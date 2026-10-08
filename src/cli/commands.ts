/**
 * CLI 命令实现 —— 只做"把三层（身份/信封/传输）拼起来 + I/O"，
 * 业务规则全部在底层模块，命令层不复制任何校验逻辑。
 *
 * 约定（用户定稿，DECISIONS §8）：
 * - 正常输出 → stdout；错误/诊断 → stderr
 * - `--json`：每行一个 JSON 对象
 * - 命令完成后**必须自行退出**（send / ping），退出码见 exit-codes.ts
 */

import { loadIdentity, saveNewIdentity, generateIdentity, type Identity } from '../identity/identity'
import type { Env } from '../config/paths'
import { Transport } from '../transport/transport'
import { wsImplementation } from '../transport/ws-impl'
import { createPipeline } from '../receive/pipeline'
import { DedupTable } from '../receive/dedup'
import { PendingPings } from '../receive/pending-pings'
import { AutoReplyPolicy, handleEnvelope, type HandlerDeps } from '../receive/handler'
import { buildTextMessage, buildPingMessage } from '../messaging/outgoing'
import { sanitizeForDisplay } from '../envelope/sanitize'
import { DropCounters } from '../common/drop-counters'
import type { Event } from 'nostr-tools'
import { readCliConfig, writeCliConfig, resolveRelays } from './config'
import { parsePubkeyArg, InvalidPubkeyError } from './keys'
import {
  EXIT_OK,
  EXIT_OTHER,
  EXIT_USAGE,
  EXIT_NO_IDENTITY,
  EXIT_SEND_UNCONFIRMED,
  EXIT_PING_TIMEOUT,
} from './exit-codes'

export interface CommandIO {
  out: (line: string) => void
  err: (line: string) => void
  json: boolean
  readStdin: () => Promise<string>
  nowMs: () => number
}

class UsageError extends Error {}

/**
 * 命令内部直接决定退出码的受控出口（如"无身份"）。
 * 必须导出：run() 靠它把退出码透传出去，否则会落到"其他错误 → 1"，
 * 而且打印一整串堆栈。
 */
export class CommandExitError extends Error {
  constructor(readonly exitCode: number) {
    super('command exit')
  }
}

function identityOrExit(env: Env, io: CommandIO): Identity {
  try {
    return loadIdentity(env)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    throw new CommandExitError(EXIT_NO_IDENTITY)
  }
}

// ── init ────────────────────────────────────────────────────────────

export async function cmdInit(
  args: { name?: string },
  env: Env,
  io: CommandIO,
): Promise<number> {
  try {
    const id = generateIdentity()
    saveNewIdentity(id.secretKey, env)
    if (args.name !== undefined) {
      const config = readCliConfig(env)
      writeCliConfig({ ...config, name: args.name }, env)
    }
    if (io.json) {
      io.out(
        JSON.stringify({
          event: 'init',
          publickey: id.publicKey,
        }),
      )
    } else {
      io.out('身份已生成。')
      io.out(`公钥：${id.publicKey}`)
      io.out('⚠️ 私钥一旦丢失无法找回：没有助记词、没有云端备份。请自行安全备份。')
    }
    return EXIT_OK
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return EXIT_OTHER
  }
}

// ── whoami ──────────────────────────────────────────────────────────

export async function cmdWhoami(env: Env, io: CommandIO): Promise<number> {
  const id = identityOrExit(env, io)
  if (io.json) io.out(JSON.stringify({ publickey: id.publicKey }))
  else io.out(id.publicKey) // 仅公钥（用户定稿）
  return EXIT_OK
}

// ── send ────────────────────────────────────────────────────────────

export const MAX_TTL_SECONDS = 86_400

export async function cmdSend(
  args: { pubkey: string; text: string; ttl?: number; relays: string[] },
  env: Env,
  io: CommandIO,
): Promise<number> {
  const to = parsePubkeyArg(args.pubkey) // 疑似 nsec → UsageError
  let text = args.text
  if (text === '-') text = await io.readStdin()

  let ttl = args.ttl ?? 3600
  if (!Number.isFinite(ttl) || ttl <= 0) throw new UsageError('--ttl 必须是正整数秒')
  if (ttl > MAX_TTL_SECONDS) {
    throw new UsageError(`--ttl 上限为 ${MAX_TTL_SECONDS} 秒（24 小时）`)
  }

  const id = identityOrExit(env, io)
  const urls = resolveRelays(args.relays, env)

  const built = buildTextMessage(
    { ownSecretKey: id.secretKey, ownPubkey: id.publicKey, now: () => Math.floor(io.nowMs() / 1000) },
    to,
    text,
    ttl,
  )
  if (!built.ok) {
    io.err(`消息构造失败：${built.detail}`)
    return EXIT_OTHER
  }

  const transport = new Transport({
    urls,
    websocketImplementation: wsImplementation(),
    log: (line) => io.err(`[relay] ${line}`),
  })
  try {
    const connectResults = await transport.connect()
    for (const r of connectResults) {
      if (!r.ok) io.err(`[relay] 连接失败：${r.url}（${r.message}）`)
    }

    const report = await transport.publish(built.wrap)
    if (io.json) {
      io.out(JSON.stringify({ event: 'send', delivered: report.delivered, results: report.results }))
    } else if (report.delivered) {
      for (const r of report.results) {
        io.out(`${r.ok ? '✓ 已确认' : '✗ 未确认'} ${r.url}`)
      }
    } else {
      io.err('消息未被任何中继确认 —— 未送达。')
    }
    return report.delivered ? EXIT_OK : EXIT_SEND_UNCONFIRMED
  } finally {
    transport.close()
  }
}

