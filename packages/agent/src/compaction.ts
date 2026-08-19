/**
 * 上下文压缩：把一段历史投影成摘要，腾出窗口。
 *
 * 这个文件只管**怎么压**；**什么时候压**是 `agent/loop.ts` 的事（发送前按占用与
 * 软阈值判，只有那一个入口），手动压缩走同一个 `run()`，只是判据换成用户的显式意图。
 *
 * 两条不变量：
 *
 * 1. **压缩是投影，不销毁数据。** 产出一份 manifest，构造请求时按它投影；
 *    **Message / Step / 正文库一个字节不动**。所以压缩可撤销、可重放、历史面板
 *    永远显示完整会话。做成「删掉旧消息换成摘要」的话，用户翻历史会发现前面的
 *    对话凭空消失。
 * 2. **摘要失败不能把整轮 run 带崩。** 摘要本身是一次模型调用，它也会失败
 *    （正是上下文超限时更容易失败）。所以有 `localSummary()` 这条确定性降级路径：
 *    不调模型，纯截取拼装。质量差得多，但远好于「压缩失败 → 请求还是超限 → run 挂掉」。
 * 3. **中断即丢弃，不设例外。** 信号 abort 之后一律返回 `aborted`——包括摘要
 *    已经生成完的那种。压缩不可逆地改写模型可见历史，中断之后落库等于用用户
 *    没等到的那份摘要替换掉他的会话。**不要给「反正已经算出来了」开口子**：
 *    加一条例外就是两条规则，而重算一次压缩的成本是零次模型调用。
 */

import type { CompactionFacts, CompactionManifest, MessageId } from '@qywork/core'

/** 少于这个数不值得压缩：摘要带来的信息损失比省下的 token 更贵。 */
export const MIN_MESSAGES_TO_COMPACT = 3

/**
 * 摘要输出预算（字符）。
 *
 * **必须随输入缩放**，不能是固定值。固定 4000 时，一段本来只有 2500 字符的会话
 * 会被"压"成 5478 字符的投影——压缩把上下文变大了。实测撞到过
 * （`scripts/compaction-fidelity.ts` 报「213%」）。
 *
 * 目标比例 25%：低于这个数摘要会丢掉关键约束，高于它压缩就没有意义。
 * 上下限用来兜住极端输入。
 */
const SUMMARY_RATIO = 0.25
const SUMMARY_MIN_CHARS = 400
const SUMMARY_MAX_CHARS = 4000

function summaryBudget(segments: string[]): number {
  const total = segments.reduce((n, s) => n + s.length, 0)
  return Math.max(SUMMARY_MIN_CHARS, Math.min(SUMMARY_MAX_CHARS, Math.round(total * SUMMARY_RATIO)))
}

/**
 * 判断一条用户消息是否带硬约束。
 *
 * 只有带约束的才逐字进事实包；其余交给摘要。
 *
 * **不要退化成「所有用户消息一律逐字保留」**。「约束一旦被概括就可能反转含义」
 * 这条理由本身成立，但用在全部消息上就是：40 轮会话里 39 条用户消息逐字留下，
 * 那不是压缩，是原样复制。
 *
 * 判错方向不对称：漏判一条约束会让它只存在于摘要里（可能被改写），
 * 误判一条普通消息只是多留几十个字符。所以宁可宽一点。
 */
function looksLikeConstraint(text: string): boolean {
  // 三类都要认，实测缺一类就丢事实（见下面的注释）：
  //
  // 1. 否定与命令 —— 最典型的约束。
  // 2. 赋值型约定 —— 「定为 X」「用 A 不用 B」。缺了它「签名算法用 RS256」会被概括掉。
  // 3. **带单位的数字** —— 「15 分钟」「7 天」「最多 3 次」。这类被摘要改写一个数字
  //    就完全错了，而模型概括时恰恰最爱丢具体数值。实测「令牌有效期 15 分钟」
  //    就是因为不含任何关键词而丢失的。
  return (
    /不要|不能|不得|不用|禁止|必须|务必|一定要|只能|只准|别|避免|千万/.test(text) ||
    /记住|注意|保持|优先|默认|统一|约定|定为|设为|采用|改用|先不|暂不|等.{0,6}再/.test(text) ||
    /\d+\s*(分钟|小时|天|周|秒|毫秒|次|条|个|行|MB|KB|GB|%|万|千)/.test(text)
  )
}

/** 单条 segment 的截断长度。 */
const SEGMENT_EXCERPT = 320

