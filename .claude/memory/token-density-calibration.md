---
name: token-density-calibration
description: 新增或补测型号的估算系数（文字、图片、视频）用 .tmp/ctx-probe 下的实测脚本；Claude 中转要直连读首个事件，Qwen 要关闭思考
metadata:
  type: project
---

`ModelSpec.density`（十项词法系数与图片规则）按实测拟合，2026-10-27 测了 7 档；Gemini 3.x Flash、Claude Fable 5.1、MiMo 因中转限速或余额不足未测，使用默认档。

步骤：`bun run .tmp/ctx-probe/run-all.sh <接口名> <模型>`（真实会话样本与 8 种尺寸图片）→ `density-extra.ts`（生僻字、其他字符、每条消息开销）→ `features.ts` → `fit5.py`（文字）与 `fit_images.py`（图片）→ `build-fixture.ts` 更新 `packages/ai/src/fixtures/token-samples.json`。

**Why:** 默认档按各项最大值取，未测型号的读数偏高；系数随 tokenizer 变化，不能按名称推断为同一档。

**How to apply:**
- Anthropic 协议经适配器时要等模型思考完毕，每次约两分钟；`direct.ts` 直接请求，读到 `message_start` 的输入用量即结束，约 6 秒。
- zhende.ai 的 Claude 中转在每个请求前注入约 8600 token 隐藏系统提示，按「减去基线」计算时抵消；它还会拦截随机生僻字与「第N条」交替消息，Claude 用 `claude-extra.ts` 补测。
- qwen3.8-flash 不受 max_tokens 限制，长样本要思考数分钟；设 `NO_THINKING=1` 走关闭思考的直接请求。
- 视频规则（`TokenDensity.video`）用 `.tmp/ctx-probe/video-probe.ts <接口名> <模型>` 实测，视频由 imageio_ffmpeg 的 ffmpeg 以 testsrc2 生成到 `.tmp/ctx-probe/vid/`，`fit_video.py` 拟合。百炼的 data URI 单项上限 50 MB，更大的视频经适配器以路径发送（自动上传）；Qwen 拒收短于 2 秒的视频。合成视频的时长是整数秒，帧数取整方式只能用真实成片核对：`real-probe.ts <接口名> <模型>` 读取 `.tmp/ctx-probe/real/` 下的成片副本，与估算逐段比较。
- 回执准入的判定线（`turn-end.ts` 的 `inputLimit`）依赖这些系数的偏差，系数大幅变化后复核该线。相关：[[relay-catalog-no-mention-syntax]]
