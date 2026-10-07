import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

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
 * 基目录：`$AGENTNET_HOME`，否则 `~/.agentnet`。
 *
 * 环境变量**只承载路径，绝不承载私钥材料** —— SPEC §7 规则 2 与
 * DECISIONS.md §9 明令禁止通过环境变量或命令行参数传入私钥。
 *
 * `AGENTNET_HOME` 是外部可控输入，因此必须校验：
 * 相对路径会让基目录随进程的 cwd 漂移（cwd 可被攻击者影响），
 * 而 `..` 会把私钥投递到完全意料之外的位置。
 */
export function baseDir(env: Env = process.env): string {
  const override = env['AGENTNET_HOME']?.trim()
  const chosen = override !== undefined && override !== '' ? override : join(homedir(), '.agentnet')
  assertSafeBaseDir(chosen)
  return chosen
}

/** 绝对路径、无 NUL、无 `.` / `..` 段、规范化后与输入一致。 */
export function assertSafeBaseDir(dir: string): void {
  if (dir === '') throw new InvalidBaseDirError('不得为空', dir)
  if (dir.includes('\0')) throw new InvalidBaseDirError('不得包含 NUL', dir)
  if (!isAbsolute(dir)) throw new InvalidBaseDirError('必须是绝对路径', dir)

  const segments = dir.split(sep)
  if (segments.includes('..') || segments.includes('.')) {
    throw new InvalidBaseDirError('不得包含 . 或 .. 路径段', dir)
  }

  // 规范化后必须与原值一致：多余的斜杠、尾随分隔符等形态都会在此暴露。
  if (normalize(dir) !== resolve(dir)) {
    throw new InvalidBaseDirError('不是规范化的绝对路径', dir)
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
