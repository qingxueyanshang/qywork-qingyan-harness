---
name: scratch-dir-shared-between-sessions
description: .tmp/scratch 由并行会话共用，提交说明等文件不要使用固定文件名；提交说明写入本会话私有的临时目录
metadata:
  type: project
---

`.tmp/scratch/` 是所有会话共用的目录（`CLAUDE_SCRATCHPAD` 指向它），并行会话会写入同名文件。
提交说明、待执行的脚本等在写入与使用之间可能被其他会话覆盖，因此不要使用 `commit-msg.txt` 这类固定名称：
写入本会话私有的临时目录（系统提示中的 scratchpad 路径），或文件名带上本次任务的主题。

**Why:** 2026-10-27 两个会话同时提交，本会话写入 `.tmp/scratch/commit-msg.txt` 后，另一会话写入同名文件，
`git commit -F` 读取到对方的说明，提交内容正确而说明错误，随后用 `git commit --amend --only -F` 改正（树不变，不纳入暂存区中的其他改动）。

**How to apply:** 与 [[partial-commit-shared-files]] 一起使用：按索引提交本会话的段，说明文件放在私有路径；提交后用 `git log -1` 核对说明。
