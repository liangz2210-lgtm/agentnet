# ACCEPTANCE.md — 里程碑 1 验收对照表

对照 `SPEC.md` §3 的八条验收标准。**每条都给出可复跑的证据**：测试名，或真实命令输出。

复现方式：

```bash
pnpm install
pnpm build          # 产出 dist/cli/bin.js（端到端测试跑的是这个真实二进制）
pnpm test           # 205 passed（单元测试 + 集成测试 + 端到端测试）
```

分层说明：

| 层 | 目录 | 跑什么 |
|---|---|---|
| 单元 | `test/unit/` | 纯逻辑，不联网、不落盘到真实家目录 |
| 集成 | `test/integration/` | 真实 `nak serve`（随机端口、等就绪、测完必关） |
| 端到端 | `test/e2e/` | **真实 CLI 子进程** + 两个隔离数据目录 + 随机端口 nak |

---

## 1. 每个 agent 能生成并本地保存自己的密钥身份

| 证据类型 | 内容 |
|---|---|
| 单元 | `test/unit/identity.test.ts`（25）— 生成、0600 权限、拒绝符号链接、init 不覆盖 |
| 单元 | `test/unit/keyfile.test.ts`（12）— 私钥文件/目录的准入校验纯函数 |
| 单元 | `test/unit/paths.test.ts`（15）— 基目录解析与安全校验 |
| 单元 | `test/unit/audit-a1-a6.test.ts`（16）— 针对首轮审计 A1–A6 的回归测试 |
| 端到端 | `S1 身份 > 两个隔离数据目录各自 init，公钥互不相同且都是完整 64 位十六进制` |
| 端到端 | `S1 身份 > whoami 只输出公钥一行，且 init 拒绝覆盖已有身份` |

真实输出：

```console
$ agentnet init --name alice
身份已生成。
公钥：5763e164f911b69270f49749e4a39706f5cfc2fddc658d1f46ef5c78c8542ed5
⚠️ 私钥一旦丢失无法找回：没有助记词、没有云端备份。请自行安全备份。
[exit] 0

$ agentnet whoami
5763e164f911b69270f49749e4a39706f5cfc2fddc658d1f46ef5c78c8542ed5
[exit] 0
```

---

## 2. A 向 B 发送一条消息，B 能验证确为 A 所发

| 证据类型 | 内容 |
|---|---|
| 单元 | `test/unit/pipeline.test.ts > 第 4 步：from 与已验签发送者不一致被拒（FROM_MISMATCH —— unwrapEvent 不查这一条）` |
| 单元 | `test/unit/pipeline.test.ts > 第 4 步：to 不是本机公钥被拒（TO_MISMATCH）` |
| 单元 | `test/unit/envelope-validate.test.ts`（27）— `verifyAuthenticity` 的两个方向 |
| 端到端 | `S2 listen 收消息 > 显示的消息带发送者**完整**公钥（不缩写、不打码）` |
| 端到端（反面） | `S5 拒绝路径 > 伪造发送者（C 签名但 from 写 A）不显示` — stderr 出现 `FROM_MISMATCH`，stdout 无该行 |
| 端到端（反面） | `S5 拒绝路径 > to 不是本机公钥的消息不显示` |

真实输出（bob 侧 `listen`）：

```console
[text] 5763e164f911b69270f49749e4a39706f5cfc2fddc658d1f46ef5c78c8542ed5: 验收演示消息
```

---

## 3. 消息端到端加密，中继看不到内容

| 证据类型 | 内容 |
|---|---|
| 集成 | `test/integration/transport.test.ts > 用例 5：中继上抓到的是密文，且外层公钥不是发送者` |
| 单元 | `test/unit/envelope-shared.test.ts`（10）— 发送侧与接收侧共用同一个校验函数 |

该用例直接连到中继、抓下线上那条事件并断言：`kind === 1059`、`content` 不是明文、
外层 `pubkey` **不等于**发送方公钥、`p` 标签只有收件人。

> 已知限制 **L1**：`p` 标签仍然暴露**收件人**，中继读不懂内容但能画出"谁在跟谁通信"。M1 不修复。

---

## 4. B 不在线时消息暂存在中继，B 上线后能收到

| 证据类型 | 内容 |
|---|---|
| 集成 | `用例 4：离线消息上线后收到（since = now − 72h 覆盖 gift wrap 回溯）` |
| 端到端 | `S3 离线消息 > 接收方不在线时发出，之后 listen 仍能收到（since 回溯 72h）` |

`since` 取 `now − 72h` 而非 `now`：NIP-59 把外层时间戳**随机回溯 0~48 小时**
（`nostr-tools` 源码 `nip59.js`），用 `since = now` 会**永远漏收**离线消息。
72h = 48h × 1.5，留 50% 余量吸收时钟偏差与 nak 的排他 `since` 语义。

---

## 5. 过期消息被拒绝；重复消息只处理一次；未签名或签名错误的消息被拒绝

| 子项 | 证据 |
|---|---|
| **过期** | 单元 `第 3 步：过期消息被拒（EXPIRED），且**不写去重表**`；端到端 `S5 > 过期消息不显示（--ttl 1，等过期后再收）` |
| **重复 / 重放** | 单元 `第 5 步：同一消息第二次到达被去重（DUPLICATE）`；集成 `用例 3：同一消息经两个中继到达只处理一次`；端到端 `S5 > 同一信封 id 投递两次只显示一次（第二次判为 DUPLICATE）` |
| **wrap 签名被篡改** | 单元 `第 2 步：篡改 wrap 签名被拒（接收方不信任中继的验签）` → `WRAP_SIGNATURE_INVALID` |
| **seal 签名被篡改** | 单元 `第 2 步：seal 签名被篡改被拒（SEAL_SIGNATURE_INVALID）` |
| **不是发给我们的密文** | 单元 `第 2 步：不是发给我们的密文被拒（WRAP_DECRYPT_FAILED）` |
| **第一级大小检查（256KB）** | 单元 `第 1 步：解封前按密文长度拦下超大包（WRAP_TOO_LARGE）` |
| **第二级大小检查（64KB）** | 单元 `第 3 步：载荷超过 64KB 在解析之前被拒（TOO_LARGE）` |

