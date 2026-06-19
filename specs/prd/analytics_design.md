# MyAgents 数据埋点设计文档

> **文档定位**：本文档是 MyAgents 产品数据埋点的唯一权威来源（Single Source of Truth）。
>
> **面向读者**：开发者、AI 助手
>
> **更新原则**：任何埋点的新增、修改、删除都必须同步更新本文档。

---

## 写给 AI 的上下文

如果你是一个 AI 助手，正在阅读本文档以了解如何为 MyAgents 添加埋点，以下是你需要知道的关键信息：

### 1. 埋点的技术实现

```typescript
// 导入
import { track } from '@/analytics';

// 调用方式
track('event_name', {
  param1: 'value1',
  param2: 123,
  param3: true,
});
```

### 2. 添加新埋点的步骤

1. **定义事件**：在 `src/renderer/analytics/types.ts` 的 `EventName` 类型中添加事件名
2. **调用埋点**：在合适的位置调用 `track('event_name', { ... })`
3. **更新文档**：在本文档的「事件清单」章节添加事件说明
4. **类型安全**：如果 params 结构复杂，可在 `types.ts` 中定义 interface

### 3. 埋点原则

- **隐私优先**：不收集对话内容、文件路径、API Key 等敏感信息
- **静默失败**：埋点失败不影响用户体验
- **解耦设计**：埋点代码不应影响主功能逻辑
- **params 规范**：只使用 `string | number | boolean | null`，不嵌套对象

### 4. 代码位置速查

| 文件 | 职责 |
|------|------|
| `src/renderer/analytics/types.ts` | 事件名枚举、参数类型定义 |
| `src/renderer/analytics/tracker.ts` | `track()` 函数实现 |
| `src/renderer/analytics/queue.ts` | 批量上报队列 |
| `src/renderer/analytics/config.ts` | 开关配置 |
| `src/renderer/analytics/device.ts` | 设备 ID、平台检测 |
| `src/server/analytics.ts` | 服务端事件上报（Sidecar 层） |

---

## 1. 概述

### 1.1 目标

为 MyAgents 桌面客户端集成埋点统计能力，上报匿名使用数据到 MyAgents Analytics 服务，帮助了解产品使用情况。

### 1.2 核心原则

1. **开关控制**：通过 `.env` 配置开关，未配置则不上报（适应开源场景）
2. **隐私优先**：仅收集行为数据，不收集对话内容、文件路径等敏感信息
3. **解耦设计**：埋点模块独立于主功能，不影响核心流程
4. **静默失败**：上报失败不影响用户体验，不弹出错误提示

### 1.3 技术约束

- 上报地址：`https://analytics.myagents.io/api/track`
- 需要 `X-API-Key` 鉴权
- 支持批量上报（队列 + 防抖）
- 通过 Rust 代理层发送请求（遵循项目 CORS 规范）

---

## 2. 事件清单

### 2.1 应用生命周期

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `app_launch` | 应用启动完成 | `{ launch_type: "cold", runtimes_active?: string }` | ✅ 已实现 |

> **`runtimes_active`**（采用率快照）：逗号分隔的 distinct **有效外部 runtime** 列表（如 `"codex"` / `"claude-code,codex"`）。gate-aware——`multiAgentRuntime` 关闭时为 `""`（所有 agent 实际跑 builtin）。捕获"已配置但可能从未发过 turn"的 runtime，是 `ai_turn_complete`（只看实际用过的）看不到的采用信号。config 尚未加载时该字段缺省。

### 2.2 会话管理

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `session_new` | 创建新会话 | `{ session_id, tab_id?, triggered_by, entry_intent, runtime, has_initial_message, assistant_entry?, agent_hash }` —— `triggered_by` 是 UI surface，`entry_intent` 是入口语义，`has_initial_message` 来自真实出生上下文；小助理/诊断类会话额外带 `assistant_entry` 细分发起位置；详见 `prd_0.2.36_analytics_entry_funnel_reliability.md` | ✅ 已实现 |
| `session_switch` | Chat 内历史下拉切换到历史会话 | `{ session_id, legacy_compat? }` —— 新版本同时上报 `history_open`，`legacy_compat=true` 仅用于 admin 兼容查询排除双计；旧版本无该标记，可作为 `history_open` 的历史数据 fallback | ✅ 已实现 |
| `session_rewind` | 使用时间回溯 | `{}` | ✅ 已实现 |
| `session_title_edit` | 手动修改会话标题 | `{}` | ✅ 已实现 |
| `session_fork` | 从当前会话 fork 新分支 | `{}` | ✅ 已实现 |

