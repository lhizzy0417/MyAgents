# MyAgents IM 集成技术架构

## 一、核心架构决策

### 1.1 分层解耦：IM in Rust, AI in Node.js

| 层 | 职责 | 实现语言 | 理由 |
|----|------|---------|------|
| **IM 适配层** | Telegram/飞书/钉钉 连接管理、消息收发、重连、白名单 | Rust | I/O 密集型，零 GC、稳定性高，崩溃不影响 IM 连接 |
| **Plugin Bridge 层** | 加载 OpenClaw 社区 Channel Plugin，代理消息收发 | Node.js 独立进程 | 兼容 TS 生态插件，故障隔离于独立进程 |
| **Session 路由层** | peer→Sidecar 映射、按需启停、消息缓冲 | Rust | 复用 SidecarManager，统一进程生命周期管理 |
| **AI 对话层** | Claude SDK、MCP、工具系统、Session 管理 | Node.js Sidecar | 已有完整生态，不值得用 Rust 重写 |

**关键优势**：
1. **故障隔离**：AI 进程（Node.js）崩溃 → Rust IM 层继续收消息、缓冲 → 自动重启 Node.js Sidecar → resume Session → 用户无感
2. **资源高效**：IM 连接在 Rust，额外内存 < 5MB
3. **连接稳定**：Rust 长轮询天然适合 always-on 场景

### 1.2 多 Bot 架构

支持同时运行多个 IM Bot 实例，每个 Bot 拥有独立的配置、连接、Session 和健康状态。

```
┌─────────────────────────────────────────────────────────────────┐
│ Tauri Desktop App │
├──────────────────────────────────────────────────────────────────┤
│ React Frontend │
│ ┌────────────┐ ┌────────────┐ ┌─────────────────────────────┐ │
│ │ Chat Tab │ │ Chat Tab │ │ Settings → 聊天机器人 │ │
│ │ Tab Sidecar│ │ Tab Sidecar│ │ ┌─────┐ ┌─────┐ ┌─────┐ │ │
│ └──────┬─────┘ └──────┬─────┘ │ │Bot 1│ │Bot 2│ │Bot 3│ │ │
│ │ │ │ └──┬──┘ └──┬──┘ └──┬──┘ │ │
├─────────┼───────────────┼────────┼─────┼──────┼──────┼───────┤ │
│ ▼ ▼ │ ▼ ▼ ▼ Rust │ │
│ ┌─────────────┐ ┌───────────┐ │ ManagedImBots │ │
│ │ Tab Sidecar │ │Tab Sidecar│ │ HashMap<String, ImBotInstance│ │
│ │ :31415 │ │ :31416 │ │ ├── bot_1 → Instance │ │
│ └─────────────┘ └───────────┘ │ │ ├── TelegramAdapter │ │
│ │ │ ├── SessionRouter │ │
│ │ │ ├── HealthManager │ │
│ │ │ └── MessageBuffer │ │
│ │ ├── bot_2 → Instance │ │
│ │ └── bot_3 → Instance │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
 │
 ┌───────────┼───────────┐
 Telegram API Feishu WS Plugin Bridge (Node.js)
 ↕ HTTP
 OpenClaw 社区插件
 (QQ Bot, Matrix, …)
```

---

## 二、Rust 侧实现

### 2.1 核心数据结构

```rust
/// 多 Bot 管理容器（Tauri State）
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// 单个 Bot 实例
pub struct ImBotInstance {
 pub bot_id: String,
 pub shutdown_tx: watch::Sender<bool>, // 优雅关闭信号
 pub health: Arc<HealthManager>, // 健康状态持久化
 pub router: Arc<Mutex<SessionRouter>>, // peer→Sidecar 映射
 pub buffer: Arc<Mutex<MessageBuffer>>, // 离线消息缓冲
 pub started_at: Instant, // 用于计算 uptime
 pub process_handle: JoinHandle<()>, // 消息处理主循环
 pub bind_code: String, // QR 绑定码 "BIND_{uuid8}"
 pub config: ImConfig, // 运行时配置快照
}
```

### 2.2 Tauri Commands（Legacy，已 Deprecated）

> 以下旧命令已标 `@deprecated`，内部转发到新 Agent Channel API。新代码应使用 `cmd_start_agent_channel` 等新命令（见文档末尾"Agent Channel 架构"章节）。

```rust
/// @deprecated — 使用 cmd_start_agent_channel 替代
#[tauri::command]
async fn cmd_start_im_bot(
 botId: String,
 botToken: String,
 allowedUsers: Vec<String>,
 permissionMode: String,
 workspacePath: String,
 model: Option<String>,
 providerEnvJson: Option<String>,
 mcpServersJson: Option<String>,
 availableProvidersJson: Option<String>,
 botName: Option<String>, // Bot 显示名称，传入系统提示词
) -> Result<ImBotStatus, String>;

/// 停止指定 Bot
#[tauri::command]
async fn cmd_stop_im_bot(botId: String) -> Result<(), String>;

/// 查询单个 Bot 状态
#[tauri::command]
async fn cmd_im_bot_status(botId: String) -> Result<ImBotStatus, String>;

/// 批量查询所有 Bot 状态
#[tauri::command]
async fn cmd_im_all_bots_status() -> Result<HashMap<String, ImBotStatus>, String>;

/// 获取 Bot 的对话列表
#[tauri::command]
async fn cmd_im_conversations(botId: String) -> Result<Vec<ImConversation>, String>;
```

### 2.3 Bot 生命周期

#### 启动流程（`start_im_bot()`）

