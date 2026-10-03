---
name: qy-needs-isolated-home
description: 开发与验收中执行 qy 必须将 QYWORK_HOME 指向 .tmp 下的隔离目录；PreToolUse 钩子会拦截未设置的命令
metadata:
  type: feedback
---

执行 `qy` / `bun packages/cli/src/index.ts` 时，同一条命令中必须设置 `QYWORK_HOME` 指向 `.tmp/` 下的隔离目录；需要模型配置时把用户的 config.json 复制到隔离目录，用完删除。

**Why:** 2026-09-30 为查询参数执行了 `qy exec --help`，彼时的 CLI 把 `--help` 当成任务，使用用户真实的 `~/.qywork` 在仓库目录创建了工作区「qywork」和会话「--help」，并用用户默认模型发送了一次真实请求（0.17 美元）。用户要求清理，并要求「以后不要再误跑」。CLI 已改为 `exec --help` 只输出用法、无法识别的参数报错；另外添加了 `scripts/guard-real-home.ts` 钩子（`.claude/settings.json` 的 PreToolUse）。

**How to apply:** 被钩子拦截时不要改变写法绕过，应改为带 `QYWORK_HOME` 的命令。多进程测试同样使用独立的 home（全新库并发迁移的问题见 [[db-concurrency]]）。操作用户真实数据前先备份整个数据库（`VACUUM INTO` 到 `.tmp/scratch/dbbackup/`），并使用 store 自身的函数修改，不手写 SQL。