### 2.3 核心交互

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `message_send` | 用户发送消息 | 见下表 | ✅ 已实现 |
| `message_complete` | AI 回复完成 | 见下表 | ✅ 已实现 |
| `message_stop` | 用户主动停止生成 | `{}` | ✅ 已实现 |
| `message_error` | 消息发送/生成失败 | `{}` | ✅ 已实现 |
| `message_retry` | 用户重试 AI 消息 | `{}` | ✅ 已实现 |
| `message_copy` | 用户复制 AI 消息 | `{}` | ✅ 已实现 |
| `message_export` | 用户导出 AI 消息 | `{}` | ✅ 已实现 |
| `thinking_copy` | 用户复制思考过程 | `{}` | ✅ 已实现 |
| `thinking_export` | 用户导出思考过程 | `{}` | ✅ 已实现 |

**`message_send` params：**

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `runtime` | string | **本会话有效 runtime**，与服务端 `ai_turn_complete.runtime` 同口径，桌面漏斗可直接按 runtime 拆而不必 join `session_new`。取值优先用会话**冻结 runtime**（`sessionRuntime`，来自 `chat:system-init`），未知时回退 agent-config 的 `resolveEffectiveRuntime`——这样改了 agent 默认 runtime 后旧会话仍报实际执行的冻结值 | `"builtin"` / `"codex"` / `"claude-code"` / `"gemini"` |
| `mode` | string | 权限模式 | `"auto"` / `"confirm"` / `"deny"` |
| `model` | string | 当前模型 | `"claude-sonnet-4-20250514"` |
| `skill` | string \| null | 技能名称 | `"commit"` / `null` |
| `has_image` | boolean | 是否含图片 | `true` / `false` |
| `has_file` | boolean | 是否含文件 | `true` / `false` |
| `is_cron` | boolean | 是否为心跳循环任务 | `true` / `false` |

**`message_complete` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `runtime` | string | **本会话有效 runtime**，同 `message_send.runtime`（冻结 `sessionRuntime` 优先，回退 agent-config；`builtin` / `codex` / `claude-code` / `gemini`） |
| `model` | string | 模型名称 |
| `input_tokens` | number | 输入 tokens |
| `output_tokens` | number | 输出 tokens |
| `cache_read_tokens` | number | 缓存读取 tokens |
| `cache_creation_tokens` | number | 缓存创建 tokens |
| `tool_count` | number | 工具调用次数 |
| `duration_ms` | number | 响应耗时（毫秒） |

### 2.4 工具使用

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `tool_use` | 工具调用完成 | `{ tool }` | ✅ 已实现 |
| `permission_grant` | 用户授予权限 | `{ tool, type }` | ✅ 已实现 |
| `permission_deny` | 用户拒绝权限 | `{ tool }` | ✅ 已实现 |

### 2.5 配置变更

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `provider_switch` | 切换 AI 供应商 | `{ provider_id }` | ✅ 已实现 |
| `model_switch` | 切换模型 | `{ model }` | ✅ 已实现 |
| `reasoning_effort_switch` | 切换推理强度 | `{ effort }` | ✅ 已实现 |
| `mcp_add` | 添加 MCP 服务 | `{ type }` | ✅ 已实现 |
| `mcp_remove` | 移除 MCP 服务 | `{}` | ✅ 已实现 |
| `agent_add` | 添加 Sub-Agent | `{ scope }` | ✅ 已实现 |
| `agent_remove` | 删除 Sub-Agent | `{ scope }` | ✅ 已实现 |
| `agent_channel_create` | 添加 Agent Channel（飞书 / Telegram / 钉钉 / OpenClaw 插件） | `{ source, platform }` | ✅ 已实现 |
| `agent_channel_remove` | 删除 Agent Channel | `{ source, platform }` | ✅ 已实现 |
| `agent_channel_toggle` | 启停 Agent Channel | `{ platform, enabled }` | ✅ 已实现（GUI 独有） |

**`agent_channel_create` / `agent_channel_remove` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 触发渠道，见 §4.3 — GUI（ChannelWizard / ChannelDetailView）填 `desktop`；CLI（`myagents agent channel add/remove`）由 `cliSource()` 推断 |
| `platform` | string | 渠道类型：`feishu` / `telegram` / `dingtalk` / `openclaw:<plugin>` / `unknown`（兜底） |

**`agent_channel_toggle` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `platform` | string | 渠道类型 |
| `enabled` | boolean | 切换后的目标状态 |

> CLI 当前没有 channel 启停子命令，所以此事件 GUI 独有，不带 `source`。
> 如果未来 CLI 加上等价命令，再扩展为带 `source` 的形式。

