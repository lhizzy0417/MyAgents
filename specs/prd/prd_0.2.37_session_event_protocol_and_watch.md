---
title: "PRD 0.2.37 - Session Event Protocol 与跨 Session Watch"
version: "0.2.37"
status: draft
created: 2026-06-20
updated: 2026-06-20
owner: product-engineering
related_issue: "https://github.com/hAcKlyc/MyAgents/issues/374"
scope:
  - "统一 session send / watch 的系统推送协议"
  - "新增简化版 myagents session watch <sessionId>"
  - "优化 session send 的 AI 可见 prompt 结构"
  - "修正 headless session turn 的 owner 生命周期"
non_scope:
  - "cron 轮询 session 文件或 unified log"
  - "watch 后追加 then-prompt / then-prompt-file"
  - "新增独立跨 session RPC 模型"
---

# PRD 0.2.37 - Session Event Protocol 与跨 Session Watch

## 执行须知（给空 session 的你）

这份 PRD 是完整上下文。开始开发前必须先读：

- `AGENTS.md`
- `specs/ARCHITECTURE.md`
- `specs/tech_docs/session_architecture.md`
- `specs/tech_docs/cli_architecture.md`
- `specs/tech_docs/multi_agent_runtime.md`
- `specs/tech_docs/pit_of_success.md`

开发时重点从这些代码入口向内读，不要凭记忆改：

- `src/cli/myagents.ts`
- `src/server/system-prompt-cli-tools.ts`
- `src/server/admin-api.ts`
- `src/server/index.ts`
- `src/server/inbox/admin-handler.ts`
- `src/server/inbox/drain-handler.ts`
- `src/server/inbox/reply-deliver.ts`
- `src/server/inbox/types.ts`
- `src/server/agent-session.ts`
- `src/server/runtimes/external-session.ts`
- `src-tauri/src/inbox/deliver.rs`
- `src-tauri/src/sidecar.rs`

本需求属于跨 session / CLI / Sidecar 生命周期 / external runtime 分流改动。实现时必须复用现有 `session send`、inbox delivery、`BackgroundCompletion`、`/api/session-state`、external runtime inbox result 机制；除非先和用户重新讨论，不要另起 cron、文件轮询、日志 grep、独立 watcher 进程或新的 sidecar owner 类型。

## 背景

GitHub issue #374 提出一个真实工作流：

> A session 的任务依赖 B session 的完成结果；希望 A 能监控 B，等 B 完成后自动继续。

issue 里给出的 workaround 是让 A 用 cron 轮询 B 的 session JSONL、mtime、`HEARTBEAT_OK` 或 unified log 的 `terminal_reason`，再把依赖关系写入一个 `session-dependencies.json`。这说明需求成立，但实现方向不符合 MyAgents 架构：

- session 是否完成是 live sidecar / turn lifecycle 状态，不是文件 mtime。
- unified log 是诊断渠道，不是业务协议。
- cron 最小粒度、token 开销和脚本状态都会让体验变差。
- 让 AI 自己读内部存储格式会把产品协议泄漏给 prompt。

MyAgents 已经有一套更接近正确答案的能力：`myagents session send`。它把信息投递给另一个 session，被投递 session 完成该 turn 后，系统会把结果异步推送回源 session。新的 `watch` 需求和它属于同一个问题族：不是引入新的通讯模型，而是复用“系统推送 session 事件”的能力，只增加一个新的触发状态：目标 session 当前或最近一轮工作完成。

## 目标

1. 建立统一的 MyAgents Session Event Protocol v1，替代当前分散的 `<inbox-message>` / `<inbox-reply>` prompt 形态。
2. 保持 `session send` 的本质：fire-and-forget 投递；默认由系统在目标 turn 完成后自动把结果推回源 session；`--no-reply` 表示单向通知，不推回结果。
3. 新增简化版 `myagents session watch <sessionId>`：
   - 目标正在运行时，监听该 session 当前工作完成，并把最新结果推送给当前 session。
   - 目标已经 idle 时，立即返回/推送 `already_idle` 事件，并附带目标最近一轮结果。
   - watch 不向目标 session 发送新任务。
