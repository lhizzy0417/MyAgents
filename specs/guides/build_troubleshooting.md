# 构建问题排查指南

## 目录

1. [Windows 构建脚本常见问题](#windows-构建脚本常见问题)
2. [CSP 配置错误](#csp-配置错误)
3. [Rust toolchain / rustfmt 漂移](#rust-toolchain--rustfmt-漂移)
4. [Resources 缓存问题](#resources-缓存问题)
5. [代理配置问题](#代理配置问题)

---

## Windows 构建脚本常见问题

### 问题：构建后 CSP 错误仍然存在

**症状**：
```
Fetch API cannot load http://ipc.localhost/plugin...
Refused to connect because it violates the document's Content Security Policy
```

**根本原因**：

早期构建脚本存在两个严重 BUG（修复后保留为已知陷阱说明）：

#### Bug 1: 缺少 resources 目录清理

**问题**：
- 构建脚本只清理了 `bundle` 目录
- 未清理 `src-tauri/target/{arch}/{profile}/resources` 目录
- Tauri 在 resources 目录缓存了 `tauri.conf.json` 等配置文件
- 即使源文件更新，构建仍使用旧缓存

**修复**（commit a23cdf3）：
```powershell
# 清理 resources 目录确保配置重新读取
$resourcesDir = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"
if (Test-Path $resourcesDir) {
    Remove-Item $resourcesDir -Recurse -Force
}
```

#### Bug 2: 错误的 CSP 覆盖

**问题**：
- `build_windows.ps1` 第 153 行强制覆盖 CSP 为旧版本
- 覆盖的 CSP 缺少关键指令：
  - ❌ `asset:` 协议
  - ❌ `http://ipc.localhost` （Windows Tauri IPC 必需，由 `connect-src` 放行）
  - ❌ `https://download.myagents.io`

**修复**（commit a23cdf3）：
- 移除错误的 CSP 覆盖逻辑
- 改为验证 CSP 配置完整性
- 检查关键部分，如果缺失则警告用户

**验证方法**：

```powershell
# 检查构建脚本版本
git log --oneline build_windows.ps1 | head -1
# 应显示 a23cdf3 或更新的 commit

# 清理构建
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release -Recurse -Force

# 重新构建
.\build_windows.ps1
```

---

## CSP 配置错误

### Windows Tauri IPC 需要特殊 CSP

**背景**：
- Windows Tauri v2 使用 `http://ipc.localhost` 进行 IPC 通信（走 Fetch API）
- CSP 中 `default-src` 和 `connect-src` 都必须包含 `http://ipc.localhost`。
  注意：管 fetch/XHR/WebSocket 的标准指令是 `connect-src`；曾经配过的
  `fetch-src` 是非标准指令，WebKit / WebView2 都忽略它（只在 console 报
  "Unrecognized"），已移除——真正放行 IPC 的一直是 `connect-src`。

**正确配置**（`tauri.conf.json`）：
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: tauri: asset: http://ipc.localhost; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: tauri: asset: http://ipc.localhost http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https://download.myagents.io; img-src 'self' data: blob: asset: https://download.myagents.io;"
    }
  }
}
```

**关键部分**：
- `default-src`: 包含 `http://ipc.localhost`
- `connect-src`: **必须**包含 `http://ipc.localhost`（Windows Tauri IPC 走 Fetch API，由 connect-src 放行），并含 localhost 和 WebSocket 支持
- `img-src`: 支持 data URL 和 CDN 资源

**验证 CSP 配置**：

```powershell
# 检查 tauri.conf.json 中的 CSP
$conf = Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json
$csp = $conf.app.security.csp

# 验证关键部分
$requiredParts = @("http://ipc.localhost", "asset:", "connect-src", "https://download.myagents.io")
foreach ($part in $requiredParts) {
    if ($csp -notlike "*$part*") {
        Write-Host "缺少: $part" -ForegroundColor Red
    }
}
```

---

## Rust toolchain / rustfmt 漂移

**症状**：
- 未改 Rust 逻辑，却出现几十个 `src-tauri/src/**/*.rs` 文件的 diff
- diff 主要是 import 排序、宏参数换行、`let Some(...) else` 展开、trailing comma 等格式变化

**根本原因**：

Rust 格式化结果由 `rustfmt` 版本决定。仓库根目录的 `rust-toolchain.toml` 固定实际开发/CI toolchain；如果本机没有通过 rustup 进入仓库、或 IDE 使用了系统 Rust，就可能跑出不同格式。

`setup.sh` / `setup_windows.ps1` 和各平台 build 脚本都会调用 `scripts/ensure_rust_toolchain.*`：
- 从 `rust-toolchain.toml` 读取 channel 和 components（当前为 `1.92.0` + `rustfmt` / `clippy`）
- 显式安装对应 component
- 平台 build 额外安装目标 target（Windows 为 `x86_64-pc-windows-msvc`）
- Windows setup 会刷新当前 PowerShell 的 PATH；如果 winget 只报告 Rustup 包已安装但 `rustup.exe` 仍不可用，会兜底下载官方 `rustup-init.exe`，验证/补齐 `~/.cargo/bin/rustup.exe`

如果 Windows 上 setup 后 build 仍报 `can't find crate for core`、`target may not be installed`、`component 'rustfmt' is unavailable/not installed` 等 Rust 缺失类错误，先手动运行：

```powershell
.\scripts\ensure_rust_toolchain.ps1 -Targets x86_64-pc-windows-msvc
```

macOS / Linux：

```bash
./scripts/ensure_rust_toolchain.sh
```

**验证方法**：

```bash
rustup show active-toolchain
rustfmt --version
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

`rustup show active-toolchain` 应显示被仓库 `rust-toolchain.toml` override。升级 Rust 时必须同时改 `rust-toolchain.toml` 和 CI toolchain，并把 `cargo fmt` 产生的机械 diff 单独提交。

---

## Resources 缓存问题

### 问题：配置更新后构建仍使用旧配置

**原因**：
- Tauri 在 `target/{arch}/{profile}/resources/` 缓存配置文件
- 常规清理（`cargo clean` 或删除 `bundle`）不会清理此目录

**解决方案**：

手动清理 resources 目录：
```powershell
# Debug 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/debug/resources -Recurse -Force

# Release 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/release/resources -Recurse -Force
```

或使用构建脚本（已自动处理）：
```powershell
.\build_windows.ps1  # 自动清理 release/resources
.\build_dev_win.ps1  # 默认快速 Debug exe，自动清理 debug/resources
.\build_dev_win.ps1 -BundleNsis  # 需要验证安装器时，额外清理 debug/bundle 并打 Debug NSIS
```

---

## 代理配置问题

### localhost 连接失败

**症状**：
```
[proxy] Request failed: error sending request for url (http://127.0.0.1:31415/...)
```

**原因**：
- reqwest 默认使用系统代理（如 Clash: 127.0.0.1:7890）
- Windows 系统代理未正确处理 localhost 排除
- localhost 请求被发送到代理，连接失败

**解决方案**：

所有 localhost 请求强制禁用代理（详见 `pit_of_success.md` 的 `local_http` 节）：
```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 禁用所有代理（包括系统代理）
    .build()?;
```

**详见**：[proxy_config.md](../tech_docs/proxy_config.md)

---

## 最佳实践

### 构建前检查清单

- [ ] 版本号已同步（`package.json`, `tauri.conf.json`, `Cargo.toml`）
- [ ] Rust toolchain/components/target 已由 `scripts/ensure_rust_toolchain.*` 准备
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] CSP 配置完整（`connect-src` 包含 `http://ipc.localhost`）
- [ ] 清理旧的 resources 缓存
- [ ] 杀死残留进程（node sidecar, MyAgents）

### 构建后验证

- [ ] 安装包大小正常（~150MB）
- [ ] 安装并启动成功
- [ ] 开发者工具无 CSP 错误
- [ ] Sidecar 连接正常
- [ ] 二维码等资源加载正常

---

## 相关文档

- [Windows 构建指南](../guides/windows_build_guide.md)
- [代理配置](../tech_docs/proxy_config.md)
- [Windows 平台指南](./windows.md)
