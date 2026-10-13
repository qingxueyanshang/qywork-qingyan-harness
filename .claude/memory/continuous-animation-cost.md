---
name: continuous-animation-cost
description: 常驻动画只能动 transform / opacity；用户显示器 180Hz，重绘型动画的开销是 60Hz 实测值的三倍；测量方法为隔离实例 + SystemInfo.getProcessInfo
metadata:
  type: project
---

用户主显示器为 2560×1440、180Hz。动画 `stroke-dashoffset`、`background-position`、`background-color`
这类属性不能由合成线程执行，每一帧都在主线程重绘，并重新光栅化该区域内同一图层的全部内容。

2026-10-13 实测：画布三张视频卡生成期间，连线的 `stroke-dashoffset` 流动动画使 WebView 渲染进程与
GPU 进程各占约 45% 单核；隔离实例中 60Hz 下为渲染 10–13%、GPU 30–41%，去掉该动画后为 1.2% / 1.6%
（剩余部分是 `transform` 驱动的生成中方块）。已删除该动画，生成中的连线改为静态虚线。

**Why:** 动画面积越大、下方图片越多，每帧光栅化成本越高；刷新率再乘以三。
**How to apply:** 常驻或长时间运行的动画只用 `transform` / `opacity`。会话工作流图的 `wf-edge`
（transcript.css）仍是同类写法，面积较小，尚未测量。
测量脚本：`.tmp/perf-canvas/perf.mjs`（隔离服务 + 画布副本 + 无头 Chromium，浏览器级 CDP
`SystemInfo.getProcessInfo` 取各进程 cpuTime，注入样式逐项关闭动画对比）。见 [[probe-ui-with-isolated-instance]]。
