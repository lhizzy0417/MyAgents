---
type: prd
status: draft
created: 2026-06-25
updated: 2026-06-25
scope: "Builtin provider/model route identity across Desktop Chat, Floating Ball, IM Agent Channel, Task/Cron, and SessionEngine"
issue: "本会话架构收敛：model-only legacy snapshots cannot identify the provider/baseUrl; providerEnvJson is a stale credential-bearing compatibility field"
research: "specs/ARCHITECTURE.md; specs/tech_docs/session_architecture.md; specs/tech_docs/third_party_providers.md; specs/tech_docs/task_provider_routing.md; specs/tech_docs/multi_agent_runtime.md; specs/tech_docs/im_integration_architecture.md; specs/prd/prd_0.2.40_session_config_snapshot_identity_repair.md; specs/prd/prd_0.2.39_session_config_ownership_repair.md; specs/prd/prd_0.2.3_provider_model_pairing.md; specs/prd/prd_0.2.9_task_provider_routing.md"
review: "completed(sub-agent architecture / compatibility / adversarial review; findings folded into resolver layering, legacy UX, CAS repair, and write-path inventory)"
---

# Provider Route Identity Architecture

## 执行须知（给空 session 的你）

你要解决的不是“某个模型选择器选错了 provider”，而是把 MyAgents 的 builtin provider 路由身份收敛成一个跨入口一致的不变量：

1. `model` 不是路由身份，永远不能单独决定 provider/baseUrl。
2. 新架构里，持久层保存的是 `ProviderRoute`（providerId + model 的路由身份），运行时才从同一个 live provider definition 原子解析成 `ProviderEnv`。
3. `ProviderEnv` 是 SDK subprocess 的环境变量派生物，不是业务配置，不应该成为新 session 的权威持久字段。
4. 历史数据必须兼容，但兼容只能发生在一个 identity normalization layer 里；不能继续在 Chat、Floating Ball、Cron、IM 各自猜 provider。
5. 遇到无法确定 provider 的旧 owned builtin session，必须 fail-closed，让用户选择 provider 后再继续；不能静默落到 Anthropic/subscription/first available provider。

第一轮开发不要从 UI 改起。先落 shared/server 的 route 类型、resolver、兼容读、测试，再让 Desktop Chat、悬浮球、IM/Task/Cron 入口都吃同一份结果。

## 背景

v0.2.40 把 builtin 模型选择升级为 provider-scoped 之后，暴露出历史 snapshot 的根本问题：很多 owned session 只存了 `model + configSnapshotAt`，没有 `providerId`。但实际发请求时，SDK 需要的是 provider 对应的 baseUrl、鉴权方式、OpenAI bridge 配置、model alias 等运行时环境。`fa6c56d7 fix(session): recover legacy snapshot provider identity` 已经做了一个局部修复：在 renderer 里用 provider registry 尝试从 model 反推 provider，能唯一确定就恢复 providerId，不能确定就标记 unknown。

这个修复是必要的兼容垫片，但不是终局架构，原因是：

1. 它主要修 Chat renderer。悬浮球发 `/chat/send` 时不带 `providerEnv`，完全依赖 sidecar 从 session metadata 自恢复；服务端 resolver 不懂 legacy model-only，就仍然无法路由。
2. 当前 metadata schema 同时存在 `providerId`、`model`、`providerEnvJson`。其中 `providerEnvJson` 带密钥且会 stale，Task/Cron 已经把类似字段标为 legacy read-only，但 session 侧还在写。
3. 当前 `ProviderEnv | 'subscription' | undefined` 的函数参数语义混合了三件事：保持当前 provider、切 subscription、切具体 provider。它适合 runtime 内部，不适合作为产品层持久身份。
4. external runtime（Codex/Claude Code/Gemini）没有 MyAgents builtin provider 概念；如果继续让 loose `model/providerId` 横穿所有路径，很容易把 builtin 字段写进 external session。

本 PRD 的目标是把 “model 对应哪个供应商、请求走哪个 baseUrl” 这件事从散落的调用点中抽出来，定义为一等 Route。

## 当前技术事实

### Session snapshot

`SessionMetadata` 当前持久字段位于 `src/server/types/session.ts`，包括：

- `runtime`
- `model`
- `reasoningEffort`
- `permissionMode`
- `mcpEnabledServers`
- `enabledPluginIds`
- `providerId`
- `providerEnvJson`
- `configSnapshotAt`

`configSnapshotAt` 存在时，owned session 的配置由 session snapshot 拥有；缺字段不能随便回落到 Agent 默认值。这是 `prd_0.2.39_session_config_ownership_repair.md` 与 `prd_0.2.40_session_config_snapshot_identity_repair.md` 已经确立的不变量。

### Desktop Chat

`src/renderer/pages/Chat.tsx` 当前从 provider registry + config api key 组装 `ProviderEnv`，再通过 `TabProvider.sendMessage` 把它发给 `/chat/send`。`src/server/agent-session.ts::enqueueUserMessage` 接收后用这些语义：