export interface CompactionInput {
  /** 待压缩的历史消息，按时间升序。 */
  messages: {
    id: MessageId
    role: 'user' | 'assistant'
    content: string
    hasAttachments?: boolean
  }[]
  /** 待压缩范围内的工具动作事实。 */
  actions: {
    stepId: string
    tool: string
    status: string
    target: string | null
    summary: string
    errorCode?: string | null
    /** 这次调用落盘的正文 id。压缩后靠它才能把内容库里那份读回来。 */
    resourceId?: string | null
  }[]
  /** 上一份 manifest；增量压缩时在它基础上推进。 */
  previous: CompactionManifest | null
}

export type CompactionOutcome =
  /** `summarized` = 这份摘要是模型写的还是本地降级拼的。调用方据它决定怎么显示。 */
  | { status: 'compacted'; manifest: CompactionManifest; summarized: boolean }
  /** 没到值得压缩的量，或者已经压到头了。**不是失败**——调用方不该报错。 */
  | { status: 'skipped'; reasonCode: 'too_few_messages' | 'nothing_new' }
  | { status: 'failed'; reasonCode: string; message: string }
  /**
   * 执行期间被中断，整次丢弃，没有任何持久副作用。
   *
   * **调用方不得把它当失败上报**：中断是用户自己的动作，停止时刻多一张红卡是噪音。
   */
  | { status: 'aborted' }

/** 由调用方注入的摘要生成器。返回 null = 走本地降级。 */
export type Summarizer = (prompt: string, budgetChars: number) => Promise<string | null>

/**
 * 摘要调用是不是被中断掐掉的。
 *
 * 认 `name` 而不是 `instanceof DOMException`：中断可能由 `AbortSignal` 原生抛出，
 * 也可能由适配器层包一层再抛，跨 realm 时 `instanceof` 不成立而 `name` 恒成立。
 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

/**
 * 执行一次压缩，产出新的 manifest。
 *
 * **永不抛异常**：压缩失败要返回结构化结果，让调用方决定是原样重试还是放弃。
 * 抛出来会让「压缩失败」和「run 崩了」在调用栈上无法区分。
 */
export async function compact(
  input: CompactionInput,
  summarize: Summarizer | null,
  signal?: AbortSignal,
): Promise<CompactionOutcome> {
  const { messages, actions, previous } = input

  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return { status: 'skipped', reasonCode: 'too_few_messages' }
  }

  const through = messages[messages.length - 1]!.id
  if (previous?.compactedThroughMessageId === through && actions.length === 0) {
    // 上次已经压到这里了，这次没有任何新东西可压。再压一次只是又花一次模型调用。
    return { status: 'skipped', reasonCode: 'nothing_new' }
  }

  const segments = buildSegments(messages, actions)
  const facts = extractFacts(messages, actions, previous?.facts)

  const budget = summaryBudget(segments)
  let summary = ''
  let summarized = false
  if (summarize) {
    try {
      const out = await summarize(buildSummaryPrompt(segments, previous?.summary ?? null), budget)
      if (out?.trim()) {
        summary = out.trim()
        summarized = true
      }
    } catch (err) {
      // 中断与 provider 失败必须分开：**降级只对后者成立**。把中断也降级，
      // 用户按停止之后拿到的就是一份机械截取的 manifest，而它不可逆。
      if (isAbortError(err)) return { status: 'aborted' }
      // provider 失败走降级，不上抛。上下文超限时这条路径尤其容易命中——
      // 而那正是最需要压缩成功的时刻。
    }
  }
  if (!summary) summary = localSummary(segments, budget)

  if (!summary) {
    return { status: 'failed', reasonCode: 'empty_summary', message: '摘要为空，未产出可用投影' }
  }

  // 摘要期间信号被拉起（摘要器自己吞掉了中断、或压根没有摘要器）时，
  // 这一次的产物同样作废。落库端还有一道守卫，两道的判据是同一个信号。
  if (signal?.aborted) return { status: 'aborted' }

  return {
    status: 'compacted',
    summarized,
    manifest: {
      revision: (previous?.revision ?? 0) + 1,
      compactedThroughMessageId: through,
      compactedMessageCount: (previous?.compactedMessageCount ?? 0) + messages.length,
      summary,
      facts,
      createdAt: Date.now(),
    },
  }
}

