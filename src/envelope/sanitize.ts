/**
 * 打印前清洗 —— 消息内容一律视为**不可信数据**（SPEC §5）。
 *
 * 终端不只会执行换行：`ESC[2J` 清屏、`ESC]0;...BEL` 改写标题、
 * `\r` 把光标退回行首覆盖已打印的内容。日志注入的老套路就是靠这些
 * 让终端显示与实际不一致。
 *
 * v0.2 追加（SPEC §7 规则 5 的显示侧强化）：
 * - **双向控制字符**（U+202A–202E、U+2066–2069）：能在终端里把
 *   "命令"和"参数"的视觉顺序颠倒（Trojan Source 的终端版）
 * - **零宽字符**（U+200B–200D、U+2060、U+FEFF）：肉眼不可见，
 *   可用于绕过人工审阅或拼出"看不见的第二条消息"
 * - C0/C1 全段剔除（含 0x9B —— 单字符 CSI，不需 ESC 前缀就能发控制序列）
 */

const CONTROL_CLASS = '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F'

/** ESC 及紧随其后的一条转义序列（CSI / OSC / 单字符序列）。 */
const ESCAPE_SEQUENCE = new RegExp(`\\u001B(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)|[^\\u001B])`, 'g')

/**
 * **单字符 CSI（U+009B）** 及其后的整条序列。
 * 它等价于 `ESC [` 但不需要 ESC 前缀 —— 只把 U+009B 这一个字符删掉是不够的，
 * 后面的 `2J`（清屏）会作为明文留在终端里。先按整条序列吞掉，
 * 剩下的孤立 U+009B 再由 STRAY_CONTROL 兜底。
 */
const C1_CSI_SEQUENCE = /\u009B[0-9;?]*[ -/]*[@-~]/g

const STRAY_CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'g')

/** 双向控制字符：U+202A–202E（LRE/RLE/PDF/LRO/RLO）与 U+2066–2069（LRI/RLI/FSI/PDI）。 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g

/** 零宽与不可见格式字符：U+200B–200D、U+2060、U+FEFF。 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g

/** 保留换行与制表符，去掉其余控制字符与转义序列。 */
export function stripTerminalControls(input: string): string {
  return input
    .replace(ESCAPE_SEQUENCE, '')
    .replace(C1_CSI_SEQUENCE, '')
    .replace(BIDI_CONTROLS, '')
    .replace(ZERO_WIDTH, '')
    .replace(STRAY_CONTROL, '')
}

/** 日志专用：先压成单行再清洗，避免 `\r` / `\n` 伪造日志行。 */
export function sanitizeForLog(input: string, maxLength = 120): string {
  const flat = input.replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ')
  return stripTerminalControls(flat).slice(0, maxLength)
}

/** listen 显示单行的长度上限（防御性取值，无数据支撑）。 */
export const MAX_DISPLAY_LINE_LENGTH = 2000

/**
 * 显示层清洗：清洗 + 压成单行 + 超长截断并**注明截断**。
 * 截断必须可见 —— "看起来完整的一行"和"被截断的一行"对审阅者意义完全不同。
 */
export function sanitizeForDisplay(
  input: string,
  maxLength = MAX_DISPLAY_LINE_LENGTH,
): { text: string; truncated: boolean } {
  const flat = stripTerminalControls(input).replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ')
  if (flat.length <= maxLength) return { text: flat, truncated: false }
  return { text: flat.slice(0, maxLength) + '…[已截断]', truncated: true }
}
