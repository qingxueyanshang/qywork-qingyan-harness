---
name: send-follow-probe
description: 发送消息后会话流位移的实测方法：模拟 Anthropic 流的本地服务、隔离实例与 .tmp/probe/send-pull 脚本；rAF 中逐帧读取布局本身会造成位移
metadata:
  type: project
---

2026-11-27 排查「发送后会话流被下推」所用的方法，脚本在 `.tmp/probe/send-pull/`（隔离实例的搭建见 [[probe-ui-with-isolated-instance]]）：

- `fake.ts`：模拟 Anthropic Messages 流的本地服务。第一轮返回长回复；之后每轮先流式输出思考 `THINK_MS` 毫秒再输出正文，
  `FIRST_BYTE_MS` 设定首字节之前的等待，用于复现真实模型首个内容到达前的阶段。`home/config.json` 只含该服务，不含真实 key。
- `probe-q.mjs`：新建会话取得第一轮长回复，粘贴两张图片、输入五行正文后发送，记录 scroll 事件与各时刻距底部的距离并截图；
  第 4 个参数为 `wheel` 时发送前先在底部继续向下滚动滚轮。`probe-hook.mjs` 给布局读取接口加钩子，记录滚动位置被收紧时的调用栈；
  `probe-cv.mjs` 注入样式取消用户消息行的 `content-visibility` 作对照。
- **不要以 `probe.mjs` 的逐帧记录定案**：它在 `requestAnimationFrame` 中读取布局，新建的行此时按 80px 占位参与布局，读取本身就会使浏览器收紧滚动位置。
  定案用 `probe-q.mjs`（不逐帧读取）与截图。

已确认的三个成因与对照结果：开始事件改写消息 id 使该行重建（取消 `content-visibility` 后位移消失）；滚轮意图不区分方向；
输入框测量高度时先设为 auto。修复前 `wheel` 情形发送后距底部 155px、思考结束后 252px，修复后全程为 0。

**Why:** 组件测试中没有浏览器布局，`content-visibility` 占位与滚动位置收紧只在真实浏览器中出现。
**How to apply:** 修改 `conversation-scroll.ts`、`TranscriptRows.tsx` 的行对象或输入框的高度计算后，`wheel` 与 `nowheel` 两种情形各执行一次 `probe-q.mjs`，
全程距底部为 0 后再报告已修复。触摸相关的修改另见 [[touch-scroll-probe]]。
