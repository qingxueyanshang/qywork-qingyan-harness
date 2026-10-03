---
name: pty-lessons-before-removal
description: 终端 PTY 的四条硬约束，修改 terminal.rs 之前先读；它们都体现在当前实现中，改错时不会报错
metadata:
  type: project
---

终端已重新实现，位于 `apps/desktop/src-tauri/src/terminal.rs`（更早的 `pty.rs` 于
2026-08-12 删除：它有 4 个已注册的 Tauri command、零调用方，而应用自定义命令不受
`capabilities` 约束，等于给 WebView 中的任何脚本留下一条通过 `invoke('pty_open')` 取得可写
shell 的途径）。以下四条是这部分代码的约束，修改前先确认未破坏其中任何一条：

1. **PTY 在 Rust 侧，不放在 Bun sidecar。** Bun 的内建 PTY 只支持 POSIX，Windows 没有
   ConPTY 实现，而 Windows 是本项目的主要开发平台。`portable-pty` 在三个平台分别使用
   ConPTY / openpty，行为一致。
2. **spawn 之后立即 drop slave 端，只保留 master。** 保留 slave 时，子进程退出后 master
   的读端收不到 EOF，读线程会永久阻塞。因此不要保存整个 `PtyPair`。
3. **读取的字节按累积缓冲 lossy 解码，不能按 chunk 严格解码。** PTY 字节流会在多字节
   字符中间被切开，严格解码在中文输出上会随机报错。
4. **默认 shell 固定为 `powershell.exe`，不读取 `COMSPEC`。** Windows 上该变量始终存在
   且指向 cmd.exe，按它取值会使优先级恰好颠倒。

能力边界按 B5 处理：手机端无法访问 Tauri 进程，握手声明 false、界面不显示入口，
而不是显示一个点击即报错的按钮。判断某条会话是否仍存在，见 [[pty-alive-check-by-process-tree]]。