// ── ping ────────────────────────────────────────────────────────────

export async function cmdPing(
  args: { pubkey: string; timeout?: number; relays: string[] },
  env: Env,
  io: CommandIO,
): Promise<number> {
  const to = parsePubkeyArg(args.pubkey)
  const timeoutSeconds = args.timeout ?? 10
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UsageError('--timeout 必须是正整数秒')
  }

  const id = identityOrExit(env, io)
  const urls = resolveRelays(args.relays, env)

  const nowSeconds = () => Math.floor(io.nowMs() / 1000)
  const built = buildPingMessage({ ownSecretKey: id.secretKey, ownPubkey: id.publicKey, now: nowSeconds }, to)
  if (!built.ok) {
    io.err(`消息构造失败：${built.detail}`)
    return EXIT_OTHER
  }

  const counters = new DropCounters()
  const transport = new Transport({
    urls,
    websocketImplementation: wsImplementation(),
    log: (line) => io.err(`[relay] ${line}`),
    counters,
    onRelayStatus: (url, status) => {
      if (io.json) io.out(JSON.stringify({ type: 'relay_status', url, status }))
    },
  })

  const pendingPings = new PendingPings({ now: io.nowMs, ttlSeconds: timeoutSeconds + 5 })
  let resolvePong: ((from: string, atMs: number) => void) | null = null
  const pongPromise = new Promise<{ from: string; atMs: number }>((resolve) => {
    resolvePong = (from, atMs) => resolve({ from, atMs })
  })

  const handlerDeps: HandlerDeps = {
    ownPubkey: id.publicKey,
    ownSecretKey: id.secretKey,
    now: nowSeconds,
    autoReply: new AutoReplyPolicy({ now: nowSeconds }),
    pendingPings,
    send: (event: Event) => {
      void transport.publish(event).then((report) => {
        if (!report.delivered) io.err('[relay] pong 未能送达任何中继')
      })
    },
    onText: (from, envelopeId, text) => {
      const display = sanitizeForDisplay(text)
      if (io.json) {
        io.out(JSON.stringify({ type: 'text', from, id: envelopeId, text: display.text, truncated: display.truncated }))
      } else {
        io.out(`[text] ${from}: ${display.text}`)
      }
    },
    counters,
  }
  const dedup = new DedupTable()
  const handleIncoming = createPipeline({
    ownSecretKey: id.secretKey,
    ownPubkey: id.publicKey,
    now: nowSeconds,
    dedup,
    counters,
    handler: (envelope) => {
      const outcome = handleEnvelope(handlerDeps, envelope)
      if (outcome.action === 'PONG_ACCEPTED') {
        resolvePong?.(envelope.from, io.nowMs())
      }
    },
    onReject: (reason) => {
      // 只记原因码与累计次数 —— detail 里可能夹带攻击者可控文本，不写日志
      if (reason !== 'DUPLICATE') io.err(`[receive] 丢弃 ${reason}（累计 ${counters.countOf(reason)} 次）`)
    },
  })

  try {
    const connectResults = await transport.connect()
    for (const r of connectResults) {
      if (!r.ok) io.err(`[relay] 连接失败：${r.url}（${r.message}）`)
    }

    // pong 通过订阅本机 gift wrap 到达 —— 必须先订阅再发
    transport.subscribeGiftWraps(id.publicKey, (evt) => {
      handleIncoming(evt)
    })

    // 先登记再发布：pong 可能先于 publish 返回值到达
    pendingPings.register(built.envelopeId)
    const sentAtMs = io.nowMs()
    const report = await transport.publish(built.wrap)
    if (!report.delivered) {
      if (io.json) io.out(JSON.stringify({ event: 'ping', ok: false, reason: 'UNCONFIRMED' }))
      else io.err('ping 未被任何中继确认 —— 未送达。')
      return EXIT_SEND_UNCONFIRMED
    }

    const pong = await Promise.race([
      pongPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutSeconds * 1000)),
    ])

    if (pong === null) {
      if (io.json) io.out(JSON.stringify({ event: 'ping', ok: false, reason: 'TIMEOUT' }))
      else io.err(`ping 超时（${timeoutSeconds} 秒内未收到 pong）。`)
      return EXIT_PING_TIMEOUT
    }

    const latency = pong.atMs - sentAtMs
    if (io.json) {
      io.out(JSON.stringify({ event: 'ping', ok: true, from: pong.from, latencyMs: latency }))
    } else {
      io.out(`pong 来自 ${pong.from}，往返 ${latency} ms`)
    }
    return EXIT_OK
  } finally {
    transport.close()
  }
}

