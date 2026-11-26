---
name: publish-release-via-api
description: 正式发布经 .tmp/scratch/release-api.ps1 调用 GitHub 接口触发三个发布工作流并公开草稿，本机没有 gh；Git Bash 中须设置 MSYS_NO_PATHCONV=1
metadata:
  type: reference
  modified: 2026-11-26
---

正式发布不需要 `gh`：`.tmp/scratch/release-api.ps1` 从 Git 凭据管理器（`git credential fill`）取得已保存的
GitHub 令牌，直接调用仓库接口。该脚本在 `.tmp/` 下、不入库；文件丢失时按下方接口自行调用。

**流程**（v0.3.6 实测）：

1. 确认前一版本已公开（见 [前一版本未发布时不升版本号](version-bump-only-after-publish.md)）。
2. 写 `.github/release-notes/v<版本>.md`，修改 `VERSION` 后执行 `bun run version:sync`，`bun run gate` 通过后
   提交 `chore(release): 发布 <版本>` 并推送 master。不需要手动打标签。
3. 对 `release-windows.yml`、`release-macos.yml`、`release-linux.yml` 各发送一次
   `POST /actions/workflows/<文件>/dispatches`，请求体 `{"ref":"master"}`；工作流只接受 master。
4. 三端成功后各自上传到同一个草稿 Release（18 个附件，含 `latest.json`）。核对附件与 `latest.json` 的版本后，
   `PATCH /releases/<id>`，请求体 `{"draft":false,"make_latest":"true"}`；公开时 GitHub 按草稿的提交创建标签。

整个过程约 40 分钟，macOS 常排队 15 分钟以上。

**易错点**：

- 从 PowerShell 工具调用时在当前会话中点源（`. .\.tmp\scratch\release-api.ps1 -Mode Call ...`），先设置编码；
  `powershell -File` 另起的进程不继承编码设置，`git credential fill` 失败，请求不会发出（0.3.27 实测）。
- 发布工作流在 macOS 与 Linux 上运行同一套门禁，本机 Windows 门禁不覆盖按平台分支的用例（0.3.27 因运行环境清单在 Linux 上多一行而失败）；
  改动含平台分支时，发版前在 WSL 中运行相关测试文件（见 [[linux-e2e-via-wsl]]）。
- 发布工作流在门禁之前先把 sidecar 打包进 `apps/desktop/src-tauri/bin/sidecar/`（内嵌网页），门禁中的外壳编译按其中的文件检查资源；
  本机门禁的 sidecar 写入 `.tmp/gate-sidecar`，覆盖不到。改动网页的静态资源（新增数据目录、文件名）后，发版前本机先运行
  `bun run build:agent` 再运行 `bun run typecheck:rust`（0.3.27 因 pdf.js 数据中没有扩展名的许可证文件在 Windows 上失败）。
- 从 Git Bash 调用时须设置 `MSYS_NO_PATHCONV=1`：`/actions/...` 这类参数会被改写为 Windows 路径，
  脚本以「Expected a repository-relative API path」拒绝，请求不会发出。
- PowerShell 须先把 `[Console]::InputEncoding`、`[Console]::OutputEncoding` 与 `$OutputEncoding` 设为无 BOM 的 UTF-8，
  否则 `git credential fill` 报「missing protocol field」。
- 触发与公开属于写入请求，失败后先读取 `/actions/runs` 或 `/releases` 确认远端状态，再决定是否重发，避免重复构建。
- 某一平台失败而其他平台已上传时，修复后只重新触发该平台：工作流按标签找到同一个草稿并追加附件。草稿的
  `target_commitish` 是最先建立草稿的构建所用的提交，公开时在同一个 `PATCH` 中写入最终提交
  （`"target_commitish":"<sha>"`），标签才包含全部附件的代码。只在修复不改变其他平台产物时这样做
  （仅限该平台的代码或测试，例如 `#[cfg(windows)]`）。v0.3.10 实测：Windows 门禁两次因按真实时间断言的用例失败，
  修复后单独重新触发 Windows，公开时把标签指向最终提交。
- 公开后不要在前台运行 `verify-desktop-release.ps1`：它下载全部 18 个附件（约 400 MB），本机到 GitHub 下载约 50–70 KB/s，
  需要两小时以上。run_command 只在无输出且进程不占用 CPU、不读写磁盘时才终止，下载持续写入磁盘，命令不会超时；
  输出又重定向到文件时界面没有任何进展，只显示运行中（v0.3.7 停滞了 79 分钟，由用户中断）。
  公开前后的核对改为不下载安装包：附件清单与前一个公开版本相同、全部 `uploaded`；只下载 `latest.json` 核对版本、链接与签名；
  公开后对各安装包的下载地址发送 HEAD 请求确认可访问。
  2026-11-21（v0.3.24）实测完整下载核对在 15 分钟内完成；网络状况变化时仍按上一条处理。
- `verify-desktop-release.ps1` 校验更新签名时调用 `.tmp/scratch/release-crypto.py verify <文件> <.sig> <公钥>`（只用公钥，
  minisign 格式的 Ed25519 签名，依赖本机 Python 的 `cryptography`）。该文件曾在清理 `.tmp` 时被删除，2026-11-21 重写，
  清理时保留它。
- 被点源的 `release-api.ps1` 带有 `param()`，调用方脚本中与其参数同名的变量（如 `$OutFile`）会被清空，调用方改用其他变量名。
- 构建失败时先读取失败任务的日志（`.tmp/scratch/fetch-job-log.ps1 -JobId <id> -Target <文件>`），区分代码导致的失败与运行环境的失败。
  后者以 `POST /actions/runs/<id>/rerun-failed-jobs` 只重新运行失败的任务：macOS 工作流的两个架构是两个任务，已成功并上传的任务不重新运行，
  草稿中的附件保留。v0.3.30 实测两例：Windows 门禁中 Bun 的测试进程崩溃（`worker crashed: exit code 0xC0000409`，全部断言通过），
  macOS x86_64 门禁通过后创建草稿时连接 GitHub 超时（`Connect Timeout Error`）；两者重新运行后均成功。
  等待运行结束用 `.tmp/scratch/wait-release-runs.ps1 -Ids <id,id>`（每 60 秒输出一次状态）。
- 调用 `.tmp/scratch/` 下这些脚本时，同样须先在当前会话中设置上述三项编码：脚本内部设置的 `$OutputEncoding` 只作用于脚本作用域，
  `git credential fill` 仍报「missing protocol field」（v0.3.30 实测）。
- 官网的下载清单地址是 `https://qywork.io/download/latest.json`（单数 `download`），由服务器每 10 分钟同步一次，
  同步记录在服务器的 `/opt/qywork-cloud/downloads/mirror.log`；同步后版本公告自动写入。
