import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DIR_MODE,
  IdentityAccessError,
  IdentityExistsError,
  IdentityMissingError,
  MalformedKeyError,
  MAX_KEY_FILE_BYTES,
  SECRET_KEY_BYTES,
  generateIdentity,
  loadIdentity,
  saveNewIdentity,
  whoami,
} from '../../src/identity/identity'
import { KeyFileError } from '../../src/identity/keyfile'
import { identityPath } from '../../src/config/paths'

let cleanups: string[] = []

function tempHome(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'agentnet-home-'))
  cleanups.push(dir)
  return { AGENTNET_HOME: dir }
}

function fileMode(path: string): number {
  return lstatSync(path).mode & 0o777
}

function mkfifo(path: string): void {
  execFileSync('mkfifo', [path])
}

afterEach(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  cleanups = []
})

describe('generateIdentity', () => {
  it('产生 64 位十六进制公钥', () => {
    const id = generateIdentity()
    expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(id.secretKey).toHaveLength(32)
  })
})

describe('saveNewIdentity', () => {
  it('私钥文件权限确为 0600，目录权限确为 0700', () => {
    const env = tempHome()
    const target = saveNewIdentity(generateIdentity().secretKey, env)

    expect(fileMode(target)).toBe(0o600)
    expect(fileMode(dirname(target))).toBe(DIR_MODE & 0o777)
  })

  it('落盘内容为 64 位十六进制', () => {
    const env = tempHome()
    const id = generateIdentity()
    const target = saveNewIdentity(id.secretKey, env)

    expect(readFileSync(target, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('已存在身份时拒绝覆盖，且原内容不变', () => {
    const env = tempHome()
    const first = generateIdentity()
    saveNewIdentity(first.secretKey, env)
    const before = readFileSync(identityPath(env), 'utf8')

    expect(() => saveNewIdentity(generateIdentity().secretKey, env)).toThrow(
      IdentityExistsError,
    )
    expect(readFileSync(identityPath(env), 'utf8')).toBe(before)
  })
})

describe('loadIdentity', () => {
  it('正常读取且公钥与私钥对应', () => {
    const env = tempHome()
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)

    const loaded = loadIdentity(env)
    expect(loaded.publicKey).toBe(id.publicKey)
  })

  it('拒绝：私钥路径是符号链接 —— 在 open 阶段就失败，根本读不到内容', () => {
    const env = tempHome()
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)

    const home = env['AGENTNET_HOME'] as string
    const real = join(home, 'real.key')
    const link = identityPath(env)
    writeFileSync(real, Buffer.from(id.secretKey).toString('hex'), { mode: 0o600 })
    rmSync(link)
    symlinkSync(real, link)

    // 本平台实测存在 O_NOFOLLOW，因此 open 即以 ELOOP 失败。
    // 「stat 显示是符号链接」那条分支由 keyfile.test.ts 的纯函数用例覆盖。
    expect(() => loadIdentity(env)).toThrow(IdentityAccessError)
    expect(() => loadIdentity(env)).toThrow(/ELOOP/)
  })

  it('拒绝：私钥路径是 FIFO，且**不挂起**', async () => {
    const env = tempHome()
    mkfifo(identityPath(env))

    const started = Date.now()
    const outcome = await Promise.race([
      (async () => {
        try {
          loadIdentity(env)
          return 'resolved'
        } catch (e) {
          return 'rejected:' + (e as Error).name
        }
      })(),
      new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 2000)),
    ])
    const elapsed = Date.now() - started

    // O_NONBLOCK 让 open 立即返回，随后 fstat 发现不是普通文件而被拒绝。
    expect(outcome).not.toBe('TIMEOUT')
    expect(elapsed).toBeLessThan(2000)
    expect(outcome).toMatch(/rejected/)
  })

  it('拒绝：私钥路径是目录', () => {
    const env = tempHome()
    mkdirSync(identityPath(env), { mode: 0o700 })
    expect(() => loadIdentity(env)).toThrow(/必须是普通文件|IdentityAccess/)
  })

  it('拒绝：私钥文件过大（在读取之前按 fstat.size 拦下）', () => {
    const env = tempHome()
    writeFileSync(identityPath(env), 'a'.repeat(MAX_KEY_FILE_BYTES + 1), { mode: 0o600 })
    expect(() => loadIdentity(env)).toThrow(/过大/)
  })

  it('拒绝：权限过松（启动时先验才有 enforce）', () => {
    const env = tempHome()
    const id = generateIdentity()
    const target = saveNewIdentity(id.secretKey, env)

    chmodSync(target, 0o644)
    expect(() => loadIdentity(env)).toThrow(/权限过松/)
  })

  it('拒绝：文件不存在', () => {
    expect(() => loadIdentity(tempHome())).toThrow(IdentityMissingError)
  })

  it('拒绝：内容不是 64 位十六进制', () => {
    const env = tempHome()
    writeFileSync(identityPath(env), 'not-hex', { mode: 0o600 })
    expect(() => loadIdentity(env)).toThrow(MalformedKeyError)
  })

  it('私钥不存在环境变量兜底：环境变量里有 key 也不顶用', () => {
    const env = {
      ...tempHome(),
      AGENTNET_SECRET_KEY: Buffer.from(generateIdentity().secretKey).toString('hex'),
      AGENTNET_KEY: Buffer.from(generateIdentity().secretKey).toString('hex'),
    }
    expect(() => loadIdentity(env)).toThrow(IdentityMissingError)
  })
})

