---
issue: 215
phase: research (read-only)
processed: 2026-05-19 14:30 Asia/Shanghai
companion: 215-yuanbao-fallback-before-real-reply.md
---

# #215 方案 A/B 代码层调研笔记

调研轮，**不写代码**。下面的"修改清单"只是落点 + 大致改动，owner 决策后再下手。

---

## Q1. builtin SDK + yuanbao 为什么没人报双发？

**答案**: **假设 2 (H2) 是对的——builtin SDK 同样会双发，只是 1-2s 的时间差肉眼不易察觉，没有报告 ≠ 没有 bug**。静态分析无法证实"用户从没遇到过"，需要复现日志佐证。

**代码证据**:

两条 runtime 路径在出栈 `/api/im-bridge/message` 之后**完全收敛**到同一条 IM event bus → reply_router → BridgeAdapter::send_message → `/send-text`，**没有任何一条路径会回灌 yuanbao 的 `dispatcherOptions.deliver`**：

- `src-tauri/src/management_api.rs::handle_bridge_message` L1017–1130：纯 200 OK 入队，从不直接回调 plugin。
- `src/server/agent-session.ts:806, 1411-1412` (builtin SDK)：emit 到 imEventBus。
- `src/server/runtimes/external-session.ts:504` (external runtime)：emit 到 imEventBus。
- `src/server/plugin-bridge/compat-runtime.ts:673-674` 显式注释 `// Do NOT call the deliver callback — AI reply comes back via /send-text`。
- `src/server/plugin-bridge/index.ts:759-777` `/send-text` endpoint → 调 `capturedPlugin.sendText(chatId, text)`，**完全绕开 yuanbao 的 dispatch-reply 中间件状态机**，因此既 reset 不了 `hasSentContent`，也唤醒不了 `queueSession`。

`queueSession.flush()` 实现 (`~/.myagents/openclaw-plugins/openclaw-plugin-yuanbao/.../outbound/queue.js:52-56`)：
```js
async flush() {
  await sendChain;           // 空 Promise.resolve()
  onComplete();
  return hasSentContent;     // 永远 false（没 push 过）
}
```
没 push 就立刻返回 false。yuanbao 在 `await doDispatchReply()` 后**5-10ms 内**就走到 fallback 分支。无论 AI 多快，都赶不上。

**置信度: high** — 静态分析路径全跑通了。

**未解 / 需复现**:
- 谁在 yuanbao 里实际**发送**了 fallback 文本？dist 2.13.1 的 `dispatch-reply.js` L173-181 **只 log.warn 不 sendText**（MD5 `14cfa330c1f84e274c480739d1eeb810`，3 处 sender 全是变量名引用，无 `.sendText` 调用）。但用户日志 `[yuanbao][ws] [C2C] preparing to send message` 明明发了 fallback 文。yuanbao 的 dispatch-reply.test.js L113-138 **TEST** 期望 `sender.sendText` 被调，与 dist 不一致。可能：(a) dist 与 test 不同步，sendText 路径在某次 refactor 删除了，或 (b) 还有一层 pipeline wrapper / hook 在 catch 这个 warn 触发 send，或 (c) 用户的 fallback 文本其实是 Rust `/send-text` 用 fallback content 直接发的（不太可能因为 5s 太早）。**修方案前最好抓一份 stack trace 看 sendC2CMessage 的 caller。**
- **A 方案的实施前置: 必须先抓一段 builtin SDK + yuanbao 的真实日志，确认双发是否也发生**。如果 builtin 实际上不双发，说明有一条我没找到的同步回灌路径，盲改 bypass path 会破坏它。

**A 方案对 H1/H2 的影响**:
- 如果是 H2 (我目前的判断)：A 方案安全，bypass path 合成 deliver 把 reply 灌进 yuanbao，**两边都修好**。
- 如果是 H1：A 方案危险，bypass path 合成 deliver 会和已有路径打架 → 真实回复发两次。

→ **必须先用 builtin SDK + yuanbao 复现一遍确认**。

---

## Q2. `/send-text` 端点今天到底服务谁？

**答案**: 12 个 Rust 调用点 + 1 个 Bridge HTTP 入口。可分三类：(a) `reply_router` 在 dispatch context 里发的（7 处，安全可改）、(b) IM command 处理（3 处，独立无 dispatch）、(c) 通知 / cron 推送（2 处，独立无 dispatch）。Feishu/Dingtalk **完全不走** `/send-text`，已是 protocol path。

**代码证据**:

