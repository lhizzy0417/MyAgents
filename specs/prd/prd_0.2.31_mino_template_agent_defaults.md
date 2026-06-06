# PRD 0.2.31 — Mino 模板默认主动 Agent 能力

status: implemented
created: 2026-06-06
implemented: 2026-06-06
owner: MyAgents

## 1. 背景

Mino 是用户进入 MyAgents 后的默认工作区，也是「从模板创建 Agent」里的核心内置模板。当前实现里：

- Mino 文件内容来自独立的模板仓库，并被打包到 Tauri resources。
- MyAgents 启动时复制/注册 Mino 工作区，并给每个 Project 自动补一个 basic `AgentConfig`。
- 自动补出来的 basic Agent 默认 `enabled: false`，所以 Mino 的「主动 Agent 模式」默认关闭。

这会让新用户第一次打开默认 Mino 时，看到的是一个普通工作区，而不是一个已经进入 Agent 产品语义的工作区。用户需要手动打开「主动 Agent 模式」后，才会看到 Channels、Heartbeat、Memory Update 等能力。

## 2. 目标

让内置 Mino 模板天然表达「这是一个 Agent 产品默认工作区」：

1. 首次启动自动创建的 Mino 默认工作区，默认开启「主动 Agent 模式」。
2. 用户从模板库选择 Mino 创建的新工作区，也默认开启「主动 Agent 模式」。
3. Mino 默认开启 Heartbeat 与 Memory Update 的配置，但不自动创建任何 IM channel。
4. 普通工作区、用户自定义模板、已有用户配置不被惊扰。
5. 配置来源必须架构清晰：Mino 文件内容仍由外部模板仓库负责；MyAgents 只负责产品级 Agent 默认策略。

## 3. 非目标

- 不把所有 project 的 basic Agent 都默认开启。
- 不自动创建 `feishu_mino` 或任何 channel；IM 凭据、登录、授权必须是用户显式行为。
- 不让无 channel 的 Agent 自动产生后台 AI 请求。Rust 运行时仍然只在存在可启动 channel 时运行 Agent heartbeat。
- 不把 Agent 默认配置写进 Mino 文件模板仓库，也不依赖 `HEARTBEAT.md` / `UPDATE_MEMORY.md` 里的隐藏 manifest。
- 不 retroactively 修改用户已经存在、并且曾经关闭过的 Mino Agent。
- 不改变「应用模板到当前工作区」的语义；该流程只合并文件，不改 Agent 运行策略。

## 4. 当前 Ground Truth

### 4.1 Mino 初始化

- `cmd_initialize_bundled_workspace` 只复制 resources/mino 到本地项目目录。
- `ensureBundledWorkspace()` 注册 project，设置 icon/displayName/defaultWorkspacePath。
- `ensureAllProjectsHaveAgent()` 会给未关联 Agent 的 project 补 basic Agent，但 `enabled: false`。

### 4.2 模板创建

- `TemplateLibraryDialog` 调 Rust 命令复制模板文件。
- `Launcher.handleCreateFromTemplate()` 之后调用 `addProject(path)`，再 patch icon/displayName。
- `ConfigProvider.addProject()` 在 project 没有 `agentId` 时自动创建 basic Agent，当前同样 `enabled: false`。

### 4.3 运行时启动

- Rust `schedule_agent_auto_start()` 只遍历 `agent.enabled === true` 的 Agent。
- 每个 channel 还必须 `channel.enabled === true` 且有启动凭据。
- Agent 级 heartbeat 只有在至少一个 channel 成功启动后才会创建 runner。

因此，把 Mino Agent 默认 enabled 不会单独触发后台 AI 成本；它只让 UI 与持久配置进入主动 Agent 状态。

## 5. 设计

### 5.1 模板文件内容与产品策略分离

Mino 文件模板在另一个仓库，这是合理的：它负责工作区里的 `CLAUDE.md`、`HEARTBEAT.md`、`UPDATE_MEMORY.md`、memory 目录等内容。

MyAgents 应该在本项目内声明产品级模板元数据：

- 模板展示信息：`name` / `description` / `icon`
- 模板创建后的 Agent 默认能力：`agentDefaults`

这避免把 app 运行策略塞进内容模板仓库，也避免通过路径名 `mino` 做硬编码判断。

### 5.2 新增 `WorkspaceTemplate.agentDefaults`

在 `WorkspaceTemplate` 上增加可选字段：

```ts
agentDefaults?: {
  enabled?: boolean;
  heartbeat?: HeartbeatConfig;
  memoryAutoUpdate?: MemoryAutoUpdateConfig;
}
```

语义：

- 缺省：沿用普通 basic Agent，`enabled: false`。
- `enabled: true`：创建 project 对应 Agent 时直接开启主动 Agent 模式，并把 project 标记为 `isAgent: true`。
- `heartbeat`：写入 `AgentConfig.heartbeat`。
- `memoryAutoUpdate`：写入 `AgentConfig.memoryAutoUpdate`。

