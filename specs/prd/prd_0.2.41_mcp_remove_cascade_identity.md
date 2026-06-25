---
type: prd
status: draft
created: 2026-06-26
updated: 2026-06-26
scope: "Define MCP remove as deletion of a custom MCP identity across AppConfig, Projects, Sessions, Task/Cron, legacy Agent/Bot MCP payloads, and UI caches; disable remains the reversible gate operation."
issue: "Architecture follow-up to 08cb9c93 / #405: removing custom MCP must not leave dangling references or resurrection sources"
research: "specs/ARCHITECTURE.md; specs/tech_docs/session_architecture.md; specs/tech_docs/task_center.md; specs/tech_docs/im_integration_architecture.md; specs/tech_docs/cli_architecture.md; src/shared/mcpConfig.ts; src/server/admin-api.ts; src/server/utils/admin-config.ts; src/renderer/config/services/mcpService.ts; src/renderer/config/services/agentConfigService.ts; src-tauri/src/im/config_store.rs; src-tauri/src/task.rs; src-tauri/src/sidecar/cron_execute.rs"
review: "completed(single sub-agent architecture review: approve with changes; Task/Cron three-state override, legacy IM Bot cleanup, and locked Projects/Sessions mutations folded into this PRD)"
---

# MCP Remove Cascade Identity

## 执行须知（给空 session 的你）

这份 PRD 要把 `myagents mcp remove` / Settings 删除自定义 MCP 的语义定死。你不要把它理解成“再补一个清理数组的 patch”，而是要收敛 MCP 配置的身份模型：

1. MCP definition 的权威来源只有 preset MCP + `config.mcpServers`。
2. `config.mcpEnabledServers` 是全局安全 gate。
3. Agent / Project / Session / Task / Cron / legacy IM Bot 里的 `mcpEnabledServers` 都只是 selection refs，只能存 id。
4. `agents[].mcpServersJson` 和 legacy `imBotConfigs[].mcpServersJson` 是 runtime payload / 派生缓存，不是权威 definition store。
5. `disable` 是可逆地关 gate；`remove` 是删除 custom MCP identity，必须 cascade 清理所有 selection refs 和 legacy payload，防止“删了又回来”或“重新加同 id 后旧对象自动启用”。

实现前必须主动读 `specs/ARCHITECTURE.md` 的 MCP 配置权威来源分离、`specs/tech_docs/session_architecture.md` 的 snapshot config 语义、`specs/tech_docs/task_center.md` 的 Task/Cron 数据归属、`specs/tech_docs/im_integration_architecture.md` 的 Agent Channel/Rust config reader、`specs/tech_docs/cli_architecture.md` 的 Admin API/CLI 入口。

本期不是做 UI 改版；本期是把 remove 的所有写路径收敛到一个确定的删除编排。UI/CLI 只触发这个编排，不再各自拼文件修改逻辑。

## 背景

`08cb9c93 fix(mcp): remove legacy agent MCP references` 修掉了一个真实问题：某些 HTTP/SSE MCP definition 只残留在 `agents[].mcpServersJson` 里，用户从 UI/CLI remove 后，全局 `config.mcpServers` 被删了，但 Agent legacy payload 还留着 definition。下一次读取 config 时，load-boundary promotion 又把它提升回全局 catalogue，看起来就是“删了又回来”。

这个 commit 的方向是对的：它把 TypeScript promotion/removal 逻辑抽到 `src/shared/mcpConfig.ts`，并让 Settings 和 Admin API 删除路径都清 `agents[].mcpServersJson`。但如果用“正确架构终局”来衡量，它还只解决了最危险的 resurrection source，没有把 `remove` 的产品语义完整落到所有持久引用上。

用户这次明确要的不是“最小修补”，而是确定性方案：所有边界清楚、架构正确、没有技术债，也没有为了显得安全而堆 tombstone / scanner / retry wrapper。

## 当前技术事实

### MCP catalogue 与 runtime materialization

当前 MCP 有几类持久数据：

