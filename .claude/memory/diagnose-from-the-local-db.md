---
name: diagnose-from-the-local-db
description: 排查 agent 行为先查 ~/.qywork/qywork.sqlite3，那里有每次工具调用的完整 args 与 outcome；截图和记忆都不够
metadata:
  node_type: memory
  type: project
---

用户报「模型行为不对」时，**本地数据库能把那一轮完整重放出来**，不必靠截图推断。
只读打开 `<home>/.qywork/qywork.sqlite3`（bun:sqlite，
`{ readonly: true }`；跑着的服务是 WAL 模式，读不影响它）。

哪张表回答哪个问题：

| 问题 | 表 |
|---|---|
| 模型到底调了什么、参数是什么、返回了什么 | `steps.payload`（JSON，含 `args` / `outcome` / `action`）|
| 这一轮怎么收的场 | `runs.stop_reason` / `error_message` |
| 目标的每一次变更 | `goal_events.snapshot`（每次一行完整快照）|
| **有没有发生过权限裁决** | `permission_audit` |
| 用户原话 | `messages` |

最后一条是关键：`permission_audit` **空表** = 一次裁决都没发生过。
两次排查都是靠它把「权限闸拦的」和「路径层拦的」分开——用户看到的现象一样，
病因和修法完全不同。

**先查表再讲机制**（CLAUDE.md A5）。踩过的具体形状：

- 用户说「只有创建待办没有修改待办」→ 查 `steps` 发现 37 步的 run 只调了两次
  `write_todos`，52 步那轮一次没调。抱怨的是文案，真问题是**根本没在更新**。
- 用户说「权限控制没生效」→ `permission_audit` 空，被拦的是 `resolveInWorkspace`。
- 用户说「显示已中断」→ `runs.stop_reason='user_interrupt'` 而
  `error_message` 写着「上次进程退出」——是 `recoverStaleRuns` 借了这个停止原因。

写查询脚本放 scratchpad，结果 `Bun.write` 到文件再用 Read 看：
终端直接打中文会二次污染证据（全局记忆 `encoding-diagnosis-by-bytes`）。
