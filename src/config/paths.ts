import { homedir } from 'node:os'
import { join } from 'node:path'

export const IDENTITY_FILENAME = 'identity.key'
export const CONFIG_FILENAME = 'config.json'
export const DATA_DIRNAME = 'data'

export type Env = Readonly<Record<string, string | undefined>>

/**
 * 基目录：`$AGENTNET_HOME`，否则 `~/.agentnet`。
 *
 * 注意：环境变量**只承载路径，绝不承载私钥材料** —— SPEC §7 规则 2 与
 * DECISIONS.md §9 明令禁止通过环境变量或命令行参数传入私钥。
 */
export function baseDir(env: Env = process.env): string {
  const override = env['AGENTNET_HOME']?.trim()
  if (override !== undefined && override !== '') {
    return override
  }
  return join(homedir(), '.agentnet')
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
