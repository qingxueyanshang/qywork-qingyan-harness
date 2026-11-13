/**
 * 任一主请求的消息条目重建。只读。
 *
 * 消息条目不逐请求保存，按账本的现状重建：取该请求发出之前已存在的单元，按其前最近一次改写 manifest 的
 * 压缩记录的两条边界判定每个单元是原文、已收纳还是已被摘要替代，逐条估算，再按请求行的对账结果
 * （store 的 `requestBreakdown`）等比对齐。条目一律是估算值。
 *
 * 与该请求实际内容的已知差异：摘要线以内被置顶的待办清单、从最新快照补回的运行上下文不列为条目，
 * 它们的占用经对齐计入同组的其他条目；收纳不逐字保留 `write_todos` 调用；附件与媒体按读取时的文件估算；
 * 媒体换出与推理剥离不重放。
 */

import { breakdownOf, condenseMessage, cutKey } from '@qywork/agent'
import type { ContentBlock, WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateMessages } from '@qywork/ai'
import type {
  ContextBreakdown,
  ConversationId,
  ProviderRequest,
  RequestItem,
  RequestItemsResponse,
  RunId,
  Step,
} from '@qywork/core'
import { alignGroupItems, CONTEXT_GROUPS } from '@qywork/core'
import {
  type CompactionRecord,
  compactionRecords,
  listRuns,
  listSteps,
  requestBreakdown,
  requestEnvelopeItems,
  type Store,
} from '@qywork/store'
import { RuntimeCompaction, type Unit } from '../compaction.ts'
import { modelSpecOf, type QyConfig } from '../config.ts'

/** 条目名称取正文开头的字符数。 */
const LABEL_CHARS = 80
/** 用户消息、新进入的内容与回复三行各取的字符数。 */
const LINE_CHARS = 200

/** 待重建的请求：store 的 `requestWithPrevious` 的结果，`request` 必须是主请求。 */
export interface RequestTarget {
  conversationId: ConversationId
  request: ProviderRequest
  previous: ProviderRequest | null
}

/** 一次请求的重建结果。`messages` 在边界未知时为 null；`envelope` 在没有信封明细时为 null。 */
interface Rebuilt {
  breakdown: ContextBreakdown
  estimated: boolean
  messages: RequestItem[] | null
  envelope: RequestItem[] | null
}

function textOf(content: string | ContentBlock[]): string {
  return typeof content === 'string'
    ? content
    : content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** 正文开头的 `chars` 个字符，空白折叠为一个空格；截断时以省略号结尾。空文本返回 null。 */
function preview(text: string, chars: number): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const head = Array.from(flat)
  return head.length > chars ? `${head.slice(0, chars).join('')}…` : flat
}

function labelOf(message: WireMessage, unit: Unit): string | null {
  if (message.role === 'tool') {
    const calls = unit.messages.flatMap((m) => m.toolCalls ?? [])
    return calls.find((call) => call.id === message.toolCallId)?.name ?? null
  }
  const text = preview(textOf(message.content), LABEL_CHARS)
  if (text === null && message.toolCalls?.length) {
    return message.toolCalls.map((call) => call.name).join('、')
  }
  return text
}

/** 单元戳 `<runId>:<定宽 seq>` 拆为轮次与序号（agent 的 `stepStamp`）。 */
function stampOf(step: string): { runId: RunId; seq: number } {
  const sep = step.lastIndexOf(':')
  return { runId: step.slice(0, sep) as RunId, seq: Number(step.slice(sep + 1)) }
}

/**
 * 重建 `target.request` 的条目，并与同一会话中上一次主请求的条目比较。
 *
 * 密度取该请求所用型号的规格，上一次请求按同一密度估算；型号已不在配置中时取缺省密度。
 * 条目随后按各自请求的对账结果对齐，密度只影响条目之间的比例。
 */