- `undefined`：保持当前 provider。
- `'subscription'`：清空 provider env，走 Anthropic subscription。
- `ProviderEnv` object：切到具体 provider。

这条链路能工作，但 credential-bearing route 在 renderer 和 HTTP body 里传递；而且它只覆盖 Desktop Chat 主发送路径。

### Sidecar restore

`src/server/utils/admin-config.ts::resolveWorkspaceConfig` 是 sidecar 启动/恢复 owned session 和 headless session 的核心读取路径。它当前按 `providerId` 调 `resolveProviderEnv(providerId)`，再在 `providerEnvJson` 存在时优先 decode snapshot。

这说明服务端已经有“从 providerId live-resolve env”的骨架，但还缺三件事：

1. 没有 canonical `ProviderRoute` 类型。
2. 没有统一处理 `model-only + configSnapshotAt` 的 legacy resolver。
3. `providerEnvJson` 仍然会在新 owned session freeze 时写入。

### Floating Ball

`src/renderer/floating-ball/useFloatingSession.ts` 创建悬浮球 session 时走 `createSession(..., { seedMaxPermission: true })`，服务端用 owned snapshot 捕获 runtime/model/provider/MCP。悬浮球发送消息时只传 `text/images/permissionMode/analyticsSource`，不传 `model/providerEnv`。

因此悬浮球正确性完全依赖 sidecar restore。只在 Chat renderer 做 legacy providerId 反推，无法修复悬浮球旧 session。

### Task/Cron

Task/Cron 已经接近目标架构：

- Rust `CronTask` 持久化 `provider_id + model`，不再写 `provider_env`。
- `provider_env` 是 legacy read-only 字段，反序列化兼容但 `skip_serializing`。
- Rust 校验 `provider_id.is_some() => model.is_some()`，并禁止 external runtime 同时指定 providerId。
- 执行时把 `provider_id/model` 传到 sidecar，由 sidecar 每 tick live-resolve provider env。

这条线应作为 session 侧终局的参照，而不是另起一个 session-only 规则。

### IM Agent Channel

IM/Agent Channel 有两种语义：

- pure IM / agent-channel session：live-follow AgentConfig + ChannelOverrides，每次消息按 channel/agent 当前配置解析。
- detach/opened/owned session：被 session snapshot 接管，之后按 owned session 规则。

新架构不能把 pure IM 误升级成 frozen provider snapshot；但 IM 每次 live-follow 解析出的 builtin route 仍然应该走同一套 route identity helper 与 server materializer。

### Multi-Agent Runtime

External runtime 不使用 builtin provider route。`src/server/session-engine/` 是跨 runtime 的 facade，新 config/send/read endpoint 必须通过 SessionEngine 分流，而不是在 route module 里手写 runtime 分支。

因此 `ProviderRoute` 的适用范围必须是：

- builtin engine：可有 route。
- external engine：route 为 not-applicable，输入 providerId 必须被拒绝或 scrub。

## 产品目标

1. owned builtin session 的 provider/model 身份完整、自包含、可恢复。
2. 新写入的数据不再需要 credential-bearing `providerEnvJson` 才能恢复请求路由。
3. Desktop Chat、悬浮球、IM Agent Channel、Task/Cron、Background/Inbox/Heartbeat 都复用同一套 provider route identity helper 与 server materializer。
4. 历史数据自动兼容：可确定的 legacy session 静默修复；不可确定的 legacy session 清楚阻断并要求用户选择 provider。
5. provider 切换、model 切换、history boundary、OpenAI bridge、usage provider attribution 都继续正确。
6. external runtime 的模型配置继续归 external runtime 所有，不被 builtin provider route 污染。

## 历史 session 用户体验策略

用户目标是“历史 session 对我无感”。本 PRD 的 UX 判据是：

1. 只要 provider 身份能从历史数据中被确定，用户就不应该看到任何修复动作。
2. 只有当历史数据本身无法回答“这个 model 当时属于哪个 provider”时，才允许出现一次性确认。
3. 任何情况下都不能为了无感而猜 provider；猜错会把请求打到错误 baseUrl、错误 API key 或错误账单，比一次性确认更坏。

当前分支里的实际体验：

| 历史数据形态 | 当前体验 | 终局体验 |
| --- | --- | --- |
| `providerId + model` | 基本可恢复；session 侧能按 providerId resolve env | model 属于该 provider 时完全无感并补 canonical route；错配不固化 |
| `providerEnvJson + model` | 能 decode 时可恢复，但密钥 blob 仍是权威之一，且可能 stale | 作为 read-only legacy fallback 继续可用；不把 opaque env 自动升级成 canonical route，用户后续重选模型时再清理成无密钥 route |
| `model + configSnapshotAt` 且 model 在已配置凭据的 provider 中唯一命中 | Desktop Chat 在 `fa6c56d7` 后已能局部无感恢复；悬浮球/headless 仍可能缺 provider env | 完全无感；server resolver 也自动修复，悬浮球同样正确 |
| `model + configSnapshotAt` 且 model 在已配置凭据的 provider 中多命中 | 当前不能可靠知道原 provider，Chat 不能安全猜 | 不强行无感；模型选择器进入待选择状态，用户按正常选模型流程选一次 |
| `model + configSnapshotAt` 但没有任何已配置凭据的 provider 命中 | 当前容易表现为 provider 不可用、请求失败或错误 fallback | 不 fallback；模型选择器进入待选择/待配置状态 |
| 无 `configSnapshotAt` 但有 session hints 的旧 session | 这是 legacy unlocked，不是 owned snapshot | 本次读取继续使用 session hints，避免突然换 provider；不静默 promote |
| external runtime 历史 session | providerId 本来不适用 | 不引入 provider route；继续使用 runtimeConfig |

