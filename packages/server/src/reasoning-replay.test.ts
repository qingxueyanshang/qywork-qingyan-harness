/**
 * Claude 原生思考块跨轮、跨 run 回放的端到端回归测试。**使用假 provider，不产生费用、不访问网络。**
 *
 * **覆盖范围**：`ai/providers/anthropic.ts` 采集签名与块位置、`agent/loop/attempt.ts` 记录前缀指纹、
 * 思考 step 载荷写入账本、`runtime/transcript.ts` 从账本投影回历史、`agent/loop/request.ts`
 * 的前缀比对，以及 Anthropic 适配器原位回放。
 *
 * **必须使用真实链路的原因。** 前缀指纹必须在「内存中的 transcript」与「下一个 run 从账本投影出的
 * 历史」上逐字相同，块才会被回放；两侧任何一个字段形状不同，块就会被静默剥离，
 * 而模型仍能作答；只有请求体能证明块仍然存在。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  latestTodos,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

function sse(events: Record<string, unknown>[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const START = {
  type: 'message_start',
  message: {
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
}

function thinking(index: number, text: string, signature: string) {
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index },
  ]
}

function finish(stop: string) {
  return [
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 12 } },
    },
    { type: 'message_stop' },
  ]
}

/** 思考 → 调用 `list_dir`。 */
const TOOL_TURN = sse([
  START,
  ...thinking(0, '先看目录', 'sig-tool'),
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"."}' },
  },
  { type: 'content_block_stop', index: 1 },
  ...finish('tool_use'),
])

/** 思考 → 以正文结束。 */
function textTurn(signature: string, text: string): string {
  return sse([
    START,
    ...thinking(0, '可以收尾', signature),
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    ...finish('end_turn'),
  ])
}

