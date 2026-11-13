#!/usr/bin/env bun
/**
 * 执行工具之前的压缩检查点：现行判据与候选判据在账本上的离线对比。
 *
 * 账本（`~/.qywork/qywork.sqlite3`）以只读方式打开，不写入任何内容；结果写入 `.tmp/compaction-replay/`。
 *
 * 现行判据：占用超过「软阈值 − 一份尾部保留量 ÷ 估算折算比」时调用压缩端口，软阈值以下只执行回收量达到半份保留量的收纳。
 * 候选判据：占用超过软阈值，或上一次决策的投递触及单次上限。
 *
 * 三项指标：
 * 1. 软阈值以下的收纳中，上一批工具结果含部分投递的比例；
 * 2. 候选判据下，占用 55% 至 80% 区间内将变为部分投递的读取次数；
 * 3. 推迟后在软阈值处的收纳次数，以及其中需要调用模型写摘要的次数。
 *
 * 现行判据的数值取自账本中的压缩记录。候选判据的数值由逐会话重放得到，只重放含自动压缩记录的会话
 * （其余会话在两种判据下没有差异），近似如下：
 * - 被推迟的回收量取该次收纳前的检查点读数减去收纳后的读数（下一次请求的读数减去本批工具结果的估算）；
 * - 推迟的内容在越过软阈值时整份收纳：越线处只收纳、不摘要，需要摘要的只有现行判据下同样越线并摘要的位置；
 * - 变为部分投递的读取按单次上限投递，其后各次决策的读数不随之改变：模型续读的行为无法离线推算。
 *
 * 部分投递按结果正文判定：说明中含「上下文剩余空间」（`read_file` 的续读说明、`landHead` 的续读说明、检索结果的截断说明），
 * 或 `read_resource` 的分页结果带 `nextOffset`。
 *
 * 校验：执行工具之前的压缩记录中的占用，与按请求账推算的检查点读数逐条比较；一致说明重放与账本使用同一口径。
 *
 * 软阈值、尾部保留量与单次投递上限调用 `@qywork/agent` 的同名函数，比例取缺省值 80：对比的是比例可调之前的账本记录。
 *
 *   bun run scripts/compaction-replay.ts
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  deliveryCap,
  envelopeResult,
  openBatchBudget,
  outcomeTokens,
  softLimit,
  tailRetain,
  toolResultContent,
} from '@qywork/agent'
import { estimateMessage, lookupModel, type ProviderKind, type TokenDensity } from '@qywork/ai'
import { COMPACT_PERCENT_DEFAULT } from '@qywork/core'

const LEDGER = join(homedir(), '.qywork', 'qywork.sqlite3')
const OUT_DIR = join(import.meta.dir, '..', '.tmp', 'compaction-replay')

/** 窗口按缺省比例的触发线参数。 */
function thresholdOf(contextWindow: number) {
  return { contextWindow, compactPercent: COMPACT_PERCENT_DEFAULT }
}
const BAND = { from: 0.55, to: 0.8 }

/** 按单次投递上限截短正文的读取工具（`chargeBatchBudget`、`deliverReadable`、`read_resource` 的分页、检索的裁剪）。 */
const READ_TOOLS = new Set([
  'read_file',
  'read_resource',
  'read_history',
  'read_memory',
  'read_skill',
  'read_office',
  'read_office_guide',
  'grep',
  'glob',
])

interface RequestRow {
  id: string
  created_at: number
  model: string
  provider_kind: string | null
  purpose: string
  measured_input_tokens: number
  occupancy_tokens: number | null
  provider_input_tokens: number | null
  provider_output_tokens: number | null
  provider_cached_tokens: number | null
  provider_cache_write_tokens: number | null
  anchored: number
  configuration: string | null
}

interface StepRow {
  id: string
  seq: number
  kind: 'tool_action' | 'compaction'
  tool_name: string | null
  tool_call_id: string | null
  provider_batch_id: string | null
  call_index: number | null
  status: string
  payload: string | null
  created_at: number
}

