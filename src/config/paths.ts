import { userInfo } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const IDENTITY_FILENAME = 'identity.key'
export const CONFIG_FILENAME = 'config.json'
export const DATA_DIRNAME = 'data'

export type Env = Readonly<Record<string, string | undefined>>

export class InvalidBaseDirError extends Error {
  constructor(reason: string, value: string) {
    super(`AGENTNET_HOME 不合法（${reason}）：${value.length > 80 ? `${value.slice(0, 80)}…` : value}`)
    this.name = 'InvalidBaseDirError'
  }
}

/**
 * 默认基目录：`~/.agentnet`。
 *
 * ⚠️ **用 `os.userInfo().homedir`，不用 `os.homedir()`** —— 后者会跟随 `$HOME`。
 * 实测（见 DECISIONS.md「否定性断言清单」A5 条目）：把 `$HOME` 改成 `/tmp/FAKEHOME-TEST`
 * 之后 `os.homedir()` 立刻变成该值，而 `os.userInfo().homedir` 仍是真实的 `/Users/<you>`。
 * `AGENTNET_HOME` 未设置时，家目录是私钥落盘位置的唯一依据，不能受环境变量摆布。
 */
export function defaultBaseDir(): string {
  return join(userInfo().homedir, '.agentnet')
}

/**
 * 基目录：`$AGENTNET_HOME`，否则 `~/.agentnet`。
 *
 * 环境变量**只承载路径，绝不承载私钥材料** —— SPEC §7 规则 2 与
 * DECISIONS.md §9 明令禁止通过环境变量或命令行参数传入私钥。
 *
 * `AGENTNET_HOME` 是外部可控输入，因此必须校验：
 * 相对路径会让基目录随进程的 cwd 漂移（cwd 可被攻击者影响），
 * 而 `..` 会把私钥投递到完全意料之外的位置。
 *
 * 本函数是**纯路径运算，不触碰文件系统**：它返回的是"配置值"，可能尚不存在，
 * 也可能含符号链接。真实路径由 `dirguard.ts` 的 `resolveRealBaseDir` 解析一次后提供。
 */
export function baseDir(env: Env = process.env): string {
  const override = env['AGENTNET_HOME']?.trim()
  const chosen = override !== undefined && override !== '' ? override : defaultBaseDir()
  assertSafeBaseDir(chosen)
  return chosen
}

/**
 * 配置值的形式校验：绝对路径、无 NUL、无 `.` / `..` 段、不得是文件系统根。
 *
 * **不再把 `normalize` 与 `resolve` 的结果做等值比较**（二轮审计 A4）：
 * 那条检查把"尾随分隔符、多余斜杠"当成风险，可它们并不改变目标位置；
 * 它挡不住任何真实攻击，却会拒绝合法输入。真正的"这个位置安不安全"
 * 由 `resolveRealBaseDir` 之后的**逐层祖先检查**回答（DECISIONS §9 / A1、A2）。
 *
 * 拒绝 `/`：把私钥放在根目录下意味着祖先检查无从谈起，且它与
 * "基目录必须仅当前用户可访问"这条前提直接冲突。
 */
export function assertSafeBaseDir(dir: string): void {
  if (dir === '') throw new InvalidBaseDirError('不得为空', dir)
  if (dir.includes('\0')) throw new InvalidBaseDirError('不得包含 NUL', dir)
  if (!isAbsolute(dir)) throw new InvalidBaseDirError('必须是绝对路径', dir)

  const segments = dir.split(sep)
  if (segments.includes('..') || segments.includes('.')) {
    throw new InvalidBaseDirError('不得包含 . 或 .. 路径段', dir)
  }

  if (resolve(dir) === sep) {
    throw new InvalidBaseDirError('不得为文件系统根目录', dir)
  }
}

export function identityPath(env: Env = process.env): string {
  return join(baseDir(env), IDENTITY_FILENAME)
}

export function configPath(env: Env = process.env): string {
  return join(baseDir(env), CONFIG_FILENAME)
}

export function dataDir(env: Env = process.env): string {
  return join(baseDir(env), DATA_DIRNAME)
}
