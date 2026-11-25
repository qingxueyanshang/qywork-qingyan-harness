---
name: remote-canvas-timing-probe
description: 远程访问下画布卡片状态的时序实测：.tmp/probe/canvas-run 中的模拟视频接口、远程监听器代理与窄屏 WebKit 脚本
metadata:
  type: project
---

排查「手机远程访问时卡片状态不更新」一类问题时，用 `.tmp/probe/canvas-run/` 的脚本在隔离实例上实测，不在用户的实例上点击生成（会扣云端积分）。

- `prep.ts`：建立隔离数据目录与含视频生成卡的画布；`copy-real.ts`：复制用户的真实画布与其引用的文件，视频卡改用模拟型号。
- `mock.ts`：模拟 `openai_videos` 接口，提交请求保持 `HOLD_MS` 后才返回任务号，用于观察「提交中」。
  模拟型号须取目录中接受参考图的型号名（`doubao-seedance-2-5-260628`），否则带参考图的卡片在发送前被拒绝。
- `proxy.ts`：模拟远程监听器，JSON 响应经 `remoteTransfer`，HTTP 与事件流各加 `LAT` 毫秒；`STALL` 使生成开始后的画布读取额外延迟，
  `RUNLAG` 使运行的响应体晚于事件到达。不要用 Playwright 的 `page.route` 加延迟：启用路由后浏览器缓存失效，etag 路径不再经过。
- `run.mjs <token> <webkit|chromium> 0 <卡片序号>`（环境变量 `PORT`、`CANVAS`、`CARD`）：390×844 触屏打开画布、点生成，逐 200 ms 记录卡片阶段、接口请求与事件帧。
- `touch.mjs`：Chromium 经 CDP `Input.dispatchTouchEvent` 发送真实触摸序列，检查滑动与轻点。

2026-11-25 实测：单纯的延迟、etag 与 56 张卡的真实画布都不使卡片停滞；能复现的形状是运行状态的事件先于运行的响应体到达、发起的重新读取变慢时，
已到达的响应体被丢弃，卡片等到重新读取返回才更新。用户会话中 26 秒未更新的全部成因未在本机复现。见 [[probe-ui-with-isolated-instance]]。
