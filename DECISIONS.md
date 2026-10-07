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

## 0. 威胁模型（先划边界，再谈防线）

> **本文件后续每一条"安全"决定，都只在这个边界内成立。** 边界不清，防线就是对牛弹琴。

### 范围内：其他 uid 的本地进程 / 其他本地用户

能力假设：可以在文件系统上创建、删除、改名任意它有权操作的路径；可以读它有权读的文件；
可以把自己的目录改成任意权限；**但无法**改写别的进程的内存、无法绕过内核的权限检查、
无法以 root 身份行事。

典型攻击形态（本项目的防线都是针对它们设计的）：

| 攻击 | 防线 |
|---|---|
| 把 `identity.key` 换成符号链接，指向攻击者可读的文件 | `O_NOFOLLOW` + fd 直通（§9） |
| 把基目录**的某一级祖先**换成符号链接，整体平移路径语义 | `realpath` 解析一次 + 逐层祖先检查（§9 / A1、A2） |
| 把某级祖先改成对他人可写，随后替换整段路径 | 逐层检查"组与其他不可写"（§9 / A2） |
| 抢先在共享可写目录（`/tmp`）里建出同名目录 | 禁止基目录直接位于 sticky 共享目录下（§9 / A2） |
| 让 `init` 写到一半失败，留下卡死用户的残留文件 | 先 `ftruncate` 再 `unlink`，失败显式上报（§9 / A3） |

### 范围外：我们**不**防

| 不在范围内的对手 | 为什么不防 |
|---|---|
| **以同一 uid 运行的恶意程序** | 它能直接 `open` 私钥文件、能 `ptrace` 本进程、能改写自己的 `HOME`。文件权限模型的主语是 **uid 而不是进程**，在此全部失效 |
| **root** | 同上，且更强 —— root 不受任何 uid / 权限位约束 |

**这条边界反过来约束两件事**：

1. 「私钥在内存里不清零」（L6）在同一 uid 的对手面前**本来就没有意义**。
   所以不做假装有效的加固，只登记为已知限制。
2. 反过来说，**凡是范围内的攻击必须真被挡住**，不许拿"反正同 uid 也能拿到"搪塞 ——
   那等于把边界偷偷挪了，让 §9 的一堆检查变成装饰。

### 关于断言的纪律

本文档中凡是「某物不存在 / 某行为不会发生」的断言，**一律附实测命令**（回查表见第 18 节）。
理由：首轮审计曾断言「Node 未导出 `O_NOFOLLOW`」，**本机实测为假**（值为 256）。
一条没被实测过的否定性断言，和一条错误的决定没有区别 —— 而错误的决定会让人**删掉**真正有用的防线。

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
- ⚠️ 默认路径中的家目录取 **`os.userInfo().homedir`**，**不是** `os.homedir()`（A5）。
  实测：把 `$HOME` 改成 `/tmp/FAKEHOME-TEST` 后 `os.homedir()` 立即变成该值，
  而 `os.userInfo().homedir` 仍是真实的 `/Users/yao`。
  `AGENTNET_HOME` 未设置时，家目录是私钥落盘位置的**唯一依据**，不能受环境变量摆布。
  实测命令见第 18 节
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
- 读写一律 **fd 直通**：`openSync` → `fstatSync(fd)` → 从 fd 读。
  **绝不**先 `lstat` 路径校验、再 `readFileSync` 路径读取 —— 那是两次独立的路径解析，
  校验的 inode 与读到的 inode 可以不是同一个（TOCTOU）
- **`fs.constants.O_NOFOLLOW` 在本机存在且生效**（实测：Node 22.22.2 / 26.4.0 均为
  `256 / 0o400`，带它打开符号链接返回 `ELOOP`）。
  ⚠️ **修正审计结论**：审计员称"Node 未导出 `O_NOFOLLOW`" —— 该说法在本机**不成立**。
  实现做特性检测：有则用它，无则比对 `fstat(fd)` 与 `lstat(路径)` 的 `dev`/`ino`
- 打开时带 `O_NONBLOCK` —— 只读打开一个无写端的 FIFO 会**永久阻塞**
  （实测：不带该标志的对照组 4 秒超时被杀，带上后 2ms 打开；命令见第 18 节）；
  带上它则 open 立即返回，随后由 fstat 发现"不是普通文件"而拒绝
- 读取前按 `fstat.size` 判上限（256 字节），**在读之前**，不在读之后
- 数据目录同样准入：目录、非符号链接、属主为当前用户、组与其他位为零。
  **拒绝**而非自动 chmod —— 静默改动用户目录权限是更糟的惊喜