4. 修正当前 inbox delivery 对死亡/无 tab session 的 owner 生命周期处理，避免 ownerless sidecar，同时复用现有后台任务 owner 模型。
5. 对 builtin SDK runtime 和 external runtimes 保持语义一致。

## 非目标

- 不实现 `myagents session watch <sessionId> --then-prompt-file <path>`。
- 不实现 `--then`、`--then-file`、`--then-prompt` 等“watch 完成后追加 prompt”能力。
- 不让 AI 通过 cron、JSONL、mtime、unified log、私有状态文件判断 session 完成。
- 不把 `session send` 改成同步 RPC 或“互相 send message”的模型。
- 不新增任意外部可见的 session 状态存储格式给 AI 直接消费。

## 现有实现 Ground Truth

### `session send`

CLI 入口在 `src/cli/myagents.ts`：

- `myagents session send <sessionId> -p "<prompt>"`
- `myagents session send <sessionId> --prompt-file <path>`
- `--no-reply` 表示不期待结果推回。

Admin API 在 `src/server/admin-api.ts` 和 `src/server/index.ts` 里路由到 `src/server/inbox/admin-handler.ts`。handler 构造 `PendingInboxMessage` 后，通过 Rust management API 投递到目标 session。

目标 sidecar 的 `/api/inbox/drain` 会把消息转成 user message 注入对应 runtime：

- builtin 走 `enqueueUserMessage(..., inboxMeta)`
- external 走 `sendExternalMessage(..., { inboxMeta })`

目标 turn 结束时：

- builtin 在 `src/server/agent-session.ts` 根据 `currentTurnInboxMeta` 调 `deliverInboxReply(...)`
- external 在 `src/server/runtimes/external-session.ts` 的 turn finalize 路径里调 `deliverInboxReply(...)`

因此 `session send` 的关键语义不是同步回复，而是：

> A 投递请求给 B；B 正常完成一个 turn；MyAgents 系统把 B 的最终结果异步推送回 A。

### 当前 AI 可见 prompt

目前目标 session 看到：

```xml
<inbox-message from="..." reply_back="true">
...
</inbox-message>
```

源 session 收到：

```xml
<inbox-reply from="..." in_reply_to="...">
...
</inbox-reply>
```

这两个名字容易让 AI 误解成“互相手动 reply”，并且 watch 继续添加新 tag 会让跨 session 协议越来越散。

### Owner 生命周期问题

`src-tauri/src/inbox/deliver.rs` 当前为死掉的目标 session 拉起 sidecar 时，会添加一个临时 `SidecarOwner::Tab("inbox-deliver-...")`。投递结束后它调用局部的 `release_transient_owner`，直接 `sidecar.remove_owner(owner)`，如果这是最后一个 owner，会让 sidecar 以 ownerless 状态继续存在，以免刚投递的 turn 被立刻停掉。

这保住了功能，但不是正确 owner 模型。项目已经有 `SidecarOwner::BackgroundCompletion(session_id)` 和 `start_background_completion`：它表示“这个 session 没有 tab，但有后台 turn 需要等到 idle/error 后才能释放”。新实现应把 `session send`、watch delivery、无 tab 源 session 被唤醒后的 turn，都纳入这条 canonical owner lifecycle。

## 产品语义

### `session send`

`send` 用于让另一个 session 做新工作或收到通知。

默认行为：

1. 当前 session A 执行：

   ```bash
   myagents session send <sessionId> -p "<prompt>"
   ```

2. MyAgents 把 `send.request` 事件投递给目标 session B。
3. B 在自己的上下文里处理该请求。
4. B 本轮 turn 完成后，MyAgents 系统自动把 B 的最终结果作为 `send.result` 推送回 A。

`--no-reply` 行为：

1. 当前 session A 执行：

   ```bash
   myagents session send <sessionId> -p "<prompt>" --no-reply
   ```

2. B 收到 `send.request`，但事件会明确说明这是 one-way request / notification。
3. MyAgents 不把 B 的本轮结果推回 A。

注意：

- B 不需要手动调用 `myagents session send` 来“回信”。
- 但协议不要在 prompt 里写冗余禁止句。只需要把系统自动推送语义描述清楚。
- 如果 B 自己确实要让其他 session 做新工作，它仍然可以主动使用 `session send`。

