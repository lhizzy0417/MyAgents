# PRD 0.2.4 — 任务中心 / 想法体验增强

> 版本：0.2.4
> 分支：`dev/0.2.4`
> 日期：2026-04-29
> 范围：5 个增强功能（搜索高亮、想法多选合并、@ 想法搜索、任务派发高级配置、任务卡查看会话）

---

## 一、原始需求（用户原文）

> 任务中心/想法需求
>
> 1. 想法搜索的结果，目前缺少匹配关键词的高亮标记
>
> 2. 想法卡更多菜单增加多选功能，进入多选状态后，可以多选（多选按钮/状态可以放在卡片右下角，但整个卡片都是点击选中反选的出发去。）；多选任务后，底部中央出现悬浮菜单，支持【合并】【删除】【取消】三个功能。点击删除需要有确认弹窗；点击合并不需要确认弹窗，直接将多个卡片变为一个，合并操作就按列表当前的展示顺序，从上到下合并，不同文本之间使用 `\n—\n` 来进行区隔，相当于追加到第一个卡片里，同时 meta 信息中的 tag 数据做去重聚合。合并成功后其他的笔记文件删除。
>
> 3. AI对话框里，@功能增加搜索想法的功能。在输入@后，顶部出现 工作区文件 ｜ 想法 的切换 tab，默认还是工作区文件搜索。但用户切换想法后，默认列表就展示若干条想法笔记的文本内容，每一条至少展示两行高度。未输入时展示最近 5 条，用户一旦输入文本，则变为搜索想法状态展示所有搜索的结果（底层能力与想法列表顶部的搜索一致）。具体的交互视觉设计，请你来精细设计。
>
> 4. 任务中心的派发任务功能面板/任务编辑面板，目前仅支持选择 Agent 工作区，所有细节都是直接服用 Agent 工作区。但实际场景下应该在这里有「高级功能」，点击展开为本次任务设置不同的 runtime、模型、工具。大概逻辑应该包含
> 1)任务派发层级将 runtime 和 模型、工具的设置调整 成用户可配置的方式。（默认是基于 Agent，但可以变更为其他）
> 2)任务派发面板的交互设计优化
>
> 5. 任务卡片应该可能会有对应的正在执行或者个刚刚完成的 session，希望增加一个关联功能，在鼠标 hover 到卡片上的时候，在更多按钮的左边 出现一个新的功能按钮「查看任务会话」，点击后应该新开 tab 直接加载当前任务关联的最新的 session 加载进去（交互对应就是点开面板后任务执行最近的一条）

> 需求澄清后的修订（2026-04-29）：
> - 第 2 条「合并到第一个卡片里」修订为「合并时新建一条想法承接全部内容，合并成功后其他原始卡片（含原首条）一并删除」。原因：新建卡片更干净，避免在原卡片上做 in-place mutation 导致的部分状态残留。
> - 第 2 条「meta tag 去重」保留；正文中的 `#xxx` 多次出现不动。
> - 第 4 条「工具」澄清为仅 MCP server 启用列表（一期范围），未来可能加 `disallowedTools`。
> - 第 4 条「权限默认」澄清为：Task 未设置时执行使用对应 runtime 的最大权限模式（SDK 内置 = `bypassPermissions`），而不是 fallback Agent 工作区的权限设置。

---

## 二、需求共识（澄清结果）

### 需求 1 — 想法搜索结果高亮

| 项 | 决策 |
|----|------|
| 高亮范围 | 仅命中关键词的字符片段；多次出现都标 |
| 视觉 | 黄底（`var(--accent-warm-subtle)`）深字（`var(--accent-warm)`），与现有 `#tag` pill 区分但同色系 |
| 大小写 | 不区分（保持与后端 `thoughtList(query)` 一致） |
| 与 `#tag` pill 共存 | tag 仍渲染橙色 pill；当查询命中 tag 文字段时只染那段字符，pill 外形不变 |
| Clamp 行为 | 不做特殊处理，保持原 5 行 clamp + "展开全文" 按钮 |
| 高亮算法位置 | 渲染端 TS 实现（简单 `toLowerCase + indexOf` 循环），不走后端 |

