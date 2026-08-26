/**
 * 派一件的进度通道。**用假 provider 跑真链路，不花钱、不联网。**
 *
 * 覆盖范围：`delegate.ts` 的 `makeDelegate().run()` 广播出来的 `team.member`
 * ——内置分支的完整序列、终态里的子会话 id、拿不到卡片 id 时的降级、
 * 以及派不出去时不留半截状态。
 *
 * **为什么走真链路。** 这条通道的形状就是「派出去之后，卡上那一格跟着动」。
 * 把 `runBuiltinMember` 换成桩，测到的只是「桩被调用了」；真正会坏的是装配——
 * 事件带没带 stepId（不带前端整条丢弃）、终态发没发（不发那一格永远停在进行中）、
 * 子会话 id 有没有随终态出来（没有就点不开）。
 *
 * 外部 CLI 那一支这里覆盖不到：`findCli` 探测的是本机装了什么，测试环境不可控。
 * 它由真机验收。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope, RunId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { makeDelegate } from './delegate.ts'
import { RunManager } from './runs.ts'

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 一轮纯文本收尾：子 agent 说完这句就结束，产出就是它。 */
function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_text' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_text',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

/** 这次请求怎么答。用完就 401——那一档当场终结，不会让子会话自己接着转。 */
let script: (() => Response)[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text()
    const next = script.shift()
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next()
  },
})

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-delegate-'))
  const dbPath = join(dir, 'delegate.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  runs = new RunManager(store, bus)
  config = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  } as unknown as QyConfig
  workspaceId = upsertWorkspace(store, dir, 'delegate-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => events.push(frame),
  })
})

afterAll(async () => {
  provider.stop(true)
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** 每个用例一条干净的会话与一份干净的脚本。 */
function conversation(): ConversationId {
  script = []
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '派活',
  }).id
}

function delegate(conversationId: ConversationId) {
  return makeDelegate({
    deps: { store, content, config, bus, runs },
    workspaceRoot: dir,
    conversationId,
  })
}

/**
 * 广播出去的成员事件，按顺序。
 *
 * 成员类型按 `type` 收窄拿到——`@qywork/core` 刻意不逐个导出事件成员，
 * 它们只在 `AgentEvent` 这个可辨识联合里出现。
 */
type MemberEvent = Extract<AgentEvent, { type: 'team.member' }>

function members(): MemberEvent[] {
  return events.map((f) => f.event).filter((e): e is MemberEvent => e.type === 'team.member')
}

const at = { runId: 'rn_1' as RunId, stepId: 'st_1' }

describe('派一件的进度', () => {
  test('跑成时按 working → done 走，两条都挂在这张卡上', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('查完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(true)
    expect(res.output).toBe('查完了')
    expect(members().map((m) => m.phase)).toEqual(['working', 'done'])
    // 不带 stepId 的事件前端认不出是哪张卡，整条丢弃。
    expect(members().every((m) => m.stepId === 'st_1')).toBe(true)
    expect(members().every((m) => m.runId === 'rn_1')).toBe(true)
  })

  /** 子会话不进会话列表，终态里这个 id 是点开它的唯一入口。 */
  test('终态带着子会话 id', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('看完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '看一眼',
      ...at,
      signal: new AbortController().signal,
    })

    const done = members().at(-1)
    expect(done?.phase).toBe('done')
    expect(done?.childConversationId).toBe(res.conversationId as ConversationId)
    expect(done?.childConversationId).toBeTruthy()
  })

  /**
   * 没做成也必须落终态。**这是原始失败形状**：不发的话卡上那一格停在「进行中」，
   * 而这一轮早就结束了——用户看到的是一个永远转下去的格子。
   */
  test('没做成时落 failed，不是停在 working', async () => {
    const cid = conversation()
    // 脚本空着 = 401，子会话当场终结。
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(false)
    expect(members().map((m) => m.phase)).toEqual(['working', 'failed'])
  })

  /** 中断走的也是终态那条路：用户点停止之后，那一格不能还转着。 */
  test('中断时也落 failed', async () => {
    const cid = conversation()
    const ctl = new AbortController()
    ctl.abort()
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      ...at,
      signal: ctl.signal,
    })

    expect(res.ok).toBe(false)
    expect(members().map((m) => m.phase)).toEqual(['working', 'failed'])
  })

  /**
   * 拿不到卡片 id 时整条不发。发出去也没有卡片认领它（前端按 stepId 找），
   * 只是白广播——而派活本身照跑，形状与终态都不依赖这条通道。
   */
  test('没有卡片 id 时一条都不发，活照派', async () => {
    const cid = conversation()
    script = [() => new Response(textTurn('查完了'), { headers: SSE_HEADERS })]
    const res = await delegate(cid).run({
      target: '',
      task: '去查一下',
      runId: 'rn_2' as RunId,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(true)
    expect(members()).toHaveLength(0)
  })

  /** 派不出去就不该在图上留一个跑着的格子——那一格从头到尾没人在跑。 */
  test('目标不存在时不发任何进度', async () => {
    const cid = conversation()
    const res = await delegate(cid).run({
      target: '查无此角色',
      task: '执行任务',
      ...at,
      signal: new AbortController().signal,
    })

    expect(res.ok).toBe(false)
    expect(members()).toHaveLength(0)
  })
})