```
cmd_start_im_bot(botId, botToken, ...)
 │
 ├── 若同 botId 已在运行 → 优雅停止（等待 5s 收尾）
 │
 ├── 迁移遗留文件（v1/v2 → v3 子目录）
 │ └── im_state.json / im_{botId}_*.json → im_bots/{botId}/*.json
 │
 ├── 初始化组件
 │ ├── HealthManager（加载上次状态）
 │ ├── MessageBuffer（恢复磁盘缓冲）
 │ └── SessionRouter（恢复 peer→session 映射）
 │
 ├── 创建 TelegramAdapter
 │ └── 传入 allowed_users: Arc<RwLock<Vec<String>>>
 │
 ├── 验证连接
 │ └── getMe() → 获取 bot_username
 │
 ├── 注册 Bot 命令
 │ └── setMyCommands: /new, /workspace, /model, /provider, /status
 │
 ├── 初始化运行时共享状态
 │ ├── current_model: Arc<RwLock<Option<String>>>
 │ └── current_provider_env: Arc<RwLock<Option<Value>>>
 │
 ├── 启动后台任务
 │ ├── 消息处理主循环（tokio::spawn）
 │ ├── Telegram 长轮询（listen_loop）
 │ ├── 健康状态持久化（5s 间隔）
 │ └── 空闲 Session 回收（60s 间隔）
 │
 ├── 生成绑定 URL
 │ └── https://t.me/{username}?start=BIND_{uuid8}
 │
 └── 返回 ImBotStatus（含 bot_username、bind_url）
```

#### 关闭流程（`stop_im_bot()`）

```
cmd_stop_im_bot(botId)
 │
 ├── 发送 shutdown 信号（watch channel）
 ├── 等待 process_handle 完成（超时 10s）
 ├── 持久化缓冲消息到磁盘
 ├── 持久化活跃 Session 到健康状态
 ├── 释放所有 Sidecar Session
 └── 设置状态 Stopped，写入最终状态
```

#### 应用启动自动恢复

```
Tauri app 启动
 │
 └── 遍历 config.imBotConfigs[]
 └── 若 enabled == true && botToken 非空
 └── cmd_start_im_bot(...)
```

### 2.4 消息处理循环

**并发模型**：

```
Per-Message Task:
1. 获取 per-peer 锁（同一用户/群消息串行化）
 ↓
2. 获取 global semaphore（GLOBAL_CONCURRENCY = 5）
 ↓
3. 短暂锁 router（ensure_sidecar + record_response）
 ↓
4. SSE 流式读取 AI 响应（stream_to_telegram）
 ↓
5. 重放缓冲消息（同一 peer lock 内）
```

**命令分发（无需 Sidecar I/O）**：

| 命令 | 行为 |
|------|------|
| `/start BIND_xxxx` | QR 绑定：添加用户到白名单，发射 `im:user-bound` 事件 |
| `/start` | 显示帮助文本 |
| `/new` | 重置 Session（`router.reset_session()`） |
| `/workspace [path]` | 显示/切换工作区 |
| `/model [name]` | 显示/切换 AI 模型（支持快捷名：sonnet, opus, haiku） |
| `/provider [id]` | 显示/切换 AI 供应商 |
| `/status` | 显示 Session 信息 |

**普通消息处理（SSE 流式）**：

```
收到普通消息
 │
 ├── ACK：setMessageReaction(⏳) + sendChatAction(typing)
 │
 ├── ensure_sidecar()：获取/创建 Sidecar
 ├── 若新 Sidecar → 同步 AI 配置（model + MCP servers）
 │
 ├── POST /api/im/chat → SSE 流（含 botName 用于系统提示词）
 │ ├── "partial" 事件 → 节流编辑消息（≥1s 间隔，截断 4000 字符）
 │ ├── "block-end" 事件 → 定稿（>4096 字符则分片发送）
 │ ├── "complete" 事件 → 返回 sessionId
 │ └── "error" 事件 → 删除 draft，发送错误消息
 │
 ├── 清除 ACK：setMessageReaction("")
 ├── 更新 Session 状态：record_response(session_key, sessionId)
 ├── 更新健康状态：last_message_at, active_sessions
 │
 └── 重放缓冲消息（若有）
```

### 2.5 Telegram Adapter

```rust
pub struct TelegramAdapter {
 bot_token: String,
 allowed_users: Arc<RwLock<Vec<String>>>, // 可热更新白名单
 client: reqwest::Client, // LONG_POLL_TIMEOUT + 10s
 coalescer: Arc<Mutex<MessageCoalescer>>, // 碎片合并 + 防抖
 bot_username: Arc<Mutex<Option<String>>>, // getMe() 后缓存
}
```

**ImAdapter Trait**：
- `verify_connection()` → `getMe()` 验证 Token
- `register_commands()` → `setMyCommands()` 注册命令菜单
- `listen_loop()` → `getUpdates` 长轮询，指数退避重连
- `send_message()` → 自动分片 + Markdown 降级 + 纯文本 fallback
- `ack_received/processing/clear()` → `setMessageReaction` emoji 管理

**MessageCoalescer（碎片合并 + 防抖）**：
- 缓冲 ≥4000 字符的消息为 fragments
- 合并连续 fragments（<1500ms 间隔 + 同 chat_id）
- 非 fragment 消息立即返回（不防抖）
- 500ms 超时后刷出合并结果

**白名单**：
- 空白名单 → 拒绝所有消息（安全默认）
- 检查 user_id 和 username
- QR 绑定请求（`/start BIND_`）绕过白名单
- 群聊需 @mention 或 `/ask` 前缀

**错误处理**：

| 错误类型 | 处理策略 |
|----------|---------|
| 429 Rate Limited | 等待 `retry_after` 秒后重试 |
| 500/503 瞬态错误 | 3 次重试，1s 退避 |
| 401 Unauthorized | 停止长轮询 |
| Markdown 解析失败 | 降级纯文本重发 |
| 消息未修改 | 静默忽略（Draft Stream 常见） |
| 消息过长 | 自动分片（4096 UTF-16 code unit 限制） |

### 2.6 Session Router

