/**
 * `nak serve` 测试夹具（DECISIONS §1 的强制约束）：
 *
 * - **随机端口**：先向内核要一个空闲端口，避免并发用例互撞
 * - **等就绪**：轮询 WebSocket 握手，直到中继真的能应答（最多 10 秒）
 * - **测完必关**：`stop()` 杀进程、等退出、清临时目录
 * - **数据目录隔离**：nak 是内存中继、没有数据目录；隔离手段是
 *   "每个用例一套独立的中继实例 + 独立的临时目录（AGENTNET_HOME）"
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import WebSocket from 'ws'

export interface NakRelay {
  url: string
  port: number
  dataDir: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法取得空闲端口'))))
    })
  })
}

async function canConnect(url: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const done = (v: boolean): void => {
      ws.removeAllListeners()
      ws.terminate()
      resolve(v)
    }
    ws.on('open', () => done(true))
    ws.on('error', () => done(false))
    const timer = setTimeout(() => done(false), timeoutMs)
    timer.unref?.()
  })
}

export async function startNak(): Promise<NakRelay> {
  const port = await freePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'agentnet-nak-'))
  const child: ChildProcess = spawn('nak', ['serve', '--port', String(port)], {
    stdio: 'ignore',
  })
  const url = `ws://127.0.0.1:${port}`

  const deadline = Date.now() + 10_000
  for (;;) {
    if (await canConnect(url)) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      rmSync(dataDir, { recursive: true, force: true })
      throw new Error(`nak serve 在 10 秒内未就绪（${url}）—— 是否已安装 nak 0.21.0？`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  return {
    url,
    port,
    dataDir,
    stop: async () => {
      if (child.exitCode !== null) {
        rmSync(dataDir, { recursive: true, force: true })
        return
      }
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2000).unref?.()
      })
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 轮询等待条件成立（集成测试里等事件到达用）。 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
