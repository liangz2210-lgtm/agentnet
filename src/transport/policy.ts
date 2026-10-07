/**
 * 传输层的**纯决策函数** —— 不碰网络、不碰时钟，方便单测。
 */

/** 指数退避：第 `attempt` 次失败后的等待毫秒数（1s, 2s, 4s, … 封顶）。 */
export function nextBackoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  if (attempt < 1) return baseMs
  const scaled = baseMs * 2 ** (attempt - 1)
  return Math.min(scaled, maxMs)
}

export interface RelayPublishResult {
  url: string
  ok: boolean
  /** 成功时为中继的 OK 消息；失败时为原因码（不含消息内容）。 */
  message: string
}

export interface PublishReport {
  /** 至少一个中继确认（OK）才算送达。 */
  delivered: boolean
  results: RelayPublishResult[]
}

/**
 * 送达判定：**至少一个中继确认才算成功**，且无论如何返回每个中继的结果 ——
 * 「一个不可用仍送达」这条验收必须能被证明，所以逐中继结果不可省。
 */
export function reportFromResults(results: RelayPublishResult[]): PublishReport {
  return { delivered: results.some((r) => r.ok), results }
}

/**
 * 订阅 gift wrap 的过滤器：kind 1059、`#p` 指向自己、
 * `since = now − 72h`（NIP-59 时间戳随机回溯 0~48h 的 1.5 倍，DECISIONS §4）。
 */
export function giftWrapFilter(
  ownPubkey: string,
  nowSeconds: number,
  lookbackSeconds: number,
): { kinds: [1059]; '#p': string[]; since: number } {
  return { kinds: [1059], '#p': [ownPubkey], since: nowSeconds - lookbackSeconds }
}

export type ConnectPlan =
  | { action: 'already-known'; url: string }
  | { action: 'limit-reached'; url: string; limit: number }
  | { action: 'connect'; url: string }

/**
 * 连接数上限的规划：超出上限的地址**明确报告** `limit-reached`，
 * 不静默忽略 —— 静默会让"少连了一个中继"变成无人察觉的事实。
 */
export function planConnections(
  urls: readonly string[],
  known: ReadonlySet<string>,
  maxConnections: number,
): ConnectPlan[] {
  const plans: ConnectPlan[] = []
  for (const url of urls) {
    if (known.has(url)) {
      plans.push({ action: 'already-known', url })
      continue
    }
    if (known.size + plans.filter((p) => p.action === 'connect').length >= maxConnections) {
      plans.push({ action: 'limit-reached', url, limit: maxConnections })
      continue
    }
    plans.push({ action: 'connect', url })
  }
  return plans
}
