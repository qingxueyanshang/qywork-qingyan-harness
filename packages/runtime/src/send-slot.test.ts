/**
 * 摘要请求与 art 请求取得与主请求同一个在途名额（`@qywork/agent` 的 `sendLimiter`）。
 *
 * 覆盖范围：`summarizer.ts` 的 `makeSummarizer` 与 `art.ts` 的 `generateArt`（经 `media.ts` 的 `makeMediaPort` 分派）。
 * 对端是本机模拟的对话接口，记录收到的请求数。
 *
 * 原始失败形状：中转报告并发超限、上限降为 1 且名额已被占用时，摘要与 art 请求不排队，
 * 立即发出。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createSummaryTrace, sendLane, sendLimiter } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import { createConversation, createRun, Store, upsertWorkspace } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'
import { requestPersistence } from './request-persistence.ts'
import { makeSummarizer } from './summarizer.ts'

let server: ReturnType<typeof Bun.serve>
let received = 0

const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
const SSE =
  chunk({
    choices: [{ delta: { content: '<!doctype html><html></html>' }, finish_reason: null }],
  }) +
  chunk({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }) +
  'data: [DONE]\n\n'

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      await req.text()
      received++
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
})
afterAll(() => server.stop(true))

/** 每个用例使用独立的模型 id：名额按「端点 × 模型」分别计数，用例之间不共用上限。 */
function config(model: string): QyConfig {
  return {
    active: { provider: 'relay', model },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: { [model]: {} },
      },
    },
  }
}

/** 把该名额的上限降为 1 并占用它，返回释放函数。 */
async function occupy(model: string): Promise<() => void> {
  const lane = sendLane(
    buildAdapter({
      kind: 'openai_chat_completions',
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model,
    }),
  )
  const signal = new AbortController().signal
  ;(await sendLimiter.acquire(lane, signal))('concurrency_rejected')
  const hold = await sendLimiter.acquire(lane, signal)
  return () => hold('completed')
}

/** 等待若干轮事件循环，使未排队的请求有机会到达对端。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Bun.sleep(5)
}

test('上限为 1 且名额被占用时，摘要请求排队，释放后才发出', async () => {
  const model = 'slot-summary'
  const cfg = config(model)
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, resolve('.tmp/send-slot'), 'test')
  const cv = createConversation(store, { workspaceId: ws.id, provider: 'relay', model })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model,
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const profile = {
    kind: 'openai_chat_completions' as const,
    apiKey: 'sk-test',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model,
  }
  const trace = createSummaryTrace(
    requestPersistence(store, cfg),
    run.id,
    0,
    buildAdapter(profile),
    run.usage,
    'relay',
  )
  const release = await occupy(model)
  const before = received
  try {
    const pending = makeSummarizer({ profile: () => profile })('生成摘要', 128, trace)
    await settle()
    expect(received).toBe(before)
    release()
    expect(await pending).not.toBeNull()
    expect(received).toBe(before + 1)
  } finally {
    store.close()
  }
})

test('上限为 1 且名额被占用时，art 请求排队，释放后才发出', async () => {
  const model = 'slot-art'
  const release = await occupy(model)
  const before = received
  const pending = makeMediaPort(config(model)).generate(
    { type: 'art', prompt: '页面', inputs: [], params: {} },
    new AbortController().signal,
  )
  await settle()
  expect(received).toBe(before)
  release()
  expect((await pending).ok).toBe(true)
  expect(received).toBe(before + 1)
})