### `session watch`

`watch` 用于当前 session 依赖另一个 session 的工作，或者用户希望当前 session 监听另一个 session。

命令只有一个：

```bash
myagents session watch <sessionId>
```

语义：

- 如果目标 session 正在 `running` / `starting`，watch 观察目标 session 在注册时已经存在的当前工作。目标完成后，MyAgents 把 `watch.completed` 推送回当前 session。
- 如果目标 session 在注册时已经 `idle`，watch 不创建长期 watcher，立即给当前 session 一个 `watch.already_idle` 事件，并附带目标最近一轮结果。
- 如果目标 session 不存在、不可达、超时或最终失败，推送/返回 `watch.error`，并尽量附带最新已知结果。
- `watch` 不向目标 session 发送新任务。需要让目标做新工作时使用 `send`。

为什么不支持 `--then-prompt-file`：

- 当前 session 是连续会话，用户“等 B 做完后继续 X”的上下文已经在 A 的历史里。
- 系统只需要把 B 的完成事件和最新结果推给 A，A 会在新的 turn 里结合原历史继续推理。
- 过早加入 then prompt 会制造第二套任务注入语义，增加误触发、重复上下文和审计复杂度。

## System Prompt 设计

将现有 `<myagents-session-inbox>` 更新为更通用的 `<myagents-session-events>`。文案保持 skill-like：说明工具能做什么、何时用、怎么用，不写实现细节。

目标文案：

```xml
<myagents-session-events>
MyAgents provides cross-session push and watch capabilities through the `myagents` CLI; run these commands from your shell/Bash tool.

Use `myagents session send` when another session should do new work or receive a notification:

  myagents session send <sessionId> -p "<prompt>"
  myagents session send <sessionId> --prompt-file <path>

By default, MyAgents pushes the target turn result back to this session. Add `--no-reply` for one-way delivery.

Use `myagents session watch` when this session depends on another session's work or the user asks you to monitor another session's current/latest result:

  myagents session watch <sessionId>

`watch` observes the target session; it does not ask the target session to do new work. Use `send` for new work.

You may receive `<myagents-session-event>` blocks. Treat them as system-delivered events and follow their payload.
</myagents-session-events>
```

实现位置：

- `src/server/system-prompt-cli-tools.ts`
- `src/server/admin-api.ts` 中 CLI help / tool capability 文案需要同步。

## Session Event Protocol v1

### 核心原则

所有跨 session 系统推送统一使用一个 AI 可见 envelope：

```xml
<myagents-session-event version="1" type="...">
<event-summary>
...
</event-summary>
<payload>
...
</payload>
</myagents-session-event>
```

协议分两层：

- 传输层：Rust / Sidecar 内部传递结构化 event object。
- Prompt 层：由一个中心 renderer 把 event object 渲染成 AI 可见 block。

不要在多个文件里手写 XML 字符串。新增一个中心 helper，例如：

- `renderSessionEventPrompt(event)`
- `sanitizeSessionEventAttribute(value)`
- `neutralizeSessionEventStructuralTags(value)`

payload 必须防止结构性 tag 注入。需要 neutralize 或 escape：

- `<myagents-session-event`
- `</myagents-session-event>`
- `<event-summary`
- `</event-summary>`
- `<payload`
- `</payload>`
- `<latest-result`
- `</latest-result>`

属性值必须统一 sanitize，不能直接插入 title、session label、error code 或外部 runtime 文本。

### 通用字段

建议内部 event object 使用这些字段。实现可以根据现有类型渐进落地，但 AI 可见 prompt 必须统一。

```ts
type SessionEventType =
  | 'send.request'
  | 'send.result'
  | 'watch.already_idle'
  | 'watch.completed'
  | 'watch.error';

interface SessionEventBase {
  version: 1;
  type: SessionEventType;
  eventId: string;
  createdAt: string;
  sourceSessionId?: string;
  sourceLabel?: string;
  targetSessionId?: string;
  targetLabel?: string;
}
```

字段方向约定：