| Caller | File:line | Scenario | 当前是否在 pending dispatch 里 | 改 `/send-text` 路由是否会破坏 |
|---|---|---|---|---|
| `dispatch_edit_based` 首发 draft | `src-tauri/src/im/reply_router.rs:219` | AI 流式回复首条 | **YES** | NO，可改 |
| `dispatch_edit_based` "(No response)" | `reply_router.rs:296,299` | AI 没输出 fallback | **YES** | NO |
| `dispatch_edit_based` error / cancelled | `reply_router.rs:371` | 错误终态 | **YES** | NO |
| `dispatch_streaming` placeholder | `reply_router.rs:424` | non-text block 占位 | **YES** | NO |
| `dispatch_streaming` 非 streaming finalize | `reply_router.rs:447, 479` | 退化路径 | **YES** | NO |
| `dispatch_streaming` gap warning | `reply_router.rs:604` | session-reset 提示 | **YES** | NO |
| `dispatch_streaming` no-response | `reply_router.rs:489, 492` | finalize 时为空 | **YES** | NO |
| `im/mod.rs:1579` `/bind` 成功 | `mod.rs:1579` | 命令回执 | **NO** | YES — 必须 bypass |
| `im/mod.rs:1597, 1609` `/start` & 错误 | `mod.rs:1597, 1609` | 命令回执 | **NO** | YES — 必须 bypass |
| `handover.rs:409` session 切换通知 | `handover.rs:409` | 后置通知 | **NO** | YES — 必须 bypass |
| `cron_task.rs:1658, 2027, 3736` `deliver_cron_result_to_bot` | `cron_task.rs:1658` | cron 异步推送 | **NO** | YES — 必须 bypass |

**Feishu / Dingtalk 路径**: 都是 native Rust adapter（`src-tauri/src/im/feishu.rs`、`src-tauri/src/im/dingtalk.rs`），不经过 BridgeAdapter，**完全不调 `/send-text`**。Feishu/Dingtalk 的 dispatcher 在 `compat-runtime.ts:418` 的 `dispatchReplyFromConfig` protocol 路径（行 432-541），通过 `/finalize-stream` → `pending.callbacks.sendFinalReply()` 闭环。改 `/send-text` 路由对他们零影响。

**置信度: high**（reply_router 调用点全列出来了；feishu/dingtalk 验证经过 native adapter 文件确认）。

**未解**: 无。

---

## Q3. qqbot / weixin / weixin-cli / wecom 的 dispatch-reply 形状

**答案**: qqbot + wecom + yuanbao 三家都有 `dispatcherOptions.deliver: async (payload, info) => void` 形状一致；openclaw-weixin 走 protocol path 不在 bypass 范围；weixin-cli 未装无法核。**合成 deliver callback 这套对 qqbot/yuanbao 完全适配，对 wecom 需要单独适配**（wecom 直发 Agent API 不走 queueSession，会被 shim "合成出来的 deliver" 短路掉真实的微信 Agent 发送）。

**代码证据**:

| Plugin | 文件 | 有 `dispatcherOptions.deliver` | deliver 行为 | 有 fallback 分支 | 与合成 deliver 兼容性 |
|---|---|---|---|---|---|
| yuanbao | `.../dispatch-reply.js:67` | YES | queueSession.push + hasSentContent=true | YES (L173-181) | HIGH (baseline) |
| qqbot | `@sliverp/qqbot/src/gateway.ts:1304` | YES | sendQueue.push + 自调 QQ API | YES (tool-only timeout) | HIGH |
| wecom-openclaw-plugin | `@wecom/.../agent/handler.js:429` | YES | **直发 Agent API**（无 queueSession） | NO | **MEDIUM** — 形状对，但 deliver 是真实发送动作，shim 替换会丢失实际发送能力 |
| openclaw-weixin | (走 protocol path) | N/A | 走 `dispatchReplyFromConfig`，不是 bypass | N/A | N/A — 不影响 |
| openclaw-weixin-cli | **未装** | unknown | unknown | unknown | unknown — 需 npm 拉源码 |

**置信度: medium-high**——qqbot 和 wecom 都从节点本地 `~/.myagents/openclaw-plugins/*/node_modules/` 读到了，结构清晰；weixin-cli 未装，要用 `npm view openclaw-weixin-cli` 拉 metadata 核 dispatch-reply 文件，再下结论。

**未解**:
- **wecom 的 deliver 是真实发送，不是 enqueue**——shim 合成 callback 不能简单"调用 plugin 提供的 deliver"，否则 plugin 自己就发了两次（一次 plugin's own deliver、一次 shim 合成路径试图 enqueue）。需要：要么 shim 在合成 callback 里**调用 plugin 自己的 deliver**（不修改原 callback，只 wrap），要么允许 plugin 通过 `dispatcherOptions` 明确 opt-in "我接受 protocol-path"。
- weixin-cli 形状未知。建议 owner 决方案 A 之前手动 `npm view` 或暂时把 weixin-cli 列为 "已知未覆盖"。

---

## Q4. pending-dispatch 抽象的完整 API surface

**答案**:

签名 (`src/server/plugin-bridge/pending-dispatch.ts:32-65`):
```ts
registerPendingDispatch(
  chatId: string,
  callbacks: PendingDispatchCallbacks,
): Promise<{ queuedFinal: number; counts: Record<string, number> }>
```

