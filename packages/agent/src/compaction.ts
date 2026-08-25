/**
 * 上下文压缩：两段式管线，一个入口。
 *
 * 这个文件只管**怎么压**；**什么时候压**是 `agent/loop.ts` 的事（发送前按占用与
 * 软阈值判），取数与落库是 `runtime/compaction.ts` 的事。
 *
 * 分工按内容性质划：**确定性内容归算法，叙事性内容归模型。**
 * 工具结果正文、调用参数、文件路径、资源定位符经一次概括就不可靠，而模型会拿
 * 它们去改文件，所以收纳段（`condenseMessage`）只换信封不改字节；多轮意图、
 * 当前状态、关键决定正则做不了归纳，交给摘要段。
 *
 * 四条不变量：
 *
 * 1. **压缩是投影，不销毁数据。** 产出一份 manifest，构造请求时按它投影；
 *    **Message / Step / 正文库一个字节不动**。所以压缩可撤销、可重放、历史面板
 *    永远显示完整会话。
 * 2. **两条边界，收纳线 ≥ 摘要线。** 摘要线以内换成「摘要 + 事实清单」，
 *    摘要线到收纳线之间消息原样、工具正文瘦身，收纳线之后逐字原样。
 * 3. **摘要段失败不回退整次压缩。** 收纳段是确定性产物，模型没写出摘要时它照常
 *    落库、摘要线不动。不要为此加一条本地拼装的降级摘要：机械截取的那份看起来
 *    和模型写的一样，而用户无从分辨。
 * 4. **中断即丢弃，不设例外。** 信号 abort 之后一律返回 `aborted`——包括摘要
 *    已经生成完的那种。压缩不可逆地改写模型可见历史，中断之后落库等于用用户
 *    没等到的那份摘要替换掉他的会话。**不要为「摘要已经算完」开口子**：
 *    加一条例外就是两条规则，而重算一次压缩的成本是零次模型调用。
 */

import type { WireMessage, WireToolCall } from '@qywork/ai'
import { estimateMessages, estimateText } from '@qywork/ai'
import type {
  ActionKind,
  CompactionCut,
  CompactionFacts,
  CompactionManifest,
  MessageId,
} from '@qywork/core'

/**
 * 摘录界：一条 segment、一条事实、一个被折叠的调用参数，共用这一个长度。
 *
 * 「一条事实一两句话」是可读性决策，运行期没有可测的真源。
 */
const EXCERPT = 320

/**
 * 事实清单最多占投影预算的几成。
 *
 * 两半：逐字事实一半，叙事摘要一半。不切开的话，事实清单在预算紧的时候会占满整份
 * 预算，摘要段随即以「没有空间」失败，而那份刚裁好的事实清单也跟着作废
 * ——摘要线不动，它没进 manifest。
 */
const FACTS_BUDGET_SHARE = 0.5

/**
 * 可折单元的戳记。
 *
 * 字典序等于产生顺序：run id 与 step seq 都是单调的，seq 定宽补零。
 * **同一个执行波次的全部消息共用一个戳**，切界只落在戳之间。
 */
export function stepStamp(runId: string, seq: number): string {
  return `${runId}:${String(seq).padStart(9, '0')}`
}

/**
 * 一条消息在折叠序上的位置。`null` = 不参与折叠（尾区注记等无戳消息）。
 *
 * 先比消息 id、同一条消息内再比 step 戳：消息本体的戳为空串，排在它的执行记录之前。
 */
export function unitKey(m: WireMessage): string | null {
  return m._messageId ? `${m._messageId}|${m._step ?? ''}` : null
}

/** 边界在折叠序上的位置。与 `unitKey` 同一口径，两处不同形就切错线。 */
export function cutKey(cut: CompactionCut): string {
  return `${cut.messageId}|${cut.step ?? ''}`
}

/** 摘要线。 */
export function summaryCutOf(m: CompactionManifest | null): CompactionCut | null {
  if (!m?.compactedThroughMessageId) return null
  return {
    messageId: m.compactedThroughMessageId,
    ...(m.compactedThroughStep ? { step: m.compactedThroughStep } : {}),
  }
}

