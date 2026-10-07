import { describe, expect, it } from 'vitest'
import { SlidingWindowLimiter } from '../../src/common/rate-limit'

describe('SlidingWindowLimiter', () => {
  it('窗口内按上限放行，超出拒绝', () => {
    let t = 0
    const limiter = new SlidingWindowLimiter(3, 60_000, () => t)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)
    expect(limiter.count).toBe(3)
  })

  it('窗口滑动后名额恢复', () => {
    let t = 0
    const limiter = new SlidingWindowLimiter(2, 60_000, () => t)
    limiter.tryAcquire()
    limiter.tryAcquire()
    expect(limiter.tryAcquire()).toBe(false)
    t = 60_001 // 两条记录恰好滑出窗口
    expect(limiter.count).toBe(0)
    expect(limiter.tryAcquire()).toBe(true)
  })

  it('边界：恰好到窗口边界（<= cutoff）的记录被淘汰', () => {
    let t = 0
    const limiter = new SlidingWindowLimiter(1, 1000, () => t)
    limiter.tryAcquire() // t=0
    t = 1000
    expect(limiter.tryAcquire()).toBe(true) // t=0 的记录已出窗
  })

  it('不同 key 的限流器互不影响（按发送方隔离）', () => {
    let t = 0
    const a = new SlidingWindowLimiter(1, 60_000, () => t)
    const b = new SlidingWindowLimiter(1, 60_000, () => t)
    expect(a.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(true)
  })
})