### 需求 2 — 想法多选合并/删除

| 项 | 决策 |
|----|------|
| 入口 | 卡片"⋯ 更多"菜单加 `多选` 项；点击进入多选模式 |
| 多选模式视觉 | 卡片右下角显示一个圆形 checkbox；整卡可点击切换；选中状态卡片加 ring（`var(--accent-warm)`）+ 浅色 bg |
| 进入多选模式后行为 | 隐藏 hover 出现的 AI 讨论 / 派发 / ⋯ 三按钮；卡片本体的双击编辑禁用；标签/查询过滤仍生效 |
| 退出方式 | 底部悬浮菜单的 `取消` 按钮 + Esc 键退出；自动恢复原列表交互 |
| 底部悬浮菜单内容 | `合并 (N)` `删除 (N)` `取消`；N=0 时合并/删除按钮置灰 |
| 删除确认弹窗 | 复用 `ConfirmDialog`，文案：「确认删除选中的 N 条想法？此操作不可恢复。」 |
| 合并语义 | 新建一条想法承接全部内容；按列表当前展示顺序自上而下用 `\n—\n` 拼接；新条 `tags` = 所有源卡片 `tags` 去重聚合（不重新解析正文）；新条 `convertedTaskIds` = 所有源卡片并集去重；新条 `images` = 所有源卡片图片合并；合并完成后**所有源卡片**（含原首条）删除 |
| 合并文本分隔符 | `\n—\n`（Em Dash U+2014） |
| 合并不需要确认弹窗 | 与原始需求一致 |
| 失败处理 | 后端 Rust 实现合并为原子事务：先创建新想法，再批量删源；任意一步失败则回滚（删掉刚建的新想法），前端 toast 提示 |
| 悬浮菜单 z-index | `z-40`（高于卡片但低于 `z-[200]` 的全屏 overlay 与 dialog）；位置 `fixed bottom-6 left-1/2 -translate-x-1/2` |

### 需求 3 — @ 功能搜索想法

| 项 | 决策 |
|----|------|
| Picker 顶部 segmented tab | `工作区文件 ｜ 想法`；默认 `工作区文件`；同一 chat tab 内会话生命周期记忆上次选择 |
| 切换交互 | 点击切换；同时支持 `←/→` 方向键切 tab；切换时 `selectedFileIndex` 重置为 0；当前查询字符串保留，立即触发对应 tab 的搜索 |
| 想法 tab 默认列表 | 未输入查询：展示最近 5 条（按 `updatedAt` 倒序）|
| 想法 tab 搜索状态 | 输入任意字符即触发搜索（与现有 `thoughtList({query})` 复用），软上限 50 条；超过显示"还有 N 条结果未显示"|
| 想法行展示 | 高 ≥ 2 行；从上到下：相对时间 + tags 小 pill 行（最多 3 个 tag）+ 内容前 2 行（`-webkit-line-clamp: 2`）+ 命中高亮（搜索时） |
| 选中后插入 | 直接插入想法**完整 markdown 内容**到输入框 `@` 位置（替换 `@query`）；末尾追加一个空格；不带任何分隔/头部包装 |
| AI 看到的格式 | 与用户输入混在一起的纯 md 内容；不加 `--- 想法 ---` 等标识 |
| 键盘导航 | ↑↓ 在当前 tab 列表内移动；Tab/Enter 选中；Esc 关闭；←/→ 切换 tab（仅当焦点在 picker 时） |
| 视觉风格 | 与现有文件搜索结果同款 popover；tab 头部使用 segmented 样式（圆角胶囊背景 + 当前激活白底 + 阴影） |

### 需求 4 — 任务派发/编辑高级配置

