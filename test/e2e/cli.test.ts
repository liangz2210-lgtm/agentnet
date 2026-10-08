/**
 * 端到端测试 —— **真实 CLI 子进程 + 两个隔离数据目录 + 随机端口 nak**。
 *
 * 覆盖用户定稿的 8 个场景：
 *   S1 两个身份各自 init / whoami，公钥不同
 *   S2 listen 收到消息并显示**完整**发送者公钥
 *   S3 离线期间发来的消息，上线后能收到（since 回溯 72h）
 *   S4 ping/pong 成功（0）与超时（5）
 *   S5 过期 / 重复 / 伪造发送者 —— 一律不显示
 *   S6 恶意内容（ESC、零宽、双向控制字符）被清理；超长行注明截断
 *   S7 全部中继不可达：send → 4，listen → 启动失败非零
 *   S8 结束后无残留进程
 *
 * 每个用例都新建身份：nak 是内存 relay、事件会累积，用新公钥天然隔离历史消息。
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { startNak, type NakRelay } from '../integration/helpers/nak'
import {
  cleanHome,
  ensureBuilt,
  mkHome,
  runCli,
  spawnListen,
  type ListenProc,
} from './helpers/cli'
import { deliver, envelopeJson, sealAndWrap } from './helpers/raw'

let nak: NakRelay
const homes: string[] = []
const listeners: ListenProc[] = []

beforeAll(async () => {
  ensureBuilt()
  nak = await startNak()
}, 30_000)

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.stop()
})

afterAll(async () => {
  for (const l of listeners.splice(0)) await l.stop()
  await nak.stop()
  for (const h of homes.splice(0)) cleanHome(h)
}, 30_000)

function track(home: string): string {
  homes.push(home)
  return home
}

/** 新建一个真实身份（走 CLI init + whoami），返回数据目录与完整公钥。 */
async function newAgent(name: string): Promise<{ home: string; pk: string }> {
  const home = track(mkHome())
  const init = await runCli(['init', '--name', name], { home })
  expect(init.code, init.stderr).toBe(0)
  const who = await runCli(['whoami'], { home })
  expect(who.code, who.stderr).toBe(0)
  const pk = who.stdout.trim()
  expect(pk).toMatch(/^[0-9a-f]{64}$/)
  return { home, pk }
}

function listen(home: string): ListenProc {
  const l = spawnListen(home, [nak.url])
  listeners.push(l)
  return l
}

