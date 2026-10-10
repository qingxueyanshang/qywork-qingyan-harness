/**
 * 上下文压缩：两段式流程，单一入口。
 *
 * 本文件只负责压缩方式；压缩时机由 `agent/loop/compact.ts` 决定（发送前按占用与软阈值判定），
 * 取数与落库由 `runtime/compaction.ts` 负责。
 *
 * 按内容性质分工：确定性内容由算法处理，叙事性内容由模型处理。
 * 工具结果正文、调用参数、文件路径、资源定位符经过一次概括即不再可靠，而模型会依据
 * 它们修改文件，因此收纳段（`condenseMessage`）只保留信封、不改写保留的字节；多轮意图、
 * 当前状态、关键决定无法用正则归纳，交给摘要段。
 *
 * 四条不变量：
 *
 * 1. 压缩是投影，不销毁数据。压缩产出一份 manifest，构造请求时按它投影；
 *    Message、Step 与正文库的字节均不改动。因此压缩可撤销、可重放，历史面板
 *    始终显示完整会话。
 * 2. 两条边界，收纳线 ≥ 摘要线。摘要线以内替换为「摘要 + 事实清单」，
 *    摘要线到收纳线之间消息原样、工具正文精简，收纳线之后逐字原样。
 * 3. 摘要段失败不回退整次压缩。收纳段是确定性产物，模型未写出摘要时收纳段照常
 *    落库、摘要线不变。不要为此增加本地拼装的降级摘要：机械截取的摘要与模型写的
 *    摘要外观相同，用户无从分辨。
 * 4. 中断即丢弃，不设例外。信号 abort 之后一律返回 `aborted`，包括摘要已生成完成的
 *    情形。压缩不可逆地改写模型可见的历史，中断后落库等于用用户未等待的摘要替换其会话。
 *    不要为「摘要已生成完成」设例外：增加一条例外即形成两条规则，而重新执行压缩的成本
 *    是零次模型调用。
 */

