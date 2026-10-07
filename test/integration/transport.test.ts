/**
 * 传输层集成测试 —— 对真实 nak 中继（随机端口、等就绪、测完必关）。
 *
 * 覆盖 SPEC §9 的集成验收 + 用户指定的五个必含用例：
 *   1. 一个中继宕机时进程不崩溃且另一个仍送达
 *   2. 中继返回 OK=false 时发送报告失败
 *   3. 同一消息经两个中继到达只处理一次
 *   4. 离线消息上线后收到
 *   5. 中继上抓到的是密文且看不到发送者
 */

import WebSocket from 'ws'
import type { Event } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { afterAll, describe, expect, it } from 'vitest'
import { startNak, waitFor, type NakRelay } from './helpers/nak'
import { Transport } from '../../src/transport/transport'
import { createPipeline } from '../../src/receive/pipeline'
import { DedupTable } from '../../src/receive/dedup'
import { PendingPings } from '../../src/receive/pending-pings'
import { AutoReplyPolicy } from '../../src/receive/handler'
import { buildTextMessage } from '../../src/messaging/outgoing'
import { SlidingWindowLimiter } from '../../src/common/rate-limit'
import { wsCast } from './helpers/ws-cast'

const relays: NakRelay[] = []
afterAll(async () => {
  for (const relay of relays.splice(0)) await relay.stop()
})

async function start(): Promise<NakRelay> {
  const relay = await startNak()
  relays.push(relay)
  return relay
}

/** 发送方 A 的构造依赖。 */
const skA = generateSecretKey()
const pkA = getPublicKey(skA)
const skB = generateSecretKey()
const pkB = getPublicKey(skB)

function textEvent(to: string): Event {
  const built = buildTextMessage(
    { ownSecretKey: skA, ownPubkey: pkA, now: () => Math.floor(Date.now() / 1000) },
    to,
    'integration-hello',
  )
  if (!built.ok) throw new Error(`构造失败：${built.detail}`)
  return built.wrap
}

function receiverPipeline() {
  const handled: Event[] = []
  const rejects: { reason: string }[] = []
  const dedup = new DedupTable()
  const process = createPipeline({
    ownSecretKey: skB,
    ownPubkey: pkB,
    now: () => Math.floor(Date.now() / 1000),
    dedup,
    handler: () => handled.push({} as Event),
    onReject: (reason) => rejects.push({ reason }),
  })
  return { handled, rejects, dedup, process }
}

