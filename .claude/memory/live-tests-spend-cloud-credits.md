---
name: live-tests-spend-cloud-credits
description: 用真实模型做对照实测会扣用户的云端积分；先估算积分、查余额，优先用 DeepSeek V4.1 Flash 或 GPT-6.1 Terra
metadata:
  type: feedback
---

用 `loadConfig()` 加真实模型运行的实测脚本（如 `scripts/context-scale-live.ts` 的写法）经云端接口扣用户的积分。
2026-11-25 用 Claude Opus 5.5 做读取方式对照实验，24 次运行消耗约 30 积分，余额变为负数，用户自己的会话随即被拒（HTTP 402）。
用户随后要求换便宜的模型：DeepSeek V4.1 Flash 与 GPT-6.1 Terra 两组各 12 次共消耗约 1.6 积分，同样测出了差别。
同日补测（「先完整读一遍，梳理第 1–60 章」）估算 4–5 积分，实际 24.8 积分：Terra 在 18 次运行中自行开出 55 个子代理会话，
子代理的 620 次请求占 23.3 积分；累计输入上限只统计主会话，余额耗尽，3 次运行以 HTTP 402 中断。

**Why:** 积分是用户的钱，余额耗尽会中断用户正在进行的工作；读取、收纳这类程序侧机制与模型无关，便宜的模型同样能测出效果。

**How to apply:** 启动前写明估算积分并经云端账本（`balance` 表）查余额；默认用 DeepSeek V4.1 Flash 或 GPT-6.1 Terra，
只有被测行为依赖模型能力时才用 Opus；运行中设累计输入上限，事后按 `provider_requests.cloud_request_id` 对 `ledger` 核对实际扣费。
上限与核对都按实验数据库中的全部运行计算（含 `parent_conversation_id` 不为空的子代理会话），不按主会话的 run 计算；
要求通读大文件、梳理大范围内容的题目会诱发子代理并行读取，估算时按子代理数倍计入，或在实验中不提供子代理与工作流工具。
