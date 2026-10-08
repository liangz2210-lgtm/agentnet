import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { parsePubkeyArg } from '../../src/cli/keys'
import { resolveRelays } from '../../src/cli/config'
import { run } from '../../src/cli/main'
import { EXIT_OK, EXIT_USAGE, EXIT_NO_IDENTITY } from '../../src/cli/exit-codes'

const PK_A = 'a'.repeat(64)

/**
 * 数据目录必须建在**项目内**：os.tmpdir() 在 macOS 落在 /private/tmp（sticky + 世界可写），
 * 会被 assertAncestrySafe 直接拒绝。用 test/.tmp 下的临时目录。
 */
const TMP_ROOT = join(process.cwd(), 'test', '.tmp')
function mkHome(): string {
  mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(TMP_ROOT, 'cli-home-'))
}
function collect(): { out: string[]; err: string[]; io: { out: (l: string) => void; err: (l: string) => void } } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } }
}

describe('parsePubkeyArg（hex / npub，疑似私钥拒绝）', () => {
  it('接受 64 位十六进制并统一为小写', () => {
    expect(parsePubkeyArg(PK_A)).toBe(PK_A)
    expect(parsePubkeyArg('A'.repeat(64))).toBe(PK_A)
  })

  it('接受 npub 并解码为十六进制', () => {
    const npub = nip19.npubEncode(PK_A)
    expect(parsePubkeyArg(npub)).toBe(PK_A)
  })

  it('拒绝 nsec 并提示私钥不走命令行', () => {
    const nsec = nip19.nsecEncode(new Uint8Array(32).fill(1))
    expect(() => parsePubkeyArg(nsec)).toThrow(/nsec/)
    expect(() => parsePubkeyArg(nsec)).toThrow(/命令行/)
  })

  it('拒绝 ncryptsec 与 128 位十六进制（疑似私钥形态）', () => {
    expect(() => parsePubkeyArg('ncryptsec1abcdef')).toThrow(/nsec|私钥/)
    expect(() => parsePubkeyArg('ab'.repeat(64))).toThrow(/私钥/)
  })

  it('拒绝格式不对的公钥', () => {
    expect(() => parsePubkeyArg('hello')).toThrow(/64 位十六进制/)
    expect(() => parsePubkeyArg('zz'.repeat(32))).toThrow(/64 位十六进制/)
  })
})

describe('resolveRelays（优先级：命令行 > 环境变量 > config.json）', () => {
  it('命令行有值时完全取代其余来源', () => {
    const relays = resolveRelays(['ws://cli'], {
      AGENTNET_RELAYS: 'ws://env',
    })
    expect(relays).toEqual(['ws://cli'])
  })

  it('其次取 AGENTNET_RELAYS（逗号分隔、去空白）', () => {
    const relays = resolveRelays([], { AGENTNET_RELAYS: 'ws://a, ws://b ,ws://c' })
    expect(relays).toEqual(['ws://a', 'ws://b', 'ws://c'])
  })

  it('无任何来源 → 抛 NoRelaysConfiguredError（不静默用空列表）', () => {
    expect(() =>
      resolveRelays([], { AGENTNET_HOME: '/tmp/agentnet-cli-config-test-nonexistent' }),
    ).toThrow(/未配置任何中继/)
  })

  it('空白环境变量视同未设置 → 同样报错', () => {
    expect(() => resolveRelays([], { AGENTNET_RELAYS: '   ' })).toThrow(/未配置任何中继/)
  })
})

describe('run() 的退出码（CLI 定稿：0/1/2/3/4/5）', () => {
  it('无身份时 whoami / send / ping 一律退出码 3，且不打堆栈', async () => {
    const home = mkHome()
    for (const argv of [['whoami'], ['send', PK_A, 'hi'], ['ping', PK_A]]) {
      const c = collect()
      const code = await run(argv, { AGENTNET_HOME: home }, { out: c.io.out, err: c.io.err })
      expect(code, `argv=${argv.join(' ')}`).toBe(EXIT_NO_IDENTITY)
      // 堆栈里会出现 "at " 行 —— 受控错误不允许落到"其他错误"分支
      expect(c.err.join('\n')).not.toMatch(/^\s+at /m)
    }
  })

  it('init 成功 → 0，且输出只含公钥', async () => {
    const home = mkHome()
    const c = collect()
    expect(await run(['init'], { AGENTNET_HOME: home }, { out: c.io.out, err: c.io.err })).toBe(EXIT_OK)
    const c2 = collect()
    expect(await run(['whoami'], { AGENTNET_HOME: home }, { out: c2.io.out, err: c2.io.err })).toBe(EXIT_OK)
    expect(c2.out).toHaveLength(1)
    expect(c2.out[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('非法用法（未知命令 / 缺参数 / nsec 公钥）→ 退出码 2', async () => {
    const home = mkHome()
    const cases = [
      ['bogus'],
      ['send'],
      ['ping'],
      ['send', nip19.nsecEncode(new Uint8Array(32).fill(1)), 'hi'],
      ['--nope'],
    ]
    for (const argv of cases) {
      const c = collect()
      const code = await run(argv, { AGENTNET_HOME: home }, { out: c.io.out, err: c.io.err })
      expect(code, `argv=${argv.join(' ')}`).toBe(EXIT_USAGE)
    }
  })
})
