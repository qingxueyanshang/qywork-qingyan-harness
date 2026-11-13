/**
 * 请求信封的明细随主请求写入。
 *
 * 覆盖范围：`request-persistence.ts` 的 `openRequest`（明细与请求行同一事务）、`agent/loop/attempt.ts`
 * 随主请求提供估算、`agent/loop/request.ts` 的 `envelopeItemsOf`、`agent/loop/summary-trace.ts`
 * 的摘要请求不提供估算、`store/monitor/envelopes.ts` 的写入与读取、`store/repos.ts` 的
 * `deleteConversation` 清除孤立明细。主请求经真实 `Session`、完整的内置工具表、真实 `Store`
 * 与本地 HTTP 端点执行。
 */

import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSummaryTrace } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import { type ConversationId, emptyBreakdown, emptyOmitted } from '@qywork/core'
import {
  ContentStore,
  createConversation,
  createRun,
  deleteConversation,
  listProviderRequests,
  listRuns,
  requestEnvelopeItems,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import type { QyConfig } from '../config.ts'
import { requestPersistence } from '../request-persistence.ts'
import { Session } from '../session.ts'

const blobs = new ContentStore(':memory:')

const ENVELOPE_GROUPS = ['systemPrompt', 'systemTools', 'mcpTools'] as const

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function envelopeRows(store: Store): { fingerprint: string; items: string }[] {
  return store.db
    .query<{ fingerprint: string; items: string }, []>(
      'SELECT fingerprint, items FROM request_envelopes ORDER BY fingerprint',
    )
    .all()
}

function config(baseUrl: string): QyConfig {
  return {
    active: { provider: 'relay', model: 'claude-opus-5-5' },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl,
        models: { 'claude-opus-5-5': {} },
      },
    },
  }
}

test('同一信封的两轮只写入一份明细，逐项与实际发送的工具表一致，删除会话后清除', async () => {
  const bodies: { tools?: { function: { name: string } }[] }[] = []
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(JSON.parse(await req.text()))
      return sse([
        { choices: [{ delta: { content: '完成' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ])
    },
  })
  const store = new Store({ path: ':memory:' })
  const workspaceRoot = await mkdtemp(
    join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'request-envelopes-'),
  )
  const sessions: Session[] = []
  let conversationId: ConversationId | undefined
  const ask = async (prompt: string) => {
    const session = new Session({
      content: blobs,
      store,
      config: config(`http://127.0.0.1:${provider.port}/v1`),
      workspaceRoot,
      signal: new AbortController().signal,
    })
    sessions.push(session)
    for await (const ev of session.ask(prompt, conversationId)) {
      if (ev.type === 'run.started') conversationId = ev.conversationId as ConversationId
    }
  }
  try {
    await ask('第一轮')
    await ask('第二轮')

    const requests = listRuns(store, conversationId!).flatMap((r) =>
      listProviderRequests(store, r.id),
    )
    expect(requests.map((r) => r.purpose)).toEqual(['turn', 'turn'])
    const fingerprint = requests[0]!.cacheRouteFingerprint!
    expect(requests[1]!.cacheRouteFingerprint).toBe(fingerprint)

    const rows = envelopeRows(store)
    expect(rows.map((r) => r.fingerprint)).toEqual([fingerprint])
    const stored = JSON.parse(rows[0]!.items) as {
      group: string
      name: string | null
      tokens: number
    }[]
    const sentTools = bodies[0]!.tools!.map((t) => t.function.name)
    expect(sentTools.length).toBeGreaterThan(10)
    expect(stored[0]).toMatchObject({ group: 'systemPrompt', name: null })
    expect(stored.slice(1).map((i) => i.name)).toEqual(sentTools)

    // 对齐之前：逐项之和与请求行上的分组值之差在 10% 以内。
    const groups = requests[0]!.sentCategories
    for (const group of ENVELOPE_GROUPS) {
      const sum = stored.filter((i) => i.group === group).reduce((n, i) => n + i.tokens, 0)
      expect(Math.abs(sum - groups[group])).toBeLessThanOrEqual(groups[group] * 0.1)
    }
    expect(groups.systemPrompt).toBeGreaterThan(0)
    expect(groups.systemTools).toBeGreaterThan(0)

    // 对齐之后：逐项之和等于分组值。
    const aligned = requestEnvelopeItems(store, fingerprint, groups)!
    for (const group of ENVELOPE_GROUPS) {
      expect(aligned.filter((i) => i.group === group).reduce((n, i) => n + i.tokens, 0)).toBe(
        stored.some((i) => i.group === group) ? groups[group] : 0,
      )
    }

    expect(deleteConversation(store, conversationId!)).toBe(true)
    expect(envelopeRows(store)).toEqual([])
  } finally {
    for (const session of sessions) session.dispose()
    store.close()
    provider.stop(true)
  }
})

function fixture() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws', 'ws')
  const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'envelopes',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const cfg = config('http://127.0.0.1:9/v1')
  return { store, run, cfg, persist: requestPersistence(store, cfg) }
}

function mainRequest(runId: string, turnIndex: number, fingerprint: string) {
  return {
    runId: runId as never,
    turnIndex,
    retryIndex: 0,
    purpose: 'turn' as const,
    providerKind: 'openai_chat_completions' as const,
    model: 'm',
    measuredInputTokens: 10,
    sentCategories: emptyBreakdown(),
    omittedCategories: emptyOmitted(),
    payloadHash: 'h',
    requestBytes: 10,
    cacheRouteFingerprint: fingerprint,
  }
}

test('估算只在该指纹尚无明细时调用；估算失败时请求行一并回滚', () => {
  const { store, run, persist } = fixture()
  try {
    let estimates = 0
    const estimate = () => {
      estimates++
      return [{ group: 'systemPrompt' as const, name: null, tokens: 5 }]
    }
    persist.openRequest({ ...mainRequest(run.id, 0, 'fp_a'), envelopeItems: estimate })
    persist.openRequest({ ...mainRequest(run.id, 1, 'fp_a'), envelopeItems: estimate })
    expect(estimates).toBe(1)
    expect(envelopeRows(store).map((r) => r.fingerprint)).toEqual(['fp_a'])

    expect(() =>
      persist.openRequest({
        ...mainRequest(run.id, 2, 'fp_b'),
        envelopeItems: () => {
          throw new Error('估算失败')
        },
      }),
    ).toThrow('估算失败')
    expect(listProviderRequests(store, run.id).map((r) => r.turnIndex)).toEqual([0, 1])
    expect(envelopeRows(store).map((r) => r.fingerprint)).toEqual(['fp_a'])
  } finally {
    store.close()
  }
})

test('摘要请求写入请求行，不写入明细', () => {
  const { store, run, cfg, persist } = fixture()
  try {
    const adapter = buildAdapter({
      kind: 'openai_chat_completions',
      apiKey: 'test-key',
      baseUrl: cfg.providers.relay!.baseUrl!,
      model: 'm',
    })
    const trace = createSummaryTrace(persist, run.id, 0, adapter, run.usage)
    trace.open({
      model: 'm',
      system: [{ text: '摘要器的系统提示词' }],
      messages: [{ role: 'user', content: '执行记录片段' }],
      tools: [],
      maxOutputTokens: null,
      idleTimeoutMs: 1000,
    })
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => r.purpose)).toEqual(['summary'])
    expect(rows[0]!.cacheRouteFingerprint).not.toBeNull()
    expect(envelopeRows(store)).toEqual([])
  } finally {
    store.close()
  }
})
