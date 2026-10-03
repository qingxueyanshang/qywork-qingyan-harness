---
name: git-bash-tmp-points-at-deleted-test-dir
description: Git Bash 的 /tmp 可能挂载在已删除的 .tmp/tests/run-*/ 目录上，所有 bash 命令多输出一行警告，shell 工具的测试因此失败
metadata:
  type: project
---

**现象（2026-10-01 实测）**：每条 bash 命令先输出 `bash.exe: warning: could not find /tmp, please create!`；
`packages/server/src/workspace-changes.test.ts` 的 4 项「shell 的写入进变更页」全部失败，报「投递额度未开账」
（多出的 stderr 使 shell 工具进入投递分支，而测试未开账）。代码未修改时同样失败。

**成因**：MSYS 的挂载表在同一登录会话的所有 MSYS 进程间共享，`/tmp`（`usertemp`）取第一个初始化它的进程的 TEMP。
测试预载把 TEMP 设为 `.tmp/tests/run-*/…/.tmp` 并启动了 bash；若此时另有长期运行的 sh/bash（并行会话的脚本），
挂载表会一直保留，测试结束删除目录后 `/tmp` 就指向不存在的路径。

**处理**：用 `mount | grep tmp` 查看 `/tmp` 的指向，重建该目录即可（只是空目录，不影响其他会话）；
不要为此结束其他会话的 sh/bash 进程。所有 MSYS 进程都退出后挂载表自动重建。

**为什么**：门禁失败时容易误判为刚修改的代码导致。**用法**：门禁中 shell 相关测试突然失败、且 bash 输出带有这行警告时，先排查本条。
