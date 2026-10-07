import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InvalidBaseDirError, assertSafeBaseDir, baseDir } from '../../src/config/paths'

const cleanups: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentnet-paths-'))
  cleanups.push(d)
  return d
}
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('assertSafeBaseDir（外部可控输入，必须校验）', () => {
  it('放行：规范化的绝对路径', () => {
    expect(() => assertSafeBaseDir(tmp())).not.toThrow()
  })

  it('拒绝：相对路径（会随进程 cwd 漂移）', () => {
    expect(() => assertSafeBaseDir('agentnet')).toThrow(InvalidBaseDirError)
    expect(() => assertSafeBaseDir('./agentnet')).toThrow(/绝对路径/)
  })

  it('拒绝：包含 .. 路径段（会把私钥投递到意料之外的位置）', () => {
    expect(() => assertSafeBaseDir('/Users/yao/../etc')).toThrow(/不得包含/)
  })

  it('拒绝：包含 . 路径段', () => {
    expect(() => assertSafeBaseDir('/Users/./yao')).toThrow(/不得包含/)
  })

  it('拒绝：NUL 字节', () => {
    expect(() => assertSafeBaseDir('/tmp/a\u0000b')).toThrow(/NUL/)
  })

  it('拒绝：尾随分隔符（normalize 与 resolve 不一致）', () => {
    expect(() => assertSafeBaseDir('/tmp/agentnet/')).toThrow(InvalidBaseDirError)
  })

  it('放行：多余斜杠会被两个函数一致地折叠，不改变目标位置', () => {
    // normalize('/tmp//agentnet') 与 resolve 结果相同 —— 它指向的还是同一个地方，
    // 因此不构成风险，不必拒绝。
    expect(() => assertSafeBaseDir('/tmp//agentnet')).not.toThrow()
  })

  it('拒绝：空字符串', () => {
    expect(() => assertSafeBaseDir('')).toThrow(InvalidBaseDirError)
  })
})

describe('baseDir', () => {
  it('AGENTNET_HOME 合法时采用之', () => {
    const d = tmp()
    expect(baseDir({ AGENTNET_HOME: d })).toBe(d)
  })

  it('AGENTNET_HOME 非法时报错，而不是静默接受', () => {
    expect(() => baseDir({ AGENTNET_HOME: '../evil' })).toThrow(InvalidBaseDirError)
    expect(() => baseDir({ AGENTNET_HOME: 'relative' })).toThrow(InvalidBaseDirError)
  })

  it('AGENTNET_HOME 为空或空白时回落到 ~/.agentnet', () => {
    expect(baseDir({})).toMatch(/\.agentnet$/)
    expect(baseDir({ AGENTNET_HOME: '   ' })).toMatch(/\.agentnet$/)
  })

  it('未设置时回落的默认路径也是绝对路径', () => {
    expect(() => assertSafeBaseDir(baseDir({}))).not.toThrow()
  })

  it('当前进程环境的 AGENTNET_HOME 若被设置，也必须是合法的', () => {
    // 只做形式校验：本测试不修改 process.env
    expect(typeof baseDir().length).toBe('number')
  })
})
