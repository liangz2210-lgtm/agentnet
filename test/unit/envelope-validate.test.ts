import { describe, expect, it } from 'vitest'
import { validateEnvelope, type RejectReason, type ValidationResult } from '../../src/envelope/validate'
import {
  MAX_ENVELOPE_BYTES,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  MAX_NOTE_BYTES,
  MAX_SESSION_BYTES,
  MAX_TEXT_BYTES,
} from '../../src/envelope/constants'

const T0 = 1_700_000_000

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ULID = '0123456789ABCDEFGHJKMNPQRS'

function at(
  over: Record<string, unknown> = {},
  drop: string[] = [],
  ctx: Partial<{ now: number; createdAt: number }> = {},
) {
  const base: Record<string, unknown> = {
    v: 0,
    id: UUID,
    type: 'text',
    from: A,
    to: B,
    expires_at: 0,
    payload: { text: 'hi' },
    receipt: null,
  }
  const merged = { ...base, ...over }
  for (const k of drop) delete merged[k]
  return validateEnvelope(JSON.stringify(merged), {
    rumorCreatedAt: ctx.createdAt ?? T0,
    now: ctx.now ?? T0,
  })
}

/** 构造原始 JSON 串：结构与 `at()` 一致，便于按字节调大小。 */
function raw(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 0,
    id: UUID,
    type: 'text',
    from: A,
    to: B,
    expires_at: 0,
    payload: { text: 'hi' },
    receipt: null,
    ...over,
  })
}

function reasonOf(r: ValidationResult, expected: RejectReason) {
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe(expected)
}

describe('返回值形态：带原因码，不抛异常', () => {
  it('非法输入一律返回结果对象而非抛出', () => {
    const cases: unknown[] = [null, 42, [], {}, 'not-json', '{"v":0}']
    for (const c of cases) {
      expect(() =>
        validateEnvelope(c, { rumorCreatedAt: T0, now: T0 }),
      ).not.toThrow()
      const r = validateEnvelope(c, { rumorCreatedAt: T0, now: T0 })
      expect(r.ok).toBe(false)
    }
  })

  it('通过时携带结构化信封', () => {
    const r = at({ expires_at: T0 + 60 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.envelope.id).toBe(UUID)
      expect(r.envelope.payload).toEqual({ kind: 'text', text: 'hi' })
    }
  })
})

describe('大小：先按 UTF-8 字节检查，再解析 JSON', () => {
  it('超过 1 字节即拒绝 —— 必须是 TOO_LARGE 而不是 INVALID_JSON', () => {
    const padding = MAX_ENVELOPE_BYTES - raw({ expires_at: T0 + 60, note: '' }).length + 1
    const big = raw({ note: 'x'.repeat(padding), expires_at: T0 + 60 })
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(MAX_ENVELOPE_BYTES)

    const r = validateEnvelope(big, { rumorCreatedAt: T0, now: T0 })
    reasonOf(r, 'TOO_LARGE')
  })

  it('观察到的性质：语义合法的信封最大也远不到 64KB —— 总闸只对畸形输入生效', () => {
    // 每个字段顶到各自的上限，总量仍然远低于 64KB。
    // 这条测试的意义是**锁住这个预算关系**：将来任何人放宽某个字段上限时，
    // 它会被打破并提示需要重新核对总闸。
    const maxValid = raw({
      note: 'x'.repeat(MAX_NOTE_BYTES),
      payload: { text: 'x'.repeat(MAX_TEXT_BYTES) },
      session: 'x'.repeat(MAX_SESSION_BYTES),
      expires_at: T0 + 60,
    })
    expect(Buffer.byteLength(maxValid, 'utf8')).toBeLessThan(MAX_ENVELOPE_BYTES)
    expect(validateEnvelope(maxValid, { rumorCreatedAt: T0, now: T0 }).ok).toBe(true)
  })

  it('多字节字符按 UTF-8 字节计，不按字符数', () => {
    // 22000 个汉字 = 66000 字节 > 64KB；字符数 22000 却远小于 65536
    const big = raw({ note: '汉'.repeat(22_000), expires_at: T0 + 60 })
    expect(big.length).toBeLessThan(MAX_ENVELOPE_BYTES)
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(MAX_ENVELOPE_BYTES)

    const r = validateEnvelope(big, { rumorCreatedAt: T0, now: T0 })
    reasonOf(r, 'TOO_LARGE')
  })
})

describe('严格 schema', () => {
  it('未知顶层字段被拒绝', () => {
    reasonOf(at({ extra: 1, expires_at: T0 + 60 }), 'UNKNOWN_TOP_LEVEL_FIELD')
  })

  it('未知 type 被拒绝', () => {
    reasonOf(at({ type: 'query', expires_at: T0 + 60 }), 'UNKNOWN_TYPE')
  })

  it('缺少必填字段被拒绝', () => {
    reasonOf(at({}, ['receipt']), 'MISSING_FIELD')
  })

  it('receipt 非 null 被拒绝，但缺失或 null 均可', () => {
    reasonOf(at({ receipt: 'x', expires_at: T0 + 60 }), 'RECEIPT_NOT_NULL')
    expect(at({ expires_at: T0 + 60 }).ok).toBe(true)
    expect(at({}, ['receipt']).ok).toBe(false)
  })

  it('原型污染键被拒绝（顶层与深层）', () => {
    const top = JSON.stringify([{ __proto__: {}, v: 0 }])
    expect(validateEnvelope(top.replace(/^\[|\]$/g, ''), { rumorCreatedAt: T0, now: T0 }).ok).toBe(
      false,
    )
    reasonOf(at({ payload: { text: 'x', constructor: 1 }, expires_at: T0 + 60 }), 'UNSAFE_KEY')
    reasonOf(at({ payload: { text: 'x', prototype: {} }, expires_at: T0 + 60 }), 'UNSAFE_KEY')
  })
})

