---
type: prd
status: implemented
created: 2026-06-06
updated: 2026-06-06
implemented: 2026-06-06
implementation_commit: 92bcf468
verified_against: ecd45063
scope: "Workspace file search result navigation, reveal-in-tree, result context menu, preview focus"
branch: dev/0.2.31
---

# PRD 0.2.31 - 工作区搜索结果导航体验

## 1. 背景

工作区文件搜索的索引冷重建问题已在 `9c7e4aa5 fix: avoid cold workspace search rebuilds` 修复。开发前搜索可以返回结果，但用户在结果区继续操作时仍存在体验断点：

1. 搜索结果能显示命中行，但点击结果后右侧预览不一定落到对应命中位置。
2. 搜索结果文件行缺少“一键回到文件目录并选中文件”的入口。
3. 搜索结果文件行右键菜单不完整，且开发前实现依赖目录树已加载节点，目录没加载时会无响应。
4. 搜索结果列表没有命中选中态，用户点击后无法确认右侧预览对应哪一条。

本 PRD 的目标是把“搜索结果”从静态结果列表升级成稳定的文件导航入口：用户搜到文件后，可以预览、跳到命中行、在文件树里定位、打开所在文件夹，并且这些行为在 split view、已打开同文件、目录未加载等场景下都可靠。

## 2. 最终实现状态

**状态：已实现。** 本 PRD 的 P0/P1 均已落地，代码提交为 `92bcf468 feat: improve workspace search result navigation`。本次文档复核以当前 `dev/0.2.31` HEAD `ecd45063` 为准；后续 `ecd45063` 的目录树 refresh 修复未改变本 PRD 的搜索结果导航协议。

最终用户体验：

