# qywork — 项目记忆索引

qywork 自身的记忆存放于此，每条一个文件，下方每行对应一条：`- [标题](文件.md) — 一句话`。

**分层规则**（见 `CLAUDE.md` D3）：只与 qywork 代码有关的写在这里；
对整台机器都成立的陷阱（Windows 编码、Playwright 不可用、npm shim）和跨项目的工作偏好，
写入全局 `~/.claude/projects/.../memory/`。写新记忆前先读本文件，避免重复。

- [命中率只看最后一次调用](hit-rate-shows-latest-call.md) — 用户确定的口径，不要改成整轮累计；可以调整的只有「没回报按 0 算」那一处
- [排查先查本地数据库](diagnose-from-the-local-db.md) — `~/.qywork/qywork.sqlite3` 有每次工具调用的完整 args 与 outcome；`permission_audit` 空表 = 一次权限裁决都没发生过
- [dev server 必须显式绑定 IPv4](dev-server-must-bind-ipv4.md) — vite 不设 host 时只监听 `::1`，Tauri/PowerShell 探测 localhost 使用 IPv4，现象为 `tauri dev` 停滞 180 秒；`strictPort` 同样必须开启
- [桌面端 WebView 连接 CDP](tauri-webview-no-cdp.md) — 开发构建设置 `QYWORK_WEBVIEW_DEBUG_PORT` 并另起隔离实例；环境变量与策略注册表都不生效
- [修改 terminal.rs 前先读这四条](pty-lessons-before-removal.md) — PTY 必须在 Rust 侧、slave 端立即释放、字节流按累积缓冲 lossy 解码、默认 shell 固定为 powershell 且不读 COMSPEC
- [dev 状态下修改源码会作用于用户正在使用的窗口](dev-edits-hit-the-running-app.md) — 修改前端触发热更新、修改 core 触发整页刷新、修改 packages 在运行中的 run 结束后重启 dev.ts 的 sidecar、修改 Rust 重启整个应用；取证须另起隔离实例
- [PTY 是否存活以进程树为准](pty-alive-check-by-process-tree.md) — `qywork.exe` 下有 `conhost.exe --headless` + shell 才算存活；只剩 webview 说明界面显示与实际不符
- [本地打包产物收集到 .tmp/installer/](local-installer-lands-in-tmp.md) — `tauri:build` 末尾自动收集；正式发布通过 GitHub Actions 草稿 Release，不要把本地 exe 当作发布产物
- [计时测试在机器高负载时成批超时](timing-tests-fail-under-machine-load.md) — followup / goal-loop / 插件 e2e 的 10s 上限；套件总时长翻倍且只有这几条失败即为负载所致，待负载回落后重新运行
- [在不影响用户窗口的前提下复现前端问题](probe-ui-with-isolated-instance.md) — 复制数据库到 .tmp/probe/home 并启动隔离 sidecar，`#t=token` 配对，用 Node 驱动 Playwright 获取 pageerror
- [真机电脑控制任务会操作任何已打开的窗口](desktop-live-runs-can-type-into-this-session.md) — 曾输入 `exit` 结束主会话、曾导航用户的 Edge；运行前确认 run-task.ts 会隐藏运行前已打开的全部窗口，结束后用 scan-touched.ts 检查
- [参照用的 agent 仓库位于 view-agent](reference-agents-in-view-agent.md) — 「看看开源项目」指桌面 view-agent 下的 pi / prime / cc-haha / deepseek-harness 四个仓库；出处只写入 docs/plans
- [前一版本未发布时不升版本号](version-bump-only-after-publish.md) — v0.1.20 未公开时新改动并入 0.1.20，本地打包安装使用同一版本号，版本说明修改当前版本的那一份
- [执行 qy 必须隔离数据目录](qy-needs-isolated-home.md) — 同一条命令中设置 `QYWORK_HOME` 指向 .tmp；钩子 `scripts/guard-real-home.ts` 拦截未设置的命令；曾误用用户真实账本执行过一次
- [Git Bash 的 /tmp 指向已删除的测试目录](git-bash-tmp-points-at-deleted-test-dir.md) — bash 先输出「could not find /tmp」、shell 工具测试报「投递额度未开账」；用 `mount` 查看指向并重建该目录，不结束其他会话的 sh
- [与并行会话修改了同一批文件时只提交本会话的段](partial-commit-shared-files.md) — 按内容判定归属、从 HEAD 构造内容写入索引、临时工作树自检、按索引提交；带 pathspec 会把对方的段一并提交
- [刷新恢复的测试方法](refresh-restore-testing.md) — 带查询串重新导入模块模拟刷新；组件测试 afterEach 清空记录；性能对照构建把 sessionSignal 换成 createSignal
