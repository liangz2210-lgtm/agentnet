import { DEFAULT_LIFETIME_SECONDS } from './constants'
import { validateEnvelope, type RejectReason, type ValidationResult } from './validate'
import type { EnvelopeType } from './validate'

/** 发送侧调用 `buildEnvelope` 时输入的载荷形态。 */
export interface BuildEnvelopeInput {
  id: string
  type: EnvelopeType
  /** 发送方自己的公钥。会与 `ownPubkey` 比对（发送侧额外检查）。 */
  from: string
  /** 接收方公钥。`to` 在 send 命令输入时即已确定，不是变量。 */
  to: string
  /** 取自时钟。透传给共享校验作为唯一时间基准。 */
  createdAt: number
  /** 有效期秒数，缺省 1 小时（SPEC §5）。 */
  lifetimeSeconds?: number
  payload: Record<string, unknown>
  session?: string
  note?: string
}

export interface SendOk {
  ok: true
  raw: string
  envelope: NonNullable<Extract<ValidationResult, { ok: true }>['envelope']>
}

export type SendResult = SendOk | { ok: false; reason: RejectReason; detail: string }

/**
 * 构造信封 —— **这是发送侧唯一调用共享校验的点**，
 * 位于「构造完成后、加密封装之前」（DECISIONS §6）。
 *
 * 发送侧的额外检查：
 *   - `from` 必须等于自己的公钥
 *   - `to` 的公钥格式（`TO_INVALID_FORMAT`）—— 由共享的 `validateEnvelope` 覆盖，
 *     此处不再重复实现
 *
 * 注意：发送侧的校验**只是提前报错、省一次网络往返**，
 * 不构成任何安全保障 —— 真正强制执行的永远是接收侧。
 */
export function buildEnvelope(
  input: BuildEnvelopeInput,
  ctx: { ownPubkey: string; now: number },
): SendResult {
  if (input.from !== ctx.ownPubkey) {
    return {
      ok: false,
      reason: 'FROM_NOT_SELF',
      detail: 'from 与本机公钥不一致',
    }
  }

  const lifetime = input.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS
  const expiresAt = input.createdAt + lifetime

  // 信封内不再携带 created_at —— DECISIONS §6：以 rumor.created_at 为唯一时间基准。
  const envelope: Record<string, unknown> = {
    v: 0,
    id: input.id,
    type: input.type,
    from: input.from,
    to: input.to,
    expires_at: expiresAt,
    payload: input.payload,
    receipt: null,
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }

  const raw = JSON.stringify(envelope)

  const result = validateEnvelope(raw, {
    rumorCreatedAt: input.createdAt,
    now: ctx.now,
  })

  if (!result.ok) return result
  return { ok: true, raw, envelope: result.envelope }
}

export { validateEnvelope }
