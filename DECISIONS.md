# DECISIONS.md — 技术决定与依据

> **上游：`SPEC.md` 是唯一事实来源；本文件只记录「为什么这么做」。**
> 第一部分是**可复现的实测事实**（含版本号、观测值、失败原因）；
> 第二部分是**在这些事实之上做出的决定**。
> 两件事分开写：事实会随依赖升级而变，决定是否要跟着变，取决于事实是否还成立。

---

# 第一部分 · 实测事实

> 全部于 2026-10-08 在本机实测。复现脚本：`/tmp/nakspike/probe*.mjs`。
> 里程碑 1 完成时，这些探针将改造为 `test/integration/` 下的回归测试。

## A. 环境与依赖

| 事实 | 观测值 |
|---|---|
| Node | v22.22.2 (arm64)；系统另有 v26.4.0 |
| 包管理 | pnpm 11.7.0 / npm 10.9.7 |
| Docker | CLI 29.8.0 存在，但 **daemon 未运行、未装 Docker Desktop**；`colima`/`lima` 已装 |
| `nostr-tools` | 2.25.2，**Unlicense**，含 `nip17.js` / `nip44.js` / `nip59.js`（带类型与测试声明） |
| `vitest` | 5.0.3，MIT |
| `ws` | 8.22.0，**MIT** |
| `typescript` | 7.0.2，Apache-2.0（dist-tag `latest`） |
| `nak` | 0.21.0，Unlicense，经 `brew install nak` 安装 |
| TypeScript | 7.0.2 实测可用（`tsc --noEmit` 通过；dist-tag 为 `latest`，但 7.x 是原生移植版，若在后续步骤出现兼容问题回退 5.x） |
| Vitest | 5.0.3 实测可用。**其 `InlineConfig` 已不再暴露 `pool` / `poolOptions`**，写成 sub-object 会触发 TS2769 |

#### 安装环节的环境坑

`pnpm install` 默认（`node-linker=isolated`）在本机失败：
`ERR_PNPM_CODEBUDDY_BROKER_DENY ... symlink '../../../@types+node@22.20.5/node_modules/@types/node'`。
改为 `.npmrc` 中 `node-linker=hoisted`（扁平化、不用符号链接）后 10 秒装完。
→ **`.npmrc` 必须随仓库提交**，否则换机器会重现该错误。

排除的候选：
- `hoytech/strfry` — **GPL-3.0**（730★，活跃）。强传染，不适合作为默认开发依赖
- `applesauce-relay` — MIT，但把 `nostr-tools` 钉在 `~2.19`，与我们要用的 2.25.2 冲突
- `@nostr-relay/core` — MIT，但 16★ 且 README 自称 WIP

## B. `nak serve` 作为本地中继的实测结果

| 考察项 | 结果 | 证据 |
|---|---|---|
| **持久化** | ❌ **不满足**。重启后事件全丢 | 发布 1 条 → 读到 1；杀进程重启 → 读到 0 |
| `since` 过滤 | ✅ 支持，但**语义是排他的**（`created_at > since`） | `since = ts[2]` 漏掉边界事件；`since = ts[2]-1` 才返回。`kind:1` 与 `kind:30079` 结论一致 |
| `p` 标签过滤 | ✅ 完全正确 | 预期 3 条、实得 3 条；与 `since` 组合也正确 |
| `until` 过滤 | ✅ 且是**包含的**（`<=`） | 边界事件正常返回 |
| **离线送达** | ✅ 无订阅者时投递，之后查询仍能取回 | 关键：**中继存活期内可用** |
| **中继只见密文** | ✅ 外层 kind 1059、仅一个 `p` 标签、`content` 为密文、外层 pubkey **不等于**发送方 | — |
| 自我声明 | `--help` 首句即 **"starts an in-memory relay for testing purposes"** | — |

> **注意 NIP-01 与 nak 的分歧**：NIP-01 规定 `since` 为包含语义（`>=`），nak 实现为排他（`>`）。
> 实测不通过 = lenient risk，因此后续任何逻辑都**不依赖 `since` 的边界精度**。