- `AGENTNET_HOME` 必须绝对路径、无 NUL、无 `.`/`..` 段、**不得为 `/`**（A4）
  - **移除原先"规范化后必须与原值一致"的检查**：尾随分隔符与多余斜杠**不改变目标位置**，
    那条检查挡不住任何攻击，却会拒绝合法输入。"这个位置安不安全"由下面的真实路径 +
    逐层祖先检查回答，而不是靠字符串形态
- **祖先路径段同样要检查**（A1 / A2，原先是缺口）：
  - **`realpath` 解析一次，此后全程只使用这个真实路径**，不再对配置值做第二次解析。
    基目录尚不存在时，向上找到最近的已存在祖先、对**它**做 realpath，
    再把待创建的段拼回去 —— 避免出现"上半段真实、下半段可被劫持"的混合路径
  - 该解析**抓到了一个 `lstat` 完全看不见的事实**：macOS 上 `/var` 是 `/private/var`
    的符号链接（实测见第 18 节）。也就是说 `os.tmpdir()` 返回的路径**本身含符号链接**，
    只做 `lstat` 的最后一段检查，等于什么都没查
  - 从 `/` 起**逐层**检查每一级：是目录、非符号链接、属主为当前用户或 root、
    组与其他用户不可写
  - 基目录**不得直接位于带 sticky 位的共享可写目录下**（`/tmp` → `/private/tmp`，实测 `1777`）：
    这类目录里任何人都能抢先建出同名目录
  - **不引入原生绑定**（无 `openat(2)`）：残余的 TOCTOU 窗口登记为 **L8**，
    "接入真实资金前再评估 openat 方案"写入路线（第 19 节）
- **私钥不得通过环境变量或命令行参数传入**（避免进程列表与子进程环境泄漏）
- 私钥文件**创建时即以 0600 打开**（`openSync(path, 'wx', 0o600)`），
  而非「先写后 chmod」—— 后者在写入与 chmod 之间存在可被读取的时间窗
- **加载时**先验准入再读内容：拒绝**符号链接**、拒绝**非当前用户所有**的文件、
  拒绝**权限过松**（组/其他位非零），任一条不满足即拒绝运行
- 取值一律用 **`lstatSync`**，不得用 `statSync`（后者跟随符号链接）
- 落盘后回读 `stat` 校验（`umask` 会削弱 mode 实参）
- 已有身份时 `init` **绝不覆盖**，且**不提供 `--force`** ——
  提示用户手动备份（`cp -p`）或移走文件后再重试。
  唯一应该由人来做决定的是"要不要丢掉一个身份"，这个开关不该被程序抢走
- **写入失败必须清场**（A3，顺序有讲究）：
  1. 先 **`ftruncate(fd, 0)`** —— 即便随后 `unlink` 失败，磁盘上也不该残留私钥字节
  2. 再 `closeSync(fd)`、再 `unlinkSync(target)`
  3. **`unlink` 失败必须显式上报**：抛 `IdentityCleanupError`，消息里给出
     **残留文件的完整路径**、原始失败原因、以及手动处置步骤
     （`cp -p` 先备份 → `mv` 再移走 → 重新 `init`）
  否则会留下一个"存在但不可用、又因 `wx` 挡住重建"的半成品，把用户永久卡死。
  **程序不自动删除**：删掉什么只能由人决定（与"不提供 `--force`"同一条原则）
- **基目录不存在 ⇒ 视同身份不存在**（A6）：抛 `IdentityMissingError`，
  照常引导首次运行，而不是抛一个"目录错误"。**加载路径绝不建目录** ——
  否则"身份不存在"这个事实会被自己抹掉
- **错误分类代替裸 errno**（A7）：`ENOENT`→`IdentityMissingError`、
  `ELOOP`→`IdentitySymlinkError`、`EACCES`/`EPERM`→`IdentityPermissionError`、
  其余→`IdentityAccessError`（**消息里不含 errno**）。
  errno 只用于 **switch 分支判断**，绝不拼进消息 ——
  "这条路径是 ENOENT 还是 EACCES"本身就是向攻击者泄漏的文件系统信息
- **`fstat`/`lstat` 的 dev/ino 回退分支仅用于无 `O_NOFOLLOW` 的平台**（A8 / A9）。
  **本机实测两个 Node 版本都存在该常量（值 256），此分支在本机永远不执行** ——
  它的覆盖率不应被当作防线（登记为 **L9**）
- **私钥一旦丢失无法找回**，README 必须写明

