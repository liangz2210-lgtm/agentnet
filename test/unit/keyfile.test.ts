import { describe, expect, it } from 'vitest'
import {
  KEY_FILE_MODE,
  KeyFileError,
  assertPrivateKeyFile,
  formatMode,
} from '../../src/identity/keyfile'
import type { FileStat } from '../../src/identity/keyfile'

const MY_UID = 501
const OTHER_UID = 502

function stat(over: Partial<FileStat> = {}): FileStat {
  return {
    isFile: true,
    isSymbolicLink: false,
    mode: KEY_FILE_MODE,
    uid: MY_UID,
    size: 64,
    isDirectory: false,
    ...over,
  }
}

describe('assertPrivateKeyFile（纯函数，可接收伪造 stat）', () => {
  it('放行：普通文件 / 0600 / 属当前用户', () => {
    expect(() => assertPrivateKeyFile(stat(), MY_UID)).not.toThrow()
  })

  it('拒绝：符号链接', () => {
    expect(() => assertPrivateKeyFile(stat({ isSymbolicLink: true }), MY_UID)).toThrow(
      KeyFileError,
    )
  })

  it('拒绝：不是普通文件（例如目录）', () => {
    expect(() =>
      assertPrivateKeyFile(stat({ isFile: false, mode: 0o40700 }), MY_UID),
    ).toThrow(/必须是普通文件/)
  })

  it('拒绝：属主不是当前用户', () => {
    // 这条在普通开发机上造不出来（需要 root），纯函数化后才可测。
    expect(() => assertPrivateKeyFile(stat({ uid: OTHER_UID }), MY_UID)).toThrow(
      /必须属于当前用户/,
    )
  })

  it('拒绝：权限过松（0644）', () => {
    expect(() => assertPrivateKeyFile(stat({ mode: 0o644 }), MY_UID)).toThrow(
      /权限过松/,
    )
  })

  it('拒绝：属主不可读（0000）', () => {
    expect(() => assertPrivateKeyFile(stat({ mode: 0o000 }), MY_UID)).toThrow(
      /不可读/,
    )
  })

  it('formatMode 输出三位八进制', () => {
    expect(formatMode(0o100600)).toBe('600')
    expect(formatMode(0o100644)).toBe('644')
  })
})