## C. 🔴 gift wrap 时间戳回溯窗口 = **48 小时**

`nostr-tools/lib/esm/nip59.js:232-234`：

```js
var TWO_DAYS = 2 * 24 * 60 * 60;
var now = () => Math.round(Date.now() / 1e3);
var randomNow = () => Math.round(now() - Math.random() * TWO_DAYS);
```

`createSeal` 与 `createWrap` 都调用 `randomNow()`，外层时间戳在 `(now-48h, now]` 上均匀分布。

- 实测一次偏移 **-157854 秒 ≈ -43.85 小时**
- **订阅若用 `since = now`，一条 gift wrap 都收不到**（实测 got = 0）
- `since = now - 172800`（48h）可以取到

## D. 🔴 多中继容错：`SimplePool` 会让进程崩溃

现象：向一个**不可达**中继 `publish`，Node 进程因 `RangeError: Maximum call stack size exceeded` 直接退出。

交叉验证矩阵：

| WebSocket 实现 | Node 22.22.2 | Node 26.4.0 |
|---|---|---|
| Node 内置（undici） | ❌ 爆栈退出 | ❌ 爆栈退出 |
| `ws` 包（注入） | ✅ 优雅降级 | ✅ 优雅降级 |

进一步：

- `enableReconnect: true/false` **均不能**避免崩溃
- **`SimplePool.publish` 对宕机中继谎报 `status: "fulfilled"`** —— 返回值不可信
- `SimplePool` 的构造函数签名被裁剪为只接受 `enablePing` / `enableReconnect`，**拿不到 `websocketImplementation`**
- `nostr-tools/pool` 虽导出全局 `useWebSocketImplementation(WS)`，注入后虽不再爆栈，但仍抛出**无法被 `Promise.allSettled` 捕获的 `ERR_UNHANDLED_REJECTION`**，进程依旧退出

**唯一实测可行的写法**：对每个中继独立
`AbstractRelay.connect(url, { verifyEvent, websocketImplementation: WS, timeout })` + `try/catch`。
此时宕机中继返回 `ok:false / "connection failed"`，存活中继照常投递，进程正常退出。

根因位置 `abstract-relay.js:271`（`index.js:970` 同类）：
`ws.onerror` 中 `reject("connection failed")` 后又 `this.ws.close()`，
进而触发 `ws.onclose` 再次 `reject(...)`；与 Node 内置 WebSocket 的错误传播叠加后爆栈。

## E. `nip59.unwrapEvent` 到底校验了什么 / 没校验什么

源码 `nip59.js:288-303`，逐条实测：

| 攻击 | 是否被 `unwrapEvent` 拦住 | 实测错误 |
|---|---|---|
| 篡改 wrap 密文（翻一个 base64 字符） | ✅ | MAC 校验失败（NIP-44 完整性） |
| 伪造 seal，rumor.pubkey ≠ seal.pubkey | ✅ | `rumor pubkey ... does not match seal pubkey` |
| 伪造 seal **签名** | ✅ | **`seal signature is invalid`** |
| **内层 JSON 声称 `from = A`，实际发送者是 C** | ❌ **放行** | 无 —— 缺的不是密码学，是 `from` 与已验签公钥的比对 |

**回答「unwrapEvent 是否校验 seal 签名」：校验。** 源码第 296 行 `if (!verifyEvent(seal))`，
实测亦证实。**因此不重复实现验签**（否则违反 SPEC §7 规则 1），但**必须加锁行为的回归测试**，
使依赖升级若移除该校验时能立即发现。

## F. 附带发现：`verifyEvent` 的缓存 Symbol 会被展开运算符复制

`finalizeEvent` 给事件对象打上内部 `verifiedSymbol = true`；`{ ...verifiedEvent }`
**会连 Symbol 一起复制**，随后 `verifyEvent(spread)` 直接命中缓存返回 `true` —— 即使 `sig` 已被改动。

实测：把 seal 的 `sig` 翻一位后 `{...seal}` → `verifyEvent` 返回 **true**；
但同一篡改体经 JSON 序列化/反序列化后（Symbol 丢失）→ 返回 false，`unwrapEvent` 正确拒绝。

