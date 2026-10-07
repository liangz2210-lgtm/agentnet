import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { IDENTITY_FILENAME } from '../config/paths'
import { assertAncestrySafe, resolveRealBaseDir } from '../config/dirguard'
import { currentUid } from '../config/uid'
import {
  DIR_MODE,
  KEY_FILE_MODE,
  MAX_KEY_FILE_BYTES,
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
 *
 * ⚠️ 该 dev/ino 回退分支**在本机永远不执行**（已知限制 L9）：
 * 本机两个 Node 版本都实测存在 `O_NOFOLLOW`。保留它是为了无该常量的平台，
 * 因此它不在本机的覆盖率统计内，也不应被当作"已验证的防线"。
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

/** 已存在身份：`init` 拒绝覆盖，且不提供 `--force`。 */
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

/** 身份不存在：无论是文件缺失还是基目录缺失，都导向"先运行 init"。 */
export class IdentityMissingError extends Error {
  constructor(path: string) {
    super(`未找到身份文件：${path}。请先运行 agentnet init`)
    this.name = 'IdentityMissingError'
  }
}

/** 身份路径是符号链接（打开阶段即被 `O_NOFOLLOW` 拒绝）。 */
export class IdentitySymlinkError extends Error {
  constructor(path: string) {
    super(`身份文件不能是符号链接：${path}。请删除该链接后重新运行 init。`)
    this.name = 'IdentitySymlinkError'
  }
}

/** 权限不足，无法读/写身份文件或其所在目录。 */
export class IdentityPermissionError extends Error {
  constructor(path: string) {
    super(`没有权限访问身份文件：${path}。请检查该路径各级目录与文件的权限与属主。`)
    this.name = 'IdentityPermissionError'
  }
}

/** 兜底：无法访问，但**不泄露裸 errno**（A7）。 */
export class IdentityAccessError extends Error {
  constructor(path: string) {
    super(`无法访问身份文件：${path}。请检查父目录与文件的权限与属主。`)
    this.name = 'IdentityAccessError'
  }
}

/**
 * 写入未完成，且**清理残留文件也失败**（A3）。
 *
 * 这是最危险的一种失败：磁盘上留下一个"内容不完整、又因 `wx` 挡住重建"的文件，
 * 用户会被永久卡住。因此必须显式上报**并给出路径与手动处置步骤** ——
 * 程序不自动删除（删掉什么，只能由人来决定）。
 */
export class IdentityCleanupError extends Error {
  constructor(path: string, original: unknown, cleanup: unknown) {
    super(
      `写入身份文件失败，且清理残留文件也失败。\n` +
        `残留文件：${path}\n` +
        `原始失败：${messageOf(original)}\n` +
        `清理失败：${messageOf(cleanup)}\n` +
        `请手动处置（程序不会自动删除）：\n` +
        `  1. cp -p "${path}" "${path}.bak"   先备份\n` +
        `  2. mv "${path}" "${path}.stuck"     再移走，解除对 init 的阻塞\n` +
        `  3. 重新运行 agentnet init`,
    )
    this.name = 'IdentityCleanupError'
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把底层 errno 归类成**自有错误类型**（A7）。
 *
 * 不把裸 errno 拼进消息：errno 会向攻击者透露文件系统状态
 * （"这个路径是 ENOENT 还是 EACCES"本身就是信息）。
 * 对外只给"发生了什么 + 该怎么办"，分类通过错误**类型**表达。
 */
function classifyFsError(err: unknown, path: string): Error {
  const code = errnoOf(err)
  switch (code) {
    case 'ENOENT':
      return new IdentityMissingError(path)
    case 'ELOOP':
      return new IdentitySymlinkError(path)
    case 'EACCES':
    case 'EPERM':
      return new IdentityPermissionError(path)
    default:
      return new IdentityAccessError(path)
  }
}

/**
 * 基目录准入：`mkdirSync` 的 mode 只对**新建**的目录生效（实测：recursive 模式下
 * 每一层新建目录都会带上该 mode），目录**已存在**时它既不检查也不收紧；
 * 而 `lstatSync` 与打开时的 `O_NOFOLLOW` 都只作用于**路径最后一段** ——
 * 祖先路径段由 `assertAncestrySafe` 覆盖（A1 / A2）。
 *
 * 采用拒绝而非自动 chmod：与私钥文件「权限过松则拒绝运行」保持一致，
 * 静默改动用户目录权限是更糟的惊喜。
 *
 * **基目录不存在 ⇒ 视同身份不存在**（A6）：抛 `IdentityMissingError`，
 * 让首次运行引导照常出现，而不是抛一个让人摸不着头脑的"目录错误"。
 */
function assertDirectoryReady(dir: string, uid: number): void {
  let st: Stats
  try {
    st = lstatSync(dir)
  } catch (err) {
    throw classifyFsError(err, join(dir, IDENTITY_FILENAME))
  }
  assertPrivateDirectory(toStat(st), uid)
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
 * 打开之后的任何失败都会**先截断再删除**残留文件（A3），
 * 保证「要么有合规可用的身份，要么磁盘上什么都没有」。
 */
export function saveNewIdentity(
  secretKey: Uint8Array,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new MalformedKeyError(`私钥必须是 ${SECRET_KEY_BYTES} 字节`)
  }

  const uid = currentUid()
  // 解析一次真实路径，之后全程使用它 —— 祖先路径段同样纳入检查（A1 / A2）。
  const { real, exists } = resolveRealBaseDir(env)
  assertAncestrySafe(real, uid)
  if (!exists) mkdirSync(real, { recursive: true, mode: DIR_MODE })
  assertDirectoryReady(real, uid)

  const target = join(real, IDENTITY_FILENAME)
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
    throw classifyFsError(err, target)
  }

  try {
    writeAll(fd, payload)
    fsyncSync(fd)
    // 对 fd 校验：umask 会削弱 open 的 mode 实参，因此落盘后必须复核。
    assertPrivateKeyFile(toStat(fstatSync(fd)), uid)
  } catch (err) {
    // A3：先把长度截断为 0 —— 即便随后 unlink 失败，磁盘上也不该残留私钥字节。
    try {
      ftruncateSync(fd, 0)
    } catch {
      /* 截断失败也要继续尝试 unlink */
    }
    try {
      closeSync(fd)
    } catch {
      /* 同上 */
    }
    try {
      unlinkSync(target)
    } catch (cleanupErr) {
      // 不静默：残留文件会让用户永久卡住，必须显式上报并给出路径与手动步骤。
      throw new IdentityCleanupError(target, err, cleanupErr)
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
 * 顺序刻意如此：解析真实路径 → 逐层祖先检查 → 目录准入 → `openSync`
 * （钉住 inode，且拒绝符号链接 / 不因 FIFO 挂起）→ `fstatSync(fd)` 校验
 * → 按 size 判上限 → 从 **fd** 读。
 * 全程不再对路径做第二次解析，因此不存在 TOCTOU 窗口。
 */
export function loadIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Identity {
  const uid = currentUid()
  const { real, exists } = resolveRealBaseDir(env)
  assertAncestrySafe(real, uid)
  // A6：基目录不存在 = 还没有身份，而不是"目录出错"。
  if (!exists) throw new IdentityMissingError(join(real, IDENTITY_FILENAME))
  assertDirectoryReady(real, uid)

  const target = join(real, IDENTITY_FILENAME)

  let fd: number
  try {
    fd = openKeyFile(target)
  } catch (err) {
    throw classifyFsError(err, target)
  }

  try {
    const st = fstatSync(fd)

    // ⚠️ 仅用于**无 `O_NOFOLLOW` 的平台**；本机实测存在该常量，此分支不执行（L9）。
    // 原理：fd 指向的 inode 必须与 lstat 看到的一致，否则说明中间被掉包。
    if (O_NOFOLLOW === undefined) {
      const pathStat = lstatSync(target)
      if (pathStat.dev !== st.dev || pathStat.ino !== st.ino) {
        throw new IdentitySymlinkError(target)
      }
    }

    assertPrivateKeyFile(toStat(st), uid)

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
