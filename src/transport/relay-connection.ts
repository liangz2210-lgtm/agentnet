/**
 * 单条中继连接的封装 —— **崩溃不可恢复，所以本层绝不向上抛异常**：
 * 连接失败返回 false、发布失败返回 `{ ok: false }`，把"哪个中继怎么了"
 * 如实上报，由调用方决定怎么办（DECISIONS §2）。
 *
 * 为什么不用 `SimplePool`（DECISIONS 第一部分 D，实测）：
 * 向不可达中继 publish 会让 Node 因 `RangeError` 爆栈退出，且 SimplePool 对
 * 宕机中继谎报 `fulfilled` —— 两个都是致命的。
 */

import { AbstractRelay } from 'nostr-tools/abstract-relay'
import { verifyEvent as nostrVerifyEvent, type Event, type Filter } from 'nostr-tools'
import { SlidingWindowLimiter } from '../common/rate-limit'
import { nextBackoffDelayMs, type RelayPublishResult } from './policy'
import {
  CONNECT_TIMEOUT_MS,
  INCOMING_RATE_WINDOW_MS,
  MAX_EVENTS_PER_CONNECTION_PER_WINDOW,
  MAX_EVENTS_PER_SUBSCRIPTION,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
} from './constants'

export interface RelayConnectionOptions {
  websocketImplementation?: typeof WebSocket | undefined
  connectTimeoutMs?: number | undefined
  reconnectBaseDelayMs?: number | undefined
  reconnectMaxDelayMs?: number | undefined
  reconnectMaxAttempts?: number | undefined
  now?: (() => number) | undefined
  /** 日志只写事实，不写消息内容（SPEC §7 规则 6）。 */
  log?: ((line: string) => void) | undefined
}

export interface SubscriptionHandle {
  readonly relayUrl: string
  close(): void
}

export class RelayConnection {
  private relay: AbstractRelay | null = null
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closing = false
  private incomingLimiter: SlidingWindowLimiter
  private rateDropped = 0

  constructor(
    readonly url: string,
    private readonly opts: RelayConnectionOptions = {},
  ) {
    this.incomingLimiter = new SlidingWindowLimiter(
      MAX_EVENTS_PER_CONNECTION_PER_WINDOW,
      INCOMING_RATE_WINDOW_MS,
      opts.now ?? Date.now,
    )
  }

  get connected(): boolean {
    return this.relay?.connected ?? false
  }

  /** 因单连接速率被丢弃的事件数（诊断用，不含内容）。 */
  get droppedByRateLimit(): number {
    return this.rateDropped
  }

  /** 连接；成功 true、失败 false，**绝不抛出**。已连接时直接返回 true。 */
  async connect(): Promise<boolean> {
    if (this.closing) return false
    if (this.connected) return true
    try {
      const relayOpts: {
        verifyEvent: (event: Event, url: string) => boolean
        websocketImplementation?: typeof WebSocket
        enableReconnect?: boolean
      } = {
        // 入站事件的签名校验（中继侧防线；接收流水线还会再验一次 wrap 签名）
        verifyEvent: (event) => nostrVerifyEvent(event),
        // 重连策略由本类自管：递增退避 + 次数上限 + close 时可取消
        enableReconnect: false,
        ...(this.opts.websocketImplementation === undefined
          ? {}
          : { websocketImplementation: this.opts.websocketImplementation }),
      }
      const relay = new AbstractRelay(this.url, relayOpts)
      await relay.connect({ timeout: this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS })
      relay.onclose = () => {
        this.relay = null
        this.scheduleReconnect()
      }
      this.relay = relay
      this.attempts = 0
      this.log(`relay connected: ${this.url}`)
      return true
    } catch {
      this.log(`relay connect failed: ${this.url}`)
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return
    this.attempts += 1
    const max = this.opts.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS
    if (this.attempts > max) {
      this.log(`relay reconnect abandoned: ${this.url}`)
      return
    }
    const delay = nextBackoffDelayMs(
      this.attempts,
      this.opts.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS,
      this.opts.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    // 不阻止进程退出：CLI 是短命进程，定时器不该拖住它
    this.reconnectTimer.unref?.()
  }

  /** 发布到该中继。失败（含中继回 OK=false）返回 `{ ok: false }`，绝不抛出。 */
  async publish(event: Event): Promise<RelayPublishResult> {
    const relay = this.relay
    if (relay === null || !relay.connected) {
      return { url: this.url, ok: false, message: 'NOT_CONNECTED' }
    }
    try {
      const message = await relay.publish(event)
      return { url: this.url, ok: true, message: message ?? '' }
    } catch (err) {
      // 中继 OK=false 会走到这里：只保留原因，不携带事件内容
      return {
        url: this.url,
        ok: false,
        message: err instanceof Error ? err.message : 'PUBLISH_REJECTED',
      }
    }
  }

  /**
   * 在该中继上建立订阅。未连接返回 null（调用方不必区分"没连上"和"连不上"）。
   *
   * 入站两道闸（均为防御性取值，无数据支撑）：
   * 1. 单连接滑动窗口速率；
   * 2. 单次订阅（至 EOSE）事件数上限 —— 超出部分丢弃并计数，不中断订阅。
   */
  subscribe(
    filters: readonly Filter[],
    onevent: (evt: Event) => void,
    oneose?: () => void,
  ): SubscriptionHandle | null {
    const relay = this.relay
    if (relay === null || !relay.connected) return null

    let perSubscription = 0
    const sub = relay.subscribe([...filters], {
      onevent: (evt: Event) => {
        if (!this.incomingLimiter.tryAcquire()) {
          this.rateDropped += 1
          return
        }
        perSubscription += 1
        if (perSubscription > MAX_EVENTS_PER_SUBSCRIPTION) {
          this.rateDropped += 1
          return
        }
        onevent(evt)
      },
      ...(oneose === undefined ? {} : { oneose }),
    })
    return {
      relayUrl: this.url,
      close: () => {
        try {
          sub.close()
        } catch {
          /* 已关闭的订阅再关一次无害 */
        }
      },
    }
  }

  /** 关闭连接并**取消全部定时器**（重连退避计时器必须随之消失）。 */
  close(): void {
    this.closing = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.relay?.close()
    } catch {
      /* 关闭失败不影响退出 */
    }
    this.relay = null
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }
}
