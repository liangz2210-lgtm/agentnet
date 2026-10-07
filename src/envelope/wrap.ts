/**
 * gift wrap 的封 / 拆 —— 对 `nostr-tools` 的 NIP-17 / NIP-59 薄封装。
 *
 * 三层结构（DECISIONS 第一部分 E）：
 *   wrap (kind 1059, 临时密钥, 时间戳随机回溯 0~48h)
 *    └─ seal (kind 13, 发送方真密钥签名 —— 身份证明所在)
 *        └─ rumor (kind 14, content = 应用层信封 JSON)
 */

import * as nip17 from 'nostr-tools/nip17'
import { verifyEvent, type Event } from 'nostr-tools'

/** 把应用层信封（`buildEnvelope` 的输出）封成可直接发布到中继的 gift wrap。 */
export function wrapEnvelope(
  senderPrivateKey: Uint8Array,
  recipientPubkey: string,
  envelopeRaw: string,
): Event {
  return nip17.wrapEvent(senderPrivateKey, { publicKey: recipientPubkey }, envelopeRaw)
}

export type UnwrapResult =
  | { ok: true; rumor: { content: string; pubkey: string; created_at: number } }
  | { ok: false; reason: UnwrapFailureReason; detail: string }

export type UnwrapFailureReason =
  | 'WRAP_NOT_OBJECT'
  | 'WRAP_SIGNATURE_INVALID'
  | 'WRAP_KIND_INVALID'
  | 'WRAP_DECRYPT_FAILED'
  | 'SEAL_SIGNATURE_INVALID'
  | 'RUMOR_SENDER_MISMATCH'

/**
 * 拆封 —— 接收流水线的第二步（大小检查之后）。
 *
 * `unwrapEvent`（实测，DECISIONS 第一部分 E）会：
 *   ✅ 校验 seal 签名
 *   ✅ 校验 rumor.pubkey === seal.pubkey
 *   ❌ **不校验 wrap 自身签名**
 *   ❌ **不认识应用层的 from 字段**
 * 前一个 ❌ 在这里补上（中继虽会验，但接收方执行为准）；后一个 ❌ 由 `verifyAuthenticity` 补。
 */
export function unwrapGiftWrap(wrap: unknown, recipientPrivateKey: Uint8Array): UnwrapResult {
  if (typeof wrap !== 'object' || wrap === null) {
    return { ok: false, reason: 'WRAP_NOT_OBJECT', detail: '事件不是对象' }
  }
  const event = wrap as Event
  if (event.kind !== 1059) {
    return { ok: false, reason: 'WRAP_KIND_INVALID', detail: `kind ${String(event.kind)} 不是 gift wrap` }
  }
  // 中继会验签，但「接收方执行为准」：不能把安全建立在中继的诚实上。
  if (!verifyEvent(event)) {
    return { ok: false, reason: 'WRAP_SIGNATURE_INVALID', detail: 'wrap 签名无效' }
  }
  try {
    const rumor = nip17.unwrapEvent(event, recipientPrivateKey)
    return {
      ok: true,
      rumor: { content: rumor.content, pubkey: rumor.pubkey, created_at: rumor.created_at },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('signature is invalid')) {
      return { ok: false, reason: 'SEAL_SIGNATURE_INVALID', detail: 'seal 签名无效' }
    }
    if (message.includes('does not match seal pubkey')) {
      return { ok: false, reason: 'RUMOR_SENDER_MISMATCH', detail: 'rumor 与 seal 公钥不一致' }
    }
    // 解密失败 = 不是发给我们的，或密文被篡改。细节不给攻击者。
    return { ok: false, reason: 'WRAP_DECRYPT_FAILED', detail: '解封失败' }
  }
}
