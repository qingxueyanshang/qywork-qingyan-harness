/**
 * 一轮只解析一次模型规格：轮次进行中修改配置，本轮仍按开始时的规格执行并完成记账。
 *
 * 覆盖范围：`session.ts` 的 `ask`（解析点）、`makeToolContext`（使用本轮 adapter）与收尾记账。
 * 经真实 `Session`、真实 `Store` 与本地 HTTP 端点执行。
 *
 * 原始失败形状：设置页保存时删除了本轮所用的接口，构造工具上下文时重新解析规格并抛出异常，
 * 本轮没有 `run.finished`，也没有记账。
 */

import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId } from '@qywork/core'
import { ContentStore, listRuns, Store, usageEntries } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('轮次开始后接口被删除：本轮按开始时的规格完成，并完成记账', async () => {
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
  const config: QyConfig = {
    active: { provider: 'relay', model: 'deepseek-v4-flash' },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
  }
  const session = new Session({
    content: new ContentStore(':memory:'),
    store,
    config,
    workspaceRoot: await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'run-profile-')),
    signal: new AbortController().signal,
    allowedTools: [],
  })
  try {
    const events: AgentEvent[] = []
    for await (const ev of session.ask('你好')) {
      events.push(ev)
      // 设置页保存配置时就地替换配置对象的内容（`adoptConfig`）。
      if (ev.type === 'run.started') delete config.providers.relay
    }
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished).toMatchObject({ status: 'done' })
    const started = events.find((e) => e.type === 'run.started')
    const run = listRuns(store, started!.conversationId as ConversationId)[0]!
    expect(run.status).toBe('done')
    expect(usageEntries(store).filter((e) => e.runId === run.id && e.kind === 'run')).toHaveLength(
      1,
    )
  } finally {
    session.dispose()
    store.close()
    provider.stop(true)
  }
})