describe('格式：公钥、id', () => {
  it('公钥必须是 64 位小写十六进制', () => {
    reasonOf(at({ from: A.toUpperCase(), expires_at: T0 + 60 }), 'INVALID_FIELD')
    reasonOf(at({ to: B.toUpperCase(), expires_at: T0 + 60 }), 'TO_INVALID_FORMAT')
    reasonOf(at({ to: 'deadbeef', expires_at: T0 + 60 }), 'TO_INVALID_FORMAT')
  })

  it('id 接受 UUID 与 ULID，拒绝其它形态', () => {
    expect(at({ id: UUID, expires_at: T0 + 60 }).ok).toBe(true)
    expect(at({ id: ULID, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(at({ id: 'random-string', expires_at: T0 + 60 }), 'INVALID_FIELD')
    reasonOf(at({ id: '', expires_at: T0 + 60 }), 'INVALID_FIELD')
    reasonOf(at({ id: UUID.toUpperCase(), expires_at: T0 + 60 }), 'INVALID_FIELD')
  })
})

describe('按 type 的 payload 校验', () => {
  it('ping 的 payload 必须为空', () => {
    expect(at({ type: 'ping', payload: {}, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(
      at({ type: 'ping', payload: { a: 1 }, expires_at: T0 + 60 }),
      'PAYLOAD_INVALID',
    )
  })

  it('pong 必须携带合法 id', () => {
    expect(at({ type: 'pong', payload: { id: UUID }, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(at({ type: 'pong', payload: {}, expires_at: T0 + 60 }), 'PAYLOAD_INVALID')
    reasonOf(at({ type: 'pong', payload: { id: 'bad' }, expires_at: T0 + 60 }), 'PAYLOAD_INVALID')
  })

  it('text 长度上限', () => {
    expect(at({ payload: { text: '汉'.repeat(1) }, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(
      at({ payload: { text: 'x'.repeat(MAX_TEXT_BYTES + 1) }, expires_at: T0 + 60 }),
      'PAYLOAD_INVALID',
    )
    expect(at({ payload: { text: 'x'.repeat(MAX_TEXT_BYTES) }, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(at({ payload: { text: 42 }, expires_at: T0 + 60 }), 'PAYLOAD_INVALID')
  })

  it('note 超长被拒绝', () => {
    reasonOf(at({ note: 'x'.repeat(MAX_NOTE_BYTES + 1), expires_at: T0 + 60 }), 'INVALID_FIELD')
  })
})

describe('时间：唯一基准与边界（表格驱动）', () => {
  it('信封内若带 created_at，必须与 rumor.created_at 相等', () => {
    expect(at({ created_at: T0, expires_at: T0 + 60 }).ok).toBe(true)
    reasonOf(at({ created_at: T0 + 1, expires_at: T0 + 60 }), 'CREATED_AT_MISMATCH')
  })

  const futureCases: Array<[number, boolean]> = [
    [MAX_FUTURE_SKEW_SECONDS - 1, true],
    [MAX_FUTURE_SKEW_SECONDS, true],
    [MAX_FUTURE_SKEW_SECONDS + 1, false],
  ]
  it.each(futureCases)('created_at 超前 %i 秒 -> 通过=%s', (delta, shouldPass) => {
    const r = validateEnvelope(raw({ expires_at: T0 + delta + 60 }), {
      rumorCreatedAt: T0 + delta,
      now: T0,
    })
    expect(r.ok).toBe(shouldPass)
    if (!shouldPass) expect(r.ok === false && r.reason).toBe('CLOCK_TOO_FUTURE')
  })

  const lifetimeCases: Array<[number, boolean]> = [
    [MAX_LIFETIME_SECONDS - 1, true],
    [MAX_LIFETIME_SECONDS, true],
    [MAX_LIFETIME_SECONDS + 1, false],
  ]
  it.each(lifetimeCases)('有效期 %i 秒 -> 通过=%s', (lifetime, shouldPass) => {
    const r = validateEnvelope(raw({ expires_at: T0 + lifetime }), {
      rumorCreatedAt: T0,
      now: T0,
    })
    expect(r.ok).toBe(shouldPass)
    if (!shouldPass) expect(r.ok === false && r.reason).toBe('LIFETIME_TOO_LONG')
  })

  const expiryCases: Array<[number, boolean]> = [
    [1, true],
    [0, false],
    [-1, false],
  ]
  it.each(expiryCases)('距过期 %i 秒 -> 通过=%s', (gap, shouldPass) => {
    const expiresAt = T0 + 60
    const r = validateEnvelope(raw({ expires_at: expiresAt }), {
      rumorCreatedAt: T0,
      now: expiresAt - gap,
    })
    expect(r.ok).toBe(shouldPass)
    if (!shouldPass) expect(r.ok === false && r.reason).toBe('EXPIRED')
  })

  it('expires_at 不晚于 created_at 被拒绝', () => {
    reasonOf(at({ expires_at: T0 }), 'LIFETIME_NOT_POSITIVE')
    reasonOf(at({ expires_at: T0 - 1 }), 'LIFETIME_NOT_POSITIVE')
  })
})
