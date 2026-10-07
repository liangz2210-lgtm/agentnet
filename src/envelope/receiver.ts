/**
 * 接收侧入口。
 *
 * 接收是整个校验链的**唯一权威落点**（DECISIONS §6「接收方执行为准」）：
 *
 *   rumor.content ──▶ validateEnvelope（共用）──▶ verifyAuthenticity（仅接收侧）
 *                                                   └─ from === 已验签的 seal 公钥
 *                                                      to   === 本机公钥
 *
 * 顺序不能颠倒：先做结构与时间校验，再做身份比对。
 */
export { validateEnvelope, verifyAuthenticity } from './validate'
export type { ValidationResult, RejectReason, AgentEnvelope } from './validate'
