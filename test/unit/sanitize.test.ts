import { describe, expect, it } from 'vitest'
import { sanitizeForLog, stripTerminalControls } from '../../src/envelope/sanitize'

describe('stripTerminalControls（打印前清洗）', () => {
  it('保留换行与制表符', () => {
    expect(stripTerminalControls('a\nb\tc')).toBe('a\nb\tc')
  })

  it('清除会改写终端的 ANSI 序列', () => {
    expect(stripTerminalControls('\u001B[2Jclear')).toBe('clear')
    expect(stripTerminalControls('\u001B[31mRED\u001B[0m')).toBe('RED')
    expect(stripTerminalControls('\u001B]0;pwned\u0007tail')).toBe('tail')
  })

  it('清除回车与其它 C0/C1 控制字符', () => {
    expect(stripTerminalControls('line1\rX')).toBe('line1X')
    expect(stripTerminalControls('a\u0000b')).toBe('ab')
    expect(stripTerminalControls('a\u0085b')).toBe('ab')
  })

  it('完整日志注入样例：标题改写 + 退格覆盖', () => {
    const evil = '\u001B]0;trusted\u0007amount=999\u0008\u0008\u0008refund'
    const clean = stripTerminalControls(evil)
    expect(clean).not.toContain('\u001B')
    expect(clean).not.toContain('\u0007')
    expect(clean).not.toContain('\u0008')
  })
})

describe('sanitizeForLog', () => {
  it('压平换行，避免伪造日志行', () => {
    expect(sanitizeForLog('a\nb\rc')).toBe('a b c')
  })

  it('截断到上限', () => {
    expect(sanitizeForLog('x'.repeat(500), 10)).toBe('x'.repeat(10))
  })
})
