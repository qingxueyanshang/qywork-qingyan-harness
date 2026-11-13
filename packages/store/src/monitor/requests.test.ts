/**
 * 覆盖 `monitor/requests.ts`：`conversationRequests`、`conversationRequestDetails`、`requestBreakdown`、
 * `compactionRecords`，以及 `repos.ts` 中供其使用的 `rowToProviderRequest`。
 */

import { describe, expect, test } from 'bun:test'
import type {
  ContextBreakdown,
  ConversationId,
  ProviderRequestId,
  RunId,
  RunUsage,
  StepPayload,
} from '@qywork/core'
import { attributeCacheMisses, emptyBreakdown, reconcileBreakdown } from '@qywork/core'
import { Store } from '../db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  listProviderRequests,
  listRuns,
  openProviderRequest,
  recordCompactionStep,
  settleProviderRequest,
  settleToolStep,
  updateRunUsage,
  upsertWorkspace,
} from '../repos.ts'
import { compactionRecords, conversationRequestDetails, conversationRequests } from './requests.ts'
import { requestToolDurations } from './tool-usage.ts'

const T0 = 1_760_000_000_000

function breakdown(history: number): ContextBreakdown {
  return { ...emptyBreakdown(), systemPrompt: 300, systemTools: 500, historyMessages: history }
}

let seq = 0