因此，“用户无感”可以作为默认承诺，但不能作为绝对承诺。绝对不可见修复只有在数据足够判定时才正确；数据不可判定时，产品应该把这件事缩小成一次性、可理解、可恢复的确认，而不是静默 misroute。

## 非目标

1. 不改变 Claude Agent SDK 的 provider env 接入方式；SDK subprocess 仍然通过 env/baseUrl/bridge 注册工作。
2. 不迁移或重写 transcript 内容。
3. 不让 model id 成为全局唯一标识；模型仍然只在 provider scope 内有意义。
4. 不在 task/cron/session metadata 里持久化 API key。
5. 不一次性删除旧字段；`providerId/model/providerEnvJson` 必须保留读兼容，直到所有历史读取路径稳定。

## 终局数据模型

新增 shared 类型，建议放在 `src/shared/providerRoute.ts`，server/renderer 都只引用这里的纯类型和纯 helper。

```ts
export type BuiltinProviderRoute =
  | BuiltinConcreteProviderRoute
  | BuiltinSubscriptionProviderRoute
  | BuiltinUnknownLegacyProviderRoute;

export type BuiltinConcreteProviderRoute = {
  kind: 'provider';
  providerId: string;
  model: string;
};

export type BuiltinSubscriptionProviderRoute = {
  kind: 'subscription';
  providerId: string;
  model: string;
};

export type BuiltinUnknownLegacyProviderRoute = {
  kind: 'unknown-legacy';
  model: string;
  reason: 'missing-provider-id' | 'ambiguous-model' | 'provider-deleted' | 'provider-disabled';
  candidateProviderIds?: string[];
};
```

关键约束：

1. `kind:'provider'` 和 `kind:'subscription'` 都必须有 `providerId + model`。
2. `kind:'unknown-legacy'` 只能来自历史读取，不允许新写入。
3. external runtime 的 session metadata 不允许有 `providerRoute`。
4. `providerId/model` 旧字段在迁移期作为 mirror 保留，方便旧 UI、统计、列表筛选继续工作。
5. `providerRoute` 不保存 baseUrl、API key、authType、apiProtocol、modelAliases 等 provider definition 字段。Provider definition 是全局 live resource，和 `resolveSessionConfig` 里“tool registry/provider definitions 不在 session snapshot 里”的既有约束一致。

`SessionMetadata.providerEnvJson` 的新定位：

- read-only legacy compatibility field。
- 新写入 owned snapshot 时默认不写。
- 只有读取旧数据且没有 concrete `ProviderRoute` 时允许 decode，用来保持历史 session 可运行；本期不从 opaque `providerEnvJson` 自动推断/补写 canonical route，避免把旧密钥 blob 或旧 endpoint 误固化成新身份。
- decode 必须走 allow-list builder，显式丢弃 `apiKey`。禁止 `{ ...decodedEnv }` 写入任何新持久结构。
- 如果旧 blob 无法映射到 providerId，但它本身包含完整 baseUrl+apiKey，这是 `legacy-env` 兼容态，不是 canonical route；允许短期只读使用，但不补写 canonical，也不把密钥复制到新字段。

Agent/Channel/Rust IM 配置里的 legacy `providerEnvJson` 本期只纳入 read/fallback 边界，不做全量废弃迁移。若要彻底删除这些字段，需要单独 phase 覆盖 renderer agent config service、Rust `im/types.rs`、config store、channel patch 与迁移策略。

## 持久化策略

`SessionMetadata` 新增：

```ts
providerRoute?: BuiltinProviderRoute;
```

迁移期保留旧字段镜像：

- `providerRoute.kind !== 'unknown-legacy'` 时，同步写 `providerId = providerRoute.providerId`、`model = providerRoute.model`。
- `providerRoute.kind === 'unknown-legacy'` 时，只保留原始 `model`，不补 providerId。
- external runtime 写入时清掉 `providerRoute/providerId/providerEnvJson`，`model` 仍表示 runtime model。

为什么需要一个嵌套字段，而不只继续用 `providerId + model`：

1. 需要显式表达 `unknown-legacy`，避免把“不知道 provider”编码成 `providerId: undefined` 后被误认为 subscription/default。
2. 需要让 read path 有一个 canonical 结果，避免 Chat/FB/IM/Cron 继续各自补丁。
3. 需要在类型上区分 builtin provider route 与 external runtime model，避免 loose `model/providerId` 横穿所有 runtime。

## Resolver 分层

不要新增一个吞掉所有 owner 语义的“超级 resolver”。终局是两层：

