---
name: probe-ui-with-isolated-instance
description: 不碰用户窗口地复现前端问题：拷一份 ~/.qywork 数据库到 .tmp/probe/home，起隔离 sidecar，用 Node 驱动 Playwright 按 #t=token 配对加载
metadata:
  type: project
---

复现「界面白屏 / 某条会话渲染出错」时，不要在用户开着的 `bun run dev` 窗口上取证，走这条：

1. 拷数据库副本：`~/.qywork/qywork.sqlite3`、`qywork_content.sqlite3` 连同 `-wal` / `-shm` 一起拷到
   `.tmp/probe/home/`。**不拷 `config.json`**（里面是明文 key），没有 key 只影响发请求，不影响渲染。
2. 起隔离 sidecar：`QYWORK_HOME=<绝对路径>/.tmp/probe/home bun packages/cli/src/index.ts serve --port 7799 --host 127.0.0.1 --print-token --static apps/web/dist`
   （先 `bun run --cwd apps/web build`）。要开发构建就再起一个 vite：`QYWORK_PORT=7799 bun run vite --port 5181 --host 127.0.0.1`，它把 `/api` 与 `/stream` 代理到 7799。
3. 配对不用扫码：地址加 `#t=<token>` 即可（`client.ts` 读 hash 里的 `t=`，base 取 origin）。
   sidecar 会恢复上次的工作区与会话，侧栏里已激活的 `button.project-open` / `button.conv-open` 是 disabled 的，别去点。
4. 驱动浏览器用 **node** 跑 `.mjs`，脚本放 `.tmp/probe/`（放系统临时目录会解析不到 `playwright`），
   监听 `pageerror` / `console.error`，最后 `taskkill //PID <pid> //T //F` 收掉两个进程。

2026-09-04 实测：白屏报告发生在 dev 监督器 05:41 那次协调重启之后；隔离实例下同一条会话在生产与开发构建都正常渲染，
说明是那次整页刷新拿到了坏状态，不是当前代码的渲染崩溃。见 [[dev-edits-hit-the-running-app]]。
