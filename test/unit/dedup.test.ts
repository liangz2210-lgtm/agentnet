import { describe, expect, it } from 'vitest'
import { DedupTable } from '../../src/receive/dedup'

const pk = (c: string) => c.repeat(64)

/** 毫秒时钟（与 Date.now 同单位 —— 去重表内部把秒级 expires_at × 1000）。 */
const T0 = 1_700_000_000_000
const SEC = 1000

describe('DedupTable', () => {
  it('(from,id) 复合键：不同发送方的同名 id 不互相误杀', () => {
    let t = T0
    const table = new DedupTable({ now: () => t })
    expect(table.add(pk('a'), 'id-1', T0 / 1000 + 3600).ok).toBe(true)
    expect(table.add(pk('b'), 'id-1', T0 / 1000 + 3600).ok).toBe(true) // 同 id 不同 from → 放行
    expect(table.add(pk('a'), 'id-1', T0 / 1000 + 3600).ok).toBe(false) // 同键 → 拒绝
  })

  it('过期项被惰性清扫：TTL = min(expires_at, now+24h) + 600s', () => {
    let t = T0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'id-1', T0 / 1000 + 3600) // 保留至 T0 + (3600+600)s
    expect(table.has(pk('a'), 'id-1')).toBe(true)
    t = T0 + (3600 + 600) * SEC + 1
    expect(table.has(pk('a'), 'id-1')).toBe(false)
    expect(table.add(pk('a'), 'id-1', T0 / 1000 + 3600).ok).toBe(true) // 过期后可重新记录
  })

  it('同一条消息在保留期内第二次写入必须被拒（集成回归：跨中继重复）', () => {
    let t = T0
    const table = new DedupTable({ now: () => t })
    const expires = T0 / 1000 + 3600
    expect(table.add(pk('a'), 'same-id', expires).ok).toBe(true)
    expect(table.add(pk('a'), 'same-id', expires).ok).toBe(false)
    expect(table.add(pk('a'), 'same-id', expires).ok).toBe(false)
    t += 1000
    expect(table.add(pk('a'), 'same-id', expires).ok).toBe(false)
  })

  it('保留期上限 24h：expires_at 设到一年后也只保留 now+24h+600s', () => {
    let t = T0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'id-1', T0 / 1000 + 365 * 24 * 3600)
    t = T0 + (24 * 3600 + 600) * SEC + 1
    expect(table.has(pk('a'), 'id-1')).toBe(false)
  })

  it('每发送方配额：超出后按插入顺序 FIFO 淘汰自己的最旧条目', () => {
    let t = T0
    const table = new DedupTable({ now: () => t, perSenderQuota: 3 })
    for (let i = 0; i < 3; i++) table.add(pk('a'), `id-${i}`, T0 / 1000 + 3600)
    expect(table.senderCount(pk('a'))).toBe(3)
    table.add(pk('a'), 'id-3', T0 / 1000 + 3600) // 第 4 条 → id-0 被淘汰
    expect(table.senderCount(pk('a'))).toBe(3)
    expect(table.has(pk('a'), 'id-0')).toBe(false)
    expect(table.has(pk('a'), 'id-3')).toBe(true)
    // 其他发送方不受影响
    table.add(pk('b'), 'id-b0', T0 / 1000 + 3600)
    expect(table.has(pk('a'), 'id-1')).toBe(true)
  })

  it('全局容量：超出后淘汰全局最旧条目', () => {
    let t = T0
    const table = new DedupTable({ now: () => t, capacity: 2 })
    table.add(pk('a'), 'id-1', T0 / 1000 + 3600)
    table.add(pk('b'), 'id-2', T0 / 1000 + 3600)
    table.add(pk('c'), 'id-3', T0 / 1000 + 3600) // 第 3 条 → a:id-1 被淘汰
    expect(table.size).toBe(2)
    expect(table.has(pk('a'), 'id-1')).toBe(false)
    expect(table.has(pk('b'), 'id-2')).toBe(true)
  })

  it('写入时顺带清扫：新写入会触发过期淘汰', () => {
    let t = T0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'old', T0 / 1000 + 100)
    t = T0 + 1000 * 1000
    table.add(pk('a'), 'new', T0 / 1000 + 3600)
    expect(table.size).toBe(1)
    expect(table.has(pk('a'), 'old')).toBe(false)
  })
})
