# 前端 Render 崩溃

使用场景：白屏、整页“界面渲染出错”、点某处 UI 直接跳到错误页、某个面板一打开就崩。

## Ground truth

- `AppErrorBoundary` 挂在 React 根附近。任意组件 render 抛错都可能让整个界面进入错误页。
- 发布包组件栈通常是压缩名，不能靠 `at t` / `at Dn` 硬猜组件。
- 这类问题多数是产品 bug，不要引导用户改 Provider/MCP 配置来“修”。

## 取证

```bash
myagents status --json
myagents version
rg -n "\\[AppErrorBoundary\\]|\\[REACT\\] \\[ERROR\\]|Cannot read properties|Minified React error|render" ./logs/unified-*.log | tail -80
rg '\[boot\]' ./logs/unified-*.log | tail -5
```

向用户补问：
- 崩溃前最后一个动作是什么？
- 是否稳定复现？
- 是所有工作区/会话都崩，还是某个会话、某条消息、某个设置页才崩？
- 最近是否安装插件、切换 runtime、打开带媒体的消息或恢复历史会话？

## 报告要点

Bug report 带：
- 原始 error message
- 用户最后动作和复现步骤
- boot/status/version
- 关键日志行
- 是否和特定 workspace/session/message/tool attachment 有关

不要把压缩组件栈当成确定定位，只把它作为附加证据。
