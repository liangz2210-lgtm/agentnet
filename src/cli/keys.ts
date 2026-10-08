/**
 * 公钥参数的解析（用户定稿）：
 * - 接受 **十六进制**（64 位小写/大写十六进制）与 **npub**（NIP-19 bech32）
 * - 统一转成小写十六进制后校验格式
 * - **疑似 nsec 私钥的参数一律拒绝并提示** —— 私钥不接受通过命令行传入
 *   （SPEC §7 规则 2 与 DECISIONS §9），命令行参数会进 shell 历史
 *   与其他进程可见的进程列表
 */

import { nip19 } from 'nostr-tools'

export class InvalidPubkeyError extends Error {
  constructor(reason: string, hint: string) {
    super(`${reason}\n${hint}`)
    this.name = 'InvalidPubkeyError'
  }
}

const NSEC_HINT =
  '看起来这是私钥（nsec）。私钥不接受通过命令行传入：它会进入 shell 历史和进程列表。\n' +
  '本命令需要的是**对方公钥**（64 位十六进制或 npub）。'

/** 把 hex / npub 统一解析成 64 位小写十六进制公钥。疑似私钥即拒绝。 */
export function parsePubkeyArg(input: string): string {
  const trimmed = input.trim()

  // 疑似私钥：任何 bech32 私钥前缀（nsec / ncryptsec）直接拒绝
  if (/^nsec1/i.test(trimmed) || /^ncryptsec1/i.test(trimmed)) {
    throw new InvalidPubkeyError('拒绝：参数疑似 nsec 私钥。', NSEC_HINT)
  }
  // 128 位十六进制是私钥的 hex 形态，同样拒绝
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    throw new InvalidPubkeyError('拒绝：参数疑似 128 位十六进制私钥。', NSEC_HINT)
  }

  if (/^npub1/i.test(trimmed)) {
    try {
      const decoded = nip19.decode(trimmed)
      if (decoded.type !== 'npub') {
        throw new Error(`decode 得到 ${String(decoded.type)}`)
      }
      const pubkey = decoded.data as string
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('解码结果不是 64 位十六进制')
      return pubkey.toLowerCase()
    } catch (err) {
      const detail = err instanceof InvalidPubkeyError ? err.message : 'npub 解码失败或格式不对'
      throw new InvalidPubkeyError(`拒绝：${detail}`, '公钥形如 npub1… 或 64 位十六进制。')
    }
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  throw new InvalidPubkeyError(
    '拒绝：公钥必须是 64 位十六进制或 npub1…。',
    '可从对方机器上运行 agentnet whoami 获取。',
  )
}
