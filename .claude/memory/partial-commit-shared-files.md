---
name: partial-commit-shared-files
description: 与并行会话修改了同一批文件时只提交本会话的段：按内容判定归属、从 HEAD 构造内容写入索引、临时工作树自检、按索引提交（不能带 pathspec）
metadata:
  type: project
---

**情形（2026-10-02，`6d017648`）**：并行会话同时在修改 `server/canvas.ts`、`core/domain/canvas.ts`、`GeneratePanel.tsx`、`canvas.css`、
`core/index.ts`、`core/domain/canvas.test.ts`，双方的改动交错在同一个文件中。

**做法**：
1. 逐段判定归属要**按内容**，不要按编号：对方在「列出」与「暂存」之间再次修改了文件，编号整体错位过一次，把对方的一行带入了索引。
   脚本 `.tmp/scratch/stage-hunks.ts`（`--dry` 先查看判定结果）：从 `git show HEAD:<path>` 出发，只应用本会话的 -U0 段，用 `hash-object -w` + `update-index --cacheinfo` 写入索引，工作区不变。
2. 双方插入在同一位置的改动会被归为同一段（`canvas.test.ts` 即属此类），这种情况直接从 HEAD 构造内容（`.tmp/scratch/stage-core-test.ts`）。
3. 核对：`git diff --cached` 逐段检查，再用 `git commit-tree` + `git worktree add --detach .tmp/<dir>` 将索引单独检出，`bun install`、typecheck、biome、`bun run test` 全部通过后才提交。
4. **提交按索引，不带 pathspec**：`git commit -- <paths>` 取的是工作区中这些文件的全文，会把对方的段一并提交。
   同一条命令中先核对 `git diff --cached --name-only` 的数目以及对方关键词计数为 0，再执行 `git commit`。

**Why:** CLAUDE.md F 节的「带 pathspec 点名提交」是为了避免一并提交他人暂存的文件；同一个文件中双方都有改动时，pathspec 反而会把对方的段一并提交。

**How to apply:** 提交前 `git status` 中出现本会话未修改过的文件时，先检查本会话的文件中是否有对方的段（用 `git diff -U0` 查看内容），有则按上述流程处理。
临时工作树中 esbuild / rollup 的二进制文件与主仓库是硬链接，开发实例运行时无法删除，留在 `.tmp` 中不影响使用。关联 [[no-git-stash-in-shared-worktree]]。
