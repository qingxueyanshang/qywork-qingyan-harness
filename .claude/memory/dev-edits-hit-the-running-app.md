---
name: dev-edits-hit-the-running-app
description: 用户运行 bun run dev 时，修改仓库源码会直接作用于用户正在使用的窗口
metadata:
  type: project
---

用户平时运行着 `bun run dev`（vite 5180 + `tauri dev`）。在这种状态下修改源码并非「等他下次启动才生效」：

- 修改组件（`apps/web/src/components/**`）→ vite 热更新直接作用于用户正在使用的窗口。修改 `TerminalPanel.tsx` 会重建
  xterm 实例，`ensureStarted` 随即再开一条 PTY，用户屏幕上的终端被替换为一个新 shell。实测：保存文件的
  同一分钟内，开发外壳进程下多出 `conhost.exe` + `powershell.exe` 各一个。
- 修改 `apps/web/src/lib/store/**` 或 `packages/**` → **整页刷新**（不是局部热更新，已按加载计数实测确认），
  前端状态全部丢失：页签、打开的文件、终端页都被清空。终端页会自动恢复（`terminal_list` 恢复页签 + `terminal_open` 回放最近 256K 输出，
  连接的仍是原有的那条 shell），其他状态不会恢复。
- 修改 `apps/desktop/src-tauri/**` → `tauri dev` 重新编译并**重启整个应用**，运行中的 run 和终端一并丢失。
- 修改 `packages/**` 或 `apps/web/src/**` → 桌面端复用 `dev.ts` 的 sidecar（`qywork.log` 中为「复用 dev.ts 的 sidecar :7717」）。
  `dev.ts` 的重载判据是「文件已变化，且没有进行中的 run」：运行中的 run 不会中断，全部结束后 sidecar 才重启，
  客户端约一秒内自动重连。实测（2026-10-09）：用户的一轮结束后 0.45 秒 sidecar 重启。
  多个文件须一次写完整：其间若最后一轮恰好结束，sidecar 会以写到一半的代码重启。
- 跨多个文件分步修改接口时，sidecar 会以中间状态反复重启并崩溃；连续失败达到上限后 `reload-supervisor.ts` 停止重试，
  而此后每次重启前的空闲检查要请求 sidecar 自身，sidecar 已退出时该检查一直失败，源码修好也不会再重启。
  现象：7717 端口健康检查无响应、进程列表中没有 `index.ts serve`。只能结束 `dev.ts` 进程树后重新 `bun run dev`
  （2026-10-25 实测；从独立的 cmd 窗口启动，不依赖当前会话）。

因此：修改 Rust 之前先确认用户没有运行中的 run；仅为取证而修改代码（例如添加 `--remote-debugging-port`）时不要修改 Rust，
另起隔离实例（`qy serve --print-token` + 临时 `QYWORK_HOME`）验证。见 [[tauri-webview-no-cdp]]。
