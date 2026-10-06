import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createSummaryTrace } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import { emptyBreakdown, emptyOmitted } from '@qywork/core'
import {
  createConversation,
  createRun,
  finishRun,
  listProviderRequests,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { exportConversationDiagnostics } from './archive.ts'
import type { QyConfig } from './config.ts'
import { requestPersistence } from './request-persistence.ts'
import { makeSummarizer } from './session.ts'

function fixture(baseUrl: string) {
  const store = new Store({ path: ':memory:' })
  const config: QyConfig = {
    active: { provider: 'p', model: 'diagnostic-model' },
    providers: {
      p: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key-123456',
        baseUrl,
        models: { 'diagnostic-model': {} },
      },
    },
  }
  const ws = upsertWorkspace(store, resolve('.tmp/request-diagnostics'), 'test')
  const cv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'diagnostic-model',
  })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model: cv.model,
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const profile = {
    kind: 'openai_chat_completions' as const,
    apiKey: 'test-key-123456',
    baseUrl,
    model: cv.model,
  }
  const persist = requestPersistence(store, config)
  const trace = createSummaryTrace(persist, run.id, 0, buildAdapter(profile), run.usage, 'p')
  return { store, config, ws, cv, run, profile, persist, trace }
}

function sse(rows: unknown[]) {
  return rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('')
}

for (const mode of ['success', 'stream_error', 'eof', 'abort'] as const) {
  test(`摘要请求的 ${mode} 经真实传输、写入数据库与导出后保留终态`, async () => {
    const controller = new AbortController()
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const provider = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.text()
        if (mode === 'abort') {
          abortTimer = setTimeout(() => controller.abort(), 30)
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(': waiting\n\n'))
              },
              cancel() {},
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const text = { choices: [{ delta: { content: '摘要正文' }, finish_reason: null }] }
        const empty = {
          choices: [{ delta: { content: '', reasoning_content: '' }, finish_reason: null }],
        }
        const usage = {
          choices: [],
          usage: {
            prompt_tokens: 25,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 11 },
          },
        }
        const end = { choices: [{ delta: {}, finish_reason: 'stop' }] }
        const error = {
          error: {
            type: 'invalid_request_error',
            code: 'bad_parameter',
            param: 'max_tokens',
            message: 'bad max_tokens test-key-123456',
          },
        }
        return new Response(
          sse(
            mode === 'success'
              ? [text, empty, usage, end]
              : mode === 'eof'
                ? [text, usage]
                : [error],
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const h = fixture(`http://127.0.0.1:${provider.port}/v1`)
    try {
      const summarize = makeSummarizer({
        profile: () => h.profile,
        signal: controller.signal,
      })
      if (mode === 'success') expect(await summarize('生成摘要', 128, h.trace)).toBe('摘要正文')
      else await expect(summarize('生成摘要', 128, h.trace)).rejects.toBeDefined()
      const row = listProviderRequests(h.store, h.run.id)[0]!
      expect(row.configuration).toMatchObject({
        maxOutputTokens: 128,
        toolCount: 0,
        messageCount: 1,
      })
      expect(row.completedAt).not.toBeNull()
      expect(row.headersAt).not.toBeNull()
      if (mode === 'success') {
        expect(row.status).toBe('received')
        expect(row.lastContentKind).toBe('text')
        expect(row.lastVisibleAt).toBeNull()
        expect(row.providerInputTokens).toBe(14)
        expect(row.providerCachedTokens).toBe(11)
      } else {
        expect(row.status).toBe('uncertain')
        expect(row.diagnostic?.retry.decision).toBe(
          mode === 'abort' ? 'interrupted' : 'not_retryable',
        )
        expect(row.diagnostic?.transport?.status).toBe(200)
        if (mode === 'abort') {
          expect(row.firstEventAt).toBeNull()
          expect(row.diagnostic?.providerEvents).toBe(0)
        }
        if (mode === 'stream_error') expect(row.errorMessage).toContain('bad max_tokens')
        if (mode === 'eof') expect(row.providerInputTokens).toBe(14)
      }
      const exported = exportConversationDiagnostics(h.store, h.cv.id, h.config)
      expect(exported).not.toContain('test-key-123456')
      expect(JSON.parse(exported).runs[0].providerRequests[0].status).toBe(row.status)
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
      h.store.close()
      provider.stop(true)
    }
  })
}

test('结束轮次时立即将未完成的请求置为终态，保留未发送与已发送的区别', () => {
  const h = fixture('http://127.0.0.1:1/v1')
  try {
    for (let i = 0; i < 2; i++) {
      const id = h.persist.openRequest({
        runId: h.run.id,
        turnIndex: i,
        retryIndex: 0,
        purpose: 'turn',
        providerKind: 'openai_chat_completions',
        model: h.cv.model,
        measuredInputTokens: 20,
        sentCategories: emptyBreakdown(),
        omittedCategories: emptyOmitted(),
        payloadHash: 'test',
        requestBytes: 20,
        cacheRouteFingerprint: 'test',
      })
      if (i === 1) h.persist.markRequestSent(id)
    }
    finishRun(h.store, h.run.id, { status: 'interrupted', stopReason: 'user_interrupt' })
    const rows = listProviderRequests(h.store, h.run.id)
    expect(rows.map((r) => r.status)).toEqual(['uncertain', 'uncertain'])
    expect(rows[0]!.sentAt).toBeNull()
    expect(rows[1]!.sentAt).not.toBeNull()
    expect(
      rows.every((r) => r.completedAt !== null && r.diagnostic?.retry.decision === 'run_ended'),
    ).toBe(true)
  } finally {
    h.store.close()
  }
})