```rust
pub struct SessionRouter {
 peer_sessions: HashMap<String, PeerSession>, // peer→session 映射
 sidecar_manager: Arc<ManagedSidecarManager>,
 default_workspace: PathBuf,
 global_semaphore: Arc<Semaphore>, // 默认 5 并发
 peer_locks: HashMap<String, Arc<Mutex<()>>>, // 同一 peer 串行化
}
```

**Session Key 设计**：
```
私聊： im:telegram:private:{user_id}
群聊： im:telegram:group:{group_id}
```

**Sidecar 所有权**：IM Bot 使用 `SidecarOwner::ImBot(session_key)` 作为 Sidecar 的 owner，与 `Tab`、`CronTask`、`BackgroundCompletion` 并列。当所有 owner 释放时 Sidecar 自动停止。`ensure_session_sidecar()` 和 `release_session_sidecar()` 统一管理生命周期。

### 2.7 健康状态持久化

```rust
pub struct HealthManager {
 state: Arc<Mutex<ImHealthState>>,
 persist_path: PathBuf, // ~/.myagents/im_bots/{bot_id}/state.json
}

pub struct ImHealthState {
 pub status: ImStatus, // Online | Connecting | Error | Stopped
 pub bot_username: Option<String>,
 pub uptime_seconds: u64,
 pub last_message_at: Option<String>,
 pub active_sessions: Vec<ImActiveSession>,
 pub error_message: Option<String>,
 pub restart_count: u32,
 pub buffered_messages: usize,
 pub last_persisted: Option<String>,
}
```

**持久化**：每 5 秒写入磁盘，供前端轮询展示。

**Per-Bot 文件路径**（v3 子目录结构）：
- 健康状态：`~/.myagents/im_bots/{bot_id}/state.json`
- 消息缓冲：`~/.myagents/im_bots/{bot_id}/buffer.json`
- 去重缓存：`~/.myagents/im_bots/{bot_id}/dedup.json`（仅飞书）
- 遗留文件迁移：启动时自动迁移 v1（`im_state.json`）和 v2（`im_{botId}_*.json`）到 v3 子目录，孤儿文件自动清理

### 2.8 消息缓冲

```rust
pub struct MessageBuffer {
 queue: VecDeque<BufferedMessage>,
 max_size: usize, // 默认 100 条
 persist_path: PathBuf, // 磁盘持久化
}
```

Sidecar 不可用时消息进入缓冲队列，恢复后在同一 peer lock 内按序重放。

### 2.9 Draft Stream（流式输出到 Telegram）

已实现的 SSE 流式输出机制：

```
Rust 调用 Node /api/im/chat (SSE stream)
 │
 ├── 收到 "partial" 事件
 │ ├── 首次 → sendMessage() 创建 draft
 │ └── 后续 → editMessageText(draft_id, text)
 │ └── 节流：距上次编辑 ≥ 1s
 │ └── 截断：最多 4000 字符
 │
 ├── 收到 "block-end" 事件
 │ ├── 文本 ≤ 4096 → editMessageText 定稿
 │ └── 文本 > 4096 → deleteMessage(draft) → 分片发送
 │
 ├── 收到 "complete" 事件
 │ └── 返回 sessionId，流结束
 │
 └── 收到 "error" 事件
 └── deleteMessage(draft) → sendMessage(错误信息)
```

**多 Block 支持**：AI 回复可包含多个 text block，每个 block 独立创建/编辑 draft 消息。

### 2.10 Tauri 事件

| 事件 | Payload | 触发时机 |
|------|---------|---------|
| `im:user-bound` | `{ botId, userId, username? }` | 用户通过 QR 码绑定成功 |

### 2.11 交互式权限审批

当 IM Bot 使用非 `fullAgency` 模式时，SDK 的 `canUseTool()` 会阻塞等待审批。审批请求通过飞书交互卡片 / Telegram Inline Keyboard 展示给用户。

#### 数据流

```
canUseTool() 阻塞 → checkToolPermission() 注入 imStreamCallback('permission-request')
 → SSE 流发出 permission-request 事件
 → Rust stream_to_im() 解析 → adapter.send_approval_card()
 → 存储 PendingApproval{request_id, sidecar_port, chat_id, card_message_id}
 → SSE 流自然暂停（canUseTool 在等 Promise）

--- 用户点击按钮 / 回复文本 ---

 → approval_tx 通道 → POST /api/im/permission-response
 → handlePermissionResponse() 解除 Promise → SSE 流恢复
 → 更新卡片/消息为"已允许"或"已拒绝"
```

#### 核心类型

```rust
struct ApprovalCallback {
 request_id: String,
 decision: String, // "allow_once" | "always_allow" | "deny"
 user_id: String,
}

struct PendingApproval {
 sidecar_port: u16,
 chat_id: String,
 card_message_id: String, // 空 = 卡片发送失败，文本降级
 created_at: Instant, // 用于 15 分钟 TTL 清理
}

type PendingApprovals = Arc<Mutex<HashMap<String, PendingApproval>>>;
```

#### 文本命令降级

即使交互卡片/按钮不可用，用户也能通过文本完成审批：

| 用户回复 | 等效操作 |
|---------|---------|
| `同意` / `approve` | allow_once |
| `始终同意` / `always approve` | always_allow |
| `拒绝` / `deny` | deny |

系统自动匹配该 chat 最近的 pending approval，无需输入 request_id。

#### 平台实现

- **飞书**：`msg_type: "interactive"` 交互卡片，3 个按钮（允许/始终允许/拒绝），`card.action.trigger` 事件回调
- **Telegram**：`inline_keyboard` + `callback_query`，short_id 映射解决 64 byte `callback_data` 限制

### 2.12 飞书 WebSocket 事件 ACK

飞书 WS 协议要求客户端对数据帧发送 ACK 确认。未 ACK 的事件在 WebSocket 重连后会被服务端重放。

