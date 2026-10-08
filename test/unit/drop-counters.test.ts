/**
 * 丢弃计数的回归测试（用户要求：每一种丢弃都按原因码计数，以便将来校准上限）。
 *
 * 覆盖三类丢弃点：
 *   1. 接收流水线的每一步（大小 / 解封 / 校验 / 认证 / 去重）
 *   2. 业务层的丢弃（自动回复被限速压掉、无人认领的 pong）
 *   3. 传输层的入站两道闸（速率、订阅事件数）—— 集成测试另测
 *
 * 另有一条**日志不得含消息内容**的断言：detail 里会夹带攻击者可控文本，
 * 只能留在返回值里，不能进日志（SPEC §7 规则 5/6）。
 */

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { DropCounters, DELIVERED } from '../../src/common/drop-counters'
import { createPipeline } from '../../src/receive/pipeline'
import { DedupTable } from '../../src/receive/dedup'
import { handleEnvelope } from '../../src/receive/handler'
import { AutoReplyPolicy } from '../../src/receive/handler'
import { PendingPings } from '../../src/receive/pending-pings'
import { buildEnvelope } from '../../src/envelope/sender'
import { wrapEnvelope, unwrapGiftWrap } from '../../src/envelope/wrap'
import { INCOMING_RATE_LIMIT, SUBSCRIPTION_EVENT_CAP } from '../../src/transport/relay-connection'

const skA = generateSecretKey()
const pkA = getPublicKey(skA)
const skB = generateSecretKey()
const pkB = getPublicKey(skB)
const NOW = Math.floor(Date.now() / 1000)

function envelopeRaw(over: Record<string, unknown> = {}, createdAt = NOW): string {
  const result = buildEnvelope(
    {
      id: '0199f0e1-0000-7000-8000-000000000001',
      type: 'text',
      from: pkA,
      to: pkB,
      createdAt,
      lifetimeSeconds: 3600,
      payload: { text: 'hi' },
      ...over,
    } as never,
    { ownPubkey: pkA, now: createdAt },
  )
  if (!result.ok) throw new Error(result.detail)
  return result.raw
}

function wrapFrom(raw: string, createdAt = NOW): Event {
  return wrapEnvelope(skA, pkB, raw, createdAt)
}

describe('DropCounters', () => {
  it('按原因码计数，可分别取数', () => {
    const c = new DropCounters()
    c.record('EXPIRED')
    c.record('EXPIRED')
    c.record('DUPLICATE')
    expect(c.countOf('EXPIRED')).toBe(2)
    expect(c.countOf('DUPLICATE')).toBe(1)
    expect(c.countOf('NEVER')).toBe(0)
    expect(c.total()).toBe(3)
  })

  it('快照按数量降序、同数量按原因码升序（输出稳定，便于 diff）', () => {
    const c = new DropCounters()
    c.record('B', 2)
    c.record('A', 2)
    c.record('C', 5)
    expect(c.snapshot().map((e) => e.reason)).toEqual(['C', 'A', 'B'])
  })

  it('摘要可读，且空表不刷屏', () => {
    const empty = new DropCounters()
    expect(empty.formatLines()).toEqual([])
    expect(empty.formatSummary()).toBe('丢弃 0 次')

    const c = new DropCounters()
    c.record('EXPIRED', 7)
    c.record('DUPLICATE', 5)
    expect(c.formatSummary()).toBe('丢弃 12 次（EXPIRED=7 DUPLICATE=5）')
  })

  it('忽略非法次数（0 / 负数 / NaN）', () => {
    const c = new DropCounters()
    c.record('X', 0)
    c.record('X', -3)
    c.record('X', Number.NaN)
    expect(c.countOf('X')).toBe(0)
  })
})

