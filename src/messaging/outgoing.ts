/**
 * 发送侧的消息构造：应用层信封（复用共享校验，构造完成即校验）→ gift wrap。
 *
 * 注意：发送侧的校验**只是提前报错**，不构成安全保障（DECISIONS §6）。
 * 私钥只在本模块的调用栈里流转，绝不进日志、环境变量或命令行参数。
 */

import { randomUUID } from 'node:crypto'
import type { Event } from 'nostr-tools'
import { buildEnvelope } from '../envelope/sender'
import { wrapEnvelope } from '../envelope/wrap'
import { DEFAULT_LIFETIME_SECONDS } from '../envelope/constants'

export interface OutgoingDeps {
  ownSecretKey: Uint8Array
  ownPubkey: string
  now: () => number
}

export interface OutgoingOk {
  ok: true
  wrap: Event
  envelopeId: string
}
export type OutgoingResult =
  | OutgoingOk
  | { ok: false; reason: string; detail: string }

/**
 * 发送 text 消息。
 *
 * `lifetimeSeconds` 对应 CLI 的 `--ttl`。**必须显式接进来** —— 第 5 步端到端抓到过
 * 一次"--ttl 被解析、被校验，却没被传到这里"的 bug，消息恒用默认 3600 秒，
 * 于是"发一条 1 秒后过期的消息"这条用例直接失败。
 */
export function buildTextMessage(
  deps: OutgoingDeps,
  to: string,
  text: string,
  lifetimeSeconds: number = DEFAULT_LIFETIME_SECONDS,
): OutgoingResult {
  return build(deps, to, 'text', { text }, lifetimeSeconds)
}

/** 发送 ping。返回的 `envelopeId` 应由调用方登记进 `PendingPings`。 */
export function buildPingMessage(deps: OutgoingDeps, to: string): OutgoingResult {
  return build(deps, to, 'ping', {})
}

function build(
  deps: OutgoingDeps,
  to: string,
  type: 'ping' | 'text',
  payload: Record<string, unknown>,
  lifetimeSeconds: number = DEFAULT_LIFETIME_SECONDS,
): OutgoingResult {
  const now = deps.now()
  const result = buildEnvelope(
    {
      id: randomUUID(),
      type,
      from: deps.ownPubkey,
      to,
      createdAt: now,
      lifetimeSeconds,
      payload,
    },
    { ownPubkey: deps.ownPubkey, now },
  )
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }
  return {
    // 传入同一个 now：rumor.created_at 必须与信封的 created_at 基准一致
    ok: true,
    wrap: wrapEnvelope(deps.ownSecretKey, to, result.raw, now),
    envelopeId: result.envelope.id,
  }
}