/** 收纳线。缺这个键的 manifest 收纳线与摘要线重合。 */
export function condenseCutOf(m: CompactionManifest | null): CompactionCut | null {
  return m?.condensedThrough ?? summaryCutOf(m)
}

/**
 * 收纳一条消息：换信封，不改字节。
 *
 * 工具结果只留 `call_id / tool / status / executed / summary` 与落盘定位符 `resources`，
 * 正文去掉——超过投递界的那些本来就落了 sink，`read_resource` 按那些 id
 * 取得回原文。调用参数里的长字符串（`write_file` 的整份正文）折成摘录 + 标记。
 *
 * `reasoningContent` 原样保留：DeepSeek 类兼容端点对带 tool_calls 的历史
 * assistant 消息缺思考正文会 400。
 *
 * **产物必须是纯函数结果、逐字稳定**：投影每次构造请求都跑一遍，掺进时间戳或
 * 随机量会让缓存断点之前的字节每次都变，前缀缓存从此全程不命中。
 */
export function condenseMessage(m: WireMessage): WireMessage {
  if (m.role === 'tool') {
    const content = condenseToolResult(m.content)
    return content === m.content ? m : { ...m, content }
  }
  if (!m.toolCalls?.length) return m
  return { ...m, toolCalls: m.toolCalls.map(foldCallArguments) }
}

function condenseToolResult(content: WireMessage['content']): WireMessage['content'] {
  /*
   * 块数组：**丢掉图像块，只把文本信封收起来**。
   *
   * 图片正是最该被收掉的那一类——一张几 MB 的截图跨轮重放一次就是一次满额，
   * 而收纳的整个用途就是把大段正文换成一句话。丢掉之后模型仍拿得到路径
   * （信封里的 `result.imagePath`），要看重新 `read_file` 一次即可。
   *
   * 写成 `return content` 原样放行的话，带图的工具结果**永远收不掉**。
   */
  if (Array.isArray(content)) {
    const text = content.find((b) => b.type === 'text')
    return text ? condenseToolResult(text.text) : content
  }
  const env = parseEnvelope(content)
  if (!env) return content
  return JSON.stringify({
    call_id: env.call_id,
    tool: env.tool,
    status: env.status,
    executed: env.executed,
    summary: env.summary,
    ...(env.resources ? { resources: env.resources } : {}),
    // 收纳过的再收纳一次必须逐字相同：投影每次构造请求都跑，产物一抖动缓存就全失配。
    ...(env.result !== undefined || env.result_omitted ? { result_omitted: true } : {}),
  })
}

/**
 * 工具结果信封的反序列化。
 *
 * 正文由 `agent/loop.ts` 与 `runtime/transcript.ts` 用 `JSON.stringify` 造，
 * 这里是它的反向。解析不出来的原样返回——收纳换不了信封时保留原文是安全方向，
 * 而让一次投影抛异常会把整轮 run 带崩。
 */
function parseEnvelope(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function foldCallArguments(call: WireToolCall): WireToolCall {
  let folded = false
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call.arguments)) {
    if (typeof value === 'string' && value.length > EXCERPT) {
      args[key] = `${value.slice(0, EXCERPT)}…[已折叠 ${value.length - EXCERPT} 字符]`
      folded = true
    } else {
      args[key] = value
    }
  }
  return folded ? { ...call, arguments: args } : call
}

/**
 * 判断一条用户消息是否带硬约束。
 *
 * **只决定排序，不决定去留**：约束类排在前面，裁旧时最后被裁。
 * 用它做去留过滤时正则漏判一条就等于那条约束只存在于摘要里（可能被改写），
 * 实测在真实会话上抓到 0 条。
 */
function looksLikeConstraint(text: string): boolean {
  return (
    /不要|不能|不得|不用|禁止|必须|务必|一定要|只能|只准|别|避免|千万/.test(text) ||
    /记住|注意|保持|优先|默认|统一|约定|定为|设为|采用|改用|先不|暂不|等.{0,6}再/.test(text) ||
    /\d+\s*(分钟|小时|天|周|秒|毫秒|次|条|个|行|MB|KB|GB|%|万|千)/.test(text)
  )
}

