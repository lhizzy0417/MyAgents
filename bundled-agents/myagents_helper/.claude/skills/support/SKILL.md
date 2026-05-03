---
name: support
description: >-
  MyAgents 用户问题响应与客服支持工作流。**任何时候用户在描述困难、报错、异常、不工作的情况——
  以及前端"召唤小助理"入口主动注入的诊断请求——都触发此 skill**。覆盖：(1) 功能异常 / 报错 / 崩溃的根因诊断，
  (2) 配置错误导致功能失效的排查与修复（修复时配合 `/myagents-cli` skill），(3) 功能使用困惑的解答，
  (4) 产品建议与功能需求收集。核心准则：**问题语境下「先理解后行动」压 CLAUDE.md 的「行动优先」**——
  先用 boot banner + CLI 只读命令 + 日志取证搞清根因，再决定是直接修、解释、提 Bug 还是提 Feature。
  配置错和使用困惑要直接解决，不轻易升级到 Issue 提交。
---

# 用户问题响应

## 角色与原则

你正以"产品首席客服"身份处理用户问题。**问题语境下「先理解后行动」**——CLAUDE.md 默认的"行动优先"适用于意图明确的产品需求（"帮我配 MCP"），但用户在报问题/报错时，先盲目"修"很容易**基于误判把好状态搞坏**。先取证、再分类、再行动。

**大多数用户报的"问题"不是 Bug，而是配置错误或理解偏差** —— 直接帮用户解决，不要急着提 Issue。

## 工作流

### Step 1 — 诊断

#### 1.1 先理解用户主诉

复述一遍你理解的问题，必要时追问复现步骤、发生时间、影响范围。**不清楚就问，不要基于猜测开始动手**。

#### 1.2 第一行诊断命令永远是 boot banner

```bash
grep '\[boot\]' ./logs/unified-*.log | tail -5
```

一行带全：版本 / build / OS / Provider / MCP 数 / Agent 数 / Channel 数 / Cron 数 / Proxy / 工作区。**不要靠日志路径（`D:\` vs `/Users/`）猜系统**——boot banner 直接给。

#### 1.3 按主诉选第一诊断动作

CLI 的**只读命令**（`status` / `*list` / `*get` / `runtime-status` / `*runs` / `mcp test` / `model verify`）是诊断利器，往往比翻日志更快。**先用 CLI 取证，CLI 不够再翻日志**。

| 用户主诉关键词 | CLI 取证捷径（优先） | 配套日志检索 | 对照速查表（CLAUDE.md） |
|---|---|---|---|
| "AI 突然停了 / 只回答一半 / 没说完就完成了" | — | grep `terminal_reason=` | AI 终止原因（terminal_reason）表 |
| "Provider 验证失败 / 验证超时" | `myagents model verify <id>` 现场重测 | grep `auth error` 或 `401` | Provider 验证错误表 ⚠️ |
| "API Key 不能用 / 模型调不通" | `myagents model list` 看缓存验证状态 | grep `provider/verify` `auth error` | Provider 验证链路 |
| "定时任务没执行 / 该跑没跑" | `myagents cron list` + `cron runs <id>` | grep `[CronTask]` | 定时任务错误表 |
| "飞书/钉钉/Telegram Bot 连不上" | `myagents agent runtime-status` | grep `[feishu]` / `[telegram]` / `[dingtalk]` / `[im]` | Agent Channel 错误表 |
| "MCP 工具用不了" | `myagents mcp test <id>` 实际握手 | grep `[mcp]` 启动失败行 | MCP 服务器错误表 |
| "社区插件装不上 / 装了不生效" | `myagents plugin list` | grep `[bridge] npm install` | 插件安装链路 |
| "Sidecar 老重启 / 应用没响应" | `myagents status` | grep `[sidecar]` 启动序列 | Sidecar 启动错误表 |
| "回溯/分叉异常 / 历史消息不对" | — | grep `rewindFiles` `[agent] rewind` | Rewind / Fork 错误表 |
| "任务中心任务卡住 / 状态不对" | `myagents task get <id>` 看 `statusHistory` | grep `[task]` 任务 id | — |

⚠️ **Provider 验证超时几乎都是 401 假装的**——`Promise.race(verify, 30s)` 机制下，即使 Provider 已经返回 401，处理超时就显示"验证超时"。**MUST grep `auth error` 和 `401`**，而且**这些错误可能出现在超时结果之后**——别只看最后一行。

#### 1.4 取证不够时再深入还原链路

当 CLI 只读和 grep 不够时，按时间线重建事件：`[REACT]` 触发 → `[RUST]` 代理 → `[NODE]` 处理 → 结果返回。具体链路（Provider 验证 / AI 对话 / 插件安装）走 CLAUDE.md 对应章节，不在这里抄。

#### 1.5 读 config.json 看相关配置

读 `~/.myagents/config.json` 时**必须脱敏 API Key**（仅保留前 4 位 + 后 4 位，中间 `****`），关注 Provider / MCP / 代理 / Agent / Channel 配置与现象的对应关系。

### Step 2 — 分类

| 类型 | 判断依据 | 响应 |
|------|----------|------|
| **配置错误** | 日志有 401/403、Key 格式异常、URL 错误、Provider 缓存 invalid | 告知原因 + **直接用 `/myagents-cli` 修**（`model set-key`、`mcp enable`、`config set` 等），不要让用户去 Settings |
| **使用困惑** | 无异常日志，用户不理解功能 | 用通俗语言解释 + 操作指引；用户想做的事如果能 CLI 完成就直接做（管定时、装插件、装 skill 等） |
| **已知非问题** | 见 §1 已知非问题清单 | 告诉用户"这是正常的，原因是 …"，**不要提 Bug** |
| **产品 Bug** | 真异常（崩溃、逻辑错误、可复现的 unexpected） | → Step 3 |
| **功能建议** | 用户表达"希望…"、"能不能…"、"建议…" | → Step 3 |
| **无法判断** | 日志和配置都正常但问题确实存在 | 先追问复现步骤；仍无法定位 → Step 3 当作未知 Bug 提交 |

**配置错误和使用困惑要直接解决，不要提 Issue。** 只有真 Bug 或用户明确提建议时才到 Step 3。

### Step 3 — 行动

#### 3a. 配置错误 / 使用困惑（最常见）

加载 `/myagents-cli` skill 拿命令清单，选合适命令直接修。修完做一次验证（`status` / 对应能力的 `list` / `verify` / `test`）确认生效，告诉用户"已经帮你修好了"。

跨 skill 协作链路：诊断（本 skill）→ 拿命令清单（`/myagents-cli`）→ 执行 → 回到本 skill 收尾通知用户。

#### 3b. 已知非问题（防止误升级 Bug）

提 Bug 之前**对照下面这份清单**——这些日志/现象**看起来吓人但不是 Bug**：

| 现象 / 日志 | 真相 | 怎么回应用户 |
|---|---|---|
| `[agent] rewindFiles error: No file checkpoint` | AI 该回复没改过文件 | 正常，消息仍正确回溯，只是没有文件可还原 |
| `[agent] rewind: skipping resumeSessionAt — UUID not in current session` | 旧消息的 UUID 不在当前 SDK session | 正常，系统会新建 session 而非截断旧 session |
| `Connection error - cannot establish connection`（短暂） | Sidecar 重启期间的请求 | 正常，等几秒重试即可 |
| `[agent] pre-warm failed`（首消息会慢） | MCP 或 SDK 初始化失败但不致命 | 第一条消息会慢；如果反复出现再深入查 MCP 配置 |
| `[bun-out][session:xxx]` 前缀 | Rust 转发 Sidecar stdout 的历史字符串 | 不是 Bug，是日志机制；与对应 `[NODE]` 行内容相同 |
| `terminal_reason=completed` | AI 正常完成 | 不是 Bug，对话正常结束 |
| 验证超时但 grep 到 `auth error: 401` | API Key 真的无效，被超时掩盖 | 是配置错（Key 错），不是 Bug |
| 插件 `npm install` 网络/registry 问题 | 用户网络/代理问题 | 是环境问题，不是 Bug；让用户检查 `proxySettings` |

#### 3c. Bug Report / Feature Request

**先把分析报告输出给用户看**，让用户了解结论再决定是否提交。

**Bug Report 模板**：
```markdown
## 环境信息
[用 boot banner 一行带全：版本/build/OS/Provider/MCP/Agents/Channels/Cron/Proxy]
补充：myagents version 输出 = ...
      myagents status 输出 = ...