- 对 `send.request`，source 是发起 send 的 session，target 是收到请求的 session。
- 对 `send.result`，source 是产生结果的目标 session，target 是收到系统推送的原发起 session。
- 对 `watch.*`，source 是被 watch 的 session，target 是收到 watch 事件的 watcher session。

### `send.request`

目标 session B 收到 A 的请求时看到：

```xml
<myagents-session-event
  version="1"
  type="send.request"
  event_id="evt_abc123"
  source_session_id="A-session-id"
  source_label="A 的会话标题"
  target_session_id="B-session-id"
  source_notification="auto"
  created_at="2026-06-20T12:00:00.000Z">
<event-summary>
Another MyAgents session sent this session a request. Work on it normally in this session. When this turn finishes, MyAgents will automatically deliver this turn's final result back to the source session.
</event-summary>
<payload>
用户希望你基于当前实现再加一轮 deepseek 验证。
</payload>
</myagents-session-event>
```

`--no-reply` 时：

```xml
<myagents-session-event
  version="1"
  type="send.request"
  event_id="evt_abc123"
  source_session_id="A-session-id"
  source_label="A 的会话标题"
  target_session_id="B-session-id"
  source_notification="none"
  created_at="2026-06-20T12:00:00.000Z">
<event-summary>
Another MyAgents session sent this session a one-way request or notification. The source session will not automatically receive this turn's final result.
</event-summary>
<payload>
这个 context 只需要记录一下，不用主动反馈给发起 session。
</payload>
</myagents-session-event>
```

### `send.result`

源 session A 收到 B 的自动结果推送时看到：

```xml
<myagents-session-event
  version="1"
  type="send.result"
  event_id="evt_result_456"
  source_session_id="B-session-id"
  source_label="B 的会话标题"
  target_session_id="A-session-id"
  request_event_id="evt_abc123"
  status="ok"
  terminal_reason="completed"
  created_at="2026-06-20T12:05:00.000Z">
<event-summary>
MyAgents automatically delivered the final result of the target session turn triggered by your previous `session send` request.
</event-summary>
<payload>
B 的完整 assistant 输出内容...
</payload>
</myagents-session-event>
```

失败时：

```xml
<myagents-session-event
  version="1"
  type="send.result"
  event_id="evt_result_456"
  source_session_id="B-session-id"
  source_label="B 的会话标题"
  target_session_id="A-session-id"
  request_event_id="evt_abc123"
  status="error"
  error_code="turn_failed"
  terminal_reason="error"
  created_at="2026-06-20T12:05:00.000Z">
<event-summary>
MyAgents attempted to deliver the final result of the target session turn triggered by your previous `session send` request, but that turn did not complete successfully.
</event-summary>
<payload>
external runtime turn did not complete successfully
</payload>
</myagents-session-event>
```

### `watch.already_idle`

watch 注册时目标已经 idle：

```xml
<myagents-session-event
  version="1"
  type="watch.already_idle"
  event_id="evt_watch_001"
  watch_id="watch_abc123"
  source_session_id="B-session-id"
  source_label="B 的会话标题"
  target_session_id="A-session-id"
  target_state_at_registration="idle"
  created_at="2026-06-20T12:10:00.000Z">
<event-summary>
The target session was already idle when this watch was registered, so no long-running watcher was created.
</event-summary>
<payload>
<latest-result>
B 最近一轮 assistant 输出内容...
</latest-result>
</payload>
</myagents-session-event>
```

这条事件允许包含一个低噪音提示：如果需要让目标 session 做新工作，应使用 `myagents session send`。但不要在 payload 前后塞长篇教学；系统 prompt 已经解释了工具用法。

### `watch.completed`

目标在 watch 注册后完成：

```xml
<myagents-session-event
  version="1"
  type="watch.completed"
  event_id="evt_watch_002"
  watch_id="watch_abc123"
  source_session_id="B-session-id"
  source_label="B 的会话标题"
  target_session_id="A-session-id"
  target_state_at_registration="running"
  final_state="idle"
  terminal_reason="completed"
  created_at="2026-06-20T12:12:00.000Z">
<event-summary>
The watched target session has finished the turn that was active when this watch was registered.
</event-summary>
<payload>
<latest-result>
B 刚完成这一轮的 assistant 输出内容...
</latest-result>
</payload>
</myagents-session-event>
```

