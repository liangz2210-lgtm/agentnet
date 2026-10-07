import { describe, expect, it } from 'vitest'
import { DedupTable } from '../../src/receive/dedup'

const pk = (c: string) => c.repeat(64)

describe('DedupTable', () => {
  it('(from,id) 复合键：不同发送方的同名 id 不互相误杀', () => {
    const table = new DedupTable({ now: () => 0 })
    expect(table.add(pk('a'), 'id-1', 3600).ok).toBe(true)
    expect(table.add(pk('b'), 'id-1', 3600).ok).toBe(true) // 同 id 不同 from → 放行
    expect(table.add(pk('a'), 'id-1', 3600).ok).toBe(false) // 同键 → 拒绝
  })

  it('过期项被惰性清扫：TTL = min(expires_at, now+24h) + 600s', () => {
    let t = 0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'id-1', 3600) // expires_at=3600 → 保留至 4200
    expect(table.has(pk('a'), 'id-1')).toBe(true)
    t = 4201
    expect(table.has(pk('a'), 'id-1')).toBe(false)
    expect(table.add(pk('a'), 'id-1', 3600).ok).toBe(true) // 过期后可重新记录
  })

  it('保留期上限 24h：expires_at 设到一年后也只保留 now+24h+600s', () => {
    let t = 0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'id-1', 365 * 24 * 3600)
    t = 24 * 3600 + 600 + 1
    expect(table.has(pk('a'), 'id-1')).toBe(false)
  })

  it('每发送方配额：超出后按插入顺序 FIFO 淘汰自己的最旧条目', () => {
    let t = 0
    const table = new DedupTable({ now: () => t, perSenderQuota: 3 })
    for (let i = 0; i < 3; i++) table.add(pk('a'), `id-${i}`, 3600)
    expect(table.senderCount(pk('a'))).toBe(3)
    table.add(pk('a'), 'id-3', 3600) // 第 4 条 → id-0 被淘汰
    expect(table.senderCount(pk('a'))).toBe(3)
    expect(table.has(pk('a'), 'id-0')).toBe(false)
    expect(table.has(pk('a'), 'id-3')).toBe(true)
    // 其他发送方不受影响
    expect(table.has(pk('b'), 'id-0')).toBe(false)
    table.add(pk('b'), 'id-b0', 3600)
    expect(table.has(pk('a'), 'id-1')).toBe(true)
  })

  it('全局容量：超出后淘汰全局最旧条目', () => {
    let t = 0
    const table = new DedupTable({ now: () => t, capacity: 2 })
    table.add(pk('a'), 'id-1', 3600)
    table.add(pk('b'), 'id-2', 3600)
    table.add(pk('c'), 'id-3', 3600) // 第 3 条 → a:id-1 被淘汰
    expect(table.size).toBe(2)
    expect(table.has(pk('a'), 'id-1')).toBe(false)
    expect(table.has(pk('b'), 'id-2')).toBe(true)
  })

  it('写入时顺带清扫：新写入会触发过期淘汰', () => {
    let t = 0
    const table = new DedupTable({ now: () => t })
    table.add(pk('a'), 'old', 100)
    t = 1000
    table.add(pk('a'), 'new', 3600)
    expect(table.size).toBe(1)
    expect(table.has(pk('a'), 'old')).toBe(false)
  })
})
