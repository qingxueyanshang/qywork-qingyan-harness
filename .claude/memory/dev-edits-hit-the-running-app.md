---
name: dev-edits-hit-the-running-app
description: 用户开着 bun run dev 时，改仓库源码会直接作用到他正在用的那个窗口
metadata:
  type: project
---

用户平时开着 `bun run dev`（vite 5180 + `tauri dev`）。在这种状态下改源码不是「等他下次启动才生效」：

- 改组件（`apps/web/src/components/**`）→ vite 热更打进他正在用的窗口。改到 `TerminalPanel.tsx` 会重建
  xterm 实例，`ensureStarted` 随即再开一条 PTY——他屏幕上那块终端被换成一个新 shell。实测：保存文件的
  同一分钟，`qywork.exe` 下多出 `conhost.exe` + `powershell.exe` 各一个。
- 改 `apps/web/src/lib/store/**` 或 `packages/**` → **整页刷新**（不是局部热更，实测按加载计数确认过），
  前端状态全没：页签、打开的文件、终端页都归零。终端页现在会自己补回来（`terminal_list` 恢复页签 + `terminal_open` 回放最近 256K 输出，
  接的还是原来那条 shell），别的不会。
- 改 `apps/desktop/src-tauri/**` → `tauri dev` 重编并**重启整个应用**，跑着的 run 和终端一起没。

所以：动 Rust 之前先确认他手上没有在跑的 run；只为取证而改代码（比如加 `--remote-debugging-port`）不要动 Rust，
另起隔离实例（`qy serve --print-token` + 临时 `QYWORK_HOME`）去验。见 [[tauri-webview-no-cdp]]。
