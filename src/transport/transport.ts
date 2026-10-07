/**
 * 传输层的对外薄接口 —— 业务逻辑只认识这个类，不直接触碰 nostr-tools
 * （DECISIONS §2「封装在薄接口之后」）。
 *
 *   connect()   逐中继建立连接（互不影响，结果逐中继报告）
 *   publish()   逐中继发布；**至少一个确认才算送达**
 *   subscribe() 在全部已连接中继上订阅 gift wrap
 *   close()     关闭全部订阅与连接，**取消全部定时器**
 */

import type { Event } from 'nostr-tools'
import { RelayConnection, type RelayConnectionOptions, type SubscriptionHandle } from './relay-connection'
import { planConnections, reportFromResults, giftWrapFilter, type PublishReport, type RelayPublishResult } from './policy'
import {
  CONNECT_TIMEOUT_MS,
  MAX_RELAY_CONNECTIONS,
  PUBLISH_TIMEOUT_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  SUBSCRIPTION_LOOKBACK_SECONDS,
} from './constants'

export interface TransportOptions {
  urls: readonly string[]
  websocketImplementation?: typeof WebSocket
  connectTimeoutMs?: number
  publishTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectMaxAttempts?: number
  maxConnections?: number
  /** 日志只写事实与公钥缩写，不写消息内容（SPEC §7 规则 6）。 */
  log?: (line: string) => void
}

export interface Subscription {
  /** 各中继上的订阅句柄；未连接的中继不建立订阅（不报错 —— 连接状态已在 connect 时报告）。 */
  readonly handles: readonly SubscriptionHandle[]
  close(): void
}

export class Transport {
  private readonly connections = new Map<string, RelayConnection>()
  private readonly subscriptions: SubscriptionHandle[] = []
  private closed = false

  constructor(private readonly opts: TransportOptions) {}

  get urls(): readonly string[] {
    return this.opts.urls
  }

  get connectionCount(): number {
    return this.connections.size
  }

  /** 逐中继连接；每个结果独立报告，绝不抛出。重复调用对已连接中继是幂等的。 */
  async connect(): Promise<RelayPublishResult[]> {
    const results: RelayPublishResult[] = []
    const max = this.opts.maxConnections ?? MAX_RELAY_CONNECTIONS
    const known = new Set(this.connections.keys())
    for (const plan of planConnections(this.opts.urls, known, max)) {
      if (plan.action === 'already-known') {
        const conn = this.connections.get(plan.url)
        const ok = conn ? await conn.connect() : false
        results.push({ url: plan.url, ok, message: ok ? 'ALREADY_CONNECTED' : 'CONNECT_FAILED' })
        continue
      }
      if (plan.action === 'limit-reached') {
        results.push({
          url: plan.url,
          ok: false,
          message: `CONNECTION_LIMIT_REACHED(${plan.limit})`,
        })
        continue
      }
      const conn = new RelayConnection(plan.url, this.connectionOptions())
      this.connections.set(plan.url, conn)
      const ok = await conn.connect()
      results.push({ url: plan.url, ok, message: ok ? '' : 'CONNECT_FAILED' })
    }
    return results
  }

  private connectionOptions(): RelayConnectionOptions {
    return {
      websocketImplementation: this.opts.websocketImplementation,
      connectTimeoutMs: this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      reconnectBaseDelayMs: this.opts.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: this.opts.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS,
      reconnectMaxAttempts: this.opts.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS,
      log: this.opts.log,
    }
  }

  /**
   * 逐中继发布。任一中继的故障都**不影响其他中继**（逐中继独立 + try/catch）。
   * 至少一个中继确认（OK）才算送达；全部结果随 `PublishReport` 返回。
   * **绝不抛出** —— 发布失败是常规分支，不是异常路径。
   */
  async publish(event: Event): Promise<PublishReport> {
    if (this.closed) {
      return { delivered: false, results: [...this.opts.urls].map((url) => ({ url, ok: false, message: 'TRANSPORT_CLOSED' })) }
    }
    const results = await Promise.all(
      [...this.connections.values()].map((conn) => conn.publish(event)),
    )
    return reportFromResults(results)
  }

  /**
   * 在全部**已连接**中继上订阅 gift wrap（kind 1059）。
   *
   * `since = now − 72h`：NIP-59 把外层时间戳随机回溯 0~48h（实测），
   * 72h = 48h × 1.5，留 50% 余量吸收时钟偏差与中继 `since` 语义差异（nak 为排他 `>`）。
   * **不依赖 `since` 的边界精度**（DECISIONS §1/§4）。
   */
  subscribeGiftWraps(
    ownPubkey: string,
    onevent: (evt: Event, relayUrl: string) => void,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Subscription {
    const filter = giftWrapFilter(ownPubkey, nowSeconds, SUBSCRIPTION_LOOKBACK_SECONDS)
    const handles: SubscriptionHandle[] = []
    for (const conn of this.connections.values()) {
      const handle = conn.subscribe([filter], (evt) => onevent(evt, conn.url))
      if (handle !== null) handles.push(handle)
    }
    const subscription: Subscription = {
      handles,
      close: () => {
        for (const h of handles) h.close()
      },
    }
    this.subscriptions.push(...handles)
    return subscription
  }

  /** 关闭全部订阅与连接，取消全部定时器。之后 publish 会得到 `TRANSPORT_CLOSED`。 */
  close(): void {
    this.closed = true
    for (const handle of this.subscriptions) handle.close()
    this.subscriptions.length = 0
    for (const conn of this.connections.values()) conn.close()
  }
}

export { SUBSCRIPTION_LOOKBACK_SECONDS } from './constants'