describe('传输层集成（真实 nak 中继）', () => {
  it('用例 1：一个中继宕机时进程不崩溃，另一个仍送达', async () => {
    const alive = await start()
    // 宕机中继：一个没有进程监听的端口
    const dead = await startNak()
    const deadUrl = `ws://127.0.0.1:${dead.port}`
    await dead.stop() // 端口已腾出，但连接将被拒绝

    const transport = new Transport({
      urls: [alive.url, deadUrl],
      websocketImplementation: wsCast(),
      connectTimeoutMs: 2000,
      reconnectBaseDelayMs: 50,
      reconnectMaxAttempts: 1,
    })

    const connectResults = await transport.connect() // 这里崩溃 = 测试失败
    expect(connectResults).toHaveLength(2)
    expect(connectResults[0]).toMatchObject({ url: alive.url, ok: true })
    expect(connectResults[1]).toMatchObject({ url: deadUrl, ok: false })

    const report = await transport.publish(textEvent(pkB))
    expect(report.delivered).toBe(true)
    expect(report.results).toHaveLength(2)
    expect(report.results[0]).toMatchObject({ url: alive.url, ok: true })
    expect(report.results[1]).toMatchObject({ url: deadUrl, ok: false })
    transport.close()
  })

  it('用例 2：中继返回 OK=false 时发送报告失败', async () => {
    const relay = await start()
    const transport = new Transport({ urls: [relay.url], websocketImplementation: wsCast() })
    await transport.connect()

    // 合法签名的消息正常送达
    const good = await transport.publish(textEvent(pkB))
    expect(good.delivered).toBe(true)

    // 篡改签名后中继必须回 OK=false —— 报告必须如实反映
    const event = textEvent(pkB)
    const bad = await transport.publish({ ...event, sig: '00'.repeat(64) })
    expect(bad.delivered).toBe(false)
    expect(bad.results[0]?.ok).toBe(false)
    transport.close()
  })

  it('用例 3：同一消息经两个中继到达只处理一次', async () => {
    const relayA = await start()
    const relayB = await start()
    const sender = new Transport({
      urls: [relayA.url, relayB.url],
      websocketImplementation: wsCast(),
    })
    await sender.connect()

    const receiver = new Transport({
      urls: [relayA.url, relayB.url],
      websocketImplementation: wsCast(),
    })
    await receiver.connect()

    const rx = receiverPipeline()
    receiver.subscribeGiftWraps(pkB, (evt) => {
      rx.process(evt)
    })

    const event = textEvent(pkB)
    const report = await sender.publish(event)
    expect(report.delivered).toBe(true)

    // 两个中继都会投递同一条消息；去重表必须保证只处理一次
    const settled = await waitFor(() => rx.handled.length + rx.rejects.length >= 2)
    expect(settled).toBe(true)
    expect(rx.handled).toHaveLength(1)
    expect(rx.rejects.map((r) => r.reason)).toContain('DUPLICATE')

    sender.close()
    receiver.close()
  })

  it('用例 4：离线消息上线后收到（since = now − 72h 覆盖 gift wrap 回溯）', async () => {
    const relay = await start()

    // 接收方此时不在线：只有发送方连着中继
    const sender = new Transport({ urls: [relay.url], websocketImplementation: wsCast() })
    await sender.connect()
    const report = await sender.publish(textEvent(pkB))
    expect(report.delivered).toBe(true)

    // 接收方上线，订阅回溯 72h
    const receiver = new Transport({ urls: [relay.url], websocketImplementation: wsCast() })
    await receiver.connect()
    const rx = receiverPipeline()
    receiver.subscribeGiftWraps(pkB, (evt) => {
      rx.process(evt)
    })

    const got = await waitFor(() => rx.handled.length >= 1)
    expect(got).toBe(true)
    expect(rx.rejects).toHaveLength(0)

    sender.close()
    receiver.close()
  })

  it('用例 5：中继上抓到的是密文，且外层公钥不是发送者', async () => {
    const relay = await start()
    const sender = new Transport({ urls: [relay.url], websocketImplementation: wsCast() })
    await sender.connect()

    // 一个"旁听者"：裸 WebSocket 订阅全部 gift wrap
    const eavesdropped: Event[] = []
    const eavesdropper = new WebSocket(relay.url)
    await new Promise<void>((resolve, reject) => {
      eavesdropper.on('open', () => {
        eavesdropper.send(
          JSON.stringify(['REQ', 'eaves', { kinds: [1059], since: Math.floor(Date.now() / 1000) - 72 * 3600 }]),
        )
        resolve()
      })
      eavesdropper.on('error', reject)
    })
    eavesdropper.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as unknown
      if (Array.isArray(parsed) && parsed[0] === 'EVENT' && parsed[2] !== undefined) {
        eavesdropped.push(parsed[2] as Event)
      }
    })

    await sender.publish(textEvent(pkB))
    const captured = await waitFor(() => eavesdropped.length >= 1)
    expect(captured).toBe(true)

    const evt = eavesdropped[0] as Event
    expect(evt.kind).toBe(1059)
    expect(evt.pubkey).not.toBe(pkA) // 外层是临时密钥，看不到发送者
    expect(evt.content).not.toContain('integration-hello') // 内容是密文
    expect(evt.content).not.toContain(pkB) // 收件人只在 #p 标签（已知限制 L1）

    eavesdropper.close()
    sender.close()
  })

  it('单连接入站速率上限生效（防御性）', async () => {
    // 纯单元层面的补充：RelayConnection 的入站闸用的就是这个限流器
    let t = 0
    const limiter = new SlidingWindowLimiter(2, 60_000, () => t)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)
  })
})
