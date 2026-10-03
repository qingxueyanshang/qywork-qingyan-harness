---
name: timing-tests-fail-under-machine-load
description: followup / goal-loop / plugin e2e 中有 10s 上限的几条测试在机器 CPU 被其他应用占满时成批超时，不是回归
metadata:
  type: project
---

`packages/server/src/followup.test.ts`（收尾之后发起下一轮、注入当前这一轮）、`goal-loop.test.ts`、
插件端到端「声明了 process:exec 能跑」这几条各有 5–10 秒的等待上限。机器上 ChatGPT / 微信 /
dwm 把 CPU 占用推高到 90% 以上时，它们成批超时，全量套件耗时从 ~65 秒延长到 140–170 秒；负载降到 20% 以下时，
同一份代码全部通过（2026-09-03 实测三次）。

**Why:** 这些测试等待的是本地模拟 provider 的一轮往返加上 `setTimeout(0)` 的一次收尾回调，负载高时事件循环无法及时调度它们。
**How to apply:** 门禁失败时先查看套件总时长与 `Get-CimInstance Win32_Processor` 的 LoadPercentage；
时长翻倍且只有这几条计时测试失败时，待负载回落后再运行一次，不要修改测试或运行路径。
真正的回归会在低负载下稳定复现。