function newRun(store: Store, conversationId: ConversationId, workspaceId: string, key: string) {
  return createRun(store, {
    conversationId,
    workspaceId: workspaceId as never,
    model: 'm',
    clientRequestId: key,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

/** 建一条请求行，创建、发出与完成时刻按 `at` 写入，使归因与截取的判据可确定。 */
function request(
  store: Store,
  runId: RunId,
  turnIndex: number,
  at: number,
  opts: {
    retryIndex?: number
    purpose?: 'turn' | 'summary'
    status?: 'received' | 'uncertain' | 'in_flight'
    usage?: {
      inputTokens: number
      outputTokens: number
      cachedTokens: number | null
      cacheWriteTokens: number | null
      cacheWrite1hTokens?: number
    }
    occupancy?: number
    compactAt?: number
  } = {},
): ProviderRequestId {
  const id = openProviderRequest(store, {
    runId,
    turnIndex,
    retryIndex: opts.retryIndex ?? 0,
    purpose: opts.purpose ?? 'turn',
    providerName: 'p',
    providerKind: 'anthropic_messages',
    model: 'm',
    measuredInputTokens: 1_000 + turnIndex,
    ...(opts.occupancy !== undefined ? { occupancyTokens: opts.occupancy } : {}),
    ...(opts.compactAt !== undefined
      ? {
          configuration: {
            contextWindow: 200_000,
            modelMaxOutputTokens: null,
            maxOutputTokens: null,
            effort: null,
            idleTimeoutMs: 1,
            toolCount: 0,
            messageCount: 0,
            compactAt: opts.compactAt,
          },
        }
      : {}),
    sentCategories: breakdown(400 + turnIndex),
    omittedCategories: { historyOriginal: turnIndex, intermediateOriginal: 0 },
    payloadHash: `h${turnIndex}`,
    cacheRouteFingerprint: 'fp',
  }).id
  if (opts.status !== 'in_flight') {
    settleProviderRequest(store, id, opts.status ?? 'received', opts.usage ?? null)
  }
  store.db
    .query(
      'UPDATE provider_requests SET created_at = ?, sent_at = ?, completed_at = ? WHERE id = ?',
    )
    .run(at, at + 10, opts.status === 'in_flight' ? null : at + 500, id)
  return id
}

function compaction(
  store: Store,
  runId: RunId,
  at: number,
  payload: Omit<Extract<StepPayload, { kind: 'compaction' }>, 'kind'>,
): void {
  seq++
  recordCompactionStep(store, runId, seq, { kind: 'compaction', ...payload })
  store.db
    .query("UPDATE steps SET created_at = ? WHERE run_id = ? AND seq = ? AND kind = 'compaction'")
    .run(at, runId, seq)
}

function toolStep(store: Store, runId: RunId, batch: ProviderRequestId, durationMs: number): void {
  seq++
  const step = appendStep(store, {
    runId,
    seq,
    kind: 'tool_action',
    toolName: 'read_file',
    toolCallId: `call_${seq}`,
    providerBatchId: batch,
    callIndex: 0,
    executionWaveIndex: 0,
    status: 'running',
    payload: { kind: 'tool_call', args: {} },
  })
  settleToolStep(
    store,
    step.id,
    'success',
    {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: 'ok' },
    },
    durationMs,
  )
}

function turn(
  turnIndex: number,
  input: number,
  output: number,
  costUsd: number,
): RunUsage['turns'][number] {
  return {
    turnIndex,
    input,
    output,
    cached: null,
    cacheWrite: null,
    reasoning: 0,
    source: 'provider',
    usageStatus: 'ok',
    costUsd,
    at: T0,
  }
}

/**
 * 会话 A 两轮：第一轮一次主请求、一次摘要请求、一次压缩、一次失败后重发成功的主请求与一条未改写
 * manifest 的压缩记录；第二轮一次用量账中没有对应记录的主请求、一条旧压缩记录与一次在途的主请求。
 * 会话 B 另有一次主请求，不得计入 A。
 */
function seed() {
  seq = 0
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const a = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const b = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

  const run1 = newRun(store, a.id, ws.id, 'a1')
  const r1 = request(store, run1, 0, T0, {
    usage: { inputTokens: 1_000, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 1_000 },
    occupancy: 1_500,
    compactAt: 160_000,
  })
  toolStep(store, run1, r1, 120)
  toolStep(store, run1, r1, 300)
  request(store, run1, 1, T0 + 1_000, {
    purpose: 'summary',
    usage: { inputTokens: 9_000, outputTokens: 700, cachedTokens: 0, cacheWriteTokens: 0 },
  })
  compaction(store, run1, T0 + 2_000, {
    phase: 'done',
    manifestRevision: 3,
    compactedMessages: 4,
    summarized: true,
    trigger: 'automatic',
    occupancy: 2_050,
    occupancyAfter: 1_200,
    summaryCut: null,
    condenseCut: null,
  })
  const r2 = request(store, run1, 2, T0 + 3_000, { status: 'uncertain', occupancy: 2_100 })
  const r3 = request(store, run1, 2, T0 + 4_000, {
    retryIndex: 1,
    usage: {
      inputTokens: 200,
      outputTokens: 30,
      cachedTokens: 900,
      cacheWriteTokens: 100,
      cacheWrite1hTokens: 100,
    },
    occupancy: 2_100,
    compactAt: 160_000,
  })
  compaction(store, run1, T0 + 5_000, {
    phase: 'skipped',
    manifestRevision: 0,
    compactedMessages: 0,
  })
  updateRunUsage(store, run1, {
    inputTokens: 10_200,
    outputTokens: 780,
    cachedTokens: 900,
    cacheWriteTokens: 1_100,
    reasoningTokens: 0,
    cost: 0.0185,
    currency: 'CNY',
    turns: [turn(0, 1_000, 50, 0.012), turn(1, 9_000, 700, 0.006), turn(2, 200, 30, 0.0005)],
  })

  const run2 = newRun(store, a.id, ws.id, 'a2')
  const r4 = request(store, run2, 0, T0 + 6_000, {
    usage: { inputTokens: 300, outputTokens: 20, cachedTokens: 1_900, cacheWriteTokens: 0 },
    occupancy: 2_300,
  })
  compaction(store, run2, T0 + 7_000, {
    phase: 'done',
    manifestRevision: 4,
    compactedMessages: 6,
  })
  const r5 = request(store, run2, 1, T0 + 8_000, { status: 'in_flight' })
  toolStep(store, run2, r4, 40)

  const runB = newRun(store, b.id, ws.id, 'b1')
  const rb = request(store, runB, 0, T0 + 9_000, {
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0 },
  })
  return { store, a: a.id, run1, run2, r1, r2, r3, r4, r5, rb }
}

describe('conversationRequests', () => {
  test('行数等于各轮主请求行数之和，按创建顺序排列，不含摘要请求与其他会话', () => {
    const { store, a, r1, r2, r3, r4, r5 } = seed()
    try {
      const page = conversationRequests(store, a, null)!
      const perRun = listRuns(store, a).flatMap((run) =>
        listProviderRequests(store, run.id).filter((r) => r.purpose === 'turn'),
      )
      expect(page.requests).toHaveLength(perRun.length)
      expect(page.requests.map((r) => r.id)).toEqual([r1, r2, r3, r4, r5])
    } finally {
      store.close()
    }
  })

  test('对账之前的分组原值与按轮接口一致：有用量按输入总量对账，没有用量按运行中读数并标为估算', () => {
    const { store, a } = seed()
    try {
      const page = conversationRequests(store, a, null)!
      const perRun = new Map(
        listRuns(store, a)
          .flatMap((run) => listProviderRequests(store, run.id))
          .map((r) => [r.id, r]),
      )
      for (const row of page.requests) {
        const raw = perRun.get(row.id)!
        const total =
          raw.providerInputTokens === null
            ? (raw.occupancyTokens ?? raw.measuredInputTokens)
            : raw.providerInputTokens +
              (raw.providerCachedTokens ?? 0) +
              (raw.providerCacheWriteTokens ?? 0)
        expect(row.breakdown).toEqual(reconcileBreakdown(raw.sentCategories, total))
        expect(row.estimated).toBe(raw.providerInputTokens === null)
        expect(Object.values(row.breakdown).reduce((n, v) => n + v, 0)).toBe(total)
      }
      // 第三行：输入 200 + 命中 900 + 写入 100；第五行在途，取本地测得值。
      expect(
        page.requests.map((r) => [
          r.estimated,
          Object.values(r.breakdown).reduce((n, v) => n + v, 0),
        ]),
      ).toEqual([
        [false, 2_000],
        [true, 2_100],
        [false, 1_200],
        [false, 2_200],
        [true, 1_001],
      ])
    } finally {
      store.close()
    }
  })

  test('明细与序列逐条对应：用量、省略量、各阶段时刻、金额与工具耗时', () => {
    const { store, a, r1, r4 } = seed()
    try {
      const sequence = conversationRequests(store, a, null)!.requests
      const rows = conversationRequestDetails(store, a, null)!.details
      expect(rows.map((r) => r.id)).toEqual(sequence.map((r) => r.id))
      expect(sequence.map((r) => r.compactAt)).toEqual([160_000, null, 160_000, null, null])
      const perRun = new Map(
        listRuns(store, a)
          .flatMap((run) => listProviderRequests(store, run.id))
          .map((r) => [r.id, r]),
      )
      expect(rows.map((r) => r.omitted)).toEqual(
        rows.map((r) => perRun.get(r.id)!.omittedCategories),
      )
      expect(rows.map((r) => r.usage)).toEqual([
        { input: 1_000, output: 50, cached: 0, cacheWrite: 1_000, cacheWrite1h: null },
        null,
        { input: 200, output: 30, cached: 900, cacheWrite: 100, cacheWrite1h: 100 },
        { input: 300, output: 20, cached: 1_900, cacheWrite: 0, cacheWrite1h: null },
        null,
      ])
      // 金额只在带用量的 received 行上：失败的尝试与在途行为 null；第二轮的用量账中没有记录，也为 null。
      expect(rows.map((r) => r.cost)).toEqual([
        { amount: 0.012, currency: 'CNY' },
        null,
        { amount: 0.0005, currency: 'CNY' },
        null,
        null,
      ])
      const durations = requestToolDurations(store, a)
      expect(rows.map((r) => r.toolMs)).toEqual(rows.map((r) => durations.get(r.id) ?? null))
      // 第一行的两次调用在同一波次，取较长的一次。
      expect(rows.map((r) => r.toolMs)).toEqual([300, null, null, 40, null])
      expect(rows.find((r) => r.id === r1)?.sentAt).toBe(T0 + 10)
      expect(rows.find((r) => r.id === r4)?.completedAt).toBe(T0 + 6_500)
    } finally {
      store.close()
    }
  })

  test('归因按整段请求与全部压缩记录计算；压缩记录只列出改写了 manifest 的', () => {
    const { store, a } = seed()
    try {
      const page = conversationRequests(store, a, null)!
      const raw = listRuns(store, a)
        .flatMap((run) => listProviderRequests(store, run.id))
        .filter((r) => r.purpose === 'turn')
        .sort((x, y) => (x.id < y.id ? -1 : 1))
      expect(page.requests.map((r) => r.cacheMiss)).toEqual(
        attributeCacheMisses(raw, compactionRecords(store, a)),
      )
      // 第三行在压缩之后：新增内容 = 1200 − 2000 + 回收量 850 = 50，未命中 300 的其余部分计为压缩。
      expect(page.requests[2]!.cacheMiss).toEqual({
        newContent: 50,
        compaction: 250,
        modelSwitch: 0,
        toolChange: 0,
        cacheExpiry: 0,
        other: 0,
      })
      expect(page.requests[1]!.cacheMiss).toBeNull()
      expect(page.compactions).toEqual([
        {
          createdAt: T0 + 2_000,
          trigger: 'automatic',
          summarized: true,
          occupancy: 2_050,
          occupancyAfter: 1_200,
        },
        {
          createdAt: T0 + 7_000,
          trigger: null,
          summarized: false,
          occupancy: null,
          occupancyAfter: null,
        },
      ])
      expect(page.tools).toEqual([{ toolName: 'read_file', calls: 3, durationMs: 460 }])
    } finally {
      store.close()
    }
  })

  test('after 返回的行与整段读取的对应部分相同，压缩记录取该请求之后创建的', () => {
    const { store, a } = seed()
    try {
      const full = conversationRequests(store, a, null)!
      const details = conversationRequestDetails(store, a, null)!
      for (const [k, row] of full.requests.entries()) {
        expect(conversationRequests(store, a, row.id)).toEqual({
          requests: full.requests.slice(k + 1),
          compactions: full.compactions.filter((c) => c.createdAt > row.createdAt),
          tools: full.tools,
        })
        expect(conversationRequestDetails(store, a, row.id)).toEqual({
          details: details.details.slice(k + 1),
        })
      }
      expect(conversationRequests(store, a, full.requests[0]!.id)!.compactions).toHaveLength(2)
      expect(conversationRequests(store, a, full.requests.at(-1)!.id)!.requests).toEqual([])
    } finally {
      store.close()
    }
  })

  test('after 不是本会话的主请求时返回 null', () => {
    const { store, a, run1, rb } = seed()
    try {
      const summary = listProviderRequests(store, run1).find((r) => r.purpose === 'summary')!
      expect(conversationRequests(store, a, summary.id)).toBeNull()
      expect(conversationRequests(store, a, rb)).toBeNull()
      expect(conversationRequests(store, a, 'pr_missing' as ProviderRequestId)).toBeNull()
      expect(conversationRequestDetails(store, a, rb)).toBeNull()
    } finally {
      store.close()
    }
  })

  test('没有请求的会话返回空序列', () => {
    const store = new Store({ path: ':memory:' })
    try {
      const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
      const c = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
      expect(conversationRequests(store, c.id, null)).toEqual({
        requests: [],
        compactions: [],
        tools: [],
      })
      expect(conversationRequestDetails(store, c.id, null)).toEqual({ details: [] })
    } finally {
      store.close()
    }
  })
})
