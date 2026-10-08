/**
 * 审计发现 F1 / F2 的回归测试 —— 两条都是「连接层把控制权交给了中继」：
 *
 * - **F1**：重连定时器被 `unref()`，中继一断开事件循环就空了，
 *   `listen` 以**退出码 0 静默退出**（比挂住危险：脚本以为它正常结束）。
 * - **F2**：中继发来的 `NOTICE` 走到 nostr-tools 的默认实现 `console.debug`，
 *   把中继构造的裸控制序列**直接写进 stdout**，完全绕过接收侧的清洗。
 *
 * 两条都必须在**连接层**测：端到端只跑得起 F1，F2 需要一个会发恶意 NOTICE 的中继。
 *
 * ⚠️ 本文件里的控制字符**一律写成 `\uXXXX` 转义**，绝不在源码里放裸控制字符
 * （裸字符会被编辑器/工具链悄悄改掉，测试也就悄悄失去意义）。
 */

import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { wsCast } from '../integration/helpers/ws-cast'
import { RelayConnection } from '../../src/transport/relay-connection'

/** C0 与 C1 控制字符（含 U+009B 单字符 CSI）—— 清洗后不许残留任何一段。 */
const ANY_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/

/** 恶意 NOTICE：OSC 改写标题 + 两次清屏 + 单字符 CSI + 回车覆盖已打印行。 */
const EVIL_NOTICE = 'hi\u001B]0;你已被入侵\u0007\u001B[2J\u001B[3J\u009B31mred\rdone'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('F1 回归：重连定时器必须撑住事件循环', () => {
  it('连接失败后，重连定时器是 ref 的（不是 unref 的）', async () => {
    const realSetTimeout = globalThis.setTimeout
    const seen: Array<{ delay: number; timer: NodeJS.Timeout }> = []
    // 只**包一层**做记录，不改行为 —— 直接替换实现会把 vitest 自己依赖的
    // 定时器一起弄坏。
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: unknown,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const timer = (realSetTimeout as unknown as typeof setTimeout)(
        fn as never,
        delay as never,
        ...(rest as never[]),
      ) as unknown as NodeJS.Timeout
      seen.push({ delay: delay ?? 0, timer })
      return timer as never
    }) as unknown as typeof setTimeout)

    // 端口 1 上没有人监听 → 必然连接失败 → 走 scheduleReconnect
    const conn = new RelayConnection('ws://127.0.0.1:1', {
      websocketImplementation: wsCast(),
      connectTimeoutMs: 200,
      reconnectBaseDelayMs: 4321, // 唯一值，好从一堆定时器里认出「我们那个」
      reconnectMaxDelayMs: 4321,
    })
    const ok = await conn.connect()
    conn.close()

    const ours = seen.filter((s) => s.delay === 4321)
    // 空跑检查：先确认真的抓到了我们的定时器，再谈它 ref 不 ref
    expect(ours).toHaveLength(1)
    expect(ok).toBe(false)
    expect(ours[0]!.timer.hasRef()).toBe(true)
  })
})

describe('F2 回归：中继 NOTICE 不得把控制序列送进终端', () => {
  it('恶意 NOTICE 先清洗再进日志，裸 ESC / OSC 标题 / 清屏串一个都不留', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    // port 0 要等 'listening' 之后 address() 才有值（在此之前是 null）
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const port = (wss.address() as AddressInfo).port
    // 一个"恶意中继"：握手成功就立刻发一条夹带控制序列的 NOTICE
    wss.on('connection', (sock) => {
      sock.send(JSON.stringify(['NOTICE', EVIL_NOTICE]))
    })

    const lines: string[] = []
    const conn = new RelayConnection(`ws://127.0.0.1:${port}`, {
      websocketImplementation: wsCast(),
      connectTimeoutMs: 2000,
      log: (line) => lines.push(line),
    })

    try {
      const ok = await conn.connect()
      expect(ok).toBe(true)
      await new Promise((r) => setTimeout(r, 300)) // 等 NOTICE 被处理
    } finally {
      conn.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }

    const noticeLines = lines.filter((l) => l.includes('relay notice'))
    // 空跑检查：确认 NOTICE 真的被**我们的**处理器接住了 ——
    // nostr-tools 的默认实现走 console.debug，不会落进这里的 log。
    // 少了这一条，"没清洗"和"压根没收到"看起来一模一样。
    expect(noticeLines.length).toBeGreaterThan(0)

    for (const line of noticeLines) {
      expect(line).not.toMatch(ANY_CONTROL)
      expect(line).not.toContain('\u001B')
      expect(line.length).toBeLessThanOrEqual(200) // 日志有长度上限
    }
    // 可读部分保留，被吞掉的只是控制序列
    expect(noticeLines.join('')).toContain('hi')
    expect(noticeLines.join('')).toContain('done')
    expect(noticeLines.join('')).not.toContain('你已被入侵')
  })
})
