/**
 * 二轮审计 A1–A6 的回归测试 —— 一条发现一个用例组。
 *
 * 约定：每组都先断言「检查确实跑到了 N > 0 条」（对照组），再断言违规被拒。
 * 只验一边的检查等于空跑：检查脚本报错 / 选择器写错 / 常量不存在，
 * 在输出上都和"检查通过"长得一模一样。
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InsecureBaseDirError, assertAncestrySafe, resolveRealBaseDir } from '../../src/config/dirguard'
import { IDENTITY_FILENAME, assertSafeBaseDir, defaultBaseDir } from '../../src/config/paths'
import {
  IdentityMissingError,
  generateIdentity,
  loadIdentity,
  saveNewIdentity,
} from '../../src/identity/identity'

const cleanups: string[] = []
function tempHome(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'agentnet-audit-'))
  cleanups.push(dir)
  return { AGENTNET_HOME: dir }
}
/**
 * `os.tmpdir()` 在 macOS 上返回的 `/var/...` 其实是 `/private/var/...` 的符号链接 ——
 * 用 `lstat` 完全看不出来，只有 `realpath` 会暴露。因此凡是与"真实路径"做比较的断言，
 * 期望值都必须自己先 realpath 一次。
 */
function real(p: string): string {
  return realpathSync(p)
}
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* 已删除则忽略 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function srcOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

