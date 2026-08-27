---
name: local-installer-lands-in-tmp
description: 本地打包测试的安装包收进 .tmp/installer/，正式发布不走这条路而是 GitHub Actions 的草稿 Release
metadata:
  node_type: memory
  type: feedback
  modified: 2026-08-27
---

本地打包测试的产物落 `.tmp/installer/`，由 `bun run tauri:build` 末尾的
`scripts/collect-installer.ts` 自动收过去，不要留在 cargo 的 `target/` 里。

**为什么**：`target/` 下是构建中间物，且路径分两条——带 `--target` 落
`target/<三元组>/release/bundle/nsis`，不带落 `target/release/bundle/nsis`。
交付物散在两个地方，换个人打包就找不到。`.tmp/<用途>` 这条落点由 CLAUDE.md B6
规定、`scripts/temp-dir.test.ts` 在门禁里盯着。

**怎么用**：`bun run tauri:build` 打完自动收；只想收一次已有产物就单独跑
`bun run scripts/collect-installer.ts`。

**边界——这条只管本地测试包。** 正式发布走
`.github/workflows/release-windows.yml`：手动触发，跑版本检查与全量门禁，
由 tauri-action 直接建 GitHub 草稿 Release 并传 `SHA256SUMS.txt`，全程不经过
`.tmp/`。**不要拿本地这份 exe 当发布产物**——它没有校验文件、没有 tag、没走门禁。
发布步骤见 `docs/releasing.md`。
