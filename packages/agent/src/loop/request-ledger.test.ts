/**
 * 覆盖范围：`loop/attempt.ts` 的逐请求账在真实 HTTP 故障下写入的记录
 * （`openRequest` / `markRequestSent` / `markRequestHeaders` / `settleRequest`），
 * 与 `@qywork/ai` 的 `providers/fault-server.test-helper.ts` 三协议故障端点。
 *
 * 请求账使用真实的 `@qywork/store`：断言检查的是数据库中记录行的内容，
 * 用替身记录调用序列无法验证。step 相关的钩子为空实现，不在本文件的范围内。
 *
 * 对照数据是故障端点的 `receipts`，即服务端收到的请求次数。
 */

import { expect, test } from 'bun:test'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import {
  closedPortBaseUrl,
  type FaultServer,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
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
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { MAX_RESENDS } from './attempt.ts'

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
  profile: { kind: 'openai_responses' | 'openai_chat_completions'; baseUrl: string; model: string },
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
      // 本用例验证退避期间没有新接收，因此按真实计时等待夹具给出的 Retry-After。
      (ms) => Bun.sleep(ms),
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
    expect(rows.length).toBe(MAX_RESENDS + 1)
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