import type {
  ChatRequest,
  ProviderUsage,
  TokenDensity,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import { estimateMessages, estimateText } from '@qywork/ai'
import type {
  ActionKind,
  CompactionCut,
  CompactionFacts,
  CompactionManifest,
  FileReadProgress,
  ProviderHedge,
} from '@qywork/core'

/**
 * 摘录长度上限：segment、事实条目、被折叠的调用参数共用该长度。
 *
 * 「一条事实一两句话」是可读性取舍，运行期没有可测量的依据。
 */
const EXCERPT = 320

/**
 * 事实清单占投影预算的比例上限。
 *
 * 逐字事实与叙事摘要各占一半。不划分时，事实清单在预算紧张时占满整份预算，摘要段随即
 * 因没有空间而失败，刚裁剪好的事实清单也随之作废：摘要线不变，事实清单不进入 manifest。
 */
const FACTS_BUDGET_SHARE = 0.5

/**
 * 可折单元的戳记。
 *
 * 字典序即产生顺序：run id 与 step seq 都单调递增，seq 定宽补零。
 * 同一执行波次的全部消息共用一个戳，切分边界只落在戳之间。
 */
export function stepStamp(runId: string, seq: number): string {
  return `${runId}:${String(seq).padStart(9, '0')}`
}

/**
 * 一条消息在折叠顺序中的位置。`null` 表示不参与折叠（摘要投影等无戳消息）。
 *
 * 先比较消息 id，同一消息内再比较 step 戳：消息本体的戳为空串，排在其执行记录之前。
 */
export function unitKey(m: WireMessage): string | null {
  return m._messageId ? `${m._messageId}|${m._step ?? ''}` : null
}

/** 边界在折叠顺序中的位置。必须与 `unitKey` 格式一致，否则边界切分位置错误。 */
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

/** 收纳线。manifest 缺少该键时收纳线与摘要线重合。 */
export function condenseCutOf(m: CompactionManifest | null): CompactionCut | null {
  return m?.condensedThrough ?? summaryCutOf(m)
}

/**
 * 收纳一条消息：只保留信封，保留部分的字节不改写。
 *
 * 工具结果只保留 `call_id / tool / status / executed / summary` 与落盘定位符 `resources`，
 * 移除正文：超过投递上限的正文已写入 sink，`read_resource` 可按这些 id 取回原文。
 * 调用参数中的长字符串（如 `write_file` 的完整正文）折叠为摘录与标记。
 *
 * `reasoningContent` 原样保留：带 tool_calls 的历史 assistant 消息缺少思考正文时，
 * DeepSeek 类兼容端点返回 400。
 *
 * 产物必须是纯函数结果、逐字稳定：每次构造请求都会执行投影，混入时间戳或随机量会使
 * 缓存断点之前的字节每次变化，前缀缓存始终无法命中。
 */
export function condenseMessage(m: WireMessage): WireMessage {
  if (m.role === 'tool') {
    const content = condenseToolResult(m.content)
    return content === m.content ? m : { ...m, content }
  }
  if (!m.toolCalls?.length) return m
  return { ...m, toolCalls: m.toolCalls.map(foldCallArguments) }
}

/**
 * 媒体块被移出后信封中 `images_omitted` 的值，由装配阶段的换出（`loop/request.ts` 的
 * `evictedMedia` 与 `omitImages`）与收纳共用。
 *
 * 该值陈述「此前已发送给你、现已移出」这一传输事实：装配阶段只换出最后一条 assistant 之前的
 * 媒体，它们已随得到回应的请求发出；收纳只作用于收纳线之前的较早轮次。
 * 不要写成「你已看过」：端点收到请求不等于模型读到了图像，部分端点会丢弃媒体块而不报错。
 * 也不要只写 `true` 或「已提供」：移除图像会使其后的原生推理失效，模型会判断自己从未收到
 * 该图像，向用户否认之前的检查并反复重新读取。系统提示词「工作方式」一节有同一条规则。
 * 必须逐字稳定：每次构造请求时投影都会重新生成这段文字。
 */
export const IMAGES_OMITTED =
  '此图像或视频此前已随请求发送给你，现已从请求中移出（较早的媒体超出保留上限，或这段上下文已压缩）。需要画面细节时，通过 read_history 按 call_id 取回。'

function condenseToolResult(content: WireMessage['content']): WireMessage['content'] {
  /*
   * 块数组：丢弃媒体块，只收纳文本信封，并在信封中标记 `images_omitted`。
   *
   * 装配时仍保留的媒体（`loop/request.ts` 的 `evictedMedia` 未换出的部分）位于收纳线之前时同样丢弃：
   * 触发压缩说明上下文空间已紧张，较早轮次的媒体最先移出。标记不可省略：收纳后的信封与新生成的
   * 成功信封形状相同，缺少该字段时模型会认为图像仍然可见。需要再次查看时按原路径重新 `read_file`，
   * 或用 `call_id` 经 `read_history` 取回。
   *
   * 不要改为 `return content` 原样返回，否则带图的工具结果永远无法收纳。
   */
  if (Array.isArray(content)) {
    const text = content.find((b) => b.type === 'text')
    if (!text) return content
    const env = parseEnvelope(text.text)
    if (!env) return text.text
    const dropped = content.some((b) => b.type === 'image' || b.type === 'video')
    return condenseToolResult(
      JSON.stringify(dropped ? { ...env, images_omitted: IMAGES_OMITTED } : env),
    )
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
    ...(env.images_omitted ? { images_omitted: IMAGES_OMITTED } : {}),
    // 已收纳的内容再次收纳必须逐字相同：每次构造请求都执行投影，产物一旦变化，缓存全部失效。
    ...(env.result !== undefined || env.result_omitted ? { result_omitted: true } : {}),
  })
}