interface CompactionPayload {
  phase?: string
  trigger?: string
  occupancy?: number
  estimatedOccupancy?: number
  contextWindow?: number
  summarized?: boolean
}

interface Outcome {
  status?: string
  executed?: boolean
  message?: string
  data?: unknown
  resources?: { resourceId?: string }[]
}

type Event =
  | { kind: 'compaction'; step: StepRow; payload: CompactionPayload; beforeTools: boolean }
  | { kind: 'batch'; request: RequestRow; steps: StepRow[] }

const db = new Database(LEDGER, { readonly: true })

function windowOf(req: RequestRow, fallback: CompactionPayload | null): number {
  try {
    const parsed = JSON.parse(req.configuration ?? '{}') as { contextWindow?: unknown }
    if (typeof parsed.contextWindow === 'number' && parsed.contextWindow > 0) {
      return parsed.contextWindow
    }
  } catch {
    // 无法解析时退回压缩记录或目录中的窗口。
  }
  if (fallback?.contextWindow) return fallback.contextWindow
  return lookupModel(req.model, kindOf(req)).contextWindow
}

function kindOf(req: RequestRow): ProviderKind {
  return (req.provider_kind ?? 'openai_chat_completions') as ProviderKind
}

function outcomeOf(step: StepRow): Outcome {
  if (!step.payload) return {}
  try {
    const parsed = JSON.parse(step.payload) as { outcome?: Outcome }
    return parsed.outcome ?? {}
  } catch {
    return {}
  }
}

function dataOf(outcome: Outcome): Record<string, unknown> | undefined {
  const d = outcome.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : undefined
}

/** 与 `runtime/transcript.ts` 的 `toolContent` 同形的工具消息，按请求侧的估算函数计量。 */
function toolMessageTokens(step: StepRow, d: TokenDensity): number {
  const outcome = outcomeOf(step)
  const data = dataOf(outcome)
  const resources = (outcome.resources ?? []).map((r) => r.resourceId).filter(Boolean)
  const result = envelopeResult(data)
  const envelope = JSON.stringify({
    call_id: step.tool_call_id ?? '',
    tool: step.tool_name ?? 'unknown',
    status: outcome.status ?? (step.status === 'success' ? 'success' : 'failure'),
    executed: outcome.executed ?? false,
    summary: outcome.message ?? '',
    ...(resources.length ? { resources } : {}),
    ...(result ? { result } : {}),
  })
  return estimateMessage({ role: 'tool', content: toolResultContent(envelope, data) }, d)
}

function isPartial(step: StepRow, outcome: Outcome): boolean {
  if (typeof outcome.message === 'string' && outcome.message.includes('上下文剩余空间')) return true
  const data = dataOf(outcome)
  return (
    step.tool_name === 'read_resource' &&
    typeof data?.nextOffset === 'number' &&
    !Array.isArray(data.hits)
  )
}

function hasMedia(outcome: Outcome): boolean {
  const data = dataOf(outcome)
  return Array.isArray(data?.images) || Array.isArray(data?.videos)
}

/** 余额为 `remaining` 时的单次投递上限，开账方式与 `loop/tool-wave.ts` 相同。 */
function capOf(remaining: number, window: number): number {
  const reserve = Math.floor(tailRetain(thresholdOf(window)) / 2)
  return deliveryCap({ state: openBatchBudget(new Map(), remaining, reserve) })
}

/** 一次决策开始时、执行工具之前的检查点读数与估算折算比。 */
function checkpointOf(
  req: RequestRow,
  recorded: CompactionPayload | null,
): { occupancy: number; scale: number; exact: boolean } {
  const out = req.provider_output_tokens ?? 0
  if (recorded?.occupancy) {
    const est = recorded.estimatedOccupancy ?? recorded.occupancy
    return {
      occupancy: recorded.occupancy,
      scale: Math.min(1, est / recorded.occupancy),
      exact: true,
    }
  }
  if (req.anchored && req.provider_input_tokens !== null) {
    const prompt =
      req.provider_input_tokens +
      (req.provider_cached_tokens ?? 0) +
      (req.provider_cache_write_tokens ?? 0)
    return {
      occupancy: prompt + out,
      scale: prompt > 0 ? Math.min(1, req.measured_input_tokens / prompt) : 1,
      exact: true,
    }
  }
  return {
    occupancy: (req.occupancy_tokens ?? req.measured_input_tokens) + out,
    scale: 1,
    exact: false,
  }
}

