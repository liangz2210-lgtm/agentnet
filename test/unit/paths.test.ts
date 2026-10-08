import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InvalidBaseDirError,
  assertSafeBaseDir,
  baseDir,
  defaultBaseDir,
} from '../../src/config/paths'

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
    expect(() => assertSafeBaseDir('/Users/someone/../etc')).toThrow(/不得包含/)
  })

  it('拒绝：包含 . 路径段', () => {
    expect(() => assertSafeBaseDir('/Users/./someone')).toThrow(/不得包含/)
  })

  it('拒绝：NUL 字节', () => {
    expect(() => assertSafeBaseDir('/tmp/a\u0000b')).toThrow(/NUL/)
  })

  it('拒绝：文件系统根', () => {
    // A4：根目录下"祖先"无从谈起，且与"仅当前用户可访问"直接冲突。
    expect(() => assertSafeBaseDir('/')).toThrow(/根目录/)
  })

  it('放行：尾随分隔符与多余斜杠（A4 —— 不再用 normalize===resolve 拦它们）', () => {
    // 这两条**不改变目标位置**，拒绝它们只是拒绝合法输入，挡不住任何攻击。
    // "这个位置安不安全"由 resolveRealBaseDir 之后的逐层祖先检查回答。
    expect(() => assertSafeBaseDir('/tmp/agentnet/')).not.toThrow()
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

describe('A5 回归：默认基目录不受 $HOME 影响', () => {
  it('篡改 $HOME 后 baseDir({}) 仍指向真实家目录', () => {
    const previous = process.env['HOME']
    const expected = defaultBaseDir()
    try {
      process.env['HOME'] = '/tmp/FAKEHOME-AGENTNET-TEST'
      // `os.homedir()` 会跟随 $HOME（已实测），因此这里验证的是我们**没有**用它。
      expect(baseDir({})).toBe(expected)
      expect(baseDir({})).not.toContain('FAKEHOME')
    } finally {
      if (previous === undefined) delete process.env['HOME']
      else process.env['HOME'] = previous
    }
  })

  it('源码从 node:os 只导入 userInfo，不导入会跟随 $HOME 的那一个', () => {
    const src = require('node:fs').readFileSync(
      new URL('../../src/config/paths.ts', import.meta.url),
      'utf8',
    ) as string
    expect(src).not.toMatch(/import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*'node:os'/)
    expect(src).toContain('userInfo().homedir')
  })
})
