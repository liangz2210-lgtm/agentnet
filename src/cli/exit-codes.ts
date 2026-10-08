/**
 * CLI 退出码（用户定稿，写入 DECISIONS §8）：
 *
 *   0  成功
 *   1  其他错误
 *   2  用法错误（参数缺失/格式不对/未知选项）
 *   3  没有身份（未 init 或私钥不可用）
 *   4  发送未被任何中继确认
 *   5  ping 超时
 */
export const EXIT_OK = 0
export const EXIT_OTHER = 1
export const EXIT_USAGE = 2
export const EXIT_NO_IDENTITY = 3
export const EXIT_SEND_UNCONFIRMED = 4
export const EXIT_PING_TIMEOUT = 5