**实现注记**：`assertPrivateKeyFile` 做成接收"伪造 stat"的**纯函数** ——
「属主不是当前用户」这条在开发机上造不出来（需要 root），纯函数化后才有测试的入场券。

## 10. `ping` / `pong` 语义

**决定**：
- **只有 `ping` 触发自动回复**；`pong` 与 `text` **永不**触发自动回复
- `pong` 必须引用一个**未完成的 `ping`**，否则忽略（不产生「孤儿回应」）
- 按**发送方**限速：**每发送方 60 秒窗口内最多 10 次**自动回复（已确认）
- 另加**全局**上限：**60 秒窗口内跨所有发送方最多 100 次**自动回复（已确认，**做成可配置常量**）
  - ⚠️ **该 100 这个值没有任何数据支撑，纯属防御性取值**，
    既未做过压测也未估算过正常流量。若将来观测到误杀，优先调整此常量。
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
作为已知限制 **L1** 登记于第 17 节，并写入 SPEC §7 与后续路线。

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

## 15. 信封校验：一个函数，两个调用点

**决定**：校验拆成两个函数，边界切在「能否不解密就知道」这件事上。

| 函数 | 谁调用 | 负责什么 |
|---|---|---|
| `validateEnvelope` | **发送侧 + 接收侧共用** | 结构、格式、大小、receipt、时间规则、按 type 的 payload 校验 |
| `verifyAuthenticity` | **仅接收侧** | `from` === 已验签的 seal 公钥；`to` === 本机公钥 |

**发送侧调用点**：在 `buildEnvelope` 内部、**构造完成后、加密封装之前**。
`to` 在 `send` 命令接收输入时即已确定，不是会中途变化的变量。
发送侧额外检查两项：`from` 必须等于自己的公钥；`to` 的公钥格式（后者由共用函数覆盖，不重复实现）。

**理由**：把可离线判定的部分与需要验签结果的部分切开，才能让两侧真正共用同一份实现 ——
「两侧各写一份」迟早会漂移。已有测试断言 `receiver.validateEnvelope === core`，引用相等。

### 返回值而非异常

**决定**：一律返回 `{ ok: true, envelope }` 或 `{ ok: false, reason, detail }`，**不抛异常**。

**理由**：不可信输入的失败是**预期内的常规分支**，不是异常路径。用异常会让调用方
不得不写 try/catch 包裹整个解析过程，还容易漏掉某个分支；原因码则可以被
去重/日志/统计直接消费。

### v0 严格 schema

- 顶层出现集合外的字段 → 拒绝（不静默忽略 —— 静默会让未来扩展难以察觉）
- 未知 `type` → 拒绝
- `ping` payload 必须为空；`pong` 必须携带合法 `id`；`text` 有长度上限
- 公钥必须是 **64 位小写**十六进制
- `id` 只接受 **UUID**（小写带连字符）或 **ULID**（26 位 Crockford Base32）
- `receipt` 允许**缺失或 null**，非 null 一律拒绝

### 两条必须在解析之前的检查

1. **先按 UTF-8 字节数判 64KB，再 `JSON.parse`** —— 否则畸形大包会先进解析器，
   既浪费 CPU 又让失败原因失真
2. **原型污染键**（`__proto__` / `constructor` / `prototype`）**递归**检查后才允许对象被使用

### 观察到的性质：64KB 总闸在语义合法的信封上不可达

各字段上限之和约 10KB（note 1KB + text 8KB + session 64B + 结构开销），
远低于 64KB。因此该总闸的实际职责已经变成**拦截畸形/超长输入**，而非限制正常消息。

**处置**：保留该检查 —— SPEC §5 明确要求，且将来放宽任何字段上限时它是最后一道闸；
同时**把这条预算关系写成测试**，任何人放宽字段上限导致总量逼近 64KB 时会立刻失败。

### ⚠️ 防御性取值（无数据支撑）

`MAX_TEXT_BYTES=8192`、`MAX_NOTE_BYTES=1024`、`MAX_SESSION_BYTES=64`、
`MAX_AUTO_REPLIES_GLOBAL=100` 均无实测依据，仅作防御。观测到误杀时优先调这些常量。

### 终端控制字符

`payload` / `note` 一律视为不可信数据（SPEC §5）。`listen` **打印前**必须过
`stripTerminalControls`：ESC 序列（`ESC[2J` 清屏、`ESC]0;...BEL` 改标题）、
`\r` 退格覆盖、C0/C1 控制字符全部剔除，保留换行与制表符。已有 6 个测试覆盖。

## 16. 仓库完整性自检（`pnpm check:repo`）

**决定**：新增 `scripts/check-repo-integrity.mjs`，**提交前必须运行**。

