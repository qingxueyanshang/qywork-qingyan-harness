/** 覆盖手动压缩入口、HTTP 摘要、SQLite 历史恢复与会话导出。 */
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentEvent } from '@qywork/core'
import { catalogKey, exportConversationDiagnostics, type QyConfig } from '@qywork/runtime'
import {
  appendMessage,
  createConversation,
  listConversationHistoryPage,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import type { CommandDeps } from './deps.ts'
import { compactConversation } from './run-control.ts'

test('摘要尚未返回时历史页包含压缩进度，结束后更新同一条记录', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived!: () => void
  const requested = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const provider = Bun.serve({
    port: 0,
    async fetch() {
      arrived()
      await waiting
      return new Response(
        [
          { choices: [{ delta: { content: '已整理材料，继续核对。' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]
          .map((row) => `data: ${JSON.stringify(row)}\n\n`)
          .join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
  })
  const store = new Store({ path: ':memory:' })
  let work: Promise<void> | undefined
  try {
    const ws = upsertWorkspace(store, resolve('.tmp/compaction-progress'), 'progress')
    const cv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'diagnostic-model',
    })
    for (let i = 0; i < 5; i++)
      appendMessage(store, {
        conversationId: cv.id,
        role: 'user',
        content: `第${i}条${'核对材料。'.repeat(500)}`,
      })
    work = compactConversation(cv.id, {
      store,
      config: {
        providers: {
          p: {
            kind: 'openai_chat_completions',
            apiKey: 'test',
            baseUrl: `http://127.0.0.1:${provider.port}/v1`,
            models: { 'diagnostic-model': {} },
          },
        },
      },
      bus: { publish() {} },
    } as unknown as CommandDeps)
    await requested
    const during = listConversationHistoryPage(store, cv.id, { limit: 10 })
    expect(during.steps).toHaveLength(1)
    expect(during.steps[0]).toMatchObject({
      status: 'running',
      payload: { kind: 'compaction', phase: 'started', stage: 'summarizing' },
    })
    release()
    await work
    const after = listConversationHistoryPage(store, cv.id, { limit: 10 })
    expect(after.steps).toHaveLength(1)
    expect(after.steps[0]).toMatchObject({
      id: during.steps[0]!.id,
      status: 'success',
      payload: { phase: 'done' },
    })
    expect(after.runs[0]?.stepCount).toBe(1)
  } finally {
    release()
    await work
    store.close()
    provider.stop(true)
  }
})

test('摘要被拒后仍保留原生错误、请求参数、降级原因，导出时改配置不改历史', async () => {
  const requests: Record<string, unknown>[] = []
  const secret = 'test-provider-secret-123456'
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>)
      return Response.json(
        {
          error: {
            message: `max_tokens must be <= 8192; credential ${secret}`,
            code: 'invalid_parameter',
            type: 'invalid_request_error',
            param: 'max_tokens',
          },
        },
        { status: 400 },
      )
    },
  })
  const store = new Store({ path: ':memory:' })
  try {
    const endpoint = `http://127.0.0.1:${provider.port}/v1`
    const config: QyConfig = {
      active: { provider: 'p', model: 'diagnostic-model' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          apiKey: secret,
          baseUrl: endpoint,
          models: { 'diagnostic-model': {} },
        },
      },
    }
    const ws = upsertWorkspace(store, resolve('.tmp/diagnostic-workspace'), 'diagnostic')
    const cv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'diagnostic-model',
      title: 'summary failure',
    })
    for (let i = 0; i < 5; i++)
      appendMessage(store, {
        conversationId: cv.id,
        role: 'user',
        content: `第${i}次要求：${'保留必要上下文。'.repeat(500)}`,
      })
    const events: AgentEvent[] = []
    await compactConversation(cv.id, {
      store,
      config,
      bus: { publish: (ev: AgentEvent) => events.push(ev) },
    } as unknown as CommandDeps)
    expect(requests).toHaveLength(1)
    config.providers.p!.baseUrl = 'https://new-endpoint.example/v1'
    const exported = exportConversationDiagnostics(store, cv.id, config)
    const bundle = JSON.parse(exported)
    expect(bundle.collectionErrors).toEqual([])
    expect(bundle.schemaVersion).toBe(8)
    expect(bundle.conversationProfiles[0].source).toBe('export_time')
    const run = bundle.runs[0]
    const request = run.providerRequests[0]
    expect(request).toMatchObject({
      purpose: 'summary',
      status: 'rejected',
      errorCode: 'invalid_request',
      configuration: { endpoint, maxOutputTokens: requests[0]!.max_tokens, toolCount: 0 },
      diagnostic: {
        provider: { status: 400, code: 'invalid_parameter', type: 'invalid_request_error' },
        retry: { decision: 'not_retryable' },
      },
    })
    expect(request.errorMessage).toContain('max_tokens must be <= 8192')
    expect(request.diagnostic.causes.length).toBeGreaterThan(0)
    expect(request.headersAt).not.toBeNull()
    expect(request.completedAt).not.toBeNull()
    expect(request.firstContentAt).toBeNull()
    expect(request.providerInputTokens).toBeNull()
    expect(exported).not.toContain(secret)
    expect(run.steps[0].payload).toMatchObject({
      trigger: 'manual',
      reasonCode: 'summary_error',
      summarized: false,
    })
    expect(run.steps[0].payload.message).toBeTruthy()
    expect(bundle.runSignals[0]).toMatchObject({
      summaryRequests: 1,
      failedSummaryRequests: 1,
      failedRequestsWithoutDiagnostics: [],
      requestsWithoutConfiguration: 0,
    })
    expect(
      events.some(
        (ev) =>
          ev.type === 'compaction' && ev.phase === 'done' && ev.reasonCode === 'summary_error',
      ),
    ).toBe(true)
  } finally {
    store.close()
    provider.stop(true)
  }
})