```rust
// 收到数据帧后立即发送 ACK（相同 seq_id，type: "ack"）
let ack_data = Self::build_ack_frame(&frame);
ws_write.send(WsMessage::Binary(ack_data.into())).await;
```

配合 72 小时 dedup 缓存 TTL（`DEDUP_TTL_SECS = 72 * 60 * 60`）作为防御兜底，防止长时间运行后重连导致消息重复处理。

### 2.13 Plugin Bridge（OpenClaw 社区插件桥接）

**设计动机**：OpenClaw 生态有大量 Channel Plugin（QQ Bot、WeChat、Matrix 等），均为 TypeScript 实现。为避免为每个平台写 Rust 适配器，引入 Plugin Bridge 机制——独立 Node.js 进程加载社区插件，仅做 Channel I/O，AI 推理走现有 Rust → Node.js Sidecar 管道。

#### 架构

```
Rust BridgeAdapter ←─ HTTP ──→ Plugin Bridge (Node.js 进程)
 │ │
 │ POST /send-text │ import(plugin)
 │ POST /send-media │ compat-api → register()
 │ POST /edit-message │ compat-runtime → dispatchReply 拦截
 │ GET /status │
 │ │ POST /api/im-bridge/message → Rust
 │ │
 ▼ ▼
SessionRouter → Sidecar(AI) 社区 IM 平台 (QQ/Matrix/…)
```

#### 核心组件

| 组件 | 位置 | 职责 |
|------|------|------|
| `BridgeAdapter` | `src-tauri/src/im/bridge.rs` | 实现 ImAdapter + ImStreamAdapter，通过 HTTP 与 Bridge 进程通信 |
| Plugin Bridge 入口 | `src/server/plugin-bridge/index.ts` | 启动 HTTP server，加载插件，转发消息 |
| compat-api | `src/server/plugin-bridge/compat-api.ts` | OpenClaw API shim，捕获 `registerChannel()` |
| compat-runtime | `src/server/plugin-bridge/compat-runtime.ts` | channelRuntime mock，拦截 `dispatchReply` 提取用户消息 |
| plugin-sdk-shim | `src/server/plugin-bridge/plugin-sdk-shim/` | 为 `openclaw/plugin-sdk` imports 提供运行时 shim |
| Bridge sender registry | `bridge.rs` 静态 `BRIDGE_SENDERS` | bot_id → (sender_channel, plugin_id) 路由映射 |

#### 消息流

**入站**（社区平台 → AI）：
1. 社区插件收到消息 → 调 `withReplyDispatcher({ run })` 或 `dispatchReplyFromConfig()`
2. compat-runtime 拦截 → 提取 ctx 字段 → POST `/api/im-bridge/message` → Rust
3. Rust 查 `BRIDGE_SENDERS` registry → `mpsc::Sender<ImMessage>` → 标准消息处理循环
4. SessionRouter → ensure_sidecar → AI Sidecar → SSE 流式回复

**出站**（AI → 社区平台）：
1. Rust `BridgeAdapter::send_message()` → POST `/send-text` 到 Bridge 进程
2. Bridge 调用插件的 deliver 回调 → 社区平台 API

#### Dispatch 返回值约定

OpenClaw 插件对 dispatch 函数的返回值做 `{ queuedFinal, counts }` 解构。**所有** dispatch 相关函数 MUST 返回此结构，否则插件崩溃：

| 函数 | 返回 |
|------|------|
| `withReplyDispatcher({ run })` | `{ queuedFinal: 0, counts: {} }` |
| `dispatchReplyFromConfig(params)` | 透传 `dispatchReplyWithBufferedBlockDispatcher` 的返回值 |
| `dispatchReplyWithBufferedBlockDispatcher(params)` | `{ queuedFinal: 0, counts: {} }`（包括 empty text 提前返回路径） |
| `createReplyDispatcherWithTyping()` 的 `dispatch` 回调 | `{ queuedFinal: 0, counts: {} }` |

#### ctx 字段提取映射

compat-runtime 从 OpenClaw 插件的 dispatch context 中提取以下字段，转发到 Rust：

| 插件 ctx 字段 | compat-runtime 变量 | Rust BridgeMessagePayload | 用途 |
|---|---|---|---|
| `BodyForAgent` / `Body` | `text` | `text` | 消息正文（BodyForAgent 含插件预处理的群聊历史） |
| `SenderId` | `senderId` | `sender_id` | 发送者 ID |
| `SenderName` | `senderName` | `sender_name` | 发送者名称 |
| `ChatType` | `chatType` | `chat_type` | `"group"` 或 `"direct"` |
| `From` | `chatId`（去除 `feishu:` 前缀） | `chat_id` | 会话 ID |
| `MessageSid` | `messageId` | `message_id` | 消息 ID |
| `WasMentioned` / `IsMention` | `isMention` | `is_mention` | 是否 @机器人 |
| `GroupSubject` / `GroupName` | `groupName` | `group_name` | 群名称（人类可读） |
| `MessageThreadId` | `threadId` | `thread_id` | 线程/话题 ID |
| `ReplyToBody` | `replyToBody` | `reply_to_body` | 引用回复原文 |
| `GroupSystemPrompt` | `groupSystemPrompt` | `group_system_prompt` | 群聊自定义系统提示 |

**isMention 默认值逻辑**：

```typescript
// compat-runtime.ts — 与 Rust management_api.rs 保持一致
const isMention = ctx.WasMentioned ?? ctx.IsMention ?? (chatType !== 'group');
// 私聊 → true（消息直达 bot），群聊 → false（需插件明确标记）
```

OpenClaw 飞书插件通过 `mentionedBot(ctx.mentions)` 检测 @mention，结果写入 `ctx.WasMentioned`。若插件未设置此字段，群消息默认 `false`——配合 `GroupActivation::Mention` 策略，未 @bot 的消息会被缓冲到群历史而非触发 AI。