| 数据 | 位置 | 语义 |
| --- | --- | --- |
| preset MCP definitions | `PRESET_MCP_SERVERS` | 内置 definition，不允许 remove |
| custom MCP definitions | `config.mcpServers` | 用户自定义 definition |
| global gate | `config.mcpEnabledServers` | 全局启用开关 |
| env/args overrides | `config.mcpServerEnv` / `config.mcpServerArgs` | definition 的附加运行参数 |
| Agent selection | `agents[].mcpEnabledServers` | Agent 选择的 MCP id 子集 |
| Agent legacy payload | `agents[].mcpServersJson` | 运行时 payload / 旧版本遗留 definition 容器 |
| Legacy IM Bot selection | `imBotConfig.mcpEnabledServers` / `imBotConfigs[].mcpEnabledServers` | 旧 IM Bot 选择的 MCP id 子集 |
| Legacy IM Bot payload | `imBotConfig.mcpServersJson` / `imBotConfigs[].mcpServersJson` | 旧 IM Bot runtime payload / definition 容器 |
| Project selection | `projects.json[].mcpEnabledServers` | Workspace/Project 选择的 MCP id 子集 |
| Session snapshot selection | `sessions.json[].mcpEnabledServers` | owned session 捕获的 MCP id 子集 |
| Task/Cron override | `Task.mcp_enabled_servers` / `CronTaskConfig.mcp_enabled_servers` | per-task/per-cron MCP id override |

运行时真正给 SDK 的 MCP 列表应该由以下交集 materialize：

```text
MCP definitions (preset + config.mcpServers)
  ∩ global gate (config.mcpEnabledServers)
  ∩ selection refs (agent/project/session/task/cron)
```

这和 `ARCHITECTURE.md` 的权威来源分离一致：

- Desktop Tab 的 MCP 由前端 `/api/mcp/set` 推给 session sidecar。
- IM/Cron/Headless 由 Sidecar self-resolve 从磁盘读取。
- 混用不同来源会造成 MCP fingerprint 漂移和 session 重启循环。

### Load-boundary legacy promotion

三条读取路径都需要理解历史 `agents[].mcpServersJson`：

- Renderer `loadAppConfig()` 调 `normalizeStringifiedJsonFields()` + `promoteAgentMcpJsonToGlobal()`。
- Node Admin `loadConfig()` 在 `src/server/utils/admin-config.ts` 里也已调用 `promoteAgentMcpJsonToGlobal()`。
- Rust IM reader 有 twin：`src-tauri/src/im/config_store.rs::promote_agent_mcp_json_to_global_value`。

这说明 `mcpServersJson` 仍是兼容输入，但不应该继续作为长期权威定义源。

### 当前 remove 覆盖范围

`08cb9c93` 后，`removeMcpServerEverywhere(config, id)` 清理：

- `config.mcpServers`
- `config.mcpEnabledServers`
- `config.mcpServerEnv`
- `config.mcpServerArgs`
- `agents[].mcpEnabledServers`
- `agents[].mcpServersJson`

还没有覆盖：

- `imBotConfig.mcpEnabledServers` / `imBotConfigs[].mcpEnabledServers`
- `imBotConfig.mcpServersJson` / `imBotConfigs[].mcpServersJson`
- `projects.json[].mcpEnabledServers`
- `sessions.json[].mcpEnabledServers`
- `Task.mcp_enabled_servers`
- `CronTaskConfig.mcp_enabled_servers`
- `config.launcherLastUsed?.mcpEnabledServers` 这类 UI cache

这些 dangling refs 不会单独复活 definition，因为它们没有完整 server definition；但它们会带来另一个产品问题：用户 remove 了一个 MCP identity 后，未来重新添加同 id，旧 Project/Task/Session 可能自动重新启用它。这不是用户对“删除”的直觉。

## 产品目标

1. `remove` 表示删除一个 custom MCP identity，而不是只删当前全局 definition。
2. 删除后，同 id 不再出现在任何 selection refs / runtime payload / UI cache 中。
3. 删除后重新添加同 id，不会被旧 Agent/Project/Session/Task/Cron/legacy Bot 自动启用。
4. `disable` 保持可逆：只关目标 scope 的 gate，不清 selection refs。
5. UI Settings 和 CLI/Admin API 走同一个删除编排，不再有两套写盘逻辑。
6. 不引入 tombstone、后台扫盘、长期“修复任务”或复杂事务日志；所有清理在用户触发 remove 的同步路径内完成，幂等可重试。

## 非目标

1. 不删除 builtin MCP。Builtin 仍只能 disable，不能 remove。
2. 不重写 MCP selection UI。
3. 不迁移 transcript 消息正文；只改 session metadata 的 MCP id 列表。
4. 不改变 SDK MCP server schema 或 Claude Agent SDK 接入方式。
5. 不在本期删除 `agents[].mcpServersJson` 字段；只把它降级为 legacy/derived payload，并在 remove 时清理其中对应 entry。
6. 不新增 tombstone 表来记“曾经删除过的 id”。删除后的同 id 是一个新 custom MCP，旧引用已经被 cascade 清掉。

