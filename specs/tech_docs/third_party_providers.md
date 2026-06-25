# 第三方 LLM 供应商集成指南

本文档总结了在 MyAgents 中集成第三方 LLM 供应商（DeepSeek、智谱、Moonshot、MiniMax 等）的关键技术经验。

---

## 核心原理

Claude Agent SDK 支持通过环境变量配置第三方 API：

| 环境变量 | 作用 |
|----------|------|
| `ANTHROPIC_BASE_URL` | API 端点地址 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证令牌 |
| `ANTHROPIC_API_KEY` | API 密钥（SDK 可能使用此变量）|
| `ANTHROPIC_MODEL` | 默认模型 ID |

---

## 关键经验

### 1. 环境变量必须同时设置两个 Key 变量

SDK 不同版本可能使用不同的环境变量名，建议同时设置：

```typescript
env.ANTHROPIC_AUTH_TOKEN = apiKey;
env.ANTHROPIC_API_KEY = apiKey;
```

### 2. 切换回官方订阅时必须清除环境变量

问题：切换到第三方后再切回 Anthropic 订阅，如果 `ANTHROPIC_BASE_URL` 仍存在，请求会发到错误的端点。

解决：显式删除环境变量：

```typescript
if (currentProviderEnv?.baseUrl) {
  env.ANTHROPIC_BASE_URL = currentProviderEnv.baseUrl;
} else {
  delete env.ANTHROPIC_BASE_URL; // 关键！
}
```

### 3. API Key 存储与读取

- **存储位置**: `apiKeys[provider.id]`（通过 useConfig 获取）
- **常见错误**: 误用 `provider.apiKey`（始终为 undefined）
- **正确做法**: 

```typescript
const { apiKeys } = useConfig();
const apiKey = apiKeys[currentProvider.id];
```

### 4. Provider 配置结构

```typescript
interface Provider {
  id: string;
  name: string;
  config: {
    baseUrl?: string;  // 第三方 API 端点
  };
  models: ModelEntity[];
  primaryModel: string;
}
```

---

## 预设供应商 BaseURL

| 供应商 | BaseURL | 类型 | 备注 |
|--------|---------|------|------|
| DeepSeek | `https://api.deepseek.com/anthropic` | 模型官方 | Anthropic 兼容 |
| Moonshot | `https://api.moonshot.cn/anthropic` | 模型官方 | Anthropic 兼容 |
| 智谱 AI | `https://open.bigmodel.cn/api/anthropic` | 模型官方 | Anthropic 兼容 |
| MiniMax | `https://api.minimaxi.com/anthropic` | 模型官方 | Anthropic 兼容 |
| 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | 云服务商 | 字节跳动 |
| 火山方舟 API调用 | `https://ark.cn-beijing.volces.com/api/compatible` | 云服务商 | 字节跳动 |
| 硅基流动 | `https://api.siliconflow.cn/` | 云服务商 | authType: api_key |
| ZenMux | `https://zenmux.ai/api/anthropic` | 云服务商 | 多模型聚合路由 |
| OpenRouter | `https://openrouter.ai/api` | 云服务商 | authType: auth_token_clear_api_key |

> **注意**：所有供应商使用 Anthropic 兼容端点。不同供应商 `authType` 可能不同，详见 `types.ts` 中的 `PRESET_PROVIDERS`。

