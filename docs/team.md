# 子 Agent、Graph 与外部 CLI

一个子任务使用 `subagent`；多个子任务或需要检查点审查的任务使用 `workflow`。
两者都异步派发：调用返回派发结果，任务完成或失败后，回执作为消息送回主会话。

日常使用只需在会话中说明分工。下面的 JSON 是 Agent 调用工具的参数示例，不是要求用户手动运行的命令。

## 子 Agent 与续接

| 种类 | 作用 |
|---|---|
| `temp` | 临时子 Agent，无需预先定义角色，填写 `name` |
| `role` | 使用项目中配置的角色，填写 `role` |
| `cli` | 调用本机识别到的外部 Agent CLI，填写 `cli` |

内置子 Agent 有自己的上下文，不会自动看见主会话全部内容；派发时应在 `task` 中给足背景。

首次调用 `subagent`：

```json
{
  "kind": "temp",
  "name": "代码审查",
  "task": "检查工作区本次改动，只报告问题，不修改文件"
}
```

回执包含 `subagentId`。继续交给同一个子 Agent 时，填入 `subagent`：

```json
{
  "subagent": "<上次返回的 subagentId>",
  "task": "继续核实刚才报告的第一个问题"
}
```

续接不再填写 `kind / role / name / cli`，也不重新指定模型。
主会话有未完成待办时，单个子任务还需用 `parentTodo` 关联对应待办；子任务完成不自动替主会话验收。

## 不同模型分工

新建内置子 Agent 时，可以成对填写 `provider` 与 `model`，使用已配置的服务和模型。
参数须取自运行上下文的模型清单；只在任务文字里写模型名不构成模型选择。

模型选择顺序：**本次明确指定 > 角色配置 > 当前会话 > 配置默认值**。
已有子 Agent 续接时沿用原会话模型；外部 CLI 使用它自己的模型与账号，不接受这两个参数。

## Graph：并行、依赖与审查

Agent 根据任务生成 DAG，不需要提前在项目配置里写固定流程。
下面是 `workflow` 的首次调用示例：两个分析节点并行，审查后实施，最后验收。

```json
{
  "goal": "分析并修复前后端接口不一致的问题",
  "nodes": [
    { "id": "frontend", "kind": "temp", "name": "前端分析", "task": "分析前端接口调用，不修改文件" },
    { "id": "backend", "kind": "temp", "name": "后端分析", "task": "分析后端接口实现，不修改文件" },
    { "id": "review", "kind": "checkpoint", "label": "审查分析", "needs": ["frontend", "backend"] },
    { "id": "fix", "kind": "temp", "name": "实施修改", "task": "根据上游分析修复并测试", "needs": ["review"] },
    { "id": "accept", "kind": "checkpoint", "label": "验收", "needs": ["fix"] }
  ],
  "maxConcurrent": 2
}
```

各内置 Agent 节点均可分别指定 `provider / model`，组成跨模型任务图。

- `needs` 定义依赖；互不依赖且已就绪的节点按 `maxConcurrent` 并行，超过上限的节点排队。
- 上游输出默认传给下游；`{input}` 可指定插入位置，`passInput: false` 则只保留执行顺序。
- 同一批并行节点共用检查点，检查点串成一条链；每个 Agent 节点必须位于某个检查点上游。
- 到检查点后，由**主 Agent**核验回执，再调用 `workflow` 作出裁决，不是自动弹出用户审批框。
- Graph 显示依赖与节点状态；内置子 Agent 可打开独立会话查看执行过程。

批准下一批：

```json
{
  "workflowId": "<首次返回的 workflowId>",
  "checkpointId": "review",
  "decision": "approve",
  "note": "分析已核实，继续实施"
}
```

要求指定节点返工：

```json
{
  "workflowId": "<首次返回的 workflowId>",
  "checkpointId": "review",
  "decision": "revise",
  "note": "补充接口边界检查",
  "revisions": [
    { "nodeId": "frontend", "instruction": "在原分析基础上核对空响应的处理" }
  ]
}
```

返工续接原子会话，不新增依赖环。批准后仍可修订：对应检查点及下游批准会撤销，
下游结果失效，待后续批准时重跑。节点也可用 `subagent` 引用本会话已有子 Agent，
无需重新创建。

## 角色配置

在“系统设置 → Agent Team”中管理角色，配置保存到当前项目的 `.qy/team.json`。
也可以明确要求 Agent 用 `define_role` 创建或修改角色。

```json
{
  "roles": [
    {
      "id": "analyst",
      "name": "分析",
      "description": "读代码、定位问题",
      "systemPrompt": "只分析，不修改文件；给出结论和依据。",
      "allowedTools": ["read_file", "grep", "glob", "list_dir"]
    }
  ],
  "rules": { "shared": "禁止修改 CI 配置" }
}
```

角色可设置 `provider / model / effort`。未设置模型时跟随当前会话；
`allowedTools` 省略表示全部工具，空数组表示不提供工具。
`rules.shared` 是用户维护的公共约束，`define_role` 不修改它。

## 外部 CLI

qywork 识别本机已安装、已接入的外部 Agent CLI；用户明确点名时可派发，
例如 `subagent` 参数：

```json
{
  "kind": "cli",
  "cli": "claude",
  "task": "复核当前改动，只报告发现的问题"
}
```

- CLI 使用自己的账号与模型，运行时可能直接修改工作区；权限由其自身执行环境决定。
- qywork 展示 CLI 输出和记录到的文件变更，但不将它的模型用量计入内置 Agent 账单。
- 后续仍通过 `subagentId` 续派。只有 CLI 返回会话号且支持续接时，才能保留其原上下文；
  否则会新开外部会话，并在回执中说明，需要重新提供完整背景。

当前识别规则见 [CLI 适配表](../packages/team/src/cli-detect.ts)。

## 用量与记录

每个内置子 Agent 的请求与用量记在自己的会话中，运行页可汇总主会话及内置子会话。
任务派发、节点状态和回执保存在运行记录中；外部 CLI 用量不在此汇总范围内。

[返回项目介绍](../README.md) · [文档索引](INDEX.md)