### 2.6 功能使用

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `tab_new` | 新建标签页 | `{ tab_count }` | ✅ 已实现 |
| `tab_close` | 关闭标签页 | `{ view, tab_count }` | ✅ 已实现 |
| `restore_last_session` | 启动后恢复上次打开的 Tab | `{ count }` | ✅ 已实现 |
| `settings_open` | 进入设置页 | `{ section }` | ✅ 已实现 |
| `workspace_open` | 从启动页打开新工作区会话 | `{ agent_hash, runtime, entry_intent, has_initial_message, session_id: null, tab_id? }` | ✅ 已实现 |
| `workspace_create` | 创建工作区 | `{ source }` | ✅ 已实现 |
| `history_open` | 从历史相关入口打开目标 session | `{ session_id, agent_hash, runtime, entry_source? }` —— `entry_source` 取值见下表；旧版本无该字段，兼容聚合时仍按 `history_open` 计入 | ✅ 已实现 |
| `file_drop` | 拖拽文件 | `{ file_count }` | ✅ 已实现 |
| `skill_use` | 从面板插入 Skill | `{ skill_name }` | ✅ 已实现 |
| `tts_play` | 播放 TTS 语音 | `{}` | ✅ 已实现 |
| `task_center_open` | 打开任务中心 | `{}` | ✅ 已实现 |
| `bug_report_submit` | 提交 Bug Report | `{ has_screenshot }` | ✅ 已实现 |
| `launcher_mode_switch` | 启动页 对话/想法 模式切换 | 见下表 | ✅ 已实现 |

**`launcher_mode_switch` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `to` | string | 切换到的模式：`"task"`（对话）/ `"thought"`（想法） |
| `via` | string | 触发方式：`"click"`（点击 ModeSegment）/ `"shortcut"`（Tab / Cmd+Shift+T） |

> 启动页是 GUI 独有路径，CLI 不会触发此事件，所以不带 `source` 字段。

**`history_open` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 用户打开的目标 session id，显式传值，不依赖 Active Context |
| `agent_hash` | string \| null | 目标 session 所属工作区的 agent hash |
| `runtime` | string | 目标 session 冻结 runtime，优先读取 session metadata |
| `entry_source` | string \| undefined | 历史入口细分：`launcher_recent`（启动页最近历史）、`launcher_overlay`（启动页全屏历史页/搜索）、`chat_dropdown`（Chat tab 内历史下拉切换）、`chat_dropdown_new_tab`（历史下拉“在新 tab 打开”）、`settings_helper_history`（设置页小助理历史）、`task_run_history`（任务/运行历史打开会话）。旧版本缺省。 |

### 2.7 IM Bot

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `im_bot_create` | 创建旧版 IM Bot | `{ platform }` | ⚠️ legacy enum；当前 Agent Channel 流程使用 `agent_channel_create` |
| `im_bot_toggle` | 启用/禁用旧版 IM Bot | `{ platform, enabled }` | ⚠️ legacy enum；当前 Agent Channel 流程使用 `agent_channel_toggle` |
| `im_bot_remove` | 删除旧版 IM Bot | `{ platform }` | ⚠️ legacy enum；当前 Agent Channel 流程使用 `agent_channel_remove` |

### 2.8 系统事件

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `update_check` | 检查更新 | `{}` | ✅ 已实现 |
| `update_install` | 安装更新 | `{ version }` | ✅ 已实现 |

### 2.9 心跳循环（Cron Task）

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `cron_enable` | 用户开启心跳循环设置 | 见下表 | ✅ 已实现 |
| `cron_start` | 首条消息发送，任务运行 | 见下表 | ✅ 已实现 |
| `cron_stop` | 任务停止 | 见下表 | ✅ 已实现 |
| `cron_recover` | 应用重启恢复任务 | 见下表 | ✅ 已实现 |
| `launcher_cron_stage` | 启动页输入框进入/退出定时任务配置阶段 | `{ stage }` | ✅ 已实现 |
| `launcher_cron_create_standalone` | 启动页创建独立定时任务 | `{ interval_minutes, schedule_kind }` | ✅ 已实现 |

**`cron_enable` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `interval_minutes` | number | 执行间隔（分钟） |
| `run_mode` | string | 运行模式 `"loop"` / `"once_then_stop"` |
| `has_time_limit` | boolean | 是否设置时间限制 |
| `has_count_limit` | boolean | 是否设置次数限制 |
| `notify_enabled` | boolean | 是否开启通知 |

