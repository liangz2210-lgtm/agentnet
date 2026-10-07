/**
 * 打印前清洗 —— 消息内容一律视为**不可信数据**（SPEC §5）。
 *
 * 终端不只会执行换行：`ESC[2J` 清屏、`ESC]0;...BEL` 改写标题、
 * `\r` 把光标退回行首覆盖已打印的内容。日志注入的老套路就是靠这些
 * 让终端显示与实际不一致。
 */

const CONTROL_CLASS = '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F'

/** ESC 及紧随其后的一条转义序列（CSI / OSC / 单字符序列）。 */
const ESCAPE_SEQUENCE = new RegExp(`\\u001B(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)|[^\\u001B])`, 'g')

const STRAY_CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'g')

/** 保留换行与制表符，去掉其余控制字符与转义序列。 */
export function stripTerminalControls(input: string): string {
  return input.replace(ESCAPE_SEQUENCE, '').replace(STRAY_CONTROL, '')
}

/** 日志专用：先压成单行再清洗，避免 `\r` / `\n` 伪造日志行。 */
export function sanitizeForLog(input: string, maxLength = 120): string {
  const flat = input.replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ')
  return stripTerminalControls(flat).slice(0, maxLength)
}