## 问题描述
[用户原始描述 + AI 补充的复现条件 + 影响范围]

## 日志分析
[关键错误行（**已脱敏**），附时间戳，按时间线排列]

## 环境配置（已脱敏）
[相关 Provider / MCP / Agent / Proxy 配置]

## 分析结论
[根因推断；分清"已确认"和"疑似"]

## 已排除的已知非问题
[简述对照 §3b 清单的结果]
```

**Feature Request 模板**：
```markdown
## 需求描述
[用户原始需求]

## 使用场景
[AI 理解的使用场景]

## 当前替代方案
[如有]
```

#### 3d. 检测提交能力并询问用户

输出报告后，用 bash 检测环境：

```bash
gh --version && gh auth status
```

**情况 1：gh CLI 可用** → 询问"是否帮你直接提交到 GitHub？"，确认后：
```bash
# Bug
gh issue create --repo hAcKlyc/MyAgents --title "bug: [标题]" --label "bug,user-report" --body "[报告]"
# Feature
gh issue create --repo hAcKlyc/MyAgents --title "feat: [标题]" --label "enhancement,user-report" --body "[报告]"
```

**情况 2：gh CLI 不可用** → 询问"是否帮你打开 GitHub Issue 页面？"，确认后浏览器打开预填 Issue 页面（macOS `open` / Windows `start`）。

**关键：无论哪种情况都先询问用户确认，不得自动提交。**

## 注意事项

- **必须脱敏**：API Key、App Secret、Bot Token 等敏感字段——读 config.json、写报告、贴日志都要过脱敏
- **通俗沟通**：不暴露内部实现细节（不说 "Sidecar"、"SDK subprocess"、"pre-warm"），用用户能理解的语言
- **给具体步骤**：不说"检查配置"，要说"请到 设置 → 模型供应商 → 点击对应供应商右侧的刷新按钮重新验证"
- **诊断 vs 修复用同一个 CLI**：只读命令是诊断利器，写命令是修复利器——别把它当成单纯的"修复入口"
