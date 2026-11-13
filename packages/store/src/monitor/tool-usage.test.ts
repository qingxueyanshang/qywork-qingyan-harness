/**
 * 覆盖 `monitor/tool-usage.ts`：`conversationToolTotals`、`batchToolDuration`、`requestToolDurations`。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId, ProviderRequestId, RunId, WorkspaceId } from '@qywork/core'
import { Store } from '../db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  listRuns,
  listSteps,
  openProviderRequest,
  settleToolStep,
  upsertWorkspace,
} from '../repos.ts'
import { batchToolDuration, conversationToolTotals, requestToolDurations } from './tool-usage.ts'

function newRun(
  store: Store,
  conversationId: ConversationId,
  workspaceId: WorkspaceId,
  key: string,
): RunId {
  return createRun(store, {
    conversationId,
    workspaceId,
    model: 'm',
    clientRequestId: key,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

function newRequest(store: Store, runId: RunId, turnIndex: number): ProviderRequestId {
  return openProviderRequest(store, {
    runId,
    turnIndex,
    retryIndex: 0,
    model: 'm',
    measuredInputTokens: 0,
    sentCategories: {} as never,
    omittedCategories: {} as never,
    payloadHash: 'h',
  }).id
}

let seq = 0

/**
 * 按运行时的写入顺序建一条工具步骤：先以 running 建行，带批次与波次；
 * `settled` 给出时按该状态与时长写入终态，`durationMs` 缺省表示被中断后没有时长。
 */
function toolStep(
  store: Store,
  runId: RunId,
  batch: ProviderRequestId,
  toolName: string,
  waveIndex: number,
  settled?: { status: 'success' | 'failure'; durationMs?: number },
): void {
  seq++
  const step = appendStep(store, {
    runId,
    seq,
    kind: 'tool_action',
    toolName,
    toolCallId: `call_${seq}`,
    providerBatchId: batch,
    callIndex: seq,
    executionWaveIndex: waveIndex,
    status: 'running',
    payload: { kind: 'tool_call', args: {} },
  })
  if (!settled) return
  settleToolStep(
    store,
    step.id,
    settled.status,
    {
      kind: 'tool_result',
      args: {},
      outcome: { status: settled.status, executed: true, message: 'ok' },
    },
    settled.durationMs,
  )
}

function textStep(store: Store, runId: RunId, batch: ProviderRequestId): void {
  seq++
  appendStep(store, { runId, seq, kind: 'text', content: '回复', providerBatchId: batch })
}

/**
 * 会话 A 两轮四次请求：r1 两个波次（首个波次三条并行），r2 两个各含一条调用的波次，
 * r3 只有一条仍在执行的调用，r4 没有工具调用。会话 B 另有一条调用，不得计入 A。
 */
function seed() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const a = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const b = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

  const run1 = newRun(store, a.id, ws.id, 'a1')
  const r1 = newRequest(store, run1, 0)
  textStep(store, run1, r1)
  toolStep(store, run1, r1, 'read_file', 0, { status: 'success', durationMs: 120 })
  toolStep(store, run1, r1, 'read_file', 0, { status: 'success', durationMs: 300 })
  toolStep(store, run1, r1, 'grep', 0, { status: 'success', durationMs: 80 })
  toolStep(store, run1, r1, 'edit_file', 1, { status: 'success', durationMs: 50 })
  const r2 = newRequest(store, run1, 1)
  toolStep(store, run1, r2, 'run_command', 0, { status: 'success', durationMs: 1000 })
  toolStep(store, run1, r2, 'run_command', 1, { status: 'failure', durationMs: 200 })
  toolStep(store, run1, r2, 'run_command', 2, { status: 'failure' })

  const run2 = newRun(store, a.id, ws.id, 'a2')
  const r3 = newRequest(store, run2, 0)
  toolStep(store, run2, r3, 'read_file', 0)
  const r4 = newRequest(store, run2, 1)
  textStep(store, run2, r4)

  const runB = newRun(store, b.id, ws.id, 'b1')
  const rb = newRequest(store, runB, 0)
  toolStep(store, runB, rb, 'read_file', 0, { status: 'success', durationMs: 999 })

  return { store, a: a.id, r1, r2, r3, r4, rb }
}

describe('conversationToolTotals', () => {
  test('各工具的调用次数与本会话的工具步骤逐一一致，累计时长只计已记录时长的调用', () => {
    const { store, a } = seed()
    try {
      const expected = new Map<string, { calls: number; durationMs: number }>()
      for (const run of listRuns(store, a)) {
        for (const s of listSteps(store, run.id)) {
          if (s.kind !== 'tool_action') continue
          const t = expected.get(s.toolName!) ?? { calls: 0, durationMs: 0 }
          t.calls++
          t.durationMs += s.durationMs ?? 0
          expected.set(s.toolName!, t)
        }
      }
      const totals = conversationToolTotals(store, a)
      expect(totals.map((t) => [t.toolName, { calls: t.calls, durationMs: t.durationMs }])).toEqual(
        [...expected].sort(([x], [y]) => (x < y ? -1 : 1)),
      )
      expect(totals).toEqual([
        { toolName: 'edit_file', calls: 1, durationMs: 50 },
        { toolName: 'grep', calls: 1, durationMs: 80 },
        { toolName: 'read_file', calls: 3, durationMs: 420 },
        { toolName: 'run_command', calls: 3, durationMs: 1200 },
      ])
    } finally {
      store.close()
    }
  })

  test('没有工具调用的会话返回空列表', () => {
    const store = new Store({ path: ':memory:' })
    try {
      const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
      const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
      expect(conversationToolTotals(store, cv.id)).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('batchToolDuration', () => {
  test('单波次并行：取最长一次调用', () => {
    expect(
      batchToolDuration([
        { waveIndex: 0, durationMs: 120 },
        { waveIndex: 0, durationMs: 300 },
        { waveIndex: 0, durationMs: 80 },
      ]),
    ).toBe(300)
  })

  test('多波次：各波次取最长一次后相加，与输入顺序无关', () => {
    const calls = [
      { waveIndex: 0, durationMs: 120 },
      { waveIndex: 0, durationMs: 300 },
      { waveIndex: 1, durationMs: 50 },
      { waveIndex: 2, durationMs: 400 },
      { waveIndex: 2, durationMs: 30 },
    ]
    expect(batchToolDuration(calls)).toBe(750)
    expect(batchToolDuration([...calls].reverse())).toBe(750)
  })

  test('没有工具调用时为 0', () => {
    expect(batchToolDuration([])).toBe(0)
  })
})

describe('requestToolDurations', () => {
  test('按请求合并其批次的工具执行时长，只含本会话已记录时长的调用', () => {
    const { store, a, r1, r2 } = seed()
    try {
      expect(requestToolDurations(store, a)).toEqual(
        new Map([
          [r1, 300 + 50],
          [r2, 1000 + 200],
        ]),
      )
    } finally {
      store.close()
    }
  })
})