/**
 * 工具结果信封的反序列化。
 *
 * 正文由 `agent/loop/request.ts` 与 `runtime/transcript.ts` 用 `JSON.stringify` 生成，
 * 此处执行逆操作。无法解析时原样返回：无法收纳时保留原文是安全的处理，
 * 而投影抛出异常会使整轮 run 失败。
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
  const folded = foldValue(call.arguments)
  return folded === call.arguments
    ? call
    : { ...call, arguments: folded as Record<string, unknown> }
}

/**
 * 把任意深度的长字符串折叠为摘录与标记，对象与数组的结构原样保留。没有可折叠内容时返回原引用。
 *
 * 不要只折叠顶层：批量写入类工具把正文放在 `files[].content` 等嵌套位置，只折叠顶层时
 * 这些参数永远无法收纳。
 */
function foldValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > EXCERPT
      ? `${value.slice(0, EXCERPT)}…[已折叠 ${value.length - EXCERPT} 字符]`
      : value
  }
  if (Array.isArray(value)) {
    const items = value.map(foldValue)
    return items.some((item, i) => item !== value[i]) ? items : value
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k, foldValue(v)] as const)
    return entries.some(([k, v]) => v !== (value as Record<string, unknown>)[k])
      ? Object.fromEntries(entries)
      : value
  }
  return value
}

/**
 * 判断一条用户消息是否包含硬约束。
 *
 * 只决定排序，不决定去留：约束类排在前面，裁剪时最后被裁。
 * 用它过滤去留时，正则每漏判一条，该约束就只存在于摘要中（可能被改写）；
 * 实测在真实会话上命中 0 条。
 */
function looksLikeConstraint(text: string): boolean {
  return (
    /不要|不能|不得|不用|禁止|必须|务必|一定要|只能|只准|别|避免|千万/.test(text) ||
    /记住|注意|保持|优先|默认|统一|约定|定为|设为|采用|改用|先不|暂不|等.{0,6}再/.test(text) ||
    /\d+\s*(分钟|小时|天|周|秒|毫秒|次|条|个|行|MB|KB|GB|%|万|千)/.test(text)
  )
}

/** target 视为文件路径的动作类别。`run` / `call` / `query` 的 target 是命令串与查询串，不进入文件清单。 */
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
  /** 动作类别，决定 target 是否为文件路径。 */
  actionKind: ActionKind | null
  target: string | null
  summary: string
  errorCode?: string | null
  /** 本次调用落盘的正文 id。压缩后依靠它从内容库读取原文。 */
  resourceId?: string | null
  /** 按行读取时本次读取的行段与文件总行数；其余调用为 null 或缺省。 */
  lines?: { from: number; to: number; total: number } | null
}

export interface CompactionInput {
  /** 上一条摘要线到新折叠线之间的对话文本，按时间升序。 */
  messages: {
    /**
     * 取回地址，在摘要中写为 `[message:<id>]`。有两种格式：
     * `messages` 表中的行是 `MessageId`；run 内注入的用户消息是 `<runId>:<stepId>`，
     * 它不在 `messages` 表中（见 `StepKind` 的 `'user'`）。
     * 两种都由 `HistoryPort.message` 解析，对模型没有区别。
     */
    id: string
    role: 'user' | 'assistant'
    content: string
    hasAttachments?: boolean
  }[]
  /** 同一区间内的工具动作事实。 */
  actions: CompactionAction[]
  /** 上一份 manifest；增量压缩时在它基础上推进。 */
  previous: CompactionManifest | null
  /** 本次的折叠线。收纳线必定推进到此处；摘要线只在摘要段成功时推进到此处。 */
  fold: CompactionCut
  /** 仅收纳段即可使占用回到软阈值以下：不调用模型，只前移收纳线。 */
  condenseOnly: boolean
  /**
   * 会话主模型的估算密度，不是 summarizer 的：这些量描述主模型看到的上下文，
   * 改用摘要模型的密度等于用另一个 tokenizer 度量主模型的窗口。
   */
  density: TokenDensity
  /** 投影总预算（token）。事实清单优先占用，摘要使用剩余部分。 */
  projectionBudget: number
  /** 摘要输出长度的常态观测值（token，p95）。无观测时为 null，此时预算等于 headroom。 */
  typicalSummaryTokens: number | null
  /** 被摘要替换的区段在收纳之后的占用（token），即「必须更小」检查的右侧。 */
  condensedRegionTokens: number
  /** 本次进入摘要线的会话消息条数。 */
  foldedMessageCount: number
  /** 摘要请求的记账钩子：一轮之内压缩时由主循环提供，手动压缩时由服务端提供。 */
  trace?: SummaryTrace
}

