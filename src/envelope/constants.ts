/**
 * 信封相关的全部魔法数字与约束。
 *
 * 集中放在这里，是为了让「凭什么取这个值」的答案只有一份。
 * 标了 ⚠️ 的是**没有数据支撑的防御性取值**，观测到误杀时优先调它们。
 */

/** 载荷总大小上限（UTF-8 字节），SPEC §5。 */
export const MAX_ENVELOPE_BYTES = 65_536

/** 消息有效期上限，DECISIONS §6 —— 与去重保留期对齐。 */
export const MAX_LIFETIME_SECONDS = 24 * 60 * 60

/** created_at 允许超前于接收方时钟的上限。 */
export const MAX_FUTURE_SKEW_SECONDS = 600

/** 默认有效期：发送方未显式指定时使用，SPEC §5。 */
export const DEFAULT_LIFETIME_SECONDS = 60 * 60

/** 自动回复限速窗口。 */
export const RATE_LIMIT_WINDOW_SECONDS = 60

/** 单个发送方在一个窗口内的自动回复上限。 */
export const MAX_AUTO_REPLIES_PER_SENDER = 10

/**
 * 跨所有发送方在一个窗口内的自动回复总上限。
 * ⚠️ **取 100 没有任何数据支撑，纯粹是防御性取值** —— 未做压测、未估算正常流量。
 * DECISIONS §10、已知限制 L3a。
 */
export const MAX_AUTO_REPLIES_GLOBAL = 100

/** `text` 载荷的内容长度上限（UTF-8 字节）。⚠️ 防御性取值，非 SPEC 规定。 */
export const MAX_TEXT_BYTES = 8_192

/** `note` 字段长度上限（UTF-8 字节，不可信字段）。⚠️ 防御性取值。 */
export const MAX_NOTE_BYTES = 1_024

/** `session` 字段长度上限（字节）。⚠️ 防御性取值。 */
export const MAX_SESSION_BYTES = 64

/** 公钥：64 位**小写**十六进制。 */
export const PUBKEY_PATTERN = /^[0-9a-f]{64}$/

/** 消息 id：仅接受 UUID（小写带连字符）或 ULID（26 位 Crockford Base32）两种形态。 */
export const ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const ID_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** session 允许字符集。 */
export const SESSION_PATTERN = /^[A-Za-z0-9_-]+$/

/** 原型污染的三种危险键名。 */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** v0 允许的顶层字段。出现集合外的键一律拒绝。 */
export const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'v',
  'id',
  'type',
  'from',
  'to',
  'expires_at',
  'payload',
  'session',
  'note',
  'receipt',
  'created_at',
])

/**
 * 必填字段。注意 `created_at` **不在其中** —— DECISIONS §6 规定以
 * `rumor.created_at` 为唯一时间基准，信封里不再单独携带它；
 * 若仍出现则必须与之一致。
 */
export const REQUIRED_TOP_LEVEL_FIELDS = [
  'v',
  'id',
  'type',
  'from',
  'to',
  'expires_at',
  'payload',
  'receipt',
] as const