## 终局语义

### `disable(serverId, scope)`

`disable` 是 gate 操作：

- `scope=global`：从 `config.mcpEnabledServers` 移除。
- `scope=project`：从当前 project 的 `mcpEnabledServers` 移除。
- `scope=both`：两者都做。
- 不删 `config.mcpServers` definition。
- 不清 Agent/Session/Task/Cron selection refs。
- 不清 `mcpServerEnv` / `mcpServerArgs`。

Rationale：disable 是“暂时不要用”，用户之后 re-enable 应恢复已有选择。

### `remove(serverId)`

`remove` 是 custom MCP identity 删除：

- 只允许 custom MCP；preset/builtin MCP 返回错误。
- preset/builtin 判定必须基于 `PRESET_MCP_SERVERS` id set，而不是 effective merged catalogue，避免 custom 覆盖 preset id 时语义含糊。
- 可以清 dangling custom id：如果 id 不在 current custom definitions 中，但不属于 preset，也允许作为 cleanup-only remove，用于恢复部分失败或手工损坏的数据。
- 必须 cascade 到所有持久 refs。
- 必须清掉 legacy Agent payload 中的 matching definition。
- 最后刷新运行中的 MCP state 并广播 config change。

Rationale：remove 后用户重新添加同 id，应当像添加一个新 MCP，不应继承旧项目、任务或会话选择。

## 数据模型不变量

### N1 Definition identity

MCP definition 的身份是 `server.id`。对 custom MCP，`config.mcpServers[]` 是定义权威；对 builtin MCP，`PRESET_MCP_SERVERS` 是定义权威。

### N2 Global gate

`config.mcpEnabledServers` 是安全 gate。任何 runtime materialization 都必须检查它。`sessionMeta.mcpEnabledServers`、`task.mcp_enabled_servers`、`agent.mcpEnabledServers` 不能绕过 global disabled。

### N3 Selection refs

以下字段只允许保存 id，不允许保存 definition：

- `agents[].mcpEnabledServers`
- `imBotConfig.mcpEnabledServers`
- `imBotConfigs[].mcpEnabledServers`
- `projects.json[].mcpEnabledServers`
- `sessions.json[].mcpEnabledServers`
- `Task.mcp_enabled_servers`
- `CronTaskConfig.mcp_enabled_servers`

### N4 Legacy payload

`agents[].mcpServersJson` 与 legacy IM Bot 的 `mcpServersJson` 只作为 legacy compatibility / runtime payload：

- 读取时可用于 promotion，修复旧数据。
- 保存 Agent MCP selection 时应从 canonical registry 派生。
- remove 时必须删除 matching entry。
- 后续 phase 可考虑从持久 schema 中删除，但本期不做。

### N5 Task/Cron MCP override 必须升级为三态

当前 Rust Task/Cron 是 two-state：`None` 表示 follow workspace/agent，`Some(nonEmpty)` 表示 override，`Some([])` 在 storage boundary 被折叠成 `None`。这个语义不够支撑 identity deletion：如果一个 task 原本只 override 了即将删除的 MCP，remove 后折叠成 `None` 会让它开始继承 workspace/agent 的其它 MCP，这不是用户删除该 identity 的直觉。

本期必须把 Task/Cron MCP override 升级为三态：

| 持久值 | 语义 |
| --- | --- |
| `None` / field absent | follow workspace/agent |
| `Some([])` | explicit no MCP |
| `Some([id...])` | explicit MCP override |

这不是额外防御，而是 remove cascade 的必要数据语义。实现必须同步更新 Rust storage normalization、update API、Task → Cron projection、执行 materialization、UI/CLI 编辑路径与测试。

## 技术方案

### 1. 重命名并拆分 shared helper

保留 `src/shared/mcpConfig.ts`，但把职责命名改准：

```ts
export function promoteAgentMcpJsonToGlobal<T extends McpConfigContainer>(config: T): boolean;
export function pruneMcpServerReferencesFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T;
export function removeMcpServerDefinitionFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T;
export function removeMcpServerFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T;
```

`removeMcpServerEverywhere` 这个名字不保留，因为它只处理 AppConfig，不是真的 everywhere。命名不准会误导后续实现者以为 project/session/task/cron 已覆盖。

`removeMcpServerFromAppConfig` 负责：

