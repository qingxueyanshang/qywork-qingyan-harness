---
name: desktop-live-runs-can-type-into-this-session
description: 电脑控制真机任务中被测模型会操作任何已打开的窗口，2026-09-24 因此丢失过一次主会话、改变过用户 Edge 的当前页
metadata:
  type: project
---

在真机上运行电脑控制任务（`.tmp/scratch/batch5/run-task.ts --foreground`）时，被测模型可能使用它能看到的任何窗口：2026-09-24 GPT-6 Sol 向运行 Claude Code 的 Windows Terminal 输入命令和 `exit`，主会话退出；安装态的 Edge 样本将用户自己 Edge 的当前页导航到别的页面；设置样本借用用户的 Edge 与资源管理器按 Win+I，并将资源管理器从最大化改为还原。

**Why:** 模型知道窗口属于用户也不能阻止这一行为（重放中向终端输入的比例仍约为 10%）；模型需要一个能接收输入的位置时，会借用任意已打开的窗口。

**How to apply:** 运行真机任务前确认 `run-task.ts` 的 `installTerminalHide` 与 `userWindowHandles` 仍然存在：开始运行前已打开的窗口全部经 `BATCH5_HIDDEN_HANDLES` 从被测模型的窗口清单中移除。安装态（`--installed`）无法修改后端，只能隐藏终端，因此安装态不运行 Edge 任务。「正在运行的终端」用 conhost 诱饵测试。运行结束后用 `.tmp/scratch/terminal-awareness/scan-touched.ts` 检查是否操作了任务以外的窗口。任务会接管前台鼠标与键盘。相关：[[probe-ui-with-isolated-instance]]