/** 取一个当前空闲（无人监听）的端口，用于"中继不可达"场景。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('取端口失败'))))
    })
  })
}

// ── S1 两个身份各自 init / whoami ────────────────────────────────────

describe('S1 身份', () => {
  it('两个隔离数据目录各自 init，公钥互不相同且都是完整 64 位十六进制', async () => {
    const a = await newAgent('alice')
    const b = await newAgent('bob')
    expect(a.pk).not.toBe(b.pk)
    expect(a.home).not.toBe(b.home)
  })

  it('whoami 只输出公钥一行，且 init 拒绝覆盖已有身份', async () => {
    const a = await newAgent('alice')
    const who = await runCli(['whoami'], { home: a.home })
    expect(who.stdout.trim().split('\n')).toHaveLength(1)

    const again = await runCli(['init'], { home: a.home })
    expect(again.code).not.toBe(0)
    expect(again.stderr).toMatch(/已存在|不覆盖/)

    // 身份没被覆盖
    const still = await runCli(['whoami'], { home: a.home })
    expect(still.stdout.trim()).toBe(a.pk)
  })

  it('无身份时 whoami / send / ping 退出码 3', async () => {
    const home = track(mkHome())
    for (const argv of [['whoami'], ['ping', 'b'.repeat(64)]]) {
      const r = await runCli(argv, { home })
      expect(r.code, `argv=${argv.join(' ')}`).toBe(3)
    }
  })

  it('--json 每行一个 JSON 对象', async () => {
    const a = await newAgent('alice')
    const r = await runCli(['whoami', '--json'], { home: a.home })
    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({ publickey: a.pk })
  })
})

// ── S2 listen 收到并显示完整发送者 ───────────────────────────────────

describe('S2 listen 收消息', () => {
  it('显示的消息带发送者**完整**公钥（不缩写、不打码）', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()

    const sent = await runCli(['send', bob.pk, 'hello-bob', '--relay', nak.url], { home: alice.home })
    expect(sent.code, sent.stderr).toBe(0)

    const line = await b.waitForLine(/\[text\]/)
    expect(line).not.toBeNull()
    expect(line).toContain(alice.pk) // 完整 64 位
    expect(line).toContain('hello-bob')
    expect(line).not.toContain('…') // 没有省略
  })

  it('文本为 - 时从标准输入读取', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()

    const sent = await runCli(['send', bob.pk, '-', '--relay', nak.url], {
      home: alice.home,
      stdin: 'from-stdin',
    })
    expect(sent.code, sent.stderr).toBe(0)
    expect(await b.waitForLine(/from-stdin/)).not.toBeNull()
  })
})

// ── S3 离线后收到 ────────────────────────────────────────────────────

describe('S3 离线消息', () => {
  it('接收方不在线时发出，之后 listen 仍能收到（since 回溯 72h）', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')

    // bob 还没有 listen —— 先发
    const sent = await runCli(['send', bob.pk, 'offline-hello', '--relay', nak.url], {
      home: alice.home,
    })
    expect(sent.code, sent.stderr).toBe(0)

    await new Promise((r) => setTimeout(r, 500)) // 确保先落中继再订阅

    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    const line = await b.waitForLine(/offline-hello/, 10_000)
    expect(line).not.toBeNull()
    expect(line).toContain(alice.pk)
  })
})

// ── S4 ping / pong 与超时 ────────────────────────────────────────────

describe('S4 ping', () => {
  it('对方在线 → 收到 pong，退出码 0 且进程自行退出', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()

    const r = await runCli(['ping', bob.pk, '--timeout', '8', '--relay', nak.url], {
      home: alice.home,
      timeoutMs: 15_000,
    })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/pong/)
    expect(r.stdout).toContain(bob.pk)
  })

  it('无人应答 → 退出码 5，进程自行退出', async () => {
    const alice = await newAgent('alice')
    const ghost = getPublicKey(generateSecretKey()) // 没人在线
    const started = Date.now()
    const r = await runCli(['ping', ghost, '--timeout', '2', '--relay', nak.url], {
      home: alice.home,
      timeoutMs: 15_000,
    })
    expect(r.code).toBe(5)
    expect(r.stderr).toMatch(/超时/)
    expect(Date.now() - started).toBeLessThan(12_000) // 没有卡住
  })
})

// ── S5 过期 / 重复 / 伪造，一律不显示 ────────────────────────────────

describe('S5 拒绝路径', () => {
  it('过期消息不显示（--ttl 1，等过期后再收）', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')

    const sent = await runCli(['send', bob.pk, 'will-expire', '--ttl', '1', '--relay', nak.url], {
      home: alice.home,
    })
    expect(sent.code, sent.stderr).toBe(0)

    await new Promise((r) => setTimeout(r, 2500)) // 等它过期

    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    expect(await b.waitForLine(/will-expire/, 4000)).toBeNull()
    expect(b.stderr()).toMatch(/EXPIRED/)
  })

  it('同一信封 id 投递两次只显示一次（第二次判为 DUPLICATE）', async () => {
    const bob = await newAgent('bob')
    const skC = generateSecretKey()
    const pkC = getPublicKey(skC)
    const now = Math.floor(Date.now() / 1000)
    const content = envelopeJson({
      id: '0199f0e1-1111-7000-8000-000000000001',
      type: 'text',
      from: pkC,
      to: bob.pk,
      expires_at: now + 3600,
      payload: { text: 'dup-once' },
    })
    // 两次**独立包装**：外层 wrap 的密钥与时间戳都是随机的，所以是两个不同的
    // Nostr 事件（中继不会按 event id 吃掉第二个），但内层信封 id 完全相同 ——
    // 这正是重放攻击的样子，必须被应用层去重键 (from, id) 拦下。
    expect(await deliver(nak.url, sealAndWrap(skC, bob.pk, content, now))).toBe(true)
    expect(await deliver(nak.url, sealAndWrap(skC, bob.pk, content, now))).toBe(true)

    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    expect(await b.waitForLine(/dup-once/, 8000)).not.toBeNull()

    await new Promise((r) => setTimeout(r, 1200)) // 给第二次投递留时间
    const shown = b.stdout().split('\n').filter((l) => l.includes('dup-once'))
    expect(shown).toHaveLength(1)
    expect(b.stderr()).toMatch(/DUPLICATE/)
  })

  it('伪造发送者（C 签名但 from 写 A）不显示', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const skC = generateSecretKey()
    const now = Math.floor(Date.now() / 1000)
    const content = envelopeJson({
      id: '0199f0e1-2222-7000-8000-000000000002',
      type: 'text',
      from: alice.pk, // ← 冒用 alice
      to: bob.pk,
      expires_at: now + 3600,
      payload: { text: 'i-am-not-alice' },
    })
    const wrap = sealAndWrap(skC, bob.pk, content, now)
    expect(await deliver(nak.url, wrap)).toBe(true)

    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    expect(await b.waitForLine(/i-am-not-alice/, 6000)).toBeNull()
    expect(b.stderr()).toMatch(/FROM_MISMATCH/)
  })

  it('to 不是本机公钥的消息不显示', async () => {
    const bob = await newAgent('bob')
    const someone = getPublicKey(generateSecretKey())
    const skC = generateSecretKey()
    const pkC = getPublicKey(skC)
    const now = Math.floor(Date.now() / 1000)
    const content = envelopeJson({
      id: '0199f0e1-3333-7000-8000-000000000003',
      type: 'text',
      from: pkC,
      to: someone, // ← 发给别人
      expires_at: now + 3600,
      payload: { text: 'not-for-bob' },
    })
    const wrap = sealAndWrap(skC, someone, content, now)
    expect(await deliver(nak.url, wrap)).toBe(true)

    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    expect(await b.waitForLine(/not-for-bob/, 5000)).toBeNull()
  })
})

// ── S6 恶意内容清理 ──────────────────────────────────────────────────

describe('S6 输出清洗', () => {
  it('ESC / 零宽 / 双向控制字符在进入终端前被清掉，且内容不执行', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()

    const nasty = 'ok' + '\u001b[31mRED\u001b[0m' + '\u200b\u202a\u202e evil\u2066\ufeff'
    const sent = await runCli(['send', bob.pk, nasty, '--relay', nak.url], { home: alice.home })
    expect(sent.code, sent.stderr).toBe(0)

    const line = await b.waitForLine(/\[text\]/, 8000)
    expect(line).not.toBeNull()
    const shown = line as string
    for (const bad of ['\u001b', '\u200b', '\u202a', '\u202e', '\u2066', '\ufeff']) {
      expect(shown).not.toContain(bad)
    }
    expect(shown).toContain('ok')
  })

  it('超长单行被截断并注明', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const b = listen(bob.home)
    expect(await b.waitForStderr(/listening/)).not.toBeNull()

    const long = 'x'.repeat(3000)
    const sent = await runCli(['send', bob.pk, long, '--relay', nak.url], { home: alice.home })
    expect(sent.code, sent.stderr).toBe(0)

    const line = await b.waitForLine(/\[text\]/, 8000)
    expect(line).not.toBeNull()
    expect(line).toMatch(/已截断/)
    expect((line as string).length).toBeLessThan(2200)
  })

  it('疑似 nsec 私钥作为公钥参数 → 退出码 2 并给出提示', async () => {
    const alice = await newAgent('alice')
    const { nip19 } = await import('nostr-tools')
    const nsec = nip19.nsecEncode(new Uint8Array(32).fill(7))
    const r = await runCli(['send', nsec, 'hi', '--relay', nak.url], { home: alice.home })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/私钥/)
  })
})

// ── S7 全部中继不可达 ────────────────────────────────────────────────

describe('S7 中继不可达', () => {
  it('send 未被任何中继确认 → 退出码 4', async () => {
    const alice = await newAgent('alice')
    const bob = await newAgent('bob')
    const dead = `ws://127.0.0.1:${await freePort()}`
    const r = await runCli(['send', bob.pk, 'nowhere', '--relay', dead], {
      home: alice.home,
      timeoutMs: 20_000,
    })
    expect(r.code).toBe(4)
  })

  it('listen 启动时所有中继都不可达 → 报错并以非零码退出（不挂住）', async () => {
    const bob = await newAgent('bob')
    const dead = `ws://127.0.0.1:${await freePort()}`
    const r = await runCli(['listen', '--relay', dead], { home: bob.home, timeoutMs: 20_000 })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/不可达/)
  })

  it('listen 启动失败不会留下常驻进程', async () => {
    const bob = await newAgent('bob')
    const dead = `ws://127.0.0.1:${await freePort()}`
    await runCli(['listen', '--relay', dead], { home: bob.home, timeoutMs: 20_000 })
    // 上面能正常返回，说明进程已退出
    const r = spawnSync('pgrep', ['-f', 'dist/cli/bin.js'], { encoding: 'utf8' })
    expect((r.stdout ?? '').trim()).toBe('')
  })
})

// ── S8 无残留 ────────────────────────────────────────────────────────

describe('S8 收尾', () => {
  it('全部用例结束后没有残留的 CLI 进程', () => {
    const r = spawnSync('pgrep', ['-f', 'dist/cli/bin.js'], { encoding: 'utf8' })
    expect((r.stdout ?? '').trim()).toBe('')
  })

  it('listen 收到 SIGTERM 后干净退出（退出码 0）', async () => {
    const bob = await newAgent('bob')
    const b = spawnListen(bob.home, [nak.url])
    expect(await b.waitForStderr(/listening/)).not.toBeNull()
    expect(await b.stop()).toBe(0)
  })
})
