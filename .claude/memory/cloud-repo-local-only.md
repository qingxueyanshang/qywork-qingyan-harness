---
name: cloud-repo-local-only
description: 云端仓库 qywork-cloud 只用本地 git，不推送、不创建远程；用户未要求时不构建安装包
metadata:
  type: feedback
---

云端服务的代码位于 `Desktop\qywork-cloud`（与 qywork 同级的独立仓库），只在本地提交，不推送到 GitHub，也不创建远程仓库。
未经用户要求不构建安装包（不执行 `tauri:build`）；服务器由用户自行准备，未准备好之前只做不依赖服务器的部分。

**Why:** 用户 2026-11-01 明确要求「云端代码不需要推送 github，以后不要再反复问，本地 git 就行」「安装包你不要构建」。
此前回复中两次询问私有远程与是否构建安装包，用户认为是重复询问。

**How to apply:** 云端提交只用本地 `git commit`；进度说明与方案中不再列出「创建私有仓库」「构建安装包」作为待用户提供的事项。
需要真机验证时说明验证方式，不主动打包。参见 [[commercial-cloud-standalone-accounts]]。