export type CompactionOutcome =
  /**
   * `summarized` 表示摘要线是否随之前移。为 false 时 `reasonCode` 说明摘要段未完成的原因；
   * 没有 `reasonCode` 表示无需调用模型（仅收纳段即已足够）。
   */
  | {
      status: 'compacted'
      manifest: CompactionManifest
      summarized: boolean
      reasonCode?: string
      message?: string
    }
  /** 折叠线以内没有新单元。这不是失败，调用方不应报错。 */
  | { status: 'skipped'; reasonCode: 'nothing_to_fold' }
  /** 摘要段未完成，且收纳线也无法前移：本次压缩没有产生任何结果。 */
  | { status: 'failed'; reasonCode: string; message: string }
  /**
   * 执行期间被中断，整次丢弃，没有任何持久副作用。
   *
   * 调用方不得将其作为失败上报：中断由用户主动发起，停止时额外显示一张错误卡片属于干扰信息。
   */
  | { status: 'aborted' }

/**
 * 摘要请求的记账钩子。一轮之内压缩时由主循环提供：摘要请求按该轮的普通请求写入
 * `provider_requests`，返回的 usage 计入所属轮次；手动压缩使用同一套记账钩子。
 */
export interface SummaryTrace {
  /** 发送前登记，返回请求 id。 */
  open(req: ChatRequest, adapter?: import('@qywork/ai').LlmAdapter): string
  sent(requestId: string): void
  /** `at` 是 `response_started` 带来的传输层观察时刻，不是调用时刻。 */
  headers(requestId: string, at: number): void
  /** 响应头之前补发过第二份请求；规则与主请求相同。 */
  hedge(requestId: string, hedge: ProviderHedge): void
  firstEvent(requestId: string): void
  /** 每段非空内容都调用；`at` 是适配器解析该段时的观察时刻，不是调用时刻。 */
  content(
    requestId: string,
    at: number,
    kind?: import('@qywork/core').ProviderRequestContentKind,
  ): void
  diagnostic(requestId: string, diagnostic: import('@qywork/core').ProviderRequestDiagnostic): void
  settle(
    requestId: string,
    status: 'received' | 'uncertain' | 'rejected',
    usage: ProviderUsage | null,
    errorCode: string | null,
    finishReason?: string,
    errorMessage?: string | null,
  ): void
}

/** 由调用方注入的摘要生成器，预算单位为 token。返回 null 表示摘要为空或被输出上限截断。 */
export type Summarizer = (
  prompt: string,
  budgetTokens: number,
  trace?: SummaryTrace,
) => Promise<string | null>