const metrics = {
  conversations: 0,
  decisions: 0,
  approximateCheckpoints: 0,
  check: {
    beforeToolsRecords: 0,
    anchoredRecords: 0,
    matchingWithin1Percent: 0,
    belowSoftRecords: 0,
    belowSoftOverCurrentLine: 0,
  },
  current: {
    belowSoft: 0,
    belowSoftAfterPartial: 0,
    belowSoftWithoutPriorBatch: 0,
    atSoft: 0,
    atSoftSummarized: 0,
    partialReadsInBand: 0,
  },
  candidate: {
    belowSoft: 0,
    belowSoftAfterPartial: 0,
    atSoft: 0,
    atSoftSummarized: 0,
    deferred: 0,
    deferredUnknown: 0,
    newPartialReads: 0,
    newPartialReadsInBand: 0,
  },
}

function eventsOf(runId: string): Event[] {
  const requests = new Map(
    db
      .query<RequestRow, [string]>(
        `SELECT id, created_at, model, provider_kind, purpose, measured_input_tokens, occupancy_tokens,
                provider_input_tokens, provider_output_tokens, provider_cached_tokens,
                provider_cache_write_tokens, anchored, configuration
         FROM provider_requests WHERE run_id = ?`,
      )
      .all(runId)
      .map((r) => [r.id, r]),
  )
  const steps = db
    .query<StepRow, [string]>(
      `SELECT id, seq, kind, tool_name, tool_call_id, provider_batch_id, call_index, status, payload, created_at
       FROM steps WHERE run_id = ? AND kind IN ('tool_action', 'compaction') ORDER BY seq`,
    )
    .all(runId)
  const events: Event[] = []
  for (const step of steps) {
    if (step.kind === 'compaction') {
      let payload: CompactionPayload = {}
      try {
        payload = JSON.parse(step.payload ?? '{}') as CompactionPayload
      } catch {
        // 无法解析的压缩记录按空记录处理。
      }
      events.push({ kind: 'compaction', step, payload, beforeTools: false })
      continue
    }
    const last = events.at(-1)
    if (last?.kind === 'batch' && last.request.id === step.provider_batch_id) {
      last.steps.push(step)
      continue
    }
    const request = step.provider_batch_id ? requests.get(step.provider_batch_id) : undefined
    if (!request || request.purpose !== 'turn') continue
    events.push({ kind: 'batch', request, steps: [step] })
  }
  // 执行工具之前的压缩记录紧邻其后的工具批次，且晚于该批次的请求；发送前的压缩早于下一次请求。
  for (let i = 0; i + 1 < events.length; i++) {
    const e = events[i]!
    const next = events[i + 1]!
    if (
      e.kind === 'compaction' &&
      next.kind === 'batch' &&
      next.request.created_at <= e.step.created_at
    ) {
      e.beforeTools = true
    }
  }
  return events
}

/** 下一次主请求的读数；该请求之前另有发送前的压缩时返回 null。 */
function nextOccupancy(
  runId: string,
  after: number,
  events: Event[],
  index: number,
): number | null {
  const next = events[index + 1]
  if (next?.kind === 'compaction' && !next.beforeTools) return null
  const row = db
    .query<{ occupancy_tokens: number | null }, [string, number]>(
      `SELECT occupancy_tokens FROM provider_requests
       WHERE run_id = ? AND purpose = 'turn' AND created_at > ? ORDER BY created_at LIMIT 1`,
    )
    .get(runId, after)
  return row?.occupancy_tokens ?? null
}

