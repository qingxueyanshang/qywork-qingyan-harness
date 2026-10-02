---
name: partial-commit-shared-files
description: 与并行会话改了同一批文件时只提交自己的段：按内容判段、从 HEAD 构造写进索引、临时工作树自检、按索引提交（不能带 pathspec）
metadata:
  type: project
---

**情形（2026-10-02，`6d017648`）**：并行会话同时在改 `server/canvas.ts`、`core/domain/canvas.ts`、`GeneratePanel.tsx`、`canvas.css`、
`core/index.ts`、`core/domain/canvas.test.ts`，两边的改动交错在同一个文件里。

**做法**：
1. 逐段判归属要**按内容**，不要按编号：对方在「列出」与「暂存」之间又改了文件，编号整体错位过一次，把对方的一行带进了索引。
   脚本 `.tmp/scratch/stage-hunks.ts`（`--dry` 先看判定）：从 `git show HEAD:<path>` 出发，只套本会话的 -U0 段，`hash-object -w` + `update-index --cacheinfo` 写进索引，工作区不动。
2. 两边插在同一个位置的会被归成同一段（`canvas.test.ts` 就是），这种直接从 HEAD 构造内容（`.tmp/scratch/stage-core-test.ts`）。
3. 核对：`git diff --cached` 逐段过目，再 `git commit-tree` + `git worktree add --detach .tmp/<dir>` 把索引单独检出，`bun install`、typecheck、biome、`bun run test` 都过了才提交。
4. **提交按索引，不带 pathspec**：`git commit -- <paths>` 取的是工作区里这些文件的全文，会把对方的段一起带走。
   同一条命令里先核对 `git diff --cached --name-only` 的数目与对方关键词为 0，再 `git commit`。

**Why:** CLAUDE.md F 节的「带 pathspec 点名提交」是为了不卷走别人暂存的文件；同一个文件里两边都有改动时 pathspec 反而会卷走对方的段。

**How to apply:** 提交前 `git status` 出现自己没碰过的文件时，先查自己的文件里有没有对方的段（`git diff -U0` 看内容），有就走上面的流程。
临时工作树里 esbuild / rollup 的二进制与主仓库是硬链接，开发实例运行时删不掉，留在 `.tmp` 里不影响。关联 [[no-git-stash-in-shared-worktree]]。
