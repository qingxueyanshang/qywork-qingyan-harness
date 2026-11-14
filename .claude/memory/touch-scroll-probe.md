---
name: touch-scroll-probe
description: 会话流的触摸滑动与底部跟随须用真实触摸序列实测后再报告已修复；实测脚本在 .tmp/probe/touch-follow.mjs 与 touch-static.mjs
metadata:
  type: project
---

修改 `apps/web/src/components/Transcript.tsx` 的 `createConversationScroll` 后，先用隔离实例实测，再报告结果。
组件测试中手工派发的 scroll 事件不含浏览器的时序：scroll 事件晚于写入一帧派发，其间内容增高会改变读到的距离。

- 实测脚本：`.tmp/probe/touch-follow.mjs`（每 40ms 追加一行，向上滑动后再滑回底部，统计被写回底部与跟随未恢复的次数）、
  `.tmp/probe/touch-static.mjs`（静止内容下逐帧记录与手势方向相反的位移）。启动方式见 [[probe-ui-with-isolated-instance]]，
  视口 390×800 并开启 `hasTouch` 与 `isMobile`。隔离实例首屏是账号登录页，点击「使用自己的 API key」后再关闭设置页。
- 触摸用 CDP 的 `Input.dispatchTouchEvent` 逐点发送。`Input.synthesizeScrollGesture` 在无头模式下不派发 `touchmove`，
  也不滚动，不能据它判断事件顺序。
- 对照旧版本时不切换工作区：把旧版本文件写到 `components/` 下的临时文件名，用 `page.route` 把 `Transcript.tsx` 的请求
  替换为该文件，实测后删除。

**Why:** 2026-11-14 第一次修改只有组件测试，未实测即报告已修复，用户反馈问题加重；实测后确认失败形状是
「内容增加期间滑回底部后跟随不恢复」，与最初的推断不同。

**How to apply:** 两个脚本的结果都为 0 次失败后才报告已修复；无法在真实手机上验证时在回复中写明。
