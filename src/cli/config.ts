/**
 * CLI 配置解析。
 *
 * 中继来源优先级（用户定稿）：**命令行 `--relay` > `AGENTNET_RELAYS` > `config.json`**
 * —— 高优先级来源**有值时完全取代**低优先级来源，不做合并（合并会让"我想只用这一个"变成"多连了一堆"）。
 *
 * config.json（0644）还承载 `init --name` 写入的 `name` 字段。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { configPath, type Env } from '../config/paths'

export interface CliConfig {
  name?: string
  relays?: string[]
}

export function readCliConfig(env: Env = process.env): CliConfig {
  const path = configPath(env)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const config: CliConfig = {}
    if (typeof parsed['name'] === 'string') config.name = parsed['name']
    if (Array.isArray(parsed['relays'])) {
      config.relays = parsed['relays'].filter((r): r is string => typeof r === 'string')
    }
    return config
  } catch {
    // 配置文件损坏不应让命令直接失败 —— 忽略并当作空配置，
    // 由中继来源校验在真正需要中继的命令里报出明确错误。
    return {}
  }
}

export function writeCliConfig(config: CliConfig, env: Env = process.env): void {
  writeFileSync(configPath(env), JSON.stringify(config, null, 2) + '\n', { mode: 0o644 })
}

export class NoRelaysConfiguredError extends Error {
  constructor() {
    super(
      '未配置任何中继。\n' +
        '中继来源优先级：命令行 --relay > 环境变量 AGENTNET_RELAYS（逗号分隔） > config.json 的 relays 字段。\n' +
        `config.json 位于 ${configPath()}。本地测试可用：nak serve`,
    )
    this.name = 'NoRelaysConfiguredError'
  }
}

/** 按优先级解析中继列表。`cliRelays` 非空时完全取代其余来源。 */
export function resolveRelays(cliRelays: readonly string[], env: Env = process.env): string[] {
  if (cliRelays.length > 0) return [...cliRelays]

  const envRelays = (env['AGENTNET_RELAYS'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '')
  if (envRelays.length > 0) return envRelays

  const config = readCliConfig(env)
  if (config.relays !== undefined && config.relays.length > 0) return config.relays

  throw new NoRelaysConfiguredError()
}