/**
 * 摘要调用是否因中断而终止。
 *
 * 按 `name` 判定，不用 `instanceof DOMException`：中断可能由 `AbortSignal` 原生抛出，
 * 也可能由适配器层包装后抛出；跨 realm 时 `instanceof` 不成立，而 `name` 始终成立。
 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

/**
 * 执行一次压缩，产出新的 manifest。
 *
 * 不抛出异常：压缩失败时返回结构化结果，由调用方决定原样重试或放弃。
 * 抛出异常会使压缩失败与 run 异常终止在调用栈上无法区分。
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

  /** 摘要段未完成时的终态：收纳线可前移时照常落库，无法前移时本次判定为失败。 */
  const summaryFailed = (reasonCode: string, message: string): CompactionOutcome =>
    advancesCondense
      ? {
          status: 'compacted',
          summarized: false,
          reasonCode,
          message,
          manifest: advanceCondense(previous, fold),
        }
      : { status: 'failed', reasonCode, message }

  const facts = fitFacts(
    extractFacts(input.messages, input.actions, previous?.facts),
    Math.floor(input.projectionBudget * FACTS_BUDGET_SHARE),
    input.density,
  )
  // 事实清单逐字保留，优先占用预算；摘要使用剩余部分。两个量全程按 token 计，不做单位换算。
  const headroom = input.projectionBudget - estimateText(factsContent(facts), input.density)
  const budget =
    input.typicalSummaryTokens === null ? headroom : Math.min(headroom, input.typicalSummaryTokens)
  if (budget <= 0) return summaryFailed('no_headroom', '折叠后仍没有容纳摘要的空间')

  let summary: string | null
  try {
    summary = await summarize(
      buildSummaryPrompt(
        buildSegments(input.messages, input.actions),
        previous?.summary ?? null,
        budget,
      ),
      budget,
      input.trace,
    )
  } catch (err) {
    // 中断与 provider 失败必须区分：中断时整次丢弃，其余失败只表示摘要段未完成。
    if (isAbortError(err)) return { status: 'aborted' }
    return summaryFailed('summary_error', err instanceof Error ? err.message : String(err))
  }

  // 摘要期间中止信号已触发（摘要器自行捕获了中断而未抛出）时，本次产物同样作废。
  // 落库端另有一道检查，两处依据同一个信号。
  if (signal?.aborted) return { status: 'aborted' }
  if (!summary?.trim()) return summaryFailed('summary_empty', '摘要为空或被输出上限截断')
  /*
   * 「在预算内」检查：摘要超出事实清单之外的剩余预算时作废摘要段，提示词中已写明该限制。
   * 只有下方的「必须更小」检查不够：被替换的区域很大时，远超预算的摘要同样比它小，
   * 压缩落库后占用仍在软阈值以上。
   */
  if (estimateText(summary.trim(), input.density) > headroom) {
    return summaryFailed('over_budget', '摘要超出投影预算')
  }

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
   * 「必须更小」检查。
   *
   * 两侧使用同一估算方法，系统性偏差同向抵消。条件不成立时作废摘要段：投影大于被替换的
   * 内容时，本次压缩反而增大上下文，且不产生任何错误。
   * 该检查同时约束事实包跨多次压缩的累积：每次折叠后，模型看到的总量必须净减少。
   */
  const replaced =
    (previous ? estimateMessages(projectManifest(previous), input.density) : 0) +
    input.condensedRegionTokens
  if (estimateMessages(projectManifest(candidate), input.density) >= replaced) {
    return summaryFailed('not_smaller', '新投影不小于被替换的内容')
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
 * 把消息与动作展平为带来源标记的片段。
 *
 * `[message:id]` / `[action:id]` 前缀有意保留：摘要中提到某次读取（如 config.ts）时，
 * 可按 id 回溯原始记录。摘要是投影而不是替代，可追溯是其前提。
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
 * 此部分不经过模型：文件路径、用户约束等事实一经摘要改写即不再可靠，
 * 而模型后续会依据它们修改文件。机械提取应保守，不能产生近似的路径。
 *
 * 与上一份 facts 合并而不是替换：压缩是增量的，早期确定的约束不能随新一次压缩消失。
 */
function extractFacts(
  messages: CompactionInput['messages'],
  actions: CompactionAction[],
  previous: CompactionFacts | undefined,
): CompactionFacts {
  const filesTouched = new Set(previous?.filesTouched ?? [])
  // 按动作类别收录，不要按 target 是否形似路径收录：`run_command` 的 target 是整条命令串，
  // 用正则判定时整串命令都会被收录，实测清单膨胀到摘要的十几倍。
  for (const a of actions) {
    if (a.target && a.actionKind && FILE_ACTION_KINDS.has(a.actionKind)) filesTouched.add(a.target)
  }

  // 落盘产物的定位符。合并而不是替换：较早落盘的正文在压缩后仍须可以读取。
  const resources = new Set(previous?.resources ?? [])
  for (const a of actions) {
    if (a.resourceId) resources.add(`${actionLabel(a)} → ${a.resourceId}`)
  }
  /*
   * 未解决项按时间顺序核销：同一工具对同一目标先失败后成功时，该失败不再列为未解决。
   * 判据要求工具与目标都相同，其他目标的成功不核销。只累加不核销时，
   * 模型每次压缩后都会看到已解决的失败，并据此重做。
   */
  let openItems = [...(previous?.openItems ?? [])]
  for (const a of actions) {
    const failed = `${actionLabel(a)} 失败`
    if (a.status === 'failure') {
      openItems.push(`${failed}${a.errorCode ? `（${a.errorCode}）` : ''}`)
    } else if (a.status === 'success') {
      openItems = openItems.filter((item) => item !== failed && !item.startsWith(`${failed}（`))
    }
  }

  /*
   * 用户消息全部进入事实包，约束类排在前面。
   *
   * 用正则筛选去留会遗漏：在真实会话上三条正则均未命中。逐字收录不会使投影超过原文：
   * 事实包是原文的子集，上限由「必须更小」检查与 `fitFacts` 的预算保证。
   *
   * 长消息按全文判定约束，摘录带约束的句子并附原文地址：先截取头部再判定时，
   * 位于后部的「不要…」既不被判定为约束，也不进入事实包。
   */
  const fresh: string[] = []
  for (const m of messages) {
    const text = (m.content ?? '').trim()
    if (!text || m.role !== 'user') continue
    fresh.push(userFact(m.id, text))
  }
  const userConstraints = [
    ...new Set([
      ...(previous?.userConstraints ?? []),
      ...fresh.filter(looksLikeConstraint),
      ...fresh.filter((t) => !looksLikeConstraint(t)),
    ]),
  ]

  const filesRead = mergeReads(previous?.filesRead ?? [], actions)

  return {
    filesTouched: [...filesTouched],
    openItems: dedupeKeepLatest(openItems),
    userConstraints,
    ...(resources.size ? { resources: [...resources] } : {}),
    ...(filesRead.length ? { filesRead } : {}),
  }
}

/** 把成功的按行读取并入读取进度：同一文件的行段按起点排序，重叠或相邻的合并。 */
function mergeReads(
  previous: readonly FileReadProgress[],
  actions: readonly CompactionAction[],
): FileReadProgress[] {
  const byPath = new Map<string, FileReadProgress>(
    previous.map((p) => [p.path, { ...p, ranges: p.ranges.map(([a, b]) => [a, b]) }]),
  )
  for (const a of actions) {
    if (a.status !== 'success' || a.actionKind !== 'read' || !a.target || !a.lines) continue
    const entry = byPath.get(a.target) ?? { path: a.target, totalLines: a.lines.total, ranges: [] }
    entry.totalLines = a.lines.total
    entry.ranges.push([a.lines.from, a.lines.to])
    byPath.set(a.target, entry)
  }
  return [...byPath.values()].map((entry) => {
    const sorted = [...entry.ranges].sort((x, y) => x[0] - y[0])
    const merged: [number, number][] = []
    for (const [from, to] of sorted) {
      const last = merged.at(-1)
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
      else merged.push([from, to])
    }
    return { ...entry, ranges: merged }
  })
}

/** 读取进度的一行：`path：已读第 1–27000、27001–30000 行（共 187500 行）`。 */
function readProgressLine(p: FileReadProgress): string {
  const ranges = p.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join('、')
  return `${p.path}：已读第 ${ranges} 行（共 ${p.totalLines} 行）`
}

/** 动作在事实清单中的名称：工具名加目标。未解决项按该名称逐字匹配核销。 */
function actionLabel(a: CompactionAction): string {
  return `${a.tool}${a.target ? ` ${a.target}` : ''}`
}

/**
 * 一条用户消息在事实包中的写法。
 *
 * 未超出长度上限时写原文；超出时摘录带约束的句子，没有则取头部；截断过的附上 `[message:…]`，
 * 模型需要全文时据此用 `read_history` 取回。
 */
function userFact(id: string, text: string): string {
  if (text.length <= EXCERPT) return excerpt(text, EXCERPT)
  const hits = text.split(/(?<=[。！？!?；;\n])/).filter(looksLikeConstraint)
  return `${excerpt(hits.length ? hits.join(' ') : text, EXCERPT)}（原文 [message:${id}]）`
}

function dedupeKeepLatest(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // 从后往前去重再反转：重复项保留最近一次，较早的重复项丢弃。
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i]!
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.reverse()
}

