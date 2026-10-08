/**
 * CLI 入口：参数解析 + 命令分发 + 退出码。
 *
 * 退出码（DECISIONS §8）：0 成功 / 1 其他 / 2 用法 / 3 无身份 /
 * 4 发送未被任何中继确认 / 5 ping 超时。
 */

import type { Env } from '../config/paths'
import {
  cmdInit,
  cmdListen,
  cmdPing,
  cmdSend,
  cmdWhoami,
  UsageError,
  InvalidPubkeyError,
  CommandExitError,
  type CommandIO,
} from './commands'
import { NoRelaysConfiguredError } from './config'
import {
  EXIT_OK,
  EXIT_OTHER,
  EXIT_USAGE,
} from './exit-codes'

const USAGE = `agentnet —— 开源网络的 agent 间通讯层（里程碑 1）

用法:
  agentnet init [--name <name>]            生成本机身份（已有身份则拒绝，不覆盖）
  agentnet whoami                          显示本机公钥
  agentnet send <公钥> <文本> [--ttl 秒]   发送 text 消息；文本为 - 时读标准输入
  agentnet ping <公钥> [--timeout 秒]      发送 ping 并等待 pong
  agentnet listen                          连接中继，接收并显示消息

公钥: 64 位十六进制或 npub1…（NIP-19）。疑似 nsec 私钥的参数会被拒绝。

选项:
  --relay <url>      指定中继（可重复）。中继优先级: 命令行 > AGENTNET_RELAYS > config.json
  --json             每行输出一个 JSON 对象
  --ttl <秒>         send 的有效期，默认 3600，上限 86400
  --timeout <秒>     ping 等待 pong 的时长，默认 10

退出码: 0 成功 | 1 其他错误 | 2 用法错误 | 3 无身份 | 4 发送未被任何中继确认 | 5 ping 超时
`

interface ParsedArgs {
  positionals: string[]
  relays: string[]
  json: boolean
  name?: string
  ttl?: number
  timeout?: number
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], relays: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new UsageError(`选项 ${arg} 缺少参数`)
      }
      i += 1
      return value
    }
    switch (arg) {
      case '--json':
        parsed.json = true
        break
      case '--relay':
        parsed.relays.push(next())
        break
      case '--name':
        parsed.name = next()
        break
      case '--ttl': {
        const value = Number(next())
        if (!Number.isFinite(value)) throw new UsageError('--ttl 必须是数字')
        parsed.ttl = value
        break
      }
      case '--timeout': {
        const value = Number(next())
        if (!Number.isFinite(value)) throw new UsageError('--timeout 必须是数字')
        parsed.timeout = value
        break
      }
      default:
        if (arg.startsWith('--')) throw new UsageError(`未知选项：${arg}`)
        parsed.positionals.push(arg)
    }
  }
  return parsed
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
  })
}

/**
 * 运行一条命令，返回退出码。**不调用 process.exit** —— 由入口统一调用，
 * 便于测试注入 I/O 后直接拿返回值。
 */
export async function run(argv: readonly string[], env: Env = process.env, io?: Partial<CommandIO>): Promise<number> {
  const command = argv[0] ?? ''
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv.slice(1))
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}`)
      return EXIT_USAGE
    }
    throw err
  }

  const commandIo: CommandIO = {
    out: io?.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: io?.err ?? ((line) => process.stderr.write(`${line}\n`)),
    json: parsed.json,
    readStdin: io?.readStdin ?? readStdin,
    nowMs: io?.nowMs ?? Date.now,
  }

  try {
    switch (command) {
      case 'init': {
        const name = parsed.name
        return await cmdInit(name === undefined ? {} : { name }, env, commandIo)
      }
      case 'whoami':
        return await cmdWhoami(env, commandIo)
      case 'send': {
        const [pubkey, ...textParts] = parsed.positionals
        if (pubkey === undefined || textParts.length === 0) {
          throw new UsageError('用法: agentnet send <公钥> <文本> [--ttl 秒]（文本为 - 时读标准输入）')
        }
        return await cmdSend(
          {
            pubkey,
            text: textParts.join(' '),
            ...(parsed.ttl === undefined ? {} : { ttl: parsed.ttl }),
            relays: parsed.relays,
          },
          env,
          commandIo,
        )
      }
      case 'ping': {
        const [pubkey] = parsed.positionals
        if (pubkey === undefined) throw new UsageError('用法: agentnet ping <公钥> [--timeout 秒]')
        return await cmdPing(
          {
            pubkey,
            ...(parsed.timeout === undefined ? {} : { timeout: parsed.timeout }),
            relays: parsed.relays,
          },
          env,
          commandIo,
        )
      }
      case 'listen':
        return await cmdListen({ relays: parsed.relays }, env, commandIo)
      case '--help':
      case '-h':
      case 'help':
      case '':
        process.stderr.write(USAGE)
        return command === '' ? EXIT_USAGE : EXIT_OK
      default:
        throw new UsageError(`未知命令：${command}`)
    }
  } catch (err) {
    // 命令自己定的退出码（如"无身份" → 3）：透传，不打堆栈
    if (err instanceof CommandExitError) return err.exitCode
    if (err instanceof UsageError) {
      commandIo.err(`${err.message}\n\n${USAGE}`)
      return EXIT_USAGE
    }
    if (err instanceof InvalidPubkeyError) {
      commandIo.err(err.message)
      return EXIT_USAGE
    }
    if (err instanceof NoRelaysConfiguredError) {
      commandIo.err(err.message)
      return EXIT_USAGE
    }
    commandIo.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
    return EXIT_OTHER
  }
}

/** 入口（编译后由 bin 直接调用）。 */
export async function main(): Promise<void> {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