/** 目标算「文件」的动作类别。`run` / `call` / `query` 的 target 是命令串与查询串，不进文件清单。 */
const FILE_ACTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'read',
  'write',
  'edit',
  'delete',
])

export interface CompactionAction {
  stepId: string
  tool: string
  status: string
  /** 动作类别，决定 target 是不是文件路径。 */
  actionKind: ActionKind | null
  target: string | null
  summary: string
  errorCode?: string | null
  /** 这次调用落盘的正文 id。压缩后靠它才能把内容库里那份读回来。 */
  resourceId?: string | null
}

export interface CompactionInput {
  /** 上一条摘要线到新折叠线之间的对话文本，按时间升序。 */
  messages: {
    id: MessageId
    role: 'user' | 'assistant'
    content: string
    hasAttachments?: boolean
  }[]
  /** 同一区间内的工具动作事实。 */
  actions: CompactionAction[]
  /** 上一份 manifest；增量压缩时在它基础上推进。 */
  previous: CompactionManifest | null
  /** 这一次的折叠线。收纳线一定推进到它；摘要线只有摘要段成功才推进到它。 */
  fold: CompactionCut
  /** 收纳段单独就把占用拉回软阈值之下：不调模型，只前移收纳线。 */
  condenseOnly: boolean
  /** 投影总预算（token）。事实清单先占，摘要拿剩下的。 */
  projectionBudget: number
  /** 摘要输出的常态观测（token，p95）。无观测为 null，此时预算就是 headroom。 */
  typicalSummaryTokens: number | null
  /** 被摘要替换掉那一段在收纳之后的占用（token），「必须更小」闸的右侧。 */
  condensedRegionTokens: number
  /** 本次进入摘要线的会话消息条数。 */
  foldedMessageCount: number
}

export type CompactionOutcome =
  /**
   * `summarized` = 摘要线有没有跟着前移。false 时 `reasonCode` 说明摘要段为什么
   * 没做成；没有 `reasonCode` 就是不需要调模型（收纳段已经够了）。
   */
  | { status: 'compacted'; manifest: CompactionManifest; summarized: boolean; reasonCode?: string }
  /** 折叠线以内没有新单元。**不是失败**——调用方不该报错。 */
  | { status: 'skipped'; reasonCode: 'nothing_to_fold' }
  /** 摘要段没做成，且收纳段也无可推进——这一次什么都没做到。 */
  | { status: 'failed'; reasonCode: string; message: string }
  /**
   * 执行期间被中断，整次丢弃，没有任何持久副作用。
   *
   * **调用方不得把它当失败上报**：中断是用户自己的动作，停止时刻多一张红卡是噪音。
   */
  | { status: 'aborted' }

