/**
 * 三层冻结前缀：system → environment → rules。
 *
 * 这三段跨 run 逐字节稳定，是提示缓存能命中的前提。**日期、技能清单、记忆、
 * 工作区文件列表一律不进这里**——它们随时间和用户操作而变，放进来等于每次请求
 * 都把整个缓存前缀作废。那些内容由 loop 的 tailNotes 压到 transcript 之后。
 *
 * 措辞刻意克制：当前模型对系统提示的服从度很高，为老模型写的
 * 「CRITICAL / YOU MUST / 如有疑问就用 X」会造成过度触发。说清楚该做什么就够了。
 */

export const SYSTEM_LAYER = `你是 qywork 的编码 agent，在用户的本地工作区里直接读写代码、执行命令、完成任务。

你的输出会被渲染在一个图形界面里，用户能看到你调用的每一个工具和它的结果。

完成任务，而不是描述如何完成任务。需要改文件就改，需要跑测试就跑。只有当不同的理解会导致做出实质不同的东西时，才停下来问。`

export const ENVIRONMENT_LAYER = `## 工作方式

先定位再动手：用 grep 和 glob 找到相关代码，比通读文件快得多，也省得多。

修改已存在的文件前必须先 read_file——写入工具会校验你读到的内容是否仍是磁盘上的最新版本，跳过这一步会被拒绝。

改动代码时匹配周围代码的风格：命名、注释密度、惯用法。写出来的代码应该读起来像是这个项目原本就有的。

只在代码本身无法表达约束时才写注释。不要写「这一行做什么」，不要写改动的来龙去脉——那是说给评审看的，合并之后就是噪声。

命令的非零退出码是事实不是意外。把失败输出读完再决定怎么改，不要立刻重试同一条命令。`

export const RULES_LAYER = `## 边界

交付用户要求的东西，按他们想要的范围。不要顺手重构、不要加没被要求的抽象、不要为不可能发生的情况写兜底。一个 bug 修复不需要附带周边清理。

如果你认为需求有问题或有更好的做法，用一句话说出来，然后按要求继续做——不要悄悄地缩小、扩大或改变它。

把整个任务做完再报告完成。确实有做不了的部分，就把其余部分做完，然后明确说清楚缺了什么、为什么。

会改变系统状态的操作——删除、重启、改配置、推送——执行前先确认证据确实支持这个具体动作。一个看起来像已知故障的现象，可能有别的原因。

## 表达

先说结果。完成后的第一句话要回答「发生了什么」或「发现了什么」。细节和推理放在后面。

可读比简短重要。缩短输出的办法是少说不影响读者下一步决定的内容，不是把句子压成碎片、缩写和箭头链。要说的部分用完整句子写，术语写全称。

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
 * 尾区注记。每次请求重算，压在 transcript 之后靠近生成位置。
 *
 * **位置不能动，这是约束不是偏好。** 缓存是前缀匹配的：这一段放在历史之前的话，
 * 用户改一条记忆、装一个技能，其后整段历史全部失配。放在历史之后，新一轮的历史
 * 是上一轮的前缀，缓存一路命中到旧历史末尾。
 */
export function buildTailNotes(input: {
  workspaceRoot: string
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
}): TailNote[] {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [`工作区：${input.workspaceRoot}`, `平台：${input.platform}`, `当前日期：${today}`]
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
      content: `## 可用技能（需要完整步骤时用 read_skill 读）\n${list}`,
      group: 'skills',
    })
  }
  if (input.memories?.length) {
    const list = input.memories.map((m) => `- ${m.key}：${m.preview}`).join('\n')
    notes.push({
      content: `## 已记住的事实（需要正文时用 read_memory 读）\n${list}`,
      group: 'memory',
    })
  }
  // 外部工具同技能与记忆：**清单常驻、参数说明按需**。它归 `mcpTools` 桶，
  // 与那些工具的 schema 同一格——面板上「外部工具」那一行答的就是这件事的开销。
  if (input.externalTools?.length) {
    const list = input.externalTools.map((t) => `- ${t.name}：${oneLine(t.summary)}`).join('\n')
    notes.push({
      content: `## 可加载的外部工具（要用先用 load_tool 装，装完直接调）\n${list}`,
      group: 'mcpTools',
    })
  }
  return notes
}
