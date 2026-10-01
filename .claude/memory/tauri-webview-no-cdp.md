---
name: tauri-webview-no-cdp
description: 桌面端 WebView2 接 CDP 的办法：开发构建设 QYWORK_WEBVIEW_DEBUG_PORT，另起隔离实例；环境变量与策略注册表都不生效
metadata: 
  node_type: memory
  type: project
  originSessionId: 05999b74-ea23-4dc4-ad35-72313e189798
  modified: 2026-10-01T12:40:00.000Z
---

**桌面端 WebView 可以用 CDP 驱动了（2026-10-01 起）**：开发构建读 `QYWORK_WEBVIEW_DEBUG_PORT`，
给主窗口开调试端口（`lib.rs` `build_main_window`）；发布构建（打开 `custom-protocol`）按条件编译不含这段。
用户 2026-10-01 定为保留，不需要再问。

为什么只有这一条路（2026-10-01 实测）：
- 外壳经接口传了 `additional_browser_args`，WebView2 因此忽略环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`；
- 用户策略注册表 `HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`（值名 `qywork.exe`）也不生效。

做法（不碰用户正在用的实例，见 [[dev-edits-hit-the-running-app]]、[[qy-needs-isolated-home]]）：
- 外壳另构建到单独的 target 目录（如 `.tmp/cargo-target-verify`）：用户实例占着 `.tmp/cargo-target` 的 exe；
- 自己起服务端（`QYWORK_HOME` 指向 .tmp、`--cwd` 测试工作区、`--print-token`），外壳用 `QYWORK_TOKEN` / `QYWORK_PORT` 接它；
- `WEBVIEW2_USER_DATA_FOLDER` 指向 .tmp 下独立目录（这个环境变量生效），否则和用户实例抢同一个数据目录；
- 不设 `QYWORK_HOST_KEY`，浏览器宿主与桌面宿主不起；
- Playwright `chromium.connectOverCDP('http://127.0.0.1:<端口>')`，页面源是 `http://localhost:5180`（用户的 Vite）；
- 结束时按进程号 `taskkill /T /F` 只关自己起的外壳。
现成脚本：`.tmp/canvas-check/shell.mjs`（时间线全流程，2026-10-01 通过）。

`switch_workspace` 中间那一次点击仍未补验。

Web 端的实测手段见 [[playwright-broken-use-cdp]]。
