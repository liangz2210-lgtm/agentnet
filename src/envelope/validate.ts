import {
  ALLOWED_TOP_LEVEL_FIELDS,
  FORBIDDEN_KEYS,
  ID_ULID_PATTERN,
  ID_UUID_PATTERN,
  MAX_ENVELOPE_BYTES,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  MAX_NOTE_BYTES,
  MAX_SESSION_BYTES,
  MAX_TEXT_BYTES,
  PUBKEY_PATTERN,
  REQUIRED_TOP_LEVEL_FIELDS,
  SESSION_PATTERN,
} from './constants'

export type EnvelopeType = 'ping' | 'pong' | 'text'

export interface PingPayload {
  kind: 'ping'
}

export interface PongPayload {
  kind: 'pong'
  id: string
}

export interface TextPayload {
  kind: 'text'
  text: string
}

export type EnvelopePayload = PingPayload | PongPayload | TextPayload

export interface AgentEnvelope {
  v: 0
  id: string
  type: EnvelopeType
  from: string
  to: string
  /** 取自 `rumor.created_at`，是唯一的时间基准（DECISIONS §6）。 */
  created_at: number
  expires_at: number
  payload: EnvelopePayload
  session?: string
  note?: string
  receipt: null
}

export type RejectReason =
  | 'NOT_STRING'
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'NOT_OBJECT'
  | 'UNKNOWN_TOP_LEVEL_FIELD'
  | 'MISSING_FIELD'
  | 'UNKNOWN_TYPE'
  | 'INVALID_FIELD'
  | 'UNSAFE_KEY'
  | 'CREATED_AT_MISMATCH'
  | 'CLOCK_TOO_FUTURE'
  | 'LIFETIME_NOT_POSITIVE'
  | 'LIFETIME_TOO_LONG'
  | 'EXPIRED'
  | 'PAYLOAD_INVALID'
  | 'RECEIPT_NOT_NULL'
  | 'FROM_NOT_SELF'
  | 'TO_INVALID_FORMAT'
  | 'FROM_MISMATCH'
  | 'TO_MISMATCH'

export interface ValidationOk {
  ok: true
  envelope: AgentEnvelope
}

export interface ValidationErr {
  ok: false
  reason: RejectReason
  detail: string
}

export type ValidationResult = ValidationOk | ValidationErr

export interface TimeContext {
  /** `rumor.created_at` —— 唯一时间基准，由调用方传入以支持可注入时钟。 */
  rumorCreatedAt: number
  /** 当前时间（秒）。单元测试注入固定值，避免随时间 flaky。 */
  now: number
}

function err(reason: RejectReason, detail: string): ValidationErr {
  return { ok: false, reason, detail }
}

function ok_(envelope: AgentEnvelope): ValidationOk {
  return { ok: true, envelope }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

/** 递归检查原型污染三剑客。在任何深层 key 上命中都拒绝。 */
function hasForbiddenKey(node: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (Array.isArray(node)) return node.some((x) => hasForbiddenKey(x, depth + 1))
  if (!isPlainObject(node)) return false
  for (const k of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(k)) return true
    if (hasForbiddenKey(node[k], depth + 1)) return true
  }
  return false
}

/**
 * 信封校验 —— **发送侧与接收侧共用同一个函数**（DECISIONS §6「接收方执行为准」）。
 *
 * 覆盖范围：结构、格式、大小、receipt、时间规则、按 type 的 payload 校验。
 * **不含**身份认证：那是 `verifyAuthenticity` 的事，只存在于接收侧。
 *
 * 入口是**原始 JSON 字符串**，因为 64KB 上限必须在解析之前按 UTF-8 字节数判定，
 * 原型污染键也必须在任何对象被使用之前拦下。
 */
