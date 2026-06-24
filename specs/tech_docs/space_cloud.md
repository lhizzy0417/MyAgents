# MyAgents Cloud Space 架构

## 定位

Cloud Space 是桌面端连接 MyAgents 官方/团队空间的客户端能力，目前仍处于开发中/半成品状态，不作为已发布用户能力写入 CHANGELOG 或 GitHub Release notes。

它不是 AI Runtime，也不属于 Session Sidecar：登录、Issue/Skill/Agent 注册、附件上传下载、dispatch 拉取都由 Rust Tauri command 拥有；React 只负责 UI 编排；CLI 通过 management API 暴露 issue/attachment 子集给 Agent 自动化使用。

## 构建门控

Space 是 build-time capability：

- `src-tauri/build.rs` 读取环境变量或仓库根 `.env`，仅转发 `MYAGENTS_SPACE_*` 白名单。
- `MYAGENTS_SPACE_ENABLED=true` 时必须提供 HTTPS 且不带 path/credential 的 `MYAGENTS_SPACE_BASE_URL`；build/runtime 校验会移除 query/fragment 并注入规范化后的 origin。
- `cmd_space_get_capability` 返回 `{available, baseUrl, publicClientId, reason}`，只代表构建能力；前端还必须叠加 `config.teamSpaceEnabled === true`（默认关闭）才展示开发中的 Team Space 入口。
- 缺少能力时，Space UI 不应降级为硬编码 URL；所有云端请求必须经 Rust 能力检查。

### Dev/Test mock data mode

Phase 2 为本地验证和自动化测试新增了显式 mock mode：

- debug/test build 中运行时设置 `MYAGENTS_SPACE_MOCK_DATA=true` 时，`space_build_capability()` 返回可用能力，baseUrl 为 `https://space.mock.myagents.local`。release build 中该环境变量被忽略。
- mock mode 仍然由 Rust Space 边界拥有：renderer 继续只调用 `src/renderer/api/spaceCloud.ts`，Tauri command/CLI helper 继续走 `src-tauri/src/space_cloud.rs`，不会在 React 组件里塞假数据。
- mock mode 使用进程内 deterministic 数据集，覆盖 Issues、评论、附件、Skills、Skill 文件、Registered Agents、dispatch。mutation 会更新同一份 in-memory state，便于验证创建/评论/状态/指派等交互。
- mock mode 不读写真实 `~/.myagents/space/session.json`，不访问 `space.myagents.io`，不作为发布能力写入 CHANGELOG 或 Release notes。
- mock mode 只用于 dev/test。生产构建仍以 `MYAGENTS_SPACE_ENABLED` / `MYAGENTS_SPACE_BASE_URL` / public client id 的 build-time capability 为准。

## 模块边界

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Rust | `src-tauri/src/space_cloud.rs` | Space session、HTTP proxy、registered agents、dispatch、Skill zip、附件上传下载 |
| Renderer API | `src/renderer/api/spaceCloud.ts` | Tauri invoke typed wrapper；不直接 `fetch` Space 服务 |
| Renderer UI | `src/renderer/pages/Space.tsx` | Issues / Skills / Agents 三个视图，登录轮询、创建/评论/派发、Skill 安装 |
| CLI | `src/cli/myagents.ts` + `src-tauri/src/cli.rs` | Agent 可调用的 Space issue get/comment/status 与 attachment download 操作；dispatch 处理仍是 Rust/Tauri 内部链路 |

## 本地状态

Space 本地状态保存在 `~/.myagents/space/` 下：

- `session.json` — 云端 session token 与用户/space/membership 摘要；Rust 对外只返回 redacted public view。
- `registered_agents.json` — 本机注册到 Space 的 Agent 映射，包含本地 workspace path 与云端 token。
- `dispatch_log.json` — 已处理 dispatch 到本地 Task 的映射，用于幂等与 delivered 标记。

这些文件属于桌面客户端状态，不进入 SessionStore，也不由 Sidecar 管理。

## 网络与安全

- 所有 Space HTTP 请求由 Rust `reqwest` 发起，并带 build-time public client id header；renderer 不持有 session token。
- 用户可控 workspace 路径进入 Rust 后必须通过 `validate_workspace_root`。
- 写入 workspace 的附件下载走 `resolve_inside_workspace`，只能落在目标 workspace 内。
- Skill zip 安装有总大小、单文件大小、entry 数限制，并防 Zip-Slip；安装目标只允许 global 或当前 project。
- 附件上传有单次数量和大小限制，读取前校验路径与文件大小。

## Dispatch 处理

Registered Agent 可从 Space 拉取 dispatch，并将其转成本地 Task：

1. `cmd_space_register_agent` 在云端创建 registered agent，并写入本地映射。
2. `cmd_space_poll_dispatches` / `cmd_space_process_dispatches_once` 拉取待处理 dispatch。
3. Rust 创建本地 Task/运行记录后写 `dispatch_log.json`，再调用 `cmd_space_mark_dispatch_delivered` 对云端确认。

该链路保持“云端分发、客户端执行”的边界：云端不直接访问本地文件系统或 Sidecar；本地执行仍走 MyAgents 的 Task/Session 体系。
