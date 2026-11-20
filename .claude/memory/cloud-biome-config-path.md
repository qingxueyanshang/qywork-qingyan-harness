---
name: cloud-biome-config-path
description: 格式化云端仓库的文件必须以 --config-path 指定公开仓库的 biome.json；云端仓库根目录没有该文件，直接运行会按默认配置重排整个文件
metadata:
  type: project
---

云端仓库（`Desktop\qywork-cloud`）没有自己的 `biome.json`，门禁（`scripts/gate.ts`）以 `--config-path ../qywork/biome.json` 调用公开仓库的 biome。
在云端仓库中直接运行 `../qywork/node_modules/.bin/biome format --write <文件>` 时使用默认配置，整个文件按默认缩进与换行重排；
之后再以正确的配置格式化也无法恢复原有的换行，差异中混入数千行无关改动。

**Why:** 2026-11-20 修改网关报错时出现过一次：5 个文件的差异由 84 行扩大到 5000 余行，只能从提交还原后重新应用改动。

**How to apply:** 在云端仓库格式化或检查时写 `../qywork/node_modules/.bin/biome format --write --config-path ../qywork/biome.json <文件>`；
格式化之后先看 `git diff --stat`，行数明显超出本次改动时立即从提交还原。相关：[[cloud-repo-local-only]]