1. `src/shared/providerRoute.ts`：纯 identity normalization。只处理 `providerRoute/providerId/model/providerEnvJson` 这些字段如何归一成 provider route identity，不读磁盘、不读 API key、不碰 SessionEngine state。
2. `src/server/utils/admin-config.ts` / `resolveWorkspaceConfig` / `resolveSessionConfig`：保留现有 owner 语义，在 provider 字段处调用 identity helper，再做 `ProviderRoute -> ProviderEnv` credential materialization。

这意味着 `resolveWorkspaceConfig`、`resolveSessionConfig`、`snapshotForOwnedSession` 不被替换；它们只把 loose provider 字段升级为 canonical route 字段，继续分别承担磁盘解析、owned/live-follow、snapshot 构造的既有职责。

server materializer 输出：

```ts
export type ProviderRouteResolution =
  | { status: 'resolved'; route: BuiltinConcreteProviderRoute | BuiltinSubscriptionProviderRoute; providerEnv?: ResolvedProviderEnv }
  | { status: 'legacy-env'; providerEnv: ResolvedProviderEnv; model?: string; reason: 'unmapped-provider-env-json' }
  | { status: 'unknown-legacy'; route: BuiltinUnknownLegacyProviderRoute }
  | { status: 'not-applicable'; runtime: RuntimeType }
  | {
      status: 'error';
      code:
        | 'provider-missing'
        | 'provider-disabled'
        | 'api-key-missing'
        | 'model-not-in-provider'
        | 'provider-model-mismatch';
      message: string;
    };
```

### Credential-configured candidate set

`model-only + configSnapshotAt` 的自动归属不能在全量 preset/custom provider registry 里匹配。全量预设里大量 provider 共享模型名，直接用全量 registry 会把本可无感修复的旧 session 误判成 ambiguous。

自动归属的候选集定义为：

1. provider definition 存在，且声明了该 `model`。
2. API provider：`config.providerApiKeys[providerId]` 存在非空 key。
3. Anthropic subscription provider（`anthropic-sub`）：本地存在订阅账号凭据证据即可参与候选，包括 `providerVerifyStatus['anthropic-sub'].status === 'valid'`、缓存过的 `accountEmail`、或可证明曾完成登录/验证的 `verifiedAt` 记录。`accountEmail` 是 enrichment，不要求一定存在；如果用户只通过 `claude auth login` 登录过但没有 email，也不能因此排除。
4. 不做 upstream 网络校验，不判断余额，不验证 key/token 是否真实可用，也不判断订阅是否仍在有效期内。自动归属阶段只判断“用户曾经/当前为这个 provider 配过凭据”。
5. 自动归属阶段不使用 providerOrder、defaultProvider、first available、enablement/special-casing 做 tie-breaker；只看“这个 provider 是否有凭据证据且声明该 model”。
6. 除 `anthropic-sub` 这种有账号凭据证据的 subscription 外，其他 no-key provider 不纳入候选。

这个候选集只用于“从 model 推断 provider 身份”。真正发送时仍然走 `ProviderRoute -> ProviderEnv` materializer，按正常 provider 配置错误处理请求失败、key 无效、token 失效、订阅过期、上游不可达等问题。

解析规则：

0. 先 normalize runtime。`runtime !== 'builtin'` 时直接返回 `not-applicable`，并 lazy scrub `providerRoute/providerId/providerEnvJson/enabledPluginIds`；`model` 只按 external runtime model 处理，stale builtin model 走现有 runtime coerce/drop，不进入 provider route。
1. canonical `providerRoute` 存在：按 route 解析。provider 必须存在、启用、model 属于该 provider；否则返回 error，不 fallback。
2. legacy `providerId + model` 存在：只有 provider 存在、启用、且 model 属于该 provider 时，才能构造 canonical route 并 lazy repair。否则进入 `provider-model-mismatch` 或 `unknown-legacy`，不能把污染数据固化。
3. legacy `providerEnvJson + model` 存在：只在没有 concrete route 时 decode 成 `legacy-env` 只读兼容态，以保持历史 session 可运行；不得 lazy repair，不得写新字段。用户后续在模型选择器重新选择 provider/model 时，才按正常选择流程写 canonical route 并清掉旧 env。
4. 如果同时存在 concrete `providerRoute`，live materialization 永远优先，旧 `providerEnvJson` 不得覆盖 canonical route。
5. legacy `model + configSnapshotAt` 存在但 providerId 缺失：server 自动 repair 只能使用持久 metadata + credential-configured candidate set 的唯一匹配；不能使用全量 preset registry、mutable `currentProviderEnv` 或 pre-warm state。renderer 的 `selectedProviderId` 只允许作为用户显式修复动作输入，不能作为后台自动 repair 依据。候选多命中或无命中都进入 `unknown-legacy`。
6. `configSnapshotAt` 不存在但 session 有 `providerId/providerEnvJson/model`：这是 `legacy-unlocked-with-session-hints`。本次 effective config 可以优先使用 session hints，避免旧桌面会话突然换 provider；但纯读取不盖 `configSnapshotAt`，不 promote 成 owned providerRoute。只有用户显式改配置或新 owner freeze/materialize 时才写 canonical route。
7. provider disabled/deleted/key missing：不能落到 first available provider；返回 error 或 unknown，UI 给可恢复动作。

