---
name: publish-release-via-api
description: 正式发布经 .tmp/scratch/release-api.ps1 调用 GitHub 接口触发三个发布工作流并公开草稿，本机没有 gh；Git Bash 中须设置 MSYS_NO_PATHCONV=1
metadata:
  type: reference
  modified: 2026-10-27
---

正式发布不需要 `gh`：`.tmp/scratch/release-api.ps1` 从 Git 凭据管理器（`git credential fill`）取得已保存的
GitHub 令牌，直接调用仓库接口。该脚本在 `.tmp/` 下、不入库；文件丢失时按下方接口自行调用。

**流程**（v0.3.6 实测）：

1. 确认前一版本已公开（见 [前一版本未发布时不升版本号](version-bump-only-after-publish.md)）。
2. 写 `.github/release-notes/v<版本>.md`，修改 `VERSION` 后执行 `bun run version:sync`，`bun run gate` 通过后
   提交 `chore(release): 发布 <版本>` 并推送 master。不需要手动打标签。
3. 对 `release-windows.yml`、`release-macos.yml`、`release-linux.yml` 各发一次
   `POST /actions/workflows/<文件>/dispatches`，请求体 `{"ref":"master"}`；工作流只接受 master。
4. 三端成功后各自上传到同一个草稿 Release（18 个附件，含 `latest.json`）。核对附件与 `latest.json` 的版本后，
   `PATCH /releases/<id>`，请求体 `{"draft":false,"make_latest":"true"}`；公开时 GitHub 按草稿的提交创建标签。

整个过程约 40 分钟，macOS 常排队 15 分钟以上。

**易错点**：

- 从 Git Bash 调用时须设置 `MSYS_NO_PATHCONV=1`：`/actions/...` 这类参数会被改写为 Windows 路径，
  脚本以「Expected a repository-relative API path」拒绝，请求不会发出。
- PowerShell 须先把 `[Console]::InputEncoding`、`[Console]::OutputEncoding` 与 `$OutputEncoding` 设为无 BOM 的 UTF-8，
  否则 `git credential fill` 报「missing protocol field」。
- 触发与公开属于写入请求，失败后先读取 `/actions/runs` 或 `/releases` 确认远端状态，再决定是否重发，避免重复构建。