#### 插件生命周期

```
安装：cmd_install_openclaw_plugin(npm_spec)
 → bun init + bun add <spec>
 → 读取 openclaw.plugin.json manifest
 → 复制 plugin-sdk-shim → node_modules/openclaw/
 → 返回 manifest + capabilities

启动：start_im_bot(platform="openclaw:qqbot")
 → spawn_plugin_bridge() (Node.js 进程)
 → 健康检查 GET /status
 → register_bridge_sender(bot_id, plugin_id, tx)
 → listen_loop + poll_handle watcher

停止：stop_im_bot()
 → POST /stop → Bridge 优雅退出
 → unregister_bridge_sender(bot_id)
 → kill bridge process

卸载：cmd_uninstall_openclaw_plugin(plugin_id)
 → is_plugin_in_use() 安全检查
 → rm -rf plugin 目录
```

### 2.14 群聊处理

#### 群激活策略

| 模式 | 行为 | 配置 |
|------|------|------|
| `GroupActivation::Mention` | 仅 @bot / `/ask` 触发 AI，其他消息缓冲到群历史 | 默认 |
| `GroupActivation::Always` | 所有消息都触发 AI，AI 可回复 `<NO_REPLY>` 跳过 | 需显式配置 |

#### 平台覆盖矩阵

| 平台 | `Mention` 上下文积攒 | `Always` 模式 | 说明 |
|------|------|------|------|
| Telegram | ✅ | ✅ | 完整支持 |
| Feishu 原生 | ✅ | ✅ | 仅识别 @bot / `/ask`，不识别 reply-to-bot |
| Dingtalk | ✅ | ✅ | `is_mention = isInAtList` |
| OpenClaw Bridge（飞书 / QQ 等） | ✅ | ✅ | `compat-runtime.ts::defaultIsMentionForGroup` 默认 `false`，依赖插件设置 `WasMentioned` |
| **OpenClaw Bridge - 企微 (wecom)** | ❌ | ❌ | 企微 AI Bot **平台限制**：webhook 仅在 `@机器人` 时下发 `aibot_msg_callback`，未 @ 的群消息上游就没有事件可推。`compat-runtime.ts::defaultIsMentionForGroup('wecom')` 硬编码 `true` 反映这一事实。前端 UI（`ChannelDetailView.tsx`）已禁用企微的"全部消息"开关并加 tooltip 说明 |

#### 群名解析（3 级 fallback）

```rust
// mod.rs — group_name 解析链
let group_name = group_permissions // 1. 用户在 UI 配置的群名
 .find(|g| g.group_id == msg.chat_id)
 .map(|g| g.group_name.clone())
 .or_else(|| msg.hint_group_name.clone()) // 2. Bridge 插件传来的群名
 .unwrap_or_else(|| msg.chat_id.clone()); // 3. 原始 chat_id
```

#### 群聊 AI Prompt 模板

Rust 构建 `GroupStreamContext` 后，Sidecar `/api/im/chat` 端点组装最终 prompt：

```
[群聊信息] ← 仅 isFirstGroupTurn
你正在「{groupName}」{groupPlatform}群聊中。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字] 标注发送者。
你会收到群里的所有消息。如果你认为不需要回复… ← 仅 GroupActivation::Always

[群聊指令] ← groupSystemPrompt（来自插件配置）
{groupSystemPrompt}

{pendingHistory} ← 积攒的未触发群消息

[引用回复] ← replyToBody（引用回复上下文）
> {quoted original text}

[from: {senderName}] ← 发送者标记
{message text}
```

**私聊引用回复**：非群聊时 `replyToBody` 也会注入（`[引用回复]\n> ...` 前置于消息）。

#### 群工具禁用

群聊默认禁用危险工具：`['Bash', 'Edit', 'Write']`。可通过 `groupToolsDeny` 配置覆盖（空数组 = 全部允许）。

#### ImMessage 群聊相关字段

```rust
pub struct ImMessage {
 // ... 基础字段（chat_id, text, sender_id 等） ...
 pub is_mention: bool, // @bot 检测结果
 pub reply_to_bot: bool, // 回复 bot 消息检测
 pub hint_group_name: Option<String>, // Bridge 插件提供的群名 hint
 pub reply_to_body: Option<String>, // 引用回复原文（Bridge 插件）
 pub group_system_prompt: Option<String>, // 群聊自定义系统提示（Bridge 插件）
}
```

这 3 个 Option 字段由 Bridge 插件透传，原生适配器（Telegram/Feishu/Dingtalk）设为 `None`。`BufferedMessage` 序列化时同步携带（`#[serde(default)]`），崩溃恢复后不丢失。

---

## 三、前端实现

### 3.1 组件结构

```
src/renderer/components/ImSettings/
├── ImSettings.tsx # 路由容器（list/detail/wizard/platform 多视图）
├── ImBotList.tsx # Bot 列表页
├── ImBotDetail.tsx # Bot 详情/配置页
├── ImBotWizard.tsx # 2 步创建向导（内置平台）
├── PlatformSelect.tsx # 平台选择页（内置 + 社区插件）
├── OpenClawWizard.tsx # OpenClaw 社区插件安装/配置向导
├── assets/
│ ├── telegram.png # Telegram 平台图标
│ └── telegram_bot_add.png # BotFather 教程截图
└── components/
 ├── BotTokenInput.tsx # Token 输入（密码型 + 验证状态）
 ├── BotStatusPanel.tsx # 运行状态单行面板
 ├── BindQrPanel.tsx # QR 码绑定面板
 ├── WhitelistManager.tsx # 白名单管理（添加/删除 + 药丸标签）
 ├── PermissionModeSelect.tsx # 权限模式单选卡片
 ├── AiConfigCard.tsx # 供应商 + 模型选择
 └── McpToolsCard.tsx # MCP 工具复选列表
```