/** 由调用方注入的摘要生成器。预算是 token。返回 null = 空摘要或被输出上限截断。 */
export type Summarizer = (prompt: string, budgetTokens: number) => Promise<string | null>

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
  summarize: Summarizer,
  signal?: AbortSignal,
): Promise<CompactionOutcome> {
  const { previous, fold } = input
  const condensed = condenseCutOf(previous)
  const advancesCondense = cutKey(fold) > (condensed ? cutKey(condensed) : '')

  if (input.condenseOnly) {
    return { status: 'compacted', summarized: false, manifest: advanceCondense(previous, fold) }
  }

  /** 摘要段没做成时的终态：收纳能推进就照常落库，推不动才算这一次彻底没做到。 */
  const summaryFailed = (reasonCode: string, message: string): CompactionOutcome =>
    advancesCondense
      ? {
          status: 'compacted',
          summarized: false,
          reasonCode,
          manifest: advanceCondense(previous, fold),
        }
      : { status: 'failed', reasonCode, message }

  const facts = fitFacts(
    extractFacts(input.messages, input.actions, previous?.facts),
    Math.floor(input.projectionBudget * FACTS_BUDGET_SHARE),
  )
  // 事实清单逐字，优先占预算；摘要拿剩下的。两个量全程按 token 计，没有折算点。
  const headroom = input.projectionBudget - estimateText(factsContent(facts))
  const budget =
    input.typicalSummaryTokens === null ? headroom : Math.min(headroom, input.typicalSummaryTokens)
  if (budget <= 0) return summaryFailed('no_headroom', '折叠之后仍然没有放摘要的空间')

  let summary: string | null
  try {
    summary = await summarize(
      buildSummaryPrompt(
        buildSegments(input.messages, input.actions),
        previous?.summary ?? null,
        budget,
      ),
      budget,
    )
  } catch (err) {
    // 中断与 provider 失败必须分开：中断整次丢弃，其余只是摘要段没做成。
    if (isAbortError(err)) return { status: 'aborted' }
    return summaryFailed('summary_error', err instanceof Error ? err.message : String(err))
  }

  // 摘要期间信号被拉起（摘要器自己吞掉了中断）时，这一次的产物同样作废。
  // 落库端还有一道守卫，两道的判据是同一个信号。
  if (signal?.aborted) return { status: 'aborted' }
  if (!summary?.trim()) return summaryFailed('summary_empty', '摘要为空或被输出上限截断')

  const candidate: CompactionManifest = {
    revision: (previous?.revision ?? 0) + 1,
    compactedThroughMessageId: fold.messageId,
    ...(fold.step ? { compactedThroughStep: fold.step } : {}),
    condensedThrough: fold,
    compactedMessageCount: (previous?.compactedMessageCount ?? 0) + input.foldedMessageCount,
    summary: summary.trim(),
    facts,
    createdAt: Date.now(),
  }

  /*
   * 「必须更小」闸。
   *
   * 两侧用同一把估算尺，系统性偏差同向抵消。不成立就作废摘要段——投影比被它
   * 替换的内容还大时，这次压缩把上下文变大了，而不会有任何报错。
   * 它同时是事实包跨压缩累积的总闸：每折一次，模型看到的总量必须净减。
   */
  const replaced =
    (previous ? estimateMessages(projectManifest(previous)) : 0) + input.condensedRegionTokens
  if (estimateMessages(projectManifest(candidate)) >= replaced) {
    return summaryFailed('not_smaller', '新投影没有比被替换的内容更小')
  }

  return { status: 'compacted', summarized: true, manifest: candidate }
}

/** 只前移收纳线：摘要线、事实包、消息计数原样沿用。 */
function advanceCondense(
  previous: CompactionManifest | null,
  fold: CompactionCut,
): CompactionManifest {
  return {
    revision: (previous?.revision ?? 0) + 1,
    compactedThroughMessageId: previous?.compactedThroughMessageId ?? null,
    ...(previous?.compactedThroughStep
      ? { compactedThroughStep: previous.compactedThroughStep }
      : {}),
    condensedThrough: fold,
    compactedMessageCount: previous?.compactedMessageCount ?? 0,
    summary: previous?.summary ?? '',
    facts: previous?.facts ?? { filesTouched: [], openItems: [], userConstraints: [] },
    createdAt: Date.now(),
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
  actions: CompactionAction[],
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
    if (a.summary) parts.push(`结果=${excerpt(a.summary, EXCERPT)}`)
    out.push(`[action:${a.stepId}] ${parts.join('；')}`)
  }
  return out
}

/**
 * 提取精确事实包。
 *
 * 这部分**不经过模型**——文件路径、用户约束这类事实一旦被摘要改写就不再可靠，
 * 而模型后续会拿它们去改文件。宁可机械提取得保守一点，也不能让它们变成一个近似的路径。
 *
 * 与上一份 facts 合并而不是替换：压缩是增量的，早期定下的约束不能随着一次新压缩消失。
 */
