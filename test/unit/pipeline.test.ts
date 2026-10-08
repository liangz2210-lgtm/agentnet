/**
 * 接收流水线的**离线端到端**测试：真密钥、真加密、真解封，只不经过网络。
 * 六步顺序在这里逐级验证 —— 每一级只挡它该挡的，且失败不写去重表。
 */

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import * as nip59 from 'nostr-tools/nip59'
import type { Event } from 'nostr-tools'
import { buildEnvelope } from '../../src/envelope/sender'
import { wrapEnvelope } from '../../src/envelope/wrap'
import { DedupTable } from '../../src/receive/dedup'
import { createPipeline, type ReceiveOutcome } from '../../src/receive/pipeline'
import { DropCounters, DELIVERED } from '../../src/common/drop-counters'
import type { AgentEnvelope } from '../../src/envelope/validate'

/**
 * 以真实当前时间为基准：nip59 的 rumor/created_at 取自系统时钟，
 * 而流水线的 `now` 是可注入的 —— 两者必须同一量级，否则会先撞上
 * "created_at 超前 10 分钟"的检查而测不到目标分支。
 */
const NOW = Math.floor(Date.now() / 1000)

const skA = generateSecretKey()
const skB = generateSecretKey()
const pkA = getPublicKey(skA)
const pkB = getPublicKey(skB)
const skC = generateSecretKey()
const pkC = getPublicKey(skC)

function makeEnvelope(input: Partial<Parameters<typeof buildEnvelope>[0]>): string {
  const createdAt = input.createdAt ?? NOW
  const result = buildEnvelope(
    {
      id: input.id ?? '0196b874-5f2a-7e3a-9b1c-2d4f6a8c0e1d',
      type: input.type ?? 'text',
      from: input.from ?? pkA,
      to: input.to ?? pkB,
      createdAt,
      ...(input.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: input.lifetimeSeconds }),
      payload: input.payload ?? { text: 'hello' },
    },
    { ownPubkey: input.from ?? pkA, now: createdAt },
  )
  if (!result.ok) throw new Error(`测试信封构造失败：${result.detail}`)
  return result.raw
}

function makePipeline(handler: (e: AgentEnvelope) => void = () => {}) {
  const rejects: { reason: string }[] = []
  const dedup = new DedupTable({ now: () => NOW })
  const counters = new DropCounters()
  const process = createPipeline({
    ownSecretKey: skB,
    ownPubkey: pkB,
    now: () => NOW,
    dedup,
    handler,
    onReject: (reason) => rejects.push({ reason }),
    counters,
  })
  return { process, dedup, rejects, counters }
}

