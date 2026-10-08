import { describe, expect, it } from 'vitest'
import {
  giftWrapFilter,
  slowRetryDelayMs,
  nextBackoffDelayMs,
  planConnections,
  reportFromResults,
} from '../../src/transport/policy'
import { SUBSCRIPTION_LOOKBACK_SECONDS } from '../../src/transport/constants'

describe('nextBackoffDelayMs（重连递增退避）', () => {
  it('1s, 2s, 4s, 8s 指数增长', () => {
    expect(nextBackoffDelayMs(1, 1000, 30_000)).toBe(1000)
    expect(nextBackoffDelayMs(2, 1000, 30_000)).toBe(2000)
    expect(nextBackoffDelayMs(3, 1000, 30_000)).toBe(4000)
    expect(nextBackoffDelayMs(4, 1000, 30_000)).toBe(8000)
  })

  it('封顶不无限翻倍', () => {
    expect(nextBackoffDelayMs(10, 1000, 30_000)).toBe(30_000)
    expect(nextBackoffDelayMs(50, 1000, 30_000)).toBe(30_000)
  })
})

describe('reportFromResults（送达判定）', () => {
  const results = (ok: boolean[]) =>
    ok.map((o, i) => ({ url: `wss://r${i}`, ok: o, message: o ? '' : 'CONNECT_FAILED' }))

  it('至少一个确认才算送达', () => {
    expect(reportFromResults(results([true, false])).delivered).toBe(true)
    expect(reportFromResults(results([false, true])).delivered).toBe(true)
    expect(reportFromResults(results([false, false])).delivered).toBe(false)
  })

  it('全空数组：没有任何中继可发布 ⇒ 未送达', () => {
    expect(reportFromResults([]).delivered).toBe(false)
  })

  it('逐中继结果原样保留（"哪个成功哪个失败"必须可证明）', () => {
    const report = reportFromResults(results([false, true]))
    expect(report.results).toHaveLength(2)
    expect(report.results[1]?.ok).toBe(true)
  })
})

describe('planConnections（连接数上限）', () => {
  it('正常连接', () => {
    const plans = planConnections(['wss://a', 'wss://b'], new Set(), 16)
    expect(plans).toEqual([
      { action: 'connect', url: 'wss://a' },
      { action: 'connect', url: 'wss://b' },
    ])
  })

  it('超出上限的地址明确报告 limit-reached，不静默忽略', () => {
    const plans = planConnections(['wss://a', 'wss://b', 'wss://c'], new Set(), 2)
    expect(plans[0]).toEqual({ action: 'connect', url: 'wss://a' })
    expect(plans[1]).toEqual({ action: 'connect', url: 'wss://b' })
    expect(plans[2]).toEqual({ action: 'limit-reached', url: 'wss://c', limit: 2 })
  })

  it('已知连接跳过（幂等）', () => {
    const plans = planConnections(['wss://a'], new Set(['wss://a']), 2)
    expect(plans).toEqual([{ action: 'already-known', url: 'wss://a' }])
  })
})

describe('giftWrapFilter（订阅过滤器）', () => {
  it('kind 1059、#p 指向自己、since = now − 72h', () => {
    const filter = giftWrapFilter('a'.repeat(64), 1_700_000_000, SUBSCRIPTION_LOOKBACK_SECONDS)
    expect(filter.kinds).toEqual([1059])
    expect(filter['#p']).toEqual(['a'.repeat(64)])
    expect(filter.since).toBe(1_700_000_000 - 3 * 24 * 60 * 60)
  })
})

describe('slowRetryDelayMs（慢速重试，永不放弃）', () => {
  it('基准间隔 ± 抖动，永不超出 [interval−jitter, interval+jitter]', () => {
    for (let i = 0; i < 50; i++) {
      const d = slowRetryDelayMs(5 * 60 * 1000, 30 * 1000)
      expect(d).toBeGreaterThanOrEqual(5 * 60 * 1000 - 30 * 1000)
      expect(d).toBeLessThanOrEqual(5 * 60 * 1000 + 30 * 1000)
    }
  })

  it('随机源可注入（测试确定性）：0 → −抖动，1 → +抖动，0.5 → 基准', () => {
    expect(slowRetryDelayMs(300_000, 30_000, () => 0)).toBe(270_000)
    expect(slowRetryDelayMs(300_000, 30_000, () => 1)).toBe(330_000)
    expect(slowRetryDelayMs(300_000, 30_000, () => 0.5)).toBe(300_000)
  })

  it('结果有下限（≥1s），防止配置错误导致疯狂重试', () => {
    expect(slowRetryDelayMs(0, 0, () => 1)).toBeGreaterThanOrEqual(1000)
  })
})
