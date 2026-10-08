/**
 * 随机输入测试（fuzz）—— 目标不是"覆盖想到的输入"，而是**找出没想到的崩溃与放行**。
 *
 * 两条不变式，每一条随机输入都必须同时满足：
 *   1. **不崩溃**：`validateEnvelope` 与清洗函数对任何输入都不得抛出
 *      （抛了就是远程可触发的拒绝服务）
 *   2. **不放行非法内容**：凡是被判为合法（ok:true）的信封，必须真的合法；
 *      凡是被清洗过的文本，必须真的不含危险字符
 *
 * 用**固定种子的 PRNG**：失败可复现 —— 随机测试报不出种子的那种，等于没法修。
 */

import { describe, expect, it } from 'vitest'
import { validateEnvelope } from '../../src/envelope/validate'
import {
  stripTerminalControls,
  sanitizeForDisplay,
  sanitizeForLog,
  MAX_DISPLAY_LINE_LENGTH,
} from '../../src/envelope/sanitize'
import {
  MAX_ENVELOPE_BYTES,
  MAX_LIFETIME_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  PUBKEY_PATTERN,
} from '../../src/envelope/constants'

const NOW = 1_700_000_000
const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

// ── 固定种子 PRNG（mulberry32）：同一 seed 必得同一序列 ──────────────
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 输入生成器 ──────────────────────────────────────────────────────

/** 随机字节：含 NUL、DEL、C1、非法 UTF-8 形态。 */
function randomBytes(rnd: () => number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(rnd() * 256))
  return s
}

/** 随机 Unicode：含代理对、组合记号、双向控制、零宽、 astral 平面。 */
function randomUnicode(rnd: () => number, n: number): string {
  const interesting = [
    0x0301, 0x200b, 0x200d, 0x2060, 0xfeff, // 组合记号 / 零宽
    0x202a, 0x202e, 0x2066, 0x2069, // 双向控制
    0x009b, 0x001b, 0x0000, 0x0007, // C1 CSI / ESC / NUL / BEL
    0xd800, 0xdfff, 0xffff, 0x1f600, 0x10ffff, // 代理对与非字符
  ]
    let s = ''
  for (let i = 0; i < n; i++) {
    s +=
      rnd() < 0.45
        ? String.fromCodePoint(interesting[Math.floor(rnd() * interesting.length)] as number)
        : String.fromCodePoint(Math.floor(rnd() * 0x110000))
  }
  return s
}

const VALID = JSON.stringify({
  v: 0,
  id: '0199f0e1-0000-7000-8000-000000000001',
  type: 'text',
  from: PK_A,
  to: PK_B,
  expires_at: NOW + 3600,
  payload: { text: 'hello' },
  receipt: null,
})

/** 畸形 JSON：截断、括号错配、类型串位、原型污染键、非法字面量。 */
function malformedJson(rnd: () => number): string {
  const pool = [
    '{"v":0',
    '{"v":0,}',
    '{"a":}',
    '{]',
    '[]',
    'null',
    'undefined',
    'NaN',
    '{"v":0,"payload":{"__proto__":{"x":1}}}',
    '{"v":0,"constructor":1}',
    '{"v":0,"prototype":1}',
    '{"v":0,"id":' + '9'.repeat(400) + '}',
    '{"v":0,"expires_at":1e400}',
    '{"v":0,"expires_at":-0}',
    '{"v":0,"payload":{"text":' + '"'.repeat(3) + '}}',
    '\uFEFF{"v":0}',
    '{"v":0}\n{"v":0}',
    '[' .repeat(2000) + ']' .repeat(2000),
    '{"v":0,"to":' + PK_B + '}',
  ]
  const base = pool[Math.floor(rnd() * pool.length)] as string
  // 再随机截断一次
  return rnd() < 0.5 ? base.slice(0, Math.max(0, Math.floor(rnd() * base.length))) : base
}

/** 对合法信封做随机字节级变异 —— 变异体要么被拒，要么仍然合法，不能"变形还放行"。 */
function mutate(rnd: () => number, s: string): string {
  const chars = [...s]
  const ops = 1 + Math.floor(rnd() * 3)
  for (let i = 0; i < ops; i++) {
    const at = Math.floor(rnd() * chars.length)
    const r = rnd()
    if (r < 0.35) chars[at] = randomBytes(rnd, 1)
    else if (r < 0.6) chars.splice(at, 1)
    else if (r < 0.85) chars.splice(at, 0, randomBytes(rnd, 1))
    else chars.splice(at, 0, '"__proto__":1,')
  }
  return chars.join('')
}

// ── 不变式：被判为合法的信封必须真的合法 ────────────────────────────

