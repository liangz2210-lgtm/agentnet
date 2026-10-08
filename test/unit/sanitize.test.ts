import { describe, expect, it } from 'vitest'
import { sanitizeForDisplay, sanitizeForLog, stripTerminalControls } from '../../src/envelope/sanitize'

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

// ── v0.2 追加：双向 / 零宽 / 显示层截断 ─────────────────────────────

describe('v0.2 追加：双向与零宽字符', () => {
  it('剔除双向控制字符（U+202A–202E 与 U+2066–2069）', () => {
    const evil = 'a\u202Eevil\u202C\u2066right-to-left\u2069ok'
    const clean = stripTerminalControls(evil)
    expect(clean).toBe('aevilright-to-leftok')
  })

  it('剔除零宽字符（U+200B–200D、U+2060、U+FEFF）', () => {
    const evil = 'a\u200Bb\u200Cc\u200Dd\u2060e\ufefff'
    expect(stripTerminalControls(evil)).toBe('abcdef')
  })

  it('剔除单字符 CSI（U+009B，无 ESC 前缀的控制序列入口）', () => {
    expect(stripTerminalControls('a\u009B2Jb')).toBe('ab')
  })

  it('正常中英文与数字不受影响', () => {
    expect(stripTerminalControls('你好 hello 123!')).toBe('你好 hello 123!')
  })
})

describe('sanitizeForDisplay（显示层单行截断）', () => {
  it('短文本原样返回且不标记截断', () => {
    expect(sanitizeForDisplay('hello')).toEqual({ text: 'hello', truncated: false })
  })

  it('超长截断并注明"已截断"', () => {
    const { text, truncated } = sanitizeForDisplay('x'.repeat(3000), 2000)
    expect(truncated).toBe(true)
    expect(text.length).toBe(2000 + '…[已截断]'.length)
    expect(text.endsWith('…[已截断]')).toBe(true)
  })

  it('换行压成空格（单行显示），转义序列被清洗', () => {
    const { text } = sanitizeForDisplay('a\r\nb\u001B[2Jc')
    expect(text).toBe('a bc')
  })
})