/**
 * 把事实清单裁剪到预算以内。
 *
 * 收录顺序与裁剪顺序相反：约束最后被裁剪，其次是未解决项与落盘定位符，文件清单最先被裁剪：
 * 文件路径重新读取即可恢复，而「永远不要 force-push」这类约束一旦丢失将无法恢复。
 * 每类内部从最近向较早收录。
 *
 * 用户消息中带约束的先收录、其余后收录：两者混合按时间倒序收录时，较新的普通消息会先
 * 耗尽预算，挤掉较早的禁止性要求。
 *
 * 顺序写在代码中而不是配置中：它关系到正确性，不是偏好。
 */
function fitFacts(facts: CompactionFacts, budget: number, density: TokenDensity): CompactionFacts {
  let spent = 0
  const take = (list: readonly string[]): string[] => {
    const kept: string[] = []
    for (let i = list.length - 1; i >= 0; i--) {
      const cost = estimateText(`- ${list[i]!}\n`, density)
      if (spent + cost > budget) break
      spent += cost
      kept.push(list[i]!)
    }
    return kept.reverse()
  }
  const binding = take(facts.userConstraints.filter(looksLikeConstraint))
  const userConstraints = [
    ...binding,
    ...take(facts.userConstraints.filter((t) => !looksLikeConstraint(t))),
  ]
  const openItems = take(facts.openItems)
  // 读取进度排在文件清单之前：缺少读取进度时模型无法得知读取位置，会从头重新读取。
  const readLines = new Set(take((facts.filesRead ?? []).map(readProgressLine)))
  const filesRead = (facts.filesRead ?? []).filter((p) => readLines.has(readProgressLine(p)))
  const resources = take(facts.resources ?? [])
  const filesTouched = take(facts.filesTouched)
  return {
    filesTouched,
    openItems,
    userConstraints,
    ...(resources.length ? { resources } : {}),
    ...(filesRead.length ? { filesRead } : {}),
  }
}

