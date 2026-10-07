/**
 * 私钥文件的准入校验 —— **纯函数**，不触碰文件系统。
 *
 * 之所以做成纯函数：所有者 uid、是否为符号链接、权限位这三项里有两项
 * （uid 不匹配、符号链接）在普通开发机上很难造出来
 * （前者需要 root，后者依赖 umask 之外的东西），
 * 只有让校验逻辑可以接收"伪造的 stat"，测试才可能覆盖全部规则。
 *
 * 与之配套的实现约束见 DECISIONS.md「私钥保护」：
 * 真实运行时必须以 `lstatSync` 取值，**不得用 `statSync`**（后者会跟随符号链接）。
 */

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyFileError'
  }
}

export interface KeyFileStat {
  isFile: boolean
  isSymbolicLink: boolean
  /** st_mode 的完整值 */
  mode: number
  /** 文件属主 uid */
  uid: number
}

/** 私钥文件权限：仅属主可读写。 */
export const KEY_FILE_MODE = 0o600

export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** 逐条准入检查：任何一条不通过都抛 `KeyFileError`。 */
export function assertPrivateKeyFile(stat: KeyFileStat, currentUid: number): void {
  if (stat.isSymbolicLink) {
    throw new KeyFileError('私钥文件不能是符号链接')
  }
  if (!stat.isFile) {
    throw new KeyFileError('私钥文件必须是普通文件')
  }
  if (stat.uid !== currentUid) {
    throw new KeyFileError('私钥文件必须属于当前用户')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new KeyFileError(
      `私钥文件权限过松（${formatMode(stat.mode)}），组与其他用户不得有任何权限`,
    )
  }
  if ((stat.mode & 0o400) === 0) {
    throw new KeyFileError('私钥文件对当前用户不可读')
  }
}
