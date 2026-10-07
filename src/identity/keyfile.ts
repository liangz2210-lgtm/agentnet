/**
 * 私钥文件与数据目录的准入校验 —— **纯函数**，不触碰文件系统。
 *
 * 之所以做成纯函数：属主 uid、符号链接、以及"inode 是否被掉包"这几项
 * 在普通开发机上很难造出来（uid 那条需要 root），
 * 只有让校验逻辑可以接收"伪造的 stat"，测试才可能覆盖全部规则。
 *
 * 配套约束见 DECISIONS.md「私钥保护」：
 * 真实运行时一律对 **`fstatSync(fd)`** 的结果做校验 —— 先用 `openSync` 把 inode 钉住，
 * 再对 fd 校验，最后从 fd 读。**绝不能先 lstat 路径、再 readFileSync 路径**，
 * 那是两次独立的路径解析，校验的 inode 与读到的 inode 可以不是同一个（TOCTOU）。
 */

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyFileError'
  }
}

export class KeyDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyDirError'
  }
}

export interface FileStat {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  /** st_mode 完整值 */
  mode: number
  /** 属主 uid */
  uid: number
  /** 字节数，用于读取前的上限判断 */
  size: number
}

/** 私钥文件权限：仅属主可读写。 */
export const KEY_FILE_MODE = 0o600

/** 数据目录权限：仅属主可访问。 */
export const DIR_MODE = 0o700

/**
 * 私钥文件的读取上限。
 * 合法内容是 64 个十六进制字符 = 64 字节；留 4 倍余量吸收可能的 BOM/换行/空白。
 * **必须在 readFileSync 之前**用 `fstat.size` 判定，否则畸形大文件会先进内存。
 */
export const MAX_KEY_FILE_BYTES = 256

export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** 逐条检查私钥文件：任何一条不通过都抛 `KeyFileError`。 */
export function assertPrivateKeyFile(stat: FileStat, currentUid: number): void {
  if (stat.isSymbolicLink) {
    throw new KeyFileError('私钥文件不能是符号链接')
  }
  if (!stat.isFile) {
    throw new KeyFileError('私钥文件必须是普通文件（目录 / FIFO / 设备节点均拒绝）')
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
  if (stat.size > MAX_KEY_FILE_BYTES) {
    throw new KeyFileError(`私钥文件过大（${stat.size} 字节）`)
  }
}

/** 逐条检查数据目录：任何一条不通过都抛 `KeyDirError`。 */
export function assertPrivateDirectory(stat: FileStat, currentUid: number): void {
  if (stat.isSymbolicLink) {
    throw new KeyDirError('数据目录不能是符号链接')
  }
  if (!stat.isDirectory) {
    throw new KeyDirError('数据目录必须是目录')
  }
  if (stat.uid !== currentUid) {
    throw new KeyDirError('数据目录必须属于当前用户')
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new KeyDirError(
      `数据目录权限过松（${formatMode(stat.mode)}），组与其他用户不得有任何权限`,
    )
  }
}