> 实现约束：**不得用展开运算符复制事件对象后当作「已验证」使用。**

---

# 第二部分 · 决定及理由

## 1. 本地中继：`nak` 0.21.0（方案 B）

**决定**：采用 `nak serve`，**锁定 0.21.0**，不用 Docker。

**理由**：
- 三条硬性要求里，只有「持久化」不满足；而 **SPEC §9 的四条集成测试没有一条要求中继重启存活** ——
  「离线送达」考察的是「中继存活 + 接收方不在线」，实测通过
- `nak` 秒级启动、无状态、随手换随机端口，天然适合测试隔离；Docker 方案在本机当前不可用（无 daemon），
  改用 colima 会多一层 VM 不稳定因素
- `--help` 明示其为测试用中继，与我们的用途一致，不算误用

**代价与约束（强制）**：
- README 与本文档均注明：**内存中继、重启即丢、仅限开发测试**
- 测试夹具必须：随机端口、等待就绪、测完必关
- 由于 `since` 是排他语义，任何逻辑**不依赖 `since` 的边界精度**

## 2. `transport` 层：逐中继连接 + 薄接口

**决定**：
- 禁止使用 `SimplePool.publish(多地址)` 做多中继容错（依据 D）
- 每个中继独立 `AbstractRelay.connect(...)` + `try/catch`
- **以各中继的 OK 应答判定送达**：至少一个中继确认才算成功；无论如何都返回**每个中继的结果**
- `ws` 通过 `websocketImplementation` 注入（下限由 D 的矩阵给定）
- 以上全部封装在**薄接口**之后（如 `publishToRelays(urls, event) → RelayResult[]`），
  业务逻辑不直接触碰 nostr-tools

**理由**：崩溃是不可恢复的故障且会伪装成正常（谎报 fulfilled）；抑制住之后还要把
「哪个中继成功、哪个失败」如实上报，否则「一个不可用仍送达」这条验收无法被证明。

## 3. 新增依赖 `ws`（MIT）

**理由**：非功能性依赖，而是**规避 Node 内置 WebSocket 导致的进程崩溃**（见 D）。
MIT 许可，与项目 Apache-2.0 兼容。若未来 Node 修复其错误传播，可移除并记录。

## 4. `since` 回溯窗口 = 72 小时（常量 + 测试）

**理由**：C 给出硬上限 48h（实测最远 -43.85h）。取 **72h**＝48h × 1.5，留 50% 余量，
吸收时钟偏差与 nak 的排他语义误差。写成具名常量并配单元测试，防止被随手改成 `now`。

## 5. 去重表

**决定**：
- 键 = **`(from, id)` 复合键**（防止不同发送方的同名 `id` 互相误杀）
- **写入时机：仅在验签与信封校验全部通过之后**
- TTL = `min(expires_at, now + 24h) + 600s`
- 容量上限 **10,000** 条；**每发送方配额 512 条**（已确认）
- 配额按**插入顺序 FIFO** 淘汰：先退全局过期项，仍超限再退该发送方最旧条目
- 清理：惰性 —— 每次写入前清扫过期；**不起定时器**（定时器会让 CLI 进程无法退出）
- 存储：**纯内存，不落盘**

**理由**：
- TTL 上界超过 `expires_at` 之后无用 —— 过期消息会被过期检查直接拒绝
- `+600s` 吸收收发双方时钟偏差
- 24h 绝对上限防止发送方把 `expires_at` 设到一年后撑爆接收方
- **每发送方配额**：否则单一发送方可刷满全局容量挤掉他人条目，从而让别人的旧消息可被重放。
  配额把影响半径限制在该发送方自身（建议值 512 待确认）

**已知限制（必须写入 README 与 SPEC §7）**：
- 进程重启后去重表丢失，**中继上尚未过期的消息会被重复显示**
- **M3 引入收据/计量前必须改为持久化存储**（已记入路线）

## 6. 有效期与时间基准（接收方执行为准）

### 唯一时间基准

