---
name: tauri-webview-no-cdp
description: Tauri 在 Windows 上覆盖 WebView2 浏览器参数，桌面端 WebView 无法被 CDP 驱动
metadata: 
  node_type: memory
  type: project
  originSessionId: 05999b74-ea23-4dc4-ad35-72313e189798
  modified: 2026-08-11T03:40:41.989Z
---

**qywork 桌面端的 WebView 没法用 CDP 驱动**，所以「在桌面窗口里点一下」这类验证
目前做不到自动化。

原因：Tauri 在 Windows 上用自己的 `additional_browser_args` 覆盖了环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，外部设的 `--remote-debugging-port`
不会生效。

直接后果：`switch_workspace` 这个 Tauri
命令的两端都验过（Rust 编译通过 + 写入的文件确实被下次启动读到），
但**中间那一次点击没验**，明确记为「不算作已验证」。

绕过的办法是给 Tauri 的 window builder 加一个 debug-only 的
`additional_browser_args` 调试端口——那是**为了测试改产品代码**，
动手前先跟用户确认。

Web 端的实测手段见 [[playwright-broken-use-cdp]]。
