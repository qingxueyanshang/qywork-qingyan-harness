---
name: qy-needs-isolated-home
description: 开发与验收里执行 qy 必须把 QYWORK_HOME 指到 .tmp 下的隔离目录；PreToolUse 钩子会拦下没设的命令
metadata:
  type: feedback
---

执行 `qy` / `bun packages/cli/src/index.ts` 时，同一条命令里必须设 `QYWORK_HOME` 指向 `.tmp/` 下的隔离目录；需要模型配置时把用户 config.json 拷进隔离目录，用完删除。

**Why:** 2026-09-30 为查参数跑了 `qy exec --help`，当时 CLI 把 `--help` 当成任务，用用户真实的 `~/.qywork` 在仓库目录建了工作区「qywork」和会话「--help」，并用用户默认模型发了一次真实请求（0.17 美元）。用户要求清理并且「以后不要再误跑」。CLI 已改为 `exec --help` 只打用法、不认识的参数报错；另加 `scripts/guard-real-home.ts` 钩子（`.claude/settings.json` 的 PreToolUse）。

**How to apply:** 被钩子拦下时不要换写法绕过，改成带 `QYWORK_HOME` 的命令。多进程测试同样用独立的 home（全新库并发迁移的问题见 [[db-concurrency]]）。碰用户真实数据前先整库备份（`VACUUM INTO` 到 `.tmp/scratch/dbbackup/`），并用 store 自己的函数改，不手写 SQL。
