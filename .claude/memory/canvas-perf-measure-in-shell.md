---
name: canvas-perf-measure-in-shell
description: 画布卡顿须在桌面外壳（WebView2、180Hz）中按用户布局测量；无头 Chrome 与窄面板都无法复现，瓶颈是 GPU 进程的光栅化
metadata:
  type: project
---

2026-10-19 排查「画布拖动非常卡」的结论：

- **无头 Chrome 无法复现**：同一画布不限帧率仍有 150–400 帧。外壳窗口默认的窄面板（约 380px、缩放 10%）同样无法复现。
  只有按用户截图的布局（右侧面板约 1550px、缩放 67%、长会话打开、两张卡生成中）在外壳中测量，才得到
  平移 106–143 帧、拖动节点 90–144 帧、超时帧 26–85%。
- **瓶颈是 GPU 进程**：180Hz 下每帧预算 5.6ms，修复前拖动与平移时 GPU 每帧 7–11ms，主线程只有 4–7ms。
  判断依据看 GPU 进程的 `ThreadControllerImpl::RunTask` 与每帧 `RasterTask` 数，不看主线程。
- 已修复的三处（`CanvasPanel.tsx` / `canvas.css`）：连线由 `For` 改为 `Index`，避免每次移动重建全部连线；
  网格点改为单独的合成层，平移变量不再写在画布区上；拖动时连到被拖节点的连线放入单独一层，其余连线层不修改。
  修复后同条件下全部场景 170–180 帧。
- 被推翻的推测：连线 SVG 为 1×1、依赖溢出绘制导致整层重绘。放大 SVG 尺寸但不移动位置时没有改善。

**Why:** 用户显示器 2560×1440、180Hz，开销按刷新率放大，见 [[continuous-animation-cost]]。

**How to apply:** 画布性能问题直接用 `.tmp/perf-drag/shell-drag.mjs`（`WIDE=1` 设置用户布局、`STUB=1` 使任务保持生成中、
`HOME_DIR=home-real` 配合 `copy-db.ts` 复制的数据库副本打开同一会话、`CSSV=1` 逐项注入样式对比）测量，
外壳 exe 与隔离方法见 [[tauri-webview-no-cdp]]。数据库副本含用户会话内容，测量结束即删除。
