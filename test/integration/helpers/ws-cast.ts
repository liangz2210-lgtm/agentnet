import WsPackage from 'ws'

/**
 * 把 `ws` 的类伪装成 nostr-tools 期待的 `typeof WebSocket`（undici 的全局类型）。
 *
 * 两者在运行时兼容 —— nostr-tools 只用到 `new WebSocket(url)`、`send`、`close` 等
 * 子集 —— 但 `@types/ws` 的声明缺 `dispatchEvent` 等成员，直接传会 TS2322。
 * 类型上的这个"谎"被关在这一个文件里（DECISIONS §3：注入 ws 是为绕开
 * Node 内置 WebSocket 的错误传播，见第一部分 D 的崩溃矩阵）。
 */
export function wsCast(): typeof WebSocket {
  return WsPackage as unknown as typeof WebSocket
}