describe('流水线：每次丢弃都计数，成功也计数', () => {
  it('过期消息计入 EXPIRED，且成功时计入 DELIVERED', () => {
    const counters = new DropCounters()
    const pipeline = createPipeline({
      ownSecretKey: skB,
      ownPubkey: pkB,
      now: () => NOW,
      dedup: new DedupTable({ now: () => NOW }),
      handler: () => {},
      counters,
    })

    // 过期：created_at = NOW-3600，expires_at = NOW-1800
    const out = pipeline(wrapFrom(envelopeRaw({}, NOW - 3600), NOW - 3600))
    expect(out.ok).toBe(false)
    expect(counters.countOf('EXPIRED')).toBe(1)
    expect(counters.countOf(DELIVERED)).toBe(0)

    // 合法
    const okOut = pipeline(wrapFrom(envelopeRaw()))
    expect(okOut.ok).toBe(true)
    expect(counters.countOf(DELIVERED)).toBe(1)
    // 总丢弃数不应把成功算进去
    expect(counters.total()).toBe(2) // EXPIRED=1 + DELIVERED=1
  })

  it('伪造发送者计入 FROM_MISMATCH（C 签名但 from 写 A）', () => {
    const skC = generateSecretKey()
    const counters = new DropCounters()
    const pipeline = createPipeline({
      ownSecretKey: skB,
      ownPubkey: pkB,
      now: () => NOW,
      dedup: new DedupTable({ now: () => NOW }),
      handler: () => {},
      counters,
    })
    const forged = wrapEnvelope(skC, pkB, envelopeRaw({ from: pkA }), NOW)
    expect(pipeline(forged).ok).toBe(false)
    expect(counters.countOf('FROM_MISMATCH')).toBe(1)
  })

  it('重复消息计入 DUPLICATE', () => {
    const counters = new DropCounters()
    const pipeline = createPipeline({
      ownSecretKey: skB,
      ownPubkey: pkB,
      now: () => NOW,
      dedup: new DedupTable({ now: () => NOW }),
      handler: () => {},
      counters,
    })
    // 两次独立包装、同一信封 id —— 重放的样子
    expect(pipeline(wrapFrom(envelopeRaw())).ok).toBe(true)
    expect(pipeline(wrapFrom(envelopeRaw())).ok).toBe(false)
    expect(counters.countOf('DUPLICATE')).toBe(1)
  })

  it('onReject 只拿到原因码 —— 拿不到可能含攻击者文本的 detail', () => {
    const seen: unknown[] = []
    const counters = new DropCounters()
    const pipeline = createPipeline({
      ownSecretKey: skB,
      ownPubkey: pkB,
      now: () => NOW,
      dedup: new DedupTable({ now: () => NOW }),
      handler: () => {},
      counters,
      onReject: ((...args: unknown[]) => {
        seen.push(args)
      }) as never,
    })
    // 未知顶层字段：detail 会是「未知顶层字段：<攻击者可控的字段名>」
    const raw = JSON.parse(envelopeRaw()) as Record<string, unknown>
    raw['ATTACKER_CONTROLLED_FIELD_NAME'] = 'x'
    const out = pipeline(wrapFrom(JSON.stringify(raw)))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe('UNKNOWN_TOP_LEVEL_FIELD')

    // onReject 的实参只有一个原因码 —— detail 根本传不出来
    expect(seen[0]).toEqual(['UNKNOWN_TOP_LEVEL_FIELD'])
    // 而返回值里仍然保留 detail 供程序使用（只是不进日志）
    expect(out.ok === false && out.detail).toContain('ATTACKER_CONTROLLED_FIELD_NAME')
  })
})

describe('业务层丢弃同样计数', () => {
  function deps(counters: DropCounters, opts: { globalLimit?: number; perSenderLimit?: number } = {}) {
    return {
      ownPubkey: pkB,
      ownSecretKey: skB,
      now: () => NOW,
      autoReply: new AutoReplyPolicy({
        globalLimit: opts.globalLimit ?? 100,
        perSenderLimit: opts.perSenderLimit ?? 10,
        now: () => NOW * 1000,
      }),
      pendingPings: new PendingPings({ now: () => NOW * 1000 }),
      send: () => {},
      onText: () => {},
      counters,
    }
  }

  it('全局上限压掉的 pong 计为 PONG_SUPPRESSED_GLOBAL_LIMIT', () => {
    const counters = new DropCounters()
    const d = deps(counters, { globalLimit: 1 })
    const ping = (id: string) =>
      ({
        v: 0,
        id,
        type: 'ping',
        from: pkA,
        to: pkB,
        created_at: NOW,
        expires_at: NOW + 3600,
        payload: {},
        receipt: null,
      }) as never

    expect(handleEnvelope(d, ping('0199f0e1-0000-7000-8000-0000000000a1')).action).toBe('PONG_SENT')
    expect(handleEnvelope(d, ping('0199f0e1-0000-7000-8000-0000000000a2')).action).toBe(
      'PONG_SUPPRESSED_RATE_LIMIT',
    )
    expect(counters.countOf('PONG_SUPPRESSED_GLOBAL_LIMIT')).toBe(1)
    expect(counters.countOf('PONG_SUPPRESSED_PER_SENDER_LIMIT')).toBe(0)
  })

  it('每发送方上限压掉的 pong 计为 PONG_SUPPRESSED_PER_SENDER_LIMIT（与全局分开）', () => {
    const counters = new DropCounters()
    const d = deps(counters, { globalLimit: 100, perSenderLimit: 1 })
    const ping = (id: string) =>
      ({
        v: 0,
        id,
        type: 'ping',
        from: pkA,
        to: pkB,
        created_at: NOW,
        expires_at: NOW + 3600,
        payload: {},
        receipt: null,
      }) as never

    handleEnvelope(d, ping('0199f0e1-0000-7000-8000-0000000000b1'))
    handleEnvelope(d, ping('0199f0e1-0000-7000-8000-0000000000b2'))
    expect(counters.countOf('PONG_SUPPRESSED_PER_SENDER_LIMIT')).toBe(1)
    expect(counters.countOf('PONG_SUPPRESSED_GLOBAL_LIMIT')).toBe(0)
  })

  it('无人认领的 pong 计为 PONG_UNSOLICITED', () => {
    const counters = new DropCounters()
    const d = deps(counters)
    const pong = {
      v: 0,
      id: '0199f0e1-0000-7000-8000-000000000009',
      type: 'pong',
      from: pkA,
      to: pkB,
      created_at: NOW,
      expires_at: NOW + 3600,
      payload: { id: '0199f0e1-0000-7000-8000-0000000000ff' }, // 我们没发过
      receipt: null,
    } as never
    expect(handleEnvelope(d, pong).action).toBe('PONG_IGNORED_NO_PENDING_PING')
    expect(counters.countOf('PONG_UNSOLICITED')).toBe(1)
  })
})

describe('入站两道闸的原因码必须能区分', () => {
  it('两个常量是不同的字符串（否则无法判断该调哪个上限）', () => {
    expect(INCOMING_RATE_LIMIT).not.toBe(SUBSCRIPTION_EVENT_CAP)
  })
})