env 派生规则：

1. `kind:'subscription'`：`providerEnv = undefined`，但 `providerId/model` 仍保留为业务身份。
2. `kind:'provider'`：从同一个 live provider definition 原子读取 baseUrl/auth/apiProtocol/modelAliases/API key。禁止把旧 snapshot baseUrl 与当前 API key 混搭。
3. OpenAI protocol 仍由 `agent-session.ts` 的 bridge 注册和 `buildClaudeSessionEnv()` 完成，resolver 只产出同形 `ResolvedProviderEnv`。

## API 与 SessionEngine

所有新 send/config/materialize 能力走 `src/server/session-engine/` facade。

### 新请求形状

Desktop/builtin 发送和配置更新应传产品层 route，而不是 env：

```ts
type BuiltinRouteInput =
  | { kind: 'provider'; providerId: string; model: string }
  | { kind: 'subscription'; providerId: string; model: string };
```

`DesktopMessageRequest` 增加 `providerRoute?: BuiltinRouteInput`。`InjectedTurnRequest` 只在 Cron explicit override 这类“调用方明确选择 provider”的路径允许带 `providerRoute`。IM live-follow、Inbox、BackgroundCompletion、Heartbeat、Memory Update 默认不携带 route/env，它们依赖 sidecar 从 canonical session route 或 live Agent/Channel 配置恢复出的 current provider。

`providerEnv?: ProviderEnv | 'subscription'` 保留 legacy 入口，但新 renderer 不再使用。

SessionEngine adapter 负责：

1. builtin：把 `providerRoute` 交给 resolver 得到 `ProviderEnv | undefined`，再调用现有 `enqueueUserMessage`。
2. external：如果请求带 `providerRoute/providerId/providerEnv`，返回 400 或 scrub 后带明确日志；不要隐式忽略会造成配置漂移。

### 配置读取

`SessionEngineConfigSnapshot` 增加：

```ts
providerRoute?: BuiltinProviderRoute | null;
providerIdentityStatus?: 'resolved' | 'unknown-legacy' | 'not-applicable' | 'error';
providerIdentityMessage?: string;
```

旧的 `providerId` 继续返回 mirror，供旧 UI 和统计读取。

### 配置写入

不要为 Desktop/renderer 新增 provider setter。现有 session 架构里，Desktop provider/model 修改的权威路径是：

1. `persistInputOptionChange` 写 session snapshot / Project / Agent。
2. 用户发送时 `/chat/send` 携带 `providerRoute`，sidecar 对当前 turn 解析并在需要时重启 SDK subprocess。

`/api/provider/set` 保持 legacy/Rust IM sync 入口，不成为新 renderer 调用点。若后续需要 route-first setter，只能作为 IM sync 兼容层进入 SessionEngine，且必须保留旧 endpoint 的 external-runtime skip/compat 响应语义，不能改变 Desktop 的 owner 模型。

`SessionEngineSnapshotMaterializePatch` 增加 `providerRoute?: BuiltinProviderRoute | null`。`providerEnvJson` 保留但只读兼容，新代码不主动写。

### Legacy API compatibility

迁移期必须明确旧 API 的边界：

1. `/chat/send` 同时收到 `providerRoute` 与 `providerEnv` 时拒绝，避免双权威。
2. legacy `providerEnv: 'subscription'` 只作为旧 Desktop 兼容，映射为“本 turn 切 subscription env”；它不写新 snapshot。若要持久化 subscription route，必须通过 snapshot patch 写 `providerRoute:{kind:'subscription', providerId, model}`。
3. legacy `providerEnv` object 只转成内存 env 供旧调用继续工作，不自动写 `providerRoute`，除非它能通过 allow-list evidence 唯一映射到 providerId/model。
4. `/api/provider/set` 保持现有 Rust IM sync 语义和 external-runtime skip/compat 响应形状；不要把它变成 Desktop provider setter。
5. 只要请求或 live config 中存在 canonical provider identity，disabled/deleted/key missing 就必须 fail-closed，不得 fallback 到 legacy `payload.providerEnv`。

## 各入口行为

### Desktop Chat

1. Picker 内部继续使用 provider-scoped selection。
2. 发送 `/chat/send` 时传 `providerRoute`，不传 `ProviderEnv`。
3. session snapshot 写入 `providerRoute`，同时写 `providerId/model` mirror，清 `providerEnvJson`。
4. 如果 active owned builtin session 是 `unknown-legacy`，输入框允许用户选择 provider/model 修复；在修复前发送应返回可理解错误，不自动换 provider。
5. provider history boundary 使用 route resolution 结果；unknown legacy 不能被当作 Anthropic signed history。

### Floating Ball

