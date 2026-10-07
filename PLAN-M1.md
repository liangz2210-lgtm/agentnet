# PLAN-M1.md — 里程碑 1 实现计划

> 草稿，待确认。**上游依据：`SPEC.md`（唯一事实来源）+ `TASK-01-PROMPT.md`（施工约束）。**
> 本文件不含实现代码。确认后按"第 3 节 分步执行"推进，每步需测试通过才提交 git。

---

## 1. 假设核对结果

| SPEC §4 假设 | 核对结论 | 依据 |
|---|---|---|
| TypeScript / Node LTS | ✅ 采用。本机 Node **v22.22.2**(arm64) | `node -v` |
| `nostr-tools` | ✅ **2.25.2**，许可证 **Unlicense** | npm registry |
| 支持 NIP-17 / 44 / 59 | ✅ 包内含 `nip17.js`、`nip44.js`、`nip59.js`（含类型与测试声明） | 解包查看 |
| 关键 API | `nip17.wrapEvent(私钥, {publicKey}, 明文)` / `nip17.unwrapEvent(wrap, 私钥)`；亦可分层 `nip59.createRumor → createSeal → createWrap` | `nip17.d.ts` / `nip59.d.ts` |
| **本地中继** | ❌ **原假设不成立（本机跑不起来）**，见第 2 节 | Docker daemon 未运行，未装 Docker Desktop |
| Vitest | ✅ **5.0.3**，MIT | npm registry |
| 包管理器 pnpm | ✅ **11.7.0** 已装；npm 10.9.7 亦可 | `pnpm -v` |

**安全规则 1 与 7 不受影响**：不自实现密码学；主力依赖仅 `nostr-tools`(Unlicense) + `vitest`(MIT)。

---

## 2. ⚠️ 唯一的岔路：本地中继怎么跑（需你选）

SPEC 假设"本地 Docker 跑 strfry 或 nostr-rs-relay"。**本机实测：Docker CLI 有（29.8.0），但没有 daemon、没有 Docker Desktop。** `docker ps` 直接失败。这三个选项会改变 README、CI 和集成测试的写法，所以我不替你拍板。

| 方案 | 做法 | 许可证 | 活跃度 | 优点 | 风险 |
|---|---|---|---|---|---|
| **A. 修 Docker** | `colima start`（**本机已装 colima/lima**）→ docker-compose 跑 `nostr-rs-relay` | MIT | 719★，2026-05 | 最贴近 SPEC 原意；贴近生产 | 多一层 VM；同事/CI 也要有 Docker |
| **B. nak CLI**（*推荐*） | `brew install nak` → `nak serve` | Unlicense | 344★，2026-09 | 零 Docker、零 Node 依赖、单二进制；`nak` 还能手动查验「中继只见密文」这条验收 | 多一个 brew 前置依赖 |
| **C. Node 中继** | `@nostr-relay/core` 随仓库起 | MIT | **16★，README 自称 WIP** | 纯 TS、CI 友好 | 维护人手薄，标 WIP |

> **我的倾向：B 打底 + A 可选。** B 让 `README` 的"从零跑通"只有两条命令（`brew install nak` / `pnpm i`）；同时保留 `docker-compose.yml` 给想用标准中继的人。
> **注意**：无论选哪个，都**不否决** SPEC §9 要求的"双中继、其中一个不可用仍可送达"测试 —— nak / Docker 都能同时起两个端口。

---

## 3. 模块划分

在 SPEC §8 建议基础上**多加一个 `config`**：`src/identity`、`src/envelope`、`src/transport`、`src/cli`、**`src/config`**（中继列表 + 数据目录，SPEC §6 要求）。

设计要点：

