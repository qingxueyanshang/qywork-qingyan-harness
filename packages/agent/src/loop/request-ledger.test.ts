/**
 * 覆盖范围：`loop/attempt.ts` 的逐请求账在真实 HTTP 故障下写入的记录
 * （`openRequest` / `markRequestSent` / `markRequestHeaders` / `markRequestHedge` / `settleRequest`），
 * 与 `@qywork/ai` 的 `providers/fault-server.test-helper.ts` 三协议故障端点。
 *
 * 另覆盖响应头中的云端请求号（`@qywork/ai` 的 `CLOUD_REQUEST_ID_HEADER`）经三种协议的适配器写入账本行；
 * 用量中缓存写入的 1 小时档经 `loop/request.ts` 的 `mergeUsage` 计价、经 `settleRequest` 写入账本行。
 *
 * 请求账使用真实的 `@qywork/store`：断言检查的是数据库中记录行的内容，
 * 用替身记录调用序列无法验证。step 相关的钩子为空实现，不在本文件的范围内。
 *
 * 对照数据是故障端点的 `receipts`，即服务端收到的请求次数。
 */

import { expect, test } from 'bun:test'
import {
  buildAdapter,
  CLOUD_REQUEST_ID_HEADER,
  DEFAULT_DENSITY,
  type LlmAdapter,
  lookupModel,
  ProviderError,
  type ProviderEvent,
} from '@qywork/ai'
import {
  closedPortBaseUrl,
  type FaultServer,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent, ProviderRequest, RunId } from '@qywork/core'
import { RESEND_LIMIT } from '@qywork/core'
import {
  createConversation,
  createRun,
  listProviderRequests,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestHedge,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { fakeAdapter } from './fixtures.test-helper.ts'

interface Ledger {
  runId: RunId
  persist: LoopPersistence
  rows(): ProviderRequest[]
  close(): void
}

function ledger(): Ledger {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/fault-ws', 'fault-ws')
  const cv = createConversation(store, { workspaceId: ws.id, provider: 'fault', model: 'm' })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'fault-ledger',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  let seq = 0
  const persist: LoopPersistence = {
    nextSeq: () => ++seq,
    markImagesUndelivered: () => [],
    recordRequestDiagnostic: () => {},
    landUserStep: () => 'st_user',
    openTextStep: () => 'st_text',
    openThinkingStep: () => 'st_thinking',
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => 'st_tool',
    markExecuting: () => {},
    settleTool: (_stepId, _status, outcome) => outcome,
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: (input) => openProviderRequest(store, input).id,
    markRequestSent: (id) => markProviderRequestSent(store, id as never),
    markRequestHeaders: (id, at, cloudRequestId) =>
      markProviderRequestHeaders(store, id as never, at, cloudRequestId),
    markRequestHedge: (id, hedge) => markProviderRequestHedge(store, id as never, hedge),
    markRequestFirstEvent: (id) => markProviderRequestFirstEvent(store, id as never),
    markRequestContent: (id, at) => markProviderRequestContent(store, id as never, at),
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

async function runAgainst(
  ledgerUnderTest: Ledger,
  profile: {
    kind: 'openai_responses' | 'openai_chat_completions' | 'anthropic_messages'
    baseUrl: string
    model: string
  },
  /**
   * 退避等待。默认实现立即返回：耗尽五次重发的两个用例按真实退避需等待约一分钟，
   * 而它们断言的是账本的行数与列值，不是等待时长。
   */
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async () => {},
): Promise<AgentEvent[]> {
  const loop = new AgentLoop({
    adapter: buildAdapter({ ...profile, apiKey: 'sk-fault' }),
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: ledgerUnderTest.persist,
    streamIdleTimeoutMs: 2_000,
    sleep,
  })
  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: ledgerUnderTest.runId,
    history: [],
    signal: new AbortController().signal,
  })) {
    events.push(ev)
  }
  return events
}

function sentRows(rows: ProviderRequest[]): ProviderRequest[] {
  return rows.filter((r) => r.sentAt !== null)
}