**决定**：以 **`rumor.created_at`** 作为消息时间的**唯一基准**。
信封 JSON **不再单独携带 `created_at`**；若保留该字段，则必须与之相等，**不等即拒绝**。

**理由（措辞修正）**：rumor 的时间戳**由发送方设置，并非不可伪造**。因此我们不把它当作
"可信时间"，而只把它确立为**唯一的时间来源**，从而避免"两个时间戳可以不一致、攻击者任选其一"
的歧义；**所有边界是否合法，一律由接收方校验**。

### 接收方校验（全部通过才进入业务逻辑）

1. `created_at` **不晚于**当前时间 **10 分钟**（拒绝来自未来的消息）
2. `expires_at` **晚于** `created_at`
3. `expires_at − created_at ≤ 24h`
4. 当前时间**未过** `expires_at`

**理由**：保证「去重保留期 ≥ 消息有效期」恒成立（对齐第 5 条的 24h 上界），
否则第 5 条「最多保留 24h」与「保留至消息过期」会互相矛盾。
时钟走可注入的 `now: () => number`，单元测试不依赖真实时间。

### 原则：接收方执行为准

**决定**：上述边界的强制执行方是**接收方**。发送方**复用同一个校验函数**做提前校验、快速失败，
但发送方的校验**不构成任何安全保障**。两侧各有一份测试。

**理由**：发送方的校验只是帮助本机尽早发现 bug（省一次网络往返与一条垃圾事件）；
真正的安全边界永远只能落在接收方 —— 发送方是不可信的，它的"我已经检查过了"没有意义。

## 7. `envelope` 层新增两项校验

**决定**：
- `from` 必须等于 **已验签的 seal 公钥**
- `to` 必须等于 **接收方自己的公钥**

**理由**：依据 E 最后一行 —— `unwrapEvent` 不认识信封里的 `from` 字段，
攻击者可构造「实际发送者 C、JSON 声称来自 A」的消息并顺利通过解封。
`to` 同理：中继投递由 `#p` 标签决定，但同一进程可能持多个身份，
必须确保消息确实是发给当前这个身份的（同时阻止「把别人的消息当自己的」）。

## 8. 配置与路径

**决定**：
- 基目录：`$AGENTNET_HOME`，否则 `~/.agentnet`
- `~/.agentnet/config.json`（0644）— `relays: string[]`
- `~/.agentnet/identity.key`（**0600**）— 私钥
- `~/.agentnet/data/`（**0700**）— 数据目录（M1 去重走内存，此目录先建占位）
- 环境变量：`AGENTNET_HOME`、`AGENTNET_RELAYS`（逗号分隔，优先级高于 config.json）、
  `AGENTNET_LOG_LEVEL`
- 优先级：CLI 参数 > 环境变量 > `config.json` > 内置默认

**理由**：不用 XDG —— `AGENTNET_HOME` 正是集成测试做状态隔离的钥匙（每个用例指向独立 tmpdir），
XDG 的三件套分目录会让隔离变复杂。

## 9. 私钥保护（强化）

**决定**：
- **私钥不得通过环境变量或命令行参数传入**（避免进程列表与子进程环境泄漏）
- 私钥文件**创建时即以 0600 打开**（`openSync(path, 'wx', 0o600)`），
  而非「先写后 chmod」—— 后者在写入与 chmod 之间存在可被读取的时间窗
- **加载时**先验准入再读内容：拒绝**符号链接**、拒绝**非当前用户所有**的文件、
  拒绝**权限过松**（组/其他位非零），任一条不满足即拒绝运行
- 取值一律用 **`lstatSync`**，不得用 `statSync`（后者跟随符号链接）
- 落盘后回读 `stat` 校验（`umask` 会削弱 mode 实参）
- 已有身份时 `init` **绝不覆盖**；**私钥一旦丢失无法找回**，README 必须写明

**实现注记**：`assertPrivateKeyFile` 做成接收"伪造 stat"的**纯函数** ——
「属主不是当前用户」这条在开发机上造不出来（需要 root），纯函数化后才有测试的入场券。