**理由**：本项目已真实发生过事故 —— `.gitignore` 里的 `identity` / `identity.*`
两条规则吞掉了 `src/identity/` 整个目录和 `identity.test.ts`，
而 `git status` 一片干净、CI 也全绿，**全程零报错**。

脚本做**双向断言**，缺一边就是空跑：

1. 关键目录与文件确实被跟踪（`git ls-files`）
2. 私钥类文件确实被忽略（`git check-ignore`）
3. **反例断言**：源码本身不能被忽略（防止「为了修误伤而把规则删干净」）
4. 关键目录下至少有一个被跟踪的文件（防止整个目录被吞）

## 17. 已知限制（汇总，须同步写入 SPEC §7 与 README）

| # | 限制 | 处置 |
|---|---|---|
| L1 | **gift wrap 的 `p` 标签暴露收件人** —— 中继读不懂内容，但能画出"谁在跟谁通信" | M1 不修复；写入后续路线 |
| L2 | **去重表是纯内存的** —— 进程重启后，中继上尚未过期的消息会被**重复显示** | M1 接受；README 注明；**M3 引入收据/计量前必须改为持久化** |
| L3 | **多身份可绕过"按发送方"的限制** —— 单个对端持有 N 个公钥即可把每发送方配额放大 N 倍 | 已叠加全局上限（§10）缓解，但**不根治**；根治需信誉/成本门槛，超出 M1 范围 |
| L3a | **多身份同样可以打满全局上限，导致正常 ping 被静默丢弃** —— 全局闸只是把伤害从"单发送方"拉平到"所有发送方"，并未让诚实流量获得优先权 | M1 接受；已知限制。缓解需引入信誉/成本门槛（§10 已注明），不在 M1 范围 |
| L4 | `nak serve` **不持久化**（内存中继） | 仅开发测试用；README 与本文档均注明 |
| L5 | **`0600` 检查不覆盖 ACL 与硬链接** —— macOS 的 `chmod +a "user:bob allow read"` 可在**完全不改 `st_mode`** 的前提下授予他人读权限；Linux 的 `setfacl` 通常因改写 mask 而侥幸被 `0o077` 检查逮到，macOS 不会。Node 无任何读取 ACL 的 API | M1 不修（技术栈无解）。登记为已知限制；`AGENTNET_HOME` 不应放在共享 / 网络 / 带默认 ACL 的目录下 |
| L6 | **私钥在进程内存中不清零** —— `secretKey` 是普通 `Uint8Array`，hex 中间态更是不可变字符串，无法清零 | M1 可接受（SPEC §7 规则 3：只用测试身份）。不做假装有效的加固 |
| L7 | **错误信息含绝对路径**，泄漏用户名与家目录布局 | M1 可接受；不泄漏私钥本身。若收紧则改为打印相对基目录的路径 |
| L8 | **`realpath` 与逐层 `lstat` 之间仍有 TOCTOU 窗口** —— 攻击者可在两者之间把某一级换成符号链接。彻底消除需要 `openat(2)` 逐级打开，Node 未导出该 API | M1 不修（不引入原生绑定）。**接入真实资金前再评估 openat 方案**，见第 19 节 |
| L9 | **`dev`/`ino` 回退分支在本机是死代码** —— 本机 Node 22.22.2 / 26.4.0 均实测存在 `O_NOFOLLOW`，该分支永不执行 | 保留仅为兼容无该常量的平台；**不得把它的存在当作已验证的防线**。代码内已就地标注 |

---

## 18. 否定性断言清单（回查）

> **约定**：本文件中凡是「某物不存在 / 某行为不会发生 / 某路径不是符号链接」这类断言，
> 一律附**可复现的实测命令**。
> 起因：首轮审计断言「Node 未导出 `O_NOFOLLOW`」—— 本机实测为假（值为 `256`）。
> 一条没实测过的否定性断言，会让人**删掉**真正有用的防线。