**`cron_start` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `interval_minutes` | number | 执行间隔（分钟） |
| `model` | string | 使用的模型 |
| `provider_type` | string | 供应商类型 `"subscription"` / `"third_party"` |

**`cron_stop` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `reason` | string | 停止原因：`"manual"` / `"time_limit"` / `"count_limit"` / `"ai_exit"` / `"error"` |
| `execution_count` | number | 已执行次数 |
| `duration_minutes` | number | 运行时长（分钟） |

**`cron_recover` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `recovered_count` | number | 成功恢复的任务数 |
| `failed_count` | number | 恢复失败的任务数 |

### 2.10 任务中心（GUI + CLI）

任务中心的写入操作 GUI 和 CLI 都能触发。GUI 走 Tauri `invoke` 直连
Rust Management API，CLI 走 Sidecar `/api/admin/*` → `admin-api.ts` →
Rust。两条路径不重叠，所以 GUI 在渲染层 `track()`，CLI 在 `admin-api.ts`
的 handler 里 `trackServer()`，**不会双计**。

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `task_create` | 创建任务（手动新建 / 从想法派发） | 见下表 | ✅ 已实现 |
| `task_run` | 派发任务执行（首次或 rerun） | 见下表 | ✅ 已实现 |
| `task_stop` | 用户手动中止运行中的任务 | `{ source }` | ✅ 已实现 |
| `task_delete` | 删除任务 | 见下表 | ✅ 已实现 |
| `task_align_discuss` | 「AI 讨论」入口（任务对齐） | `{}` | ✅ 已实现 |

> `task_align_discuss` 是 GUI 独有，仅在 ThoughtCard 点击「AI 讨论」时触发，
> CLI 没有等价命令，所以不带 `source` 字段。

**`task_create` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 触发渠道，见 §4.3 |
| `origin` | string | `"manual"`（直接新建）/ `"thought_dispatch"`（从想法派发，对齐流程） |
| `has_workspace` | boolean | 是否绑定到工作区 |

**`task_run` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 触发渠道，见 §4.3 |
| `run_count` | number \| null | 第几次执行 — `1` = 首次派发，`>1` = 重新派发。值取自 `task.sessionIds.length + 1`。`null` 仅出现在 CLI 路径预读任务记录失败时（罕见，例如 Rust Mgmt API 临时不可达），前端永远填实数。 |

**`task_delete` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 触发渠道，见 §4.3 |
| `status` | string | 删除时任务所处状态（`todo` / `running` / `done` / `archived` / `unknown`） |

### 2.11 想法（Thought）

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `thought_create` | 创建想法 | 见下表 | ✅ 已实现 |

**`thought_create` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 触发渠道，见 §4.3 |
| `location` | string \| null | UI 入口：`"launcher"`（启动页 想法 模式）/ `"task_center"`（任务中心想法流）；CLI 触发时为 `null` |

### 2.12 统一 AI 执行（服务端上报）

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `ai_turn_complete` | AI 完成一轮**成功**响应（覆盖所有来源 + 所有 runtime） | 见下表 | ✅ 已实现 |

> **注意**：此事件在 Node Sidecar 层上报（`src/server/analytics.ts`），不经过前端。
> 覆盖所有 AI 执行来源（桌面对话 / 定时任务 / IM Bot）**和所有 runtime**
> （内置 SDK + Codex / Claude Code / Gemini）。**这是分辨 runtime 实际使用量的唯一权威口径。**
>
> **触发口径 = 成功 turn**：builtin 在空返回（`emptySuccessfulResult`）走 error 分支不上报；
> external 仅在 `turn_complete` / `session_complete` 上报。两条路径都"成功才发"，
> 失败/中断 turn 不计入——做留存/活跃无碍，做"失败率"需另接事件。
>
> 上报点：builtin = `agent-session.ts`（`runtime: 'builtin'` 硬编码）；
> external = `external-session.ts`（`runtime: getCurrentRuntimeType()`，即 sidecar 实际 spawn 的 runtime）。

**`ai_turn_complete` params：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string | 来源：`"desktop"` / `"floating_ball"` / `"cron"` / `"im"`（详见 §4.3 的取值约定） |
| `session_id` | string \| null | SDK Session ID，用于 join 回前端 `session_new` 还原完整漏斗；首 turn 前可能为 `null` |
| `platform` | string \| null | IM 平台：`"telegram"` / `"feishu"` / `null` |
| `runtime` | string | 实际执行 runtime：`"builtin"` / `"codex"` / `"claude-code"` / `"gemini"` |
| `model` | string \| null | 模型名称 |
| `input_tokens` | number | 输入 tokens |
| `output_tokens` | number | 输出 tokens |
| `cache_read_tokens` | number | 缓存读取 tokens |
| `cache_creation_tokens` | number | 缓存创建 tokens |
| `tool_count` | number | 工具调用次数 |
| `duration_ms` | number | 响应耗时（毫秒） |

