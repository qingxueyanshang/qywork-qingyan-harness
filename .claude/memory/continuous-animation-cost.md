---
name: continuous-animation-cost
description: 常驻动画只能动 transform / opacity，重绘型效果改用固定频率定时器；用户显示器 180Hz，CSS 动画开销是 60Hz 实测值的三倍；测量方法为隔离实例 + SystemInfo.getProcessInfo
metadata:
  type: project
---

用户主显示器为 2560×1440、180Hz。CSS 动画按窗口所在显示器的刷新率逐帧更新；`stroke-dashoffset`、
`background-position`、`background-color` 不能由合成线程执行，每一帧都在主线程重绘并重新光栅化。

2026-10-13 实测：画布三张视频卡生成期间，连线的 `stroke-dashoffset` CSS 动画使 WebView 渲染进程与
GPU 进程各占约 45% 单核。隔离实例（模型桩真实启动三张卡，60Hz）：CSS 动画为渲染 10–12%、GPU 34–38%；
改为定时器每秒 24 次写入 `--canvas-flow` 并让连线层 `will-change: transform` 单独成层后为 5–6% / 10–12%，
且不随刷新率增长。根变量与逐条写入两种写法开销相同。

**Why:** 用户要求保留流动效果并优化，不接受直接删除动画（2026-10-13 删除后被追问，已恢复）。
**How to apply:** 视觉效果先保留，用固定频率或合成线程属性降低开销；删除视觉效果前先问用户。
会话工作流图的 `wf-edge`（transcript.css）仍是同类写法，面积较小，尚未测量。
测量脚本在 `.tmp/perf-canvas/`：`variants.mjs`（注入样式对比各方案）、`verify.mjs`（连接
`.tmp/canvas-check/stub.ts` 模型桩真实启动生成）。见 [[probe-ui-with-isolated-instance]]。
