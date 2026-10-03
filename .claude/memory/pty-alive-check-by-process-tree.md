---
name: pty-alive-check-by-process-tree
description: 判断终端页对应的 PTY 是否仍存在，查看 qywork.exe 是否有 conhost 子进程
metadata:
  type: project
---

界面上有输出不代表会话仍存活：xterm 停留在最后一帧，从界面上无法判断。确认实际状态需查看进程树：

```powershell
Get-CimInstance Win32_Process -Filter "ParentProcessId=<qywork.exe 的 pid>"
```

一条存活的终端会话在 Windows 上是 `conhost.exe --headless --inheritcursor --width N --height N`
加一个 `powershell.exe`，两者都是 `qywork.exe` 的直接子进程。只剩 `msedgewebview2.exe` = Rust 侧的会话表为空，
界面显示与实际不符。会话被移除时 master 一并 drop，conhost 随之退出，因此「没有 conhost」这一判据是可靠的。

反向同样成立：新开一条终端后进程树中没有多出这两个进程，说明 `terminal_open` 进入了「这个 id 已存在」的提前返回分支。
