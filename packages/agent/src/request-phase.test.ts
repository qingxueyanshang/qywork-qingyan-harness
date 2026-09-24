/**
 * 覆盖范围：`loop.ts` 发出的 `run.request` / `run.retrying` 两条阶段事件的字段与顺序，
 * 以及 `provider_requests.last_content_at` 的推进判据（`markRequestContent` 那条路）。
 * 故障端点来自 `@qywork/ai` 的 `providers/fault-server.test-helper.ts`。
 *
 * 走真实 `@qywork/store`：断言问的是「事件里那个 requestId 与账本那一行对不对得上」，
 * 用替身答不了。step 相关的钩子按空实现，它们不在本文件的范围内。
 */

import { expect, test } from 'bun:test'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import { type FaultServer, startFaultServer } from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent, ProviderRequest, RunId } from '@qywork/core'
import {
  createConversation,
  createRun,
  listProviderRequests,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestSent,
  openProviderRequest,
  recordProviderRequestDiagnostic,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from './index.ts'
import { ToolRegistry } from './registry.ts'

interface Ledger {
  runId: RunId
  persist: LoopPersistence
  /** 每次 `markRequestContent` 收到的观察时刻，按到达顺序。 */
  contentMarks: number[]
  rows(): ProviderRequest[]
  close(): void
}

function ledger(): Ledger {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/phase-ws', 'phase-ws')
  const cv = createConversation(store, { workspaceId: ws.id, provider: 'fault', model: 'm' })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'phase-ledger',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const contentMarks: number[] = []
  let seq = 0
  const persist: LoopPersistence = {
    nextSeq: () => ++seq,
    landUserStep: () => 'st_user',
    openTextStep: () => 'st_text',
    openThinkingStep: () => 'st_thinking',
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => 'st_tool',
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: (input) => openProviderRequest(store, input).id,
    markRequestSent: (id) => markProviderRequestSent(store, id as never),
    markRequestHeaders: (id, at) => markProviderRequestHeaders(store, id as never, at),
    markRequestFirstEvent: (id) => markProviderRequestFirstEvent(store, id as never),
    markRequestContent: (id, at, kind, visible) => {
      contentMarks.push(at)
      markProviderRequestContent(store, id as never, at, kind, visible)
    },
    recordRequestDiagnostic: (id, diagnostic) =>
      recordProviderRequestDiagnostic(store, id as never, diagnostic),
    settleRequest: (id, status, usage, errorCode, finishReason, errorMessage) =>
      settleProviderRequest(
        store,
        id as never,
        status,
        usage,
        errorCode,
        finishReason,
        errorMessage,
      ),
  }
  return {
    runId: run.id,
    persist,
    contentMarks,
    rows: () => listProviderRequests(store, run.id),
    close: () => store.close(),
  }
}

function baseCtx(runId: string): ToolContextBase {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId,
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allowed: true }),
  }
}

async function runAgainst(led: Ledger, baseUrl: string): Promise<AgentEvent[]> {
  const loop = new AgentLoop({
    adapter: buildAdapter({
      kind: 'openai_responses',
      baseUrl,
      model: 'deepseek-flash',
      apiKey: 'sk-fault',
    }),
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: led.persist,
    streamIdleTimeoutMs: 2_000,
    // 退避按夹具给的 Retry-After 记进事件，但不真等：本文件问的是字段，不是时长。
    sleep: async () => {},
  })
  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: led.runId,
    history: [],
    signal: new AbortController().signal,
  })) {
    events.push(ev)
  }
  return events
}

