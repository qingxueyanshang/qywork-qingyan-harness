import type { RunContextSegment, TodoItem } from '@qywork/core'

/**
 * 三层冻结前缀：system → environment → rules。
 *
 * 这三段跨 run 逐字节稳定，是提示缓存能命中的前提。**日期、技能清单、记忆、
 * 工作区文件列表一律不进这里**——它们随时间和用户操作而变。Session 在 run 开始时
 * 冻结一份快照，runtime 把它放在所属真实用户消息前，协议层再并进同一条 user。
 *
 * 措辞刻意克制：当前模型对系统提示的服从度很高，为老模型写的
 * 「CRITICAL / YOU MUST / 如有疑问就用 X」会造成过度触发。说清楚该做什么就够了。
 */

export const SYSTEM_LAYER = `你是 qywork 的 harness agent，运行在用户本机，读写用户工作区里的文件、调用工具完成他交给你的任务。

你的输出会被渲染在一个图形界面里，用户能看到你调用的每一个工具和它的结果。

完成任务，而不是描述如何完成任务。需要修改文件或执行测试时直接执行。只有当不同的理解会导致做出实质不同的结果时，才停下来问。`

export const ENVIRONMENT_LAYER = `## 工作方式

执行任务前先分析用户意图、拆解需求、对需求评级，据此决定修改力度。需求是大幅度修改调整时不要只轻微改动，需求是小幅度优化时不要大批量修改。

处理已有行为异常时，先确认用户描述的具体可观察现象，并优先取得修改前证据，例如实际复现、错误堆栈或明确的代码执行路径。修复后必须检查同一个现象；当前环境无法验证时，要明确说明未验证，不要把推测表述为根因。

先用 grep 与 glob 定位，再读定位到的部分，不要通读文件。

修改已存在的文件前必须先 read_file——写入工具会校验你读到的内容是否仍是磁盘上的最新版本，跳过这一步会被拒绝。

改动代码时匹配周围代码的风格：命名、注释密度、惯用法。

多步任务动手之前先用 write_todos 列一份清单，执行中对照清单检查完成情况。自己做完一条时立刻再调一次 write_todos，把它标成 completed、把下一条标成 in_progress。子 agent 返回只代表产出已交回：先核验，满意后立刻用 write_todos 完成对应条目；不满意就保持未完成并返工。可能需要原子会话返工时从一开始就用带检查点的编排，由批准或修订决定是否通过。不要在结束时一次性把全部条目标成 completed。单步任务不列清单。

注释写用途与约束：这段代码负责什么、调用方必须遵守什么。不要逐行复述代码，不要写变更经过，那属于提交记录。

命令失败时先把输出读完再决定怎么改，不要立刻重试同一条。`

/**
 * 能力段。**九个类目一条不少地告诉模型**——不说它就想不起来自己能做这件事，
 * 这是当前模型不主动用记忆、技能、派活、定时的直接原因。
 *
 * 每行绑定一个门槛工具，只有它在注册表里才发出这一行：subagent / workflow /
 * load_tool / install_plugin 按通道注册（见 `tools/src/index.ts`），
 * 没有对应通道时发出去就是指着一个不存在的工具。
 * 过滤结果在一个会话内固定，冻结前缀因此仍然逐字节稳定。
 *
 * files 与 code 不在这里：身份段已经点名，planning 由「工作方式」的待办段落管。
 */