function replayConversation(conversationId: string): void {
  const runs = db
    .query<{ id: string }, [string]>(
      'SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at',
    )
    .all(conversationId)
  // 被推迟、尚未收纳的回收量。跨 run 保留：历史随会话延续，额度账随 run 新建。
  let extra = 0
  for (const run of runs) {
    const events = eventsOf(run.id)
    let candidateCapped = false
    let previousBatchPartial: boolean | null = null
    for (const [index, event] of events.entries()) {
      if (event.kind === 'compaction') {
        const p = event.payload
        if (event.beforeTools || p.phase !== 'done') continue
        if (p.trigger === 'automatic' && p.occupancy && p.contextWindow) {
          const soft = softLimit(thresholdOf(p.contextWindow))
          if (p.occupancy > soft) {
            metrics.current.atSoft++
            metrics.candidate.atSoft++
            if (p.summarized) {
              metrics.current.atSoftSummarized++
              metrics.candidate.atSoftSummarized++
            }
          } else {
            metrics.current.belowSoft++
            if (previousBatchPartial === null) metrics.current.belowSoftWithoutPriorBatch++
            else if (previousBatchPartial) metrics.current.belowSoftAfterPartial++
          }
        }
        extra = 0
        continue
      }

      metrics.decisions++
      const { request, steps } = event
      const prior = events[index - 1]
      const recorded =
        prior?.kind === 'compaction' && prior.beforeTools && prior.payload.trigger === 'automatic'
          ? prior.payload
          : null
      const window = windowOf(request, recorded)
      const soft = softLimit(thresholdOf(window))
      const retain = tailRetain(thresholdOf(window))
      const density = lookupModel(request.model, kindOf(request)).density
      const checkpoint = checkpointOf(request, recorded)
      if (!checkpoint.exact) metrics.approximateCheckpoints++
      const { occupancy, scale } = checkpoint

      if (recorded) {
        metrics.check.beforeToolsRecords++
        if (request.anchored && request.provider_input_tokens !== null) {
          metrics.check.anchoredRecords++
          const formula = checkpointOf(request, null).occupancy
          if (Math.abs(formula - occupancy) <= occupancy * 0.01)
            metrics.check.matchingWithin1Percent++
        }
      }

      const oldDone = recorded?.phase === 'done'
      const toolTokens = steps.reduce((n, s) => n + toolMessageTokens(s, density), 0)
      const lastCreated = Math.max(...steps.map((s) => s.created_at))
      const after = nextOccupancy(run.id, lastCreated, events, index)
      const oldPost = oldDone ? (after === null ? null : after - toolTokens) : occupancy
      const recovered = oldDone && oldPost !== null ? Math.max(0, occupancy - oldPost) : 0

      if (oldDone) {
        if (occupancy > soft) {
          metrics.current.atSoft++
          if (recorded?.summarized) metrics.current.atSoftSummarized++
        } else {
          metrics.current.belowSoft++
          metrics.check.belowSoftRecords++
          if (occupancy > soft - retain / scale) metrics.check.belowSoftOverCurrentLine++
          if (previousBatchPartial === null) metrics.current.belowSoftWithoutPriorBatch++
          else if (previousBatchPartial) metrics.current.belowSoftAfterPartial++
        }
      }

      // 候选判据。
      const simulated = occupancy + extra
      let candidatePost: number
      if (simulated > soft) {
        metrics.candidate.atSoft++
        if (oldDone && occupancy > soft && recorded?.summarized)
          metrics.candidate.atSoftSummarized++
        extra = 0
        candidatePost = oldPost ?? occupancy
      } else if (candidateCapped && extra + recovered >= retain / 2) {
        metrics.candidate.belowSoft++
        metrics.candidate.belowSoftAfterPartial++
        extra = 0
        candidatePost = oldPost ?? occupancy
      } else {
        if (oldDone) {
          if (oldPost === null) metrics.candidate.deferredUnknown++
          else metrics.candidate.deferred++
          extra += recovered
        }
        candidatePost = simulated
      }
      const currentPost = oldPost ?? occupancy

      // 投递额度：现行判据取账本中的结果，候选判据按单次上限重算。
      const inBand = (n: number) => n >= window * BAND.from && n <= window * BAND.to
      let room = Math.max(0, (soft - candidatePost) * scale)
      let capped = false
      let partialHere = false
      for (const step of [...steps].sort((a, b) => (a.call_index ?? 0) - (b.call_index ?? 0))) {
        const outcome = outcomeOf(step)
        const tokens = outcomeTokens(
          { message: outcome.message ?? '', data: dataOf(outcome) },
          density,
        )
        const cap = capOf(room, window)
        if (isPartial(step, outcome)) {
          partialHere = true
          capped = true
          if (inBand(occupancy)) metrics.current.partialReadsInBand++
          room -= Math.min(tokens, cap)
        } else if (tokens > cap && READ_TOOLS.has(step.tool_name ?? '') && !hasMedia(outcome)) {
          capped = true
          if (candidatePost > currentPost) {
            metrics.candidate.newPartialReads++
            if (inBand(simulated)) metrics.candidate.newPartialReadsInBand++
          }
          room -= cap
        } else {
          if (tokens > cap && hasMedia(outcome)) capped = true
          room -= tokens
        }
        room = Math.max(0, room)
      }
      candidateCapped = capped
      previousBatchPartial = partialHere
    }
  }
}

