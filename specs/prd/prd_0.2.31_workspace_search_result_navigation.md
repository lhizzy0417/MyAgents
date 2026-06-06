---
type: prd
status: draft
created: 2026-06-06
updated: 2026-06-06
scope: "Workspace file search result navigation, reveal-in-tree, result context menu, preview focus"
branch: dev/0.2.31
---

# PRD 0.2.31 - 工作区搜索结果导航体验

## 1. 背景

工作区文件搜索的索引冷重建问题已在 `9c7e4aa5 fix: avoid cold workspace search rebuilds` 修复。当前搜索可以返回结果，但用户在结果区继续操作时仍存在体验断点：

1. 搜索结果能显示命中行，但点击结果后右侧预览不一定落到对应命中位置。
2. 搜索结果文件行缺少“一键回到文件目录并选中文件”的入口。
3. 搜索结果文件行右键菜单不完整，且当前实现依赖目录树已加载节点，目录没加载时会无响应。
4. 搜索结果列表没有当前命中选中态，用户点击后无法确认右侧预览对应哪一条。

本 PRD 的目标是把“搜索结果”从静态结果列表升级成稳定的文件导航入口：用户搜到文件后，可以预览、跳到命中行、在文件树里定位、打开所在文件夹，并且这些行为在 split view、已打开同文件、目录未加载等场景下都可靠。

## 2. 代码事实确认

| 事实 | 代码证据 |
|---|---|
| 工作区搜索走 Tauri IPC 到 Rust `SearchEngine`，不经 Sidecar。 | `src/renderer/api/searchClient.ts` 调用 `cmd_search_workspace_files`；`specs/tech_docs/search_architecture.md` 已说明搜索是 Tauri-only。 |
| 搜索结果结构已包含 `FileSearchHit.matches[].lineNumber` 和 highlights。 | `src/renderer/api/searchClient.ts` 中 `FileMatchLine`。 |
| `DirectoryPanel` 搜索先返回当前结果，再后台 refresh index。 | `src/renderer/components/DirectoryPanel.tsx:402-460`。 |
| `FileSearchResults` 文件 header 当前只展开/收起，不打开文件。 | `src/renderer/components/search/FileSearchResults.tsx:89-94`。 |
| `FileSearchResults` 的 `onFileClick` prop 已存在但未使用。 | `src/renderer/components/search/FileSearchResults.tsx:31` 解构为 `_onFileClick`。 |
| 命中行点击会把 `lineNumber` 传回 `DirectoryPanel`。 | `src/renderer/components/search/FileSearchResults.tsx:138`。 |
| `DirectoryPanel` 会把 `initialLineNumber` 写进 preview file data。 | `src/renderer/components/DirectoryPanel.tsx:942-950`。 |
| split view 会保存并传递 `initialLineNumber`。 | `src/renderer/pages/Chat.tsx:414-427`、`src/renderer/pages/Chat.tsx:3746-3755`。 |
| `FilePreviewModal` 会把 `initialLineNumber` 传给 `MonacoEditor`。 | `src/renderer/components/FilePreviewModal.tsx:1022-1029`、`:1069-1077`。 |
| `MonacoEditor` 只在 mount callback 内处理 `initialLineNumber`，同一文件已打开时 prop 变化不会再次 reveal。 | `src/renderer/components/MonacoEditor.tsx:368-373`。 |
| 普通文件树右键菜单已有“预览”“打开所在文件夹”等动作。 | `src/renderer/components/DirectoryPanel.tsx:1822-1851`。 |
| 搜索结果右键当前尝试在已加载树里反查 node；找不到时不会打开菜单。 | `src/renderer/components/DirectoryPanel.tsx:2130-2142`。 |
| 文件树使用 `useWorkspaceTreeModel` 维护 open paths 和 visible rows，`WorkspaceTreeViewport` 当前没有外部 scroll-to-path API。 | `src/renderer/components/workspace-tree/useWorkspaceTreeModel.ts`、`WorkspaceTreeViewport.tsx`。 |

## 3. 目标

### 3.1 用户目标

用户在工作区搜索结果里应能完成以下操作：

1. 点击命中行后，右侧预览稳定跳到该命中行。
2. 同一个文件已经打开时，再点击另一个命中行，也会重新定位，不停留在旧位置。
3. 点击文件结果行的“在文件目录中展示”图标后，退出搜索模式，文件树展开到该文件所在目录，并选中文件。
4. 右键搜索结果文件行，可以直接执行“预览”“在文件目录中展示”“打开所在文件夹”。
5. 结果列表能看出当前选中的文件或命中行。

