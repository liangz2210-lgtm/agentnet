import WebSocketPackage from 'ws'

/**
 * 把 `ws` 的类伪装成 nostr-tools 期待的 `typeof WebSocket`（undici 全局类型）。
 *
 * 运行时兼容 —— nostr-tools 只用 `new WebSocket(url)`、`send`、`close` 等子集 ——
 * 但 `@types/ws` 的声明缺 `dispatchEvent` 等成员。类型上的"谎"关在这一个文件里。
 * 注入 `ws` 的原因见 DECISIONS 第一部分 D（Node 内置 WebSocket 会爆栈）。
 */
export function wsImplementation(): typeof WebSocket {
  return WebSocketPackage as unknown as typeof WebSocket
}
