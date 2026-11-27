---
name: desktop-host-probe
description: 排查电脑控制的控件树问题时直接驱动 qy-computer-host 读树，不经过模型与服务端；脚本在 .tmp/scratch/devtools-tree/
metadata:
  type: project
---

宿主经标准输入输出收发按行分隔的 JSON：先发 `handshake`（`connectionTimeoutMs` / `transactionTimeoutMs`），再发
`list_windows`、`read_tree`、`act`。信封字段为 `id`、`deadline`、`hostId`、`hostEpoch`、`connectionEpoch`、`foreground`、`op`、`params`，
回执的结果在 `observation` 中（窗口清单含 `window`、`pid`、`title`、`className`）。请求样例见
`packages/core/src/protocol/native-desktop.samples.json` 的 `workerRequests`。

`.tmp/scratch/devtools-tree/probe.ts` 按标题或窗口类（`PROBE_PID` 限定进程）读树并统计节点数与角色分布，只读；
`activate.ts` 用指定的宿主可执行文件对窗口发送 `activate` 并前后各读一次。验证宿主改动时另行编译到独立产物目录
（如 `.tmp/cargo-main-host`），不要覆盖 `.tmp/cargo-gate` 与外壳使用的产物。

2026-11-27 用它复现：Chromium 内核的窗口从最小化还原后网页内容的控件树缺失（9 个节点），只有窗口尺寸改变才恢复。
宿主在自己还原窗口时已处理（`foreground.rs` 的 `relayout_restored`）；用户自行还原的窗口仍会出现该状态。

**How to apply:** 用户报告「控件读不到」「按名称等待超时」时，先用探针读一次树，与截图对照，再判断是应用的问题还是宿主的问题。
探针只读，派发动作前确认目标窗口是本次启动的测试窗口（全局记忆 probe-input-only-verified-window）。