### `watch.error`

目标不可达、超时、异常或无法确认正常完成：

```xml
<myagents-session-event
  version="1"
  type="watch.error"
  event_id="evt_watch_003"
  watch_id="watch_abc123"
  source_session_id="B-session-id"
  source_label="B 的会话标题"
  target_session_id="A-session-id"
  target_state_at_registration="running"
  final_state="timeout"
  terminal_reason="watch_timeout"
  created_at="2026-06-20T12:40:00.000Z">
<event-summary>
MyAgents could not confirm normal completion for the watched target session.
</event-summary>
<payload>
<latest-result>
如果有最新已知结果，放在这里；没有则给出结构化 no-result 描述。
</latest-result>
</payload>
</myagents-session-event>
```

## CLI / Admin API 设计

### CLI 命令

新增：

```bash
myagents session watch <sessionId>
```

保留：

```bash
myagents session send <sessionId> -p "<prompt>"
myagents session send <sessionId> --prompt-file <path>
myagents session send <sessionId> -p "<prompt>" --no-reply
```

实现要求：

- `watch` 不接受 prompt 相关参数。
- `watch` 不接受 `--then-*` 参数。
- `send` 的 prompt 文件大小、inline prompt 限制沿用当前实现。
- CLI help 必须把 `send` / `watch` 区分清楚。
- 修改 CLI surface 后检查并按现有规范 bump `CLI_VERSION`。
- 检查 Rust 侧允许的 CLI command group / admin command 白名单是否包含 `session` 及新增 action。

### CLI 输出

面向 AI 的 CLI 输出要低噪音但可操作：

- `session send` 成功投递：打印简短投递结果，说明如果未使用 `--no-reply`，结果会由 MyAgents 系统异步推送回来。
- `session watch` 注册成功：打印 `watch_id`、目标 session、注册时状态。
- `session watch` 遇到 already idle：可以直接打印 `watch.already_idle` event block，或打印结构化 result 并确保同一个 event 也投递给当前 session。实现时选择一种，不要让 AI 既在 CLI stdout 读一遍，又在下一 turn 收到一遍完全重复且不区分来源的内容。
- `--json` 保持机器可读。

推荐策略：

- CLI stdout 只报告 command accepted / registered。
- session 内容统一通过 session event 推送进入对话。
- already idle 因为没有异步等待，也可以同步返回 event；但如果同步返回 event，就不要再重复注入同一事件，除非产品明确需要“双通道可见”。

### Admin API

新增或扩展内部 Admin API：

- `session/send` 保持现有语义，但内部构造 `send.request` event。
- 新增 `session/watch`，参数至少包含：
  - `targetSessionId`
  - `sourceSessionId` / caller session identity
  - optional `sourceLabel`

返回值建议：

```ts
interface SessionWatchAccepted {
  success: true;
  watchId: string;
  targetSessionId: string;
  targetStateAtRegistration: 'starting' | 'running' | 'idle' | 'error' | 'unknown';
  delivery: 'registered' | 'already_idle_delivered' | 'error_delivered';
}
```

## Watch 状态来源

禁止使用：

- session JSONL mtime
- assistant message 是否为空
- unified log grep
- `HEARTBEAT_OK`
- AI 自己维护的 `session-dependencies.json`

允许并推荐使用：

- live `/api/session-state`
- `SessionStore` / 持久 session metadata 里的最近 assistant result
- turn finalize hook 捕获的 result / error / attachment hints
- Rust sidecar manager 已有的 `check_sidecar_session_state`
- `BackgroundCompletion` poller 的状态转移经验

如果现有 `/api/session-state` 不足以精确表达 watch 所需状态，可以在同一架构内补充只读字段，例如：

- `activeTurnId`
- `lastCompletedTurnId`
- `lastTerminalReason`
- `lastAssistantResultRef`

但 v1 不强制引入完整 turn id 模型。最低要求是：watch 注册时记录目标状态，目标从 running/starting 转为 idle/error 后，用权威 session result 源读取最新结果。