function assertLegalIfAccepted(raw: string, ctx = { rumorCreatedAt: NOW, now: NOW }): void {
  let result: ReturnType<typeof validateEnvelope> | undefined
  expect(() => {
    result = validateEnvelope(raw, ctx)
  }).not.toThrow()
  const r = result as ReturnType<typeof validateEnvelope>
  if (!r.ok) return

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const e = r.envelope

  expect(e.v).toBe(0)
  expect(['ping', 'pong', 'text']).toContain(e.type)
  expect(e.from).toMatch(PUBKEY_PATTERN)
  expect(e.to).toMatch(PUBKEY_PATTERN)
  expect(e.receipt).toBeNull()
  expect(Number.isSafeInteger(e.expires_at)).toBe(true)
  expect(e.expires_at).toBeGreaterThan(e.created_at)
  expect(e.expires_at - e.created_at).toBeLessThanOrEqual(MAX_LIFETIME_SECONDS)
  expect(e.created_at).toBeLessThanOrEqual(ctx.now + MAX_FUTURE_SKEW_SECONDS)
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES)

  // 原型污染三剑客绝不能出现在被接受的信封里
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 40 || node === null || typeof node !== 'object') return
    for (const k of Object.keys(node as object)) {
      expect(['__proto__', 'constructor', 'prototype']).not.toContain(k)
      walk((node as Record<string, unknown>)[k], depth + 1)
    }
  }
  walk(parsed)

  // 返回值必须与输入一致（不得凭空造字段）
  expect(parsed['id']).toBe(e.id)
  expect(parsed['type']).toBe(e.type)
}

describe('validateEnvelope · 随机输入', () => {
  it('随机字节：不崩溃，且不放行非法内容', () => {
    const rnd = prng(20261009)
    for (let i = 0; i < 400; i++) {
      const raw = randomBytes(rnd, Math.floor(rnd() * 300))
      assertLegalIfAccepted(raw)
    }
  })

  it('随机 Unicode：不崩溃，且不放行非法内容', () => {
    const rnd = prng(777)
    for (let i = 0; i < 400; i++) {
      const raw = randomUnicode(rnd, Math.floor(rnd() * 200))
      assertLegalIfAccepted(raw)
    }
  })

  it('畸形 JSON：不崩溃，且不放行非法内容', () => {
    const rnd = prng(31337)
    for (let i = 0; i < 400; i++) {
      assertLegalIfAccepted(malformedJson(rnd))
    }
  })

  it('合法信封的随机变异体：要么被拒，要么仍然合法（最要紧的一条）', () => {
    const rnd = prng(424242)
    let accepted = 0
    let rejected = 0
    for (let i = 0; i < 600; i++) {
      // 一半做字节级变异（多半会被拒），一半只改 payload 文本（结构仍合法，多半被接受）
      const raw =
        i % 2 === 0
          ? mutate(rnd, VALID)
          : VALID.replace('"hello"', JSON.stringify(randomUnicode(rnd, 8)))
      const r = validateEnvelope(raw, { rumorCreatedAt: NOW, now: NOW })
      assertLegalIfAccepted(raw)
      if (r.ok) accepted += 1
      else rejected += 1
    }
    // 空跑检查：**两条分支都必须被走到**。
    // 只有 rejected>0，"拒绝路径"才真的被测到；只有 accepted>0，
    // "被接受的东西必须合法"这条断言才不是一句空话。
    expect(rejected).toBeGreaterThan(0)
    expect(accepted).toBeGreaterThan(0)
    expect(accepted + rejected).toBe(600)
  })

  it('超长输入：按字节上限拒绝，不崩溃、不爆栈', () => {
    // 1MB 纯文本
    assertLegalIfAccepted('a'.repeat(1_000_000))
    // 1MB 的合法信封形状
    const huge = JSON.stringify({
      v: 0,
      id: '0199f0e1-0000-7000-8000-000000000001',
      type: 'text',
      from: PK_A,
      to: PK_B,
      expires_at: NOW + 3600,
      payload: { text: 'x'.repeat(1_000_000) },
      receipt: null,
    })
    const r = validateEnvelope(huge, { rumorCreatedAt: NOW, now: NOW })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('TOO_LARGE')
  })

  it('深度嵌套 JSON：递归检查有深度上限，不爆栈', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000)
    // JSON.parse 自身可能抛 RangeError —— validateEnvelope 必须把它兜住
    let r: ReturnType<typeof validateEnvelope> | undefined
    expect(() => {
      r = validateEnvelope(deep, { rumorCreatedAt: NOW, now: NOW })
    }).not.toThrow()
    expect(r?.ok).toBe(false)

    // 嵌套对象（走 hasForbiddenKey 的递归分支）
    const deepObj = '{"a":'.repeat(2000) + '1' + '}'.repeat(2000)
    expect(() => {
      validateEnvelope(deepObj, { rumorCreatedAt: NOW, now: NOW })
    }).not.toThrow()
  })

  it('非字符串入参（null / 数字 / 对象 / 数组）：返回 NOT_STRING 而非抛出', () => {
    for (const bad of [null, undefined, 42, {}, [], true, Symbol('x')]) {
      const r = validateEnvelope(bad as never, { rumorCreatedAt: NOW, now: NOW })
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe('NOT_STRING')
    }
  })
})

