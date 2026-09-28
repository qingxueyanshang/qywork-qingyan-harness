---
name: reference-agents-in-view-agent
description: 用户说「看看开源项目怎么弄的」指 C:\Users\Administrator\Desktop\view-agent 下的四个 agent 仓库；各自的定位与已核过的结论
metadata:
  type: reference
---

`C:\Users\Administrator\Desktop\view-agent` 下四个参照仓库（只读，出处只能写进 `docs/plans/*`，不进代码注释，见 CLAUDE.md B10）：

- `pi-main` —— pi（badlogic）上游，`packages/ai` 是多协议适配层，`packages/coding-agent` 是产品层。
- `prime-agent-main` —— pi 在 v0.74 分出的分叉，同类问题只看它与 pi 的差异。
- `cc-haha-main` —— Claude Code 系实现，`src/`；顶层 `adapters/` 是聊天平台桥，不是模型协议。
- `deepseek-harness-master` —— DeepSeek 官方 harness，`packages/llm/*`；DeepSeek 只走 Messages 协议。

2026-09-28 核过的共识：上下文读数四家都是「上次 输入+缓存+输出 + 其后 chars/4」，都同模型原样回传思考签名；
qywork 读数失真是没回传，不是公式（[[diagnose-from-the-local-db]]）。

**How to apply:** 调研分给只读子代理并行定位，关键行自己打开核对后才写进方案（A1）。