- global custom definition
- global enabled gate
- env/args overrides
- agent selection refs
- agent legacy payload
- legacy `imBotConfig` / `imBotConfigs[]` selection refs
- legacy `imBotConfig` / `imBotConfigs[]` runtime payload
- `launcherLastUsed.mcpEnabledServers` 等 UI cache 中的 MCP id 列表

### 2. 新增唯一删除编排入口

新增 Node 侧 service：

```text
src/server/services/mcp-removal.ts
```

导出：

```ts
removeCustomMcpServerCascade(serverId: string): Promise<McpRemovalResult>
```

`Admin API handleMcpRemove()` 和 renderer Settings 删除路径都调用它。Settings 不再直接调用 renderer `deleteCustomMcpServer()` 写 config；Settings 应通过 Global Sidecar/Admin API 删除，然后 `refreshConfig()`。

选择 Node Admin API 做 coordinator 的原因：

- CLI 已经以 Admin API 为业务逻辑 owner。
- Node 已经能读写 `config.json`、`projects.json`、`sessions.json`；其中 `config.json` 必须继续走 `withConfigLock`，`projects.json` 和 `sessions.json` 必须走锁内 mutation helper，不能裸 read-modify-write。
- Node 可通过 Management API 调 Rust-owned Task/Cron store。
- UI 不应自己跨 AppConfig / Projects / Sessions / Task / Cron 拼 deletion。

### 3. 删除顺序

删除顺序固定：

1. 读取 config，验证 id：
   - id 在 `PRESET_MCP_SERVERS`：拒绝 remove，提示 use disable。
   - custom id 存在：继续。
   - custom definition 不存在但不是 preset：允许 cleanup-only，用于清 dangling refs。
2. 锁内清 `projects.json[].mcpEnabledServers`。
3. 锁内清 `sessions.json[].mcpEnabledServers`。
4. 调 Rust Management API 清 Task/Cron store 中的 `mcp_enabled_servers`。
5. 原子修改 `config.json`，调用 `removeMcpServerFromAppConfig(config, id)`。
6. 调现有 `notifyMcpChange('remove', id)`，刷新当前 Sidecar MCP state 并广播 `config:changed`。

为什么 config 最后写：如果 Task/Cron cleanup 失败，definition 还在，用户可以重试 remove；不会出现“命令说失败但 target 已经彻底消失”的恢复困难。若最后 config 写失败，前面的引用清理是收敛性的，重试仍可完成。

本方案不提供跨 `config.json` / `projects.json` / `sessions.json` / TaskStore / CronTaskManager 的全局 serializable transaction。它提供的是同步、幂等、可重试的 cascade：失败或并发编辑造成残留时，cleanup-only remove 可再次清理 dangling custom id。这个边界要写进实现和测试，不要用 tombstone 或后台 scanner 去模拟全局事务。

### 4. Projects cleanup

不要裸调用 `loadProjects()` / `saveProjects()` 做 read-modify-write。新增或复用 server-side `atomicModifyProjects(...)`，底层使用 `withFileLock` 锁 `projects.json.lock`，并保持 tmp+rename 写盘。Settings 删除路径走 Admin API，不再由 renderer 直接改 projects。

规则：

- 遍历所有 project。
- 如果 `mcpEnabledServers` 包含 target id，则移除。
- Project 没有明确“继承 workspace/agent”的上层语义；删除后保留空数组，减少语义漂移。

### 5. Sessions cleanup

复用 `SessionStore` 的 metadata 更新能力，新增锁内 bulk helper，不允许手写 `sessions.json`：

```ts
removeMcpServerFromSessionSnapshots(serverId: string): Promise<number>
```

规则：

- 只改 metadata，不读写 JSONL messages。
- 只处理 `mcpEnabledServers` 数组。
- 若数组包含 target id，则过滤。
- 对 owned session，空数组必须保留 `[]`，因为 `undefined` 在 snapshot 语义里可能表示缺字段/旧兼容；`[]` 表示“这个 snapshot 明确没有 MCP”。
- 不碰 transcript 内容。

### 6. Legacy IM Bot cleanup

legacy `imBotConfig` / `imBotConfigs[]` 已迁移到 Agent 架构，但字段仍在 `AppConfig` 中用于迁移检测和 Rust shim。它们也可能持久化：

- `mcpEnabledServers`
- `mcpServersJson`

`removeMcpServerFromAppConfig()` 必须清这些字段里的 target id 和 matching payload entry。否则同 id 重新添加后，legacy Bot 可能继承旧选择或旧 runtime payload。