### 2.13 桌面悬浮球

| 事件名 | 触发时机 | params | 状态 |
|--------|----------|--------|------|
| `floating_ball_toggle` | 开启/关闭悬浮球能力 | `{ gate, enabled }` | ✅ 已实现 |
| `floating_ball_summon` | 唤起悬浮球伴侣窗 | `{ kind }` | ✅ 已实现 |
| `floating_ball_expand` | 展开悬浮球窗口或文件预览 | `{ kind? }` | ✅ 已实现 |
| `floating_ball_pet_select` | 切换悬浮球宠物包 | `{ pet_id, source }` | ✅ 已实现 |

---

## 3. 埋点优先级

### P0 - 必须埋点（核心指标）

用于计算 DAU/MAU、使用深度、Token 消耗：

| 事件 | 用途 |
|------|------|
| `app_launch` | DAU/MAU 计算 |
| `ai_turn_complete` | **统一 AI 执行量**（桌面+定时+IM Bot），Token 消耗 |
| `message_send` | 用户活跃度、模型/技能使用分布、心跳循环占比 |
| `message_complete` | 前端侧 Token 消耗统计 |
| `session_new` | 新会话数 |
| `im_bot_create` | IM Bot 功能采用率 |
| `agent_add` | Sub-Agent 功能采用率 |
| `message_retry` | 重试率 = 回答质量指标 |
| `message_copy` | 输出价值指标 |
| `bug_report_submit` | 问题反馈量 |

### P1 - 重要埋点（功能分析）

用于分析功能使用情况：

| 事件 | 用途 |
|------|------|
| `tool_use` | 工具使用分布 |
| `provider_switch` | Provider 使用分布 |
| `mcp_add` | MCP 功能采用率 |
| `message_error` | 错误率监控 |
| `cron_enable` | 心跳循环功能采用率 |
| `cron_stop` | 心跳循环完成情况分析 |
| `im_bot_toggle` | IM Bot 活跃度 |
| `im_bot_remove` | IM Bot 流失分析 |
| `workspace_create` | 工作区使用模式 |
| `tts_play` | TTS 功能采用率 |
| `session_rewind` | 回溯功能使用频率 |
| `session_title_edit` | 标题功能参与度 |
| `skill_use` | Skill 使用分布 |
| `task_center_open` | 任务中心使用率 |

### P2 - 可选埋点（精细分析）

| 事件 | 用途 |
|------|------|
| `tab_new/close` | 多标签使用情况 |
| `settings_open` | 设置使用情况 |
| `permission_*` | 权限行为分析 |
| `cron_start` | 心跳循环实际启动率 |
| `cron_recover` | 任务恢复可靠性 |
| `agent_remove` | Agent 管理行为 |

---

## 4. 数据字段规范

### 4.1 基础字段（SDK 自动填充）

| 字段 | 来源 | 示例 |
|------|------|------|
| `device_id` | 本地生成的 UUID，持久化存储 | `a1b2c3d4-...` |
| `platform` | 系统检测 | `mac_arm` / `mac_intel` / `win_64` / `linux` |
| `app_version` | 从 Tauri 获取 | `0.1.10` |
| `client_timestamp` | 事件发生时间 | ISO 8601 |

### 4.2 params 字段规范

- 仅使用基本类型：`string` / `number` / `boolean` / `null`
- 不嵌套对象
- 不包含敏感信息：
  - ❌ 对话内容
  - ❌ 文件路径
  - ❌ API Key
  - ❌ 用户自定义 Provider 名称/URL
  - ✅ 数量统计（token 数、工具数、文件数）
  - ✅ 布尔状态（是否成功、是否有附件）
  - ✅ 预设枚举值（provider_type、tool_name）

### 4.3 `source` 字段约定

凡是 **GUI、CLI、定时任务、IM Bot 都可能触发**的事件，都必须带 `source` 字段，
使用统一枚举（类型见 `src/renderer/analytics/types.ts` 的 `Source`）：

| 取值 | 含义 |
|------|------|
| `desktop` | 桌面端 GUI 触发（未来移动端 app 再加 `mobile`） |
| `floating_ball` | 桌面悬浮球伴侣窗触发 |
| `cli` | 用户在终端手动跑 `myagents` 命令 |
| `cli_agent` | AI 子进程通过 CLI 调用 — 通过 `MYAGENTS_PORT` 环境变量识别（见 cli_architecture.md） |
| `cron` | 定时任务调度器 |
| `im` | IM Bot（飞书 / Telegram / 钉钉） |