1. 创建 session 时服务端 snapshot 必须写 `providerRoute`。
2. 恢复历史时 `applySessionSnapshot` 读取 `providerRoute/providerId/model`，能力判断以 route mirror 为准。
3. 发 `/chat/send` 不需要带 provider route；sidecar 应已从 owned metadata restore 到正确 provider env。
4. 如果悬浮球打开了 unknown legacy session，伴侣窗应展示 provider 缺失状态，并阻止发送，提示到完整 Chat 里选择 provider 或提供轻量修复入口。

### IM Agent Channel

1. pure IM/agent-channel 不写 owned providerRoute snapshot；每次消息按 ChannelOverrides → legacy channel-root providerId → Agent providerId → defaultProviderId live 解析。
2. live 解析结果复用同一套 route identity helper 与 `admin-config` materializer。
3. 如果 IM session detach/open 到 Desktop 并被 freeze，freeze 后写 owned `providerRoute`。
4. legacy `payload.providerEnv` 只允许在“无 ChannelOverrides、无 legacy channel-root providerId、无 Agent providerId、无 defaultProviderId”的 pre-route bridge/bot 情况兜底。只要任何 canonical provider identity 存在，解析失败必须返回错误，不得回退 stale env。

### Task/Cron

1. 保持 Rust 持久层 `provider_id + model`，不引入密钥字段。
2. Cron dispatch payload 可继续传 `provider_id/model`；Node 入口立即归一成 `BuiltinRouteInput`。Task/Cron 使用 live intent，不携带 session `providerRoute` 的 owned snapshot，也不冻结 baseUrl/protocol。
3. legacy `provider_env` 继续只读兼容；一旦 task 被编辑或 provider route 可确定，保存时不再写回。
4. external runtime + providerId 的 Rust 校验继续保留。

### Background / Inbox / Heartbeat / Memory Update

这些入口通常应“保持当前 provider”，不能因为缺省 provider 信息而切 subscription。默认不携带 route/env，只使用 sidecar 从 canonical route 恢复出的 current provider。若 current route 是 `unknown-legacy/error`，这些内部 turn 返回 409/错误，不注入用户气泡；只有 Cron explicit override 这类调用方明确选择 provider 的路径才传 `providerRoute`。

### External runtime

1. Codex/Claude Code/Gemini session 不存在 MyAgents builtin provider route。
2. `runtimeConfig.model` 是 external runtime 的模型字段；不要混用 `providerRoute.model`。
3. 从 builtin 切到 external 时清 `providerRoute/providerId/providerEnvJson/enabledPluginIds`。
4. 从 external 切回 builtin 时必须重新选择或 live resolve builtin provider route，不能复用 external model。

## Legacy 兼容与迁移

迁移采用 lazy repair 优先，batch migration 可选。

### Read order

0. normalize runtime。external runtime 直接 `not-applicable`，lazy scrub builtin provider fields，`model` 只作为 runtime model 处理。
1. `providerRoute` canonical：验证 provider/model 后使用；验证失败 fail-closed。
2. `providerId + model`：provider 存在、启用、model 属于该 provider 时构造 route 并补写 canonical；不满足时不升级。
3. `providerEnvJson + model`：本期只做 `legacy-env` 只读兼容，不自动补 canonical route；一旦已有 canonical route，旧 env 不参与请求路由。
4. `model + configSnapshotAt`：只用 credential-configured candidate set 唯一匹配反推 provider。唯一匹配才补 canonical；多匹配或无匹配进入 `unknown-legacy`。
5. `configSnapshotAt` 存在但 provider 不可恢复：返回 `unknown-legacy`。
6. `configSnapshotAt` 不存在但 session 有 provider/model/env hints：作为 `legacy-unlocked-with-session-hints` 参与本次 effective config，不写 canonical。
7. 完全无 session hints：live fallback 到 Agent/Project/default。

### Lazy repair

以下时机可触发 metadata patch：

- `GET /sessions/:id` 读取到可确定 legacy route。
- sidecar 初始化 owned session 时可确定 legacy route。
- 用户在 UI 修复 unknown provider 后。

patch 内容：

- 写 `providerRoute`。
- 写 `providerId/model` mirror。
- 删除 `providerEnvJson`，除非临时兼容阶段决定保留旧字段；最终不应再写。
- 更新 `configSnapshotAt` 只在用户主动修改配置时更新；纯 repair 可以加 `providerRouteRepairedAt` 诊断字段，避免改变“用户何时配置”的语义。若不加新字段，则 repair 不更新 `configSnapshotAt`。

lazy repair 必须带 CAS/precondition，不只是“读到就写”：

- 写入时确认 `providerRoute` 仍缺失。
- observed 的 `runtime/providerId/model/providerEnvJson/configSnapshotAt` 未变化。
- CAS 失败则重新 resolve 或放弃 repair，不能覆盖用户刚刚手动切换的 provider。
- `providerRoute`、`providerRouteRepairedAt` 必须加入 SessionMetadata、SessionStore update、PATCH/materialize/fork/freeze 白名单。

### Unknown legacy UX

unknown legacy 不是错误崩溃，而是一个“模型选择未完成”的历史数据状态：