1. 工作区搜索结果文件行新增纯 icon 按钮，原生 hover tip 为 `在文件目录中展示`。
2. 搜索结果文件行和命中行支持右键短菜单：`预览`、`在文件目录中展示`、`打开所在文件夹`。
3. 点击 `在文件目录中展示` 会退出搜索模式，展开祖先目录，选中目标文件，并通过 Virtuoso 滚动到可见位置。
4. 点击文件名主体会预览文件；若有内容命中，默认定位到第一条内容命中；展开箭头只负责展开/折叠。
5. 点击任意命中行都会生成新的 preview focus event；同一个文件已打开时也会重新定位到新行。
6. Markdown / HTML 在存在 search focus target 时走可定位的源码/编辑路径，不停留在无法精确行定位的 rendered/browser 视图。
7. 当前 active 文件或命中行有浅色选中态；后台 refresh 后若目标仍存在则保持，否则清空。
8. 搜索结果路径在进入前端导航状态前统一把 Windows `\` 归一化为 `/`。

## 3. 代码事实确认

| 事实 | 代码证据 |
|---|---|
| 工作区搜索走 Tauri IPC 到 Rust `SearchEngine`，不经 Sidecar。 | `src/renderer/api/searchClient.ts` 调用 `cmd_search_workspace_files`；`specs/tech_docs/search_architecture.md` 已说明搜索是 Tauri-only。 |
| 搜索结果结构包含 `FileSearchHit.matches[].lineNumber` 和 highlights。 | `src/renderer/api/searchClient.ts` 中 `FileMatchLine`。 |
| 搜索结果进入 UI 前会归一化路径，并提供 active target / ancestors / expanded merge 等纯 helper。 | `src/renderer/utils/workspaceSearchNavigation.ts`。 |
| `DirectoryPanel` 搜索使用 stale-while-revalidate：先搜当前可用结果，再延迟 refresh index，有变化时重搜。 | `src/renderer/components/DirectoryPanel.tsx` 的 search effect。 |
| `FileSearchResults` 已拆分 header 交互：arrow toggle、主体预览、icon reveal、右键 path-based 菜单回调。 | `src/renderer/components/search/FileSearchResults.tsx`。 |
| 搜索结果右键菜单不再依赖目录树节点已加载。 | `DirectoryPanel` 的 `SearchResultContextMenuState` 与 `getSearchResultContextMenuItems(hit)`。 |
| reveal-in-tree 使用祖先目录逐层 `openPath` / `expandDir`，成功后才退出搜索模式并选中目标。 | `DirectoryPanel` 的 `handleRevealSearchResultInTree`。 |
| 文件树滚动通过 Virtuoso `scrollToIndex`，请求由 `WorkspaceTreeViewport` 消费并回调 `onRevealHandled` 清除。 | `src/renderer/components/workspace-tree/WorkspaceTreeViewport.tsx`。 |
| 预览定位使用 `FilePreviewFocusTarget` 事件从 `DirectoryPanel -> Chat/FileActionContext -> FilePreviewModal -> MonacoEditor` 传递。 | `src/renderer/types/filePreview.ts`、`Chat.tsx`、`FilePreviewModal.tsx`、`MonacoEditor.tsx`。 |
| `MonacoEditor` 对已 mount 实例响应新的 `focusTarget` 对象，调用 `revealLineInCenter`、`setPosition` 并短暂高亮行。 | `src/renderer/components/MonacoEditor.tsx`。 |
| Markdown search focus 会切到 edit/source 视图以保证源码行定位。 | `FilePreviewModal` 的 `focusTarget && isMarkdown && canEdit` effect。 |

## 4. 目标

### 4.1 用户目标

用户在工作区搜索结果里应能完成以下操作：

1. 点击命中行后，右侧预览稳定跳到该命中行。
2. 同一个文件已经打开时，再点击另一个命中行，也会重新定位，不停留在旧位置。
3. 点击文件结果行的“在文件目录中展示”图标后，退出搜索模式，文件树展开到该文件所在目录，并选中文件。
4. 右键搜索结果文件行，可以直接执行“预览”“在文件目录中展示”“打开所在文件夹”。
5. 结果列表能看出当前选中的文件或命中行。

### 4.2 工程目标

1. 搜索结果导航必须建立在现有 `DirectoryPanel`、`FilePreviewModal`、`MonacoEditor`、`WorkspaceTreeViewport` 上，不新增独立文件树或平行预览系统。
2. 文件 IO 仍走 `useWorkspaceFileService(workspacePath)` 和 Tauri `cmd_workspace_*`，不得走 Sidecar HTTP。
3. 不改搜索索引行为，不改 Rust 查询语义。
4. 不用 remount 预览器作为主要定位手段，避免破坏编辑状态、autosave、live reload、滚动状态。

## 5. 范围

### 5.1 本期 IN

| 优先级 | 状态 | 需求 |
|---|---|---|
| P0 | Done | 新增搜索结果文件行“在文件目录中展示”图标按钮，hover 原生 title 为“在文件目录中展示”。 |
| P0 | Done | 搜索结果文件行右键自定义菜单：`预览`、`在文件目录中展示`、`打开所在文件夹`。 |
| P0 | Done | “在文件目录中展示”退出搜索模式，展开祖先目录，选中目标文件，并滚动到可见区域。 |
| P0 | Done | 点击搜索命中行后，右侧预览对每一次点击都跳到对应行，即使同一文件已打开。 |
| P0 | Done | 文件 header 点击语义修正：文件名区域打开文件；展开箭头只负责展开/折叠。文件名命中但无内容行时也能打开文件。 |
| P1 | Done | 搜索结果列表增加当前 active 文件/命中行选中态。 |
| P1 | Done | 后台 refresh 更新结果时保留用户手动展开/折叠状态，不无条件重置。 |
| P1 | Done | Markdown 搜索命中点击的定位策略明确化：优先切到编辑/源码视图定位，避免 rendered markdown 行映射误差。 |
| P1 | Done | 搜索结果菜单 path-based 化，不依赖目录树节点已加载。 |

### 5.2 本期 OUT

- 不改 Tantivy / jieba / direct scan fallback。
- 不增加全文搜索过滤器、正则搜索、大小写开关。
- 不做全局多文件 replace。
- 不重构整个 `DirectoryPanel`。
- 不把 Markdown rendered preview 做源码行号映射。
- 不改变普通文件树已有右键菜单的完整功能集合。

## 6. 交互需求

### 6.1 搜索结果文件行布局

文件行布局包含：

- 展开箭头
- 文件图标
- 文件名
- dirname
- match count badge

本期新增：

- 在 dirname 和 match count badge 之间增加一个纯 icon button。
- 按钮只显示 icon，无文字。
- hover 使用原生 `title="在文件目录中展示"`。
- 已实现 icon：`lucide-react` 的 `LocateFixed`。
- 按钮尺寸保持紧凑，不挤压文件名。实际命中区域约 24px，视觉 icon 14px。
- 按钮点击必须 `stopPropagation()`，不能触发展开/打开文件。

### 行点击拆分

文件 header 行需要拆成两个可理解区域：

| 区域 | 行为 |
|---|---|
| 展开箭头 | 展开/折叠该文件下的 match lines。 |
| 文件名 / 路径主体 | 打开文件。若该文件有内容命中，默认定位到第一条命中行；若只有文件名命中，则打开文件顶部。 |
| “在文件目录中展示”icon | 退出搜索并在文件树中选中该文件。 |
| match count badge | 不单独承载主要动作，随文件主体点击或保持无交互均可，但不能抢占定位 icon。 |

### 6.2 “在文件目录中展示”

触发来源：

1. 搜索结果文件行 icon button。
2. 搜索结果文件行右键菜单。

行为：

1. 成功定位后关闭搜索模式：`setIsSearchMode(false)`。
2. 成功时清理搜索 UI 显示状态；`searchQuery` 保留，方便用户再次进入搜索模式继续使用原 query。
3. 找到目标 path 的所有祖先目录。
4. 逐级打开祖先目录。若祖先目录还没加载，调用现有 `fileService.dirExpand({ path })` 加载后再继续。
5. 选中目标文件：`setSelectedNodes([targetNode])`，更新 `lastClickedPathRef.current`。
6. 滚动文件树，使目标行进入可见区域；实际实现为 Virtuoso center align。
7. 如果文件已不存在或目标 path 无法加载，显示 toast：`文件不存在或已删除`，并保持搜索模式不退出。

实现约束：

- 不新增后端命令。现有 `dirTree` + `dirExpand` 足够按路径逐级加载。
- `WorkspaceTreeViewport` 已增加可控 scroll-to-path 能力。`DirectoryPanel` 传入 `revealRequest`，`WorkspaceTreeViewport` 在 `visibleRows` 中找到 path 后通过 Virtuoso `scrollToIndex` 滚动，并调用 `onRevealHandled` 消费请求。
- 不能通过直接 DOM query 和手动设置 scrollTop 作为主方案。Virtuoso 列表应通过自身 API 滚动。
- 成功定位后文件树选中态应与普通点击文件一致。

### 6.3 搜索结果右键菜单

搜索结果文件行右键菜单固定为：

1. `预览`
2. `在文件目录中展示`
3. `打开所在文件夹`

行为定义：

| 菜单项 | 行为 |
|---|---|
| 预览 | 打开右侧 split preview 或 modal。若右键目标有第一条内容命中，则定位第一条内容命中行；若无内容命中，则打开文件顶部。 |
| 在文件目录中展示 | 执行 6.2 的 reveal-in-tree。 |
| 打开所在文件夹 | 调用现有 `fileService.openInFinder({ path })`，行为与普通文件树文件菜单一致。 |

约束：

- 搜索结果菜单必须 path-based，不允许依赖 `findInTree(directoryInfo.tree.children, path)` 成功后才显示。
- 菜单只对搜索结果文件行出现。命中行右键可以复用同一菜单，目标 path 是该命中所属文件。
- 不提供删除、重命名、引用、打开默认应用等普通树菜单项。本期搜索结果菜单保持短菜单，降低误操作。

### 6.4 搜索命中行定位

开发前 `initialLineNumber` 是一次性初始值。本期已升级成“每次点击都生效”的导航事件。

最终数据模型：

```ts
type FilePreviewFocusTarget = {
  requestId: number;
  lineNumber: number;
  query?: string;
  highlights?: [number, number][];
};
```

要求：

1. `DirectoryPanel` 每次点击 match line 都生成新的 `requestId`。
2. `Chat` split view 和 fullscreen preview 必须透传该 focus target。
3. `FilePreviewModal` 把 focus target 传给 `MonacoEditor`。
4. `MonacoEditor` 在已 mount 的 editor 上监听新的 `focusTarget` 对象事件，执行：
   - `revealLineInCenter(lineNumber)`
   - `setPosition({ lineNumber, column })`
   - 临时 decoration 高亮当前行
5. 不能只依赖 `initialLineNumber` prop，也不能通过改变 React key 强制 remount Monaco。

实现细节：`requestId` 用于来源侧生成 active target 和调试语义；Monaco 侧去重以 `focusTarget` 对象身份为准，避免不同来源的 `requestId` 碰撞，也保证同一行重复点击仍可重新 reveal。

### Markdown 文件定位

Markdown 默认 rendered preview 无可靠源码行号映射。最终策略：

- 点击搜索命中行打开 Markdown 时，如果文件可编辑，切换到编辑视图并用 Monaco 定位源码行。
- 如果不可编辑或无法进入 Monaco，则只打开文件，并允许后续 P2 再做 rendered preview 的近似定位。
- 不做 rendered markdown DOM 到源码行的复杂映射。

### 6.5 当前选中态

P1 增加 active search target：

```ts
type ActiveSearchTarget =
  | { kind: 'file'; path: string }
  | { kind: 'match'; path: string; lineNumber: number; requestId: number };
