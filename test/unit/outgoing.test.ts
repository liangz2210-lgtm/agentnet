/**
 * 发送侧构造的单测。
 *
 * 这里专门锁住一个端到端才暴露得出的 bug：`--ttl` 在 CLI 层被解析、被校验，
 * 却**没有传给 buildTextMessage**，消息恒用默认 3600 秒。单元测试当时全绿，
 * 是"发一条 1 秒后过期的消息"这条 e2e 用例把它抓出来的。
 */

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { buildTextMessage, buildPingMessage } from '../../src/messaging/outgoing'
import { unwrapGiftWrap } from '../../src/envelope/wrap'
import { DEFAULT_LIFETIME_SECONDS } from '../../src/envelope/constants'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const peerSk = generateSecretKey()
const peerPk = getPublicKey(peerSk)
const NOW = Math.floor(Date.now() / 1000)

const deps = { ownSecretKey: sk, ownPubkey: pk, now: () => NOW }

/**
 * 解出内层信封（用**接收方**私钥），返回有效期跨度。
 * 注意：信封 JSON 里**没有** created_at 字段 —— SPEC v0.2 起以 `rumor.created_at`
 * 为唯一时间基准，所以 created_at 必须从 rumor 上取。
 */
function lifetimeOf(wrap: Parameters<typeof unwrapGiftWrap>[0]): number {
  const inner = unwrapGiftWrap(wrap, peerSk)
  if (!inner.ok) throw new Error(inner.reason)
  const e = JSON.parse(inner.rumor.content) as { expires_at: number }
  return e.expires_at - inner.rumor.created_at
}

function textWrap(text: string, ttl?: number) {
  const built =
    ttl === undefined ? buildTextMessage(deps, peerPk, text) : buildTextMessage(deps, peerPk, text, ttl)
  if (!built.ok) throw new Error(built.detail)
  return built.wrap
}

describe('buildTextMessage 的有效期', () => {
  it('未指定 ttl 时用默认 3600 秒', () => {
    expect(lifetimeOf(textWrap('hi'))).toBe(DEFAULT_LIFETIME_SECONDS)
  })

  it('指定 ttl 时**真的用上**（回归：曾因漏传参数恒为默认值）', () => {
    expect(lifetimeOf(textWrap('hi', 60))).toBe(60)
    expect(lifetimeOf(textWrap('hi', 1))).toBe(1)
    expect(lifetimeOf(textWrap('hi', 86_400))).toBe(86_400)
  })

  it('ping 用默认有效期', () => {
    const built = buildPingMessage(deps, peerPk)
    if (!built.ok) throw new Error(built.detail)
    expect(lifetimeOf(built.wrap)).toBe(DEFAULT_LIFETIME_SECONDS)
  })
})