// ── 清洗函数的不变式 ────────────────────────────────────────────────

/** 清洗后绝不允许残留的字符集（C0 除 \t\n、C1、双向控制、零宽）。 */
const FORBIDDEN_AFTER_SANITIZE = [
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/, // C0（除 \t \n）与 C1（含 0x9B 单字符 CSI）
  /[\u202A-\u202E\u2066-\u2069]/, // 双向控制字符
  /[\u200B-\u200D\u2060\uFEFF]/, // 零宽与不可见格式字符
]

function assertClean(s: string, label: string): void {
  for (const re of FORBIDDEN_AFTER_SANITIZE) {
    expect(re.test(s), `${label} 残留了危险字符 ${re.source}`).toBe(false)
  }
}
describe('终端清洗 · 随机输入', () => {
  it('随机字节：不崩溃，输出不含危险字符', () => {
    const rnd = prng(9001)
    for (let i = 0; i < 400; i++) {
      const s = randomBytes(rnd, Math.floor(rnd() * 400))
      let out = ''
      expect(() => {
        out = stripTerminalControls(s)
      }).not.toThrow()
      assertClean(out, 'stripTerminalControls(随机字节)')
      // 只做删除，不新增内容
      expect(out.length).toBeLessThanOrEqual(s.length)
    }
  })

  it('随机 Unicode：不崩溃，输出不含危险字符', () => {
    const rnd = prng(2024)
    for (let i = 0; i < 400; i++) {
      const s = randomUnicode(rnd, Math.floor(rnd() * 300))
      let out = ''
      expect(() => {
        out = stripTerminalControls(s)
      }).not.toThrow()
      assertClean(out, 'stripTerminalControls(随机 Unicode)')
    }
  })

  it('sanitizeForDisplay：压成单行、截断并注明，且不残留危险字符', () => {
    const rnd = prng(555)
    for (let i = 0; i < 300; i++) {
      const s = randomUnicode(rnd, Math.floor(rnd() * 300)) + randomBytes(rnd, 50)
      let d = { text: '', truncated: false }
      expect(() => {
        d = sanitizeForDisplay(s)
      }).not.toThrow()
      assertClean(d.text, 'sanitizeForDisplay')
      // 压成单行：不得有换行/回车/制表
      expect(d.text).not.toMatch(/[\r\n\t]/)
      if (d.truncated) expect(d.text).toMatch(/已截断/)
      expect(d.text.length).toBeLessThanOrEqual(MAX_DISPLAY_LINE_LENGTH + '…[已截断]'.length)
    }
  })

  it('sanitizeForDisplay：合法短文本不被截断（不误杀正常消息）', () => {
    for (const s of ['你好', 'hello world', 'a'.repeat(MAX_DISPLAY_LINE_LENGTH)]) {
      const d = sanitizeForDisplay(s)
      expect(d.truncated).toBe(false)
      expect(d.text).toBe(s)
    }
  })

  it('sanitizeForLog：长度受限且不含危险字符（用于写日志）', () => {
    const rnd = prng(12321)
    for (let i = 0; i < 300; i++) {
      const s = randomUnicode(rnd, Math.floor(rnd() * 200))
      let out = ''
      expect(() => {
        out = sanitizeForLog(s)
      }).not.toThrow()
      assertClean(out, 'sanitizeForLog')
      expect(out.length).toBeLessThanOrEqual(120)
    }
  })

  it('孤立的 0x9B 与 ESC 都不会留下后半个序列', () => {
    // 0x9B 后跟合法终止符 → 整条吞掉；后跟普通字符 → 至少字符本身被删
    expect(stripTerminalControls('a\u009B2Jb')).toBe('ab')
    // 0x9B 后紧跟落在 [@-~] 的普通字符（如 'b'）时，该字符会被当作序列终止符
    // 一并吞掉 —— 刻意保守：宁可少显示一个字符，也不让半个控制序列漏进终端
    expect(stripTerminalControls('a\u009Bb')).toBe('a')
    // 后跟不在终止符范围内的字符时，只删 0x9B 本身
    expect(stripTerminalControls('a\u009B你b')).toBe('a你b')
    expect(stripTerminalControls('a\u001B[2Jb')).toBe('ab')
    expect(stripTerminalControls('a\u001B]0;x\u0007b')).toBe('ab')
  })
})