function extractFacts(
  messages: CompactionInput['messages'],
  actions: CompactionAction[],
  previous: CompactionFacts | undefined,
): CompactionFacts {
  const filesTouched = new Set(previous?.filesTouched ?? [])
  // 按动作类别收，**不要按 target 长得像不像路径收**：`run_command` 的 target 是
  // 整条命令串，正则一放它们就整串进来，实测清单胀到摘要的十几倍。
  for (const a of actions) {
    if (a.target && a.actionKind && FILE_ACTION_KINDS.has(a.actionKind)) filesTouched.add(a.target)
  }

  const openItems = [...(previous?.openItems ?? [])]
  // 落盘产物的定位符。合并而不是替换——早期落的那份正文压缩之后照样要能读回。
  const resources = new Set(previous?.resources ?? [])
  for (const a of actions) {
    if (a.resourceId) resources.add(`${a.tool}${a.target ? ` ${a.target}` : ''} → ${a.resourceId}`)
  }
  for (const a of actions) {
    if (a.status === 'failure') {
      openItems.push(
        `${a.tool}${a.target ? ` ${a.target}` : ''} 失败${a.errorCode ? `（${a.errorCode}）` : ''}`,
      )
    }
  }

  /*
   * 用户消息**全部**逐字进事实包，约束类排前面。
   *
   * 用正则筛去留会漏：真实会话上那三条正则一条都没命中过。逐字收录不会把投影
   * 推过原文——事实包是原文的子集，上界由「必须更小」闸与 `fitFacts` 的预算兜住。
   */
  const fresh: string[] = []
  for (const m of messages) {
    const text = (m.content ?? '').trim()
    if (!text || m.role !== 'user') continue
    fresh.push(excerpt(text, EXCERPT))
  }
  const userConstraints = [
    ...new Set([
      ...(previous?.userConstraints ?? []),
      ...fresh.filter(looksLikeConstraint),
      ...fresh.filter((t) => !looksLikeConstraint(t)),
    ]),
  ]

  return {
    filesTouched: [...filesTouched],
    openItems: dedupeKeepLatest(openItems),
    userConstraints,
    ...(resources.size ? { resources: [...resources] } : {}),
  }
}

function dedupeKeepLatest(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // 从后往前去重再反转：重复项保留**最近**那次，早期的同义重复丢掉。
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i]!
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.reverse()
}

/**
 * 把事实清单裁进预算。
 *
 * 收的顺序就是裁旧的反序：**约束最后被裁**，其次未解决项与落盘定位符，
 * 文件清单最先让位——文件路径重读一次就有，而「永远不要 force-push」这类
 * 第一天定下的铁律丢了就没了。每类内部从最近往早收。
 *
 * 顺序写成代码不写成配置：它是正确性判断，不是口味。
 */
function fitFacts(facts: CompactionFacts, budget: number): CompactionFacts {
  let spent = 0
  const take = (list: readonly string[]): string[] => {
    const kept: string[] = []
    for (let i = list.length - 1; i >= 0; i--) {
      const cost = estimateText(`- ${list[i]!}\n`)
      if (spent + cost > budget) break
      spent += cost
      kept.push(list[i]!)
    }
    return kept.reverse()
  }
  const userConstraints = take(facts.userConstraints)
  const openItems = take(facts.openItems)
  const resources = take(facts.resources ?? [])
  const filesTouched = take(facts.filesTouched)
  return {
    filesTouched,
    openItems,
    userConstraints,
    ...(resources.length ? { resources } : {}),
  }
}

/**
 * 摘要提示。**分节，不是一段并列的自由要求。**
 *
 * 并列要求会被模型当成风格建议，「约束用原话」在长会话里几乎必然被概括掉，
 * 而约束一旦被概括就可能反转含义。分节的关键在头两节：**逐条列出全部用户消息**、
 * **带上文件路径**——这把「保真」变成可检查的结构，少列一条用户消息是看得出来的，
 * 而「概括得不够准」看不出来。
 *
 * 被折区的大头是执行记录不是对话，所以节题按执行记录组织，并明确要求
 * 不复述调用过程——过程已经由收纳段的信封逐条留着了，摘要再抄一遍就是两份。
 */
/**
 * 一个 token 大约折几个中文字。
 *
 * 用来把 token 预算翻译成提示词里那句字数要求——**模型只认字数，不认 token**。
 * 取 0.6 而不是 1/1.5：留一成余量，因为摘要里混着文件路径这类 ASCII，
 * 同样的字数会比纯中文多耗 token。宁可写短一点，也不能被 `max_tokens` 截断作废。
 */
const CHARS_PER_TOKEN_ZH = 0.6