**不需要带 `source` 的事件**：纯 UI 行为（如 `launcher_mode_switch`、`tab_new`、
`settings_open`、`message_copy`）—— CLI 不可能触发，加了也是噪音。默认渠道
就是 `desktop`，省掉这个字段。

**埋点位置规则**：

| 路径 | 埋点位置 | source 推断 |
|------|---------|-------------|
| GUI（Tauri invoke → Rust 直连） | 渲染层 `track()` | 硬编码 `'desktop'` |
| CLI（Sidecar `/api/admin/*` → admin-api.ts → Rust） | `admin-api.ts` 的 handler 里 `trackServer()` | `cliSource()` helper（按 `MYAGENTS_PORT` 判断 `cli` vs `cli_agent`） |
| 服务端统一事件（如 `ai_turn_complete`） | `agent-session.ts` / `external-session.ts` | 由场景上下文推断（`desktop` / `cron` / `im`） |

**为什么不能只在服务端埋一处**：GUI 的 task / thought 创建走 Tauri 直连
Rust Management API，**不经过 Sidecar 的 admin-api**，所以服务端埋点抓不到 GUI。
两条路径完全不重叠，分两边各自埋反而是最干净的方案。

### 4.4 `surface` / `entry_intent` 字段约定

`session_new.triggered_by` 使用 `Surface`，回答“用户在哪个入口面开始”；
`session_new.entry_intent` 使用 `EntryIntent`，回答“这次入口想做什么”。两者正交，
不要再用 surface 反推 `has_initial_message`。

| 字段 | 常见取值 | 说明 |
|------|----------|------|
| `triggered_by` | `launcher_input` / `agent_card` / `history_click` / `new_chat_button` / `task_center` / `bug_report` / `agent_setup` / `floating_ball` | UI 入口面 |
| `entry_intent` | `send_message` / `open_workspace` / `open_history` / `thought_alignment` / `workspace_init` / `support_diagnostics` / `new_chat` / `fork` / `unknown` | 入口语义 |
| `assistant_entry` | `settings` / `tab_top` / `agent_error` / `support_diagnostics` / `other` | 小助理发起位置，仅 `triggered_by='bug_report'` 或支持诊断类 session 使用 |
| `has_initial_message` | boolean | session 出生时是否真的带首条消息，由 caller 显式传，不再由 surface 猜 |

---

## 5. 配置说明

### 5.1 环境变量

```env
# 埋点开关（不配置或为空则不上报）
VITE_ANALYTICS_ENABLED=true
VITE_ANALYTICS_API_KEY=your-api-key
VITE_ANALYTICS_ENDPOINT=https://analytics.myagents.io/api/track
```

### 5.2 服务端上报

前端在 `initAnalytics()` 时将配置写入 `~/.myagents/analytics_config.json`。
Node Sidecar 通过 `src/server/analytics.ts` 读取该文件，使用独立队列（3s 防抖）直接 `fetch()` 上报。
如果 Sidecar 先于前端配置文件启动，server 端会把早期事件放入 30s 短 TTL pending queue，
配置出现后再补发；如果配置明确 disabled，则直接 no-op。

### 5.3 队列机制

**前端**：防抖 500ms、队列满 50 条立即发送、页面隐藏/关闭时 flush。
**服务端**：防抖 3s、队列满 30 条立即发送。

---

## 6. 埋点位置速查

