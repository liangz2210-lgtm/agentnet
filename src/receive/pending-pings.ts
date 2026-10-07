/**
 * 未完成 ping 的登记表 —— pong 的准入依据（DECISIONS §10）：
 * 收到的 pong 必须引用一个**我们发出且尚未被回应**的 ping，否则忽略。
 * 不做登记表的话，任何人都可发 pong 制造"连接正常"的假象（孤儿回应）。
 */

export interface PendingPingsOptions {
  /** ping 的等待时限（秒），超时即从"未完成"转为"过期"。防御性取值。 */
  ttlSeconds?: number
  now?: () => number
}

export const DEFAULT_PING_TTL_SECONDS = 60

export class PendingPings {
  private readonly pending = new Map<string, number>()
  private readonly ttlSeconds: number
  private readonly now: () => number

  constructor(opts: PendingPingsOptions = {}) {
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_PING_TTL_SECONDS
    this.now = opts.now ?? Date.now
  }

  register(id: string): void {
    this.sweep()
    this.pending.set(id, this.now())
  }

  /**
   * pong 引用的 ping 是否有效。有效则**消费掉**（一个 ping 只能被回应一次），
   * 无效（不存在或已超时）返回 false。
   */
  consume(id: string): boolean {
    this.sweep()
    const at = this.pending.get(id)
    if (at === undefined) return false
    this.pending.delete(id)
    return true
  }

  get size(): number {
    return this.pending.size
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlSeconds * 1000
    for (const [id, at] of this.pending) {
      if (at <= cutoff) this.pending.delete(id)
    }
  }
}