| # | 断言 | 状态 | 实测命令 | 观测 |
|---|---|---|---|---|
| N1 | `fs.constants.O_NOFOLLOW` **存在且生效** | ✅ 已实测 | `node -e "const f=require('fs');console.log(f.constants.O_NOFOLLOW);console.log(f.constants.O_NONBLOCK)"` | `256`（`0o400`）与 `4`；带 `O_NOFOLLOW` 打开符号链接返回 `ELOOP` |
| N2 | 只读打开无写端 FIFO **会永久阻塞** | ✅ 已实测 | `mkfifo /tmp/f && printf 'import{openSync}from"node:fs";openSync(process.argv[2],Number(process.argv[3]));console.log("OPENED")' > /tmp/c.mjs && node /tmp/c.mjs /tmp/f 0 && node /tmp/c.mjs /tmp/f 4` | flags=0（不带 `O_NONBLOCK`）：**卡住不返回**，需 `Ctrl-C`；flags=4：立即 `OPENED`（实测 2ms） |
| N3 | `mkdirSync(recursive, {mode})` 的 mode **施加到每一层**新建目录 | ✅ 已实测 | `node -e "const fs=require('fs');fs.mkdirSync('/tmp/p/a/b/c',{recursive:true,mode:0o700});for(const p of ['/tmp/p/a','/tmp/p/a/b','/tmp/p/a/b/c'])console.log((fs.statSync(p).mode&0o7777).toString(8),p)"` | 三层均为 `700` |
| N4 | `os.homedir()` **会跟随** `$HOME`，`os.userInfo().homedir` **不会** | ✅ 已实测 | `node -e "const os=require('os');console.log(os.homedir(),os.userInfo().homedir);process.env.HOME='/tmp/FAKEHOME-TEST';console.log(os.homedir(),os.userInfo().homedir)"` | 改前 `…/Users/yao /Users/yao`；改后 `/tmp/FAKEHOME-TEST /Users/yao` |
| N5 | macOS 上 **`/var` 是符号链接**（指向 `/private/var`） | ✅ 已实测 | `node -e "const fs=require('fs');console.log(fs.lstatSync('/var').isSymbolicLink(), fs.realpathSync('/var'))"` | `true /private/var`；`os.tmpdir()` 返回的 `/var/folders/…` 因此**本身含符号链接** |
| N6 | `/tmp` 是 **sticky + 世界可写**（`1777`）的共享目录 | ✅ 已实测 | `ls -ld /tmp && stat -f "%Sp" /private/tmp` | `/tmp -> private/tmp`；`/private/tmp` 为 `drwxrwxrwt` |
| N7 | `unwrapEvent` **不**校验信封里的 `from` | ✅ 已实测 | 第一部分 E 的四行攻击矩阵 | 「实际发送者 C、JSON 声称来自 A」**放行** |
| N8 | `nak serve` **不**持久化 | ✅ 已实测 | 第一部分 B | 重启后事件数 `1 → 0` |
| N9 | 64KB 总闸在语义合法的信封上**不可达** | ✅ 已有测试 | 各字段上限之和约 10KB，已固化为测试 | 任何人放宽字段上限至逼近 64KB 时测试失败 |
| N10 | `O_NOFOLLOW` 在 Windows 上不存在 | ⚠️ **未实测**（本机无 Windows） | — | 该断言来自平台文档，**本机无法验证**。因此实现保留 dev/ino 回退分支（L9），不假定其成立 |

### 回查结论

- N1–N9 均已附实测命令或在第一部分有等价的实测记录，**满足约定**。
- **N10 是唯一无法满足的条目**：它是跨平台断言，本机（macOS）无从实测。
  处置：在代码中**不依赖**它 —— 做特性检测 + 回退分支，而不是"假定 Windows 一定没有"。
- 新增文件与断言同步：第 17 节的 L8 / L9 分别对应 N5 揭示的窗口与 N1 的反面。

---

## 19. 路线图补充（身份模块的解冻条件）

> 第 11 节（项目元信息）已声明：里程碑 1 **不使用任何真实资金或重要密钥**。
> 一旦这个前提改变，身份模块必须先解冻。

| # | 条目 | 触发条件 |
|---|---|---|
| R1 | **接入任何真实资金或真实重要身份之前，必须由另一个模型或人工对身份模块做一次更严格的审计** | 任何越出"测试身份"的用途 |
| R2 | **重新评估 `openat(2)` 方案**（逐级 `openat` + `O_NOFOLLOW`，彻底消除 L8 的 TOCTOU 窗口） | 同上；若评估后仍不引入原生绑定，须重新登记残余风险 |
| R3 | 去重表改为持久化（L2） | 里程碑 3 引入收据/计量之前 |
| R4 | gift wrap 收件人暴露（L1）的缓解 | 里程碑 2 之后 |
| R5 | ACL / 硬链接（L5）的缓解 | 视运行环境是否需要把 `AGENTNET_HOME` 放在共享目录下 |

**身份模块当前状态：已冻结**（2026-10-08）。冻结范围 = `src/identity/`、`src/config/paths.ts`、
`src/config/dirguard.ts`、`src/config/uid.ts`。
此后任何改动都应先说明它对应哪一条审计发现，并同步更新本文件与第 18 节。