- `envelope` 是**纯函数**（`validate(raw) → {ok, reason}`），不碰 IO ⇒ 最容易覆盖 SPEC §9 的单元测试清单
- `transport` 只管"怎么送"，不知道信封语义；`envelope` 不知道网络存在 ⇒ 两边可独立测
- **过期检查走可注入的 clock**（`now: () => number`），否则单测会随时间 flaky
- **去重键必须是 `(from, id)` 复合键**，不能只用 `id` —— 否则不同发送方的同名 id 会互相误杀，且这条恰好是"两个中继重复投递"的正确去重粒度（SPEC 未写明，我认为需补）

---

## 4. 分步执行

| # | 内容 | 同步交付的测试 | 产物/产出文件 |
|---|---|---|---|
| **1** | 脚手架：git init、`package.json`、`tsconfig`、`vitest` 配置、`.gitignore`（**私钥文件与数据目录必须 ignore**）、`DECISIONS.md` 记录本节全部决定 | 冒烟：一个占位测试绿 | 可跑 `pnpm test` |
| **2** | `identity`：密钥生成、`0600` 落盘、加载、`whoami` | 密钥文件格式与**权限确为 0600**（`umask` 会干扰，落盘后必须显式 `chmod` 并回读校验）；公钥为 32 字节 hex | `src/identity/**`、`test/identity.test.ts` |
| **3** | `envelope`：类型定义 + `validate()` 纯函数；64KB 上限、`from`≡签名者、过期、必填字段 | 合法/非法字段、超 64KB、已过期、`from`≠签名者、缺必填字段 | `src/envelope/**`、`test/envelope.test.ts` |
| **4** | `transport`：NIP-17 wrap/unwrap 往返 + `SimplePool` 收发 + `(from,id)` 去重存储 | wrap→unwrap 往返一致、重放二次投递被丢弃、`receipt` 恒 null | `src/transport/**`、`test/transport.test.ts` |
| **5** | **集成测试**（对第 2 节选定的中继）：SPEC §9 四条 | A→B 在线送达 / B 离线后上线收到 / **中继侧抓到的事件确是密文** / 双中继挂一个仍送达 | `test/integration/*.test.ts` |
| **6** | `cli`：`init`、`whoami`、`send`、`ping`、`listen` | 端到端手跑一遍 `listen` + `ping` | `src/cli/**` |
| **7** | `README.md`（从零跑通）+ **逐条对照 SPEC §3 的 8 条验收**出具对照表 | 全量 `pnpm test` 绿 | `README.md` |

> 收到 gift wrap 时的订阅 `since` 回溯窗口：**实现时按 NIP-59 原文核对具体取值**，不凭记忆写死 —— 这条直接决定验收 4（离线消息）会不会偶发漏收。

---

## 5. 需要你拍板的开放问题

**SPEC §12 自带（开工第一天就会撞上）**

1. **项目名称** —— `README.md` 和 `package.json` 第一步就要填
2. **开源许可证** —— 与依赖许可证无关，是本项目自身的
3. **v0 是否桥接 Nostr 公共中继**，还是只用本地中继（我默认：**只用本地**）

**中继选型** —— 见第 2 节 A / B / C

**我在审阅 SPEC 时发现的空白，建议补进 `SPEC.md`**

- §5「`id` 在本地保存一段时间」未定义**时长与清理策略**，实现时无法定容 —— 建议明写（如"保留至 `expires_at` 之后再延 1 小时"）
- §9 要求测"两个中继同时配置"，但 SPEC 从未写明**同一条消息经两个中继重复投递时的去重粒度** —— 我在第 3 节按 `(from, id)` 处理，请确认这是你要的语义
- §6 提到配置项可由文件或环境变量提供，**未定义路径与变量名**
- NIP-17 隐藏了作者，但 gift wrap 的 **`p` 标签仍暴露接收者**；SPEC §7 未提这层元数据泄漏是否需要应对 —— 建议至少在 SPEC 里承认这个边界

---

## 6. 明确不做

SPEC §10 九条一律不碰：目录与标签、能力令牌与授权、收据与计量、代币与链、存储与大文件、LLM 调用、GUI、多设备同步、群聊。
完成第 4 节全部步骤后**停下，不自行开始里程碑 2**。