test('退避重发的阶段事件：退避 → 发出 → 响应头 → 内容，次数与请求行一一对应', async () => {
  const fault: FaultServer = startFaultServer('retry_after_then_ok')
  fault.retryAfterSeconds = 60
  const led = ledger()
  try {
    const events = await runAgainst(led, fault.openaiBaseUrl)
    const phases = events
      .filter(
        (e) => e.type === 'run.request' || e.type === 'run.retrying' || e.type === 'text.delta',
      )
      .map((e) =>
        e.type === 'run.request'
          ? `${e.phase}:${e.attempt}/${e.max}`
          : e.type === 'run.retrying'
            ? `backoff:${e.attempt}/${e.max}`
            : 'content',
      )
    /*
     * 被回绝那一次没有 `headers` 阶段：非 2xx 由适配器直接抛错，走不到
     * `response_started`。界面因此在退避之前停在「正在请求…」。
     */
    expect(phases).toEqual(['sent:0/5', 'backoff:1/5', 'sent:1/5', 'headers:1/5', 'content'])

    const rows = led.rows()
    const sent = events.filter((e) => e.type === 'run.request' && e.phase === 'sent')
    expect(sent.map((e) => (e.type === 'run.request' ? e.requestId : ''))).toEqual(
      rows.map((r) => r.id),
    )

    const retrying = events.find((e) => e.type === 'run.retrying')
    expect(retrying?.type).toBe('run.retrying')
    if (retrying?.type !== 'run.retrying') throw new Error('缺少 run.retrying')
    // 上游给了 Retry-After 60，事件与诊断里记的就是这个数，不是本地退避基准。
    expect(retrying.backoffMs).toBe(60_000)
    expect(retrying.requestId).toBe(rows[0]!.id)
    expect(retrying.at).toBeGreaterThanOrEqual(rows[0]!.sentAt!)
    expect(rows[0]!.diagnostic?.retry).toMatchObject({
      decision: 'resend',
      attempt: 1,
      backoffMs: 60_000,
      at: retrying.at,
    })

    // 界面拿到的内容时刻与账本那一列是同一个值，刷新前后因此算得出同一个间隔。
    const delta = events.find((e) => e.type === 'text.delta')
    if (delta?.type !== 'text.delta') throw new Error('缺少 text.delta')
    expect(delta.at).toBe(rows[1]!.lastContentAt!)
    expect(rows[1]!.lastContentKind).toBe('text')
    expect(rows[1]!.lastVisibleAt).toBe(delta.at)
    // 被回绝的那一行一个字都没收到，内容时刻两列都空。
    expect(rows[0]!.firstContentAt).toBeNull()
    expect(rows[0]!.lastContentAt).toBeNull()
  } finally {
    led.close()
    fault.stop()
  }
}, 30_000)

test('未完成工具参数只推进内容时刻，不冒充可见正文', async () => {
  const fault: FaultServer = startFaultServer('truncated_tool_call')
  const led = ledger()
  try {
    const events = await runAgainst(led, fault.openaiBaseUrl)
    expect(events.some((e) => e.type === 'tool.generating')).toBe(true)
    const row = led.rows()[0]!
    expect(row.lastContentKind).toBe('tool_arguments')
    expect(row.lastContentAt).not.toBeNull()
    expect(row.lastVisibleAt).toBeNull()
  } finally {
    led.close()
    fault.stop()
  }
}, 30_000)

test('保活行不推进内容时刻，首值留在 first_content_at、末值落在 last_content_at', async () => {
  const fault: FaultServer = startFaultServer('keepalive_then_ok')
  const led = ledger()
  try {
    await runAgainst(led, fault.openaiBaseUrl)
    const row = led.rows()[0]!
    expect(row.status).toBe('received')
    expect(led.contentMarks.length).toBeGreaterThan(0)
    expect(row.firstContentAt).toBe(led.contentMarks[0]!)
    expect(row.lastContentAt).toBe(led.contentMarks.at(-1)!)
    /*
     * 夹具先发 5 行 `: ping`（每行间隔 80 ms）再发正文。保活行要是算内容，
     * 首内容时刻会落在响应头后的头几十毫秒里，这条断言随即变红。
     */
    expect(row.firstContentAt! - row.headersAt!).toBeGreaterThanOrEqual(300)
  } finally {
    led.close()
    fault.stop()
  }
}, 30_000)
