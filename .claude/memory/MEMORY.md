# qywork — 项目记忆索引

qywork 自己的记忆放这里，一条一个文件，下面一行一条指向它：`- [标题](文件.md) — 一句话`。

**分层规则**（见 `CLAUDE.md` §9）：只跟 qywork 这份代码有关的写这里；
整台机器都成立的陷阱（Windows 编码、Playwright 不可用、npm shim）和跨项目的工作偏好，
写全局 `~/.claude/projects/.../memory/`。写新记忆前先读本文件，避免重复。

- [命中率只看最后一次调用](hit-rate-shows-latest-call.md) — 用户定过的口径，别改成整轮累计；可以动的只有「没回报按 0 算」那一处
- [排查先查本地数据库](diagnose-from-the-local-db.md) — `~/.qywork/qywork.sqlite3` 有每次工具调用的完整 args 与 outcome；`permission_audit` 空表 = 一次权限裁决都没发生过
- [dev server 必须显式绑 IPv4](dev-server-must-bind-ipv4.md) — vite 不写 host 只听 `::1`，Tauri/PowerShell 探 localhost 走 IPv4，表现为 `tauri dev` 卡 180 秒；`strictPort` 同样必须开
- [桌面端 WebView 够不到 CDP](tauri-webview-no-cdp.md) — Tauri 用自己的 `additional_browser_args` 覆盖环境变量，`switch_workspace` 的那次点击至今未验，见 ROADMAP §37.4/§38.6
- [终端（PTY）重做前先读这三条](pty-lessons-before-removal.md) — pty.rs 已删（零调用方 + 注册的 command 不受 capabilities 约束）；Bun PTY 只支持 POSIX、slave 必须立刻丢、字节流只能 lossy 解码
