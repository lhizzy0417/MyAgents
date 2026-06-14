# Cron、Task、Thought 与 Session Inbox

使用场景：定时任务没执行、任务中心任务卡住、想法/任务状态异常、需要向另一个 session 反馈。

## Cron

### Ground truth

- Rust `CronTaskManager` 管理所有定时任务。
- `myagents cron list` 默认按当前工作区作用域过滤。空结果不代表全局没有任务。
- 执行记录在 `cron_runs/`，日志有 `[CronTask]`。
- 手动 `cron run-now` 是 active probe，会实际触发任务。

### 取证

```bash
myagents cron status --json
myagents cron list --json
myagents cron list --workspace <absolute-workspace-path> --json
myagents cron runs <task-id> --limit 20 --json
rg -n "CronTask|cron|cron_runs|Task .* execution failed|nextRun|workspacePath" ./logs/unified-*.log | tail -160
```

### 判断

- 任务在别的 workspace：用 `--workspace` 查，不要说任务丢了。
- enabled=false、时间表达式错误、时区误解：配置问题。
- 有 run 记录但 AI 没产出：看 run 里的 error，再跨 provider/runtime/session 排查。
- 外部 runtime cron 失败：转 `runtime.md`，envPolicy 会按 Agent 配置解析。

## Task / Thought

```bash
myagents task list --json
myagents task get <task-id> --json
myagents thought list --json
```

创建或修改任务前：

```bash
myagents runtime list --json
myagents runtime describe <runtime> --json
myagents agent show <agent-id> --json
```

不要猜 runtime/model/permissionMode。CLI 的 recovery hint 是恢复路径的一部分，要照着跑。

## Session Inbox

当用户要你给另一个 session 反馈、追问、澄清或下指令：

```bash
myagents session send <session-id> -p "..."
```

多行内容用 `--prompt-file`。仅回答当前用户时不要使用 session send。
