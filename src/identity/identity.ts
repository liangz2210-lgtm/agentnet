import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { baseDir, identityPath } from '../config/paths'
import {
  DIR_MODE,
  KEY_FILE_MODE,
  MAX_KEY_FILE_BYTES,
  KeyDirError,
  assertPrivateDirectory,
  assertPrivateKeyFile,
  type FileStat,
} from './keyfile'

/** 从本模块再导出，调用方不必知道它定义在 keyfile。 */
export { DIR_MODE, KEY_FILE_MODE, MAX_KEY_FILE_BYTES } from './keyfile'

const HEX_64 = /^[0-9a-f]{64}$/i

/** 私钥字节长度：secp256k1 标量固定 32 字节。 */
export const SECRET_KEY_BYTES = 32

/**
 * `O_NOFOLLOW` **在本机实测存在且生效**（Node 22.22.2 / 26.4.0 均为 256 / 0o400，
 * 打开符号链接返回 ELOOP）。但它是 BSD/Linux 特有、Windows 上不存在的常量，
 * 所以这里做特性检测：拿不到就退化为「fstat(fd) 与 lstat(路径) 比对 dev/ino」。
 * 两者都不依赖平台，区别在于强度不同。
 */
const O_NOFOLLOW: number | undefined = (constants as Record<string, number | undefined>)[
  'O_NOFOLLOW'
]
/**
 * `O_NONBLOCK` 用于防止打开 FIFO 时挂起 —— 只读打开一个无写端的 FIFO 会永久阻塞。
 * 加上它之后 open 立即返回，随后由 fstat 发现"不是普通文件"而拒绝。
 */
const O_NONBLOCK: number | undefined = (constants as Record<string, number | undefined>)[
  'O_NONBLOCK'
]

export class IdentityExistsError extends Error {
  constructor(path: string) {
    super(
      `身份已存在：${path}。\n` +
        `不会自动覆盖：请先手动备份（cp -p）或移走该文件，再重新运行 init。\n` +
        `注意：私钥一旦丢失无法找回。`,
    )
    this.name = 'IdentityExistsError'
  }
}

export class IdentityMissingError extends Error {
  constructor(path: string) {
    super(`未找到身份文件：${path}。请先运行 agentnet init`)
    this.name = 'IdentityMissingError'
  }
}

export class IdentityAccessError extends Error {
  constructor(path: string, code: string) {
    super(`无法访问身份文件：${path}（${code}）。请检查父目录与文件的权限与属主。`)
    this.name = 'IdentityAccessError'
  }
}

export class MalformedKeyError extends Error {
  constructor(reason: string) {
    super(`私钥文件格式错误：${reason}`)
    this.name = 'MalformedKeyError'
  }
}

export interface Identity {
  secretKey: Uint8Array
  publicKey: string
}

export function generateIdentity(): Identity {
  const secretKey = generateSecretKey()
  return { secretKey, publicKey: getPublicKey(secretKey) }
}

function toStat(st: Stats): FileStat {
  return {
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
    mode: st.mode,
    uid: st.uid,
    size: st.size,
  }
}

/**
 * `process.getuid` 在跨平台类型上是可选的 —— 而在无 uid 概念的系统上，
 * 本项目的 0600 权限模型（SPEC §7 规则 2）根本不成立，因此直接报错而非降级。
 */
function currentUid(): number {
  const getuid = process.getuid
  if (typeof getuid !== 'function') {
    throw new Error('当前平台不支持 uid 校验，无法安全使用私钥文件')
  }
  return getuid.call(process)
}

/**
 * 基目录准入：`mkdirSync` 的 mode 只对**新建**的目录生效（实测：recursive 模式下
 * 每一层新建目录都会带上该 mode），目录**已存在**时它既不检查也不收紧；
 * 而 `lstatSync` 与打开时的 `O_NOFOLLOW` 都只作用于**路径最后一段**。
 * 因此 mkdir 之后必须自己验一遍。
 *
 * ⚠️ 已知缺口（二轮审计 A1/A2）：**祖先路径段不受覆盖** ——
 * 基目录任一祖先被替换成符号链接时，这里的校验与随后的 open 都会被整体平移。
 * 当前实现也未复用目录校验的结果（见 A2）。两者均未修，待定。
 *
 * 采用拒绝而非自动 chmod：与私钥文件「权限过松则拒绝运行」保持一致，
 * 静默改动用户目录权限是更糟的惊喜。
 */
function ensureBaseDirReady(dir: string): void {
  let st: Stats
  try {
    st = lstatSync(dir)
  } catch (err) {
    throw new KeyDirError(`无法访问数据目录：${dir}（${errnoOf(err)}）`)
  }
  assertPrivateDirectory(toStat(st), currentUid())
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
  )
}

function errnoOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const c = (err as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return 'UNKNOWN'
}