/**
 * 把消息与动作拉平成带来源标记的片段。
 *
 * `[message:id]` / `[action:id]` 前缀是刻意保留的：摘要里出现「之前读过 config.ts」时，
 * 能顺着 id 回到原始记录。摘要是**投影**不是替代，可追溯是它的前提。
 */
function buildSegments(
  messages: CompactionInput['messages'],
  actions: CompactionInput['actions'],
): string[] {
  const out: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : '助手'
    const body =
      (m.content ?? '').trim() + (m.role === 'user' && m.hasAttachments ? '（含附件）' : '')
    out.push(`[message:${m.id}] ${who}：${body}`)
  }
  for (const a of actions) {
    const parts = [`工具=${a.tool}`, `状态=${a.status}`]
    if (a.target) parts.push(`目标=${a.target}`)
    if (a.errorCode) parts.push(`错误=${a.errorCode}`)
    if (a.summary) parts.push(`结果=${excerpt(a.summary, 240)}`)
    out.push(`[action:${a.stepId}] ${parts.join('；')}`)
  }
  return out
}

/**
 * 提取精确事实包。
 *
 * 这部分**不经过模型**——文件路径、用户约束这类东西一旦被摘要改写就不再可靠，
 * 而模型后续会拿它们去改文件。宁可机械提取得笨一点，也不能让它们变成"大概是这个路径"。
 *
 * 与上一份 facts 合并而不是替换：压缩是增量的，早期定下的约束不能随着一次新压缩消失。
 */
function extractFacts(
  messages: CompactionInput['messages'],
  actions: CompactionInput['actions'],
  previous: CompactionFacts | undefined,
): CompactionFacts {
  const filesTouched = new Set(previous?.filesTouched ?? [])
  for (const a of actions) {
    if (a.target && /[./\\]/.test(a.target)) filesTouched.add(a.target)
  }

  const openItems = [...(previous?.openItems ?? [])]
  const userConstraints = [...(previous?.userConstraints ?? [])]
  // 落盘产物的定位符。合并而不是替换——早期落的那份正文压缩之后照样要能读回。
  const resources = new Set(previous?.resources ?? [])
  for (const a of actions) {
    if (a.resourceId) resources.add(`${a.tool}${a.target ? ` ${a.target}` : ''} → ${a.resourceId}`)
  }

  for (const m of messages) {
    const text = (m.content ?? '').trim()
    if (!text || m.role !== 'user') continue
    // **只有带约束的用户消息**逐字进事实包。
    //
    // 「不要改 X」「必须用 Y」这类话一旦被概括就可能反转含义，所以留原话；
    // 但普通的过程性消息（「继续」「看看这个文件」）逐字留下来就不是压缩了——
    // 实测 40 轮会话全留会让投影变成原文的 213%。
    if (looksLikeConstraint(text)) userConstraints.push(excerpt(text, SEGMENT_EXCERPT))
  }
  for (const a of actions) {
    if (a.status === 'failure') {
      openItems.push(
        `${a.tool}${a.target ? ` ${a.target}` : ''} 失败${a.errorCode ? `（${a.errorCode}）` : ''}`,
      )
    }
  }

  return {
    filesTouched: [...filesTouched].slice(-80),
    openItems: dedupeTail(openItems, 40),
    /*
     * 约束**按逐字内容去重，不设条数上限**。
     *
     * 加条数上限就是让最早的那条无声消失——长会话里「永远不要 force-push」这类
     * 第一天定下的铁律，正是最先被挤掉的。规模算得出来：约束来自用户键入，
     * 40 轮会话上限约 40×320 字符 ≈ 6K token，为了不丢一条约束这个代价是对的。
     */
    userConstraints: [...new Set(userConstraints)],
    ...(resources.size ? { resources: [...resources].slice(-40) } : {}),
  }
}

