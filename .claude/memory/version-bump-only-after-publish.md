---
name: version-bump-only-after-publish
description: 前一版本尚未在 GitHub 公开发布时不升 VERSION，新改动并入当前版本号及其版本说明
metadata:
  type: feedback
---

`VERSION` 只在前一版本已公开发布（GitHub Release 不再是草稿）之后才升级。
前一版本尚未发布时，新提交并入当前版本：本地打包、静默安装仍使用同一个版本号，
版本说明修改的是 `.github/release-notes/v<当前版本>.md`，不新建下一版本的说明。

**Why:** 2026-09-28 曾在 v0.1.20 未发布时起草 v0.1.21 的版本说明并准备修改 `VERSION`，
被用户纠正「.20 版本都还没有发布，别瞎搞」。

**How to apply:** 执行本地发布流程前先确认前一版本是否已公开发布（询问用户或查看 GitHub Releases）；
未发布时只重新打包并安装同一版本号。
