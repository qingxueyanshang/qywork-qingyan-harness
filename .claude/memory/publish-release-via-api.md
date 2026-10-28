---
name: publish-release-via-api
description: 正式发布经 .tmp/scratch/release-api.ps1 调用 GitHub 接口触发三个发布工作流并公开草稿，本机没有 gh；Git Bash 中须设置 MSYS_NO_PATHCONV=1
metadata:
  type: reference
  modified: 2026-10-28
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
- 公开后不要在前台运行 `verify-desktop-release.ps1`：它下载全部 18 个附件（约 400 MB），本机到 GitHub 下载约 50–70 KB/s，
  需要两小时以上。run_command 只在无输出且进程不占用 CPU、不读写磁盘时才终止，下载一直写盘，命令不会超时；
  输出又重定向到文件时界面没有任何进展，用户只看到一直在运行（v0.3.7 卡了 79 分钟，由用户中断）。
  公开前后的核对改为不下载安装包：附件清单与前一个公开版本相同、全部 `uploaded`；只下载 `latest.json` 核对版本、链接与签名；
  公开后对各安装包的下载地址发 HEAD 请求确认可访问。
