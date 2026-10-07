/**
 * 去重表（DECISIONS §5）。
 *
 * - 键 = **`(from, id)` 复合键**：不同发送方的同名 id 不得互相误杀
 * - **写入时机在流水线里**：验签、信封校验、身份认证全部通过之后才调用 `add`
 * - TTL = `min(expires_at, now + 24h) + 600s`：
 *   过期消息会被过期检查拒绝，保留更久无意义；+600s 吸收时钟偏差
 * - 容量 10000、每发送方配额 512，均为防御性取值（无数据支撑）
 * - 淘汰按插入顺序 FIFO：先惰性清扫过期项，仍超限再退最旧条目
 * - 纯内存、不落盘 —— 重启后中继上尚未过期的消息会重复显示（已知限制 L2）
 */

export interface DedupOptions {
  capacity?: number
  perSenderQuota?: number
  /** 绝对保留上限（秒）：`min(expires_at, now + ttlCeilingSeconds) + graceSeconds`。 */
  ttlCeilingSeconds?: number
  graceSeconds?: number
  /** 毫秒时钟（默认 Date.now）。⚠️ `expires_at` 是**秒**，内部统一乘 1000 —— 单位混用是真实发生过的 bug。 */
  now?: () => number
}

export type DedupAddResult =
  | { ok: true }
  | { ok: false; reason: 'DUPLICATE' | 'QUOTA_EXCEEDED' | 'CAPACITY_EXCEEDED' }

interface Entry {
  from: string
  id: string
  retainUntil: number
}

export const DEFAULT_DEDUP_CAPACITY = 10_000
export const DEFAULT_PER_SENDER_QUOTA = 512
export const DEFAULT_TTL_CEILING_SECONDS = 24 * 60 * 60
export const DEFAULT_GRACE_SECONDS = 600

export class DedupTable {
  private readonly entries = new Map<string, Entry>()
  private readonly perSender = new Map<string, string[]>()
  private readonly capacity: number
  private readonly perSenderQuota: number
  private readonly ttlCeilingSeconds: number
  private readonly graceSeconds: number
  private readonly now: () => number

  constructor(opts: DedupOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_DEDUP_CAPACITY
    this.perSenderQuota = opts.perSenderQuota ?? DEFAULT_PER_SENDER_QUOTA
    this.ttlCeilingSeconds = opts.ttlCeilingSeconds ?? DEFAULT_TTL_CEILING_SECONDS
    this.graceSeconds = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS
    this.now = opts.now ?? Date.now
  }

  has(from: string, id: string): boolean {
    const entry = this.entries.get(keyOf(from, id))
    return entry !== undefined && entry.retainUntil > this.now()
  }

  /**
   * 记录一条已处理消息。**只应在验签与校验全部通过之后调用**。
   * 返回 `ok: false` 时消息被拒绝，不进入业务处理。
   */
  add(from: string, id: string, expiresAt: number): DedupAddResult {
    const now = this.now()
    this.sweep(now)

    const k = keyOf(from, id)
    if (this.entries.has(k)) return { ok: false, reason: 'DUPLICATE' }

    // ⚠️ 单位换算：`expires_at` 是协议层的秒，时钟是毫秒。
    const retainUntil =
      Math.min(expiresAt * 1000, now + this.ttlCeilingSeconds * 1000) +
      this.graceSeconds * 1000

    const senderKeys = this.perSender.get(from) ?? []
    if (senderKeys.length >= this.perSenderQuota) {
      // 配额满：先退该发送方最旧条目（全局过期项已被 sweep 清掉）
      const oldest = senderKeys[0]
      if (oldest === undefined) return { ok: false, reason: 'QUOTA_EXCEEDED' }
      this.remove(oldest, from)
    }
    if (this.entries.size >= this.capacity) {
      // 全局满：退最旧的全局条目
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return { ok: false, reason: 'CAPACITY_EXCEEDED' }
      const victim = this.entries.get(oldest)
      if (victim === undefined) return { ok: false, reason: 'CAPACITY_EXCEEDED' }
      this.remove(oldest, victim.from)
    }

    const entry: Entry = { from, id, retainUntil }
    this.entries.set(k, entry)
    this.perSender.set(from, [...(this.perSender.get(from) ?? []), k])
    return { ok: true }
  }

  /** 惰性清扫：每次写入前调用；不做定时器（定时器会拖住 CLI 进程无法退出）。 */
  sweep(at: number = this.now()): number {
    let removed = 0
    for (const [k, entry] of this.entries) {
      if (entry.retainUntil <= at) {
        this.remove(k, entry.from)
        removed += 1
      }
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  senderCount(from: string): number {
    return (this.perSender.get(from) ?? []).length
  }

  private remove(k: string, from: string): void {
    this.entries.delete(k)
    const list = this.perSender.get(from)
    if (list === undefined) return
    const idx = list.indexOf(k)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length === 0) this.perSender.delete(from)
  }
}

function keyOf(from: string, id: string): string {
  return `${from}:${id}`
}
