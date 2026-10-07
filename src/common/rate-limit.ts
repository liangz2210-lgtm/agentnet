/**
 * 滑动窗口限流器 —— 纯内存、可注入时钟，供两处复用：
 *
 * 1. 传输层的**单连接入站速率**上限；
 * 2. 接收侧的**自动回复**限速（每发送方 + 全局，DECISIONS §10）。
 *
 * 实现是有意朴素的：把窗口内的命中时间戳存下来，命中时先淘汰过期项。
 * 数量级都很小（个位数到百位数），不值得换成环形桶。
 */
export class SlidingWindowLimiter {
  private hits: number[] = []

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 取得一个名额；窗口已满则返回 false（调用方丢弃并记录原因）。 */
  tryAcquire(): boolean {
    const now = this.now()
    const cutoff = now - this.windowMs
    for (;;) {
      const first = this.hits[0]
      if (first === undefined || first > cutoff) break
      this.hits.shift()
    }
    if (this.hits.length >= this.maxPerWindow) return false
    this.hits.push(now)
    return true
  }

  /** 只查看不占名额。 */
  get count(): number {
    const cutoff = this.now() - this.windowMs
    for (;;) {
      const first = this.hits[0]
      if (first === undefined || first > cutoff) break
      this.hits.shift()
    }
    return this.hits.length
  }
}