| 事件 | 埋点文件 | 触发位置 |
|------|----------|----------|
| `app_launch` | `App.tsx` | 应用挂载完成 |
| `ai_turn_complete` | `agent-session.ts` (服务端) | `broadcast('chat:message-complete')` 旁 |
| `message_send` | `TabProvider.tsx` | `sendMessage` 函数成功后 |
| `message_complete` | `TabProvider.tsx` | SSE `chat:message-complete` 事件 |
| `message_stop` | `TabProvider.tsx` | SSE `chat:message-stopped` 事件 |
| `message_error` | `TabProvider.tsx` | SSE `chat:message-error` 事件 |
| `message_retry` | `Chat.tsx` | `handleRetry` rewind 成功后 |
| `message_copy` | `Message.tsx` | AssistantActions 复制按钮 |
| `message_export` | `Message.tsx` | AssistantActions 导出按钮 |
| `session_new` | `TabProvider.tsx` | `loadSession` 新会话时 |
| `session_switch` | `Chat.tsx` | Chat 内历史下拉切换时（兼容旧报表；新版同时打 `history_open`） |
| `session_rewind` | `Chat.tsx` | `handleRewindConfirm` |
| `session_title_edit` | `Chat.tsx` | `SessionTitleEditor.commit` |
| `session_fork` | `Chat.tsx` | `handleForkSession` |
| `thinking_copy` | `ProcessRow.tsx` | 思考过程复制按钮 |
| `thinking_export` | `ProcessRow.tsx` | 思考过程导出按钮 |
| `tool_use` | `TabProvider.tsx` | SSE 工具调用事件 |
| `permission_*` | `TabProvider.tsx` | `respondPermission` 函数 |
| `provider_switch` | `Chat.tsx` | Provider 选择变更 |
| `model_switch` | `Chat.tsx` | Model 选择变更 |
| `reasoning_effort_switch` | `Chat.tsx` | 推理强度选择变更 |
| `mcp_add/remove` | `Settings.tsx` | MCP 添加/删除 |
| `agent_add` | `GlobalAgentsPanel.tsx` / `WorkspaceAgentsList.tsx` | Agent 创建成功 |
| `agent_remove` | `AgentDetailPanel.tsx` | Agent 删除成功 |
| `skill_use` | `AgentCapabilitiesPanel.tsx` | 面板点击 Skill |
| `im_bot_create` | `ImBotWizard.tsx` | Wizard 完成 |
| `im_bot_toggle` | `ImBotList.tsx` / `ImBotDetail.tsx` | 启停 Bot |
| `im_bot_remove` | `ImBotDetail.tsx` | 删除 Bot |
| `tab_new/close` | `App.tsx` | Tab 操作 |
| `restore_last_session` | `App.tsx` | 启动恢复上次打开的 tabs |
| `settings_open` | `App.tsx` | 设置页打开 |
| `workspace_open` | `App.tsx` | Launcher 项目选择 |
| `workspace_create` | `Launcher.tsx` | 从模板创建工作区 |
| `history_open` | `App.tsx` | 历史相关入口打开已有 session |
| `file_drop` | `useFileDropZone.ts` | 文件拖放 |
| `tts_play` | `AudioPlayerBar.tsx` | 音频 `onPlay` |
| `task_center_open` | `Launcher.tsx` | 打开任务中心 |
| `bug_report_submit` | `BugReportOverlay.tsx` | 提交 Bug Report |
| `update_*` | `useUpdater.ts` | 更新相关 |
| `cron_enable` | `Chat.tsx` | 心跳设置确认 |
| `cron_start` | `useCronTask.ts` | 任务首次执行 |
| `cron_stop` | `useCronTask.ts` | 任务停止 |
| `cron_recover` | `App.tsx` | 应用启动恢复 |
| `launcher_cron_stage` | `BrandSection.tsx` | 启动页输入框定时模式阶段切换 |
| `launcher_cron_create_standalone` | `Launcher.tsx` | 启动页创建独立定时任务 |
| `task_create` (GUI) | `TaskListPanel.tsx` / `TaskCenter.tsx` | DispatchTaskDialog `onDispatched` 回调 |
| `task_create` (CLI) | `admin-api.ts` | `handleTaskCreateDirect` / `handleTaskCreateFromAlignment` 成功后 |
| `task_run` (GUI) | `TaskListPanel.tsx` | `handleRun` / `handleRerun` |
| `task_run` (CLI) | `admin-api.ts` | `handleTaskRun` / `handleTaskRerun` 成功后 |
| `task_stop` (GUI) | `TaskListPanel.tsx` | `handleStop` |
| `task_stop` (CLI) | `admin-api.ts` | `handleTaskUpdateStatus`，仅当 status='stopped' |
| `task_delete` (GUI) | `TaskListPanel.tsx` | `handleDelete`，确认对话框后 |
| `task_delete` (CLI) | `admin-api.ts` | `handleTaskDelete` 成功后 |
| `task_align_discuss` | `TaskCenter.tsx` | `handleDiscuss` 派出 OPEN_AI_DISCUSSION 事件前 |
| `launcher_mode_switch` | `BrandSection.tsx` | `setModeAndFocus` — 通过 `modeRef` 比对避免重复触发 |
| `thought_create` (GUI) | `ThoughtInput.tsx` | `handleSubmit` 中 `thoughtCreate` 成功后；location 由 `variant` prop 推断 |
| `thought_create` (CLI) | `admin-api.ts` | `handleThoughtCreate` 成功后；location=null |
| `agent_channel_create` (GUI) | `ChannelWizard.tsx` | 三处成功路径（启动后 / 扫码登录后 / 配置完成后） |
| `agent_channel_create` (CLI) | `admin-api.ts` | `handleAgentChannelAdd` 成功后 |
| `agent_channel_remove` (GUI) | `ChannelDetailView.tsx` | `executeDelete` 中 `patchAgentConfig` 成功后 |
| `agent_channel_remove` (CLI) | `admin-api.ts` | `handleAgentChannelRemove`，预读 platform 后再 modify |
| `agent_channel_toggle` | `ChannelDetailView.tsx` | `toggleChannel` 启/停成功路径 |
| `floating_ball_toggle` | `Settings.tsx` / `FloatingBallPetSettings.tsx` | 悬浮球能力开关 |
| `floating_ball_summon` | `CompanionWindow.tsx` | pin / wheel / screenshot 唤起 |
| `floating_ball_expand` | `CompanionWindow.tsx` | 展开窗口 / 文件预览 |
| `floating_ball_pet_select` | `FloatingBallPetSettings.tsx` | 选择宠物包 |

