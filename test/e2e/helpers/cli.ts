/**
 * 端到端测试的 CLI 驱动 —— **必须跑真实子进程**（用户定稿第 5 条）。
 *
 * 用子进程而不是 `run()` 的理由：`run()` 只覆盖命令层，而真实二进制还要过
 * "main() → process.exit(code)" 这一层。第 5 步实测就在这里抓到过一个
 * `run()` 测不出来的 bug：CommandExitError 未捕获 → "无身份"退出码变成 1。
 *
 * 数据目录一律建在**项目内**的 test/.tmp 下：macOS 的 os.tmpdir() 落在
 * /private/tmp（sticky + 世界可写），会被 assertAncestrySafe 直接拒绝。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = process.cwd()
export const CLI_BIN = join(ROOT, 'dist', 'cli', 'bin.js')
const TMP_ROOT = join(ROOT, 'test', '.tmp')

/** 每个用例一个独立 AGENTNET_HOME（mkdtempSync 默认 0700，满足目录权限要求）。 */
export function mkHome(): string {
  mkdirSync(TMP_ROOT, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(TMP_ROOT, 'home-'))
}

/**
 * **每次都重建** CLI 二进制，永远不复用旧的 dist。
 *
 * 吃过一次亏：改了 `--ttl` 的实现后 e2e 仍然失败，因为 `ensureBuilt()` 只在
 * dist 缺失时才构建，测试一直在跑改之前那份二进制。"端到端"里那个"端"
 * 必须是**当前源码**的产物，否则它验证的是历史。
 */
export function ensureBuilt(): void {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-cli.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (r.status !== 0 || !existsSync(CLI_BIN)) {
    throw new Error(`CLI 构建失败：${r.stdout ?? ''}${r.stderr ?? ''}`)
  }
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOpts {
  home: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

/** 跑一条命令并等它自己退出（send / ping 必须自行退出 —— 用户定稿）。 */
export function runCli(args: readonly string[], opts: RunOpts): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, AGENTNET_HOME: opts.home, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', (c: string) => (stderr += c))

    if (opts.stdin === undefined) child.stdin.end()
    else {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI 超时未退出：agentnet ${args.join(' ')}`))
    }, opts.timeoutMs ?? 20_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface ListenProc {
  stdout(): string
  stderr(): string
  /** 等到 stdout 出现匹配行（listen 的 text 输出走 stdout）。 */
  waitForLine(re: RegExp, timeoutMs?: number): Promise<string | null>
  waitForStderr(re: RegExp, timeoutMs?: number): Promise<string | null>
  stop(): Promise<number | null>
  readonly pid: number | undefined
}

/** 启动常驻的 listen 进程（它会一直跑到收到 SIGTERM）。 */
export function spawnListen(
  home: string,
  relayUrls: readonly string[],
  extraArgs: readonly string[] = [],
): ListenProc {
  const args = ['listen', ...relayUrls.flatMap((u) => ['--relay', u]), ...extraArgs]
  const child: ChildProcess = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGENTNET_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => (stdout += c))
  child.stderr?.on('data', (c: string) => (stderr += c))

  const waitIn = (get: () => string, re: RegExp, timeoutMs: number): Promise<string | null> =>
    new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = (): void => {
        const hit = get()
          .split('\n')
          .find((l) => re.test(l))
        if (hit !== undefined) return resolve(hit)
        if (Date.now() > deadline || child.exitCode !== null) return resolve(null)
        setTimeout(tick, 50)
      }
      tick()
    })

  return {
    pid: child.pid,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForLine: (re, t = 8000) => waitIn(() => stdout, re, t),
    waitForStderr: (re, t = 8000) => waitIn(() => stderr, re, t),
    stop: async () => {
      if (child.exitCode !== null) return child.exitCode
      return new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
        child.kill('SIGTERM')
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve(null)
        }, 3000).unref?.()
      })
    },
  }
}

/** 清理 e2e 产生的临时目录。 */
export function cleanHome(home: string): void {
  rmSync(home, { recursive: true, force: true })
}