function buildSummaryPrompt(
  segments: string[],
  previousSummary: string | null,
  budgetTokens: number,
): string {
  const head = previousSummary
    ? `已有摘要（本次在它基础上续写，不要重复其中内容）：\n${previousSummary}\n\n`
    : ''
  return (
    `${head}把下面的执行记录压缩成一份交接摘要，按这几节输出，不要开场白：\n\n` +
    `## 用户要求\n逐条列出**全部**用户消息的意图，一条不能少。原话里的约束` +
    `（不要做什么、必须用什么、具体数值与期限）**逐字引用**，不要改写。\n\n` +
    `## 已完成与产出\n改了哪些文件、做成了什么。带上文件路径。\n\n` +
    `## 关键发现与结论\n查出了什么、定了什么、为什么这么定。保留判断理由；` +
    `缺少理由会导致下一轮重复讨论。\n\n` +
    `## 当前状态与未解决\n正在做什么、卡在哪里、有哪些已知失败。\n\n` +
    `## 下一步\n接手者应该先做什么。涉及具体位置时**引用原文**，不要只说「那个文件」。\n\n` +
    `**工具调用过程不要复述**，只留结论与产物；失败的尝试细节、重复的确认可以丢掉。\n\n` +
    /*
     * 字数要求不是排版偏好，是**硬约束**。
     *
     * 摘要以 `max_tokens` 收尾时整份作废（半份摘要看起来完整，比没有更坏），
     * 而不告诉模型预算，它就按自己的节奏写、写超、被截断、作废——因此摘要段
     * 恒失败，压缩退化成只有收纳段，占用降不下来，下一次预算还是这么小。
     * 这条恶性循环在小窗口模型上必然发生。
     */
    `**整份摘要控制在 ${Math.max(200, Math.floor(budgetTokens * CHARS_PER_TOKEN_ZH))} 字以内**，` +
    `超出长度会被截断并整份作废。超长时压缩各节措辞，不得省略章节。\n\n` +
    /*
     * 定位符必须完整穿过摘要。
     *
     * 每条记录前面的 `[message:…]` / `[action:…]` 是原文的地址，摘要之后模型
     * 只能靠它用 `read_history` 回到原文。丢掉它，压缩就从「把内容挪到按需读取」
     * 退回成「丢掉」——而这正是这一段提示词存在的全部理由。
     */
    `提到某条具体记录时，把它前面那个 \`[message:…]\` 或 \`[action:…]\` 标记` +
    `**原样带上**（例如「按 [message:ms_x] 的要求…」）。标记是原文的地址，` +
    `缺失后无法回溯原文。不要生成不存在的标记。\n\n` +
    `执行记录：\n${segments.join('\n')}`
  )
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
  return [
    {
      role: 'user',
      // 尾巴上这句是**能力边界**不是解释：没有它，模型不知道折掉的原文还取得回来，
      // 因此要么当作已经丢失、要么重新把工作做一遍。
      content:
        `[此处是被压缩的早期对话摘要，修订版本 ${manifest.revision}]\n\n${manifest.summary}\n\n` +
        `（摘要里的 [message:…] / [action:…] 是原文地址，需要原文用 read_history 取回。）`,
    },
    { role: 'assistant', content: factsContent(manifest.facts) },
  ]
}

/** 事实清单那一条的正文。预算估算与投影共用它，两处各拼一遍就会各估各的。 */
function factsContent(f: CompactionFacts): string {
  const lines: string[] = []
  if (f.userConstraints.length)
    lines.push(`用户约束：\n${f.userConstraints.map((s) => `- ${s}`).join('\n')}`)
  if (f.filesTouched.length) lines.push(`涉及文件：${f.filesTouched.join('、')}`)
  if (f.resources?.length) {
    lines.push(
      `落盘产物（需要正文时用 read_resource 取回）：\n${f.resources.map((s) => `- ${s}`).join('\n')}`,
    )
  }
  if (f.openItems.length) lines.push(`未解决：\n${f.openItems.map((s) => `- ${s}`).join('\n')}`)
  return lines.length
    ? `已确认的事实清单（逐字保留，不要改写）：\n\n${lines.join('\n\n')}`
    : '已确认的事实清单：无。'
}

function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}
