---
name: pty-alive-check-by-process-tree
description: 判断终端页背后的 PTY 还在不在，看 qywork.exe 有没有 conhost 子进程
metadata:
  type: project
---

界面上有输出不代表会话还存活——xterm 停在最后一帧，看不出来。查真相走进程树：

```powershell
Get-CimInstance Win32_Process -Filter "ParentProcessId=<qywork.exe 的 pid>"
```

一条活着的终端会话在 Windows 上是 `conhost.exe --headless --inheritcursor --width N --height N`
加一个 `powershell.exe`，两者都是 `qywork.exe` 的直接子进程。只剩 `msedgewebview2.exe` = Rust 侧的会话表是空的，
界面在骗人。会话被摘掉时 master 一起 drop，conhost 随之退出，所以「没有 conhost」这条判据是可靠的。

反向也成立：新开一条终端后进程树里没多出这两个，说明 `terminal_open` 走了「这个 id 已存在」的早返回。