`PendingDispatchCallbacks` 接口 (L11-16)：
```ts
interface PendingDispatchCallbacks {
  onPartialReply?: (payload: { text?: string }) => void;
  onReasoningStream?: (payload: { text?: string }) => void;
  sendBlockReply?: (payload: { text?: string }) => boolean;
  sendFinalReply: (payload: { text?: string; isError?: boolean }) => boolean;  // 唯一 required
}
```

辅助 API (L68-105)：
- `getPendingDispatch(chatId)`: 拿到当前 pending 状态（已 resolved 返 undefined）
- `resolvePendingDispatch(chatId, result?)`: 标记 resolved + 调 promise.resolve
- `rejectPendingDispatch(chatId, error)`: 标记 resolved + reject
- `clearAllPendingDispatches()`: shutdown 时一次性 reject 所有 pending

**生命周期 / 清理**:
- TIMEOUT_MS = 10 * 60 * 1000 (10 分钟兜底)，超时 reject
- 同 chatId 第二次 register → 第一个被 reject("Superseded by new dispatch")
- 永远 resolve / reject 一次 (idempotent，`resolved` 守卫)

**调用者**:
- `register`: `compat-runtime.ts:495` (`dispatchReplyFromConfig` protocol 分支)
- `getPendingDispatch`: `index.ts:858 (/start-stream)`, `860 (/start-stream fallback)`, `932 (/stream-chunk)`, `970 (/finalize-stream)`, `1006 (/abort-stream)`
- `resolvePendingDispatch`: `index.ts:978 (/finalize-stream)` — 唯一成功 resolve 点
- `rejectPendingDispatch`: `index.ts:982 (/finalize-stream 错误)`, `1008 (/abort-stream)`, `compat-runtime.ts:528 (POST 失败)`
- `clearAllPendingDispatches`: 进程关闭

**回灌路径** (从 AI 到 plugin)：
```
external-session.ts emit → imEventBus
↓
Rust IM router 收 → reply_router::dispatch_streaming
↓
adapter.finalize_stream() — only if supports_streaming
↓
BridgeAdapter::finalize_stream (bridge.rs:773-797) POST /finalize-stream
↓
plugin-bridge/index.ts:966-984
↓
pending.callbacks.sendFinalReply({ text: finalText })  // ← 这里到 plugin
↓
resolvePendingDispatch(chatId, ...)  // promise resolve
↓
compat-runtime.ts:534 awaiting completionPromise 返回
```

A 方案要让 bypass path 也走这条 → 把 bypass 改成 register pending dispatch + 合成 `sendFinalReply` 回调，回调里调 `dispatcherOptions.deliver`。

**Rust 侧已经有的 endpoint**:
- `bridge.rs:773-797 finalize_stream(chat_id, stream_id, final_text)` — 现成的
- 但 reply_router L169-173 只对 `supports_streaming=true` 的 adapter 调 finalize_stream；bypass plugin 现在 `supports_streaming=false` → 走 `dispatch_edit_based` → 走 send_message → `/send-text`

**置信度: high**。

---

## Q5. Rust reply_router 的路由决策

**答案**: Rust 完全没有"protocol vs bypass" 概念。路由唯一判定就是 `adapter.supports_streaming()` (`reply_router.rs:169`)。BridgeAdapter 的 `supports_streaming` 又**只在 Feishu CardKit (`hasCardKitStreaming = appId && appSecret`) 下为 true**——因此今天**只有 feishu/lark 走 /finalize-stream，所有其它 OpenClaw 插件（yuanbao/qqbot/weixin/wecom）都走 /send-text**。

**代码证据**:

`ImStreamAdapter` trait (`src-tauri/src/im/adapter.rs:68`)，核心方法：
- `supports_streaming() -> bool` (L171, default false)
- `supports_edit() -> bool` (L149, default true)
- streaming protocol: `start_stream / stream_chunk / finalize_stream / abort_stream`
- edit protocol: `send_message_returning_id / edit_message / delete_message / send_message`

`supports_streaming()` 矩阵：

| Adapter | 返回 | 来源 |
|---|---|---|
| Telegram (native) | `false` | adapter.rs:171 default |
| Feishu (native) | `false` | adapter.rs:171 default |
| Dingtalk (native) | `false` | adapter.rs:171 default |
| Bridge(feishu plugin) | `true` 当 appId+appSecret | `bridge.rs:151-152` + `index.ts:730,749` |
| Bridge(yuanbao/qqbot/weixin/wecom) | **`false`** | 同上但 appId/appSecret 缺 |

**index.ts:730 关键**:
```ts
const hasCardKitStreaming = !!(pluginConfig.appId && pluginConfig.appSecret);
// ...
capabilities: {
  ...
  streaming: hasCardKitStreaming,
  streamingCardKit: hasCardKitStreaming,
  ...
}
```
即 streaming flag = Feishu CardKit 凭据是否齐。这是个 **feishu-specific hack**，没有为"我支持 protocol callbacks 但不要 cardkit"留口子。

