import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { AutoReplyPolicy, handleEnvelope } from '../../src/receive/handler'
import { PendingPings } from '../../src/receive/pending-pings'
import type { AgentEnvelope } from '../../src/envelope/validate'

const pk = (c: string) => c.repeat(64)
const NOW = 1_700_000_000

function envelope(overrides: Partial<AgentEnvelope>): AgentEnvelope {
  return {
    v: 0,
    id: '0196b874-5f2a-7e3a-9b1c-2d4f6a8c0e1d',
    type: 'text',
    from: pk('a'),
    to: pk('b'),
    created_at: NOW,
    expires_at: NOW + 3600,
    payload: { kind: 'text', text: 'hi' },
    receipt: null,
    ...overrides,
  }
}

describe('AutoReplyPolicy（每发送方 10/60s + 全局 100/60s）', () => {
  it('按发送方限速：第 11 次被压', () => {
    const policy = new AutoReplyPolicy({ now: () => NOW })
    for (let i = 0; i < 10; i++) {
      expect(policy.tryReplyTo(pk('a')).allowed).toBe(true)
    }
    expect(policy.tryReplyTo(pk('a'))).toMatchObject({ allowed: false, reason: 'PER_SENDER_LIMIT' })
    // 另一个发送方仍有自己的配额
    expect(policy.tryReplyTo(pk('c')).allowed).toBe(true)
  })

  it('全局上限：打满后所有人都被压，原因为 GLOBAL_LIMIT', () => {
    const policy = new AutoReplyPolicy({ now: () => NOW, globalLimit: 3 })
    expect(policy.tryReplyTo(pk('a')).allowed).toBe(true)
    expect(policy.tryReplyTo(pk('b')).allowed).toBe(true)
    expect(policy.tryReplyTo(pk('c')).allowed).toBe(true)
    expect(policy.tryReplyTo(pk('d'))).toMatchObject({ allowed: false, reason: 'GLOBAL_LIMIT' })
  })

  it('窗口滑动后恢复', () => {
    let t = NOW * 1000
    const policy = new AutoReplyPolicy({ now: () => t, perSenderLimit: 1 })
    expect(policy.tryReplyTo(pk('a')).allowed).toBe(true)
    expect(policy.tryReplyTo(pk('a')).allowed).toBe(false)
    t += 61_000
    expect(policy.tryReplyTo(pk('a')).allowed).toBe(true)
  })
})

describe('PendingPings（pong 必须引用未完成的 ping）', () => {
  it('登记后可消费一次，再次消费失败', () => {
    const pings = new PendingPings({ now: () => NOW * 1000 })
    pings.register('ping-1')
    expect(pings.consume('ping-1')).toBe(true)
    expect(pings.consume('ping-1')).toBe(false)
  })

  it('超时的 ping 不再有效', () => {
    let t = NOW * 1000
    const pings = new PendingPings({ now: () => t, ttlSeconds: 60 })
    pings.register('ping-1')
    t += 61_000
    expect(pings.consume('ping-1')).toBe(false)
  })

  it('没登记过的 id 直接失败', () => {
    const pings = new PendingPings({ now: () => NOW * 1000 })
    expect(pings.consume('never-sent')).toBe(false)
  })
})

describe('handleEnvelope（业务处理规则）', () => {
  const skB = generateSecretKey()

  function mk(overrides: Partial<Parameters<typeof handleEnvelope>[0]> = {}) {
    const sent: unknown[] = []
    const texts: string[] = []
    return {
      deps: {
        ownPubkey: getPublicKey(skB),
        ownSecretKey: skB,
        now: () => NOW,
        autoReply: new AutoReplyPolicy({ now: () => NOW }),
        pendingPings: new PendingPings({ now: () => NOW * 1000 }),
        send: (e: unknown) => sent.push(e),
        onText: (_from: string, _id: string, text: string) => texts.push(text),
        ...overrides,
      } as Parameters<typeof handleEnvelope>[0],
      sent,
      texts,
    }
  }

  it('只有 ping 触发自动回复（发出 pong）', () => {
    const { deps, sent } = mk()
    const outcome = handleEnvelope(deps, envelope({ type: 'ping', payload: { kind: 'ping' } }))
    expect(outcome.action).toBe('PONG_SENT')
    expect(sent).toHaveLength(1)
  })

  it('超限的 ping 不回复', () => {
    const { deps, sent } = mk({
      autoReply: new AutoReplyPolicy({ now: () => NOW, globalLimit: 0 }),
    })
    const outcome = handleEnvelope(deps, envelope({ type: 'ping', payload: { kind: 'ping' } }))
    expect(outcome.action).toBe('PONG_SUPPRESSED_RATE_LIMIT')
    expect(sent).toHaveLength(0)
  })

  it('pong 引用未完成的 ping → 接受；引用陌生的 ping → 忽略', () => {
    const { deps } = mk()
    deps.pendingPings.register('our-ping-1')
    expect(
      handleEnvelope(deps, {
        ...envelope({ type: 'pong', from: pk('a') }),
        payload: { kind: 'pong', id: 'our-ping-1' },
      }).action,
    ).toBe('PONG_ACCEPTED')
    expect(
      handleEnvelope(deps, {
        ...envelope({ type: 'pong', from: pk('a') }),
        payload: { kind: 'pong', id: 'stranger-ping' },
      }).action,
    ).toBe('PONG_IGNORED_NO_PENDING_PING')
  })

  it('pong 不触发自动回复', () => {
    const { deps, sent } = mk()
    handleEnvelope(deps, {
      ...envelope({ type: 'pong' }),
      payload: { kind: 'pong', id: 'whatever' },
    })
    expect(sent).toHaveLength(0)
  })

  it('text 只到展示层，不触发任何发送', () => {
    const { deps, texts, sent } = mk()
    const outcome = handleEnvelope(deps, envelope({ type: 'text' }))
    expect(outcome.action).toBe('TEXT_DELIVERED_TO_UI')
    expect(texts).toEqual(['hi'])
    expect(sent).toHaveLength(0)
  })
})