```

要求：

- 点击文件主体、命中行、右键“预览”后更新 active target。
- active 文件 header 使用浅色选中背景，不能和 hover 混淆。
- active match line 使用更明确但克制的选中态，例如 `bg-[var(--accent-warm-subtle)]`。
- refresh 搜索结果后，如果 active target 仍存在，保留选中态；如果不存在，清空。

### 6.6 Refresh 与展开状态

开发前 refresh 后会 `setExpandedFiles(new Set(refreshed.hits.map(h => h.path)))`。这会覆盖用户手动折叠/展开。

P1 要求：

- 新 query 的首次结果默认展开全部命中文件。
- 同 query 后台 refresh 只合并结果，不重置用户手动折叠状态。
- 如果新增命中文件，默认展开新增文件。
- 如果命中文件消失，从 `expandedFiles` 中移除。

## 7. 技术方案

### 7.1 主要变更文件

| 文件 | 变更 |
|---|---|
| `src/renderer/components/search/FileSearchResults.tsx` | 增加 reveal icon、拆分 header click 区域、支持 active target、右键回调传 hit。 |
| `src/renderer/components/DirectoryPanel.tsx` | 新增 reveal-in-tree handler、search result path-based menu、focus target 生成、active target 状态。 |
| `src/renderer/components/workspace-tree/WorkspaceTreeViewport.tsx` | 增加基于 Virtuoso 的 scroll-to-path request。 |
| `src/renderer/components/FilePreviewModal.tsx` | 把 `initialLineNumber` 迁移或兼容为 focus target。 |
| `src/renderer/components/MonacoEditor.tsx` | 支持已 mount 后响应 focus target 变化并更新 decorations。 |
| `src/renderer/pages/Chat.tsx` | split view / fullscreen preview state 透传 focus target。 |
| `src/renderer/context/FileActionContext.tsx` | 兼容通用预览协议的 focus target。 |
| `src/renderer/types/filePreview.ts` | 定义 `FilePreviewFocusTarget`。 |
| `src/renderer/utils/workspaceSearchNavigation.ts` | 抽出路径归一化、ancestor、expanded merge、active target 判断等可测试纯逻辑。 |

### 7.2 Reveal-in-tree 算法

输入：workspace-relative file path，例如 `src-tauri/src/search/file_indexer.rs`。

最终流程：

1. `const ancestors = ['src-tauri', 'src-tauri/src', 'src-tauri/src/search']`。
2. 对每个 ancestor：
   - `openPath(ancestor)`。
   - 如果 `nodeMetaByPath` 暂无该 ancestor 或该 ancestor `loaded === false`，调用 `dirExpand(ancestor)`。
   - 等待 React state 提交后继续下一层。可用小型 async loop + refs，避免依赖 stale closure。
3. 找到目标 file node 后：
   - `setSelectedNodes([node])`。
   - `lastClickedPathRef.current = path`。
   - 发出 `treeRevealRequest = { id, path }`。
4. `WorkspaceTreeViewport` 收到 request 后在 `visibleRows` 找 index，并 `scrollToIndex({ index, align: 'center', behavior: 'smooth' })`。
5. `WorkspaceTreeViewport` 调用 `onRevealHandled(id)`，`DirectoryPanel` 清空已消费请求，避免 search mode 关闭后 stale reveal 回放。

注意：

- 不能只 `openPath` 不 `dirExpand`。深层目录可能没加载，`visibleRows` 中根本没有目标节点。
- `dirExpand` 已是 workspace-safe Rust invoke，不需要新命令。
- 如果中途某个 ancestor 不存在，停止并提示。
- 等待节点出现的 frame budget 为 `REVEAL_NODE_WAIT_FRAMES`。如果新请求抵达，旧 reveal 返回 `cancelled`，不弹错误 toast。

### 7.3 Search result context menu state

`ContextMenuState` 只服务普通树节点。本期已新增搜索结果菜单 state，避免把不存在于树里的 fake node 塞给普通树菜单：

```ts
type SearchResultContextMenuState = {
  x: number;
  y: number;
  hit: FileSearchHit;
};
```

渲染时复用现有 `ContextMenu` 组件，但 items 由 `getSearchResultContextMenuItems(hit)` 生成。

## 8. 验收标准

### 8.1 P0 验收

1. 搜索 `高考` 后，结果文件行出现一个纯 icon 的“在文件目录中展示”按钮。
2. 鼠标 hover 该 icon，浏览器原生 tooltip 文案为：`在文件目录中展示`。
3. 点击该 icon 后：
   - 退出搜索结果列表。
   - 文件树展开到该文件所在目录。
   - 目标文件被选中。
   - 目标文件行滚动到可见区域。
4. 右键搜索结果文件行，菜单只显示：
   - `预览`
   - `在文件目录中展示`
   - `打开所在文件夹`
5. 对目录树未加载的深层搜索结果右键，菜单仍能显示并执行。
6. 点击 `file_indexer.rs` 的 1039 行命中，右侧预览跳到 1039 行附近。
7. 在右侧已经打开 `file_indexer.rs` 的情况下，再点击同文件 1043 行命中，右侧重新跳到 1043 行附近。
8. 点击文件 header 主体时能预览文件。点击展开箭头时只展开/折叠，不打开文件。

### 8.2 P1 验收

1. 当前点击的命中行在左侧结果列表有可见选中态。
2. 后台 refresh 搜索结果时，不重置用户手动折叠的文件。
3. Markdown 命中点击后进入可定位的源码/编辑视图，不停留在无法定位的 rendered preview。
4. active target 在 refresh 后仍存在时保持选中态，不存在时清空。

## 9. 测试与验证

### 9.1 单元 / DOM 测试

| 已落地测试 | 目标 |
|---|---|
| `FileSearchResults` 渲染 reveal icon | icon button 存在，`title="在文件目录中展示"`，点击只触发 reveal，不触发展开。 |
| `FileSearchResults` header click split | arrow 点击 toggle，filename/body 点击 open first match。 |
| `FileSearchResults` right click | 右键回调拿到完整 hit 或 path，可生成 path-based 菜单。 |
| reveal path helper | path 到 ancestors 计算正确，root-level file 正确。 |
| expandedFiles merge helper | 新 query 默认展开，同 query refresh 保留手动状态。 |
| path normalization / active target helper | Windows 反斜杠 path 进入搜索导航状态前归一化，并可正确保留 active target。 |
| `WorkspaceTreeViewport` reveal request | 找到目标 row 后调用 Virtuoso `scrollToIndex`，并通过 `onRevealHandled` 消费请求。 |

已落地测试文件：

- `src/renderer/utils/workspaceSearchNavigation.test.ts`
- `src/renderer/components/search/FileSearchResults.test.tsx`
- `src/renderer/components/workspace-tree/WorkspaceTreeViewport.test.tsx`

### 9.2 Monaco / preview 验证

Monaco 本体没有在 jsdom 中完整 mount 做组件级断言；本期通过代码路径、typecheck、lint、build 和交互验收覆盖以下行为：

- 新 `focusTarget` 对象会调用 `revealLineInCenter` 和 `setPosition`。
- 相同 `lineNumber` 但新的 focus event 仍会重新 reveal。
- focus target 为空时不触发 reveal。

### 9.3 自动验证命令

实现提交前已通过：

- `npm run test:unit`
- `npm run test:dom`
- `npm run typecheck`
- `npm run lint`
- `npm run build:web`

### 9.4 手工验收

必须在 Tauri 或可用 split-view 环境验证：

1. 用户截图场景：搜索 `高考`，点击 `file_indexer.rs` 的 1039 / 1043 命中，右侧每次都跳转。
2. 点击红框新增 icon，回到文件树并选中该文件。
3. 对深层未展开目录中的文件执行“在文件目录中展示”。
4. 右键菜单三项都可执行。
5. 正在编辑文件时点击搜索结果定位，不丢编辑内容，不触发不必要 remount。

## 10. 风险与约束

| 风险 | 处理 |
|---|---|
| 通过 remount 解决定位会丢编辑状态或 live reload 状态。 | 禁止作为主方案，必须用 focus target 驱动 Monaco 已有实例。 |
| 深层路径 reveal 可能需要多轮 async expand。 | 使用 ancestor loop + `dirExpand`，失败时明确 toast。 |
| Virtuoso 不能直接用 DOM scrollTop 稳定定位。 | 给 `WorkspaceTreeViewport` 增加 `scrollToIndex` 能力。 |
| Markdown rendered preview 行号不可靠。 | 本期切源码/编辑视图定位，不做 rendered DOM 映射。 |
| 搜索结果菜单复用普通树菜单会引入删除/重命名等高风险项。 | 搜索结果菜单单独生成短菜单。 |
| Windows 搜索 hit 可能携带反斜杠路径。 | `normalizeFileSearchHits` 在进入 UI state 前统一归一化。 |
| 旧 reveal 请求在树重渲染后回放。 | `onRevealHandled` 消费请求；新 reveal 到达会取消旧请求。 |

## 11. 实施结果

1. Done：定义 `FilePreviewFocusTarget` 并贯通 `DirectoryPanel -> Chat/FileActionContext -> FilePreviewModal -> MonacoEditor`。
2. Done：修 Monaco 已打开实例响应新的 focus target。
3. Done：调整 `FileSearchResults` header click 分区，启用 `onFileClick`。
4. Done：新增 reveal icon 和 native title。
5. Done：实现 reveal-in-tree，包括 path ancestor expand、cancel/missing 区分、Virtuoso scroll-to-path、请求消费。
6. Done：实现搜索结果 path-based 三项右键菜单。
7. Done：增加 active search target 选中态。
8. Done：优化 refresh 后 expandedFiles 合并策略。
9. Done：Markdown 命中点击切编辑/源码视图定位。
10. Done：补充 Windows path normalization 和同一行重复 focus 的回归护栏。

## 12. 成功标准

本 PRD 已完成。工作区搜索结果具备“搜索、打开、定位、回到文件树、打开所在文件夹”的闭环体验。用户不需要猜哪个区域能点，也不会遇到“搜到了但右侧不跳”“右键没反应”“想回目录树还要手动找”的断点。