**`dispatch_edit_based` 事件流** (`reply_router.rs:189-378`):
- `delta`: 累 text → 首次有句子边界时 `send_message_returning_id(draft)` 创建草稿，后续 `edit_message(draft, text)` 节流
- `block-end`: 用 `finalize_block` 收口（edit 或 delete+send）
- `complete`: 检查 NO_REPLY 模式 → 删 draft / 走 `finalize_block`
- `error / cancelled`: 删 draft + 占位 → send 错误消息
- `activity`: thinking placeholder
- `permission-request`: 审批卡

**所有调用 `adapter.send_message` 的路径 → BridgeAdapter::send_message (bridge.rs:440-463) → POST /send-text**。

**协议路径判别**: 没有静态字典，没有 plugin_id allowlist。**判定来源唯一是 plugin `/capabilities` endpoint** (`index.ts:727-756`)，由 plugin-bridge 决定要不要报 `streaming: true`，而 bridge 现在的判据只看 `appId + appSecret`。

**doc contract**: `specs/tech_docs/im_integration_architecture.md`（如果存在）描述 "出站 / Rust BridgeAdapter::send_message() → POST /send-text 到 Bridge 进程"，但**没有明确禁止 bypass-path plugin 走 finalize_stream**。`specs/tech_docs/plugin_bridge_architecture.md`（如果存在）的契约重点在 SHIM_COMPAT_VERSION 同步，不约束 reply 路径。

**`send_text` 函数签名**: `bridge.rs:440-463`，签名 `async fn send_message(&self, chat_id: &str, text: &str) -> AdapterResult<()>`，**无返回值**（`Ok(())`）。`send_message_returning_id(L483-514)` POST 到同一 endpoint，但 parse `messageId` from JSON。

**最小改动建议（Rust 侧）**:
- **方案 A.1**: 把 `BridgeAdapter::sync_capabilities` 里的 `streaming` 判据从 `appId+appSecret` 改成"plugin 显式声明 protocol path 支持"——加一个 `capabilities.protocolPath: boolean`。然后 `index.ts:749` 改成 `streaming: hasCardKitStreaming || hasProtocolPath`。**最小改动 ~5 行 Rust + ~3 行 TS。**
- **方案 A.2**: 让 BridgeAdapter 引入新维度 `supports_protocol_path: bool`，reply_router L169 改成 `if adapter.supports_streaming() || adapter.supports_protocol_path() { dispatch_streaming } else { dispatch_edit_based }`。然后 dispatch_streaming 里**对 protocol-only 模式跳过 CardKit 特有逻辑**（draft + edit）只调 finalize_stream(final_text)。**改动稍大但语义分得开。**

A.1 看起来够用且最小；A.2 在未来要分 cardkit / protocol-only 时再上。

**置信度: high**。

---

## Q6. SDK shim 版本协议

**答案**: 是 SDK shim 协议变更，要按 CLAUDE.md "MUST 三处同步 bump" 处理。

**代码证据**:
- `src/server/plugin-bridge/sdk-shim/package.json`: `"version": "2026.5.18-shim"`
- `src/server/plugin-bridge/compat-runtime.ts:206`: `const SHIM_COMPAT_VERSION = '2026.5.18';`
- `src-tauri/src/im/bridge.rs:1606`: `const SHIM_COMPAT_VERSION: &str = "2026.5.18";`

bridge.rs:976-1010 的 reinstall 检查：plugin shim 版本 prefix 必须与 SHIM_COMPAT_VERSION 一致，否则把 plugin 的 shim 重装。

**A 方案修改 `dispatchReplyWithBufferedBlockDispatcher` 是改 SDK 协议 surface**（这个函数是 OpenClaw 插件直接 import 的入口），必须三处一起 bump (建议 `2026.5.19`)。bump 后所有已装插件的 shim 在下次启动时自动重装。

`dispatchReplyWithBufferedBlockDispatcher` 在 shim 里何时引入：grep 不到 git history，但从 compat-runtime.ts 注释（"Codex H12 fix" 提到 `pending dispatch BEFORE POSTing to Rust`）看是早期就有。无版本回滚问题，bump 即可。

**置信度: high**。

---

## Q7. bypass path 的 5s timeout 真实影响

**答案**: **5s timeout 不阻塞 AI 生成，只 cap 住"Rust 接收消息入队"这一步**——Rust 在 `handle_bridge_message` (L1098-1129) 把 ImMessage `sender.send(msg)` 入队后立刻返回 200 OK，路径本身只 ~5-50ms，5s 完全够用。**A 方案改成阻塞等 AI 时，5s timeout 必须 remove**——把整条 dispatch 改为依赖 pending-dispatch 自身的 10 分钟兜底。

