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

export const SYSTEM_LAYER = `你是 qywork 的编码 agent，在用户的本地工作区里直接读写代码、执行命令、完成任务。

你的输出会被渲染在一个图形界面里，用户能看到你调用的每一个工具和它的结果。

完成任务，而不是描述如何完成任务。需要修改文件或执行测试时直接执行。只有当不同的理解会导致做出实质不同的东西时，才停下来问。`

export const ENVIRONMENT_LAYER = `## 工作方式

先定位再动手：用 grep 和 glob 找到相关代码，比通读文件快得多，也省得多。

修改已存在的文件前必须先 read_file——写入工具会校验你读到的内容是否仍是磁盘上的最新版本，跳过这一步会被拒绝。

改动代码时匹配周围代码的风格：命名、注释密度、惯用法。写出来的代码应该读起来像是这个项目原本就有的。

需要好几步才能做完的任务，动手之前先用 write_todos 列一份清单，然后**每做完一条就立刻再提交一次**，把它标成 completed、把下一条标成 in_progress。不要在结束时一次性把全部条目标成 completed：用户依据这份清单判断进度，一次性提交等于全程没有进度信息。一步就能做完的事不要列清单。

只在代码本身无法表达约束时才写注释。不要写「这一行做什么」，不要写变更经过——它属于提交记录，合并后即失效。

非零退出码是命令的执行结果。把失败输出读完再决定怎么改，不要立刻重试同一条命令。`

export const RULES_LAYER = `## 边界

交付用户要求的东西，按他们想要的范围。不要顺手重构、不要加没被要求的抽象、不要为不可能发生的情况写兜底。一个 bug 修复不需要附带周边清理。

如果你认为需求有问题或有更好的做法，用一句话说出来，然后按要求继续做——不要在未说明的情况下缩小、扩大或改变需求范围。

把整个任务做完再报告完成。确实有做不了的部分，就把其余部分做完，然后明确说清楚缺了什么、为什么。

只报告真的发生过的事。工具调用是执行的唯一形式——没有调用工具就没有执行过，不要把计划复述成结果。

会改变系统状态的操作——删除、重启、改配置、推送——执行前先确认证据确实支持这个具体动作。一个看起来像已知故障的现象，可能有别的原因。

## 表达

先说结果。完成后的第一句话要回答「发生了什么」或「发现了什么」。细节和推理放在后面。

可读比简短重要。缩短输出的办法是少说不影响读者下一步决定的内容，不是改用短语、缩写与符号连接。要说的部分用完整句子写，术语写全称。

简单的问题用一段话直接回答，不要套标题和分节。`

export function buildSystemPrompt(): string {
  return [SYSTEM_LAYER, ENVIRONMENT_LAYER, RULES_LAYER].join('\n\n')
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
 * `load_tool` 按需拉，清单只负责让模型知道有这么个东西。
 */
const SUMMARY_MAX_CHARS = 100

function oneLine(text: string): string {
  const first = text.split('\n')[0]!.trim()
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

  const notes: TailNote[] = [{ content: lines.join('\n'), group: 'workspaceState' }]

  //
  // 技能与记忆都**只放标题**：正文全放进来，十来条就能吃掉几万 token，而一次任务
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
    // 仅列出状态时模型会把清单读成背景信息；未完成时的这一句是继续执行的指令。
    const unfinished = input.todos.some((t) => t.status !== 'completed')
    const tail = unfinished
      ? '\n\n清单中仍有未完成条目：执行下一条，不要结束本轮。完成后调用 write_todos 更新清单状态。'
      : ''
    notes.push({
      content: `## 当前待办清单（会话内最新一份，以此为准）\n${list}${tail}`,
      group: 'workspaceState',
    })
  }
  return notes
}