const CAPABILITY_LINES: { tool: string; line: string }[] = [
  { tool: 'run_command', line: '- 命令：用 run_command 执行 shell 命令。' },
  {
    tool: 'write_memory',
    line: '- 记忆写入：用户说明的偏好、项目约定、下次还用得上的结论用 write_memory 存。默认 scope=project；用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_memory',
    line: '- 记忆迁移：项目层与全局层之间迁移用 move_memory，不得用复制留下双份。',
  },
  {
    tool: 'read_skill',
    line: '- 技能读取：有既定步骤的任务，先看末尾清单并用 read_skill 读正文。用户用 `#技能名` 明确选中时，先读取该技能再执行。',
  },
  {
    tool: 'write_skill',
    line: '- 技能写入：新建或更新用 write_skill；默认 scope=project，用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_skill',
    line: '- 技能迁移：项目层与全局层之间迁移用 move_skill，成功后只保留目标目录。',
  },
  {
    tool: 'write_mcp_server',
    line: '- MCP 配置：新增或更新服务用 write_mcp_server；默认 scope=project，用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_mcp_server',
    line: '- MCP 迁移：项目层与全局层之间迁移用 move_mcp_server，成功后只保留目标配置。',
  },
  {
    tool: 'load_tool',
    line: '- 外部工具：MCP 与插件的工具不在工具表里，末尾清单只列名字，用 load_tool 加载后才能调用。用户用 `@工具注册名` 明确点名时，加载并调用该工具。',
  },
  {
    tool: 'define_subagent',
    line: '- 角色定义：用 define_subagent 新建或修改当前项目 Agent Team 里的真实角色。用户消息以 `/subagent 角色描述` 开头时，按描述创建一个可长期复用、之后能被 `@角色id` 点名的角色；不要把它当成一次临时派活。',
  },
  {
    tool: 'subagent',
    line: '- 子 agent：调查要翻很多文件而结论只有一小段时派给 subagent，它的中间过程不占你的上下文。互不依赖的可以一次派几个。当前有未完成待办时，每次调用都要用 parentTodo 逐字绑定产出归属；返回后先验收，满意才用 write_todos 完成，不满意保持未完成。模型自行判断需要临时子 agent 时，不指定 agent 直接派出；用户用 `@角色id` / `@cli:id` 点名时，必须派给该现有目标。',
  },
  {
    tool: 'workflow',
    line: '- 编排：几件事之间有先后依赖、要传递上游产出，或主会话验收后可能要求原子会话返工时，用 workflow 一次交一整张图；在 agent 节点后放 checkpoint，核验满意才 approve，不满意用 revise 回流。',
  },
  { tool: 'create_schedule', line: '- 定时任务：需要按时间反复执行的事用 create_schedule 挂上。' },
  { tool: 'read_goal', line: '- 目标：跨会话的长期目标用 read_goal 读、update_goal 更新。' },
  {
    tool: 'read_history',
    line: '- 会话内容：本次会话之前的对话用 read_history 检索，工具产出的大块内容用 read_resource 读。',
  },
  { tool: 'web_search', line: '- 网络：需要外部信息用 web_search 搜、web_fetch 抓。' },
]

export const RULES_LAYER = `## 边界

交付用户要求的内容，按他要求的范围。不要附带重构、不要加没被要求的抽象、不要为不可能发生的情况写兜底。

认为需求有问题或有更好的做法时，用一句话说明，然后按原需求执行——禁止以此为由拒绝执行或缩减交付，也不得在未说明的情况下缩小、扩大或改变需求范围。

把整个任务做完再报告完成。有做不了的部分，把其余部分做完并说清缺了什么、为什么。

只报告真的发生过的事。工具调用是执行的唯一形式，不要把计划复述成结果。

会改变系统状态的操作——删除、重启、改配置、推送——执行前先确认证据支持这个具体动作。

## 表达

先说结果。完成后的第一句话要回答「发生了什么」或「发现了什么」。细节和推理放在后面。

可读比简短重要。缩短输出的办法是少说不影响读者下一步决定的内容，不是改用短语、缩写与符号连接。要说的部分用完整句子写，术语写全称。

同一件事只说一次，禁止重复表述「继续第 N 条/项/步」。

简单的问题用一段话直接回答，不要套标题和分节。`