### 3.2 工程目标

1. 搜索结果导航必须建立在现有 `DirectoryPanel`、`FilePreviewModal`、`MonacoEditor`、`WorkspaceTreeViewport` 上，不新增独立文件树或平行预览系统。
2. 文件 IO 仍走 `useWorkspaceFileService(workspacePath)` 和 Tauri `cmd_workspace_*`，不得走 Sidecar HTTP。
3. 不改搜索索引行为，不改 Rust 查询语义。
4. 不用 remount 预览器作为主要定位手段，避免破坏编辑状态、autosave、live reload、滚动状态。

## 4. 范围

### 4.1 本期 IN

| 优先级 | 需求 |
|---|---|
| P0 | 新增搜索结果文件行“在文件目录中展示”图标按钮，hover 原生 title 为“在文件目录中展示”。 |
| P0 | 搜索结果文件行右键自定义菜单：`预览`、`在文件目录中展示`、`打开所在文件夹`。 |
| P0 | “在文件目录中展示”退出搜索模式，展开祖先目录，选中目标文件，并滚动到可见区域。 |
| P0 | 点击搜索命中行后，右侧预览对每一次点击都跳到对应行，即使同一文件已打开。 |
| P0 | 文件 header 点击语义修正：文件名区域打开文件；展开箭头只负责展开/折叠。文件名命中但无内容行时也能打开文件。 |
| P1 | 搜索结果列表增加当前 active 文件/命中行选中态。 |
| P1 | 后台 refresh 更新结果时保留用户手动展开/折叠状态，不无条件重置。 |
| P1 | Markdown 搜索命中点击的定位策略明确化：优先切到编辑/源码视图定位，避免 rendered markdown 行映射误差。 |
| P1 | 搜索结果菜单 path-based 化，不依赖目录树节点已加载。 |

### 4.2 本期 OUT

- 不改 Tantivy / jieba / direct scan fallback。
- 不增加全文搜索过滤器、正则搜索、大小写开关。
- 不做全局多文件 replace。
- 不重构整个 `DirectoryPanel`。
- 不把 Markdown rendered preview 做源码行号映射。
- 不改变普通文件树已有右键菜单的完整功能集合。

## 5. 交互需求

## 5.1 搜索结果文件行布局

现状文件行包含：

- 展开箭头
- 文件图标
- 文件名
- dirname
- match count badge

新增：

- 在 dirname 和 match count badge 之间增加一个纯 icon button。
- 按钮只显示 icon，无文字。
- hover 使用原生 `title="在文件目录中展示"`。
- 推荐 icon：优先使用 lucide 的定位/展示类图标，例如 `LocateFixed` 或等价语义图标。实际实现时以已安装 `lucide-react` 导出为准。
- 按钮尺寸保持紧凑，不挤压文件名。建议命中区域约 24px，视觉 icon 14px。
- 按钮点击必须 `stopPropagation()`，不能触发展开/打开文件。

### 行点击拆分

文件 header 行需要拆成两个可理解区域：

| 区域 | 行为 |
|---|---|
| 展开箭头 | 展开/折叠该文件下的 match lines。 |
| 文件名 / 路径主体 | 打开文件。若该文件有内容命中，默认定位到第一条命中行；若只有文件名命中，则打开文件顶部。 |
| “在文件目录中展示”icon | 退出搜索并在文件树中选中该文件。 |
| match count badge | 不单独承载主要动作，随文件主体点击或保持无交互均可，但不能抢占定位 icon。 |

## 5.2 “在文件目录中展示”

触发来源：

1. 搜索结果文件行 icon button。
2. 搜索结果文件行右键菜单。

行为：

1. 关闭搜索模式：`setIsSearchMode(false)`。
2. 清理搜索 UI 状态：搜索输入可以保留当前 query 或清空，建议保留 `searchQuery`，方便用户再次点搜索图标时恢复，但结果列表不显示。
3. 找到目标 path 的所有祖先目录。
4. 逐级打开祖先目录。若祖先目录还没加载，调用现有 `fileService.dirExpand({ path })` 加载后再继续。
5. 选中目标文件：`setSelectedNodes([targetNode])`，更新 `lastClickedPathRef.current`。
6. 滚动文件树，使目标行进入可见区域，建议居中或接近中间。
7. 如果文件已不存在或目标 path 无法加载，显示 toast：`文件不存在或已删除`，并保持搜索模式不强行退出，或退出后给出明确提示。推荐失败时不退出搜索模式。

实现约束：