- Chat / Floating Ball 应让模型选择器处于待选择状态，而不是让用户看到“发送没反应”。
- 如果 credential-configured candidate set 有多个命中，模型选择器显示这些候选 provider/model。
- 如果 credential-configured candidate set 无命中，模型选择器显示当前 model 但 provider 未绑定，用户需要按正常模型选择流程选择一个已配置凭据的 provider/model，或先配置凭据。
- 用户选择后的写入等价于一次正常的用户选模型：写 canonical route、`providerId/model` mirror，并清旧 `providerEnvJson`。
- 用户选择 provider/model 不是“证明历史 transcript 属于该 provider”。如果 session 已有历史消息，默认必须设置 fresh SDK history boundary：保留可见 transcript，但下一次发送从新的 SDK conversation 开始，避免把未知来源 transcript reattach 到错误 provider。
- 只有用户明确选择“按此 provider 继续旧上下文”且后端记录确认时，才允许尝试 resume 旧 SDK history。
- 发送前仍 unknown 时，后端返回 409，错误码 `provider_route_unknown_legacy`。

## 实施计划

### Phase A：类型与纯 resolver

1. 新增 `src/shared/providerRoute.ts`。
2. 把 `resolveLegacyBuiltinSnapshotProviderId` 从 renderer-only helper 下沉或复用为 shared pure helper。
3. 单测覆盖：
   - external runtime step 0 -> not-applicable + scrub plan。
   - explicit provider wins。
   - providerId+model legacy with model-in-provider validation。
   - providerId+model mismatch -> error/unknown, no repair。
   - providerEnvJson route-less legacy fallback -> no repair, no key copy to ProviderRoute。
   - unsnapshotted legacy session hints -> effective only, no promote。
   - model-only unique match within credential-configured providers。
   - model-only ambiguous within credential-configured providers -> unknown。
   - model-only no credential-configured candidate -> unknown / model picker selection state。
   - provider disabled/deleted/key missing fail-closed。

### Phase B：server resolver 与 SessionEngine

1. 保持 `resolveWorkspaceConfig`、`resolveSessionConfig` 的 owner 结构不变，只在 provider 字段处调用 shared identity helper。
2. 在 `admin-config` 增加 materializer：`BuiltinProviderRoute -> ResolvedProviderEnv`，从同一个 live provider definition 原子读取 route fields + API key。
3. `resolveSessionConfig` 增加 route 字段或返回 route-aware provider identity，避免继续只返回 loose `providerId/providerEnvJson`。
4. `SessionEngineConfigSnapshot` 返回 `providerRoute/providerIdentityStatus`。
5. `DesktopMessageRequest` 增加 `providerRoute`；`InjectedTurnRequest` 仅供 explicit Cron/provider override 使用。
6. builtin adapter 将 route 解析成现有 `enqueueUserMessage` 参数；external adapter 拒绝 route。

### Phase C：持久化写路径

1. `SessionMetadata` 加 `providerRoute`。
2. `buildOwnedFreezeSnapshotPatch` 写 `providerRoute`，不再写 `providerEnvJson`。
3. `buildSessionSnapshotPatchUpdates` 支持 `providerRoute`，并在 providerRoute 改变时清旧 `providerEnvJson`。
4. `persistInputOptionChange` 的 `builtinSelection` 输出 `providerRoute`。
5. `PATCH /sessions/:id` 接收 `providerRoute`，响应仍 redacts `providerEnvJson`。
6. 同步所有 provider snapshot 写入点 inventory，任何一个漏掉都会继续产生旧数据：
   - `src/server/utils/session-snapshot.ts::snapshotForOwnedSession`
   - `src/server/agent-session.ts::buildOwnedFreezeSnapshotPatch`
   - `freezeCurrentSessionMetadataForImDetach`
   - fork metadata inheritance
   - pending session materialize patch
   - `POST /sessions`
   - `/api/session/freeze`
   - `/api/session/freeze-current`
   - `src-tauri/src/im/runtime_change.rs::OwnedSessionSnapshot/to_json/build_snapshot_from_*`
7. TS/Rust mirror 必须同步：写 `providerRoute + providerId/model mirror`、不写新 `providerEnvJson`、external runtime scrub `providerRoute/providerId/providerEnvJson/enabledPluginIds`。

### Phase D：renderer 消费

1. Chat 从 `providerRoute/providerIdentityStatus` seed 当前 provider/model。
2. Chat send 改传 `providerRoute`，删除新路径 `buildProviderEnv` 依赖；`buildProviderEnv` 只保留 legacy 或最终移除。
3. Launcher 创建新 session 时传/写 route intent。
4. Floating Ball history/apply snapshot 读取 route；unknown legacy 展示阻断状态。
5. provider history dialog 用 route resolver 结果，unknown 不假设 Anthropic。

### Phase E：IM/Task/Cron/headless 统一

1. IM channel live resolve 输出 route，而不是 env blob。
2. Cron dispatch provider_id/model 进入 Node 后归一成 route。
3. legacy provider_env fallback 加使用计数日志，并按“无 canonical identity 才 fallback”的边界收窄。
4. Background/Heartbeat/Memory update 确认继续保持当前 provider，不触发 subscription sentinel。

