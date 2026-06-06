---
type: prd
status: draft
created: 2026-06-06
updated: 2026-06-06
scope: "Performance architecture round 2: streaming markdown, tab render ownership, background tab colding, trace coverage completion"
source_prds:
  - specs/prd/prd_0.2.31_frontend_perf_round1.md
  - specs/prd/prd_0.2.31_global_perf_observability_and_stability_contract.md
  - specs/prd/prd_0.2.31_workspace_search_result_navigation.md
source_research:
  - specs/research/0605_research_frontend_perf_architecture_deep_review.md
  - specs/research/0605_research_myagents_global_perf_stability_architecture_review.md
branch: dev/0.2.32
---

# PRD 0.2.32 - 性能与架构 Round 2

## 1. 背景

0.2.31 已完成第一轮性能优化和全局稳定性基础设施：

- 前端入口 bundle 从约 7.5MB 降到约 640KB。
- Task Center 从逐实例 fetch/cache 收敛为单 app-level store。
- 输入框流式重渲染的两个 memo breaker 已修复。
- Renderer / Rust / Node 的 perf trace 基础已接入统一日志。
- Workspace Search cold rebuild、搜索结果导航、SessionStore line count、Runtime detect/model list 去重、Search true tail-read、Sidecar lifecycle contract tests 已落地。

本 PRD 承接 0.2.31 明确留下的遗留项。目标不是再做一轮无边界大重构，而是把剩余性能瓶颈按 owner/scope 继续归位，并补齐观测覆盖缺口。

## 2. 当前 Ground Truth

| 领域 | 当前事实 |
|---|---|
| 新建 Tab / 首屏 | P0 实测 `new_tab_reveal -> tab_shell_painted` 约 54ms，Launcher shell-first 已被 0.2.31 度量门控判定不做。 |
| 输入框流式 | `SimpleChatInput` 每 token 重渲染的两个直接原因已修：`AgentStatusPanel(messages)` 和 `globallyVisiblePlugins` identity。 |
| 流式消息区 | Chat 外壳仍会随 streaming commit 重渲染；大头预计在长 Markdown / 单大块内容的 parse/render。 |
| TabContext | 0.2.31 只做外科式修复，未做完整高频 streaming slice 与低频 shell/actions 的 owner 拆分。 |
| 后台 Tab | 多 Tab 重度场景仍缺明确 colding 策略。后台 Tab 不能影响 active Tab，但协议事件、未读、turn complete、日志等仍要保持。 |
| Trace 覆盖 | 已有 `sidecar_boot` / `turn` / `runtime` / `storage_io` / Search watcher / Cron。缺口主要是 IM enqueue/buffer replay、Plugin Bridge health/restart，以及 perf trace TS 类型 single source of truth。 |
| 文档状态 | `prd_0.2.31_global_perf_observability_and_stability_contract.md` 仍是 `draft`，但代码已落地大量内容，需要状态回填。 |

## 3. 目标

1. 降低 streaming Markdown 的每帧成本，尤其是长单块 Markdown 和代码块场景。
2. 把 Tab 渲染所有权继续从宽 `Chat/useTabState` 迁移到窄 slice 订阅，减少高频状态对低频 shell 的影响。
3. 给后台 Tab 建立最小冷化策略，让后台流式不拖慢 active Tab，同时不破坏协议和通知。
4. 补齐全局 perf trace 覆盖缺口，让 IM / Plugin Bridge / Runtime / storage / turn 的性能路径可 grep。
5. 收敛 perf trace 类型和文档状态，降低后续 AI / 开发者基于过期 PRD 做错判断的风险。

## 4. 非目标

- 不重新做 Launcher shell-first。0.2.31 已用数据判定不做。
- 不改变聊天、搜索、文件预览、任务中心、IM、Cron 的用户功能语义。
- 不做后台 QoS 调度器、Cron execution ledger、IM channel actor 化。
- 不做完整 RuntimeCapabilityService，本期只做低风险 detect/model list trace 与入口收敛补强。
- 不引入外部 metrics 服务、OpenTelemetry、dashboard 或新持久化目录。
- 不为了性能跳过 file lock、session lock、workspace path safety、Sidecar Owner 模型。

