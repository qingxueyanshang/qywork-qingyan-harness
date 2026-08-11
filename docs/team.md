# Agent Team：多角色编排

配置放在工作区的 `.qy/team.json`。没有这个文件时「开始编排」会明确说未配置并指出配在哪，
不会空跑一轮假装成功。

核心抽象是**后端无关的角色**：一个角色说明「它是谁、能用什么、受什么约束」，
至于它跑在本进程的 agent 上还是外挂的 codex / claude CLI 上，是配置问题。
这个对称性来自拓扑——`qy` 自己就是一个 CLI，所以「调度外部 CLI」和「调度自己」
是同一条代码路径。

---

## 最小配置

```json
{
  "backends": {
    "local": { "kind": "builtin" }
  },
  "roles": [
    {
      "id": "analyst",
      "backend": "local",
      "name": "分析",
      "description": "读代码、定位问题",
      "systemPrompt": "你只分析不改代码。给出结论和依据，不要动文件。",
      "allowedTools": ["read_file", "grep", "glob", "list_dir"]
    },
    {
      "id": "implementer",
      "backend": "local",
      "name": "实现",
      "description": "按方案改代码",
      "systemPrompt": "严格按给定方案改，不要顺手重构。"
    }
  ],
  "plan": [
    { "id": "diag", "roleId": "analyst", "task": "定位问题：{goal}" },
    { "id": "fix", "roleId": "implementer", "task": "按下面的分析改代码", "needs": ["diag"] }
  ],
  "rules": { "maxConcurrent": 2 }
}
```

没有 `plan` 时按「单角色直跑第一个 role」处理。

---

## 后端

### 内置

```json
{ "kind": "builtin", "profile": "deepseek", "model": "deepseek-v4-flash", "effort": "medium" }
```

用本进程的 agent 跑，机器上不需要装任何外部 CLI。三个字段都可选：
`profile` 指定用配置里哪个供应商档案（也就是用谁的 key、按谁计价），
不填用当前生效的。**指了一个不存在的档案会当场失败**——悄悄回落到默认档案会让
「用便宜模型跑审查」这类配置静默失效，而账单在另一边。

每个成员是一个**独立会话**。成员之间的上下文不共享：一个「审查者」如果看得见
「实现者」的完整思考过程，它就不再是独立视角了，而独立视角正是多角色的全部意义。
要传递的东西由编排器显式拼进 prompt。

### 外部 CLI

```json
{ "kind": "cli", "preset": "codex" }
```

内置三个预设（`codex` / `claude` / `qy`）只做**默认值**，你写的字段永远覆盖它。
不内置各家 CLI 的完整参数表——它们各自演进，写死必然过期，而过期的表现是
「昨天还能用今天报错」。完整字段：

```json
{
  "kind": "cli",
  "command": "codex",
  "args": ["exec", "--json", "{prompt}"],
  "output": "jsonl",
  "resultField": "result",
  "cwd": "packages/core",
  "env": { "FOO": "bar" },
  "timeoutMs": 600000
}
```

`output: "text"` 表示整个 stdout 就是结果；`"jsonl"` 表示逐行 JSON，
取 `resultField` 字段的最后一个非空值。

判据是显式的 `kind`，不是「没写 command 就当内置」——后者会把一条写漏了 `command`
的 CLI 配置默默变成内置，跑出来的东西完全不是你要的。

---

## 角色

| 字段 | 说明 |
|---|---|
| `id` | 计划节点用它引用 |
| `backend` | `backends` 里的键。指向不存在的后端时该角色被丢弃并记录 |
| `name` / `description` | 前者显示，后者说明该把什么交给它 |
| `systemPrompt` | 追加到该角色冻结前缀末尾的约束 |
| `allowedTools` | 只给这些工具。**空数组 = 一个都不给**（纯分析角色），不填 = 全部 |
| `maxSteps` | 该角色单次的步数上限 |

`allowedTools` 的空数组和不填是两回事，不要合并——合并会让「只让它分析、
不给任何工具」静默变成「什么都能干」，而且看不出来。写错的工具名会打一条警告，
不会静默忽略：配了 `read_files`（多了个 s）的角色会安安静静地一个工具都没有，
表现为「它什么也不干」。

---

## 计划

```json
{ "id": "fix", "roleId": "implementer", "task": "...", "needs": ["diag"], "passInput": false }
```

- `{goal}` 替换成用户的原始诉求。
- `{input}` 决定上游产出**插在哪里**。不写 `{input}` 时上游产出追加在任务末尾的
  「## 上游产出」小节下——声明了 `needs` 却拿不到产出，表现是下游角色回
  「没有上一步的上下文，无法复核」，而配置看起来完全正确。真的只想要执行顺序，
  写 `passInput: false`。
- 上游失败时下游**跳过**，不拿着坏输入继续。
- 成环和悬空引用在加载期就拒绝，不留到运行时变成「一直没有可启动节点」。

---

## 规则

```json
{
  "shared": "禁止修改 CI 配置",
  "maxConcurrent": 3,
  "maxTotalSteps": 200,
  "humanGates": ["fix"]
}
```

`humanGates` 里的节点在**执行前**问人——跑完再问等于钱已经花了、文件已经改了。
桌面端会弹授权卡片，手机端走同一条通道。

---

## 用量

一轮编排的用量是各成员之和，显示在结束时的统计里。缓存命中是「有回报才累加」：
全程没有成员回报过就显示「未回报」，而不是 0——后者会让人得出
「缓存一次都没命中」这个具体但错误的结论。
