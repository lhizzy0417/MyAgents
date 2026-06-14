# Agent、Channel 与 Plugin Bridge 诊断

使用场景：Telegram / 钉钉 / 飞书 / 微信 / QQ Agent 不在线、不回消息、社区插件装不上、QR 登录后不生效。

## Ground truth

- 新架构是 Agent + Channel。用户说 IM Bot、机器人、飞书 bot，通常都指 Agent Channel。
- 内置 Channel 由 Rust 层驱动，例如 Telegram、钉钉。
- 社区 Channel 通过独立 Node.js Plugin Bridge 进程加载 OpenClaw 插件。
- Plugin Bridge 有安装、启动、health check、QR 登录、OpenClaw SDK shim、per-channel 状态目录等多段链路。
- 社区插件运行态必须按 Agent/Channel 隔离，不应共享上游默认 `~/.openclaw` 状态。

## 取证

```bash
myagents agent list --json
myagents agent show <agent-id> --json
myagents agent channel list <agent-id> --json
myagents agent runtime-status --json
myagents plugin list --json
rg -n "\\[telegram\\]|\\[dingtalk\\]|\\[feishu\\]|\\[im\\]|\\[bridge\\]|OpenClaw|qr-login|Gateway|plugin not ready|npm install" ./logs/unified-*.log | tail -160
```

## 判断

- `agent list` 只看配置，`agent runtime-status` 看实时连接状态。不要混用。
- 内置 Channel 凭证错误：通常在对应 `[telegram]` / `[dingtalk]` 日志里有认证或连接失败。
- 社区插件安装失败：看 `[bridge] npm install` 的 stderr，通常是网络、proxy、registry、包名或平台 native 依赖。
- Bridge 进程启动失败：查 health check、entry 解析、OpenClaw SDK shim compat、缺失 `plugin-sdk/*` 子路径。
- QR 登录失败：查 `/qr-login-start` / `/qr-login-wait` 相关日志和插件是否声明 supportsQrLogin。
- 登录成功但消息不进 MyAgents：查 Bridge message route 到 Rust 的日志，再查 Agent Channel 是否 enabled。
- IM 收到消息但 AI 不回：跨到 `session-sidecar.md`、`provider-mcp.md`，因为可能是 AI runtime/provider 失败。

## 修复边界

- 可以用 CLI 启禁用 Agent、添加/移除 Channel、安装/删除插件。
- 删除 Channel、重置登录状态、重新 QR 登录前要向用户确认，因为会影响已绑定账号。
- 不要直接编辑插件状态目录，除非用户明确要求且没有 CLI/GUI 路径可用。