### 3.2 路由模式（ImSettings.tsx）

```typescript
type View =
 | { type: 'list' }
 | { type: 'detail'; botId: string }
 | { type: 'wizard' };
```

无 URL 路由，纯状态驱动的视图切换。

### 3.3 Bot 列表页（ImBotList.tsx）

- **数据源**：`config.imBotConfigs[]` 来自 `useConfig()`
- **状态轮询**：每 5s 调用 `cmd_im_all_bots_status` 获取所有 Bot 状态
- **卡片布局**：2 列 grid，每张卡片展示：
 - 平台图标（Telegram PNG icon）
 - Bot 名称（优先 `@username`，fallback 配置名）
 - 运行状态点 + 文本
 - 工作区路径 · 平台类型
 - 启动/停止胶囊按钮
- **Toggle 操作**：
 - 构建启动参数（provider env、available providers、MCP servers）
 - 调用 `cmd_start_im_bot` / `cmd_stop_im_bot`
 - 乐观更新 `statuses` 状态（stop → 立即标记 stopped，start → 使用返回的 ImBotStatus）
 - 保存 `enabled` 字段

### 3.4 创建向导（ImBotWizard.tsx）

**步骤 1：Token 配置**
- 教程图片 + 步骤说明（如何从 @BotFather 获取 Token）
- Token 输入 + 验证
- 重复 Token 检测
- 保存初始配置（`setupCompleted: false`）
- 调用 `cmd_start_im_bot` 验证 Token
- 成功后自动同步 `@username` 为 Bot 名称

**步骤 2：用户绑定**
- 轮询 Bot 状态获取 `bindUrl`（3s 间隔）
- QR 码展示 + 步骤说明
- 监听 `im:user-bound` 事件自动添加白名单
- 手动白名单管理
- 完成/跳过按钮 → 设置 `setupCompleted: true`

**取消**：停止 Bot + 删除配置。

### 3.5 详情页（ImBotDetail.tsx）

**核心 Hooks/Refs**：
- `useConfig()` → config, providers, apiKeys, projects, refreshConfig
- `toastRef` → 稳定 toast 引用
- `isMountedRef` → 异步安全守卫
- `nameSyncedRef` → 名称一次性同步标记
- `botConfigRef` → effect 中使用，不触发重新执行

**配置分区**（从上到下）：

| 分区 | 组件 | 说明 |
|------|------|------|
| 标题栏 | — | `@username` 或配置名 + 启动/停止按钮 |
| 运行状态 | BotStatusPanel | 状态点 + 标签 + 运行时间 + 会话数 + 错误 |
| Telegram Bot | BotTokenInput | Token 输入 + 重复检测 + 验证状态 |
| 用户绑定 | BindQrPanel + WhitelistManager | QR 码 + 手动管理 |
| 默认工作区 | CustomSelect | 项目列表 + 文件夹选择 + 运行中自动重启 |
| 权限模式 | PermissionModeSelect | 行动/规划/自主行动 三选一 |
| AI 配置 | AiConfigCard | 供应商 + 模型（独立于客户端） |
| MCP 工具 | McpToolsCard | 全局已启用的 MCP 服务勾选 |
| 危险操作 | ConfirmDialog | 删除 Bot（二次确认） |

**副作用**：
- 状态轮询（5s）：更新状态 + 一次性同步 Bot 名称
- MCP 加载：读取全局 MCP 服务列表
- 事件监听：`im:user-bound` → 自动添加白名单
- 工作区变更：若运行中 → 读最新配置 → 重启 Bot

### 3.6 子组件

**BotTokenInput**：
- 密码输入 + 显示/隐藏切换
- 验证状态图标（Loader2/Check/AlertCircle）
- blur/Enter 时触发 onChange 回调
- 验证成功展示 `@username`

**BotStatusPanel**：
- 单行紧凑展示：`● 运行中 · 4m · 0 个会话`
- 仅运行中显示 uptime/sessions
- 重启次数 > 0 时显示
- 错误信息 inline truncate

**BindQrPanel**：
- QR 码 160×160（qrcode 库生成）
- Deep link URL + 复制按钮
- 3 步说明
- 无白名单用户时显示"推荐"标签

**PermissionModeSelect**：
- 自定义 radio 卡片（`sr-only` 隐藏原生 radio）
- 选中态：品牌色边框 + 背景 + 内圆点
- 读取 `PERMISSION_MODES` 配置（行动/规划/自主行动）

---

## 四、配置持久化

### 4.1 数据模型

```typescript
interface ImBotConfig {
 id: string; // UUID
 name: string; // 展示名（自动同步为 @username）
 platform: ImPlatform; // 'telegram' | 'feishu' | 'dingtalk' | `openclaw:${string}`
 botToken: string;
 allowedUsers: string[]; // Telegram user_id 或 username
 providerId?: string; // AI 供应商（独立于客户端）
 model?: string; // AI 模型
 permissionMode: string; // 'plan' | 'auto' | 'fullAgency'
 mcpEnabledServers?: string[]; // Bot 可用的 MCP 服务 ID
 defaultWorkspacePath?: string;
 enabled: boolean;
 setupCompleted?: boolean; // 向导完成标记
 // OpenClaw 社区插件专属
 openclawPluginId?: string; // 插件 ID
 openclawNpmSpec?: string; // npm 包名
 openclawPluginConfig?: Record<string, unknown>; // 插件运行时配置
 openclawManifest?: object; // 插件 manifest 缓存
}
```

**存储位置**：`~/.myagents/config.json` → `imBotConfigs: ImBotConfig[]`

### 4.2 Config Service（磁盘优先）