## Owner 生命周期设计

### 现状问题

当前 `deliver_with_resume` 为 dead target session 临时拉起 sidecar 后，直接移除临时 owner，故意留下 ownerless sidecar 让刚投递的 turn 能继续跑。这是局部修补，不符合 Sidecar Owner 模型：

- sidecar 应由 `Tab`、`CronTask`、`BackgroundCompletion`、`Agent` 之一持有。
- 没有 owner 的 sidecar 不应长期存活。
- 后台 turn 应通过 `BackgroundCompletion` 表达，而不是“移除 owner 但不 stop”。

### 目标模型

将 `BackgroundCompletion` 语义推广为：

> 任何没有 foreground tab 但必须等一个 session turn 完成的 headless work，都由 `SidecarOwner::BackgroundCompletion(session_id)` 持有，完成或失败后通过 canonical release 路径释放。

适用场景：

- `session send` 投递给没有 tab 的目标 session。
- `session send` 默认 notify 时，目标完成后需要唤醒没有 tab 的源 session 接收 `send.result`。
- `session watch` 完成后需要唤醒没有 tab 的 watcher session 接收 `watch.completed`。
- `watch.already_idle` 需要把事件注入没有 tab 的 watcher session。

实现要求：

1. 投递事件前可以短暂使用 transient owner 确保 sidecar 存活。
2. 一旦事件被目标 sidecar 接受并会触发一个 turn，必须为该 session 注册/启动 `BackgroundCompletion` owner。
3. transient owner 释放必须走 canonical `release_session_sidecar` 或等价路径，不得直接 `remove_owner` 后留下 ownerless sidecar。
4. `BackgroundCompletion` poller 负责等到 `idle` / `error` / timeout 后释放 owner。
5. 复用现有 `start_background_completion` 能力；只有在现有函数无法表达“刚注入一个 headless event”的情况下，才新增小的 helper，不新增 owner enum variant。
6. 如果实现过程中发现必须新增 owner type，应暂停并与用户讨论。

## Runtime 兼容

本需求必须同时覆盖 builtin SDK 和 external runtimes。

### Builtin SDK

- `send.request` / watch event 注入走现有 `enqueueUserMessage`。
- `send.result` 继续在 turn-end 处由 `currentTurnInboxMeta` 或新 session-event meta 触发。
- abort / error 路径必须仍能产生 `send.result status="error"`，不能静默丢失。

### External runtime

- `send.request` / watch event 注入走 `sendExternalMessage`。
- `send.result` 继续在 `persistTurnResult` 或等价 finalize 路径里产生。
- 成功判定不能只看 `waitForSessionIdle`，必须沿用 multi-agent runtime 文档里“真 turn 成功”的 gate，例如 external 的 `didLastTurnSucceed` / captured error。

### 事件 meta

当前 `InboxTurnMeta` 只表达 replyBack。建议演进为更通用的 turn event meta，例如：

```ts
interface SessionEventTurnMeta {
  sourceEventId: string;
  sourceSessionId: string;
  sourceLabel?: string;
  targetSessionId: string;
  resultPolicy: 'auto_notify_source' | 'none';
  resultEventType: 'send.result';
  originalSnippet?: string;
}
```

为了降低风险，也可以先保留 `InboxTurnMeta` 内部名字，但 AI 可见协议必须切到 `send.request` / `send.result`。如果保留旧名字，需要在代码注释里明确它是 legacy internal naming，不是产品协议。

## 数据与持久化

v1 不需要新增长期用户可编辑配置文件。

watch 注册状态可以是内存态，因为它依赖 live sidecar 状态；应用重启后 active watch 可以丢失，除非后续产品明确要做“持久依赖图”。

如需跨短暂 sidecar 重启保留 watcher，可以使用已有 session manager 内存结构，由 Rust sidecar manager 持有：

```ts
interface PendingSessionWatch {
  watchId: string;
  watcherSessionId: string;
  targetSessionId: string;
  targetStateAtRegistration: string;
  createdAt: string;
}
```

不要写 `~/.myagents/session-dependencies.json` 作为 v1 方案。

## 实施计划

### Phase 1 - 协议渲染与 system prompt

