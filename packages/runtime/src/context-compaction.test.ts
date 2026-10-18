/** 手动压缩后经 Session、HTTP、请求账与面板验证计量基准的连续性。 */
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookupModel } from '@qywork/ai'
import type { AgentEvent, ConversationId } from '@qywork/core'
import {
  ContentStore,
  getConversation,
  latestSentProviderRequest,
  listRecentConversations,
  Store,
} from '@qywork/store'
import { RuntimeCompaction } from './compaction.ts'
import type { QyConfig } from './config.ts'
import { contextPanel } from './context-panel.ts'
import { Session } from './session.ts'

const blobs = new ContentStore(':memory:')

test('压缩后的首次发送、失败重发、无 usage 与会话重建均沿用压缩后基准', async () => {
  let mode: 'before' | 'reject' | 'no-usage' | 'after' = 'before'
  const bodies: string[] = []
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text())
      if (mode === 'reject') {
        return Response.json(
          { error: { type: 'invalid_request_error', message: 'invalid parameter' } },
          { status: 400 },
        )
      }
      const events: unknown[] = [
        { choices: [{ delta: { content: '回答完成' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]
      if (mode !== 'no-usage') {
        events.push({
          choices: [],
          usage: {
            prompt_tokens: mode === 'before' ? 601_476 : 200_448,
            completion_tokens: mode === 'before' ? 1011 : 1151,
          },
        })
      }
      return new Response(
        `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const store = new Store({ path: ':memory:' })
  const config: QyConfig = {
    active: { provider: 'p', model: 'glm-5.3-flashx' },
    providers: {
      p: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'glm-5.3-flashx': {} },
      },
    },
  }
  const workspaceRoot = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'context-'))
  const makeSession = () =>
    new Session({
      content: blobs,
      store,
      config,
      workspaceRoot,
      signal: new AbortController().signal,
      allowedTools: [],
    })
  let session = makeSession()
  let conversationId: ConversationId | undefined
  const model = {
    id: 'glm-5.3-flashx',
    contextWindow: 1_000_000,
    providerName: 'p',
    providerKind: 'openai_chat_completions' as const,
  }
  const ask = async (prompt: string) => {
    const readings: Extract<AgentEvent, { type: 'context' }>[] = []
    for await (const ev of session.ask(prompt, conversationId)) {
      if (ev.type === 'context') {
        readings.push(ev)
        const panel = contextPanel(store, conversationId!, model)
        expect(panel.total).toBe(ev.tokens)
        expect(panel.source).toBe(ev.source)
      }
    }
    return readings
  }
  try {
    // 先通过真实 Session 与本地 HTTP 建立三轮历史和压缩前的用量回执。
    for (let i = 0; i < 3; i++) {
      for await (const _ of session.ask(
        `原始历史${i}：${'old-history-marker '.repeat(8000)}`,
        conversationId,
      )) {
      }
      conversationId = listRecentConversations(store, 1)[0]!.id
    }
    const before = contextPanel(store, conversationId!, model)
    expect(before.total).toBe(602_487)
    const spec = lookupModel(model.id, model.providerKind)
    const compaction = new RuntimeCompaction({
      store,
      conversationId: conversationId!,
      messageIdUpperBound: null,
      summarize: async () => '保留用户事实的摘要。',
    })
    const outcome = await compaction.run({
      trigger: 'manual',
      model: model.id,
      latestUnitSeen: true,
      occupancy: before.total,
      estimatedOccupancy: before.measured,
      contextWindow: model.contextWindow,
      density: spec.density,
    })
    expect(outcome.status).toBe('compacted')
    const snapshot = getConversation(store, conversationId!)!.compactionManifest!.contextAfter!
    expect(snapshot.total).toBeLessThan(400_000)
    expect(contextPanel(store, conversationId!, model).total).toBe(snapshot.total)

    for (const nextMode of ['reject', 'no-usage', 'after'] as const) {
      // 模拟重新加载会话；状态必须从账本恢复，不能靠上次 Session 的内存。
      session.dispose()
      session = makeSession()
      mode = nextMode
      const readings = await ask('继续处理')
      const sent = latestSentProviderRequest(store, conversationId!)!
      expect(readings[0]!.source).toBe('estimated')
      expect(readings[0]!.tokens).toBe(
        snapshot.total + sent.measuredInputTokens - snapshot.measured,
      )
      expect(Math.abs(readings[0]!.tokens - snapshot.total)).toBeLessThan(10_000)
      expect(readings[0]!.tokens).toBeLessThan(400_000)
      const panel = contextPanel(store, conversationId!, model)
      if (nextMode === 'after') {
        expect(panel).toMatchObject({ total: 201_599, percent: 20.2, source: 'actual' })
      } else {
        expect(panel.source).toBe('estimated')
        expect(panel.total).toBe(readings[0]!.tokens)
      }
      expect(getConversation(store, conversationId!)!.compactionManifest!.revision).toBe(1)
    }
    const next = await ask('再继续')
    expect(next[0]!.source).toBe('projected')
    expect(next[0]!.tokens).toBeGreaterThanOrEqual(201_599)
    expect(next[0]!.tokens).toBeLessThan(211_599)
    const beforeBody = JSON.parse(bodies[2]!) as { messages: unknown[] }
    const afterBody = JSON.parse(bodies[3]!) as { messages: unknown[] }
    expect(afterBody.messages.length).toBeLessThan(beforeBody.messages.length)
  } finally {
    session.dispose()
    store.close()
    provider.stop(true)
  }
}, 20_000)
