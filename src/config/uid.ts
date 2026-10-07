/**
 * `process.getuid` 在跨平台类型上是可选的 —— 而在无 uid 概念的系统上，
 * 本项目的 0600 权限模型（SPEC §7 规则 2）根本不成立，因此直接报错而非降级。
 *
 * 单独成文件的原因：路径守卫（`dirguard.ts`）与身份模块都要用它，
 * 而 `identity.ts` 又要依赖 `dirguard.ts` —— 放在任何一方都会形成循环引用。
 */
export function currentUid(): number {
  const getuid = process.getuid
  if (typeof getuid !== 'function') {
    throw new Error('当前平台不支持 uid 校验，无法安全使用私钥文件')
  }
  return getuid.call(process)
}
