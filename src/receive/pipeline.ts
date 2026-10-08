/**
 * 接收流水线 —— 步骤**顺序固定**（SPEC §7 规则 4 / DECISIONS §6）：
 *
 *   1. 大小检查      （解密之前先拦畸形大包）
 *   2. 解封          （wrap 签名 → seal 签名 → rumor 归属）
 *   3. validateEnvelope（结构、格式、时间边界；发送/接收共用同一函数）
 *   4. verifyAuthenticity（from === 已验签的 seal 公钥；to === 本机公钥）
 *   5. 去重          （(from,id) 复合键；**在此之前的任何失败都不会写入**）
 *   6. 业务处理
 *
 * 任何一步失败只返回原因码，绝不把半成品交给下一步。
 */

import type { Event } from 'nostr-tools'
import { validateEnvelope, verifyAuthenticity, type AgentEnvelope, type RejectReason } from '../envelope/validate'
import { unwrapGiftWrap } from '../envelope/wrap'
import { DedupTable } from './dedup'
import { MAX_GIFT_WRAP_CONTENT_BYTES } from '../transport/constants'
import { DropCounters, DELIVERED } from '../common/drop-counters'

export interface PipelineOptions {
  ownSecretKey: Uint8Array
  ownPubkey: string
  /** 可注入时钟（秒）。单元测试固定值，不随真实时间 flaky。 */
  now: () => number
  dedup: DedupTable
  /** 业务处理（第六步）。只拿得到通过全部校验的信封。 */
  handler: (envelope: AgentEnvelope) => void
  /**
   * 诊断回调：只收**原因码**。
   * ⚠️ 不传 `detail` —— 它里面可能夹带攻击者可控的文本（未知字段名、非法 type 等），
   * 原样写日志等于把不可信内容送进日志文件（SPEC §7 规则 5/6）。
   */
  onReject?: (reason: ReceiveRejectReason) => void
  /** 丢弃计数（按原因码）。上层汇总后可在退出时打印，用于校准上限。 */
  counters?: DropCounters
}

export type ReceiveRejectReason =
  | 'WRAP_TOO_LARGE'
  | 'WRAP_NOT_OBJECT'
  | 'WRAP_KIND_INVALID'
  | 'WRAP_SIGNATURE_INVALID'
  | 'WRAP_DECRYPT_FAILED'
  | 'SEAL_SIGNATURE_INVALID'
  | 'RUMOR_SENDER_MISMATCH'
  | RejectReason
  | 'DUPLICATE'

export type ReceiveOutcome =
  | { ok: true; envelope: AgentEnvelope }
  | { ok: false; reason: ReceiveRejectReason; detail: string }

export function createPipeline(opts: PipelineOptions): (event: Event) => ReceiveOutcome {
  return (event: Event): ReceiveOutcome => {
    // ── 1. 大小检查（解密之前） ──────────────────────────────────────
    const contentBytes = Buffer.byteLength(event.content ?? '', 'utf8')
    if (contentBytes > MAX_GIFT_WRAP_CONTENT_BYTES) {
      return reject(opts, 'WRAP_TOO_LARGE', `${contentBytes} 字节超过解封前上限`)
    }

    // ── 2. 解封 ────────────────────────────────────────────────────
    const unwrapped = unwrapGiftWrap(event, opts.ownSecretKey)
    if (!unwrapped.ok) return reject(opts, unwrapped.reason, unwrapped.detail)

    // ── 3. 共用信封校验（rumor.created_at 是唯一时间基准） ───────────
    const validated = validateEnvelope(unwrapped.rumor.content, {
      rumorCreatedAt: unwrapped.rumor.created_at,
      now: opts.now(),
    })
    if (!validated.ok) return reject(opts, validated.reason, validated.detail)

    // ── 4. 身份认证（仅接收侧） ─────────────────────────────────────
    const authenticated = verifyAuthenticity(validated.envelope, {
      authenticatedSenderPubkey: unwrapped.rumor.pubkey,
      ownPubkey: opts.ownPubkey,
    })
    if (!authenticated.ok) return reject(opts, authenticated.reason, authenticated.detail)

    // ── 5. 去重（前面全部通过才写表） ────────────────────────────────
    const deduped = opts.dedup.add(
      authenticated.envelope.from,
      authenticated.envelope.id,
      authenticated.envelope.expires_at,
    )
    if (!deduped.ok) {
      return reject(opts, deduped.reason as ReceiveRejectReason, '重复消息或超出配额')
    }

    // ── 6. 业务处理 ────────────────────────────────────────────────
    opts.counters?.record(DELIVERED)
    opts.handler(authenticated.envelope)
    return { ok: true, envelope: authenticated.envelope }
  }
}

function reject(
  opts: PipelineOptions,
  reason: ReceiveRejectReason,
  detail: string,
): ReceiveOutcome {
  // 每一次丢弃都按原因码计数（校准防御上限的唯一数据来源）
  opts.counters?.record(reason)
  opts.onReject?.(reason)
  return { ok: false, reason, detail }
}