/**
 * 摘要提示词：分节输出，而不是一段并列的自由要求。
 *
 * 并列要求会被模型视为风格建议，「约束用原话」在长会话中几乎必然被概括，
 * 而约束一经概括就可能反转含义。分节的关键在前两节：逐条列出全部用户消息、注明文件路径。
 * 这使保真度成为可检查的结构：少列一条用户消息可以发现，而概括不准确无法发现。
 *
 * 被折叠区域的主要内容是执行记录而不是对话，因此各节标题按执行记录组织，并明确要求
 * 不复述调用过程：收纳段的信封已逐条保留调用过程，摘要再复述即形成两份。
 */
/**
 * 一个 token 约合多少个汉字。
 *
 * 用于把 token 预算换算为提示词中的字数要求：模型能遵循字数，无法遵循 token 数。
 * 取 0.6 而不是 1/1.5，预留一成余量：摘要中混有文件路径等 ASCII 内容，相同字数比纯中文
 * 消耗更多 token。摘要宁可偏短，也不能被 `max_tokens` 截断而作废。
 */
const CHARS_PER_TOKEN_ZH = 0.6

function buildSummaryPrompt(
  segments: string[],
  previousSummary: string | null,
  budgetTokens: number,
): string {
  const head = previousSummary
    ? `已有摘要（本次在其基础上续写，不要重复其中内容）：\n${previousSummary}\n\n`
    : ''
  return (
    `${head}将以下执行记录压缩为一份交接摘要，按下列各节输出，不要开场白：\n\n` +
    `## 用户要求\n逐条列出**全部**用户消息的意图，不得遗漏。原话中的约束` +
    `（不要做什么、必须用什么、具体数值与期限）**逐字引用**，不要改写。\n\n` +
    `## 已完成与产出\n修改了哪些文件、完成了什么。注明文件路径。\n\n` +
    `## 关键发现与结论\n查明了什么、确定了什么、为何如此确定。保留判断理由；` +
    `缺少理由会导致下一轮重复讨论。\n\n` +
    `## 当前状态与未解决\n正在进行什么、在何处受阻、有哪些已知失败。\n\n` +
    `## 下一步\n接手者应先做什么。涉及具体位置时**引用原文**，不要只写「那个文件」。\n\n` +
    `**不要复述工具调用过程**，只保留结论与产物；失败尝试的细节与重复的确认可以省略。\n\n` +
    /*
     * 字数要求是硬约束，不是排版偏好。
     *
     * 摘要以 `max_tokens` 结束时整份作废（不完整的摘要外观完整，比没有摘要更有害）。
     * 不告知模型预算时，模型按自身习惯输出、超出长度、被截断并作废，摘要段因此始终失败，
     * 压缩只剩收纳段，占用无法下降，下一次预算依然很小。该循环在小窗口模型上必然出现。
     */
    `**整份摘要控制在 ${Math.max(200, Math.floor(budgetTokens * CHARS_PER_TOKEN_ZH))} 字以内**，` +
    `超出长度会被截断并整份作废。超长时压缩各节措辞，不得省略章节。\n\n` +
    /*
     * 定位符必须完整保留在摘要中。
     *
     * 每条记录前的 `[message:…]` / `[action:…]` 是原文地址，摘要之后模型只能依靠它
     * 用 `read_history` 回溯原文。缺少定位符时，压缩从「把内容移到按需读取」变为
     * 「丢弃内容」；这段提示词用于防止这种情况。
     */
    `提到某条具体记录时，将其前面的 \`[message:…]\` 或 \`[action:…]\` 标记` +
    `**原样写入**（例如「按 [message:ms_x] 的要求…」）。标记是原文的地址，` +
    `缺失后无法回溯原文。不要生成不存在的标记。\n\n` +
    `执行记录：\n${segments.join('\n')}`
  )
}