- 不新增后端命令。现有 `dirTree` + `dirExpand` 足够按路径逐级加载。
- 需要给 `WorkspaceTreeViewport` 增加可控 scroll-to-path 能力。建议由 `DirectoryPanel` 传入一个 `revealRequest`，`WorkspaceTreeViewport` 在 `visibleRows` 中找到 path 后通过 Virtuoso `scrollToIndex` 滚动。
- 不能通过直接 DOM query 和手动设置 scrollTop 作为主方案。Virtuoso 列表应通过自身 API 滚动。
- 成功定位后文件树选中态应与普通点击文件一致。

## 5.3 搜索结果右键菜单

搜索结果文件行右键菜单固定为：

1. `预览`
2. `在文件目录中展示`
3. `打开所在文件夹`

行为定义：

| 菜单项 | 行为 |
|---|---|
| 预览 | 打开右侧 split preview 或 modal。若右键目标有第一条内容命中，则定位第一条内容命中行；若无内容命中，则打开文件顶部。 |
| 在文件目录中展示 | 执行 5.2 的 reveal-in-tree。 |
| 打开所在文件夹 | 调用现有 `fileService.openInFinder({ path })`，行为与普通文件树文件菜单一致。 |

约束：

- 搜索结果菜单必须 path-based，不允许依赖 `findInTree(directoryInfo.tree.children, path)` 成功后才显示。
- 菜单只对搜索结果文件行出现。命中行右键可以复用同一菜单，目标 path 是该命中所属文件。
- 不提供删除、重命名、引用、打开默认应用等普通树菜单项。本期搜索结果菜单保持短菜单，降低误操作。

## 5.4 搜索命中行定位

当前 `initialLineNumber` 是一次性初始值。需要升级成“每次点击都生效”的导航事件。

推荐数据模型：

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
4. `MonacoEditor` 在已 mount 的 editor 上监听 `focusTarget.requestId` 变化，执行：
   - `revealLineInCenter(lineNumber)`
   - `setPosition({ lineNumber, column })`
   - 临时 decoration 高亮当前行或命中范围
5. 不能只依赖 `initialLineNumber` prop，也不能通过改变 React key 强制 remount Monaco。

### Markdown 文件定位

Markdown 默认 rendered preview 无可靠源码行号映射。本期推荐策略：

- 点击搜索命中行打开 Markdown 时，如果文件可编辑，切换到编辑视图并用 Monaco 定位源码行。
- 如果不可编辑或无法进入 Monaco，则只打开文件，并允许后续 P2 再做 rendered preview 的近似定位。
- 不做 rendered markdown DOM 到源码行的复杂映射。

## 5.5 当前选中态

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

## 5.6 Refresh 与展开状态

当前 refresh 后会 `setExpandedFiles(new Set(refreshed.hits.map(h => h.path)))`。这会覆盖用户手动折叠/展开。

P1 要求：

- 新 query 的首次结果默认展开全部命中文件。
- 同 query 后台 refresh 只合并结果，不重置用户手动折叠状态。
- 如果新增命中文件，默认展开新增文件。
- 如果命中文件消失，从 `expandedFiles` 中移除。

## 6. 技术方案

### 6.1 主要变更文件

| 文件 | 变更 |
|---|---|
| `src/renderer/components/search/FileSearchResults.tsx` | 增加 reveal icon、拆分 header click 区域、支持 active target、右键回调传 hit。 |
| `src/renderer/components/DirectoryPanel.tsx` | 新增 reveal-in-tree handler、search result path-based menu、focus target 生成、active target 状态。 |
| `src/renderer/components/workspace-tree/WorkspaceTreeViewport.tsx` | 增加基于 Virtuoso 的 scroll-to-path request。 |
| `src/renderer/components/FilePreviewModal.tsx` | 把 `initialLineNumber` 迁移或兼容为 focus target。 |
| `src/renderer/components/MonacoEditor.tsx` | 支持已 mount 后响应 focus target 变化并更新 decorations。 |
| `src/renderer/pages/Chat.tsx` | split view / fullscreen preview state 透传 focus target。 |
| `src/renderer/context/FileActionContext.tsx` | 如复用预览协议，需要兼容 focus target。 |

### 6.2 Reveal-in-tree 算法建议

输入：workspace-relative file path，例如 `src-tauri/src/search/file_indexer.rs`。

流程：

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

注意：

- 不能只 `openPath` 不 `dirExpand`。深层目录可能没加载，`visibleRows` 中根本没有目标节点。
- `dirExpand` 已是 workspace-safe Rust invoke，不需要新命令。
- 如果中途某个 ancestor 不存在，停止并提示。

