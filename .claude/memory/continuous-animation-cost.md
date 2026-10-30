---
name: continuous-animation-cost
description: 常驻动画只能动 transform / opacity；重绘开销随条数增长的效果改由 WebGL 绘制（画布流动虚线即如此）；用户显示器 180Hz，CSS 动画开销是 60Hz 实测值的三倍
metadata:
  type: project
---

用户主显示器为 2560×1440、180Hz。CSS 动画按窗口所在显示器的刷新率逐帧更新；`stroke-dashoffset`、
`background-position`、`background-color` 不能由合成线程执行，每一帧都在主线程重绘并重新光栅化。

2026-10-13 实测：画布三张视频卡生成期间，连线的 `stroke-dashoffset` CSS 动画使 WebView 渲染进程与
GPU 进程各占约 45% 单核。隔离实例（模型桩真实启动三张卡，60Hz）：CSS 动画为渲染 10–12%、GPU 34–38%；
改为定时器每秒 24 次写入 `--canvas-flow` 并让连线层 `will-change: transform` 单独成层后为 5–6% / 10–12%，
且不随刷新率增长。根变量与逐条写入两种写法开销相同。

2026-10-30 实测（《寄给今天》118 张卡、12 张视频卡生成、138 条流动连线，用户布局：深色主题、缩放 32%、整张画布在视野内）：
定时器写法仍使 GPU 进程约 103% 单核、画布每秒 9 帧；只有 3 张卡生成（35 条）时也有约 70%。开销来自 GPU 进程
（CrGpuMain）光栅化抗锯齿的虚线曲线：每次推进都重画经过的全部图块，随可见的流动连线数增长。对照：停止推进约 0.3%；
去掉虚线每帧约 5ms；关闭抗锯齿（`shape-rendering: optimizeSpeed`）约 17% 但出现锯齿；改线宽、改用缩放线宽均无改善。
生成中卡片的 `canvas-snake` 动画使每一帧都提交，与推进叠加后帧率降到个位数；单独存在时开销可以忽略。
修复为 WebGL 绘制流动虚线（`apps/web/src/components/canvas/Flow.tsx`）：连线层的 SVG 在生成期间不再修改
（修复前每秒 3312 次属性修改），12 张卡与 3 张卡均为 GPU 进程约 5–7%、每秒 180 帧。外观与原写法逐项对照一致：
连线层的缩放是 `<svg>` 上的 CSS 变换，`vector-effect: non-scaling-stroke` 不抵消它，线宽与虚线都随缩放变化。

**Why:** 用户要求保留流动效果并优化，不接受直接删除动画（2026-10-13 删除后被追问，已恢复）。
**How to apply:** 视觉效果先保留，用合成线程属性或 GPU 绘制降低开销；删除视觉效果前先问用户。
判断是否需要换绘制方式时，按用户实际布局（缩放、主题、生成卡数）测量，不按少量卡片的结果外推。
会话工作流图的 `wf-edge`（transcript.css）仍是 `stroke-dashoffset` 重绘写法，面积较小，尚未测量。
测量方法见 [[canvas-perf-measure-in-shell]]。