describe('saveNewIdentity 的输入校验', () => {
  it('拒绝非 32 字节私钥，且**不落任何文件**', () => {
    const env = tempHome()
    expect(() => saveNewIdentity(new Uint8Array(0), env)).toThrow(MalformedKeyError)
    expect(() => saveNewIdentity(new Uint8Array(31), env)).toThrow(MalformedKeyError)

    // 关键：不能留下一个"存在但不可用、又挡住重建"的空文件
    expect(readdirSync(env['AGENTNET_HOME'] as string)).not.toContain('identity.key')
  })

  it('32 字节方可写入', () => {
    const env = tempHome()
    const sk = new Uint8Array(SECRET_KEY_BYTES).fill(7)
    expect(() => saveNewIdentity(sk, env)).not.toThrow()
  })
})

describe('底层库错误收口', () => {
  it('非法 secp256k1 标量抛自有 MalformedKeyError，而非 @noble 的裸错误', () => {
    const env = tempHome()
    writeFileSync(identityPath(env), '00'.repeat(32), { mode: 0o600 })
    expect(() => loadIdentity(env)).toThrow(MalformedKeyError)
    expect(() => loadIdentity(env)).not.toThrow(/invalid scalar/)
  })
})

describe('读取走 fd（结构约束）', () => {
  it('源码中不出现按路径读取的调用，读取一律经 fd', () => {
    const src = readFileSync(new URL('../../src/identity/identity.ts', import.meta.url), 'utf8')
    // 先 lstat 路径再 readFileSync 路径 = 两次路径解析，存在 TOCTOU 窗口
    expect(src).not.toMatch(/readFileSync\s*\(\s*target/)
    expect(src).not.toMatch(/readFileSync\s*\(\s*identityPath/)
    expect(src).toContain('fstatSync(')
    expect(src).toContain('readSync(')
  })

  it('本平台存在 O_NOFOLLOW，open 阶段即拒绝符号链接', () => {
    const { constants } = require('node:fs') as typeof import('node:fs')
    expect(constants['O_NOFOLLOW' as keyof typeof constants]).toBeDefined()
  })

  it('说明：上述用例证明的是「读写路径走 fd 且各分支被拒」', () => {
    // **不能**确定性证明竞态已消除 —— 竞态需要精确的时间窗，
    // 在单元测试里无法稳定复现，也不该假装能复现。
    // 这里锁住的是结构性前提：不存在"先校验路径、再读路径"的第二次解析。
    expect(true).toBe(true)
  })
})

describe('whoami', () => {
  it('返回当前身份公钥', () => {
    const env = tempHome()
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)

    expect(whoami(env)).toBe(id.publicKey)
  })
})