## 10. `ping` / `pong` 语义

**决定**：
- **只有 `ping` 触发自动回复**；`pong` 与 `text` **永不**触发自动回复
- `pong` 必须引用一个**未完成的 `ping`**，否则忽略（不产生「孤儿回应」）
- 按**发送方**限速：**每发送方 60 秒窗口内最多 10 次**自动回复（已确认）
- 另加**全局**上限：**60 秒窗口内跨所有发送方最多 100 次**自动回复（建议值，待确认）
- 超限静默丢弃；日志仅记公钥缩写 + 消息 ID，不记内容（SPEC §7 规则 6）

**理由**：防止 ping/pong 互触发造成的无限回环（SPEC §5 未写清，易踩）。
仅有按发送方限速时，单个对端仍可用 N 个身份同时打满配额 —— 因此需要再叠一层全局闸。

## 11. 项目元信息

- 项目名称：**agentnet**
- 许可证：**Apache-2.0**
- 里程碑 1 不使用任何真实资金或重要密钥，仅使用测试身份（SPEC §7 规则 3）

## 12. gift wrap 暴露收件人

**决定**：M1 **不修复**。
gift wrap 的 `p` 标签是明文的，中继虽读不懂内容，却能知道「谁收到了消息」。
作为已知限制 **L1** 登记于第 15 节，并写入 SPEC §7 与后续路线。

## 13. 依赖与工具链

**决定**：依赖全部**精确锁定**（不加 `^`/`~`）。

**理由**：本项目的多个决定直接绑定到被测行为的 exact 版本号
（`nostr-tools` 2.25.2 的 NIP-59 实现、`ws` 8.22.0 的崩溃规避、nak 0.21.0 的过滤行为）。
模糊版本会让「实测事实」悄悄失效而无人察觉。

### `.npmrc` 的 `node-linker=hoisted`（必须入库）

本机 `pnpm install` 在默认 `isolated` 链接器下失败：
`ERR_PNPM_CODEBUDDY_BROKER_DENY ... symlink '../../../@types+node@22.20.5/node_modules/@types/node'`
—— 这是**本机沙箱对符号链接的限制**，不是项目问题。
改为 `hoisted`（扁平化 `node_modules`，不用符号链接）后 10 秒装完。

→ **`.npmrc` 必须随仓库提交**，否则换一台机器会立刻重现该错误，且报错信息不会指向真正原因。

## 14. 实现约束：`verifiedSymbol` 陷阱

**约束**：**禁止用展开运算符复制已验签的事件对象**，也**不得**把 `{ ...event }` 的结果当作
「已验证」使用。

**依据**（第一部分 F）：`finalizeEvent` 给对象打上内部 `verifiedSymbol`，展开运算符**连 Symbol
一起复制**，随后 `verifyEvent` 直接命中缓存返回 `true` —— 即使 `sig` 已被改动。
同一篡改体若经 JSON 序列化（Symbol 丢失）则会被正确拒绝，可见这是个极其隐蔽的分叉。

**必须配套的测试**：「复制后篡改签名仍被拒绝」 —— 锁定该行为，防止有人图省事改写排 diff 逻辑时
把这个陷阱重新引入。

## 15. 已知限制（汇总，须同步写入 SPEC §7 与 README）

| # | 限制 | 处置 |
|---|---|---|
| L1 | **gift wrap 的 `p` 标签暴露收件人** —— 中继读不懂内容，但能画出"谁在跟谁通信" | M1 不修复；写入后续路线 |
| L2 | **去重表是纯内存的** —— 进程重启后，中继上尚未过期的消息会被**重复显示** | M1 接受；README 注明；**M3 引入收据/计量前必须改为持久化** |
| L3 | **多身份可绕过"按发送方"的限制** —— 单个对端持有 N 个公钥即可把每发送方配额放大 N 倍 | 已叠加全局上限（§10）缓解，但**不根治**；根治需信誉/成本门槛，超出 M1 范围 |
| L4 | `nak serve` **不持久化**（内存中继） | 仅开发测试用；README 与本文档均注明 |
