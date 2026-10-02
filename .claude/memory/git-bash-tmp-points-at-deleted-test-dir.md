---
name: git-bash-tmp-points-at-deleted-test-dir
description: Git Bash 的 /tmp 可能挂在已删的 .tmp/tests/run-*/ 目录上，所有 bash 多打一行警告，shell 工具的测试因此失败
metadata:
  type: project
---

**现象（2026-10-01 实测）**：每条 bash 命令先打 `bash.exe: warning: could not find /tmp, please create!`；
`packages/server/src/workspace-changes.test.ts` 的 4 项「shell 的写入进变更页」全红，报「投递额度未开账」
（多出的 stderr 让 shell 工具走进投递分支，而测试没开账）。代码没改也会红。

**成因**：MSYS 的挂载表在同一登录会话的所有 MSYS 进程间共享，`/tmp`（`usertemp`）取第一个初始化它的进程的 TEMP。
测试预载把 TEMP 设成 `.tmp/tests/run-*/…/.tmp` 并起了 bash；若此时另有长期运行的 sh/bash（并行会话的脚本），
挂载表一直活着，测试结束删掉目录后 `/tmp` 就指向不存在的路径。

**处理**：`mount | grep tmp` 看 `/tmp` 指向哪里，把那个目录建回来即可（只是空目录，不影响别人）；
不要为此结束别的会话的 sh/bash 进程。所有 MSYS 进程都退出后挂载表自动重建。

**为什么**：门禁红了容易误判成刚改的代码引起的。**怎么用**：门禁里 shell 相关测试突然红、且 bash 输出带这行警告时，先查这条。
