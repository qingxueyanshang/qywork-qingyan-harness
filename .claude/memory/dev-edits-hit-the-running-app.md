---
name: dev-edits-hit-the-running-app
description: 用户运行 bun run dev 时，修改仓库源码会直接作用于用户正在使用的窗口
metadata:
  type: project
---

用户平时运行着 `bun run dev`（vite 5180 + `tauri dev`）。在这种状态下修改源码并非「等他下次启动才生效」：

- 修改组件（`apps/web/src/components/**`）→ vite 热更新直接作用于用户正在使用的窗口。修改 `TerminalPanel.tsx` 会重建
  xterm 实例，`ensureStarted` 随即再开一条 PTY，用户屏幕上的终端被替换为一个新 shell。实测：保存文件的
  同一分钟内，`qywork.exe` 下多出 `conhost.exe` + `powershell.exe` 各一个。
- 修改 `apps/web/src/lib/store/**` 或 `packages/**` → **整页刷新**（不是局部热更新，已按加载计数实测确认），
  前端状态全部丢失：页签、打开的文件、终端页都被清空。终端页会自动恢复（`terminal_list` 恢复页签 + `terminal_open` 回放最近 256K 输出，
  连接的仍是原有的那条 shell），其他状态不会恢复。
- 修改 `apps/desktop/src-tauri/**` → `tauri dev` 重新编译并**重启整个应用**，运行中的 run 和终端一并丢失。
- 修改 `packages/**` 的服务端源码 → 桌面端复用 `dev.ts` 的 sidecar（`qywork.log` 中为「复用 dev.ts 的 sidecar :7717」），
  该 sidecar 随即重启，运行中的 run 中断。实测（2026-10-09）：保存 `packages/tools/src/canvas.ts` 后 0.3 秒 sidecar 重启，
  用户的一轮在第一次重启前 0.45 秒刚好结束；客户端约一秒内自动重连。

因此：修改 `packages/**` 或 Rust 之前先查本机账本中有没有运行中的 run，有则告知用户；仅为取证而修改代码（例如添加 `--remote-debugging-port`）时不要修改 Rust，
另起隔离实例（`qy serve --print-token` + 临时 `QYWORK_HOME`）验证。见 [[tauri-webview-no-cdp]]。