- 新增中心 `renderSessionEventPrompt(event)` helper。
- 补齐 attribute sanitize 和 structural tag neutralize。
- 将 `drain-handler.ts` 的 `<inbox-message>` 渲染迁移为 `send.request`。
- 将 `reply-deliver.ts` / reply 注入路径迁移为 `send.result`。
- 更新 `system-prompt-cli-tools.ts` 文案为 `<myagents-session-events>`。
- 同步 `admin-api.ts` help 文案。

### Phase 2 - `session watch` CLI / Admin API

- 在 CLI parser 中新增 `session watch <sessionId>`。
- 新增 `session/watch` Admin API route。
- 实现 target session lookup、状态读取、already idle 分支和 running watch 注册。
- CLI 输出保持低噪音并支持 `--json`。
- 检查并更新 CLI version gate / command group 白名单。

### Phase 3 - Watch registration and completion delivery

- Rust management API 只负责读取目标 live `/api/session-state` 并把 watcher 注册到目标 sidecar。
- 目标处于 `running` / `starting` 时，POST 到目标 sidecar 的内部 `/api/session-watch/register`，记录 one-shot watcher。
- 目标 turn-end hook 作为完成触发点，复用 builtin / external runtime finalize 中已经捕获的本轮 result / error，生成 `watch.completed` 或 `watch.error`。
- already idle 时不注册 watcher，由 caller sidecar 读取 SessionStore 最近结果并返回 `watch.already_idle`。
- 将 watch 事件投递给 watcher session，遵守 builtin/external 分流。

这个方案优先于“Rust poller 完成后再读目标结果”：完成触发点和结果快照在目标 runtime finalize 内同源，避免 idle 后落盘/释放竞态导致读到上一轮结果或空结果。

### Phase 4 - Owner 生命周期修正

- 移除 `deliver_with_resume` 中 ownerless sidecar 逻辑。
- 投递 headless turn 后启动或复用 `BackgroundCompletion` owner。
- transient owner 释放走 canonical release。
- 覆盖 send target、send result source、watch event target 三类 headless delivery。

### Phase 5 - 测试与回归

- 单元测试 session event renderer / sanitizer。
- CLI parser 测试 `send` / `watch` 参数边界。
- 后端测试 `--no-reply` 不生成 `send.result`。
- watch already idle / running completed / error 分支测试。
- Rust owner lifecycle 测试：投递 headless event 后没有 ownerless sidecar；idle 后 canonical release。
- external runtime smoke：send request 能进入 external，turn result 能形成 `send.result`。

## 验收标准

### Prompt / 协议

- 系统 prompt 中出现 `<myagents-session-events>`，第一句话说明 MyAgents 通过 `myagents` CLI 提供跨 session push/watch 能力，并要求从 shell/Bash tool 执行。
- prompt 明确：
  - `send` 用于让另一个 session 做新工作或收到通知。
  - 默认结果会被 MyAgents 自动推回本 session。
  - `--no-reply` 是单向投递。
  - `watch` 用于依赖其他 session 工作或用户要求监听其他 session。
  - `watch` 不让目标做新工作。
- 新事件统一使用 `<myagents-session-event>`，不再让新路径输出 `<inbox-message>` / `<inbox-reply>`。
- payload 内部包含伪造协议 tag 时不会逃逸外层 event block。

### `session send`

- A 执行默认 `send` 后，B 收到 `send.request source_notification="auto"`。
- B 完成该 turn 后，A 收到 `send.result status="ok"`，payload 是 B 的最终输出。
- B turn 失败/abort 时，A 收到 `send.result status="error"`。
- A 执行 `send --no-reply` 后，B 收到 `send.request source_notification="none"`，A 不收到自动结果推送。
- B 侧 prompt 不暗示必须手动回复，不产生“互相 send message”的误解。

### `session watch`

- A 对正在运行的 B 执行 `watch` 后，B 完成时 A 收到 `watch.completed` 和 B 最新结果。
- A 对已经 idle 的 B 执行 `watch` 后，A 立即得到 `watch.already_idle` 和 B 最近一轮结果，且不创建长期 watcher。
- 目标 session 不存在、不可达、超时或错误时，A 得到 `watch.error`，并尽量包含最新已知结果。
- `watch` 不向 B 注入任何新任务。
- 不存在 cron、mtime、JSONL parsing、unified log grep 实现。