```typescript
// 三个 IM 专用函数，全部 disk-first + withConfigLock 序列化

addOrUpdateImBotConfig(botConfig) // Upsert by id
updateImBotConfig(botId, updates) // Partial merge by id
removeImBotConfig(botId) // Filter out by id
```

每个函数先 `loadAppConfig()` 读取磁盘最新，修改后 `saveAppConfig()` 写回。原子写入采用 `.tmp` → `.bak` → 目标文件 的安全模式。

### 4.3 React 状态同步

`useConfig()` 新增 `refreshConfig()` 方法：

```typescript
const refreshConfig = useCallback(async () => {
 const latest = await loadAppConfig();
 setConfig(latest); // 只更新 config state，不触发 loading
}, []);
```

**使用模式**：所有 IM 组件的 config 写操作后调用 `refreshConfig()` 同步 React 状态。

```typescript
// ImBotDetail 中的 saveBotField
const saveBotField = useCallback(async (updates) => {
 await updateImBotConfig(botId, updates);
 await refreshConfig(); // 同步到 React state
}, [botId, refreshConfig]);
```

---

## 五、数据流

### 5.1 Telegram 消息 → AI → 回复

```
Telegram 用户发消息
 │
 ▼
TelegramAdapter (getUpdates 长轮询)
 │
 ├── 白名单校验 → 不在白名单 → 忽略
 ├── MessageCoalescer 碎片合并 + 防抖
 ├── 发送到 mpsc channel
 │
 ▼
消息处理循环
 │
 ├── 命令分发（inline，无 Sidecar I/O）
 │ ├── /start BIND_ → 添加白名单 → emit "im:user-bound"
 │ ├── /model → 更新 current_model RwLock
 │ ├── /provider → 更新 current_provider_env RwLock
 │ ├── /workspace → router.switch_workspace()
 │ └── /new → router.reset_session()
 │
 └── 普通消息
 ├── 获取 per-peer lock + global semaphore
 ├── ensure_sidecar()
 ├── 若新 Sidecar → 同步 AI config
 │
 ├── POST /api/im/chat (SSE stream)
 │ ├── partial → 编辑 draft（节流 ≥ 1s）
 │ ├── block-end → 定稿（分片如 > 4096）
 │ ├── complete → 返回 sessionId
 │ └── error → 发送错误信息
 │
 ├── 清除 ACK reaction
 ├── 更新 Session + 健康状态
 └── 重放缓冲消息
```

### 5.2 QR 码绑定流程

```
用户在设置页启动 Bot
 │
 ├── Rust 生成 bind_code = "BIND_{uuid8}"
 ├── 构造 bind_url = "https://t.me/{username}?start={bind_code}"
 ├── 返回 ImBotStatus（含 bind_url）
 │
 ▼
前端 BindQrPanel 展示 QR 码
 │
 ▼
用户扫码 → Telegram 打开 Bot → 自动发送 "/start BIND_xxxx"
 │
 ▼
Rust TelegramAdapter 收到消息
 │
 ├── 解析 bind_code → 匹配成功
 ├── 添加 user_id 到 allowed_users（Arc<RwLock>）
 ├── 回复绑定成功消息
 └── emit "im:user-bound" 事件
 │
 ▼
前端 ImBotDetail/ImBotWizard 监听事件
 │
 └── 添加用户到白名单配置 → saveBotField → refreshConfig
```

### 5.3 设置页 → Bot 生命周期

```
用户打开 Settings → 聊天机器人
 │
 ▼
ImBotList（读取 config.imBotConfigs + 轮询 statuses）
 │
 ├── 点击"添加 Bot" → ImBotWizard
 │ ├── Step 1: Token + 验证 + 启动
 │ └── Step 2: QR 绑定 → 完成/跳过
 │
 ├── 点击 Bot 卡片 → ImBotDetail
 │ ├── 修改配置 → saveBotField → refreshConfig
 │ ├── 工作区变更（运行中）→ 重启 Bot
 │ └── 删除 → ConfirmDialog → stop + remove + refreshConfig + onBack
 │
 └── 点击启动/停止 → toggleBot
 ├── 启动：buildStartParams → cmd_start_im_bot → 乐观更新
 └── 停止：cmd_stop_im_bot → 乐观更新为 stopped
```

---

## 六、安全模型

| 层级 | 机制 |
|------|------|
| 连接准入 | 白名单（Telegram user_id / username） |
| 空白名单 | 拒绝所有消息（安全默认） |
| 群聊触发 | 仅响应 @Bot 或 /ask |
| AI 权限 | 默认 `plan` 模式（只分析不执行） |
| 工作区沙箱 | 操作范围不超出 workspacePath |
| Token 重复 | 前端阻止同一 Token 添加多个 Bot |
| QR 绑定 | 随机 UUID bind_code，仅对应 Bot 可识别 |

---

## 七、文件清单

### Rust

```
src-tauri/src/
├── im/
│ ├── mod.rs # 模块入口 + Commands + 消息处理循环 + Bot 生命周期 + 权限审批
│ ├── adapter.rs # ImAdapter + ImStreamAdapter trait 定义 + AnyAdapter enum
│ ├── telegram.rs # TelegramAdapter + MessageCoalescer + Inline Keyboard 审批
│ ├── feishu.rs # FeishuAdapter + WebSocket + 交互卡片审批 + ACK 机制
│ ├── dingtalk.rs # DingtalkAdapter + Stream 连接
│ ├── bridge.rs # BridgeAdapter + Plugin Bridge 进程管理 + 插件安装/卸载 + sender registry
│ ├── health.rs # HealthManager + 状态持久化
│ ├── router.rs # SessionRouter: peer→Sidecar 映射
│ ├── buffer.rs # MessageBuffer: 离线消息缓冲 + 磁盘持久化
│ └── types.rs # ImConfig, ImMessage, ImPlatform 等共享类型
├── management_api.rs # /api/im-bridge/message 端点（Bridge 入站消息路由）
└── lib.rs # Command 注册
```

