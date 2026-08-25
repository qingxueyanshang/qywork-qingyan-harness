---
name: pty-lessons-before-removal
description: 终端 PTY 的四条硬约束，改 terminal.rs 之前先读；它们都在现实现里，改错了不报错
metadata:
  type: project
---

终端已经重做，落点是 `apps/desktop/src-tauri/src/terminal.rs`（更早的 `pty.rs` 于
2026-08-12 删除：4 个注册好的 Tauri command、零调用方，而应用自定义命令不受
`capabilities` 约束，等于给 WebView 里任何脚本留了一条 `invoke('pty_open')` 拿可写
shell 的路）。下面四条是这块代码的约束，改之前先确认没破坏其中任何一条：

1. **PTY 在 Rust 侧，不放 Bun sidecar。** Bun 的内建 PTY 只支持 POSIX，Windows 没有
   ConPTY 实现，而 Windows 是本项目主开发平台。`portable-pty` 在三平台分别走
   ConPTY / openpty，行为一致。
2. **spawn 之后立刻 drop slave 端，只留 master。** 留着 slave，子进程退出时 master
   的读端收不到 EOF，读线程永远挂着。所以别存整个 `PtyPair`。
3. **读出来的字节按累积缓冲 lossy 解码，不能按 chunk 严格解码。** PTY 字节流会在多字节
   字符中间被切开，严格解码在中文输出上随机报错。
4. **默认 shell 写死 `powershell.exe`，不读 `COMSPEC`。** Windows 上那个变量永远存在
   且指向 cmd.exe，按它取值优先级正好是反的。

能力边界按 B5 走：手机端够不着 Tauri 进程，握手声明 false、界面不显示入口，
而不是显示一个点了报错的按钮。判断某条会话是否还在，见 [[pty-alive-check-by-process-tree]]。