## 5. 范围与优先级

| 优先级 | 项 | 状态 |
|---|---|---|
| P0 | 流式 Markdown 增量化 / post-stream upgrade 方案与实现 | 本期 IN |
| P0 | MessageList / Chat streaming render ownership 收窄 | 本期 IN，与 Markdown 配对做 |
| P0 | 补齐 IM / Plugin Bridge perf trace 覆盖 | 本期 IN |
| P0 | 回填 0.2.31 global perf PRD 状态 | 本期 IN |
| P1 | 后台 Tab 最小冷化策略 | 本期 IN，但必须先建立 guard，不做激进 unmount |
| P1 | perf trace TS 类型 single source of truth | 本期 IN |
| P1 | Node admin runtime detection cache / forceFresh helper | 本期 IN，范围受控 |
| P2 | CSS compositor / 折叠 exit polish | 本期可选，按具体卡点逐点做 |
| P3 | 完整 Controller/View/Store 分离 | 本期 OUT，作为后续阶段 |

## 6. 需求详情

### 6.1 P0 - Streaming Markdown 成本收敛

#### 问题

0.2.31 已证明输入框不再被 streaming token 打穿，但消息内容本身仍可能在长 Markdown / 长代码块 / 单大块输出时重复 parse 和 render。当前下一轮最大的可感收益在这里。

#### 目标

- Streaming 中减少对稳定历史块的重复 Markdown parse。
- 对正在增长的最后一块采用增量策略或轻量 preview 策略。
- Turn 完成后再升级为完整 Markdown 渲染，保证最终视觉与现有一致。

#### 约束

- 不改变最终 Markdown / code block / Mermaid / KaTeX 输出语义。
- 不引入“先错误渲染再闪变”的明显 C-过渡。
- 不破坏现有复制、引用、搜索、代码块操作、工具卡渲染。
- 不把 Markdown rendered preview 的源码行号映射塞进本期。

#### 建议实现方向

1. 先用 perf mark / React Profiler 确认 streaming commit 中 Markdown parse 的实际耗时。
2. 将 message 内容切分为稳定 block 与 active block。
3. 稳定 block 用 memo key 固化，active block 只渲染最后增长区域。
4. Turn complete 后执行一次 full render reconcile，确保最终 DOM 与现有路径一致。
5. 对 Mermaid / KaTeX / heavy code highlighting 采用 post-stream upgrade 或 idle upgrade，不在每个 delta 同步重跑。

#### 验收

- 长 Markdown streaming 时 active Tab 输入、滚动、搜索浮层不明显掉帧。
- Turn 完成后的 Markdown / code / Mermaid / KaTeX 最终渲染与现有行为一致。
- `npm run test:dom` 覆盖 Markdown block memo / post-stream upgrade 的关键不变量。

### 6.2 P0 - Chat Streaming Render Ownership 收窄

#### 问题

0.2.31 未做完整 TabContext 三层拆分。当前 `Chat` 外壳仍消费宽 `useTabState`，高频 streaming commit 仍会触达过宽的 React surface。

#### 目标

- 让 MessageList 或 streaming view 直接消费高频 streaming slice。
- 让 Chat shell、输入区、标题栏、右侧面板等低频区域尽量不随每个 streaming commit 重渲染。
- 保持 `useTabState` / `useTabApi` / `useTabActive` 既有边界，不另起全局状态库。

#### 约束

- 不破坏 phantom row、防抖 reveal、queue、permission、plan mode、abort、retry、fork、search find 等现有流式正确性。
- 不让状态撕裂：消息更新、thinking 状态、tool 状态、输入 disabled 状态必须保持一致。
- 不通过 deep memo comparator 堆复杂度作为主方案。

#### 建议实现方向

1. 复核 `TabProvider` 当前 context value 的高频字段。
2. 抽 `useTabStreamingState` 或等价 `useSyncExternalStore` slice，只暴露 MessageList 必需的高频状态。
3. Chat shell 改消费低频 state/actions。
4. 对 `MessageList` props 做 identity 审计，避免把新 slice 又通过数组重组打穿。
5. 用 render-count / perf mark 验证 Chat shell 在 streaming 中趋于常数级重渲染。