test('503 退避重发：接收次数与已发送行数相等，退避期间没有新接收', async () => {
  const fault: FaultServer = startFaultServer('retry_after_then_ok')
  const led = ledger()
  try {
    await runAgainst(
      led,
      {
        kind: 'openai_responses',
        baseUrl: fault.openaiBaseUrl,
        model: 'deepseek-flash',
      },
      // 本用例验证退避期间没有新接收，因此按真实计时等待；时长不超过 1 秒，退避间隔本身不短于 2 秒。
      (ms) => Bun.sleep(Math.min(ms, 1_000)),
    )
    const rows = led.rows()
    expect(fault.receipts.length).toBe(2)
    expect(sentRows(rows).length).toBe(fault.receipts.length)

    const [rejected, received] = rows
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.errorCode).toBe('provider_unavailable')
    expect(rejected?.providerInputTokens).toBeNull()
    expect(rejected?.providerOutputTokens).toBeNull()

    expect(received?.status).toBe('received')
    expect(received?.providerInputTokens).toBe(11)
    expect(received?.providerOutputTokens).toBe(3)

    // 只断言两次接收之间存在等待，不断言等待时长：退避时长不在本文件的范围内。
    expect(fault.receipts[1]! - fault.receipts[0]!).toBeGreaterThanOrEqual(500)

    // 响应头时刻位于发出时刻与首个事件时刻之间，度量的是首包等待。
    expect(received?.headersAt).not.toBeNull()
    expect(received!.headersAt!).toBeGreaterThanOrEqual(received!.sentAt!)
    expect(received!.firstEventAt!).toBeGreaterThanOrEqual(received!.headersAt!)

    /*
     * 被拒绝的请求行同样必须有响应头时刻。
     *
     * 非 2xx 响应不会产生 `response_started`（适配器在该路径上直接抛错），时刻只能经传输读数
     * 写入账本。缺少该时刻时，连接失败与远端拒绝在账本上都是一行没有响应头的记录。
     */
    expect(rejected?.headersAt).not.toBeNull()
    expect(rejected!.headersAt!).toBeGreaterThanOrEqual(rejected!.sentAt!)
    expect(rejected?.firstEventAt).toBeNull()
  } finally {
    led.close()
    fault.stop()
  }
}, 30_000)

test('连接被拒：每一行都不是 received，用量全为 null', async () => {
  const led = ledger()
  try {
    await runAgainst(led, {
      kind: 'openai_responses',
      baseUrl: `${closedPortBaseUrl()}/v1`,
      model: 'deepseek-flash',
    })
    const rows = led.rows()
    expect(rows.length).toBe(RESEND_LIMIT + 1)
    for (const row of rows) {
      expect(row.status).not.toBe('received')
      // 连接未建立，响应头时刻为空：与远端拒绝是两种不同的失败。
      expect(row.headersAt).toBeNull()
      expect(row.providerInputTokens).toBeNull()
      expect(row.providerOutputTokens).toBeNull()
      expect(row.providerCachedTokens).toBeNull()
      expect(row.providerCacheWriteTokens).toBeNull()
    }
  } finally {
    led.close()
  }
}, 30_000)

test('用量已回报后流中断：终态非 received，已收到的用量保留在账本中', async () => {
  const fault: FaultServer = startFaultServer('eof_before_terminal')
  const led = ledger()
  try {
    await runAgainst(led, {
      kind: 'openai_chat_completions',
      baseUrl: fault.openaiBaseUrl,
      model: 'deepseek-chat',
    })
    const rows = led.rows()
    expect(sentRows(rows).length).toBe(fault.receipts.length)
    for (const row of rows) {
      expect(row.status).not.toBe('received')
      expect(row.providerInputTokens).toBe(11)
      expect(row.providerOutputTokens).toBe(3)
    }
  } finally {
    led.close()
    fault.stop()
  }
}, 30_000)

/**
 * 补发记录进入请求账：两份都没有返回响应头时经诊断中的传输读数写入，补发的一份被采用时经 `response_started` 写入。
 * 补发本身由 `@qywork/ai` 的 `transport-hedge.test.ts` 覆盖；此处的适配器直接产出带补发记录的事件。
 */
test('补发记录写入请求账：两份都未返回时随失败写入，补发的一份被采用时随响应头写入', async () => {
  const led = ledger()
  const inner = fakeAdapter([null], 'deepseek-flash')
  let calls = 0
  const adapter: LlmAdapter = {
    ...inner,
    async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
      calls++
      yield { type: 'request_prepared', measuredInputTokens: 1 }
      if (calls === 1) {
        const err = new ProviderError({
          code: 'network_error',
          message: '连接超时',
          provider: 'openai_responses',
          timedOut: true,
        })
        err.transport = {
          status: null,
          headersAfterMs: null,
          headersAt: null,
          bytes: 0,
          sinceLastByteMs: null,
          keepAliveLines: 0,
          hedge: { sentAt: 1_700_000_180_000, won: false },
        }
        throw err
      }
      yield {
        type: 'response_started',
        headersAt: Date.now(),
        hedge: { sentAt: 1_700_000_360_000, won: true },
      }
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'completed' }
    },
  }
  try {
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      makeToolContext: baseCtx,
      persist: led.persist,
      sleep: async () => {},
    })
    for await (const _ of loop.run({
      runId: led.runId,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只需执行完毕
    }
    const [failed, received] = led.rows()
    expect(failed?.status).toBe('uncertain')
    expect(failed?.hedge).toEqual({ sentAt: 1_700_000_180_000, won: false })
    expect(received?.status).toBe('received')
    expect(received?.hedge).toEqual({ sentAt: 1_700_000_360_000, won: true })
  } finally {
    led.close()
  }
})