| 项 | 决策 |
|----|------|
| 一期范围 | Runtime + Model + PermissionMode + MCP 启用列表 |
| 「工具」具体含义 | 仅 MCP server 启用列表（与 Agent 工作区 MCP 选项 1:1 对齐） |
| 字段持久化 | Task 类型新增 `runtime?: string` 和 `mcpEnabledServers?: string[]`；保留已有 `model?` `permissionMode?` |
| 默认语义 | 字段为 `undefined`/未设置 = "跟随 Agent 工作区当前值"；用户主动选择即 snapshot 到 Task 字段 |
| 权限默认特殊规则 | **未设置 permissionMode 时，执行使用所选 runtime 的最大权限模式**（SDK 内置 → `bypassPermissions`；Claude Code CLI / Codex / Gemini 各自的 max-perm 等价值），而不是 fallback Agent 的权限。这是为了让派发任务默认能跑通，避免被 Agent 当前的低权限模式卡住。 |
| 切换 runtime 时 model/MCP 字段联动 | 切到 builtin 以外 runtime 时，model/MCP 字段折叠并显示提示「外部 runtime 使用其自身配置」（与 WorkspaceBasicsSection 行为一致）|
| UI 折叠位置 | 在 `Agent 工作区` 选择器下方插入 `▸ 高级配置（可选）` 折叠条；展开后显示 4 个字段，每个字段下行小字注明「未选择 = 跟随 Agent 工作区」|
| 折叠默认状态 | 默认折叠；展开状态在面板生命周期内保持（不持久化）|
| Editor 复用 | 抽出 `<TaskAdvancedConfigEditor>` 组件，DispatchTaskDialog 与 TaskEditPanel 共用 |
| 派发面板交互优化（一期） | 仅打磨新增高级配置区块的交互：视觉层级清晰、字段间留白舒适、折叠动画流畅；其他面板大改留待后续 |

### 需求 5 — 任务卡片「查看任务会话」按钮

| 项 | 决策 |
|----|------|
| 触发条件 | hover 卡片时显示 |
| 位置 | 卡片右上角 `…` 更多按钮**左边** |
| 数据 | `task.sessionIds[task.sessionIds.length - 1]`（追加顺序末尾即最新）|
| 空数据态 | `sessionIds.length === 0` 时**不渲染按钮** |
| 应用范围 | TaskCardItem（卡片视图）+ TaskListRow（列表视图）|
| 图标 | `MessageCircle` (lucide) |
| 点击行为 | 复用现有 `OPEN_SESSION_IN_NEW_TAB` 自定义事件，参数 `{sessionId, workspacePath}` |
| 与 hover 隐藏交互的关系 | 与 ⋯ 旁的 hover 行为一致——卡片 hover 时整组 hover 动作浮现 |

### 需求 6 — 横切问题

- 分支：直接在 `dev/0.2.4` 上开发
- CHANGELOG：本次不动，由用户后续统一安排
- 版本：保持 0.2.4
- PRD 文件：本文件 `specs/prd/prd_0.2.4_task_center_thought_enhancements.md`

---

## 三、技术实现方案

### 3.1 数据模型变更

**`src/shared/types/thought.ts`** —— 不需要改类型，已有 `id / content / tags / images / convertedTaskIds / createdAt / updatedAt` 全部够用。

**`src/shared/types/task.ts`** —— 在 Task / TaskCreateDirectInput / TaskUpdateInput 三处加：
```ts
runtime?: string;            // 'builtin' | 'claude-code' | 'codex' | 'gemini' | undefined
mcpEnabledServers?: string[]; // undefined = 跟随 Agent；[] = 显式不启用任何 MCP；具体数组 = snapshot
```
`model` 与 `permissionMode` 已有，不动。

**`src-tauri/src/task.rs`** —— `Task` 结构体同步加两个 `Option` 字段（带 `#[serde(default)]`，与 CronTask 字段约定一致）；create_direct / update / append_session 等不受影响。

### 3.2 后端实现

#### A. 想法合并 API（新增）

在 `src-tauri/src/thought.rs` 新增 `merge` 方法和 `cmd_thought_merge` 命令：

```rust
pub struct ThoughtMergeInput {
    pub source_ids: Vec<String>,  // 按列表展示顺序
}

pub async fn merge(&self, input: ThoughtMergeInput) -> Result<Thought, String>
```

