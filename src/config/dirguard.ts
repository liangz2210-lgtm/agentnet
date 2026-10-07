/**
 * 基目录的**真实路径解析 + 逐层祖先检查**（二轮审计 A1 / A2 的处置）。
 *
 * 背景：私钥文件本身已经做到「fd 直通 + `O_NOFOLLOW`」，但那两项只作用于
 * **路径的最后一段**。若基目录的任一祖先被换成一个指向别处的符号链接，
 * 或者某个祖先对他人可写（他人可把整段路径替换成自己的目录），
 * 那么最后一段查得再严也毫无意义 —— 整条路径的语义已经被平移了。
 *
 * 处置：
 * 1. **解析一次**真实路径（`realpathSync`），此后全程只使用这个真实路径，
 *    不再对配置值做第二次解析；
 * 2. 从 `/` 起**逐层**检查每一级祖先：是目录、非符号链接、
 *    属主为当前用户或 root、组与其他用户不可写；
 * 3. 基目录**不得直接位于带 sticky 位的共享可写目录下**（`/tmp` 即 `1777`）——
 *    这类目录里任何人都能抢先建出同名目录。
 *
 * ⚠️ 残余窗口（已知限制 L8）：`realpath` 与随后的 `lstat` 之间仍存在竞态，
 * 彻底消除需要 `openat(2)` 逐级打开 —— Node 未导出该 API，且不引入原生绑定。
 * 见 DECISIONS §9 与路线图。
 */

import { lstatSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { baseDir, type Env } from './paths'
import { currentUid } from './uid'

export class InsecureBaseDirError extends Error {
  constructor(reason: string, path: string) {
    super(`数据目录路径不安全（${reason}）：${path}`)
    this.name = 'InsecureBaseDirError'
  }
}

export interface ResolvedBaseDir {
  /** 真实路径（符号链接已全部解析）。此后全程使用这个值。 */
  real: string
  /** 基目录当前是否已存在。不存在时由调用方决定是否创建。 */
  exists: boolean
}

function errnoOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'UNKNOWN'
}

/**
 * 解析**一次**真实路径。
 *
 * 基目录尚不存在时逐级向上找到最近的已存在祖先，对**它**做 realpath，
 * 再把待创建的路径段拼回去 —— 这样连"尚未创建的那几层"也落在真实路径下，
 * 不会出现「上半段真实、下半段仍可能被符号链接劫持」的混合路径。
 */
export function resolveRealBaseDir(env: Env = process.env): ResolvedBaseDir {
  const configured = baseDir(env)

  try {
    return { real: realpathSync(configured), exists: true }
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') {
      // 不泄露裸 errno（A7）：只说无法解析，不给攻击者额外的文件系统信息。
      throw new InsecureBaseDirError('无法解析该路径', configured)
    }
  }

  const pending: string[] = []
  let probe = configured
  for (;;) {
    const parent = dirname(probe)
    if (parent === probe) {
      throw new InsecureBaseDirError('向上直至文件系统根都找不到可用祖先', configured)
    }
    pending.unshift(basename(probe))
    probe = parent
    try {
      return { real: join(realpathSync(probe), ...pending), exists: false }
    } catch (err) {
      if (errnoOf(err) !== 'ENOENT') {
        throw new InsecureBaseDirError('无法解析该路径', configured)
      }
    }
  }
}

/**
 * 逐层检查祖先目录（含基目录自身，若已存在）。
 *
 * 尚未创建的层（ENOENT）跳过 —— 它们会由调用方以 `DIR_MODE` 创建，
 * 创建后再经 `assertPrivateDirectory` 复核。
 */
export function assertAncestrySafe(realDir: string, uid: number = currentUid()): void {
  // 基目录的直接父目录：sticky + 世界可写 ⇒ 任何人都能在这里抢建同名目录。
  const parent = dirname(realDir)
  let parentStat: Stats
  try {
    parentStat = lstatSync(parent)
  } catch {
    throw new InsecureBaseDirError('父目录无法访问', parent)
  }
  if (parentStat.isSymbolicLink()) {
    throw new InsecureBaseDirError('父目录是符号链接', parent)
  }
  if ((parentStat.mode & 0o1000) !== 0 && (parentStat.mode & 0o002) !== 0) {
    throw new InsecureBaseDirError('不得直接位于带 sticky 位的共享可写目录下', parent)
  }

  let layer = ''
  for (const part of realDir.split(sep).filter((s) => s !== '')) {
    layer = `${layer}${sep}${part}`
    let st: Stats
    try {
      st = lstatSync(layer)
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') continue
      throw new InsecureBaseDirError('该层无法访问', layer)
    }
    if (st.isSymbolicLink()) throw new InsecureBaseDirError('该层是符号链接', layer)
    if (!st.isDirectory()) throw new InsecureBaseDirError('该层不是目录', layer)
    if (st.uid !== uid && st.uid !== 0) {
      throw new InsecureBaseDirError('该层属主既不是当前用户也不是 root', layer)
    }
    if ((st.mode & 0o022) !== 0) {
      throw new InsecureBaseDirError('该层对组或其他用户可写', layer)
    }
  }
}
