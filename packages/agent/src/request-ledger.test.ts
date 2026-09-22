/**
 * 覆盖范围：`loop.ts` 的逐请求账在真实 HTTP 故障下的落账事实
 * （`openRequest` / `markRequestSent` / `markRequestHeaders` / `settleRequest`），
 * 与 `@qywork/ai` 的 `providers/fault-server.test-helper.ts` 三协议故障端点。
 *
 * 请求账走真实的 `@qywork/store`：这几条断言问的是「库里那几行长什么样」，
 * 用替身记录调用序列答不了。step 相关的钩子按空实现，它们不在本文件的范围内。
 *
 * 对账的另一侧是故障端点自己的 `receipts`——服务端侧收到过几次请求。
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
  markProviderRequestFirstContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from './index.ts'
import { MAX_RESENDS } from './loop.ts'
import { ToolRegistry } from './registry.ts'

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
    markRequestFirstContent: (id) => markProviderRequestFirstContent(store, id as never),
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
    requestPermission: async () => true,
  }
}

async function runAgainst(
  ledgerUnderTest: Ledger,
  profile: { kind: 'openai_responses' | 'openai_chat_completions'; baseUrl: string; model: string },
  /**
   * 退避等待。缺省注入立即返回：耗满五次重发的那两条按真实退避要等一分钟，
   * 而它们问的是账本的行数与列值，不是等了多久。
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
      // 这一条要验「退避期间没有新接收」，所以按真实计时等，等的是夹具给的 Retry-After。
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

    // 只断言两次接收之间确实等过，不断言等了多久：退避时长不在本文件的范围内。
    expect(fault.receipts[1]! - fault.receipts[0]!).toBeGreaterThanOrEqual(500)

    // 响应头时刻落在「发出」与「首个事件」之间，它度量的正是这一段首包等待。
    expect(received?.headersAt).not.toBeNull()
    expect(received!.headersAt!).toBeGreaterThanOrEqual(received!.sentAt!)
    expect(received!.firstEventAt!).toBeGreaterThanOrEqual(received!.headersAt!)

    /*
     * 被回绝的那一行同样要有响应头时刻。
     *
     * 非 2xx 走不到 `response_started`（适配器在那条路上直接抛错），时刻只能经传输读数
     * 进账。缺了它，「连不上」与「远端回绝了」在账本上都是一行没有响应头的记录。
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
      // 一个字节都没连上，响应头时刻因此为空：它与「回绝了」是两种不同的失败。
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

test('用量已回报后断流：终态非 received，已收到的用量仍留在账上', async () => {
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
