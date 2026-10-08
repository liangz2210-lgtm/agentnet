/**
 * 丢弃计数器 —— **按原因码计数**，为将来的上限校准提供数据。
 *
 * 为什么要有它（用户要求，DECISIONS §21）：
 * 本项目的每一个防御上限（入站速率、订阅事件数、自动回复配额、去重容量…）
 * 都是**无数据支撑的凭直觉取值**。要校准就得先知道"到底拦了多少、拦的是哪一类"。
 * 没有计数，就只能等它误杀正常流量或被打穿之后才发现 —— 而那时已经晚了。
 *
 * 两条硬约束：
 * 1. **只记原因码，不记任何消息内容**（SPEC §7 规则 6 / 规则 5）
 * 2. 计数必须**可被取走汇总**（退出时打印），否则等于没记
 */

export class DropCounters {
  private readonly counts = new Map<string, number>()

  /** 记一次丢弃。`reason` 必须是稳定的原因码，不是自由文本。 */
  record(reason: string, n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + n)
  }

  countOf(reason: string): number {
    return this.counts.get(reason) ?? 0
  }

  total(): number {
    let sum = 0
    for (const v of this.counts.values()) sum += v
    return sum
  }

  /** 按数量降序、同数量按原因码升序 —— 输出稳定，便于 diff 与告警。 */
  snapshot(): Array<{ reason: string; count: number }> {
    return [...this.counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason))
  }

  /** 渲染成 `原因码=次数` 的行。空表返回空数组（不刷屏）。 */
  formatLines(): string[] {
    return this.snapshot().map((e) => `${e.reason}=${e.count}`)
  }

  /** 单行摘要：`丢弃 12 次（EXPIRED=7 DUPLICATE=5）`。 */
  formatSummary(): string {
    const total = this.total()
    if (total === 0) return '丢弃 0 次'
    return `丢弃 ${total} 次（${this.formatLines().join(' ')}）`
  }

  reset(): void {
    this.counts.clear()
  }
}

/**
 * 成功计数用的原因码。
 * 只有"丢弃/送达"两个数字都在，才谈得上丢弃率 —— 只看丢弃数无法判断
 * 究竟是攻击变多了还是流量整体变大了。
 */
export const DELIVERED = 'DELIVERED'
