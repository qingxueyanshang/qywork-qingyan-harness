---
name: ci-runner-has-no-rg
description: GitHub 的 CI 运行环境（ubuntu、windows、macos）没有 ripgrep，grep 自动改用内置遍历；断言 rg 引擎的用例须以 Bun.which('rg') 为前提
metadata:
  type: project
---

GitHub Actions 的三个平台运行环境中没有 `rg`，grep 工具改用内置遍历。本机装有 `rg`，断言 `engine` 为 `ripgrep` 的用例在本机通过、在 CI 失败，
发布工作流的门禁随之失败。

**Why:** 2026-11-21 发布 0.3.23 时，三个平台的发布门禁都因 `grep` 的三条用例（条数上限、单条上界、上下文行）断言 `ripgrep` 而失败；
这些用例在 11-18 提交，此后两天的提交没有经过 CI，直到发布时才暴露。

**How to apply:** 涉及两种搜索引擎的用例，rg 一侧的断言写成 `if (Bun.which('rg')) expect(...).toBe('ripgrep')`。
在本机模拟 CI：从 PATH 中去掉 rg 所在目录后运行 `bun run test <文件>`（直接 `bun test` 缺少预载，结果不可信）。
发布前积累了多次未推送的提交时，先推送并等 CI 通过，再修改 `VERSION`。
