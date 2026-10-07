import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { baseDir, identityPath } from '../config/paths'
import { KEY_FILE_MODE, assertPrivateKeyFile, type KeyFileStat } from './keyfile'

/** 数据目录权限：仅属主可访问。 */
export const DIR_MODE = 0o700

const HEX_64 = /^[0-9a-f]{64}$/i

export class IdentityExistsError extends Error {
  constructor(path: string) {
    super(`身份已存在：${path}。未提供 --force，拒绝覆盖`)
    this.name = 'IdentityExistsError'
  }
}

export class IdentityMissingError extends Error {
  constructor(path: string) {
    super(`未找到身份文件：${path}。请先运行 agentnet init`)
    this.name = 'IdentityMissingError'
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

function toStat(st: Stats): KeyFileStat {
  return {
    isFile: st.isFile(),
    isSymbolicLink: st.isSymbolicLink(),
    mode: st.mode,
    uid: st.uid,
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
 * 写入新身份。**文件创建即刻以 0600 打开**，而非"先建后 chmod" —— 后者在
 * 创建与 chmod 之间存在可被读取的时间窗（DECISIONS.md「私钥保护」）。
 *
 * 若文件已存在则抛 `IdentityExistsError`，**绝不覆盖**。
 */
export function saveNewIdentity(
  secretKey: Uint8Array,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = baseDir(env)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })

  const target = identityPath(env)
  const payload = Buffer.from(secretKey).toString('hex')

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
    writeSync(fd, payload)
  } finally {
    closeSync(fd)
  }

  // umask 会削弱 open 的 mode 实参，因此落盘后必须回读校验。
  assertPrivateKeyFile(toStat(lstatSync(target)), currentUid())
  return target
}

/**
 * 加载身份。先做准入校验（符号链接 / 属主 / 权限），通过后才读取内容。
 *
 * 私钥只来自文件；**不存在任何环境变量或命令行兜底路径**。
 */
export function loadIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Identity {
  const target = identityPath(env)

  let st: Stats
  try {
    st = lstatSync(target)
  } catch {
    throw new IdentityMissingError(target)
  }

  assertPrivateKeyFile(toStat(st), currentUid())

  const raw = readFileSync(target, 'utf8').trim()
  if (!HEX_64.test(raw)) {
    throw new MalformedKeyError('期望 64 位十六进制字符串')
  }

  const secretKey = Uint8Array.from(Buffer.from(raw, 'hex'))
  return { secretKey, publicKey: getPublicKey(secretKey) }
}

export function whoami(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return loadIdentity(env).publicKey
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === code
  )
}
