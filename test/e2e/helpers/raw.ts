/**
 * 端到端里"真实 CLI 发不出来"的那些场景，在这里手工构造 gift wrap 后直接投递到中继：
 *   - 伪造发送者：用 C 的私钥签名，但信封里 `from` 写 A
 *   - 重复投递：同一个信封 id 发两次
 * 这两件事 CLI 出于设计不会做，但它们**必须被接收方拒绝**，所以由测试来扮演攻击者。
 */

import type { Event } from 'nostr-tools'
import { nip59 } from 'nostr-tools'
import { Transport } from '../../../src/transport/transport'
import { wsCast } from '../../integration/helpers/ws-cast'

export interface RawEnvelope {
  id: string
  type: 'text' | 'ping' | 'pong'
  from: string
  to: string
  created_at?: number
  expires_at: number
  payload: Record<string, unknown>
}

export function envelopeJson(e: RawEnvelope): string {
  return JSON.stringify({
    v: 0,
    id: e.id,
    type: e.type,
    from: e.from,
    to: e.to,
    created_at: e.created_at ?? e.expires_at - 3600,
    expires_at: e.expires_at,
    payload: e.payload,
    receipt: null,
  })
}

/**
 * 用 `signerSk` 签名一个信封并包成 gift wrap 投给 `recipientPubkey`。
 * 信封内容由调用方给 —— 所以 `from` 可以与签名者不一致（这正是伪造场景）。
 */
export function sealAndWrap(
  signerSk: Uint8Array,
  recipientPubkey: string,
  content: string,
  createdAt: number,
): Event {
  const rumor = nip59.createRumor({ kind: 14, content, tags: [], created_at: createdAt }, signerSk)
  const seal = nip59.createSeal(rumor, signerSk, recipientPubkey)
  return nip59.createWrap(seal, recipientPubkey)
}

/** 把一个已经构造好的 wrap 事件投递到中继；返回是否至少被一个中继确认。 */
export async function deliver(url: string, event: Event): Promise<boolean> {
  const transport = new Transport({
    urls: [url],
    websocketImplementation: wsCast(),
  })
  try {
    await transport.connect()
    const report = await transport.publish(event)
    return report.delivered
  } finally {
    transport.close()
  }
}

/** 中继上抓到的原始事件（用于验证"线上只有密文"）。 */
export async function fetchGiftWraps(url: string, pubkey: string): Promise<Event[]> {
  const transport = new Transport({
    urls: [url],
    websocketImplementation: wsCast(),
  })
  try {
    await transport.connect()
    const events: Event[] = []
    await new Promise<void>((resolve) => {
      transport.subscribeGiftWraps(pubkey, (evt) => events.push(evt))
      setTimeout(resolve, 800)
    })
    return events
  } finally {
    transport.close()
  }
}
