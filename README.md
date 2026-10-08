# agentnet

开源网络的 agent 间通讯层。**里程碑 1：身份 + 中继通讯。**

一个 agent 生成一份本地密钥身份，通过中继给另一个 agent 发端到端加密的消息。
中继看得到"有个加密包经过"，看不到内容，也看不出是谁发给谁。

> **状态：里程碑 1 已完成并冻结**（Git 标签 `m1-complete`，231 测试全绿）。
> 冻结期内不再改动 M1 的行为；要动就得先说明对应哪一条审计发现或已知限制。
> **里程碑 2 尚未开始。**

- 规格（唯一事实来源）：[`SPEC.md`](./SPEC.md)
- 技术决定与实测依据：[`DECISIONS.md`](./DECISIONS.md)
- **验收对照表**：[`ACCEPTANCE.md`](./ACCEPTANCE.md) —— 八条验收标准各对应哪些测试与命令输出
- **已知限制清单**：[`LIMITS.md`](./LIMITS.md) —— 每条都写明是什么、为什么接受、什么时候必须解决

> 里程碑 1 是**通讯层**，不是应用层。它不做目录与标签、能力令牌、收据与计量、
> 代币与链、LLM 调用、图形界面（清单见 `SPEC.md` 第 10 节）。

---

## 一、从零跑通（照抄即可）

目标：在你本机上起一个中继，造两个身份（alice / bob），让 alice 给 bob 发一条消息。

### 0. 前置条件

| 需要 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22** | 用 `node -v` 确认 |
| pnpm | 任意较新版本 | `npm i -g pnpm` |
| `nak` | **0.21.0** | 仅本地开发测试用的中继，`brew install nak` |

> **Windows 暂不支持** —— 里程碑 1 仅在 macOS 与 Linux 上测试过（详见下方"安全须知"）。

### 1. 安装与构建

```bash
git clone https://github.com/liangz2210-lgtm/agentnet.git && cd agentnet
pnpm install
pnpm build          # 产出 dist/cli/bin.js
```

`pnpm install` 依赖仓库里自带的 `.npmrc`（`node-linker=hoisted`），**不要删**。

### 2. 起一个本地中继

```bash
nak serve --port 7777
```

> `nak serve` 是**内存中继**：进程一停，事件全丢。它仅供开发与测试，不要用于真实通信。

让这个终端开着，另开两个终端继续。

### 3. 造两个身份

```bash
# 终端 A
export AGENTNET_RELAYS=ws://127.0.0.1:7777
export AGENTNET_HOME=~/.agentnet-alice
node dist/cli/bin.js init --name alice

# 终端 B
export AGENTNET_RELAYS=ws://127.0.0.1:7777
export AGENTNET_HOME=~/.agentnet-bob
node dist/cli/bin.js init --name bob
```

各自会打印一份**公钥**（64 位十六进制）。`AGENTNET_HOME` 让两个身份互不干扰 ——
同一台机器上可以有任意多个身份，它们只是不同的目录。

### 4. bob 开始收听

```bash
# 终端 B
node dist/cli/bin.js listen
```

### 5. alice 发消息

```bash
# 终端 A（把 bob 的公钥粘过来）
node dist/cli/bin.js send <bob 的公钥> "你好，我是 alice"
```

bob 那边立刻出现一行：

```
[text] <alice 的完整公钥>: 你好，我是 alice
```

### 6. 试试 ping

```bash
# 终端 A
node dist/cli/bin.js ping <bob 的公钥>
# → pong 来自 <bob 的公钥>，往返 22 ms
```

ping 需要 bob **正在 listen**（pong 是 bob 的进程自动回的）。

---

## 二、CLI 参考

```
agentnet init [--name <name>]            生成本机身份（已有身份则拒绝，不覆盖）
agentnet whoami                          显示本机公钥
agentnet send <公钥> <文本> [--ttl 秒]   发送 text 消息；文本为 - 时读标准输入
agentnet ping <公钥> [--timeout 秒]      发送 ping 并等待 pong
agentnet listen                          连接中继，接收并显示消息
```

### 公钥参数

接受两种写法，内部统一成 64 位小写十六进制：

- 64 位十六进制：`2ae5f95869122121fe47358bbd4432ba6e1efd9069190009233d5ee13d78c410`
- NIP-19 `npub1…`

