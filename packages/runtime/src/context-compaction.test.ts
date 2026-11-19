/**
 * 手动压缩后经 Session、HTTP、请求账与面板验证计量基准的连续性。
 * 覆盖范围：`compaction.ts` 的压缩后读数、`session/turn/history.ts` 的 `nextRequestMeasure`、`context-panel.ts`。
 */
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDensity } from '@qywork/agent'
import { buildAdapter, lookupModel } from '@qywork/ai'
import type { AgentEvent, ConversationId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  ContentStore,
  createRun,
  getConversation,
  latestSentProviderRequest,
  listRecentConversations,
  Store,
  settleToolStep,
} from '@qywork/store'
import { RuntimeCompaction } from './compaction.ts'
import type { QyConfig } from './config.ts'
import { contextPanel } from './context-panel.ts'
import { nextRequestMeasure } from './session/turn/history.ts'
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
          // 压缩后的请求很小，回报值须在估算的 1.5 倍加 2 万之内才作为锚点。
          usage: {
            prompt_tokens: mode === 'before' ? 601_476 : 6_448,
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
        const panel = contextPanel(store, conversationId!, model, 80)
        expect(panel.total).toBe(ev.tokens)
        expect(panel.source).toBe(ev.source)
      }
    }
    return readings
  }
  try {
    // 先通过真实 Session 与本地 HTTP 建立三轮历史和压缩前的用量回执。
    // 每段本地估算约 14 万：回报的输入量不超过估算的 1.5 倍加 2 万时，回执才作为锚点。
    for (let i = 0; i < 3; i++) {
      for await (const _ of session.ask(
        `原始历史${i}：${'old-history-marker '.repeat(35_000)}`,
        conversationId,
      )) {
      }
      conversationId = listRecentConversations(store, 1)[0]!.id
    }
    const before = contextPanel(store, conversationId!, model, 80)
    expect(before.total).toBe(602_487)
    const spec = lookupModel(model.id, model.providerKind)
    const compaction = new RuntimeCompaction({
      store,
      conversationId: conversationId!,
      workspaceRoot: process.cwd(),
      messageIdUpperBound: null,
      summarize: async () => '保留用户事实的摘要。',
    })
    const outcome = await compaction.run({
      compactPercent: 80,
      trigger: 'manual',
      model: model.id,
      latestUnitSeen: true,
      occupancy: before.total,
      estimatedOccupancy: before.measured,
      measure: await nextRequestMeasure(
        store,
        workspaceRoot,
        conversationId!,
        buildAdapter({
          kind: model.providerKind,
          apiKey: 'test-key',
          model: model.id,
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        }),
        model.providerName,
      ),
      contextWindow: model.contextWindow,
      density: spec.density,
    })
    expect(outcome.status).toBe('compacted')
    const snapshot = getConversation(store, conversationId!)!.compactionManifest!.contextAfter!
    expect(snapshot.total).toBeLessThan(400_000)
    expect(contextPanel(store, conversationId!, model, 80).total).toBe(snapshot.total)

    for (const nextMode of ['reject', 'no-usage', 'after'] as const) {
      // 模拟重新加载会话；状态必须从账本恢复，不能依赖上次 Session 的内存。
      await session.dispose()
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
      const panel = contextPanel(store, conversationId!, model, 80)
      if (nextMode === 'after') {
        expect(panel).toMatchObject({ total: 7_599, percent: 0.8, source: 'actual' })
      } else {
        expect(panel.source).toBe('estimated')
        expect(panel.total).toBe(readings[0]!.tokens)
      }
      expect(getConversation(store, conversationId!)!.compactionManifest!.revision).toBe(1)
    }
    const next = await ask('再继续')
    expect(next[0]!.source).toBe('projected')
    expect(next[0]!.tokens).toBeGreaterThanOrEqual(7_599)
    expect(next[0]!.tokens).toBeLessThan(17_599)
    const beforeBody = JSON.parse(bodies[2]!) as { messages: unknown[] }
    const afterBody = JSON.parse(bodies[3]!) as { messages: unknown[] }
    expect(afterBody.messages.length).toBeLessThan(beforeBody.messages.length)
  } finally {
    await session.dispose()
    store.close()
    await provider.stop(true)
  }
}, 20_000)

/**
 * 压缩后的读数必须等于下一次请求的估算。
 *
 * 截图较多的会话中，较早的截图在压缩之前已被换出为缩略图（`evictedMedia`），请求中计入的是缩略图。
 * 回收量按账本原样（原尺寸截图）估算时偏高，压缩后读数低于下一次请求的估算，发出一条短消息后读数随即升高。
 */