### 7. Task/Cron cleanup

Task/Cron store 在 Rust。新增一个 Management API endpoint，供 Node Admin API 调用：

```text
POST /api/mcp/remove-references
{ "serverId": "..." }
```

Rust 侧 owner：

- Task：`src-tauri/src/task.rs`
- Cron：`src-tauri/src/cron_task/*`

行为：

- 遍历 TaskStore，过滤 `Task.mcp_enabled_servers`。
- 遍历 CronTaskManager store，过滤 `CronTaskConfig.mcp_enabled_servers` / `ProviderIntent` 以外的 MCP override 字段。
- 返回 `{ taskUpdated, cronUpdated }`。

本期必须同步升级三态 override：

- Task/Cron 的 `None` 表示 follow workspace/agent。
- `Some(vec![])` 表示显式无 MCP。
- 因此如果原来是 `Some(["removed-id"])`，删除后必须写 `Some([])`，不能写回 `None`。

这是防止 remove 反而让任务从 workspace 继承其它 MCP 的关键。

要改的 owner 包括：

- `src-tauri/src/task.rs::normalize_mcp_override`
- Task create/update/legacy upgrade
- Task → CronTask projection
- `src-tauri/src/cron_task/manager.rs` patch/update normalization
- Cron execute materialization
- renderer Task editor / dispatch dialog 对 `undefined` vs `[]` 的展示和提交
- CLI/Admin task/cron payload parsing

如果实现者认为三态升级超出当前排期，必须先回到用户确认；不能把 `Some([])` 偷偷折叠成 `None`。

### 8. Running state refresh

完成持久清理后：

- 调 `notifyMcpChange('remove', id)`。
- 继续复用现有 `setMcpServers(effectiveServers)` 和 `broadcast('config:changed', { section:'mcp', action:'remove', id })`。
- 不新增后台 watcher 或 polling。

对 active Desktop Tab：

- Settings 删除后，前端收到 config changed / refresh config。
- Chat 现有 MCP sync effect 会把新的 global/project/session intersection 推给 sidecar。

对 IM/Cron：

- 后续 tick / wake / sidecar self-resolve 从磁盘读取新状态。
- 如果已有 live sidecar 正在执行，删除后的立即中断策略沿用现有 MCP config change 机制，不额外发明 kill path。

## 关键设计决策

### D1 `remove` 和 `disable` 必须分开

`disable` 是 reversible gate；`remove` 是 identity deletion。把两者混在一起会导致两个坏结果：

- remove 只删 global definition，旧 selection refs 留着，未来同 id 复用时自动启用。
- disable 过度清 refs，用户 re-enable 时丢掉原选择。

### D2 删除编排归 Node Admin API service

Renderer 不应跨多个 store 自己写；Rust 也不是 config/session 的唯一 owner。Node Admin API 已是 CLI 业务 owner，并能桥接 Rust Management API，因此它是最小新增概念的 coordinator。

### D3 不引入 tombstone

不保存 `removedMcpIds`。删除后同 id 重新添加是一个新 identity，旧 refs 已经清理，不需要 tombstone 阻止。Tombstone 会带来过期策略、UI 展示、导入导出等额外复杂度，收益低。

### D4 不做后台扫盘器

所有 cleanup 在 remove 的同步路径内完成。后台 scanner 会模糊 owner，增加不可预测写盘，并可能和用户编辑 config 竞争。

### D5 空数组不能随便删

Task/Cron/Session snapshot 中 `undefined` 和 `[]` 有不同语义。本期必须把 Task/Cron 升级为三态；删除 id 后若数组变空，保留 `[]`，不能折叠成继承。Project 也保留空数组，避免删除操作额外改变用户选择。

### D6 `mcpServersJson` 只降级，不本期删除字段

直接删除字段会影响 Rust Agent Channel 和旧 config reader。正确做法是先让所有写路径从 canonical registry 派生 runtime payload，并在 remove 时清 payload entry。彻底废弃 `mcpServersJson` 留到后续 phase。

## 反向边界

本期不做：

- 不新增 `removedMcpIds` tombstone。
- 不新增全局 config repair daemon。
- 不把 Task/Cron store 迁到 Node。
- 不把 Projects/Sessions store 迁到 Rust。
- 不引入跨所有 store 的全局事务日志。
- 不改 MCP UI 组件布局。
- 不清历史消息正文中提到的 MCP 名称。
- 不删除 builtin MCP。

## 验收标准

### A1 删除 custom HTTP MCP 后不会复活

