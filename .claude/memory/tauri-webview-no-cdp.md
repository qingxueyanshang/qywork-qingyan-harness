---
name: tauri-webview-no-cdp
description: 桌面端 WebView2 连接 CDP 的方法：开发构建设置 QYWORK_WEBVIEW_DEBUG_PORT，另起隔离实例；环境变量与策略注册表都不生效
metadata: 
  node_type: memory
  type: project
  originSessionId: 05999b74-ea23-4dc4-ad35-72313e189798
  modified: 2026-10-01T12:40:00.000Z
---

**桌面端 WebView 自 2026-10-01 起可以用 CDP 驱动**：开发构建读取 `QYWORK_WEBVIEW_DEBUG_PORT`，
为主窗口开启调试端口（`lib.rs` `build_main_window`）；发布构建（启用 `custom-protocol`）经条件编译不包含这段代码。
用户于 2026-10-01 决定保留，无需再次询问。

只有这一种方法的原因（2026-10-01 实测）：
- 外壳经接口传入了 `additional_browser_args`，WebView2 因此忽略环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`；
- 用户策略注册表 `HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`（值名 `qywork.exe`）也不生效。

做法（不影响用户正在使用的实例，见 [[dev-edits-hit-the-running-app]]、[[qy-needs-isolated-home]]）：
- 外壳另行构建到单独的 target 目录（如 `.tmp/cargo-target-verify`）：用户实例占用着 `.tmp/cargo-target` 中的 exe；
- 自行启动服务端（`QYWORK_HOME` 指向 .tmp、`--cwd` 测试工作区、`--print-token`），外壳通过 `QYWORK_TOKEN` / `QYWORK_PORT` 连接它；
- `WEBVIEW2_USER_DATA_FOLDER` 指向 .tmp 下的独立目录（这个环境变量生效），否则会与用户实例争用同一个数据目录；
- 不设置 `QYWORK_HOST_KEY`，浏览器宿主与桌面宿主不启动；
- Playwright `chromium.connectOverCDP('http://127.0.0.1:<端口>')`，页面源是 `http://localhost:5180`（用户的 Vite）；
- 结束时按进程号用 `taskkill /T /F` 只关闭自行启动的外壳。
现成脚本：`.tmp/canvas-check/shell.mjs`（时间线全流程，2026-10-01 通过）。

`switch_workspace` 过程中的那一次点击仍未补充验证。

Web 端的实测手段见 [[playwright-broken-use-cdp]]。
