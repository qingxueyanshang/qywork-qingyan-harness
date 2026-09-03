---
name: timing-tests-fail-under-machine-load
description: followup / goal-loop / plugin e2e 那几条 10s 上限的测试在机器 CPU 被别的应用占满时成片超时，不是回归
metadata:
  type: project
---

`packages/server/src/followup.test.ts`（收尾之后的火发、注入当前这一轮）、`goal-loop.test.ts`、
插件端到端「声明了 process:exec 能跑」这几条各有 5–10 秒的等待上限。机器上 ChatGPT / 微信 /
dwm 把 CPU 顶到 90% 以上时它们成片超时，全量套件从 ~65 秒拖到 140–170 秒；负载回到 20% 以下
同一份代码全绿（2026-09-03 实测三次）。

**Why:** 这些测试等的是本地假 provider 的一轮往返加 `setTimeout(0)` 的收尾一拍，负载高时事件循环排不上。
**How to apply:** 门禁红了先看套件总时长与 `Get-CimInstance Win32_Processor` 的 LoadPercentage；
时长翻倍且只有这几条计时测试红，等负载回落再跑一次，不要去改测试或改运行路径。
真正的回归会在低负载下稳定复现。
