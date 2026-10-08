/**
 * 单条中继连接的封装 —— **崩溃不可恢复，所以本层绝不向上抛异常**：
 * 连接失败返回 false、发布失败返回 `{ ok: false }`，把"哪个中继怎么了"
 * 如实上报，由调用方决定怎么办（DECISIONS §2）。
 *
 * 重连策略（v0.2 修订）：快速退避（1s→30s 封顶）连续 `RECONNECT_MAX_ATTEMPTS`
 * 次后转入**慢速重试**（约 5 分钟 ± 30s 抖动）—— **永不永久放弃**，
 * 中继可能只是暂时下线。每次状态变化通过 `onStatus` 上报。
 *
 * 为什么不用 `SimplePool`（DECISIONS 第一部分 D，实测）：
 * 向不可达中继 publish 会让 Node 因 `RangeError` 爆栈退出，且 SimplePool 对
 * 宕机中继谎报 `fulfilled` —— 两个都是致命的。
 */

import { AbstractRelay } from 'nostr-tools/abstract-relay'
import { verifyEvent as nostrVerifyEvent, type Event, type Filter } from 'nostr-tools'
import { SlidingWindowLimiter } from '../common/rate-limit'
import { nextBackoffDelayMs, slowRetryDelayMs, type RelayPublishResult } from './policy'
import {
  CONNECT_TIMEOUT_MS,
  INCOMING_RATE_WINDOW_MS,
  MAX_EVENTS_PER_CONNECTION_PER_WINDOW,
  MAX_EVENTS_PER_SUBSCRIPTION,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  SLOW_RETRY_INTERVAL_MS,
  SLOW_RETRY_JITTER_MS,
} from './constants'

/** 连接状态（会通过 `onStatus` 对外广播，用于 listen 的状态显示）。 */
export type RelayStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'slow-retry'
  | 'closed'

export interface RelayConnectionLimits {
  /** 单次订阅（至 EOSE）事件数上限。 */
  maxEventsPerSubscription?: number | undefined
  /** 单连接入站速率窗口（毫秒）。 */
  incomingRateWindowMs?: number | undefined
  /** 单连接入站速率：窗口内事件数上限。 */
  maxEventsPerConnectionPerWindow?: number | undefined
}

export interface RelayConnectionOptions {
  websocketImplementation?: typeof WebSocket | undefined
  connectTimeoutMs?: number | undefined
  reconnectBaseDelayMs?: number | undefined
  reconnectMaxDelayMs?: number | undefined
  reconnectMaxAttempts?: number | undefined
  slowRetryIntervalMs?: number | undefined
  slowRetryJitterMs?: number | undefined
  limits?: RelayConnectionLimits | undefined
  now?: (() => number) | undefined
  /** 慢速重试抖动用的随机源（测试注入固定值）。 */
  random?: (() => number) | undefined
  /** 状态变化回调。日志只写事实与 URL，不写消息内容（SPEC §7 规则 6）。 */
  onStatus?: ((url: string, status: RelayStatus) => void) | undefined
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
  private status: RelayStatus = 'closed'
  private incomingLimiter: SlidingWindowLimiter
  private rateDropped = 0
  private readonly limits: {
    maxEventsPerSubscription: number
    incomingRateWindowMs: number
    maxEventsPerConnectionPerWindow: number
  }

  constructor(
    readonly url: string,
    private readonly opts: RelayConnectionOptions = {},
  ) {
    this.limits = {
      maxEventsPerSubscription:
        opts.limits?.maxEventsPerSubscription ?? MAX_EVENTS_PER_SUBSCRIPTION,
      incomingRateWindowMs: opts.limits?.incomingRateWindowMs ?? INCOMING_RATE_WINDOW_MS,
      maxEventsPerConnectionPerWindow:
        opts.limits?.maxEventsPerConnectionPerWindow ?? MAX_EVENTS_PER_CONNECTION_PER_WINDOW,
    }
    this.incomingLimiter = new SlidingWindowLimiter(
      this.limits.maxEventsPerConnectionPerWindow,
      this.limits.incomingRateWindowMs ?? INCOMING_RATE_WINDOW_MS,
      opts.now ?? Date.now,
    )
  }

  get connected(): boolean {
    return this.relay?.connected ?? false
  }

  get currentStatus(): RelayStatus {
    return this.status
  }

  /** 因单连接速率被丢弃的事件数（诊断用，不含内容）。 */
  get droppedByRateLimit(): number {
    return this.rateDropped
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return
    this.status = status
    this.opts.onStatus?.(this.url, status)
  }

  /** 连接；成功 true、失败 false，**绝不抛出**。已连接时直接返回 true。 */
  async connect(): Promise<boolean> {
    if (this.closing) return false
    if (this.connected) return true
    this.setStatus('connecting')
    try {
      const relayOpts: {
        verifyEvent: (event: Event, url: string) => boolean
        websocketImplementation?: typeof WebSocket
        enableReconnect?: boolean
      } = {
        // 入站事件的签名校验（中继侧防线；接收流水线还会再验一次 wrap 签名）
        verifyEvent: (event) => nostrVerifyEvent(event),
        // 重连策略由本类自管：快速退避 + 慢速重试，close 时可取消
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
      this.setStatus('connected')
      this.log(`relay connected: ${this.url}`)
      return true
    } catch {
      this.log(`relay connect failed: ${this.url}`)
      this.setStatus('reconnecting')
      this.scheduleReconnect()
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return
    this.attempts += 1
    const max = this.opts.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS

    let delay: number
    if (this.attempts <= max) {
      delay = nextBackoffDelayMs(
        this.attempts,
        this.opts.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS,
        this.opts.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS,
      )
      this.setStatus('reconnecting')
    } else {
      // 慢速重试：约 5 分钟 ± 抖动，永不放弃
      delay = slowRetryDelayMs(
        this.opts.slowRetryIntervalMs ?? SLOW_RETRY_INTERVAL_MS,
        this.opts.slowRetryJitterMs ?? SLOW_RETRY_JITTER_MS,
        this.opts.random ?? Math.random,
      )
      this.setStatus('slow-retry')
    }

    const timer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    // 不阻止进程退出：CLI 是短命进程，定时器不该拖住它
    timer.unref?.()
    this.reconnectTimer = timer
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
   * 入站两道闸（均为防御性取值，可通过 `limits` 配置）：
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
        if (perSubscription > this.limits.maxEventsPerSubscription) {
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

  /** 关闭连接并**取消全部定时器**（重连/慢速重试计时器必须随之消失）。 */
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
    this.setStatus('closed')
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }
}