describe('接收流水线（顺序固定：大小→解封→校验→认证→去重→业务）', () => {
  it('合法 text 消息走完全部六步', () => {
    const seen: AgentEnvelope[] = []
    const { process } = makePipeline((e) => seen.push(e))
    const wrap = wrapEnvelope(skA, pkB, makeEnvelope({}))

    const outcome = process(wrap)
    expect(outcome.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.payload).toEqual({ kind: 'text', text: 'hello' })
  })

  it('第 1 步：解封前按密文长度拦下超大包（WRAP_TOO_LARGE）', () => {
    const { process } = makePipeline()
    const rumor = nip59.createRumor(
      { kind: 14, content: 'x'.repeat(200 * 1024), tags: [] },
      skA,
    )
    const wrap = nip59.createWrap(nip59.createSeal(rumor, skA, pkB), pkB)
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'WRAP_TOO_LARGE' })
  })

  it('第 2 步：篡改 wrap 签名被拒（接收方不信任中继的验签）', () => {
    const { process } = makePipeline()
    const wrap = { ...wrapEnvelope(skA, pkB, makeEnvelope({})), sig: '00'.repeat(64) }
    expect(process(wrap as Event)).toMatchObject({
      ok: false,
      reason: 'WRAP_SIGNATURE_INVALID',
    })
  })

  it('第 2 步：不是发给我们的密文被拒（WRAP_DECRYPT_FAILED）', () => {
    const { process } = makePipeline()
    // C 发给 C 自己的信 —— B 拆不开
    const wrap = wrapEnvelope(skC, pkC, makeEnvelope({}))
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'WRAP_DECRYPT_FAILED' })
  })

  it('第 2 步：seal 签名被篡改被拒（SEAL_SIGNATURE_INVALID）', () => {
    const { process } = makePipeline()
    const rumor = nip59.createRumor(
      { kind: 14, content: makeEnvelope({}), tags: [] },
      skA,
    )
    const seal = nip59.createSeal(rumor, skA, pkB)
    const tamperedSeal = { ...seal, sig: '0' + seal.sig.slice(1) }
    const wrap = nip59.createWrap(tamperedSeal, pkB)
    expect(process(wrap)).toMatchObject({
      ok: false,
      reason: 'SEAL_SIGNATURE_INVALID',
    })
  })

  it('第 3 步：过期消息被拒（EXPIRED），且**不写去重表**', () => {
    const { process, dedup } = makePipeline()
    // expires_at = NOW − 900：已过期，但仍晚于 created_at（NOW − 1800）→ 落在 EXPIRED 而非 LIFETIME_NOT_POSITIVE
    // rumor.created_at 需与信封构造时的 createdAt 一致，因此手工过一遍三层封装。
    const raw = makeEnvelope({ createdAt: NOW - 1800, lifetimeSeconds: 900 })
    const rumor = nip59.createRumor(
      { kind: 14, content: raw, tags: [], created_at: NOW - 1800 },
      skA,
    )
    const wrap = nip59.createWrap(nip59.createSeal(rumor, skA, pkB), pkB)
    const outcome: ReceiveOutcome = process(wrap)
    expect(outcome).toMatchObject({ ok: false, reason: 'EXPIRED' })
    expect(dedup.size).toBe(0)
  })

  it('第 3 步：载荷超过 64KB 在解析之前被拒（TOO_LARGE）', () => {
    const { process } = makePipeline()
    const rumor = nip59.createRumor({ kind: 14, content: 'x'.repeat(70 * 1024), tags: [] }, skA)
    const wrap = nip59.createWrap(nip59.createSeal(rumor, skA, pkB), pkB)
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'TOO_LARGE' })
  })

  it('第 4 步：from 与已验签发送者不一致被拒（FROM_MISMATCH —— unwrapEvent 不查这一条）', () => {
    const { process } = makePipeline()
    // C 用自己的密钥发送，但信封里声称 from = A
    const raw = makeEnvelope({ from: pkA })
    const rumor = nip59.createRumor({ kind: 14, content: raw, tags: [] }, skC)
    const wrap = nip59.createWrap(nip59.createSeal(rumor, skC, pkB), pkB)
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'FROM_MISMATCH' })
  })

  it('第 4 步：to 不是本机公钥被拒（TO_MISMATCH）', () => {
    const { process } = makePipeline()
    // A 发给 B 的信道，但信封里 to 写成 C
    const raw = makeEnvelope({ to: pkC })
    const wrap = wrapEnvelope(skA, pkB, raw)
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'TO_MISMATCH' })
  })

  it('第 5 步：同一消息第二次到达被去重（DUPLICATE）', () => {
    let handled = 0
    const { process } = makePipeline(() => {
      handled += 1
    })
    const wrap = wrapEnvelope(skA, pkB, makeEnvelope({}))
    expect(process(wrap).ok).toBe(true)
    expect(process(wrap)).toMatchObject({ ok: false, reason: 'DUPLICATE' })
    expect(handled).toBe(1)
  })

  it('顺序佐证：被第 1~4 步拒绝的消息都不占去重表的名额', () => {
    const { process, dedup } = makePipeline()
    process({ ...wrapEnvelope(skA, pkB, makeEnvelope({})), sig: '00'.repeat(64) } as Event)
    process(wrapEnvelope(skC, pkC, makeEnvelope({})))
    process(wrapEnvelope(skA, pkB, makeEnvelope({ createdAt: NOW - 7200, lifetimeSeconds: 3600 })))
    expect(dedup.size).toBe(0)
  })
})
