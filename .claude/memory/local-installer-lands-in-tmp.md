---
name: local-installer-lands-in-tmp
description: 本地打包测试的安装包收集到 .tmp/installer/；正式发布不经过此路径，而是通过 GitHub Actions 的草稿 Release
metadata:
  node_type: memory
  type: feedback
  modified: 2026-08-27
---

本地打包测试的产物放在 `.tmp/installer/`，由 `bun run tauri:build` 末尾的
`scripts/collect-installer.ts` 自动收集，不要留在 cargo 的 `target/` 中。

**为什么**：`target/` 下是构建中间产物，且路径有两种：带 `--target` 时位于
`target/<三元组>/release/bundle/nsis`，不带时位于 `target/release/bundle/nsis`。
交付物分散在两处，换人打包时就无法找到。`.tmp/<用途>` 这一位置由 CLAUDE.md B6
规定，由 `scripts/temp-dir.test.ts` 在门禁中检查。

**用法**：`bun run tauri:build` 打包完成后自动收集；只需收集一次已有产物时单独运行
`bun run scripts/collect-installer.ts`。

**边界：本条只适用于本地测试包。** 正式发布使用
`.github/workflows/release-windows.yml`：手动触发，执行版本检查与全量门禁，
由 tauri-action 直接创建 GitHub 草稿 Release 并上传 `SHA256SUMS.txt`，全程不经过
`.tmp/`。**不要把本地这份 exe 当作发布产物**：它没有校验文件、没有 tag、未经过门禁。
发布步骤见 `docs/releasing.md`。