准备：

- `config.mcpServers` 有 `yuandian-law`。
- `agents[].mcpServersJson` 里也有 `yuandian-law` definition。
- `agents[].mcpEnabledServers` 包含 `yuandian-law`。

执行：

```bash
myagents mcp remove yuandian-law
myagents mcp list
```

期望：

- list 不再出现 `yuandian-law`。
- 重启应用后仍不出现。
- `config.json` 的 `agents[].mcpServersJson` 不含该 id。

### A2 删除 cascade 覆盖所有 refs

删除后扫描：

- `config.json` 不含 target id 的 custom definition / global enabled / env / args / agent refs / Agent legacy payload / legacy IM Bot refs / legacy IM Bot payload / launcher cache。
- `projects.json` 不含 target id。
- `sessions.json` metadata 不含 target id。
- Task store 不含 target id。
- Cron store 不含 target id。

### A3 重新添加同 id 不自动启用旧对象

删除 `foo` 后重新添加 `foo`：

- Global enabled 仍按 add 流程默认状态。
- 旧 Agent/Project/Session/Task/Cron/legacy Bot 不自动包含 `foo`。
- 用户必须显式 enable/select。

### A4 disable 仍可逆

对同一个 MCP 执行：

```bash
myagents mcp disable foo --scope global
myagents mcp enable foo --scope global
```

期望：

- Agent/Project/Task/Session refs 不被清。
- enable 后原 selection 仍可 materialize。

### A5 Task/Cron 空 override 不变成继承

Task/Cron 原来 `mcpEnabledServers = ['foo']`，删除 `foo` 后：

- 保存为 `[]` / `Some([])`。
- 不变成 `undefined` / `None`。
- 后续执行不从 workspace/agent 继承 MCP。

同时，手动在 Task/Cron 编辑器里把 MCP override 清空时，也必须能表达 explicit no MCP，而不是总是清除 override 回到 follow workspace。

### A6 Settings 和 CLI 同路

从 Settings 删除和从 CLI 删除同一个 MCP，最终落盘结果一致。不得出现 renderer-only 或 CLI-only 清理差异。

## 测试计划

### Unit

- `src/shared/mcpConfig.test.ts`
  - AppConfig removal 清 global/agent/legacy Bot/legacy payload/cache。
  - promotion 仍只提升 selected HTTP/SSE custom definitions。
  - remove 不依赖 promotable shape，任何 matching id entry 都清。
- `src/server/services/mcp-removal.unit.test.ts`
  - cascade 调用顺序。
  - builtin remove 拒绝。
  - missing custom cleanup-only。
  - partial failure 不删除 config definition before Rust cleanup。

### Server/Admin

- `src/server/admin-api.unit.test.ts`
  - `handleMcpRemove` 走 cascade service。
  - Agent-only legacy HTTP MCP 仍可被 remove。
  - projects/sessions cleanup 被调用。

### Rust

- TaskStore cleanup unit。
- CronTaskManager cleanup unit。
- Task/Cron 三态 override normalization unit：`None` / `Some([])` / `Some(nonEmpty)` 必须区分。
- Management API `/api/mcp/remove-references` request/response test。

### Integration

- 构造 config + projects + sessions + task + cron + legacy imBotConfigs fixtures，执行 Admin API remove，断言所有 refs 消失。
- 重启式读取：remove 后调用 renderer/admin/Rust config readers，确认不会 promote 回来。

## 已定边界

Rust Management API 使用新增单 endpoint：

```text
POST /api/mcp/remove-references
```

不复用 task/cron existing update endpoints。理由是这次 remove 是一个产品级 identity cleanup，owner 是 Rust 侧 Task/Cron store；Node coordinator 只发一次语义化 cleanup 请求，不在 Node 里循环拼多个低级 update。这样 owner 边界清楚，也避免把 Task/Cron storage 细节泄漏到 Admin API service。

## 关联文件

- `src/shared/mcpConfig.ts`
- `src/renderer/config/services/configNormalize.ts`
- `src/renderer/config/services/mcpService.ts`
- `src/renderer/config/services/agentConfigService.ts`
- `src/server/admin-api.ts`
- `src/server/utils/admin-config.ts`
- `src/server/SessionStore.ts`
- `src-tauri/src/im/config_store.rs`
- `src-tauri/src/task.rs`
- `src-tauri/src/cron_task/*`
- `src-tauri/src/management_api.rs`
- `src-tauri/src/sidecar/cron_execute.rs`