两级大小检查为什么是 256KB 和 64KB（不是同一个数）：

- 64KB 是 SPEC 对**明文信封**的上限，必须在 `JSON.parse` 之前按 UTF-8 字节判定
- 但收到的东西是**两层 NIP-44 之后的密文**：65KB 明文经 padding + base64 后约 **153KB**（≈2.3×）
- 所以解封前的粗检取 **256KB**：既能拦住真正的巨型包，又不会把合法消息误杀

---

## 6. 消息信封中已包含类型、过期时间、预留的收据字段

| 证据类型 | 内容 |
|---|---|
| 单元 | `test/unit/envelope-validate.test.ts > 缺少必填字段被拒绝` |
| 单元 | `test/unit/envelope-validate.test.ts > receipt 非 null 被拒绝，但缺失或 null 均可` |
| 单元 | `test/unit/envelope-validate.test.ts > 未知 type 被拒绝` |
| 单元 | `test/unit/outgoing.test.ts`（3）— 有效期字段真的按 `--ttl` 写入 |

真实信封（解封后）：

```json
{
  "v": 0,
  "id": "e95af509-9b3c-4376-84de-303b5b6bc5a5",
  "type": "text",
  "from": "<发送方公钥 64 hex>",
  "to": "<接收方公钥 64 hex>",
  "expires_at": 1791483290,
  "payload": { "text": "hi" },
  "receipt": null
}
```

> **没有 `created_at` 字段**：SPEC v0.2 起以 `rumor.created_at` 为**唯一时间基准**
> （信封内若出现 `created_at`，必须与 rumor 的值相等，否则 `CREATED_AT_MISMATCH`）。

---

## 7. 有自动化测试（单元测试 + 对本地中继的集成测试）

```console
$ pnpm test
 Test Files  16 passed (16)
      Tests  205 passed (205)
```

| 层 | 文件数 | 覆盖 |
|---|---|---|
| 单元 | 13 | 身份、路径、信封校验、清洗、去重、流水线、限速、CLI 参数与退出码 |
| 集成 | 1 | 真实 nak：宕机中继不崩溃、OK=false、跨中继去重、离线送达、线上只见密文、入站限速 |
| 端到端 | 1 | 真实 CLI 进程的 8 个场景（S1–S8） |

另有 `pnpm check:repo`（仓库完整性自检，防 `.gitignore` 静默吞掉源码）
与 `pnpm typecheck`。

### 端到端 8 场景清单

| 场景 | 用例 |
|---|---|
| S1 身份 | 两个隔离目录各自 init、公钥不同；whoami 只输出一行；init 拒绝覆盖；无身份退出码 3；`--json` 每行一个对象 |
| S2 收消息 | 显示**完整**发送者公钥；文本为 `-` 时读标准输入 |
| S3 离线 | 接收方不在线时发出，之后 listen 仍能收到 |
| S4 ping | 对方在线 → pong、退出码 0；无人应答 → 退出码 5 |
| S5 拒绝路径 | 过期不显示；同信封 id 两次只显示一次；伪造发送者不显示；`to` 不是本机不显示 |
| S6 输出清洗 | ESC / 零宽 / 双向控制字符被清掉；超长行截断并注明；nsec 当公钥 → 退出码 2 |
| S7 中继不可达 | send → 退出码 4；listen 启动失败非零；失败后无残留进程 |
| S8 收尾 | 全程结束无残留 CLI 进程；listen 收到 SIGTERM 后退出码 0 |

---

## 8. 有 README，别人照着能从零跑通

`README.md` 包含：环境要求、安装构建、本地起中继、**两个身份互发消息的完整可复制流程**、
CLI 参考、退出码表、故障排查、已知限制、安全说明。

按 README 从零执行的最短路径：

```bash
pnpm install && pnpm build
nak serve --port 7777 &                    # 终端 1
export AGENTNET_RELAYS=ws://127.0.0.1:7777
export AGENTNET_HOME=~/.agentnet-alice && node dist/cli/bin.js init
export AGENTNET_HOME=~/.agentnet-bob    && node dist/cli/bin.js init
export AGENTNET_HOME=~/.agentnet-bob    && node dist/cli/bin.js listen   # 终端 2
export AGENTNET_HOME=~/.agentnet-alice  && node dist/cli/bin.js send "$(...)" "你好"
```

---

## 附：本轮端到端测试抓出的三个实现 bug

端到端层（真实进程）抓到了单元测试看不见的问题 —— 这也是为什么要单独有这一层：

| # | 问题 | 现状 |
|---|---|---|
| 1 | `CommandExitError` 未被 `run()` 捕获 → "无身份"的退出码变成 `1` 并打印一整串堆栈（应为 `3`） | 已修，并补 `run()` 的退出码单测 |
| 2 | `--ttl` 在 CLI 层被解析、被校验，却**从未传给** `buildTextMessage`，恒用默认 3600 秒 | 已修，并补 `test/unit/outgoing.test.ts` 锁死 |
| 3 | `ensureBuilt()` 只在 dist 缺失时构建 → 改完实现后测试仍在跑**改之前那份二进制** | 已改为每次都重建 |

另修一处清洗缺陷：单字符 CSI（U+009B）原先只删字符本身，把它引入的 `2J`（清屏）当明文留在了终端里。