test('手动摘要锁定会话接口，成功用量只记一笔并保留实际币种', async () => {
  let calls = 0
  const provider = Bun.serve({
    port: 0,
    fetch() {
      calls++
      const rows = [
        {
          choices: [{ delta: { content: '已完成材料整理，后续继续核对。' }, finish_reason: null }],
        },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]
      return new Response(rows.map((r) => `data: ${JSON.stringify(r)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const store = new Store({ path: ':memory:' })
  try {
    const endpoint = `http://127.0.0.1:${provider.port}/v1`
    const model = 'diagnostic-model'
    const config: QyConfig = {
      active: { provider: 'wrong', model },
      providers: {
        wrong: {
          kind: 'openai_chat_completions',
          apiKey: 'test',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: { [model]: {} },
        },
        correct: {
          kind: 'openai_chat_completions',
          apiKey: 'test',
          baseUrl: endpoint,
          models: { [model]: {} },
        },
      },
      catalog: {
        [catalogKey(model, 'openai_chat_completions')]: { currency: 'CNY', input: 10, output: 20 },
      },
    }
    const ws = upsertWorkspace(store, resolve('.tmp/summary-usage'), 'summary')
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'correct', model })
    for (let i = 0; i < 5; i++)
      appendMessage(store, {
        conversationId: cv.id,
        role: 'user',
        content: `第${i}条：${'材料核对与整理。'.repeat(500)}`,
      })
    await compactConversation(cv.id, {
      store,
      config,
      bus: { publish() {} },
    } as unknown as CommandDeps)
    expect(calls).toBe(1)
    const bundle = JSON.parse(exportConversationDiagnostics(store, cv.id, config))
    const run = bundle.runs[0]
    expect(run.providerRequests[0]).toMatchObject({
      providerName: 'correct',
      status: 'received',
      configuration: { endpoint },
    })
    expect(run.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      currency: 'CNY',
      cost: 0.0012,
    })
    const ledger = store.db
      .query('SELECT run_id, input_tokens, output_tokens, currency, cost FROM usage_ledger')
      .all()
    expect(ledger).toEqual([
      { run_id: run.id, input_tokens: 100, output_tokens: 10, currency: 'CNY', cost: 0.0012 },
    ])
  } finally {
    store.close()
    provider.stop(true)
  }
})
