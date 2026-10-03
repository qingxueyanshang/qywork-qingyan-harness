---
name: probe-ui-with-isolated-instance
description: 在不影响用户窗口的前提下复现前端问题：复制一份 ~/.qywork 数据库到 .tmp/probe/home，启动隔离 sidecar，用 Node 驱动 Playwright 按 #t=token 配对加载
metadata:
  type: project
---

复现「界面白屏 / 某条会话渲染出错」时，不要在用户正在运行的 `bun run dev` 窗口上取证，按以下步骤进行：

1. 复制数据库副本：`~/.qywork/qywork.sqlite3`、`qywork_content.sqlite3` 连同 `-wal` / `-shm` 一起复制到
   `.tmp/probe/home/`。**不复制 `config.json`**（其中是明文 key），没有 key 只影响发送请求，不影响渲染。
2. 启动隔离 sidecar：`QYWORK_HOME=<绝对路径>/.tmp/probe/home bun packages/cli/src/index.ts serve --port 7799 --host 127.0.0.1 --print-token --static apps/web/dist`
   （先执行 `bun run --cwd apps/web build`）。需要开发构建时再启动一个 vite：`QYWORK_PORT=7799 bun run vite --port 5181 --host 127.0.0.1`，它把 `/api` 与 `/stream` 代理到 7799。
3. 配对无需扫码：地址后加 `#t=<token>` 即可（`client.ts` 读取 hash 中的 `t=`，base 取 origin）。
   sidecar 会恢复上次的工作区与会话，侧栏中已激活的 `button.project-open` / `button.conv-open` 处于 disabled 状态，不要点击。
4. 驱动浏览器时用 **node** 运行 `.mjs`，脚本放在 `.tmp/probe/`（放在系统临时目录时无法解析 `playwright`），
   监听 `pageerror` / `console.error`，最后用 `taskkill //PID <pid> //T //F` 结束两个进程。

2026-09-04 实测：白屏报告发生在 dev 监督器 05:41 的那次协调重启之后；隔离实例下同一条会话在生产与开发构建中都正常渲染，
说明是那次整页刷新取得了异常状态，而不是当前代码的渲染崩溃。见 [[dev-edits-hit-the-running-app]]。
