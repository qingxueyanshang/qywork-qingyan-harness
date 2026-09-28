---
name: version-bump-only-after-publish
description: 上一版还没在 GitHub 公开发布时不升 VERSION，新改动并进当前版本号与它的版本说明
metadata:
  type: feedback
---

`VERSION` 只在上一版已经公开发布（GitHub Release 不再是草稿）之后才往上升。
上一版还没发布时，新提交并进当前版本：本地打包、静默安装仍用同一个版本号，
版本说明改的是 `.github/release-notes/v<当前版本>.md`，不新建下一版的说明。

**Why:** 2026-09-28 我在 v0.1.20 未发布时起草了 v0.1.21 的版本说明、准备改 `VERSION`，
被用户纠正「.20 版本都还没有发布，别瞎搞」。

**How to apply:** 走本地发布流程前先确认上一版是否已公开发布（问用户或看 GitHub Releases）；
没发布就只重新打包安装同一版本号。
