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
import { makeSummarizer } from './summarizer.ts'

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
    const provider = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.text()
        if (mode === 'abort') {
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
        sleep: async () => {},
      })
      const pending = summarize('生成摘要', 128, h.trace)
      if (mode === 'abort') {
        // 记下响应头之后再中止。不要改回在服务端收到请求时计时中止：负载高时中止先于响应头到达客户端，headersAt 为空。
        while (!listProviderRequests(h.store, h.run.id)[0]?.headersAt) await Bun.sleep(5)
        controller.abort()
      }
      if (mode === 'success') expect(await pending).toBe('摘要正文')
      else await expect(pending).rejects.toBeDefined()
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
        // 流内错误事件是对端的明确答复，记为被拒绝；断流与中止无法确定送达，记为结果不明。
        expect(row.status).toBe(mode === 'stream_error' ? 'rejected' : 'uncertain')
        // 断流属于暂时故障，与主请求相同按上限重发；参数错误不重发。
        expect(row.diagnostic?.retry.decision).toBe(
          mode === 'abort' ? 'interrupted' : mode === 'eof' ? 'resend' : 'not_retryable',
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
      h.store.close()
      await provider.stop(true)
    }
  })
}

/**
 * 原始失败形状：手动压缩的摘要请求遇到一次「上游服务暂时不可用」即放弃，压缩只完成收纳、摘要未完成；
 * 同一时刻的主请求按重发规则自行恢复。摘要请求按同一规则重发，重发记为同一编号的下一次尝试。
 */
test('摘要请求遇到暂时故障时按主请求的规则重发，重发记为同一编号的下一次尝试', async () => {
  let calls = 0
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text()
      calls++
      if (calls === 1) {
        return Response.json(
          { error: { message: '上游服务暂时不可用，请稍后重试', type: 'service_unavailable' } },
          { status: 503 },
        )
      }
      const rows = [
        { choices: [{ delta: { content: '摘要正文' }, finish_reason: null }] },
        { choices: [], usage: { prompt_tokens: 25, completion_tokens: 5 } },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]
      return new Response(sse(rows), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const h = fixture(`http://127.0.0.1:${provider.port}/v1`)
  try {
    const waits: number[] = []
    const summarize = makeSummarizer({
      profile: () => h.profile,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(await summarize('生成摘要', 128, h.trace)).toBe('摘要正文')
    const rows = listProviderRequests(h.store, h.run.id)
    expect(rows.map((r) => [r.turnIndex, r.retryIndex, r.status])).toEqual([
      [0, 0, 'rejected'],
      [0, 1, 'received'],
    ])
    expect(rows[0]?.diagnostic?.retry).toMatchObject({ decision: 'resend', attempt: 1 })
    expect(waits).toHaveLength(1)
  } finally {
    h.store.close()
    await provider.stop(true)
  }
})

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

test('摘要请求的补发记录经记账接口写入同一行', () => {
  const h = fixture('http://127.0.0.1:9/v1')
  try {
    const id = h.trace.open({
      model: 'diagnostic-model',
      system: [],
      messages: [{ role: 'user', content: '生成摘要' }],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: 1_000,
    })
    h.trace.hedge(id, { sentAt: 1_700_000_180_000, won: true })
    expect(listProviderRequests(h.store, h.run.id)[0]?.hedge).toEqual({
      sentAt: 1_700_000_180_000,
      won: true,
    })
  } finally {
    h.store.close()
  }
})
