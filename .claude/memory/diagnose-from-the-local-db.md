---
name: diagnose-from-the-local-db
description: 排查 agent 行为先查询 ~/.qywork/qywork.sqlite3，其中有每次工具调用的完整 args 与 outcome；截图和记忆都不足以判断
metadata:
  node_type: memory
  type: project
---

用户报告「模型行为不对」时，**本地数据库能完整重放那一轮**，不必依靠截图推断。
只读打开 `~/.qywork/qywork.sqlite3`（bun:sqlite，
`{ readonly: true }`；运行中的服务使用 WAL 模式，读取不影响它）。

各表对应的问题：

| 问题 | 表 |
|---|---|
| 模型实际调用了什么、参数是什么、返回了什么 | `steps.payload`（JSON，含 `args` / `outcome` / `action`）|
| 这一轮如何结束 | `runs.stop_reason` / `error_message` |
| 目标的每一次变更 | `goal_events.snapshot`（每次一行完整快照）|
| **有没有发生过权限裁决** | `permission_audit` |
| 用户原话 | `messages` |
| 每次请求发送了多少、上游计入了多少、在哪里中断 | `provider_requests`（`sent_categories` / `provider_*_tokens` / `sent_at` / `diagnostic`）|

`provider_requests` 的两个陷阱（2026-09-28 排查「Opus 反复长思考」时发现）：

- `request_bytes` 与 `measured_input_tokens` 统计的是**适配器转换之前**的通用请求，
  含 `reasoningContent`；适配器丢弃的内容仍计算在内。判断「到底发没发上去」要将
  `provider_input + provider_cached + provider_cache_write` 与 `measured` 比较，差额即为未发送到上游的部分。
- 缓存中断时先计算相邻两次 `sent_at` 的间隔：超过 5 分钟即为 TTL 过期（断点使用默认的 5 分钟档），
  不要先怀疑中转站轮询账号。

关键的一项是 `permission_audit`：**空表** = 一次裁决都没发生过。
两次排查都依靠它区分「权限闸拦的」与「路径层拦的」：用户看到的现象相同，
原因和修复方法完全不同。

**先查表再分析机制**（CLAUDE.md A5）。实例：

- 用户说「只有创建待办没有修改待办」→ 查 `steps` 发现 37 步的 run 只调用了两次
  `write_todos`，52 步的那一轮一次也未调用。用户反映的是文案，实际问题是**完全没有更新**。
- 用户说「权限控制没生效」→ `permission_audit` 为空，拦截来自 `resolveInWorkspace`。
- 用户说「显示已中断」→ `runs.stop_reason='user_interrupt'` 而
  `error_message` 为「上次进程退出」：是 `recoverStaleRuns` 借用了这个停止原因。

查询脚本放在 scratchpad，结果用 `Bun.write` 写入文件后再用 Read 查看：
终端直接输出中文会二次污染证据（全局记忆 `encoding-diagnosis-by-bytes`）。