test('手动压缩后的读数与下一次请求的估算一致：被折叠的截图在压缩前已缩小为缩略图', async () => {
  const provider = Bun.serve({
    port: 0,
    fetch: async (req) => {
      // 先读完请求体再答复：请求体约 190 KB，未读完即答复时客户端仍在上传，连接被重置，请求以 Connection error 失败并进入重发等待。
      await req.text()
      const events = [
        { choices: [{ delta: { content: '回答完成' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]
      // 不回报用量：读数全程是本地估算，两次请求之间的差额只来自内容本身。
      return new Response(
        `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const store = new Store({ path: ':memory:' })
  const model = {
    id: 'glm-5.3-flashx',
    contextWindow: 1_000_000,
    providerName: 'p',
    providerKind: 'openai_chat_completions' as const,
  }
  const baseUrl = `http://127.0.0.1:${provider.port}/v1`
  const config: QyConfig = {
    active: { provider: 'p', model: model.id },
    providers: {
      p: { kind: model.providerKind, apiKey: 'test-key', baseUrl, models: { [model.id]: {} } },
    },
  }
  const workspaceRoot = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'context-'))
  const session = new Session({
    content: blobs,
    store,
    config,
    workspaceRoot,
    signal: new AbortController().signal,
    allowedTools: [],
  })
  const ask = async (prompt: string, conversationId?: ConversationId) => {
    const readings: Extract<AgentEvent, { type: 'context' }>[] = []
    for await (const ev of session.ask(prompt, conversationId)) {
      if (ev.type === 'context') readings.push(ev)
    }
    return readings
  }
  try {
    await ask('打开页面逐个截图')
    const conversationId = listRecentConversations(store, 1)[0]!.id
    const { workspaceId } = getConversation(store, conversationId)!
    // 一轮浏览器操作：24 批截图，每张约 0.9 MB，合计远超请求中常驻媒体的上限，较早的截图在下一次请求中缩小为缩略图。
    const message = appendMessage(store, { conversationId, role: 'user', content: '逐页检查' })
    const run = createRun(store, {
      conversationId,
      workspaceId,
      provider: 'p',
      model: model.id,
      clientRequestId: 'screenshots',
      userMessageId: message.id,
      messageIdUpperBound: message.id,
      contextSnapshot: [],
    })
    const waves = 24
    for (let w = 0; w < waves; w++) {
      const step = appendStep(store, {
        runId: run.id,
        seq: w + 1,
        kind: 'tool_action',
        toolName: 'browser',
        toolCallId: `call_shot_${w}`,
        providerBatchId: `bt_shot_${w}`,
        callIndex: 0,
        status: 'running',
      })
      settleToolStep(store, step.id, 'success', {
        kind: 'tool_result',
        args: { action: 'screenshot' },
        outcome: {
          status: 'success',
          executed: true,
          message: `第 ${w} 页截图`,
          data: {
            title: `第 ${w} 页：${'页面中的文字与控件说明。'.repeat(600)}`,
            images: [
              {
                resourceId: `rs_shot_${w}`,
                mime: 'image/png',
                bytes: 900_000,
                size: { width: 1920, height: 1080 },
              },
            ],
          },
        },
      })
    }
    appendStep(store, {
      runId: run.id,
      seq: waves + 1,
      kind: 'text',
      content: '全部页面已检查。',
      providerBatchId: 'bt_shot_done',
    })
    await ask('汇总结果', conversationId)

    const before = contextPanel(store, conversationId, model, 80)
    const adapter = buildAdapter({
      kind: model.providerKind,
      apiKey: 'test-key',
      model: model.id,
      baseUrl,
    })
    const outcome = await new RuntimeCompaction({
      store,
      conversationId,
      workspaceRoot,
      messageIdUpperBound: null,
      summarize: async () => '已逐页截图检查。',
    }).run({
      compactPercent: 80,
      trigger: 'manual',
      model: model.id,
      latestUnitSeen: true,
      occupancy: before.total,
      estimatedOccupancy: before.measured,
      measure: await nextRequestMeasure(
        store,
        workspaceRoot,
        conversationId,
        adapter,
        model.providerName,
      ),
      contextWindow: model.contextWindow,
      density: runDensity(adapter),
    })
    expect(outcome.status === 'compacted' && outcome.summarized).toBe(true)
    const snapshot = getConversation(store, conversationId)!.compactionManifest!.contextAfter!
    expect(contextPanel(store, conversationId, model, 80).total).toBe(snapshot.total)

    await ask('继续', conversationId)
    // 压缩后第一次请求的读数：压缩后读数加上本次估算与压缩时估算之差（`RunState.meter`）。
    // 不取 `context` 事件：截图的正文不在正文库中，适配器按替换为说明之后的请求估算。
    const sent = latestSentProviderRequest(store, conversationId)!
    expect(sent.occupancyTokens).toBe(snapshot.total + sent.measuredInputTokens - snapshot.measured)
    // 差额只有压缩之后新增的内容：新的用户消息、本轮的运行上下文与上一轮的回复，合计约 150。
    // 按账本原样估算回收量时，本用例的压缩后读数比这次请求低约 3.7 万。
    expect(Math.abs(sent.occupancyTokens! - snapshot.total)).toBeLessThan(1_000)
  } finally {
    await session.dispose()
    store.close()
    await provider.stop(true)
  }
}, 20_000)