/**
 * 把 manifest 投影为发给模型的消息。
 *
 * 返回替代被压缩历史的两条消息：摘要与事实清单。
 * 事实清单单独成条而不是并入摘要，因为它必须逐字稳定：并入自由文本后会被后续压缩
 * 再次改写，文件路径无法承受多次改写。
 */
export function projectManifest(
  manifest: CompactionManifest,
): { role: 'user' | 'assistant'; content: string }[] {
  return [
    {
      role: 'user',
      // 末尾一句是能力边界而不是解释：缺少它时模型不知道折叠的原文仍可取回，
      // 会将其视为已丢失，或重新执行一遍工作。
      // 不要写入 `revision`：只推进收纳线也会使其递增，而该消息紧跟 system，内容一变，
      // 整段历史的缓存前缀全部失效。
      content:
        `[此处是被压缩的早期对话摘要]\n\n${manifest.summary}\n\n` +
        `（摘要中的 [message:…] / [action:…] 是原文地址，需要原文时用 read_history 取回。）`,
    },
    { role: 'assistant', content: factsContent(manifest.facts) },
  ]
}

/** 事实清单消息的正文。预算估算与投影共用它：两处分别拼接时估算结果会不一致。 */
function factsContent(f: CompactionFacts): string {
  const lines: string[] = []
  if (f.userConstraints.length)
    lines.push(`用户约束：\n${f.userConstraints.map((s) => `- ${s}`).join('\n')}`)
  if (f.filesRead?.length) {
    lines.push(
      `读取进度（续读从未读的行开始）：\n${f.filesRead.map((p) => `- ${readProgressLine(p)}`).join('\n')}`,
    )
  }
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