### Owner 生命周期

- `session send` 给无 tab 目标 session 时，目标 turn 有明确 owner，完成后 owner 释放。
- `send.result` / `watch.*` 投递给无 tab 源 session 时，源 session 的处理 turn 有明确 owner，完成后 owner 释放。
- 不存在“直接 remove owner 后留下 ownerless sidecar”的路径。
- 不新增 owner enum variant，除非开发前另行讨论并批准。

### Runtime

- builtin SDK runtime 行为符合上述 send/watch 验收。
- external runtime 行为符合上述 send/watch 验收。
- external runtime 不出现“只等 idle 但 turn 其实失败”的假成功。

## 风险与约束

### Watch 的“最新结果”定义

“最新结果”不能模糊成“最后一次 session 状态”。它必须是 MyAgents 认可的最近 assistant turn result：

- running watch：优先使用 watch 注册时正在进行的 turn 完成后的 result。
- already idle：使用目标 session 最近一轮已完成 assistant result。
- 如果没有可用文本，使用结构化 no-result 描述，不从空 assistant content 推断成功。

### 重复投递

already idle 分支需要明确是同步返回还是异步注入。避免同一个事件在 CLI stdout 和下一 turn 里重复出现而没有区分来源。

### 兼容旧历史

历史里已经存在 `<inbox-reply>` 不需要迁移。新生成事件使用 v1 协议即可。

### 大 payload

如果结果可能超过 SSE / IPC payload 红线，沿用现有 spill / refs 机制。不要把大结果直接塞进 SSE JSON。

## 开放问题

1. `watch.already_idle` 是只同步返回给 CLI，还是也注入当前 session 历史？

   推荐：对 AI 发起的 CLI 调用，统一以 session event 进入会话历史为准；CLI stdout 只报告 accepted / delivered，避免重复。

2. 是否需要 turn id？

   v1 可以先不强制。但如果开发时发现 running watch 可能误把 watch 注册后的另一个 turn 结果当作目标 turn，应补充 `activeTurnId` / `lastCompletedTurnId` 这样的内部只读字段。

3. 是否持久化 watcher？

   v1 不持久化。应用重启或 session manager 重启后 watcher 丢失可接受。后续如果要做跨重启依赖图，再单独设计。

## 附录 A - 推荐内部类型草案

```ts
type SessionEventStatus = 'ok' | 'error';

type SessionEvent =
  | {
      version: 1;
      type: 'send.request';
      eventId: string;
      sourceSessionId: string;
      sourceLabel?: string;
      targetSessionId: string;
      sourceNotification: 'auto' | 'none';
      createdAt: string;
      payload: string;
    }
  | {
      version: 1;
      type: 'send.result';
      eventId: string;
      requestEventId: string;
      sourceSessionId: string;
      sourceLabel?: string;
      targetSessionId: string;
      status: SessionEventStatus;
      terminalReason?: string;
      errorCode?: string;
      createdAt: string;
      payload: string;
    }
  | {
      version: 1;
      type: 'watch.already_idle' | 'watch.completed' | 'watch.error';
      eventId: string;
      watchId: string;
      sourceSessionId: string;
      sourceLabel?: string;
      targetSessionId: string;
      targetStateAtRegistration: string;
      finalState?: string;
      terminalReason?: string;
      createdAt: string;
      latestResult: string;
    };
```

## 附录 B - 反例

这些实现方式不允许作为本 PRD 的落地方案：

- A 定时运行脚本读取 B 的 JSONL。
- 用文件 mtime 判断 B 是否完成。
- grep unified log 的 `terminal_reason` 当业务状态。
- 让 AI 自己维护 session dependency graph 文件。
- 新增一个 watch prompt，让 B 在完成时主动调用 `session send` 通知 A。
- 给 watch 加 `--then-prompt-file`，把 A 的继续任务作为新 prompt 注入。
- 在 Rust 里继续用临时 owner 投递后直接移除 owner、留下 ownerless sidecar。
