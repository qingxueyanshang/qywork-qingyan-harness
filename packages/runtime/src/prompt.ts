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
 * 尾区注记。每次请求重算，压在 transcript 之后靠近生成位置。
 * 放在这里而不是前缀里，是为了让它变化时不冲掉缓存。
 */
export function buildTailNotes(input: {
  workspaceRoot: string
  platform: string
  gitBranch?: string | null
  /** 技能索引：只有 name + description，正文由模型按需 read_skill 拉取。 */
  skills?: { name: string; description: string }[]
  /** 记忆索引：只有 key + 首行摘要，正文按需 memory(action=read) 拉取。 */
  memories?: { key: string; preview: string }[]
}): string[] {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [`工作区：${input.workspaceRoot}`, `平台：${input.platform}`, `当前日期：${today}`]
  if (input.gitBranch) lines.push(`git 分支：${input.gitBranch}`)

  const notes = [lines.join('\n')]

  // 技能与记忆**只放索引不放正文**。
  //
  // 全放正文的话十个技能就能吃掉几万 token，而一次任务通常只用得上其中一个。
  // 索引让模型自己判断要不要拉全文——这是按需加载的全部意义。
  //
  // 两者都在尾区而不是冻结前缀：装一个技能、记一条记忆就会让整个 provider
  // 缓存失效，那个代价远大于它们省下的那点 token。
  if (input.skills?.length) {
    notes.push(
      `## 可用技能（需要完整步骤时用 read_skill 读）\n` +
        input.skills.map((s) => `- ${s.name}：${s.description}`).join('\n'),
    )
  }
  if (input.memories?.length) {
    notes.push(
      `## 已记住的事实（需要全文时用 memory(action=read) 读）\n` +
        input.memories.map((m) => `- ${m.key}：${m.preview}`).join('\n'),
    )
  }
  return notes
}