/** 打开私钥文件：绕开符号链接、不因 FIFO 挂起、返回已钉住 inode 的 fd。 */
function openKeyFile(target: string): number {
  let flags = constants.O_RDONLY | (O_NONBLOCK ?? 0)
  if (O_NOFOLLOW !== undefined) flags |= O_NOFOLLOW
  return openSync(target, flags)
}

/**
 * 写入新身份。**文件创建即刻以 0600 打开**（`wx`），而非"先建后 chmod" —— 后者
 * 在写入与 chmod 之间存在可被读取的时间窗（DECISIONS.md「私钥保护」）。
 *
 * 若文件已存在则**拒绝覆盖**并提示用户手动备份或移走（不提供 --force）。
 * 打开之后的任何失败都会删除残留文件，保证「要么有合规可用的身份，要么磁盘上什么都没有」。
 */
export function saveNewIdentity(
  secretKey: Uint8Array,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new MalformedKeyError(`私钥必须是 ${SECRET_KEY_BYTES} 字节`)
  }

  const dir = baseDir(env)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  ensureBaseDirReady(dir)

  const target = identityPath(env)
  // 落盘为 64 个十六进制字符（而非 32 字节原始二进制）：格式可被人工检视，
  // 且与 MAX_KEY_FILE_BYTES 的上限口径一致。
  const payload = Buffer.from(Buffer.from(secretKey).toString('hex'), 'utf8')

  let fd: number
  try {
    fd = openSync(target, 'wx', KEY_FILE_MODE)
  } catch (err) {
    if (isErrno(err, 'EEXIST')) {
      throw new IdentityExistsError(target)
    }
    throw err
  }

  try {
    writeAll(fd, payload)
    fsyncSync(fd)
    // 对 fd 校验：umask 会削弱 open 的 mode 实参，因此落盘后必须复核。
    assertPrivateKeyFile(toStat(fstatSync(fd)), currentUid())
  } catch (err) {
    closeSync(fd)
    // 清场：不留一个"存在但不可用、又挡住重建"的半成品文件。
    try {
      unlinkSync(target)
    } catch {
      /* 清理失败也要继续抛出原错误 */
    }
    throw err
  }
  closeSync(fd)
  return target
}

/** 循环写，处理短写（磁盘满、信号中断都可能触发）。 */
function writeAll(fd: number, buf: Buffer): void {
  let written = 0
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written)
    if (n <= 0) throw new MalformedKeyError('写入私钥文件时未能推进')
    written += n
  }
}

/**
 * 加载身份。
 *
 * 顺序刻意如此：`openSync`（钉住 inode，且拒绝符号链接 / 不因 FIFO 挂起）
 * → `fstatSync(fd)` 校验 → 按 size 判上限 → 从 **fd** 读。
 * 全程不再对路径做第二次解析，因此不存在 TOCTOU 窗口。
 */
export function loadIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Identity {
  const dir = baseDir(env)
  ensureBaseDirReady(dir)
  const target = identityPath(env)

  let fd: number
  try {
    fd = openKeyFile(target)
  } catch (err) {
    const code = errnoOf(err)
    // 只把 ENOENT 当成"不存在"。EACCES / ELOOP / ENOTDIR 各有含义，
    // 一律伪装成"文件不存在"会诱导用户去重建身份 —— 方向正好是攻击者想要的。
    if (code === 'ENOENT') throw new IdentityMissingError(target)
    throw new IdentityAccessError(target, code)
  }

  try {
    const st = fstatSync(fd)

    // 无 O_NOFOLLOW 时的等效防线：fd 指向的 inode 必须与 lstat 看到的一致。
    if (O_NOFOLLOW === undefined) {
      const pathStat = lstatSync(target)
      if (pathStat.dev !== st.dev || pathStat.ino !== st.ino) {
        throw new Error('身份文件在打开前后被替换')
      }
    }

    assertPrivateKeyFile(toStat(st), currentUid())

    // 上限由 assertPrivateKeyFile 在读取之前判掉，此处不重复。
    const size = st.size
    if (size <= 0) throw new MalformedKeyError('私钥文件为空')

    const buf = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read)
      if (n <= 0) break
      read += n
    }
    const raw = buf.subarray(0, read).toString('utf8').trim()

    if (!HEX_64.test(raw)) {
      throw new MalformedKeyError('期望 64 位十六进制字符串')
    }

    const secretKey = Uint8Array.from(Buffer.from(raw, 'hex'))
    return { secretKey, publicKey: derivePublicKey(secretKey) }
  } finally {
    closeSync(fd)
  }
}

/** 底层库的错误收口成自有类型，且错误信息绝不携带私钥内容。 */
function derivePublicKey(secretKey: Uint8Array): string {
  try {
    return getPublicKey(secretKey)
  } catch {
    throw new MalformedKeyError('不是有效的 secp256k1 私钥')
  }
}

export function whoami(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return loadIdentity(env).publicKey
}