实现：
1. `validate_safe_id` 校验所有 id
2. 读取所有源 thoughts；任何一条不存在直接报错
3. 按传入顺序拼接 `content`：`sources.iter().map(|t| &t.content).collect::<Vec<_>>().join("\n—\n")`
4. `tags`：所有源 tags 去重（保持首次出现顺序）
5. `images`：所有源 images 拼接去重
6. `converted_task_ids`：所有源并集去重
7. 调 `create` 创建新想法，得到 `merged`
8. 逐条 delete 所有源；失败时记日志但继续；最后返回 `merged`

并发安全：内部 `RwLock` 在 `create` 和每次 `delete` 之间会释放，但 thought 删除即便并发也是幂等的；`thought` 没有写者竞争（用户操作串行），可接受。

#### B. 任务执行 permission 默认值

定位文件：`src/server/index.ts` 或 `src/server/runtime/` 中调用 SDK `query()` 处。Task 执行路径在 `task_center.md` 描述为 CronTask 调度 → `task::build_dispatch_prompt()`。permissionMode 实际生效在 sidecar 启动时读取 Agent 配置 → SDK options。需找到该读取点并改造：

伪代码：
```ts
const taskPermissionMode = task.permissionMode
  ?? maxPermissionForRuntime(task.runtime ?? agent.runtime);

function maxPermissionForRuntime(rt: string): string {
  switch (rt) {
    case 'claude-code': return 'bypassPermissions'; // CC CLI
    case 'codex':       return 'codex-max';         // Codex 最大权限标识符（待查 runtime adapter）
    case 'gemini':      return 'gemini-max';
    case 'builtin':
    default:            return 'bypassPermissions';
  }
}
```
具体值在实现时通过读 `src/server/runtimes/` 各 adapter 源码确认。

### 3.3 前端实现

#### A. 想法搜索高亮（需求 1）

**新增** `src/renderer/utils/highlightSearchMatches.tsx`：
```ts
export function findHighlightRanges(text: string, query: string): Array<[number, number]>
export function renderWithHighlights(text: string, ranges: Array<[number, number]>): React.ReactNode
```
- ranges 为 UTF-16 索引对（与 JS `string.slice` 对齐）
- 输入 query 为空返回 `[]`；不区分大小写

**改 `ThoughtCard.tsx::renderWithTagHighlights(content, onTagClick)`**：扩展为 `renderWithTagAndQueryHighlights(content, onTagClick, query)`，对每个非 tag 段落再切一次 query 命中区间，叠加黄底高亮 span（`bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)] rounded-[2px]`）。tag pill 不重叠染色（tag 已是颜色块，不再加 query 高亮，避免双层视觉混乱）。

**改 `ThoughtPanel.tsx`**：把当前 `query` 透传给 `ThoughtCard` 一个新 prop `searchQuery`。

#### B. 想法多选合并/删除（需求 2）

**新增** `src/renderer/components/task-center/ThoughtBulkBar.tsx` —— 底部悬浮栏组件：

```
[合并 (N)]  [删除 (N)]                                [取消]
```

**改 `ThoughtPanel.tsx`**：增加 `selectMode: boolean` 与 `selectedIds: Set<string>` 两个 state；
- 进入：通过 `ThoughtCard` 的 ⋯ 菜单"多选"项触发（新增菜单项）
- 退出：`ThoughtBulkBar` 取消按钮 / Esc / 多选模式下数据全部删完
- 渲染 `ThoughtBulkBar` 当 `selectMode === true`
- `合并`：调 `thoughtMerge({sourceIds: filtered.filter(t => selectedIds.has(t.id)).map(t=>t.id)})`，按 `filtered` 当前顺序传入 → 后端
- `删除`：弹 `<ConfirmDialog>` → 调 `thoughtDelete(id)` 逐条删除；并发可接受