**`nsec1…`（私钥形态）会被直接拒绝**并提示 —— 私钥一旦进命令行，就会进 shell 历史和进程列表。

### 选项

| 选项 | 作用 |
|---|---|
| `--relay <url>` | 指定中继，**可重复**。优先级：命令行 > `AGENTNET_RELAYS` > `config.json` |
| `--json` | 每行输出一个 JSON 对象，便于脚本解析 |
| `--ttl <秒>` | `send` 的消息有效期，默认 3600，上限 86400 |
| `--timeout <秒>` | `ping` 等待 pong 的时长，默认 10 |

### 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTNET_HOME` | 数据目录（身份、配置）。默认 `~/.agentnet` |
| `AGENTNET_RELAYS` | 中继列表，逗号分隔 |

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 其他错误 |
| `2` | 用法错误（参数不对、疑似把私钥当公钥传） |
| `3` | 无身份（先跑 `init`） |
| `4` | 发送未被任何中继确认 —— **消息未送达** |
| `5` | ping 超时（对方没回 pong） |

`send` 与 `ping` 完成后**进程会自行退出**，不会挂住。

### 配置文件

`~/.agentnet/config.json`（0644），可手工编辑：

```json
{
  "name": "alice",
  "relays": ["ws://127.0.0.1:7777"]
}
```

---

## 三、故障排查

| 现象 | 原因与处置 |
|---|---|
| `未找到身份文件…请先运行 agentnet init` | 该 `AGENTNET_HOME` 下还没 init。注意每个 home 是独立身份 |
| `数据目录路径不安全（不得直接位于带 sticky 位的共享可写目录下）` | 别把 `AGENTNET_HOME` 放在 `/tmp` 下 —— 那是任何人可写的共享目录 |
| `数据目录权限过松（755）` | `AGENTNET_HOME` 必须 `0700`（`mkdir -p` 建出来是 755，用 `mkdir -m 700`） |
| `未配置任何中继` | 三种来源都没有：`--relay`、`AGENTNET_RELAYS`、`config.json` 的 `relays` |
| `启动失败：所有中继都不可达` | 中继没起或端口不对。用 `--relay` 显式指定排查 |
| `send` 退出码 4 | 没有任何中继确认。多半是中继没起，或 URL 写错（`ws://` 不是 `http://`） |
| `ping` 退出码 5 | 对方没在 `listen`，或公钥填错。ping 依赖对方在线自动回 pong |
| 重启后又看到一遍旧消息 | 已知限制：去重表是内存里的（见下） |

---

## ⚠️ 安全须知

### 私钥一旦丢失，无法找回

`agentnet init` 在你的数据目录里生成一份 secp256k1 私钥（默认 `~/.agentnet/identity.key`）。

- **这份私钥没有任何恢复机制** —— 没有助记词、没有云端备份、没有找回邮箱。
  文件删了就是永久失去这个身份，**别人发给它的消息再也无法解密**。
- 请自行备份。备份副本同样应当仅你可读。
- 私钥**不接受**通过环境变量或命令行参数传入 —— 那会让它泄漏进进程列表和子进程环境。

### 收到的内容只展示，不执行

终端输出前会清洗掉 ESC 序列、C0/C1 控制字符（含 `0x9B`）、双向控制字符
（`U+202A–202E`、`U+2066–2069`）与零宽字符 —— 否则一条消息就能改写你的终端显示、
伪造命令行历史、或藏下肉眼不可见的内容。

收到的文本**只打印到屏幕上**：不执行、不交给任何 LLM。发送者一律显示**完整公钥**
（不做缩写），因为缩写会让"确认对方到底是谁"这件事无法完成。

超长的单行会被截断，并**明确标注 `…[已截断]`** —— 静默截断等于说谎。

### 身份文件的准入要求

加载时若发现以下任一情况，**程序拒绝运行**：

| 条件 | 要求 |
|---|---|
| 文件类型 | 必须是普通文件，**不得是符号链接** |
| 所有者 | 必须是**你自己** |
| 权限位 | 组与其他用户**不得有任何权限**（即 `0600`） |

数据目录所在的**每一级祖先目录**同样受检（不得是符号链接、不得对组或其他用户可写、
不得直接位于 `/tmp` 这类带 sticky 位的共享可写目录下）。

`init` 遇到已存在的身份**不会覆盖**，且**不提供 `--force`**：覆盖身份等于让一个
已经对外公布过的公钥凭空消失，代价远高于"多建一个目录"。

