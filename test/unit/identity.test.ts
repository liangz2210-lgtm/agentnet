import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DIR_MODE,
  IdentityExistsError,
  IdentityMissingError,
  MalformedKeyError,
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

  it('拒绝：私钥路径是符号链接', () => {
    const env = tempHome()
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)

    const home = env['AGENTNET_HOME'] as string
    const real = join(home, 'real.key')
    const link = identityPath(env)
    writeFileSync(real, Buffer.from(id.secretKey).toString('hex'), { mode: 0o600 })
    rmSync(link)
    symlinkSync(real, link)

    expect(() => loadIdentity(env)).toThrow(KeyFileError)
    expect(() => loadIdentity(env)).toThrow(/符号链接/)
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

describe('whoami', () => {
  it('返回当前身份公钥', () => {
    const env = tempHome()
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)

    expect(whoami(env)).toBe(id.publicKey)
  })
})
