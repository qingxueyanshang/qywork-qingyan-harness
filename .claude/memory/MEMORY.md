# qywork — 项目记忆索引

qywork 自己的记忆放这里，一条一个文件，下面一行一条指向它：`- [标题](文件.md) — 一句话`。

**分层规则**（见 `CLAUDE.md` D3）：只跟 qywork 这份代码有关的写这里；
整台机器都成立的陷阱（Windows 编码、Playwright 不可用、npm shim）和跨项目的工作偏好，
写全局 `~/.claude/projects/.../memory/`。写新记忆前先读本文件，避免重复。

- [命中率只看最后一次调用](hit-rate-shows-latest-call.md) — 用户定过的口径，别改成整轮累计；可以动的只有「没回报按 0 算」那一处
- [排查先查本地数据库](diagnose-from-the-local-db.md) — `~/.qywork/qywork.sqlite3` 有每次工具调用的完整 args 与 outcome；`permission_audit` 空表 = 一次权限裁决都没发生过
- [dev server 必须显式绑 IPv4](dev-server-must-bind-ipv4.md) — vite 不写 host 只听 `::1`，Tauri/PowerShell 探 localhost 走 IPv4，表现为 `tauri dev` 卡 180 秒；`strictPort` 同样必须开
- [桌面端 WebView 够不到 CDP](tauri-webview-no-cdp.md) — Tauri 用自己的 `additional_browser_args` 覆盖环境变量，`switch_workspace` 的那次点击至今未验
- [改 terminal.rs 前先读这四条](pty-lessons-before-removal.md) — PTY 必须在 Rust 侧、slave 立刻丢、字节流按累积缓冲 lossy 解码、默认 shell 写死 powershell 不读 COMSPEC
- [dev 状态下改源码会打到用户正在用的窗口](dev-edits-hit-the-running-app.md) — 改前端热更、改 core 整页刷新、改 Rust 重启整个应用；取证要另起隔离实例
- [PTY 还在不在看进程树](pty-alive-check-by-process-tree.md) — `qywork.exe` 下有 `conhost.exe --headless` + shell 才算活着；只剩 webview 就是界面在骗人
- [本地打包产物收进 .tmp/installer/](local-installer-lands-in-tmp.md) — `tauri:build` 末尾自动收；正式发布走 GitHub Actions 草稿 Release，别拿本地 exe 当发布产物
- [计时测试在机器高负载时成片超时](timing-tests-fail-under-machine-load.md) — followup / goal-loop / 插件 e2e 的 10s 上限；套件总时长翻倍且只红这几条就是负载，等回落再跑