### 开发用中继是内存中继

本机测试使用 [`nak`](https://github.com/fiatjaf/nak)（版本锁定 **0.21.0**）。

- **`nak serve` 把事件全放在内存里，进程重启后立刻清空。**
- **仅供开发与测试**，不得用于任何真实通信场景。
- `since` 采用**排他**语义（`>`，与 NIP-01 的 `>=` 不同）；`#p` 标签过滤正常。
  详见 `DECISIONS.md` 第一部分 B。

### 重启后可能重复看到消息

消息去重表是**纯内存**的。进程重启后，中继上**尚未过期**的消息会被再次投递、再次显示。
这是已知限制；在里程碑 3 引入收据与计量之前，它必须改为持久化存储。

全部已知限制（含"为什么接受、什么时候必须解决"）见 [`LIMITS.md`](./LIMITS.md)。
其中两条最容易被误解，值得单独说：

- **「已送达」不等于「对方收到」**。`send` 打印的"✓ 已确认"只表示**中继收下了**，
  不表示对方收到了、更不表示对方处理了。真正的送达确认是里程碑 3 的收据。
- **所有防御上限都没有数据支撑**（速率、配额、去重容量…）。它们只是先挡住最粗暴的
  滥用，不是调优过的取值。现在已经按原因码计数，`listen` 退出时会打印丢弃汇总，
  将来用观测数据替换即可。

### 威胁模型的边界

身份模块的防线针对的是**其他 uid 的本地进程/用户**。

- **不防**以你自己身份运行的恶意程序 —— 它能直接读你的私钥文件，文件权限的主语是 uid 而不是进程。
- **不防** root。
- macOS 的 ACL（`chmod +a`）不在 `0600` 检查的覆盖范围内。

完整边界与每条防线对应的攻击形态见 `DECISIONS.md` 第 0 节与第 9 节。

### 平台支持

里程碑 1 **仅在 macOS 与 Linux 上测试过**。**Windows 暂不支持**：
私钥文件保护依赖 `O_NOFOLLOW` 等 POSIX 语义，该路径在 Windows 上**未经实测**
（见 `DECISIONS.md` §18 N10），不宜假定它成立。

### 全程只用测试身份

里程碑 1 **不涉及任何真实资金或重要密钥**。若将来要接入真实资产，
身份模块必须先解冻并通过一次更严格的审计（`DECISIONS.md` §19 R1）。

---

## 四、开发

```bash
pnpm install         # 需要 .npmrc 中的 node-linker=hoisted，见 DECISIONS.md §13
pnpm build           # 编译到 dist/（端到端测试跑的是这个真实二进制）
pnpm typecheck
pnpm test            # 单元 + 集成 + 端到端（231 passed）
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm check:repo      # 仓库完整性自检（防 .gitignore 静默吞掉源码）
```

| 层 | 目录 | 依赖什么 |
|---|---|---|
| 单元 | `test/unit/` | 无（纯逻辑，注入时钟） |
| 集成 | `test/integration/` | 真实 `nak`，随机端口、等就绪、测完必关 |
| 端到端 | `test/e2e/` | **真实 CLI 子进程** + 两个隔离数据目录 + 随机端口 `nak` |

### 目录结构

```
src/identity/    密钥生成与保存（0600、准入校验、不覆盖）
src/config/      数据目录与路径安全（逐层祖先检查）
src/envelope/    信封定义、校验、清洗、gift wrap 封拆
src/transport/   中继连接、发布、订阅、重连（逐中继独立）
src/receive/     接收流水线：大小 → 解封 → 校验 → 验签 → 去重 → 业务
src/messaging/   发送侧消息构造
src/cli/         命令行入口与退出码
```

### 接收到的消息走六步才进业务逻辑

1. 密文长度粗检（256KB）
2. 拆三层 gift wrap（**补上 `unwrapEvent` 不做的 wrap 验签**）
3. `validateEnvelope`：结构 / 大小（64KB）/ 原型污染 / 时间规则
4. `verifyAuthenticity`：`from` 必须等于**已验签**的发送方、`to` 必须等于本机
5. 去重（`(from, id)` 复合键）
6. 才交给业务逻辑

顺序不能换：先验签、再查过期与重放，最后才动业务逻辑。

---

## 许可证

Apache-2.0。第三方依赖的许可证与维护状态见 `DECISIONS.md` §13。