let script: string[] = []
const bodies: Record<string, unknown>[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push((await req.json()) as Record<string, unknown>)
    const next = script.shift()
    // 脚本耗尽时返回 401，立即终止且不重发，用例之间互不干扰。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(next, { headers: { 'content-type': 'text/event-stream' } })
  },
})

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let config: QyConfig
let workspaceId = ''
const events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-reasoning-'))
  const dbPath = join(dir, 'reasoning.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  subagents = new SubagentRegistry()
  runs = new RunManager(store, bus, subagents)
  config = {
    active: { provider: 'fake', model: 'claude-opus-5-5' },
    providers: {
      fake: {
        kind: 'anthropic_messages',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}`,
        models: { 'claude-opus-5-5': {} },
      },
    },
    mode: 'auto',
  }
  workspaceId = upsertWorkspace(store, dir, 'reasoning-ws').id
  bus.subscribe({ id: 'test', origin: 'cli', conversations: null, send: (f) => events.push(f) })
})

afterAll(async () => {
  provider.stop(true)
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function deps() {
  return { store, content, config, bus, runs, subagents }
}

async function finished(count: number): Promise<void> {
  const deadline = Date.now() + 15_000
  const done = (e: AgentEvent) => e.type === 'run.finished'
  while (Date.now() < deadline) {
    if (events.filter((f) => done(f.event)).length >= count) return
    await Bun.sleep(10)
  }
  throw new Error('run 没有按时结束')
}

type Block = Record<string, unknown>
const assistantContents = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: string | Block[] }[])
    .filter((m) => m.role === 'assistant')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) =>
            b.type === 'thinking' ? `thinking:${b.signature}` : String(b.type),
          ),
    )

test('签名思考块在同一 run 的下一轮与下一个 run 里都按原位回放', async () => {
  const cv: ConversationId = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'claude-opus-5-5',
  }).id
  script = [TOOL_TURN, textTurn('sig-text', '目录已读'), textTurn('sig-next', '好的')]

  await startRun(cv, '看看目录', undefined, deps())
  await finished(1)
  await startRun(cv, '再说一句', undefined, deps())
  await finished(2)

  expect(bodies).toHaveLength(3)
  // 同一 run 的第二次请求：工具轮带有其签名块，位于 tool_use 之前。
  expect(assistantContents(bodies[1]!)).toEqual([['thinking:sig-tool', 'tool_use']])
  // 下一个 run 的首个请求：历史从账本投影回来，两个块仍在原位。
  expect(assistantContents(bodies[2]!)).toEqual([
    ['thinking:sig-tool', 'tool_use'],
    ['thinking:sig-text', 'text'],
  ])
})

function todoTurn(signature: string, status: string): string {
  return sse([
    START,
    ...thinking(0, '更新清单', signature),
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: `toolu_${signature}`, name: 'write_todos', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ todos: [{ content: '整理目录', status }] }),
      },
    },
    { type: 'content_block_stop', index: 1 },
    ...finish('tool_use'),
  ])
}

const signatures = (body: Record<string, unknown>) =>
  assistantContents(body)
    .flat()
    .filter((b) => b.startsWith('thinking:'))

/** user 消息中的正文；带缓存断点的消息是文本块数组。 */
const userTexts = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: string | Block[] }[])
    .filter((m) => m.role === 'user')
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : m.content.filter((b) => b.type === 'text').map((b) => String(b.text)),
    )

test('待办自动继续的提示保留在历史中，其前后的签名块都不被剥离', async () => {
  bodies.length = 0
  const before = events.filter((f) => f.event.type === 'run.finished').length
  const cv: ConversationId = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'claude-opus-5-5',
  }).id
  script = [
    todoTurn('sig-a', 'in_progress'),
    // 清单未完成即收尾：守卫触发自动继续，下一次请求带有提示。
    textTurn('sig-b', '先到这里'),
    todoTurn('sig-c', 'completed'),
    textTurn('sig-d', '都做完了'),
    textTurn('sig-e', '好的'),
  ]

  await startRun(cv, '整理目录', undefined, deps())
  await finished(before + 1)
  await startRun(cv, '还有吗', undefined, deps())
  await finished(before + 2)

  expect(bodies).toHaveLength(5)
  const notice = (b: Record<string, unknown>) =>
    userTexts(b).some((t) => t.includes('本轮待办仍在进行中'))
  // 提示自自动继续的那次请求起一直保留，签名块全部保留。
  expect(notice(bodies[2]!)).toBe(true)
  expect(signatures(bodies[2]!)).toEqual(['thinking:sig-a', 'thinking:sig-b'])
  expect(notice(bodies[3]!)).toBe(true)
  expect(signatures(bodies[3]!)).toEqual(['thinking:sig-a', 'thinking:sig-b', 'thinking:sig-c'])
  // 下一个 run：提示从账本投影回原位，四个签名块全部回放。
  expect(notice(bodies[4]!)).toBe(true)
  expect(signatures(bodies[4]!)).toEqual([
    'thinking:sig-a',
    'thinking:sig-b',
    'thinking:sig-c',
    'thinking:sig-d',
  ])
})

test('受阻结束、下轮解释与明确接续都以同一份待办账本裁决', async () => {
  bodies.length = 0
  const before = events.filter((f) => f.event.type === 'run.finished').length
  const cv = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'claude-opus-5-5',
  }).id
  script = [
    todoTurn('blocked-start', 'in_progress'),
    todoTurn('blocked-pending', 'pending'),
    textTurn('blocked-reply', '页面缺少必要信息，当前无法继续。'),
    textTurn('explain', '暂停原因是缺少信息，任务仍未完成。'),
    todoTurn('resume', 'in_progress'),
    textTurn('premature', '先到这里'),
    todoTurn('done', 'completed'),
    textTurn('finished', '任务已完成'),
  ]
  await startRun(cv, '整理目录', undefined, deps())
  await finished(before + 1)
  expect(bodies).toHaveLength(3)
  expect(latestTodos(store, cv)?.[0]?.status).toBe('pending')
  const stops = () => events.filter((f) => f.event.type === 'run.finished').slice(before)
  expect(stops()[0]?.event).toMatchObject({ stopReason: 'no_progress' })

  await startRun(cv, '为什么暂停', undefined, deps())
  await finished(before + 2)
  expect(bodies).toHaveLength(4)
  expect(latestTodos(store, cv)?.[0]?.status).toBe('pending')
  expect(stops()[1]?.event).toMatchObject({ stopReason: 'completed' })

  await startRun(cv, '信息已补齐，继续完成', undefined, deps())
  await finished(before + 3)
  expect(bodies).toHaveLength(8)
  expect(userTexts(bodies[6]!).some((t) => t.includes('本轮待办仍在进行中'))).toBe(true)
  expect(latestTodos(store, cv)?.[0]?.status).toBe('completed')
  expect(stops()[2]?.event).toMatchObject({ stopReason: 'completed' })
})