export function validateEnvelope(raw: unknown, ctx: TimeContext): ValidationResult {
  if (typeof raw !== 'string') return err('NOT_STRING', '信封必须是字符串')
  if (raw === '') return err('EMPTY', '信封为空')

  const size = bytes(raw)
  if (size > MAX_ENVELOPE_BYTES) {
    return err('TOO_LARGE', `${size} 字节 > 上限 ${MAX_ENVELOPE_BYTES}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return err('INVALID_JSON', 'JSON 解析失败')
  }

  if (!isPlainObject(parsed)) return err('NOT_OBJECT', '信封必须是 JSON 对象')

  if (hasForbiddenKey(parsed)) {
    return err('UNSAFE_KEY', '检测到原型污染相关键名')
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      return err('UNKNOWN_TOP_LEVEL_FIELD', `未知顶层字段：${key}`)
    }
  }
  for (const key of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(key in parsed)) return err('MISSING_FIELD', `缺少必填字段：${key}`)
  }

  if (parsed['v'] !== 0) return err('INVALID_FIELD', `v 必须为 0，收到 ${String(parsed['v'])}`)

  const id = parsed['id']
  if (typeof id !== 'string' || !(ID_UUID_PATTERN.test(id) || ID_ULID_PATTERN.test(id))) {
    return err('INVALID_FIELD', 'id 必须是 UUID 或 ULID')
  }

  const type = parsed['type']
  if (type !== 'ping' && type !== 'pong' && type !== 'text') {
    return err('UNKNOWN_TYPE', `未知消息类型：${String(type)}`)
  }

  const from = parsed['from']
  if (typeof from !== 'string' || !PUBKEY_PATTERN.test(from)) {
    return err('INVALID_FIELD', 'from 必须是 64 位小写十六进制公钥')
  }

  const to = parsed['to']
  if (typeof to !== 'string' || !PUBKEY_PATTERN.test(to)) {
    return err('TO_INVALID_FORMAT', 'to 必须是 64 位小写十六进制公钥')
  }

  const receipt = parsed['receipt']
  if (receipt !== null && receipt !== undefined) {
    return err('RECEIPT_NOT_NULL', 'v0 中 receipt 必须为 null')
  }

  const expiresAt = parsed['expires_at']
  if (!isInteger(expiresAt)) return err('INVALID_FIELD', 'expires_at 必须是整数秒')

  const createdAt = ctx.rumorCreatedAt
  if (!isInteger(createdAt)) return err('INVALID_FIELD', 'created_at 必须是整数秒')

  const embedded = parsed['created_at']
  if (embedded !== undefined) {
    if (embedded !== createdAt) {
      return err('CREATED_AT_MISMATCH', '信封内 created_at 与 rumor.created_at 不一致')
    }
  }

  if (createdAt > ctx.now + MAX_FUTURE_SKEW_SECONDS) {
    return err('CLOCK_TOO_FUTURE', 'created_at 超前接收方时钟超过 10 分钟')
  }
  if (expiresAt <= createdAt) {
    return err('LIFETIME_NOT_POSITIVE', 'expires_at 必须晚于 created_at')
  }
  if (expiresAt - createdAt > MAX_LIFETIME_SECONDS) {
    return err('LIFETIME_TOO_LONG', '有效期超过 24 小时')
  }
  if (ctx.now >= expiresAt) {
    return err('EXPIRED', '消息已过期')
  }

  const session = parsed['session']
  if (session !== undefined) {
    if (typeof session !== 'string' || bytes(session) > MAX_SESSION_BYTES || !SESSION_PATTERN.test(session)) {
      return err('INVALID_FIELD', 'session 格式或长度不合法')
    }
  }

  const note = parsed['note']
  if (note !== undefined) {
    if (typeof note !== 'string' || bytes(note) > MAX_NOTE_BYTES) {
      return err('INVALID_FIELD', 'note 必须是字符串且不超过长度上限')
    }
  }

  const payload = parsed['payload']
  const payloadResult = validatePayload(type, payload)
  if (!payloadResult.ok) return payloadResult

  return ok_({
    v: 0,
    id,
    type,
    from,
    to,
    created_at: createdAt,
    expires_at: expiresAt,
    payload: payloadResult.payload,
    receipt: null,
    ...(typeof session === 'string' ? { session } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  })
}

type PayloadResult =
  | { ok: true; payload: EnvelopePayload }
  | { ok: false; reason: RejectReason; detail: string }

function validatePayload(type: EnvelopeType, payload: unknown): PayloadResult {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'PAYLOAD_INVALID', detail: 'payload 必须是对象' }
  }

  if (type === 'ping') {
    if (Object.keys(payload).length !== 0) {
      return { ok: false, reason: 'PAYLOAD_INVALID', detail: 'ping 的 payload 必须为空' }
    }
    return { ok: true, payload: { kind: 'ping' } }
  }

  if (type === 'pong') {
    const rid = payload['id']
    if (typeof rid !== 'string' || !(ID_UUID_PATTERN.test(rid) || ID_ULID_PATTERN.test(rid))) {
      return {
        ok: false,
        reason: 'PAYLOAD_INVALID',
        detail: 'pong 必须携带被回复 ping 的合法 id',
      }
    }
    return { ok: true, payload: { kind: 'pong', id: rid } }
  }

  const text = payload['text']
  if (typeof text !== 'string') {
    return { ok: false, reason: 'PAYLOAD_INVALID', detail: 'text 消息的 payload.text 必须是字符串' }
  }
  if (bytes(text) > MAX_TEXT_BYTES) {
    return { ok: false, reason: 'PAYLOAD_INVALID', detail: 'text 超过长度上限' }
  }
  return { ok: true, payload: { kind: 'text', text } }
}

/**
 * 身份认证 —— **仅存在于接收侧**。
 *
 * `unwrapEvent` 已验过 seal 签名并保证 `rumor.pubkey === seal.pubkey`，
 * 但它不认识信封里的 `from` / `to` 字段（DECISIONS 第一部分 E），
 * 因此这一步必须由我们自己补。
 */
export function verifyAuthenticity(
  envelope: AgentEnvelope,
  auth: { authenticatedSenderPubkey: string; ownPubkey: string },
): ValidationResult {
  if (envelope.from !== auth.authenticatedSenderPubkey) {
    return err('FROM_MISMATCH', 'from 与已验签的发送方公钥不一致')
  }
  if (envelope.to !== auth.ownPubkey) {
    return err('TO_MISMATCH', 'to 与本机公钥不一致')
  }
  return ok_(envelope)
}
