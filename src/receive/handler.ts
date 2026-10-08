/**
 * 自动回复与消息处理规则（DECISIONS §10）：
 *
 * - **只有 `ping` 触发自动回复**；`pong` 与 `text` 永不触发
 * - 收到的 `pong` 必须引用一个**未完成的 ping**，否则忽略
 * - 自动回复按发送方限速（每发送方 10 次/60s，已确认）
 * - 另加全局上限（100 次/60s，做成可配置常量）——
 *   ⚠️ 该值**无任何数据支撑，纯属防御性取值**；观测到误杀优先调此常量
 * - 超限静默丢弃；日志只记公钥缩写 + 消息 ID，不记内容（SPEC §7 规则 6）
 *
 * 已知限制 L3/L3a：多身份可绕过按发送方的限制，也可打满全局上限 ——
 * 两个上限都只是把伤害限流，不根治（根治需信誉/成本门槛，超出 M1）。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEnvelope } from '../envelope/validate'
import { buildEnvelope } from '../envelope/sender'
import { wrapEnvelope } from '../envelope/wrap'
import type { Event } from 'nostr-tools'
import { SlidingWindowLimiter } from '../common/rate-limit'
import { DropCounters } from '../common/drop-counters'
import type { PendingPings } from './pending-pings'

export interface AutoReplyOptions {
  perSenderLimit?: number
  globalLimit?: number
  windowMs?: number
  now?: () => number
}

export const DEFAULT_PER_SENDER_AUTO_REPLIES = 10
export const DEFAULT_GLOBAL_AUTO_REPLIES = 100
export const DEFAULT_AUTO_REPLY_WINDOW_MS = 60_000

export type AutoReplyDecision =
  | { allowed: true }
  | { allowed: false; reason: 'PER_SENDER_LIMIT' | 'GLOBAL_LIMIT' }

export class AutoReplyPolicy {
  private readonly perSender = new Map<string, SlidingWindowLimiter>()
  private readonly global: SlidingWindowLimiter
  private readonly windowMs: number

  constructor(private readonly opts: AutoReplyOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_AUTO_REPLY_WINDOW_MS
    this.global = new SlidingWindowLimiter(
      opts.globalLimit ?? DEFAULT_GLOBAL_AUTO_REPLIES,
      this.windowMs,
      opts.now ?? Date.now,
    )
  }

  /** 是否允许向该发送方回复一次；允许即占用名额（先全局后按发送方）。 */
  tryReplyTo(senderPubkey: string): AutoReplyDecision {
    if (!this.global.tryAcquire()) {
      return { allowed: false, reason: 'GLOBAL_LIMIT' }
    }
    let limiter = this.perSender.get(senderPubkey)
    if (limiter === undefined) {
      limiter = new SlidingWindowLimiter(
        this.opts.perSenderLimit ?? DEFAULT_PER_SENDER_AUTO_REPLIES,
        this.windowMs,
        this.opts.now ?? Date.now,
      )
      this.perSender.set(senderPubkey, limiter)
    }
    if (!limiter.tryAcquire()) {
      return { allowed: false, reason: 'PER_SENDER_LIMIT' }
    }
    return { allowed: true }
  }
}

export interface ReplyOutcome {
  action:
    | 'PONG_SENT'
    | 'PONG_SUPPRESSED_RATE_LIMIT'
    | 'PONG_ACCEPTED'
    | 'PONG_IGNORED_NO_PENDING_PING'
    | 'TEXT_DELIVERED_TO_UI'
}

export interface HandlerDeps {
  ownPubkey: string
  ownSecretKey: Uint8Array
  now: () => number
  autoReply: AutoReplyPolicy
  pendingPings: PendingPings
  /** 把已封好的 gift wrap 发出去（由调用方接 Transport.publish）。 */
  send: (event: Event) => void
  /** text 只到展示层（listen 打印前还会过终端控制字符过滤）。 */
  onText: (fromPubkey: string, envelopeId: string, text: string) => void
  /**
   * 丢弃计数。业务层也会丢弃（被限速压掉的 pong、无人认领的 pong），
   * 这些**同样要计数** —— 否则"自动回复上限"到底误杀了多少永远没有数据。
   */
  counters?: DropCounters
}

/**
 * 业务处理（流水线第六步）。入参信封已通过全部校验。
 * **永不抛出**：这里面的失败都只是"不回复/忽略"，用返回值表达。
 */
export function handleEnvelope(deps: HandlerDeps, envelope: AgentEnvelope): ReplyOutcome {
  if (envelope.type === 'ping') {
    // 只有 ping 触发自动回复
    const decision = deps.autoReply.tryReplyTo(envelope.from)
    if (!decision.allowed) {
      // 按**具体是哪一道闸**计数：全局 vs 每发送方，将来调的是不同的常量
      deps.counters?.record(`PONG_SUPPRESSED_${decision.reason}`)
      return { action: 'PONG_SUPPRESSED_RATE_LIMIT' }
    }
    const built = buildPong(deps, envelope.from, envelope.id)
    if (built === null) {
      deps.counters?.record('PONG_BUILD_FAILED')
      return { action: 'PONG_IGNORED_NO_PENDING_PING' }
    }
    deps.send(built)
    return { action: 'PONG_SENT' }
  }

  if (envelope.type === 'pong') {
    // pong 永不触发自动回复；必须引用我们发出且未完成的 ping
    if (envelope.payload.kind !== 'pong') {
      deps.counters?.record('PONG_UNSOLICITED')
      return { action: 'PONG_IGNORED_NO_PENDING_PING' }
    }
    if (!deps.pendingPings.consume(envelope.payload.id)) {
      // 无人认领的 pong：可能是迟到、被重放，或压根没发过 —— 计数以便观察
      deps.counters?.record('PONG_UNSOLICITED')
      return { action: 'PONG_IGNORED_NO_PENDING_PING' }
    }
    return { action: 'PONG_ACCEPTED' }
  }

  // text：只展示，不执行，不进 LLM（SPEC §7 规则 5）
  if (envelope.payload.kind === 'text') {
    deps.onText(envelope.from, envelope.id, envelope.payload.text)
    return { action: 'TEXT_DELIVERED_TO_UI' }
  }
  return { action: 'PONG_IGNORED_NO_PENDING_PING' }
}

/**
 * 构造 pong：信封（复用共享校验，构造完成即校验）→ gift wrap。
 * 失败返回 null —— 构造失败是我们自己的 bug，不该向外抛。
 */
function buildPong(deps: HandlerDeps, toPubkey: string, repliedPingId: string): Event | null {
  const result = buildEnvelope(
    {
      id: randomUUID(),
      type: 'pong',
      from: deps.ownPubkey,
      to: toPubkey,
      createdAt: deps.now(),
      payload: { id: repliedPingId },
    },
    { ownPubkey: deps.ownPubkey, now: deps.now() },
  )
  if (!result.ok) return null
  return wrapEnvelope(deps.ownSecretKey, toPubkey, result.raw)
}
