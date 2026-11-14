/**
 * 自动压缩比例从配置到一轮的各处读数。
 *
 * 覆盖范围：`config.ts` 的 `compactPercentFor` 与 `diagnoseConfig`、`session.ts` 在轮次开始时解析比例
 * （写给模型的状态行、循环的触发线）、`agent/loop/attempt.ts` 随主请求写入的 `compactAt`、
 * `context-panel.ts` 优先取请求行的触发线。主请求经真实 `Session`、真实 `Store` 与本地 HTTP 端点执行。
 */

import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderError } from '@qywork/ai'
import type { AgentEvent, ConversationId } from '@qywork/core'
import { ContentStore, listProviderRequests, listRuns, Store } from '@qywork/store'
import { diagnoseConfig, type QyConfig } from '../config.ts'
import { contextPanel } from '../context-panel.ts'
import { Session } from '../session.ts'
import { latestContextSnapshot } from '../transcript.ts'

const blobs = new ContentStore(':memory:')

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 两个型号：claude-opus-5-5 的窗口为 100 万（1M 档），claude-haiku-4-5 为 20 万（256K 档）。 */
function config(baseUrl: string, compactPercent: unknown): QyConfig {
  return {
    active: { provider: 'relay', model: 'claude-opus-5-5' },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl,
        models: { 'claude-opus-5-5': {}, 'claude-haiku-4-5': {} },
      },
    },
    compactPercent: compactPercent as NonNullable<QyConfig['compactPercent']>,
  }
}

async function harness(compactPercent: unknown) {
  const provider = Bun.serve({
    port: 0,
    fetch: () =>
      sse([
        { choices: [{ delta: { content: '完成' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ]),
  })
  const store = new Store({ path: ':memory:' })
  const workspaceRoot = await mkdtemp(
    join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'compact-percent-'),
  )
  const cfg = config(`http://127.0.0.1:${provider.port}/v1`, compactPercent)
  const sessions: Session[] = []
  const ask = async (
    prompt: string,
    options: { conversationId?: ConversationId; model?: string; parent?: ConversationId } = {},
  ) => {
    const session = new Session({
      content: blobs,
      store,
      config: cfg,
      workspaceRoot,
      signal: new AbortController().signal,
    })
    sessions.push(session)
    const events: AgentEvent[] = []
    let conversationId = options.conversationId
    for await (const ev of session.ask(prompt, conversationId, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.parent ? { parentConversationId: options.parent } : {}),
    })) {
      events.push(ev)
      if (ev.type === 'run.started') conversationId = ev.conversationId as ConversationId
    }
    return { conversationId: conversationId!, events }
  }
  const close = () => {
    for (const session of sessions) session.dispose()
    store.close()
    provider.stop(true)
  }
  return { store, cfg, ask, close }
}

function mainRequests(store: Store, conversationId: ConversationId) {
  return listRuns(store, conversationId)
    .flatMap((r) => listProviderRequests(store, r.id))
    .filter((r) => r.purpose === 'turn')
}

function stateLine(store: Store, conversationId: ConversationId): string {
  const segments = latestContextSnapshot(store, conversationId)?.segments ?? []
  return segments.find((s) => s.group === 'workspaceState')?.content ?? ''
}

test('1M 档设为 50：状态行、请求行、上下文事件与面板都是 50 万；256K 档的型号不受影响', async () => {
  const h = await harness({ large: 50 })
  try {
    const opus = await h.ask('第一轮')
    expect(stateLine(h.store, opus.conversationId)).toContain('约 50% 时自动压缩')
    expect(
      mainRequests(h.store, opus.conversationId).map((r) => r.configuration?.compactAt),
    ).toEqual([500_000])
    const lines = opus.events.flatMap((e) => (e.type === 'context' ? [e.compactAt] : []))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines).toEqual(lines.map(() => 500_000))

    const haiku = await h.ask('第一轮', { model: 'claude-haiku-4-5' })
    expect(stateLine(h.store, haiku.conversationId)).toContain('约 80% 时自动压缩')
    expect(
      mainRequests(h.store, haiku.conversationId).map((r) => r.configuration?.compactAt),
    ).toEqual([160_000])

    // 面板取请求行的触发线：设置改回 80 之后，本轮已显示的 50 万不变；下一轮的请求行写入后才显示新值。
    const route = {
      id: 'claude-opus-5-5',
      contextWindow: 1_000_000,
      providerName: 'relay',
      providerKind: 'openai_chat_completions' as const,
    }
    expect(contextPanel(h.store, opus.conversationId, route, 80).compactAt).toBe(500_000)
    h.cfg.compactPercent = { large: 80 }
    await h.ask('第二轮', { conversationId: opus.conversationId })
    expect(contextPanel(h.store, opus.conversationId, route, 80).compactAt).toBe(800_000)
    expect(stateLine(h.store, opus.conversationId)).toContain('约 80% 时自动压缩')
  } finally {
    h.close()
  }
})

test('父会话与子会话使用不同档的型号时各按自己的档位', async () => {
  const h = await harness({ large: 40, small: 65 })
  try {
    const parent = await h.ask('父会话')
    const child = await h.ask('子会话', {
      model: 'claude-haiku-4-5',
      parent: parent.conversationId,
    })
    expect(
      mainRequests(h.store, parent.conversationId).map((r) => r.configuration?.compactAt),
    ).toEqual([400_000])
    // 20 万窗口在 65 时为 13 万，低于最低触发线 15 万，取 15 万。
    expect(
      mainRequests(h.store, child.conversationId).map((r) => r.configuration?.compactAt),
    ).toEqual([150_000])
  } finally {
    h.close()
  }
})

test('配置文件中的比例为字符串或小数时，轮次在启动前以配置错误终止，错误码为 invalid_request', async () => {
  for (const bad of [{ large: '50' }, { large: 52.5 }, { small: 50 }, { large: 90 }]) {
    const h = await harness(bad)
    try {
      expect(diagnoseConfig(h.cfg).some((p) => p.startsWith('compactPercent.'))).toBe(true)
      let failure: unknown = null
      try {
        await h.ask('第一轮')
      } catch (err) {
        failure = err
      }
      // 错误码由抛出处给出：`startRun` 与手动压缩按 `ProviderError.code` 报告，未分类的错误记为 internal_error。
      expect(failure).toBeInstanceOf(ProviderError)
      expect((failure as ProviderError).code).toBe('invalid_request')
      expect((failure as ProviderError).message).toContain('自动压缩比例不合法')
      // 启动前终止：没有轮次，也没有发出请求。
      const runs = h.store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runs').get()
      expect(runs?.n).toBe(0)
    } finally {
      h.close()
    }
  }
})