**代码证据**:

`compat-runtime.ts:633-657`:
```ts
const resp = await cancellableFetch(
  `${rustBaseUrl}/api/im-bridge/message`,
  { method: 'POST', ..., body: JSON.stringify({...}) },
  { timeoutMs: 5_000 },  // ← 5s cap
);
```

Rust handler `management_api.rs:1098-1129`:
```rust
let msg = ImMessage { ... };
match sender.send(msg).await {     // mpsc::Sender::send，纯 enqueue
    Ok(_) => (StatusCode::OK, Json({"ok": true})),
    ...
}
```
只入 channel，没有 await AI。

5s timeout 现状没用，但 **A 方案改成阻塞后 5s 必死** (external runtime 起步 5s+)，必须：

**变体 1**: 把 POST 本身的 timeout 保持 5s（监控 Rust 入队是否健康），把 await completionPromise 单独排队，两段 timeout 分开。
**变体 2**: 把 POST timeout 撑到 11 分钟（超过 pending-dispatch 10 分钟）+ 直接复用 pending-dispatch 兜底。

变体 1 干净点：5s 仍然作为"Rust 是不是死了"的健康探针。

**置信度: high**。

---

## 基于上述调研的方案 A 修改清单

**前置确认**: 跑一次 builtin SDK + yuanbao 看实际是否双发。如果不双发，整个方案需要先搞清楚 builtin 那条隐藏路径再决策；如果双发，按下列清单走。

**清单（按改动文件分组）**:

1. **`src/server/plugin-bridge/sdk-shim/package.json`** — bump `version` 到 `2026.5.19-shim`。
2. **`src/server/plugin-bridge/compat-runtime.ts:206`** — bump `SHIM_COMPAT_VERSION` 同步。
3. **`src/server/plugin-bridge/compat-runtime.ts:581-675`** (`dispatchReplyWithBufferedBlockDispatcher`):
   - 当 `dispatcherOptions?.deliver` 是函数 → 注册 pending dispatch + 合成 callbacks (sendFinalReply / onPartialReply 反灌进 deliver)。
   - **关键 wrap 而非替换**: 合成 sendFinalReply 调 `dispatcherOptions.deliver(...)`，不接管 plugin 自己的发送动作。
   - POST 到 Rust 后从立即 return 改成 await completionPromise。
   - **wecom 特例**: wecom 的 deliver 是直发 Agent API 不是 enqueue。如果合成 deliver 路径仍然调它，wecom 会重复发。**临时方案**: 在 compat-runtime 里 keyed by plugin_id 跳过 wecom（让它走旧 bypass），等后续 wecom 改 queueSession 再开。或者 dispatcherOptions 增加 `deliveryMode: 'direct' | 'queued'` 让 plugin 自报。
   - 5s POST timeout 保留（只覆盖 Rust 入队这一步）；额外 await 自然走 pending-dispatch 10 分钟兜底。
4. **`src/server/plugin-bridge/index.ts:727-756`** (`/capabilities`):
   - 改 `streaming: hasCardKitStreaming` → `streaming: hasCardKitStreaming || hasProtocolPath`。
   - `hasProtocolPath` 来源: plugin's `raw.capabilities.protocolPath`（plugin 自报）或 inferred from "plugin defines a sendText handler + supports compat-runtime synthetic deliver"。
5. **`src-tauri/src/im/bridge.rs:1606`** — bump `SHIM_COMPAT_VERSION` 同步到 `2026.5.19`。
6. **`src-tauri/src/im/bridge.rs:141-180`** (`sync_capabilities`) — 读 `capabilities.protocolPath` 同时更新 `supports_streaming`（沿用现 flag 即可；不需要新增 trait method）。
7. **Rust reply_router 不动**——只要 `supports_streaming` 返回 true，dispatch_streaming 自动接管。
8. **可选: `src-tauri/src/im/reply_router.rs::dispatch_streaming`** — 检查是否对"没有 CardKit 只有 finalize_stream"的 plugin 路径有特殊代码段；如果有 CardKit-only 假设，需要修剪。

**回归矩阵（必须手测）**:

| Plugin | Runtime | private | group |
|---|---|---|---|
| feishu (cardkit) | builtin | ✓ | ✓ |
| feishu (cardkit) | claude-code | ✓ | ✓ |
| dingtalk | builtin | ✓ | — |
| yuanbao | builtin | ✓ | — |
| yuanbao | claude-code | ✓ | — |
| qqbot | builtin | ✓ | ✓ |
| wecom | builtin | ✓ | — (走 bypass 旧路径) |

