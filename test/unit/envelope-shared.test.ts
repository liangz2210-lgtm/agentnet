import { describe, expect, it } from 'vitest'
import { buildEnvelope } from '../../src/envelope/sender'
import * as receiver from '../../src/envelope/receiver'
import { validateEnvelope as core } from '../../src/envelope/validate'
import type { AgentEnvelope } from '../../src/envelope/validate'

const SELF = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const T0 = 1_700_000_000

describe('发送侧与接收侧导入的是同一个函数', () => {
  it('两者引用完全相等（同一份实现，不是各写一遍）', () => {
    expect(receiver.validateEnvelope).toBe(core)
    expect((buildEnvelope as unknown as Record<string, unknown>)['_unused']).toBeUndefined()
  })

  it('发送侧的失败原因码与接收侧同源', () => {
    const send = buildEnvelope(
      { id: UUID, type: 'text', from: SELF, to: 'short', createdAt: T0, payload: { text: 'hi' } },
      { ownPubkey: SELF, now: T0 },
    )
    expect(send.ok).toBe(false)
    if (!send.ok) expect(send.reason).toBe('TO_INVALID_FORMAT')

    const recvEnvelope = { from: SELF, to: PEER } as AgentEnvelope
    const auth = receiver.verifyAuthenticity(recvEnvelope, {
      authenticatedSenderPubkey: PEER,
      ownPubkey: PEER,
    })
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.reason).toBe('FROM_MISMATCH')
  })
})

describe('发送侧 buildEnvelope', () => {
  it('from 不等于本机公钥时被拒绝', () => {
    const r = buildEnvelope(
      { id: UUID, type: 'text', from: PEER, to: PEER, createdAt: T0, payload: { text: 'hi' } },
      { ownPubkey: SELF, now: T0 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('FROM_NOT_SELF')
  })

  it('构造成功后立即跑共享校验，并交回 raw 与结构化信封', () => {
    const r = buildEnvelope(
      { id: UUID, type: 'ping', from: SELF, to: PEER, createdAt: T0, payload: {} },
      { ownPubkey: SELF, now: T0 },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(typeof r.raw).toBe('string')
      expect(JSON.parse(r.raw)['created_at']).toBeUndefined()
      expect(r.envelope.expires_at).toBe(T0 + 3600)
      expect(r.envelope.payload).toEqual({ kind: 'ping' })
    }
  })

  it('超过 24 小时的有效期在发送侧就被拦下，不必走网络', () => {
    const r = buildEnvelope(
      {
        id: UUID,
        type: 'text',
        from: SELF,
        to: PEER,
        createdAt: T0,
        lifetimeSeconds: 24 * 3600 + 1,
        payload: { text: 'hi' },
      },
      { ownPubkey: SELF, now: T0 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('LIFETIME_TOO_LONG')
  })

  it('ping 带非空 payload 在发送侧就被拦下', () => {
    const r = buildEnvelope(
      { id: UUID, type: 'ping', from: SELF, to: PEER, createdAt: T0, payload: { x: 1 } },
      { ownPubkey: SELF, now: T0 },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('PAYLOAD_INVALID')
  })
})

describe('接收侧 verifyAuthenticity（仅接收侧存在）', () => {
  const envelope: AgentEnvelope = {
    v: 0,
    id: UUID,
    type: 'text',
    from: PEER,
    to: SELF,
    created_at: T0,
    expires_at: T0 + 60,
    payload: { kind: 'text', text: 'hi' },
    receipt: null,
  }

  it('from 与 to 均匹配才通过', () => {
    const r = receiver.verifyAuthenticity(envelope, {
      authenticatedSenderPubkey: PEER,
      ownPubkey: SELF,
    })
    expect(r.ok).toBe(true)
  })

  it('from 不等于已验签的 seal 公钥 -> FROM_MISMATCH', () => {
    const attacker = { ...envelope, from: 'c'.repeat(64) }
    const r = receiver.verifyAuthenticity(attacker, {
      authenticatedSenderPubkey: PEER,
      ownPubkey: SELF,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('FROM_MISMATCH')
  })

  it('to 不等于本机公钥 -> TO_MISMATCH', () => {
    const r = receiver.verifyAuthenticity(envelope, {
      authenticatedSenderPubkey: PEER,
      ownPubkey: 'd'.repeat(64),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('TO_MISMATCH')
  })
})

describe('端到端：发送侧产出 -> 接收侧校验（全链路同源）', () => {
  it('自产自收能通过全部校验', () => {
    const built = buildEnvelope(
      { id: UUID, type: 'text', from: SELF, to: PEER, createdAt: T0, payload: { text: 'hi' } },
      { ownPubkey: SELF, now: T0 },
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const got = receiver.validateEnvelope(built.raw, { rumorCreatedAt: T0, now: T0 })
    expect(got.ok).toBe(true)
    if (!got.ok) return

    const authed = receiver.verifyAuthenticity(got.envelope, {
      authenticatedSenderPubkey: SELF,
      ownPubkey: PEER,
    })
    expect(authed.ok).toBe(true)
  })
})