**改 `ThoughtCard.tsx`**：
- 新增 props：`selectMode`, `selected`, `onToggleSelect`, `onEnterSelectMode`
- ⋯ 菜单加"多选"项（仅 `!selectMode` 时显示）
- `selectMode === true` 时：
  - 隐藏所有 hover 出现的 action 按钮（AI 讨论 / 派发 / ⋯ 内的编辑/删除）
  - ⋯ 按钮也隐藏（防止重复入口）
  - 整卡 onClick / onDoubleClick 改为 `onToggleSelect`
  - 右下角增加圆形 checkbox（size 18px，选中态填充 `var(--accent-warm)` + 白色对勾）
  - 选中态卡片：`ring-1 ring-[var(--accent-warm)]` + `bg-[var(--accent-warm-subtle)]`
- `convertedTaskIds` 已派生任务计数仍显示

#### C. @ 想法搜索（需求 3）

**改 `SimpleChatInput.tsx`**：

新增 state：
```ts
const [mentionTab, setMentionTab] = useState<'file' | 'thought'>('file');
const [thoughtResults, setThoughtResults] = useState<Thought[]>([]);
```

新增 effect：当 `showFileSearch === true` 且 `mentionTab === 'thought'` 时，触发 `thoughtList({query, limit: 50})` 或 `thoughtList({limit: 5})`（无 query 时）。

**新增** `src/renderer/components/chat/MentionPickerThoughtItem.tsx` —— 想法行组件，封装时间/tag/2 行内容/高亮逻辑。

Picker JSX 重构：
```
<picker>
  <SegmentedTabs value={mentionTab} onChange={setMentionTab} />
  {mentionTab === 'file' ? <FileResults/> : <ThoughtResults/>}
</picker>
```

键盘处理：
- `mentionTab === 'thought'` 时，Tab/Enter 选中替换 `@query` 为 thought.content + ' '，关闭 picker
- ←/→ 切 tab，仅当 picker 打开
- ↑↓ 在当前 tab 内导航

`mentionTab` 持久于 chat tab 生命周期（即 SimpleChatInput 实例），不持久到 localStorage。

#### D. 任务高级配置（需求 4）

**新增** `src/renderer/components/task-center/editors/TaskAdvancedConfigEditor.tsx`：
```ts
interface Props {
  workspaceId: string;       // 用于读取 Agent 默认值占位
  runtime?: string;
  setRuntime: (v: string | undefined) => void;
  model?: string;
  setModel: (v: string | undefined) => void;
  permissionMode?: string;
  setPermissionMode: (v: string | undefined) => void;
  mcpEnabledServers?: string[];
  setMcpEnabledServers: (v: string[] | undefined) => void;
}
```
渲染折叠条 `▸ 高级配置（可选）` + 4 段：
- Runtime（CustomSelect 复用 RuntimeSelector 的可选项构造）
- 模型（仅 builtin runtime 时；调用现有 modelOptions 构造）
- 权限模式（CustomSelect, 选项 = `[未设置（最大权限）, 行动, 规划, 自主行动]`）
- MCP 启用列表（多选 chips，复用 Agent MCP 列表）

每段下方小字：「未选择时跟随 Agent 工作区当前配置」。`permissionMode` 那段补充一句：「未选择时使用 runtime 最大权限模式（默认 bypassPermissions）」。

**改 `DispatchTaskDialog.tsx`** 与 **`TaskEditPanel.tsx`**：
- 新增对应 4 个 state
- 在 `Agent 工作区` 选择器下方插入 `<TaskAdvancedConfigEditor>`
- 提交时把字段透传给 `taskCreateDirect` / `taskUpdate`

**`taskCreateDirect` API**（`src/renderer/api/taskCenter.ts`）：透传新字段；后端 Rust 端在 `TaskCreateDirectInput` struct 加对应 `Option` 字段。

#### E. 任务卡查看会话按钮（需求 5）

**改 `views/TaskItemActions.tsx`** 或在 `TaskCardItem.tsx` / `TaskListRow.tsx` 直接渲染：

由于该按钮**不进入下拉菜单**而是**与 ⋯ 平级常驻 hover 元素**，更适合在卡片父组件直接加：