**风险点**:
- Q1 假设未验证 → 高风险，先抓 builtin runtime log
- wecom 直发 deliver 与 shim 合成路径冲突 → 必须有 escape hatch（按 plugin_id 跳过或 capability flag opt-in）
- Q3 weixin-cli 未装无法核 → owner 决策前 npm view 一下
- `/send-text` 的 IM-command / handover / cron 三类 standalone 调用与 dispatch 上下文无关，需要 `/send-text` handler 主动 query pending-dispatch (`getPendingDispatch(chatId)`) → 有 → 走 deliver；无 → 走 plugin.sendText。但此改动**今天不一定要落**——A 方案的核心是 bypass path 自己注册 pending-dispatch 阻塞，AI reply 通过 reply_router → finalize_stream → 合成 sendFinalReply → deliver，**根本不会走 /send-text**。standalone 调用维持原样。
- SHIM_COMPAT_VERSION bump 会触发所有已安装 plugin 的 shim 重装；用户首次启动新版本会有 5-30s 等待。

---

## Round 2 Follow-ups (2026-05-19)

### FU-1: 谁实际发送了 yuanbao 的 fallback 文本？

**结论**: **在 owner 机器装的 yuanbao 2.13.1 dist 里，没有任何代码路径会发送 fallbackReply 文本**。`dispatch-reply.js` L173-181 只 `log.warn`，没 `sender.sendText(fallbackReply)`。穷尽搜索整个 yuanbao 包 + MyAgents Bridge + Rust IM，**找不到 fallback 文本的实际发送代码路径**。最可能的解释：**reporter 跑的不是 2.13.1**（或装了 patched 版本），有一份本机看不到的 sender.sendText(fallbackReply) 在那里。但即使 reporter 跑别的版本，**A 方案的核心假设依然成立** —— 因为如果 reporter 的 yuanbao 版本里 fallback 确实通过 `queueSession.push` / `sender.sendText` 触发，必然受 `!hasSentContent` 或 `!flushed` 这两个 guard 控制（Tests at L113-138 表明它绕不开），合成 deliver 让 `hasSentContent=true` 就会让 guard 跳过 fallback。

**证据**:

1. **dispatch-reply.js dist 2.13.1** (`~/.myagents/openclaw-plugins/openclaw-plugin-yuanbao/.../dispatch-reply.js`, MD5 `14cfa330c1f84e274c480739d1eeb810`, 202 行):
   ```js
   // L173-181:
   if (!flushed && !hasSentContent && !ctx.abortSignal?.aborted) {
       const { fallbackReply } = account;
       if (fallbackReply) {
           ctx.log.warn("[dispatch-reply] AI returned no reply content, using fallback reply");
       } else {
           ctx.log.warn("[dispatch-reply] AI returned no reply content");
       }
   }
   ```
   只 log。grep `sender\.|sendC2C|sendText` 全文件命中 3 处全是变量解构（`const { sender } = ctx;`）和 prereq check，**没有 `sender.sendText` 调用**。

2. **dispatch-reply.test.js** (同目录) L113-138 期望 `sender.sendText("我暂时无法回答")` 被调，但 dist 不调。**TEST 与 DIST 不一致**。

3. **pipeline 编排** (`pipeline/create.js`): 17 个 middleware 依次跑，`dispatchReply` 是 last。没有 wrapper / hook / decorator catch warn 转 send。`engine.js` 的 execute 是单向链，next() 跑完就完。

4. **prepare-sender.js** L29-31 的 `onComplete: () => ctx.log.debug(...)`：纯 log，没有 fallback 发送。

5. **outbound/queue.js** flush 实现 (L52-56 immediate / L89-121 mergeOnFlush / L245-255 merge-text): `flush()` 只 await sendChain + return hasSentContent。**没 push 过的内容不会被 flush 出去**。

6. **channel-shared.js** L57 提到 `fallbackReply` 仅在 `deleteAccount.clearBaseFields` 列表里（删账号时清字段名），不是发送路径。

7. **channel.js L129-148** `channel.outbound.sendText` 是 plugin **top-level** sendText handler（Bridge `/send-text` endpoint 调它），不被 dispatch-reply 调。链路是 `Rust send_message → Bridge /send-text → capturedPlugin.sendText → channel.outbound.sendText → handleAction → handler.js's sender.send → wsClient.sendC2CMessage`。这条 chain 解释了 `[yuanbao][ws] [C2C] preparing to send message` 日志——但**触发它的只能是 Rust 端 send_message 调用，不是 yuanbao 自己的 fallback warn**。

8. **MyAgents 侧 grep**: `src/server` + `src-tauri/src` 全文搜 `"暂时无法解答"` / `"fallbackReply"` / `"换个问题问问"` —— 零命中。Rust 端不知道 yuanbao 的 fallback 文本，**不可能由 MyAgents 主动发**。

**置信度**: high（owner 机器 2.13.1 dist 行为）；low（reporter 真实跑的版本）。

**对 A 方案的影响**: **unblock，但需要 owner 跟 reporter 核对版本**。如果 reporter 版本和 owner 一致（2.13.1），那 reporter 的 log 截图可能误植/混淆（fallback warn 和 5s 后真实回复同 ms？不可能）。如果 reporter 跑的是别的版本，A 方案修法仍然有效（只要 fallback 的发送 guard 是 `hasSentContent`/`flushed`，灌 deliver 就能压住）。