/** `toolNames` 是当前注册表里的工具名，决定能力段发哪几行。 */
export function buildSystemPrompt(toolNames: ReadonlySet<string>): string {
  const caps = CAPABILITY_LINES.filter((c) => toolNames.has(c.tool)).map((c) => c.line)
  /*
   * 外部 schema 小于预算时直接注册，不会有 `load_tool`。这时同样要解释输入区的
   * `@注册名`，门槛就是注册表里真的出现了扩展命名的工具，不能只绑 load_tool。
   */
  if ([...toolNames].some((name) => name.startsWith('mcp__') || name.includes('__'))) {
    caps.push(
      '- 点名调用：用户用 `@工具注册名` 明确选择已在工具表中的 MCP 或插件工具时，直接调用该工具。',
    )
  }
  const environment = caps.length
    ? `${ENVIRONMENT_LAYER}\n\n## 能力\n\n${caps.join('\n')}`
    : ENVIRONMENT_LAYER
  return [SYSTEM_LAYER, environment, RULES_LAYER].join('\n\n')
}

/**
 * 一条运行上下文及它归哪个桶。
 *
 * 分组必须带出来，**不能一律标成 `workspaceState`**：那样面板上「记忆内容」
 * 与「技能清单」两行**永远是 0**——数据一直在发，只是没人按组去量。
 */
export type TailNote = RunContextSegment

/**
 * 外部工具那一行摘要截多长。
 *
 * MCP 与插件的 `summary` 就是第三方给的 description 原文，可以是好几段。
 * 实测（2026-08-16，四个真实 server 共 41 个工具）：原样拼 2620 token，
 * 截到 100 字 1187 token。截的是**清单**不是工具本身——完整说明由
 * `load_tool` 按需拉，清单只负责让模型知道有这么一个工具。
 */
const SUMMARY_MAX_CHARS = 100

/**
 * 取摘要里第一句有内容的话。
 *
 * 必须跳过空行与 markdown 标题行：第三方 description 常以空行或 `## Overview`
 * 开头，只取第一行会让清单里那一行退化成光秃秃一个工具名，
 * 模型据此判断不出该不该 `load_tool`。
 */
function oneLine(text: string): string {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'))
  if (first === undefined) return ''
  return first.length > SUMMARY_MAX_CHARS ? `${first.slice(0, SUMMARY_MAX_CHARS)}…` : first
}

/**
 * `process.platform` 的人读名。
 *
 * **不要把 `process.platform` 原样写进提示词。** 它是 Node 的内部常量，
 * `win32` 会被读成「Windows 32 位」——实测模型照着它对用户复述过一次。
 * 未收录的取值原样返回：编一个名字比给出原值更糟。
 */
function osName(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** 待办状态的人读名。 */
const TODO_LABEL: Record<TodoItem['status'], string> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
}

/**
 * 生成一次 run 的非对话上下文快照。调用方只在 run 建立前调用一次并原子落库；
 * 不得在每个 provider 请求前重算，否则同一 run 的线上字节会漂移，重试与缓存都失真。
 */
