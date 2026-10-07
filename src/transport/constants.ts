/**
 * 传输层的全部数值上限。
 *
 * ⚠️ 除了 72h 回溯窗口（有 NIP-59 实测依据，见 DECISIONS §4），
 * 其余全部是**无数据支撑的防御性取值**：既没做过压测也没估算过正常流量。
 * 观测到误杀时优先调这些常量，而不是改结构。
 */

/** 订阅回溯窗口：gift wrap 时间戳随机回溯 0~48h（NIP-59 实测硬上限），取 72h = 48h × 1.5。 */
export const SUBSCRIPTION_LOOKBACK_SECONDS = 3 * 24 * 60 * 60

/** 中继连接数上限（含已连接与连接中的）。 */
export const MAX_RELAY_CONNECTIONS = 16

/** 单次订阅（至 EOSE）处理的事件数上限；超出部分丢弃并计数。 */
export const MAX_EVENTS_PER_SUBSCRIPTION = 5000

/** 单连接入站速率：窗口长度。 */
export const INCOMING_RATE_WINDOW_MS = 60_000

/** 单连接入站速率：窗口内事件数上限。 */
export const MAX_EVENTS_PER_CONNECTION_PER_WINDOW = 600

/** 重连退避：起始延迟。 */
export const RECONNECT_BASE_DELAY_MS = 1_000

/** 重连退避：延迟上限。 */
export const RECONNECT_MAX_DELAY_MS = 30_000

/** 重连退避：连续失败多少次后放弃该中继（进程存活期间不再自动重连）。 */
export const RECONNECT_MAX_ATTEMPTS = 6

/** 建立单条中继连接的超时。 */
export const CONNECT_TIMEOUT_MS = 10_000

/** 等待中继 OK 应答的超时（nostr-tools 内部默认 publishTimeout 之上再兜一层）。 */
export const PUBLISH_TIMEOUT_MS = 15_000

/**
 * 解封**之前**对 gift wrap 密文长度的粗检（防畸形大包先进解密器）。
 *
 * ⚠️ 不能设成 64KB：密文要过两层 NIP-44（rumor→seal→wrap），每层都有
 * padding（按 2 的幂分块）+ base64（×4/3）膨胀，实测 65KB 的明文封出来
 * 约 153KB。上限必须大于"64KB 明文封出来的密文长度"，否则第 1 步会
 * 抢在第 3 步的 64KB 信封检查之前生效，两级检查变成一级。取 256KB。
 */
export const MAX_GIFT_WRAP_CONTENT_BYTES = 256 * 1024