export function requestItems(
  store: Store,
  config: QyConfig,
  workspaceRoot: string,
  target: RequestTarget,
): RequestItemsResponse {
  const { conversationId, request, previous } = target
  const spec = request.providerName
    ? modelSpecOf(config, { provider: request.providerName, model: request.model })
    : undefined
  const density = spec?.density ?? DEFAULT_DENSITY

  const runs = listRuns(store, conversationId)
  const order = new Map(runs.map((r, i) => [r.id, i]))
  const runOf = (id: RunId) => runs[order.get(id) ?? -1]
  // 单元按压缩所用的同一份划分取得，边界判定与压缩一致。
  const units = new RuntimeCompaction({
    store,
    conversationId,
    workspaceRoot,
    messageIdUpperBound: runOf(request.runId)?.messageIdUpperBound ?? null,
    summarize: () => Promise.reject(new Error('消息条目重建不生成摘要')),
    preserveAssistantReasoning: spec ? spec.chatReasoningProtocol !== 'standard' : false,
  }).collectUnits(density)
  const compactions = compactionRecords(store, conversationId).filter((c) => c.manifestRevision > 0)
  const stepsByRun = new Map<RunId, Step[]>()
  const stepsOf = (runId: RunId) => {
    const cached = stepsByRun.get(runId)
    if (cached) return cached
    const steps = listSteps(store, runId)
    stepsByRun.set(runId, steps)
    return steps
  }
  /** 同一单元、同一消息、同一状态的分组估算只算一次：上一次请求的单元绝大部分与本次相同。 */
  const estimates = new Map<string, ContextBreakdown>()

  const rebuild = (x: ProviderRequest): Rebuilt => {
    const { breakdown, estimated } = requestBreakdown(x)
    const envelope = x.cacheRouteFingerprint
      ? (requestEnvelopeItems(store, x.cacheRouteFingerprint, breakdown)?.map(
          (item): RequestItem => ({
            id: item.name === null ? item.group : `${item.group}:${item.name}`,
            group: item.group,
            messageId: null,
            step: null,
            role: null,
            state: 'raw',
            label: item.name,
            tokens: item.tokens,
          }),
        ) ?? null)
      : null
    const covering: CompactionRecord | undefined = compactions.findLast(
      (c) => c.createdAt <= x.createdAt,
    )
    // 早于边界字段的记录没有 `condenseCut` 键；值为 null 表示没有收纳线。
    if (covering && !('condenseCut' in covering)) {
      return { breakdown, estimated, messages: null, envelope }
    }
    const summaryKey = covering?.summaryCut ? cutKey(covering.summaryCut) : null
    const condenseKey = covering?.condenseCut ? cutKey(covering.condenseCut) : null

    /*
     * 该请求发出之前已存在的单元：更早轮次的单元全部计入；本轮只计入该请求第一条输出步骤之前的，
     * 没有输出时计入创建时刻早于该请求发出时刻的。会话消息按本轮的消息上界截取。
     */
    const xOrder = order.get(x.runId) ?? -1
    const bound = runOf(x.runId)?.messageIdUpperBound ?? null
    const steps = stepsOf(x.runId)
    const output = steps.filter((s) => s.providerBatchId === x.id)
    const firstOutput = output.length ? Math.min(...output.map((s) => s.seq)) : null
    const sentAt = x.sentAt ?? x.createdAt
    const createdAt = new Map(steps.map((s) => [s.seq, s.createdAt]))
    const present = (unit: Unit): boolean => {
      if (unit.cut.step === undefined) return bound === null || unit.cut.messageId <= bound
      const { runId, seq } = stampOf(unit.cut.step)
      const o = order.get(runId) ?? Number.POSITIVE_INFINITY
      if (o !== xOrder) return o < xOrder
      return firstOutput !== null
        ? seq < firstOutput
        : (createdAt.get(seq) ?? Number.POSITIVE_INFINITY) < sentAt
    }

    const messages: RequestItem[] = []
    for (const unit of units) {
      if (!present(unit)) continue
      if (summaryKey !== null && unit.key <= summaryKey) continue
      const state = condenseKey !== null && unit.key <= condenseKey ? 'condensed' : 'raw'
      // 附件中的媒体只计入单元的估算值，归入单元中最后一条用户消息。
      const media = unit.tokens - estimateMessages(unit.messages, density)
      unit.messages.forEach((message, index) => {
        const key = `${unit.key}#${index}`
        let groups = estimates.get(`${key}:${state}`)
        if (!groups) {
          const sent = state === 'condensed' ? condenseMessage(message) : message
          groups = breakdownOf(
            {
              model: '',
              system: [],
              tools: [],
              messages: [sent],
              maxOutputTokens: null,
              idleTimeoutMs: 0,
            },
            density,
          )
          if (media > 0 && message.role === 'user' && index === unit.messages.length - 1) {
            const group = message._group ?? 'historyMessages'
            groups = { ...groups, [group]: groups[group] + media }
          }
          estimates.set(`${key}:${state}`, groups)
        }
        for (const group of CONTEXT_GROUPS) {
          if (groups[group] <= 0) continue
          messages.push({
            id: `${key}:${group}`,
            group,
            messageId: unit.cut.messageId,
            step: unit.cut.step ?? null,
            role: message.role,
            state,
            label: labelOf(message, unit),
            tokens: groups[group],
          })
        }
      })
    }
    alignGroupItems(messages, breakdown)
    return { breakdown, estimated, messages, envelope }
  }

  const current = rebuild(request)
  const prior = previous ? rebuild(previous) : null

  let diff: RequestItemsResponse['diff'] = null
  if (prior && current.messages && prior.messages) {
    // 只有一方有信封明细时（迁移之前的请求）不比较信封条目，否则整张工具表都显示为新增。
    const withEnvelope = (current.envelope === null) === (prior.envelope === null)
    const now = [...current.messages, ...(withEnvelope ? (current.envelope ?? []) : [])]
    const before = [...prior.messages, ...(withEnvelope ? (prior.envelope ?? []) : [])]
    const nowIds = new Set(now.map((item) => item.id))
    const beforeIds = new Set(before.map((item) => item.id))
    diff = {
      added: now.filter((item) => !beforeIds.has(item.id)),
      removed: before.filter((item) => !nowIds.has(item.id)),
    }
  }

  // 工具结果分为两个条目，名称只取一次。
  const enteredLabels = new Map<string, string>()
  for (const item of diff?.added ?? []) {
    if (item.messageId === null || item.label === null) continue
    enteredLabels.set(item.id.slice(0, item.id.lastIndexOf(':')), item.label)
  }

  const userMessageId = runOf(request.runId)?.userMessageId ?? null
  const userUnit = units.find((u) => u.cut.step === undefined && u.cut.messageId === userMessageId)
  const reply = stepsOf(request.runId)
    .filter((s) => s.providerBatchId === request.id && s.kind === 'text')
    .map((s) => s.content ?? '')
    .join('')

  return {
    requestId: request.id,
    breakdown: current.breakdown,
    estimated: current.estimated,
    boundaryKnown: current.messages !== null,
    items: [...(current.envelope ?? []), ...(current.messages ?? [])],
    diff,
    userMessage: userUnit ? preview(textOf(userUnit.messages.at(-1)!.content), LINE_CHARS) : null,
    entered: enteredLabels.size
      ? preview([...enteredLabels.values()].join('、'), LINE_CHARS)
      : null,
    reply: preview(reply, LINE_CHARS),
  }
}