export function buildTailNotes(input: {
  workspaceRoot: string
  /** `process.platform` 的原值。人读名由 `osName` 在这里换，调用方不必先翻译。 */
  platform: string
  gitBranch?: string | null
  /**
   * 权限模式。**必须告诉模型**：不说它只能靠撞——每撞一次就多付一轮
   * 「被拒 → 改写 → 重发」的 token，而被拒的那次工具调用本身也已经计过费。
   */
  mode: 'auto' | 'full'
  /** 技能索引：只有 name + description，正文由模型按需 read_skill 拉取。 */
  skills?: { name: string; description: string }[]
  /** 记忆索引：只有 key + 首行摘要，正文由模型按需 read_memory 拉取。 */
  memories?: { key: string; preview: string }[]
  /**
   * 待加载的外部工具：只有工具名 + 一句话，完整参数说明由模型按需 load_tool 拉。
   *
   * 这份清单属于 run 快照，不能进冻结 system 前缀——它随用户装卸 MCP / 插件而变。
   */
  externalTools?: { name: string; summary: string }[]
  /**
   * run 开始时会话账本里的待办快照。run 内更新仍以真实 `write_todos` 与绑定父待办的
   * `subagent` 调用/回执为准；压缩层保留这组最小事实链，不另造 Todo 状态。
   * 全部完成的清单属于上一件事，只留在历史里，不再冒充下一条指令的“当前待办”。
   */
  todos?: TodoItem[] | null
}): TailNote[] {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    `工作区：${input.workspaceRoot}`,
    `平台：${osName(input.platform)}`,
    `当前日期：${today}`,
  ]
  if (input.gitBranch) lines.push(`git 分支：${input.gitBranch}`)
  lines.push(
    input.mode === 'full'
      ? '权限模式：完全访问——不做裁决，路径边界也不设。'
      : '权限模式：auto——工作区外的写删、改系统状态的命令、读写凭证文件会被拒绝，其余放行。',
  )

  const notes: TailNote[] = [{ content: lines.join('\n'), group: 'workspaceState' }]

  //
  // 技能与记忆都**只放标题**：正文全放进来，十来条就能占掉几万 token，而一次任务
  // 通常只用得上其中一两条。标题的成本线性于条数不是内容，全列也装得下，
  // 哪条要展开由模型看着标题自己判断——它手上有当前任务的全部细节，
  // 而任何按当轮文本打分的召回只看得见字面重合度。
  if (input.skills?.length) {
    const list = input.skills.map((s) => `- ${s.name}：${s.description}`).join('\n')
    notes.push({
      content: `## 可用技能（需要完整步骤时用 read_skill 读取）\n${list}`,
      group: 'skills',
    })
  }
  if (input.memories?.length) {
    const list = input.memories.map((m) => `- ${m.key}：${m.preview}`).join('\n')
    notes.push({
      content: `## 已记住的事实（需要正文时用 read_memory 读取）\n${list}`,
      group: 'memory',
    })
  }
  // 外部工具同技能与记忆：**清单常驻、参数说明按需**。它归 `mcpTools` 桶，
  // 与那些工具的 schema 同一格——面板上「外部工具」那一行答的就是这件事的开销。
  if (input.externalTools?.length) {
    const list = input.externalTools.map((t) => `- ${t.name}：${oneLine(t.summary)}`).join('\n')
    notes.push({
      content: `## 可加载的外部工具（调用前先用 load_tool 加载参数说明）\n${list}`,
      group: 'mcpTools',
    })
  }
  /*
   * 待办排在快照最后，便于审计同一 run 的输入顺序；这只是段内顺序，
   * 不产生第二份可写状态。
   */
  if (input.todos?.some((t) => t.status !== 'completed')) {
    const list = input.todos
      .map((t, i) => `${i + 1}. [${TODO_LABEL[t.status]}] ${t.content}`)
      .join('\n')
    // 仅列出状态时模型会把清单读成背景信息；未完成时的第一句是继续执行的指令。
    //
    // **末句管的是行为，不是措辞。** 这条注记每轮重发、清单就摆在眼前，模型每轮都会
    // 在回复开头复述一遍进度。按措辞禁是打地鼠：冻结前缀里禁的是「继续执行第 N 项」，
    // 模型写的是「继续第 2 项」，少一个词就绕过去了。所以这里禁的是「重复播报进度」
    // 这个动作，判据交给模型自己比对上一轮说过什么。
    notes.push({
      content: `## 当前待办清单（会话内最新一份，以此为准）\n${list}\n\n检查 todo 进度，如有未完成内容，继续执行，不要结束本轮。委派时用 parentTodo 绑定产出归属；子 agent 返回后先验收，满意才用 write_todos 完成对应条目，不满意保持未完成并返工。禁止重复回复用户当前进度，仅在进度更新时告知。`,
      group: 'workspaceState',
    })
  }
  return notes
}
