import type { TodoItem } from '@qywork/core'

/**
 * 三层冻结前缀：system → environment → rules。
 *
 * 这三段跨 run 逐字节稳定，是提示缓存能命中的前提。**日期、技能清单、记忆、
 * 工作区文件列表一律不进这里**——它们随时间和用户操作而变，放进来等于每次请求
 * 都把整个缓存前缀作废。那些内容由 loop 的 tailNotes 排在整串消息的最后一段。
 *
 * 措辞刻意克制：当前模型对系统提示的服从度很高，为老模型写的
 * 「CRITICAL / YOU MUST / 如有疑问就用 X」会造成过度触发。说清楚该做什么就够了。
 */

export const SYSTEM_LAYER = `你是 qywork 的 harness agent，运行在用户本机，读写用户工作区里的文件、调用工具完成他交给你的任务。

你的输出会被渲染在一个图形界面里，用户能看到你调用的每一个工具和它的结果。

完成任务，而不是描述如何完成任务。需要修改文件或执行测试时直接执行。只有当不同的理解会导致做出实质不同的结果时，才停下来问。`

export const ENVIRONMENT_LAYER = `## 工作方式

执行任务前先分析用户意图、拆解需求、对需求评级，据此决定修改力度。需求是大幅度修改调整时不要只轻微改动，需求是小幅度优化时不要大批量修改。

先用 grep 与 glob 定位，再读定位到的部分，不要通读文件。

修改已存在的文件前必须先 read_file——写入工具会校验你读到的内容是否仍是磁盘上的最新版本，跳过这一步会被拒绝。

改动代码时匹配周围代码的风格：命名、注释密度、惯用法。

多步任务动手之前先用 write_todos 列一份清单，执行中对照清单检查完成情况，每做完一条立刻再调一次 write_todos，把它标成 completed、把下一条标成 in_progress。不要在结束时一次性把全部条目标成 completed。单步任务不列清单。

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
    line: '- 记忆：用户说明的偏好、项目约定、下次还用得上的结论，用 write_memory 存，read_memory 读正文。',
  },
  {
    tool: 'read_skill',
    line: '- 技能：有既定步骤的任务，先看末尾清单里有没有对应技能，用 read_skill 读正文。',
  },
  {
    tool: 'load_tool',
    line: '- 外部工具：MCP 与插件的工具不在工具表里，末尾清单只列名字，用 load_tool 加载后才能调用。',
  },
  {
    tool: 'subagent',
    line: '- 子 agent：调查要翻很多文件而结论只有一小段时派给 subagent，它的中间过程不占你的上下文。互不依赖的可以一次派几个。',
  },
  {
    tool: 'workflow',
    line: '- 编排：几件事之间有先后依赖、要把上一步的产出传给下一步时用 workflow，一次交一整张图。',
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
  const environment = caps.length
    ? `${ENVIRONMENT_LAYER}\n\n## 能力\n\n${caps.join('\n')}`
    : ENVIRONMENT_LAYER
  return [SYSTEM_LAYER, environment, RULES_LAYER].join('\n\n')
}

/**
 * 一条尾区注记及它归哪个桶。
 *
 * 分组必须带出来，**不能一律标成 `workspaceState`**：那样面板上「记忆内容」
 * 与「技能清单」两行**永远是 0**——数据一直在发，只是没人按组去量。
 */
export interface TailNote {
  content: string
  group: 'workspaceState' | 'skills' | 'memory' | 'mcpTools'
}

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
 * 尾区注记。每次请求重算，排在**整串消息的最后一段**（装配见 `agent/loop.ts`）。
 *
 * **位置不能动，这是约束不是偏好。** 缓存是前缀匹配的，而兼容协议没有显式断点，
 * 命中完全靠前缀逐字节相同：
 *
 * - 放在历史**之前**：用户改一条记忆、装一个技能，其后整段历史全部失配。
 * - 夹在历史与 transcript **之间**：跨 run 时上一轮的 transcript 折进历史，
 *   位置从注记之后挪到注记之前，公共前缀在上一轮历史末尾就断——
 *   上一轮跑出来的全部工具结果每开一个新 run 都要全价重付一遍。
 * - 排在**最后**：`历史 + transcript` 成为一条跨 run 只追加的稳定前缀，
 *   注记是唯一的易变尾巴。
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
   * **这份清单必须在尾区，不能进冻结前缀**——它随用户装卸 MCP / 插件而变，
   * 进前缀等于装一个插件就把整段缓存打掉，而那正是按需加载要治的病。
   */
  externalTools?: { name: string; summary: string }[]
  /**
   * 会话账本里最后一份待办清单。**这里是模型侧唯一能看到它的地方。**
   *
   * `write_todos` 那次调用本身会随步数沉进 transcript，而它的
   * `targetExtractor` 返回 `null`，压缩后不进事实清单——不重发的话清单先被
   * 后面的工具结果埋掉、再被压缩拿掉，表现是模型做着做着就不认领下一条了。
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
   * 待办排在**所有注记的最后**：它是尾区里最易变的一条，模型每提交一次
   * `write_todos` 它就变。排在前面会把技能、记忆、外部工具三条一并挤出缓存
   * （装满 MCP 时那三条约 1200–1500 token）。
   */
  if (input.todos?.length) {
    const list = input.todos
      .map((t, i) => `${i + 1}. [${TODO_LABEL[t.status]}] ${t.content}`)
      .join('\n')
    // 仅列出状态时模型会把清单读成背景信息；未完成时的第一句是继续执行的指令。
    //
    // **末句管的是行为，不是措辞。** 这条注记每轮重发、清单就摆在眼前，模型每轮都会
    // 在回复开头复述一遍进度。按措辞禁是打地鼠：冻结前缀里禁的是「继续执行第 N 项」，
    // 模型写的是「继续第 2 项」，少一个词就绕过去了。所以这里禁的是「重复播报进度」
    // 这个动作，判据交给模型自己比对上一轮说过什么。
    const unfinished = input.todos.some((t) => t.status !== 'completed')
    const tail = unfinished
      ? '\n\n检查 todo 进度，如有未完成内容，继续执行，不要结束本轮，完成后调用 write_todos 更新状态。禁止重复回复用户当前进度，仅在进度更新时告知。'
      : ''
    notes.push({
      content: `## 当前待办清单（会话内最新一份，以此为准）\n${list}${tail}`,
      group: 'workspaceState',
    })
  }
  return notes
}