```tsx
{task && task.sessionIds.length > 0 && (
  <button
    className="opacity-0 group-hover:opacity-100 ..."
    onClick={(e) => {
      e.stopPropagation();
      const lastSid = task.sessionIds[task.sessionIds.length - 1];
      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: { sessionId: lastSid, workspacePath: task.workspacePath }
      }));
    }}
    title="查看任务会话"
  >
    <MessageCircle className="h-3.5 w-3.5" />
  </button>
)}
```
两处（TaskCardItem 与 TaskListRow）都加。stopPropagation 防止触发卡片本身的"打开详情"。

### 3.4 主要风险与对策

| 风险 | 对策 |
|------|------|
| Task permissionMode 默认改为最大权限会让"未配置 = 风险高"成真 | 在 PRD 与代码注释中明确写出，编辑面板下小字明示「未选择时使用 runtime 最大权限模式（默认 bypassPermissions）」；Task→CronTask 投影 (`management_api.rs::ensure_cron_for_task` + `task.rs::update`) 已统一回退至 `fullAgency` |
| @ 想法插入完整内容可能很长 | 一期不加约束（按用户决策），监控用户反馈再决定 |
| 合并失败回滚 | 后端 merge 实现为先 create 后 delete；create 失败 → 直接报错；delete 失败 → 回滚已 create 的新条，前端 toast 报错；保留原始想法 |
| 多选模式 + 列表 filter 变化（标签切换）→ 选中条不在视野 | 切换 tag/query 时**清空** `selectedIds`，避免幽灵选中；ESC 也退出多选 |
| @ picker tab 切换时 query 未清空 → 想法 tab 立即用同 query 搜索 | 这是预期行为；与文件 tab 行为对齐 |

### 3.5 已知限制（v0.2.4 范围内）

- **`mcpEnabledServers` 仅落盘，运行时未生效**：UI、类型、Rust struct、`update()` 路径均已就位，但 cron 执行链（`/cron/execute-sync` → `enqueueUserMessage`）未读取 Task 级 MCP override。当前用户在派发面板设置的 MCP 启用列表会保存到 Task，但调度执行时仍读 Agent 工作区配置。此限制对应 PRD 4a「先简单点」的范围决策；后续版本接入 cron 执行链即可。
- **TaskAdvancedConfigEditor 模型字段为自由文本**：v0.2.4 简化为单行 input，未做 provider 模型联动（与 chat 主面板的 model picker 不对齐）。后续可改为基于当前 Agent 的 provider 列表生成 CustomSelect。

### 3.5 验证清单

- [ ] 想法搜索 "test" 命中 "Testing" 高亮 t/e/s/t（前 4 字符），与 #tag pill 不冲突
- [ ] 多选进入/退出/合并/删除/Esc/取消按钮全部可达
- [ ] 合并 3 条 → 文本顺序正确 + 分隔符正确 + 新卡片 tags 去重 + 原 3 条删除
- [ ] 合并失败（造模拟错误）→ 新卡片不残留，toast 报错
- [ ] @ 切到想法 tab → 默认显示 5 条 → 输入 "abc" 触发搜索 → ↑↓ 选中 → Enter 插入完整内容 → @query 被替换 → 末尾空格存在
- [ ] @ 想法 tab 高亮与左侧面板高亮视觉一致
- [ ] 派发面板高级配置 → 不展开 → 创建任务 → Task 字段全 undefined → 执行使用 runtime 最大权限
- [ ] 派发面板高级配置 → 选 model = X → 创建 → Task.model = X → 执行使用 X
- [ ] 派发面板 runtime 切到 codex → model/MCP 字段折叠
- [ ] 任务编辑面板上述链路全通
- [ ] 任务卡 hover → 「查看任务会话」按钮显示在 ⋯ 左边 → 点击新 tab 打开最新 session
- [ ] 无 sessionIds 的任务卡不渲染该按钮
- [ ] `npm run typecheck` 与 `npm run lint` 通过