// ── listen ──────────────────────────────────────────────────────────

export async function cmdListen(
  args: { relays: string[] },
  env: Env,
  io: CommandIO,
): Promise<number> {
  const id = identityOrExit(env, io)
  const urls = resolveRelays(args.relays, env)

  const counters = new DropCounters()
  const transport = new Transport({
    urls,
    websocketImplementation: wsImplementation(),
    log: (line) => io.err(`[relay] ${line}`),
    counters,
    onRelayStatus: (url, status) => {
      // 状态变化时打印（用户定稿）
      if (io.json) io.out(JSON.stringify({ type: 'relay_status', url, status }))
      else io.err(`[relay] ${status} ${url}`)
    },
  })

  const nowSeconds = () => Math.floor(io.nowMs() / 1000)
  const handlerDeps: HandlerDeps = {
    ownPubkey: id.publicKey,
    ownSecretKey: id.secretKey,
    now: nowSeconds,
    autoReply: new AutoReplyPolicy({ now: nowSeconds }),
    pendingPings: new PendingPings({ now: io.nowMs }),
    send: (event: Event) => {
      void transport.publish(event).then((report) => {
        if (!report.delivered) io.err('[relay] 自动回复未能送达任何中继')
      })
    },
    counters,
    onText: (from, envelopeId, text) => {
      // 文本只展示，不执行，不传 LLM（SPEC §7 规则 5）；发送者显示**完整公钥**
      const display = sanitizeForDisplay(text)
      if (io.json) {
        io.out(
          JSON.stringify({
            type: 'text',
            from,
            id: envelopeId,
            text: display.text,
            truncated: display.truncated,
          }),
        )
      } else {
        io.out(`[text] ${from}: ${display.text}`)
      }
    },
  }
  const dedup = new DedupTable()
  const handleIncoming = createPipeline({
    ownSecretKey: id.secretKey,
    ownPubkey: id.publicKey,
    now: nowSeconds,
    dedup,
    counters,
    handler: (envelope) => {
      handleEnvelope(handlerDeps, envelope)
    },
    onReject: (reason) => {
      // **只记原因码与累计次数**（SPEC §7 规则 6）。
      // 这里原先会把 detail 的前 60 字符一起写进日志 —— 而 detail 里可能夹带
      // 攻击者可控的文本（未知字段名、非法 type 值等），等于把不可信内容送进日志。
      io.err(`[receive] 丢弃 ${reason}（累计 ${counters.countOf(reason)} 次）`)
    },
  })

  const connectResults = await transport.connect()
  for (const r of connectResults) {
    if (!r.ok) io.err(`[relay] 连接失败：${r.url}（${r.message}）`)
  }
  if (!connectResults.some((r) => r.ok)) {
    io.err('启动失败：所有中继都不可达。请检查 --relay / AGENTNET_RELAYS / config.json。')
    transport.close()
    return EXIT_OTHER
  }

  transport.subscribeGiftWraps(id.publicKey, (evt) => {
    handleIncoming(evt)
  })

  if (io.json) {
    io.out(JSON.stringify({ type: 'listening', publickey: id.publicKey, relays: urls }))
  } else {
    io.err(`listening，公钥 ${id.publicKey}，Ctrl-C 退出`)
  }

  // 运行到信号到来；结束后无残留定时器
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      // 移除监听：第二次信号走默认行为（直接终止），不会卡死
      for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig as NodeJS.Signals, stop)
      transport.close()
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

  // 退出前汇总丢弃计数 —— 这是将来校准每一个防御上限的**唯一数据来源**
  if (io.json) {
    io.out(JSON.stringify({ type: 'summary', drops: counters.snapshot(), total: counters.total() }))
  } else {
    io.err(`[summary] ${counters.formatSummary()}`)
  }
  return EXIT_OK
}

export { InvalidPubkeyError }
export function usageError(message: string): UsageError {
  return new UsageError(message)
}
export { UsageError }
