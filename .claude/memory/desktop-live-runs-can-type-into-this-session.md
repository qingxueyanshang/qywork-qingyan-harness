---
name: desktop-live-runs-can-type-into-this-session
description: 电脑控制真机任务里被测模型会操作开着的任何窗口，2026-09-24 因此丢过一次主会话、改过用户 Edge 的当前页
metadata:
  type: project
---

真机跑电脑控制任务（`.tmp/scratch/batch5/run-task.ts --foreground`）时，被测模型看得到的窗口它都可能拿来用：2026-09-24 GPT-6 Sol 往运行 Claude Code 的 Windows Terminal 输入命令和 `exit`，主会话退出；安装态的 Edge 样本把用户自己 Edge 的当前页导航走；设置样本借用户的 Edge、资源管理器按 Win+I，还把资源管理器从最大化改成还原。

**Why:** 知道窗口是用户的并不能阻止它（重放里往终端输入仍有约 10%）；模型需要一个能收输入的地方时，会借任意开着的窗口。

**How to apply:** 跑真机任务前确认 `run-task.ts` 的 `installTerminalHide` 与 `userWindowHandles` 还在——开跑前已开着的窗口全部经 `BATCH5_HIDDEN_HANDLES` 从被测模型的窗口清单里去掉。安装态（`--installed`）改不到后端，只能隐藏终端，所以安装态不跑 Edge 任务。「正在运行的终端」用 conhost 诱饵测。跑完用 `.tmp/scratch/terminal-awareness/scan-touched.ts` 扫一遍有没有动到任务以外的窗口。任务接管前台鼠标键盘。相关：[[probe-ui-with-isolated-instance]]