function dedupeTail(list: string[], keep: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // 从后往前去重再反转：重复项保留**最近**那次，早期的同义重复丢掉。
  for (let i = list.length - 1; i >= 0 && out.length < keep; i--) {
    const v = list[i]!
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.reverse()
}

/**
 * 摘要提示。**分节，不是一段并列的自由要求。**
 *
 * 并列要求会被模型当成风格建议，「约束用原话」在长会话里几乎必然被概括掉，
 * 而约束一旦被概括就可能反转含义。分节的关键在头两节：**逐条列出全部用户消息**、
 * **用原文引用**交代下一步——这把「保真」变成可检查的结构，少列一条用户消息
 * 是看得出来的，而「概括得不够准」看不出来。
 *
 * 机械提取的事实包（`extractFacts`）是第二道保险：正则漏掉的靠这里的结构兜住，
 * 这里概括掉的靠事实包逐字兜住。两道都不完美，但它们的失效方式不同。
 */
function buildSummaryPrompt(segments: string[], previousSummary: string | null): string {
  const head = previousSummary
    ? `已有摘要（本次在它基础上续写，不要重复其中内容）：\n${previousSummary}\n\n`
    : ''
  return (
    `${head}把下面的会话记录压缩成一份交接摘要，按这几节输出，不要开场白：\n\n` +
    `## 用户要求\n逐条列出**全部**用户消息的意图，一条不能少。原话里的约束` +
    `（不要做什么、必须用什么、具体数值与期限）**逐字引用**，不要改写。\n\n` +
    `## 已完成\n改了哪些文件、做成了什么。带上文件路径。\n\n` +
    `## 当前状态\n正在做什么、卡在哪里、有哪些已知失败。\n\n` +
    `## 关键决定\n定了什么、为什么这么定。理由不能省——省了下一轮会重新讨论一遍。\n\n` +
    `## 下一步\n接手者应该先做什么。涉及具体位置时**引用原文**，不要只说「那个文件」。\n\n` +
    `过程性的探索、失败的尝试细节、重复的确认可以丢掉。\n\n` +
    `会话记录：\n${segments.join('\n')}`
  )
}

/**
 * 本地确定性摘要：不调模型的降级路径。
 *
 * 选取策略：**第一条用户消息** + **尽可能多的末尾片段**。
 * 理由是两头最重要——开头是任务本身（丢了模型就不知道在干什么），
 * 末尾是当前进度（丢了模型会重做已经做完的事）。中间的探索过程最可省。
 */
export function localSummary(segments: string[], budgetChars: number): string {
  const lines = segments.map((s) => excerpt(s, SEGMENT_EXCERPT)).filter((s) => s.trim())
  if (lines.length === 0) return ''

  const header = '本地确定性摘要（完整事实以压缩事实清单为准）：'
  const firstUser = Math.max(
    0,
    lines.findIndex((l) => l.includes('] 用户：')),
  )

  const selected = new Set<number>()
  // 先保第一条用户消息，再从末尾往前尽量多塞。
  const priority = [
    firstUser,
    ...Array.from({ length: lines.length }, (_, i) => lines.length - 1 - i),
  ]
  for (const idx of priority) {
    if (selected.has(idx)) continue
    const candidate = [
      header,
      ...[...selected, idx].sort((a, b) => a - b).map((i) => lines[i]!),
    ].join('\n')
    if (candidate.length > budgetChars) continue
    selected.add(idx)
  }

  if (selected.size === 0) return excerpt(`${header} ${lines[lines.length - 1]}`, SEGMENT_EXCERPT)
  return [header, ...[...selected].sort((a, b) => a - b).map((i) => lines[i]!)].join('\n')
}

/**
 * 把 manifest 投影成发给模型的消息。
 *
 * 返回的是**替代被压缩那一段历史**的两条消息：摘要 + 事实清单。
 * 事实清单单独成条而不是拼进摘要，是因为它必须**逐字稳定**——
 * 拼进自由文本会被后续压缩再次改写，文件路径经不起两轮改写。
 */
export function projectManifest(
  manifest: CompactionManifest,
): { role: 'user' | 'assistant'; content: string }[] {
  const f = manifest.facts
  const factLines: string[] = []
  if (f.userConstraints.length)
    factLines.push(`用户约束：\n${f.userConstraints.map((s) => `- ${s}`).join('\n')}`)
  if (f.filesTouched.length) factLines.push(`涉及文件：${f.filesTouched.join('、')}`)
  if (f.resources?.length) {
    const list = f.resources.map((s) => `- ${s}`).join('\n')
    factLines.push(`落盘产物（需要正文时用 read_resource 取回）：\n${list}`)
  }
  if (f.openItems.length) factLines.push(`未解决：\n${f.openItems.map((s) => `- ${s}`).join('\n')}`)

  return [
    {
      role: 'user',
      content: `[此处是被压缩的早期对话摘要，修订版本 ${manifest.revision}]\n\n${manifest.summary}`,
    },
    {
      role: 'assistant',
      content: factLines.length
        ? `已确认的事实清单（逐字保留，不要改写）：\n\n${factLines.join('\n\n')}`
        : '已确认的事实清单：无。',
    },
  ]
}

function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}