### 6.3 Search result context menu state

当前 `ContextMenuState` 只服务普通树节点。建议新增搜索结果菜单 state，避免把不存在于树里的 fake node 塞给普通树菜单：

```ts
type SearchResultContextMenuState = {
  x: number;
  y: number;
  hit: FileSearchHit;
};
```

渲染时复用现有 `ContextMenu` 组件，但 items 由 `getSearchResultContextMenuItems(hit)` 生成。

## 7. 验收标准

### 7.1 P0 验收

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

### 7.2 P1 验收

1. 当前点击的命中行在左侧结果列表有可见选中态。
2. 后台 refresh 搜索结果时，不重置用户手动折叠的文件。
3. Markdown 命中点击后进入可定位的源码/编辑视图，不停留在无法定位的 rendered preview。
4. active target 在 refresh 后仍存在时保持选中态，不存在时清空。

## 8. 测试要求

### 8.1 单元 / DOM 测试

| 测试 | 目标 |
|---|---|
| `FileSearchResults` 渲染 reveal icon | icon button 存在，`title="在文件目录中展示"`，点击只触发 reveal，不触发展开。 |
| `FileSearchResults` header click split | arrow 点击 toggle，filename/body 点击 open first match。 |
| `FileSearchResults` right click | 右键回调拿到完整 hit 或 path，可生成 path-based 菜单。 |
| `DirectoryPanel` search menu items | 搜索结果菜单包含且仅包含 3 项。 |
| reveal path helper | path 到 ancestors 计算正确，root-level file 正确。 |
| expandedFiles merge helper | 新 query 默认展开，同 query refresh 保留手动状态。 |
| focus target requestId | 连续点击同文件同一行也会生成新 requestId。 |

### 8.2 Monaco / preview 测试

如果 Monaco 难以在 jsdom 中完整 mount，至少抽出可测试 helper，并用 mock editor 验证：

- `focusTarget.requestId` 变化会调用 `revealLineInCenter` 和 `setPosition`。
- 相同 `lineNumber` 但不同 `requestId` 仍会重新 reveal。
- focus target 为空时不触发 reveal。

### 8.3 手工验收

必须在 Tauri 或可用 split-view 环境验证：

1. 用户截图场景：搜索 `高考`，点击 `file_indexer.rs` 的 1039 / 1043 命中，右侧每次都跳转。
2. 点击红框新增 icon，回到文件树并选中该文件。
3. 对深层未展开目录中的文件执行“在文件目录中展示”。
4. 右键菜单三项都可执行。
5. 正在编辑文件时点击搜索结果定位，不丢编辑内容，不触发不必要 remount。

## 9. 风险与约束

| 风险 | 处理 |
|---|---|
| 通过 remount 解决定位会丢编辑状态或 live reload 状态。 | 禁止作为主方案，必须用 focus target 驱动 Monaco 已有实例。 |
| 深层路径 reveal 可能需要多轮 async expand。 | 使用 ancestor loop + `dirExpand`，失败时明确 toast。 |
| Virtuoso 不能直接用 DOM scrollTop 稳定定位。 | 给 `WorkspaceTreeViewport` 增加 `scrollToIndex` 能力。 |
| Markdown rendered preview 行号不可靠。 | 本期切源码/编辑视图定位，不做 rendered DOM 映射。 |
| 搜索结果菜单复用普通树菜单会引入删除/重命名等高风险项。 | 搜索结果菜单单独生成短菜单。 |

## 10. 实施顺序

1. P0-1：定义 preview focus target 类型并贯通 `DirectoryPanel -> Chat split view -> FilePreviewModal -> MonacoEditor`。
2. P0-2：修 Monaco 已打开实例响应 focus target 变化。
3. P0-3：调整 `FileSearchResults` header click 分区，启用 `onFileClick`。
4. P0-4：新增 reveal icon 和 native title。
5. P0-5：实现 reveal-in-tree，包括 path ancestor expand 和 Virtuoso scroll-to-path。
6. P0-6：实现搜索结果 path-based 三项右键菜单。
7. P1-1：增加 active search target 选中态。
8. P1-2：优化 refresh 后 expandedFiles 合并策略。
9. P1-3：Markdown 命中点击切编辑/源码视图定位。

## 11. 成功标准

本 PRD 完成后，工作区搜索结果应具备“搜索、打开、定位、回到文件树、打开所在文件夹”的闭环体验。用户不需要猜哪个区域能点，也不会遇到“搜到了但右侧不跳”“右键没反应”“想回目录树还要手动找”的断点。