**未解 / 需 owner 跟 reporter 确认的**:
- reporter 机器的 yuanbao 版本（`~/.myagents/openclaw-plugins/openclaw-plugin-yuanbao/node_modules/openclaw-plugin-yuanbao/package.json` 的 version 字段）
- 让 reporter 给一段完整 unified-*.log 摘录（含 dispatch ENTER/EXIT、send_message、message-complete 全部行），不是手写截图

---

### FU-2: builtin SDK + yuanbao 真实日志验证 H2

**结论**: **owner 机器 30 天日志（unified-2026-04-19 → 2026-05-19）零 yuanbao 流量**。无法从本地日志确证 H2。但同档期 feishu/lark 跑过的 dispatch（包括今天 2026-05-19）能确认 **bypass path 在 builtin SDK 下也命中**，且发出后 plugin 不会触发"AI returned no reply" warn（feishu 没这个 middleware）。所以 feishu 上观察不到双发不能反推 yuanbao 没双发——他俩的 dispatch-reply 链路完全不同。

**证据**:

1. **本机 30 天 unified-*.log 中 yuanbao 流量** (`grep -l yuanbao /Users/zhihu/.myagents/logs/unified-*.log`)：
   - `unified-2026-05-11.log` — 8 行命中，全是 SDK shim 的 "Bridge mode" 日志（plugin loading 而非 dispatch）
   - `unified-2026-05-18.log` — 3 行命中（同上）
   - `unified-2026-05-19.log` — 21 行命中（全是 AI 调研本 issue 时打的命令噪音）
   - **没有任何一行实际的 `[yuanbao][pipeline]` / `[yuanbao][ws]` runtime 日志**。owner 机器从未跑过 yuanbao plugin 处理用户消息。

2. **同期 feishu 跑过 bypass path**（确认 bypass path 是 hot path，不是 dead code）:
   ```
   2026-05-19 02:46:56.995 [bridge-out][fb49ede4] [compat-timing] dispatchReplyFromConfig ENTER
   2026-05-19 02:46:56.995 [bridge-out][fb49ede4] [compat-timing] dispatchReplyWithBufferedBlockDispatcher ENTER: chat=ou_..., len=4
   2026-05-19 02:46:56.998 [bridge-out][fb49ede4] [compat-timing] dispatchReplyFromConfig EXIT (fallback) (+5ms)
   2026-05-19 02:46:56.998 [bridge-out][fb49ede4] [plugin] feishu[default]: dispatch complete (queuedFinal=0, replies=undefined)
   ```
   feishu 也 `hasProtocolCallbacks=false` → bypass → 5ms return。**今天 owner 的 feishu 跑的就是 builtin SDK runtime**（`[sse] chat:system-init -> ..."runtime":"builtin"...`），共 8 个 dispatch (+2ms ~ +11ms)。但 feishu 没有 fallback warn 因为它没 yuanbao 那条 middleware。

3. **feishu builtin runtime 完整 turn 时序**（2026-05-19 13:35）:
   ```
   13:35:16.212 [agent][sdk] Broadcasting chat:message-complete (output_tokens=107708)
   13:35:16.301 [bridge:openclaw-lark] send_message: textLen=1676  ← AI 真实回复
   13:35:19.545 [bridge:openclaw-lark] send_message_returning_id: textLen=12  ← 下一轮 thinking 占位
   ```
   AI 完成 → 90ms 后真实回复发到 feishu via send_message → 单发。**feishu 上没有双发**。但这不能推论 yuanbao —— 缺 fallback middleware ≠ 缺 double-send 路径。

4. **2026-05-19 02:46:56.997 的 33 byte send_message 异常**: `[bridge:openclaw-lark] send_message: textLen=33` 在 `dispatchReplyWithBufferedBlockDispatcher ENTER` 后 2ms、`dispatchReplyFromConfig EXIT (fallback)` 前 1ms 触发。**Rust 端在 bypass dispatch 跑的同时主动发了一条 33-byte 消息**。可能候选：handover.rs:409 通知 / im/mod.rs:1579-1609 command 回执 / cron 推送 / 启动前 queued 事件。**这条不在 reply_router 的 dispatch 上下文里**——说明今天的 feishu 路径里 `/send-text` **被非-dispatch 路径主动调用**，A 方案的 standalone-bypass 设计（不改 /send-text）仍然安全。

**置信度**: high（本机无 yuanbao）；medium（H2 状态：从 feishu 间接推测但不能直接断言 yuanbao 也单发或双发）。

**对 A 方案的影响**: **partial unblock**。bypass path 是 hot path 确认；H2 直接判定仍然 owner 需手动复现。

**最小复现给 owner（5 步以内）**:

1. 装 yuanbao plugin: 在 MyAgents 启动后 → Settings → IM Bot → 添加腾讯元宝 → 走完 OAuth / Token 流程
2. 把 Agent 的 `runtimeConfig.runtime` 切到 `builtin`（不是 claude-code / codex）。或者直接选个走 builtin 的 Agent 绑给 yuanbao。
3. 在元宝里发一条 12 字以内的中文消息
4. `tail -F ~/.myagents/logs/unified-$(date +%Y-%m-%d).log | grep -E "yuanbao|dispatch-reply|send_message|message-complete"`
5. 观察是否出现：
   - 在 `message-complete` 之前先有 `[yuanbao][pipeline] [dispatch-reply] AI returned no reply content` warn（→ 触发 fallback 路径，H2 成立）
   - 之后 5s 内 AI 回复经 Rust send_message 发回（→ 双发，需要 A 方案）

如果第 5 步**没看到** fallback warn —— 那说明 owner 装的 2.13.1 跟 reporter 装的版本不一样，需要让 reporter 给 yuanbao version。

---

### FU-3: weixin-cli 形状

**结论**: **`openclaw-weixin-cli` 不在公开 npm 上**（`npm view ... E404`）。本地 `~/.myagents/openclaw-plugins/openclaw-weixin-cli/` 是个**占位目录**，唯一文件 `package.json` 内容是 `{"name":"openclaw-weixin-cli","private":true,"version":"1.0.0"}`，没 dependencies、没 node_modules、没 implementation。可视作"未启用"——**A 方案 day-1 不需要为 weixin-cli 留 escape hatch**。

**证据**:

1. `npm view openclaw-weixin-cli versions --json` → `E404 Not Found - GET https://registry.npmjs.org/openclaw-weixin-cli`
2. `find /Users/zhihu/.myagents/openclaw-plugins/openclaw-weixin-cli -type f` → 仅一个文件：`package.json`
3. `cat .../openclaw-weixin-cli/package.json` → `{"name":"openclaw-weixin-cli","private":true,"version":"1.0.0"}`（无 dependencies / main / 任何实际代码）
4. 对比 sibling `openclaw-weixin/package.json`: `{"name":"openclaw-weixin","private":true,"version":"1.0.0","dependencies":{"@tencent-weixin/openclaw-weixin":"^2.4.3"}}` —— **openclaw-weixin 是真插件，openclaw-weixin-cli 是空 stub**。

**Round 1 Q3 表格更新行**:

| Plugin | 文件 | 有 `dispatcherOptions.deliver` | deliver 行为 | 有 fallback 分支 | 与合成 deliver 兼容性 |
|---|---|---|---|---|---|
| openclaw-weixin-cli | **stub（仅 package.json）** | **N/A** | N/A | N/A | **N/A — 未启用，A 方案无需覆盖** |

**置信度**: high。

**对 A 方案的影响**: **unblock**。weixin-cli 不需要进 day-1 兼容矩阵；将来如果 weixin-cli 真发布，再补一轮调研。

---

### Round 1 颠覆性证据汇总

1. **FU-1 颠覆点**: Round 1 Q1 副发现说"dist 与 test 不一致"——Round 2 穷尽搜索后**坐实**：yuanbao 2.13.1 dist 完全没有 fallback 发送代码路径，连 wrapper / hook / decorator 都没有。reporter 看到的 fallback send 必然来自其它来源（最可能：reporter 跑别的版本）。**A 方案修法不受影响**，但 reporter 版本待确认。
2. **FU-2 中性证据**: 本机 30 天日志只跑 feishu/lark/weixin，零 yuanbao。今天看到的 feishu builtin runtime + bypass path 8 次 dispatch 都**单发**——但这是因为 feishu 缺 dispatch-reply middleware，**不能推论 yuanbao 也单发**。H2 仍未直接确证，但 A 方案的 architecture 假设（bypass path 跑过、deliver 不灌 → plugin 见不到 content）已经在 feishu 上 100% 复现。
3. **FU-3 unblock 点**: weixin-cli 是 stub，A 方案不用为它留 escape hatch。Round 1 风险点矩阵能去掉一行。
4. **新发现的 Rust /send-text 主动调用路径**: 2026-05-19 02:46:56.997 的 33-byte send_message 在 bypass dispatch 跑的同时被 Rust 主动调，**不在 reply_router 的 dispatch 上下文里**——说明 Round 1 Q2 表里的 standalone 调用方（command/handover/cron）确实在生产里会被打中。A 方案保持"不改 /send-text"是正确选择。

### 一行决策建议

**A 方案可以动手 — 但 owner 先（1）让 reporter 报 yuanbao 版本号 + 给完整 unified-*.log 摘录确认 fallback 真实发送路径；（2）owner 本机手动跑一遍 builtin+yuanbao（FU-2 5 步复现）确认 H2。两件 5 分钟内可完成 —— 完成后即可开工。**