---

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ Chat.tsx                                                     │
│  - 用户选择 provider/model                                  │
│  - 新写入路径持久化 ProviderRoute: {providerId, model}      │
│  - 不持久化 apiKey/baseUrl/modelAliases                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /chat/send
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ session-engine/builtin-adapter.ts                            │
│  - 校验 ProviderRoute 与本次 model 一致                     │
│  - 调 admin-config materialize ProviderEnv                  │
│  - subscription route → 'subscription' sentinel              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ agent-session.ts                                             │
│  - 存储运行时 currentProviderEnv（非持久身份）              │
│  - buildClaudeSessionEnv() 设置环境变量                      │
│  - SDK query() 使用这些环境变量                             │
└─────────────────────────────────────────────────────────────┘
```

### ProviderRoute vs ProviderEnv

- `ProviderRoute` 是会话持久身份，只保存 provider/model：`{kind:'provider', providerId, model}` 或 `{kind:'subscription', providerId:'anthropic-sub', model}`。
- `ProviderEnv` 是请求运行时派生物，包含 `baseUrl`、`apiKey`、`authType`、`modelAliases`；只能从当前配置即时 materialize，不能作为新会话身份写回 `sessions.json`。
- `providerEnvJson` 只读兼容旧数据：没有 `providerRoute` 的历史 session 才允许 fallback 读取。新写入路径必须写 `providerRoute`，并省略/清空 `providerEnvJson`。
- `model + configSnapshotAt` 旧 session 缺 provider 时，只在“声明该 model 且本地有凭据/账号证据”的 provider 中修复。API provider 看非空 API key；Anthropic subscription 看 valid 状态、`accountEmail` 或 `verifiedAt` 任一存在。多个候选或没有候选时，不猜默认 provider，要求用户在模型选择器重新选择。

---

## 调试技巧

查看后端日志确认环境变量是否正确设置：

```
[env] ANTHROPIC_BASE_URL set to: https://open.bigmodel.cn/api/anthropic
[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set from provider config
[agent] starting query with model: glm-4.7
```

如果看到 `apiKeySource: "none"`，说明 API Key 未正确传递。

---

## ⚠️ 关键陷阱：会话中途切换供应商

### 问题

环境变量（`ANTHROPIC_BASE_URL`）在 SDK 子进程启动时设置，**无法在运行时更新**。如果用户在会话中途切换供应商：

1. `currentProviderEnv` 更新 ✅
2. 正在运行的 SDK 进程仍使用旧的 baseUrl ❌
3. API 请求发往错误的端点 → 报错"模型不存在"

### 解决方案

检测供应商变化时，**终止当前 SDK 会话并重启**。重启后是否 resume 旧 SDK transcript 由 `canResumeAcrossProviderBoundary(...)` 统一判断：

```typescript
if (providerChanged && querySession) {
  const crossesProviderHistoryBoundary = !canResumeAcrossProviderBoundary(
    toProviderHistoryEnv(currentProviderEnv, currentModel),
    toProviderHistoryEnv(providerEnv, nextModel),
  );
  currentProviderEnv = providerEnv;
  abortPersistentSession();  // 统一中止：设置标志 + 唤醒 generator 门控 + interrupt

  // 等待旧会话完全终止，避免竞态条件
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  if (crossesProviderHistoryBoundary) {
    resetForProviderHistoryBoundary(); // sessionRegistered=false，下一次 query({ sessionId }) fresh start
  }

  // schedulePreWarm() 会在 finally 中自动触发
}
```

### 注意事项

- **应用层 session 保留**：`sessionId`、`messages` 不变
- **SDK 层 session 重建**：`querySession` 通过 pre-warm 重新创建
- **跨回合状态清理**：`streamIndexToToolId`、`toolResultIndexToId`、`childToolToParent` 由 `builtin-session/turn-lifecycle.ts` 的 terminal cleanup 触发清理（`agent-session.ts` 只组装清理回调）
- **统一中止**：所有需要终止 session 的场景必须使用 `abortPersistentSession()`，它同时唤醒 generator 的 Promise 门控并调用 `interrupt()`

---

## ⚠️ 关键陷阱：Provider 历史边界与 Resume

### 问题

Anthropic 官方 API 会在 thinking block 中嵌入签名，resume session 时校验签名。普通第三方供应商（DeepSeek、GLM 等）默认进入 portable protocol family：provider env 变化仍会重启 SDK subprocess，但重启后可以 resume 旧 transcript，保留用户在同一会话中切换模型 / provider 的工作流。

从第三方供应商切换到 Anthropic 官方后 resume session 会报错：`Invalid signature in thinking block`
如果未来确认某个 provider / model / endpoint 无法 replay 其他历史，才把它加入 `src/shared/providerHistory.ts::ISOLATED_PROVIDER_HISTORY_KEYS`。进入或离开 isolated entry 时，前端必须提示"创建新会话"，后端必须 fresh SDK session reset；isolated entries 之间也不能共享 transcript。

### Resume 规则

| From | To | Resume | 原因 |
|------|-----|--------|------|
| 三方 portable | Anthropic 官方 | ❌ 新 session | Anthropic signed history 边界不同 |
| Anthropic 官方 | 三方 portable | ❌ 新 session | Anthropic signed history 边界不同 |
| 三方 portable A | 三方 portable B（同协议） | ✅ resume | 保留同一会话内切换 GLM / DeepSeek 等普通三方模型的工作流 |
| Anthropic-protocol 三方 | OpenAI-bridge 三方 | ❌ 新 session | SDK transcript 经过的协议入口不同 |
| 任意 non-isolated | isolated entry | ❌ 新 session | 已知该 entry 不支持跨边界 replay |
| isolated entry A | isolated entry B | ❌ 新 session | isolated entries 不互串 transcript |
| Anthropic 订阅 | Anthropic API Key | ✅ resume | 签名兼容 |

### 区分标准

```typescript
// Provider history identity:
// - no baseUrl, or https://api.anthropic.com = Anthropic signed family
// - ordinary third-party providers share `third-party:<apiProtocol>`
// - entries listed in ISOLATED_PROVIDER_HISTORY_KEYS get an `isolated:*`
//   identity that also includes provider/model/endpoint context
//
// ISOLATED_PROVIDER_HISTORY_KEYS is intentionally empty initially.
// Add exact keys only after a concrete incompatibility is confirmed:
// - provider:<providerId>
// - model:<modelId>
// - endpoint:<apiProtocol>:<normalizedBaseUrl>
```

---

## ⚠️ 关键陷阱：订阅模式的 providerEnv

### 原则

- `providerEnv = undefined`：使用 SDK 默认认证（Anthropic 订阅）
- `providerEnv = { baseUrl, apiKey }`：使用第三方 API

前端构建 `providerEnv` 时，**订阅模式不发送 providerEnv**：

```typescript
const providerEnv = currentProvider && currentProvider.type !== 'subscription'
  ? { baseUrl: ..., apiKey: ..., authType: ... }
  : undefined;
```

后端检测订阅切换：

```typescript
// 从 API 模式切换到订阅模式
const switchingToSubscription = !providerEnv && currentProviderEnv;
```

---

## ⚠️ 关键陷阱：智谱 GLM-4.7 的 server_tool_use

### 背景

智谱 GLM-4.7 支持服务端工具调用（如 `webReader`、`analyze_image`），返回 `server_tool_use` 类型的内容块，与 Claude 的 `tool_use`（客户端工具）不同：

| 类型 | 执行位置 | 示例工具 |
|------|----------|----------|
| `tool_use` | 客户端（本地 Sidecar） | MCP 服务器工具 |
| `server_tool_use` | 服务端（API 提供商） | webReader, analyze_image |

### 问题 1：input 是 JSON 字符串

智谱返回的 `server_tool_use.input` 是 **JSON 字符串**，而非对象：

```json
{
  "type": "server_tool_use",
  "input": "{\"url\": \"https://example.com\", \"type\": \"markdown\"}"
}
```

**解决方案**：

```typescript
let parsedInput: Record<string, unknown> = {};
if (typeof serverToolBlock.input === 'string') {
  try {
    parsedInput = JSON.parse(serverToolBlock.input);
  } catch {
    parsedInput = { raw: serverToolBlock.input };
  }
} else {
  parsedInput = serverToolBlock.input || {};
}
```

### 问题 2：装饰性文本包裹

智谱会在 `server_tool_use` 前后插入装饰性文本块，如果不过滤会显示为普通内容：

```
🌐 Z.ai Built-in Tool: mcp__web_reader__webReader
**Input:**
```json
{"url": "https://example.com", "type": "markdown"}
```
Executing on server side...
```

以及结果包裹：

```
**Output:** webReader_result_summary:[{"title":"..."}]
```

**解决方案**：在后端 `agent-session.ts` 中过滤这类文本：

```typescript
// 检测并过滤装饰性工具文本
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  if (!text || text.length < 50 || text.length > 5000) {
    return { filtered: false };
  }
  const trimmed = text.trim();

  // Pattern 1: 智谱 tool invocation wrapper - requires ALL markers
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');
  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 tool output wrapper - requires ALL markers
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}
```

**注意事项**：
- 使用**多条件匹配**，避免误伤正常内容
- 添加长度限制（50-5000 字符），进一步降低误判风险
- 记录过滤日志，便于调试

---

## 自定义供应商

用户可通过 Settings 或 Admin API 添加自定义 OpenAI 兼容供应商。自定义供应商配置持久化到 `~/.myagents/providers/{id}.json`。

### modelAliases 默认值

自定义供应商如果没有主动设置 modelAliases，`getEffectiveModelAliases()` 和 `resolveProviderEnv()` 会用 `primaryModel` 或第一个可用模型作为 sonnet/opus/haiku 的 fallback，防止子 Agent 发送 raw `claude-*` 到三方 API。