/**
 * 缓存写入的 1 小时档随用量写入账本行，并经 `mergeUsage` 按分档计价。上游回报分档的解析由 `@qywork/ai` 的
 * `anthropic.test.ts` 覆盖；此处的适配器直接产出带分档值的用量。
 */
test('缓存写入的 1 小时档写入账本行并参与计价；未回报分档时该列为 null、金额按 5 分钟档', async () => {
  for (const hour of [300, undefined]) {
    const led = ledger()
    let cost = Number.NaN
    const adapter: LlmAdapter = {
      ...fakeAdapter([null]),
      spec: lookupModel('claude-opus-5-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 1 }
        yield { type: 'response_started', headersAt: Date.now() }
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield {
          type: 'usage',
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cachedTokens: 500,
            cacheWriteTokens: 400,
            ...(hour === undefined ? {} : { cacheWrite1hTokens: hour }),
            reasoningTokens: 0,
            source: 'provider',
          },
        }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'end_turn' }
      },
    }
    try {
      const loop = new AgentLoop({
        adapter,
        registry: new ToolRegistry(),
        systemPrompt: 'sys',
        makeToolContext: baseCtx,
        persist: {
          ...led.persist,
          saveUsage: (_runId, usage) => {
            cost = usage.cost
          },
        },
        sleep: async () => {},
      })
      for await (const _ of loop.run({
        runId: led.runId,
        history: [],
        signal: new AbortController().signal,
      })) {
        // 只需执行完毕
      }
      const [row] = led.rows()
      expect(row?.providerCacheWriteTokens).toBe(400)
      expect(row?.providerCacheWrite1hTokens).toBe(hour ?? null)
      // 100 × 4 + 10 × 20 + 500 × 0.2 + 写入部分：全部按 5 分钟档为 400 × 5，含 1 小时档为 100 × 5 + 300 × 8。
      expect(cost).toBe(hour === undefined ? 0.0027 : 0.0036)
    } finally {
      led.close()
    }
  }
})

/**
 * 原始失败形状：经云端网关的对话请求，本机账本与云端请求记录没有共同的请求号，只能按设备、型号与时刻近似对照。
 * 网关在响应头中返回请求号；本机写入该次请求的账本行：成功经 `response_started`，被拒绝经诊断中的传输读数，三种协议相同。
 * 本用例在故障端点之前放一个只添加该响应头的转发服务，代替网关；直连故障端点（没有该响应头）时为 null。
 */
test.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
  '%s：响应头中的云端请求号写入账本行，成功与被拒绝相同；没有该响应头时为 null',
  async (kind) => {
    const fault = startFaultServer('complete')
    let issued = 0
    const gateway = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const upstream = await fetch(`${new URL(fault.openaiBaseUrl).origin}${url.pathname}`, {
          method: req.method,
          headers: req.headers,
          body: await req.arrayBuffer(),
        })
        const headers = new Headers(upstream.headers)
        headers.set(CLOUD_REQUEST_ID_HEADER, `rq_${++issued}`)
        return new Response(upstream.body, { status: upstream.status, headers })
      },
    })
    const base = kind === 'anthropic_messages' ? fault.anthropicBaseUrl : fault.openaiBaseUrl
    const viaGateway = base.replace(new URL(base).origin, `http://127.0.0.1:${gateway.port}`)
    const run = async (baseUrl: string) => {
      const led = ledger()
      try {
        await runAgainst(led, { kind, baseUrl, model: 'deepseek-flash' })
        return led.rows()
      } finally {
        led.close()
      }
    }
    try {
      const [received] = await run(viaGateway)
      expect([received?.status, received?.cloudRequestId]).toEqual(['received', 'rq_1'])

      fault.mode = 'payment_required'
      const [rejected] = await run(viaGateway)
      expect([rejected?.status, rejected?.errorCode, rejected?.cloudRequestId]).toEqual([
        'rejected',
        'insufficient_quota',
        'rq_2',
      ])

      fault.mode = 'complete'
      const [direct] = await run(base)
      expect([direct?.status, direct?.cloudRequestId]).toEqual(['received', null])
    } finally {
      gateway.stop(true)
      fault.stop()
    }
  },
)