### 前端

```
src/renderer/
├── components/ImSettings/ # 全部 IM 前端组件（见 §3.1）
├── config/configService.ts # IM config CRUD 函数
├── config/types.ts # PERMISSION_MODES + ImBotConfig 相关类型
├── hooks/useConfig.ts # refreshConfig 函数
└── pages/Settings.tsx # "聊天机器人" 导航入口
```

### Plugin Bridge（Node.js 进程）

```
src/server/plugin-bridge/
├── index.ts # Bridge 入口：CLI args 解析、插件加载、HTTP server
├── compat-api.ts # OpenClaw API shim（registerChannel 捕获）
├── compat-runtime.ts # channelRuntime mock（dispatchReply 拦截 → Rust，ctx 字段提取）
├── streaming-adapter.ts # 流式卡片适配（start-stream/stream-chunk/finalize-stream）
├── mcp-handler.ts # Bridge 插件 MCP 工具暴露
└── sdk-shim/
 └── plugin-sdk/
 └── feishu.js # openclaw/plugin-sdk/feishu 的 ~44 符号 shim
```

### 共享类型

```
src/shared/types/im.ts # ImBotConfig, ImBotStatus, ImPlatform, InstalledPlugin, DEFAULT_IM_BOT_CONFIG
```

### 数据文件

```
~/.myagents/
├── config.json # imBotConfigs[] 数组
└── im_bots/ # Per-bot 运行时数据
 └── {botId}/
 ├── state.json # 健康状态
 ├── buffer.json # 消息缓冲
 └── dedup.json # 去重缓存（仅飞书）
```

---

## 八、Telegram Bot API 端点

| 端点 | 用途 |
|------|------|
| `getMe` | 验证 Token + 获取 bot_username |
| `getUpdates` | 长轮询接收消息 |
| `sendMessage` | 发送文本（Markdown → 纯文本 fallback） |
| `editMessageText` | Draft Stream 编辑（流式输出） |
| `deleteMessage` | 删除 Draft（超长回复时） |
| `sendChatAction` | 发送"正在输入"状态 |
| `setMessageReaction` | ACK Reaction（⏳ / 清除） |
| `setMyCommands` | 注册命令菜单 |

---

## 九、待实现 / 未来规划

### 9.1 多端 Session 共享

当前每个 Bot 的 Session 独立于 Desktop Tab。已可通过 Desktop 打开 IM Session（跳转到已有 Sidecar），但完整双端同步尚未实现。

### 9.2 Bot Token 加密存储

当前 Token 明文存储在 `config.json`（与 Provider API Key 一致）。后续应统一迁移到 OS Keychain。

### 9.3 Bridge 插件功能补全

| 功能 | 状态 | 说明 |
|------|------|------|
| 消息分发 | ✅ 已修复 | dispatch 返回 `{ queuedFinal, counts }` |
| 群聊 isMention | ✅ 已修复 | 按 chatType 区分默认值 |
| 群名/引用回复/群系统提示 | ✅ 已透传 | 全链路闭环 |
| 群内 @mention 主动检测 | ⏳ 依赖插件 | Bridge 依赖插件设置 `WasMentioned`，无独立检测 |
| 附件/图片转发 | ⏳ 待实现 | compat-runtime 提取但 Rust `ImMessage.attachments` 为空 |
| 消息去重（Bridge） | ✅ feishu.js shim | `createDedupeCache` + Rust 层 72h dedup |

### 9.4 更多 IM 平台

`ImAdapter` trait 已定义（Telegram、飞书、钉钉已实现），可扩展 Slack、Discord 等平台，复用 Session Router 和消息处理循环。

社区平台可通过 OpenClaw Plugin Bridge 机制接入，无需编写 Rust 适配器。

---

## 附录：相关文档

| 文档 | 说明 |
|------|------|
| [架构总览](../ARCHITECTURE.md) | MyAgents 整体架构 |
| [Session 架构](./session_architecture.md) | Session 管理机制 |
| [Sidecar 管理](./bundled_node.md) | Node.js Sidecar 生命周期 |

## Agent Channel 架构

IM Bot 升级为 Agent 实体，Channel 为可插拔连接。新旧 Tauri Commands 并存：

### 新 Tauri Commands

| 命令 | 用途 |
|------|------|
| `cmd_start_agent_channel` | 启动 Agent Channel |
| `cmd_stop_agent_channel` | 停止 Agent Channel |
| `cmd_agent_channel_status` | 查询 Channel 状态 |
| `cmd_all_agents_status` | 查询所有 Agent 状态 |
| `cmd_update_agent_config` | 更新 Agent 配置 |
| `cmd_install_openclaw_plugin` | 安装 OpenClaw 社区插件 |
| `cmd_uninstall_openclaw_plugin` | 卸载插件 |
| `cmd_list_openclaw_plugins` | 列出已安装插件 |

> 旧命令 `cmd_start_im_bot` 等已标 `@deprecated`，内部转发到新 Agent API。

### InteractionScenario 扩展

系统提示词支持四种场景：
- `desktop` — 桌面客户端对话
- `im` — 内置 IM Bot（Telegram/飞书/钉钉）
- `agent-channel` — Agent Channel（OpenClaw 插件，platform 为任意字符串）
- `cron` — 定时任务

Agent Channel 与 IM Bot 的区别：`platform` 字段为 `string` 而非固定枚举，支持任意社区插件平台。

### 数据模型

```typescript
// src/shared/types/agent.ts
interface AgentConfig {
 id: string;
 name: string;
 workspacePath?: string;
 providerId?: string;
 model?: string;
 channels: ChannelConfig[];
}

interface ChannelConfig {
 id: string;
 type: ChannelType; // 'telegram' | 'dingtalk' | 'openclaw:{pluginId}'
 // ... credentials per type
}
```