#### 验收

- Streaming 期间 Chat shell render 次数显著下降。
- MessageList 仍按现有节奏 reveal，滚动位置和自动跟随行为不回归。
- 输入区不被 token commit 打穿。

### 6.3 P0 - 全局 Perf Trace 覆盖补齐

#### 问题

0.2.31 已建立 trace 基础，但 background coverage 仍不完整。当前可见覆盖包括 Sidecar、turn、runtime、storage、Search watcher、Cron。缺口主要是：

- IM enqueue / buffer replay。
- Plugin Bridge health / restart。
- trace schema 在 TS 侧仍存在 server 本地副本。

#### 目标

- 让用户反馈 IM 慢、IM 消息积压、Plugin Bridge 重启、OpenClaw channel 不稳定时，能从 unified log 看到 trace。
- 保持 trace 是轻量结构化日志，不记录 prompt、token、secret。

#### 必须埋点

| Trace | Phase | 位置 |
|---|---|---|
| `background_job` | `im_enqueue` | Rust IM message admission / router enqueue 主路径 |
| `background_job` | `im_buffer_replay` | Rust IM buffered request replay |
| `background_job` | `plugin_bridge_health` | Plugin Bridge health check |
| `background_job` | `plugin_bridge_restart` | Plugin Bridge restart / respawn |

#### 验收

```bash
rg "\\[perf\\].*trace=background_job.*phase=im_enqueue" ~/.myagents/logs/unified-*.log
rg "\\[perf\\].*trace=background_job.*phase=im_buffer_replay" ~/.myagents/logs/unified-*.log
rg "\\[perf\\].*trace=background_job.*phase=plugin_bridge" ~/.myagents/logs/unified-*.log
```

日志不得包含用户消息正文、IM token、plugin config secret。

### 6.4 P0 - 0.2.31 Global PRD 状态回填

#### 问题

`prd_0.2.31_global_perf_observability_and_stability_contract.md` 仍是 `status: draft`，但其核心工程项已大量落地。

#### 目标

- 将 0.2.31 global PRD 更新为真实状态。
- 标明哪些 R 项已完成，哪些 trace coverage 被 0.2.32 继承。
- 避免后续阅读者误以为 0.2.31 全局 PRD 未执行。

#### 验收

- 文档状态不再误导。
- 0.2.32 本 PRD 与 0.2.31 global PRD 的边界清楚。

### 6.5 P1 - 后台 Tab 最小冷化

#### 问题

多 Tab 重度场景下，后台 Tab 的 streaming/render work 可能继续影响 active Tab。0.2.31 没有处理这一层。

#### 目标

- 后台 Tab 降低 render commit 成本。
- 后台 Tab 仍保留协议状态：SSE、turn complete、unread、notification、task/IM side effects 不丢。
- Tab 切回前台时能无缝补齐最终 UI。

#### 约束

- 不关闭后台 Sidecar，不改变 Owner 模型。
- 不 gate 掉持久化、terminal event、unread、history metadata。
- 不让后台 Tab 切回后出现旧消息、丢 tool card、丢 generated attachment。

#### 建议实现方向

1. 先只 gate React render surface，不 gate protocol/data ingestion。
2. 后台 Tab 中 MessageList 可冻结可见 DOM，数据继续进入 store/ref。
3. 前台恢复时做一次 reconcile。
4. 用 `isActive` 和 existing tab active context，不新建调度器。

### 6.6 P1 - Perf Trace 类型 Single Source of Truth

#### 问题

`src/shared/perfTrace.ts` 已存在，但 `src/server/utils/perf-trace.ts` 仍有一份本地 `PerfTraceEvent` 类型副本。

#### 目标

- `PerfTraceEvent` / `PerfTraceName` / `PerfTraceStatus` 的 TS 类型统一从 `src/shared/perfTrace.ts` 导出。
- Server 只保留 Node-specific `nowMs` / `elapsedMs` / `emitPerfTrace` runtime helper。
- Renderer / Server 的字段词汇不再靠人工同步。

#### 验收

- `src/server/utils/perf-trace.ts` 不再重复定义 trace 类型。
- `npm run typecheck` 通过。
- 现有 perf log 行格式不变。