---

## 7. 验收标准

1. ✅ `.env` 未配置时，不发送任何请求
2. ✅ `.env` 配置后，正确上报事件
3. ✅ 批量上报正常工作（防抖 + 队列满发送）
4. ✅ 上报失败不影响用户正常使用
5. ✅ 不上报任何敏感信息
6. ✅ 代码与主功能解耦，可独立删除

---

## 8. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v0.1.8 | 2025-01 | 初始埋点系统实现 |
| v0.1.10 | 2025-02 | 新增心跳循环相关事件、`message_send` 增加 `is_cron` 字段 |
| v0.1.37 | 2025-03 | 新增 15 个事件 + 服务端 `ai_turn_complete` 统一 AI 执行指标 |
| v0.2.0 | 2026-04 | 新增 §4.3 `source` 字段约定（`desktop` / `cli` / `cli_agent` / `cron` / `im`），覆盖任务中心 + 想法输入。新增事件：`task_create`、`task_run`、`task_stop`、`task_delete`、`task_align_discuss`、`launcher_mode_switch`、`thought_create`。CLI 端在 `admin-api.ts` 通过 `cliSource()` helper 推断 `cli` vs `cli_agent`；`task_run` 通过 `fetchTaskSessionCount()` 在执行前预读 `sessionIds.length` 以保证 `run_count` 在 GUI/CLI 两端语义一致。|
| v0.2.0 | 2026-04 | 补登 `agent_channel_create` / `agent_channel_remove` / `agent_channel_toggle` 三个事件 — 此前已在 GUI 调用但未注册到 `EventName` 也未进文档。前两者按 §4.3 约定补 `source` 字段，CLI handler 也加上 `trackServer`；toggle 暂为 GUI 独有，CLI 加 enable/disable 子命令时再扩展。|
| v0.2.29 | 2026-06 | **Runtime 维度对齐**：文档补登 `ai_turn_complete` 实际已上报的 `runtime` / `session_id` / `cache_*` 字段（此前表里缺失 → 数仓易漏建 runtime 维度，这是"看不到 runtime"的根因）；`message_send` / `message_complete` 新增 `runtime` 字段，桌面漏斗可直接按 runtime 拆；`app_launch` 新增 `runtimes_active` 采用率快照。前端统一改用 `resolveEffectiveRuntime()`（gate-aware），消除 `session_new`（曾报"配置 runtime"）与 `ai_turn_complete`（报"实际 runtime"）在 `multiAgentRuntime` 关闭时的口径打架。helper 落在 `src/shared/types/runtime.ts`，与 Rust `resolve_agent_runtime_from_config` 同源，配单测。措辞修正：Bun→Node Sidecar。|
| v0.2.36 | 2026-06 | **入口漏斗可靠性**：`session_new` 新增 `entry_intent` / `tab_id`，`has_initial_message` 改为真实出生上下文；`workspace_open` 明确 pre-session 字段，`history_open.session_id` 改为目标 session；补齐已实现但文档缺失的事件，并增加静态 registry 测试防止类型 / 文档漂移；server `trackServer()` 增加短 TTL pending queue，减少 Sidecar 早于配置文件启动时的首 turn 丢点。|
| v0.2.36 | 2026-06 | **历史入口兼容口径**：`history_open` 增加 `entry_source`，覆盖启动页最近历史、全屏历史页、Chat 内历史切换、历史下拉新 tab、小助理历史和任务运行历史；`session_switch` 保留给旧消费者，并在新版 Chat 切换路径加 `legacy_compat=true`，供 admin 报表排除双计、仅把旧版未标记 `session_switch` 当 fallback。|