const conversations = db
  .query<{ conversation_id: string }, []>(
    `SELECT DISTINCT r.conversation_id FROM steps s JOIN runs r ON r.id = s.run_id
     WHERE s.kind = 'compaction' AND s.payload LIKE '%"trigger":"automatic"%'`,
  )
  .all()
for (const c of conversations) {
  metrics.conversations++
  replayConversation(c.conversation_id)
}
db.close()

const ratio = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '-')
const rows: [string, string, string][] = [
  [
    '1. 软阈值以下的收纳：上一批含部分投递 / 总数',
    `${metrics.current.belowSoftAfterPartial} / ${metrics.current.belowSoft}（${ratio(metrics.current.belowSoftAfterPartial, metrics.current.belowSoft)}）`,
    `${metrics.candidate.belowSoftAfterPartial} / ${metrics.candidate.belowSoft}（${ratio(metrics.candidate.belowSoftAfterPartial, metrics.candidate.belowSoft)}）`,
  ],
  [
    '2. 占用 55%–80% 的部分投递读取（候选列为新增）',
    String(metrics.current.partialReadsInBand),
    `${metrics.candidate.newPartialReadsInBand}（全部区间新增 ${metrics.candidate.newPartialReads}）`,
  ],
  [
    '3. 软阈值处的收纳 / 其中摘要',
    `${metrics.current.atSoft} / ${metrics.current.atSoftSummarized}`,
    `${metrics.candidate.atSoft} / ${metrics.candidate.atSoftSummarized}`,
  ],
]

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(OUT_DIR, { recursive: true })
const file = join(OUT_DIR, `${stamp}.json`)
writeFileSync(
  file,
  `${JSON.stringify({ ledger: LEDGER, at: new Date().toISOString(), metrics }, null, 2)}\n`,
)

console.log(
  `会话 ${metrics.conversations}，决策 ${metrics.decisions}（检查点读数按请求账近似 ${metrics.approximateCheckpoints}）`,
)
console.log(
  `校验：执行工具之前的压缩记录 ${metrics.check.beforeToolsRecords}，其中请求账为锚点 ${metrics.check.anchoredRecords}，` +
    `与推算读数相差不超过 1% 的 ${metrics.check.matchingWithin1Percent}；` +
    `软阈值以下 ${metrics.check.belowSoftRecords}，超过现行触发线的 ${metrics.check.belowSoftOverCurrentLine}`,
)
console.log(
  `软阈值以下的收纳中上一批没有工具结果 ${metrics.current.belowSoftWithoutPriorBatch}；` +
    `候选判据推迟 ${metrics.candidate.deferred}，回收量无法推算 ${metrics.candidate.deferredUnknown}`,
)
console.log('| 指标 | 现行判据 | 候选判据 |')
console.log('|---|---|---|')
for (const [name, current, candidate] of rows)
  console.log(`| ${name} | ${current} | ${candidate} |`)
console.log(`结果：${file}`)