### 6.7 P1 - Node Admin Runtime Detect Cache

#### 问题

Rust `cmd_detect_runtimes` 已有 30s TTL + single-flight。Node admin API 侧仍存在直接 `getExternalRuntime(rt).detect()` 调用。PRD 0.2.31 将其列为 optional，本期收敛为小范围 helper。

#### 目标

- 新增 `detectRuntimeCached(runtimeType, opts?)` 或等价 helper。
- 默认 TTL 30s。
- `opts.forceFresh === true` 绕过缓存，供 diagnose 使用。
- `runtime diagnose` 不被缓存掩盖真实问题。

#### 验收

- list / describe / validate 类展示路径可以走缓存。
- diagnose path force fresh。
- 不改变 runtime protocol 和真实 send turn 的错误处理。

### 6.8 P2 - CSS Compositor 与折叠 Exit Polish

#### 问题

用户曾反馈“有些交互没画好”。0.2.31 没有系统处理 CSS 合成层、折叠过渡、短 exit 保留。

#### 目标

- 只针对有实测卡顿或明显视觉跳变的组件逐点处理。
- 优先使用 transform / opacity / compositor-friendly CSS。
- 折叠类组件避免立即 unmount 导致的断帧，但不长期挂载重组件。

#### 约束

- 不做全局视觉 redesign。
- 不引入装饰性动画。
- 不新增复杂 motion framework。

## 7. 执行顺序

1. R0 文档状态回填：更新 0.2.31 global PRD 状态，确认 0.2.32 边界。
2. R1 trace coverage：IM / Plugin Bridge background trace，低风险先做。
3. R2 perf trace TS 类型 single source of truth。
4. R3 Streaming Markdown POC + profiler 验证。
5. R4 Chat streaming slice / render ownership 收窄。
6. R5 后台 Tab 最小冷化。
7. R6 Node admin runtime detect cache。
8. R7 CSS compositor polish，仅在有可复现卡点时做。

## 8. 测试要求

必须按改动范围补测试：

- Markdown / streaming：`npm run test:dom`，必要时新增 block memo / post-stream upgrade 组件测试。
- Tab state / hooks：`npm run test:unit` + targeted hook/helper tests。
- Runtime detect helper：`npm run test:unit`，覆盖 cache hit、miss、forceFresh、rejection cleanup。
- Rust IM / Plugin Bridge trace：能抽纯 helper就测 helper；涉及 Rust 逻辑需跑 targeted `cargo test`，最终跑 `cd src-tauri && cargo test`。
- 文档状态和 trace type 收敛：`npm run typecheck` + `npm run lint`。

最终验收至少运行：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:dom
cd src-tauri && cargo test
```

## 9. 手工验收

1. 长 Markdown / 长代码块 streaming，观察输入、滚动、搜索浮层是否顺滑。
2. 多 Tab 同时存在，一个后台 Tab streaming，active Tab 输入和切换不明显卡顿。
3. 触发 IM 消息和 buffer replay，unified log 可 grep background trace。
4. 启动 OpenClaw / Plugin Bridge channel，health/restart 可 grep background trace。
5. 运行 runtime list / diagnose，确认 list 可缓存、diagnose force fresh。
6. 复查最终 Markdown / tool card / generated attachment / search find 没有交互回归。

## 10. 风险与停止条件

遇到以下情况必须停止扩展范围，另立 PRD：

- 需要改变 Sidecar Owner 模型。
- 需要改变 external runtime wire protocol。
- 需要新增后台 QoS 调度器。
- 需要重写整个 `TabProvider` 或 `Chat` 页面。
- 需要为 Markdown 引入第二套长期并存的渲染协议。
- 需要新增外部 metrics 服务或 dashboard。

## 11. 成功标准

本 PRD 完成后：

- 用户在长 streaming 场景下的输入、滚动、Tab 切换体感明显更稳。
- 后台 Tab 不再无谓拖慢 active Tab。
- IM / Plugin Bridge 的慢与不稳定可以从 unified log 中直接定位。
- perf trace TS 类型不再人工双写。
- 0.2.31 与 0.2.32 的 PRD 状态和边界清晰，不再让后续开发基于过期状态判断。