### 5.3 Mino 内置模板默认值

Mino preset 使用：

```ts
agentDefaults: {
  enabled: true,
  heartbeat: {
    enabled: true,
    intervalMinutes: 240,
    ackMaxChars: 300,
    activeHours: {
      start: '08:00',
      end: '22:00',
      timezone: 'Asia/Shanghai',
    },
  },
  memoryAutoUpdate: {
    enabled: true,
    intervalHours: 24,
    queryThreshold: 5,
    updateWindowStart: '00:00',
    updateWindowEnd: '06:00',
  },
}
```

选择 4 小时 heartbeat 是为了匹配当前 Mino 实际使用状态，也避免新用户默认看到过高频率的主动检查。Heartbeat 默认开启 08:00-22:00 活跃时段，避免深夜主动唤醒；Memory Update 默认夜间窗口，且运行时还有 session 活跃度、queryThreshold、`UPDATE_MEMORY.md` 存在性等 gate。

### 5.4 Agent 创建收口

新增/抽取一个纯 helper：

```ts
buildAgentForProject(project, options)
```

用于统一生成 AgentConfig：

- `ensureAllProjectsHaveAgent()`
- `ConfigProvider.addProject()`
- 未来模板创建/升级流程

这样默认 enabled、heartbeat、memoryAutoUpdate 不靠调用方记住 patch 某几个字段，而由单一构造函数保证。

### 5.5 创建流程接入

#### 首次 Mino

`ensureBundledWorkspace()` 在注册 Mino project 后，写入 `templateId=mino` / `templateSource=builtin`。后续 `ensureAllProjectsHaveAgent()` 通过 `buildAgentForProject()` 解析 builtin template defaults，让 project 的 Agent 直接按模板默认策略创建。

#### 从模板创建 Mino

`TemplateLibraryDialog` 把 selected template 传给 `onCreateWorkspace()`；`Launcher.handleCreateFromTemplate()` 调用 addProject 时传入 `selectedTemplate.agentDefaults`。

#### 普通 add project

不传 `agentDefaults`，保持 `enabled: false`。

## 6. 边界与兼容

- 已存在 project：如果已有合法 `agentId`，不重建 Agent，不覆盖用户选择。
- 已存在 Mino：本期不自动打开。用户如果已经手动关闭，尊重用户意图。
- 从旧 IM bot migration 迁移来的 Agent：继续保留旧 bot enabled 状态，不受本 PRD 影响。
- 用户模板：默认无 `agentDefaults`。后续可以扩展用户模板编辑默认能力，但本期不做。
- 应用模板到当前工作区：只改文件，不改 AgentConfig。

## 7. 验收标准

1. Fresh install / config 中没有 Mino project 时，启动后 Mino project 有 linked Agent，且 `agent.enabled === true`、`project.isAgent === true`。
2. 从模板库选择 Mino 创建新工作区后，新 project 的 Agent 默认 `enabled === true`，带 heartbeat 与 memoryAutoUpdate。
3. 通过「添加文件夹」加入普通工作区后，新 project 的 Agent 仍默认 `enabled === false`。
4. 用户模板创建的工作区仍默认 `enabled === false`。
5. 没有 channel 的 Mino Agent 不会自动启动 IM channel，也不会单独触发 Agent heartbeat。
6. 单测覆盖：
   - 模板默认值生成 enabled Agent。
   - 普通 project 生成 disabled basic Agent。
   - 已有关联 Agent 的 project 不被覆盖。
   - Mino preset 带 agentDefaults。

## 8. 实现文件

- `src/shared/config-types.ts`：扩展 `WorkspaceTemplate`，声明 Mino `agentDefaults`。
- `src/renderer/config/services/agentConfigService.ts`：抽取 Agent 创建 helper，支持 template defaults。
- `src/renderer/config/ConfigProvider.tsx`：addProject 支持 options，模板创建传入 template provenance/defaults。
- `src/renderer/config/services/appConfigService.ts`：Mino 首次初始化记录 builtin template provenance。
- `src/renderer/components/launcher/TemplateLibraryDialog.tsx`：创建回调传出 template。
- `src/renderer/pages/Launcher.tsx`：模板创建流把 defaults 传给 addProject。
- 单测：覆盖纯 helper 与 preset defaults。

## 9. 实现确认

- `WorkspaceTemplate.agentDefaults` 已成为 Mino 默认主动能力的单一来源。
- `Project.templateId/templateSource` 已记录工作区模板来源。
- `buildAgentForProject()` 是 project → AgentConfig 的默认构造入口，会复制 heartbeat/memory 默认对象。
- `ensureAllProjectsHaveAgent()` 对带 builtin Mino provenance 的 project 生成 enabled Agent，并设置 `project.isAgent = true`。
- `ConfigProvider.addProject()` 支持模板 options，模板创建可一次性写入 project metadata 并按 defaults 创建 Agent。
- `TemplateApplyDialog` 未改动运行策略，仍只合并文件。