### Phase F：清理与文档

1. 更新 `specs/tech_docs/session_architecture.md` 的 session snapshot 字段说明。
2. 更新 `specs/tech_docs/third_party_providers.md`，把 `providerEnvJson` 降级为 legacy read-only。
3. 更新 `specs/tech_docs/task_provider_routing.md`，说明 session route 与 task route 共享 mental model。
4. 增加 lint 或 unit contract，防止新 renderer send path 继续发送 credential-bearing `providerEnv`。

## 验收标准

1. 新建 Desktop builtin session，metadata 有 `providerRoute + providerId/model mirror`，无新写入 `providerEnvJson`。
2. 恢复旧 `providerId + model` session 时，只有 model 属于 provider 才自动补 canonical route；错配数据不被固化。
3. 恢复旧 `model-only` 且模型在已配置凭据的 provider 中唯一命中的 owned session，能自动补 canonical route，悬浮球发送也走正确 live-resolved baseUrl。
4. 恢复旧 `model-only` 且模型在已配置凭据的 provider 中多命中或无命中的 owned session，Chat/FB 的模型选择器进入待选择状态，发送前返回明确 409，不静默 misroute。
5. 旧 `providerEnvJson` 带密钥的 session 不再把密钥作为新 snapshot 写回；没有 canonical route 时它只作为 read-only fallback，用户重选 provider/model 后写 canonical route 并清旧 env。
6. OpenAI protocol provider 仍然通过 bridge 正确注册和请求。
7. Task/Cron provider override 仍然只持久化 providerId/model，执行时 live-resolve。
8. pure IM channel 修改 Agent/Channel provider 后，新消息 live-follow；owned detached session 不跟随。
9. external runtime session 不接受 builtin providerRoute，且 runtime model 不被 builtin model 覆盖。
10. Usage 统计仍按 providerId/model 归因。
11. provider disabled/deleted/API key missing 时，只要 canonical identity 存在，IM/Cron/Chat 都不 fallback legacy env。
12. lazy repair CAS 失败不会覆盖用户手动 provider 切换。

## 测试矩阵

### Unit

- `providerRoute` shared resolver：所有 legacy/read-order 分支。
- `admin-config.resolveWorkspaceConfig`：owned/pure IM/unlocked/external。
- `session-snapshot-patch`：providerRoute 写入、mirror 写入、providerEnvJson 清理。
- `SessionEngine` route contracts：builtin accepts route, external rejects route。
- `providerEnvJson` allow-list：旧 blob 含 `apiKey`，repair 后无密钥落盘/响应。
- lazy repair CAS：读后用户切 provider，repair 不覆盖。

### Integration

- Desktop Chat 发送 provider route，不发送 provider env；服务端 resolve 后 SDK env 正确。
- provider/model 切换跨 history boundary 时仍新建 SDK session。
- Floating Ball 从旧 owned session 恢复后不需要 renderer providerEnv 也能发送到正确 provider。
- IM pure live-follow channel provider override 生效。
- Cron task providerId/model 执行时可解析 provider env；provider 删除/禁用时报明确错误。
- Rust IM runtime-change freeze 产出的 owned snapshot 与 TS snapshot 字段一致。
- external runtime 历史 session 带残留 providerId/providerEnvJson 时被 scrub，不进入 provider route。

### Regression

- 旧 `providerEnvJson` redaction 仍然有效。
- `providerEnv === undefined` 内部语义仍表示 keep-current，不误切 subscription。
- `providerEnv === 'subscription'` legacy desktop 语义在兼容 endpoint 中仍工作。
- provider disabled/missing key 不 fallback 到 first available。
- external runtime `runtimeConfig.model` 不被 `providerRoute.model` 污染。
- `legacy-unlocked-with-session-hints` 旧会话不会因缺 `configSnapshotAt` 被突然切到 Agent/default provider。

## 风险与约束

1. 本 PRD 明确不冻结 baseUrl/protocol/auth/modelAliases。provider route 是 providerId+model identity；provider definition 与 API key 从当前 config 原子读取，避免旧 endpoint 搭配新 key 的 credential 泄漏。
2. Lazy repair 需要文件锁/SessionStore 写入纪律和 CAS precondition，不能在多个入口并发时互相覆盖。实现时必须沿用现有 SessionStore 更新路径，不裸写 sessions.json。
3. 不能把 unknown legacy 当普通错误吞掉；它是产品态，必须有错误码和 UI 恢复动作。
4. 迁移期旧字段 mirror 会让 schema 看起来重复，但这是兼容成本；新权威必须始终是 `providerRoute`。
5. 若 provider registry 本身没有足够信息匹配旧 `providerEnvJson`，只能 `legacy-env` 只读兼容或 unknown，不要猜。

## 后续可选增强

1. 增加只读诊断 CLI：扫描 sessions.json，输出 provider route 状态分布和 unknown legacy 候选。
2. 在设置页 provider 删除/禁用前，提示会影响多少 owned sessions/tasks。
3. 给 unknown legacy 修复操作增加批量“同 model 都选这个 provider”的确认流。