describe('A1 回归：解析一次真实路径，之后全程使用真实路径', () => {
  it('AGENTNET_HOME 是符号链接时，落盘位置是链接指向的真实目录', () => {
    const realHome = mkdtempSync(join(tmpdir(), 'agentnet-real-'))
    cleanups.push(realHome)
    const linkHome = join(
      tmpdir(),
      `agentnet-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    symlinkSync(realHome, linkHome)
    cleanups.push(linkHome)

    // 对照组：先确认配置值本身确实含符号链接，否则本用例就是空跑。
    expect(resolveRealBaseDir({ AGENTNET_HOME: linkHome }).real).toBe(real(realHome))

    const id = generateIdentity()
    const target = saveNewIdentity(id.secretKey, { AGENTNET_HOME: linkHome })

    expect(target).toBe(join(real(realHome), IDENTITY_FILENAME))
    // 全程只用真实路径：返回值不该再带链接那一层。
    expect(target.startsWith(linkHome)).toBe(false)
    expect(loadIdentity({ AGENTNET_HOME: linkHome }).publicKey).toBe(id.publicKey)
  })

  it('正常（非链接）基目录不受影响', () => {
    const env = tempHome()
    const id = generateIdentity()
    expect(saveNewIdentity(id.secretKey, env)).toBe(
      join(real(env['AGENTNET_HOME'] as string), IDENTITY_FILENAME),
    )
  })
})

describe('A2 回归：逐层祖先目录检查', () => {
  it('对照组：临时目录下的基目录被放行（证明检查不是一律拒绝）', () => {
    const env = tempHome()
    expect(resolveRealBaseDir(env).real).toBe(real(env['AGENTNET_HOME'] as string))
    expect(() => assertAncestrySafe(real(env['AGENTNET_HOME'] as string))).not.toThrow()
    expect(() => saveNewIdentity(generateIdentity().secretKey, env)).not.toThrow()
  })

  it('拒绝：基目录直接位于带 sticky 位的共享可写目录下（如 /tmp）', () => {
    // 实测：/tmp -> /private/tmp，模式 1777（sticky + 世界可写）。
    const base = '/tmp/agentnet-a2-sticky-check'
    expect(() => loadIdentity({ AGENTNET_HOME: base })).toThrow(InsecureBaseDirError)
    expect(() => loadIdentity({ AGENTNET_HOME: base })).toThrow(/sticky/)
    expect(() =>
      saveNewIdentity(generateIdentity().secretKey, { AGENTNET_HOME: base }),
    ).toThrow(InsecureBaseDirError)
  })

  it('拒绝：任一祖先对组或其他用户可写', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentnet-anc-'))
    cleanups.push(home)
    const base = join(home, 'nested')

    // 对照组：放开权限之前，这条路径是被接受的。
    expect(() => assertSafeBaseDir(base)).not.toThrow()
    expect(() => assertAncestrySafe(resolveRealBaseDir({ AGENTNET_HOME: base }).real)).not.toThrow()

    chmodSync(home, 0o777)
    expect(() => loadIdentity({ AGENTNET_HOME: base })).toThrow(InsecureBaseDirError)
    expect(() => loadIdentity({ AGENTNET_HOME: base })).toThrow(/可写/)
  })

  it('属主规则：源码中要求"当前用户或 root"，且 root 所有的 /var 系祖先不误杀', () => {
    // 「属主是别人」在本机造不出来（需要 root），所以这条只锁规则本身；
    // 不误杀则由上面的对照组证明 —— 该路径的 /var、/var/folders 均由 root 所有。
    const src = srcOf('../../src/config/dirguard.ts')
    expect(src).toMatch(/st\.uid !== uid && st\.uid !== 0/)
    // 反证：/private/tmp 由 root 所有，它被拒的原因是 sticky 而不是属主。
    expect(() => loadIdentity({ AGENTNET_HOME: '/tmp/agentnet-a2-owner' })).toThrow(/sticky/)
    expect(() => loadIdentity({ AGENTNET_HOME: '/tmp/agentnet-a2-owner' })).not.toThrow(/属主/)
  })

  it('不引入原生绑定：源码中不出现 .node / node-gyp / dlopen', () => {
    const src = srcOf('../../src/config/dirguard.ts')
    expect(src).not.toMatch(/\.node['"]/)
    expect(src).not.toMatch(/node-gyp|bindings\(|dlopen|ffi/)
  })
})

describe('A3 回归：新建失败先截断再删除，删除失败必须显式上报', () => {
  it('写入后校验失败 ⇒ 磁盘上不残留私钥文件', () => {
    const env = tempHome()
    const previous = process.umask(0o400) // 让 open 的 0600 被削成 0200（属主不可读）
    try {
      expect(() => saveNewIdentity(generateIdentity().secretKey, env)).toThrow(
        /对当前用户不可读/,
      )
    } finally {
      process.umask(previous)
    }
    // 既不能留下完整私钥，也不能留下挡住重建的空壳。
    expect(existsSync(join(env['AGENTNET_HOME'] as string, IDENTITY_FILENAME))).toBe(false)
  })

  it('源码结构：清理顺序是 ftruncate → close → unlink，且 unlink 失败不静默', () => {
    const src = srcOf('../../src/identity/identity.ts')
    expect(src).toContain('ftruncateSync(fd, 0)')
    expect(src).toContain('unlinkSync(target)')
    expect(src).toContain('catch (cleanupErr)')
    expect(src).toContain('new IdentityCleanupError(target, err, cleanupErr)')
    // 旧实现把 unlink 失败吞掉了，这行注释还在即代表旧行为还在。
    expect(src).not.toContain('清理失败也要继续抛出原错误')
    // 截断必须发生在关闭 fd 之前，否则截断无从谈起。
    expect(src.indexOf('ftruncateSync(fd, 0)')).toBeLessThan(src.indexOf('closeSync(fd)'))
  })

  it('卡死处置：报错给出路径与手动步骤，且程序不自动删除', () => {
    const src = srcOf('../../src/identity/identity.ts')
    expect(src).toContain('请手动处置')
    expect(src).toContain('cp -p')
    expect(src).toContain('程序不会自动删除')
  })
})

describe('A4 回归：移除 normalize===resolve，改为拒绝文件系统根', () => {
  it('拒绝 /', () => {
    expect(() => assertSafeBaseDir('/')).toThrow(/根目录/)
  })

  it('不再因尾随分隔符拒绝合法路径', () => {
    expect(() => assertSafeBaseDir('/tmp/agentnet/')).not.toThrow()
  })

  it('源码中不再有 normalize===resolve 这条等值检查', () => {
    const src = srcOf('../../src/config/paths.ts')
    expect(src).not.toMatch(/normalize\(dir\)\s*!==\s*resolve\(dir\)/)
    expect(src).not.toMatch(/normalize\(dir\)\s*===\s*resolve\(dir\)/)
  })
})

describe('A5 回归：默认基目录使用 os.userInfo().homedir', () => {
  it('$HOME 被篡改为 /tmp/FAKEHOME-A5 时，默认基目录不变', () => {
    const previous = process.env['HOME']
    const expected = defaultBaseDir()
    try {
      process.env['HOME'] = '/tmp/FAKEHOME-A5'
      expect(expected).toBe(join(userInfo().homedir, '.agentnet'))
      expect(defaultBaseDir()).toBe(expected)
      expect(defaultBaseDir()).not.toContain('FAKEHOME')
    } finally {
      if (previous === undefined) delete process.env['HOME']
      else process.env['HOME'] = previous
    }
  })
})

describe('A6 回归：基目录不存在 ⇒ 视同身份不存在', () => {
  it('抛 IdentityMissingError，而不是"目录错误"，也不自动创建目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentnet-a6-'))
    cleanups.push(home)
    const missing = join(home, 'not-created-yet')

    expect(() => loadIdentity({ AGENTNET_HOME: missing })).toThrow(IdentityMissingError)
    expect(() => loadIdentity({ AGENTNET_HOME: missing })).toThrow(/请先运行 agentnet init/)
    // 加载路径绝不建目录 —— 否则"身份不存在"会被自己抹掉。
    expect(existsSync(missing)).toBe(false)
  })

  it('对照组：基目录存在但文件缺失，同样是 IdentityMissingError', () => {
    expect(() => loadIdentity(tempHome())).toThrow(IdentityMissingError)
  })
})
