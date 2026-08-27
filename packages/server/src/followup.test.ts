/**
 * 跟进消息（排队 / 注入）的端到端回归。**用假 provider，不花钱、不联网。**
 *
 * **覆盖范围**：`runs.ts` 的队列（入队幂等、翻转、删除、取走、复位）、
 * `commands.ts` 的 `message.send` 忙闲裁决与两条 `followup.*` 分支、
 * `run-control.ts` 收尾时的火发与它同目标续起的优先级、
 * `agent/loop.ts` 在 step 边界的注入，以及 `runtime/transcript.ts` 把那条
 * `kind='user'` 的 step 投影回历史。
 *
 * **为什么必须走真链路。** 这个功能的形状是「一轮跑到一半，模型下一次请求里
 * 多了一句用户的话」。把 loop 换成桩来测，测到的只是「桩被调用了」——真正会坏的
 * 是装配：那句话有没有进请求、进在哪个位置、下一轮从账本投影回来还在不在原位。
 * 假 provider 把每次请求的原始 body 都留了下来，前缀断言直接量它。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { buildHistory, type QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createGoal,
  currentGoal,
  listMessages,
  listRuns,
  listSteps,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function usage() {
  return { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
}

/** 一轮工具调用。用 `list_dir` —— 只读、不改工作区、参数简单。 */
function toolTurn(callId: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_tool' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: callId, name: 'list_dir' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      delta: JSON.stringify({ path: '.' }),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: { id: 'resp_tool', status: 'completed', usage: usage() },
    },
  ])
}

/** 一轮纯文本收尾。 */
function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_text' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: { id: 'resp_text', status: 'completed', usage: usage() },
    },
  ])
}

type Turn = (body: string) => Response | Promise<Response>

let script: Turn[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    const next = script.shift()
    // 脚本用完 = 401（`auth_failed`，当场终结且不重发）。理由与 goal-loop 那份相同：
    // 一句正常收尾的文本会让服务端接着起下一轮，用例之间就串了。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next(body)
  },
})

const ok =
  (payload: string): Turn =>
  () =>
    new Response(payload, { headers: SSE_HEADERS })

/** 挂住这一轮，直到用例主动放行。用来制造「会话正在跑」。 */
function gate(payload: string): { turn: Turn; release: () => void } {
  let release = (): void => {}
  const turn: Turn = () =>
    new Promise<Response>((resolve) => {
      release = () => resolve(new Response(payload, { headers: SSE_HEADERS }))
    })
  return { turn, release: () => release() }
}

// ───────────────────────── 装配 ─────────────────────────

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-followup-'))
  const dbPath = join(dir, 'followup.sqlite3')
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
  }
  workspaceId = upsertWorkspace(store, dir, 'followup-ws').id
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

function deps() {
  return { store, content, config, bus, runs }
}

/** 收到指令的假连接：只记回执，不真的开 socket。 */
function socket() {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    ws: {
      data: { authed: true, id: 'c1', origin: 'cli' },
      send: (raw: string) => sent.push(JSON.parse(raw)),
    } as never,
  }
}

function conversation(): ConversationId {
  script = []
  bodies = []
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  }).id
}

async function waitFor(what: (e: AgentEvent) => boolean, ms = 10_000): Promise<AgentEvent | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = events.find((f) => what(f.event))
    if (hit) return hit.event
    await Bun.sleep(10)
  }
  return null
}

/** 等到这条会话真的闲下来（收尾 + 火发那一拍 setTimeout(0) 都过去）。 */
async function idle(cv: ConversationId, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!runs.isBusy(cv)) {
      await Bun.sleep(60)
      if (!runs.isBusy(cv)) return
    }
    await Bun.sleep(10)
  }
}

/** 排队与火发都是 setTimeout(0)，多等几拍确认**没有**下一轮起来。 */
async function settle(): Promise<void> {
  await Bun.sleep(160)
}

/** 请求 body 里发给模型的消息串。前缀断言按它逐条比。 */
function sentMessages(body: string): { role: string; content: unknown }[] {
  const parsed = JSON.parse(body) as { input?: { role?: string; content?: unknown }[] }
  return (parsed.input ?? []).map((m) => ({ role: m.role ?? '', content: m.content }))
}

// ───────────────────────── 用例 ─────────────────────────

describe('会话在跑时发消息', () => {
  test('不回绝，排进队列，且一个字都不落盘', async () => {
    const cv = conversation()
    const held = gate(textTurn('第一轮做完了。'))
    script = [held.turn]
    const sock = socket()
    try {
      void startRun(cv, '第一句', undefined, deps())
      await waitFor((e) => e.type === 'run.started')

      await handleCommand(
        {
          type: 'message.send',
          clientRequestId: 'req-1',
          conversationId: cv,
          content: '排着的那一句',
        } as never,
        { ...deps(), ws: sock.ws },
      )

      // 没有回绝：既没有 run.error，也没有指令回执。
      expect(sock.sent).toEqual([])
      expect(events.some((f) => f.event.type === 'run.error')).toBe(false)
      expect(runs.queueOf(cv).map((f) => f.content)).toEqual(['排着的那一句'])
      // 队列不落盘：账本里只有发起这一轮的那条消息。
      expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句'])
      // 卡片的唯一实时来源。
      expect(events.some((f) => f.event.type === 'queue.changed')).toBe(true)
    } finally {
      held.release()
      await idle(cv)
    }
  }, 20_000)

  test('同一个 clientRequestId 重发不会排出两条', async () => {
    const cv = conversation()
    const held = gate(textTurn('好了。'))
    script = [held.turn]
    const sock = socket()
    try {
      void startRun(cv, '第一句', undefined, deps())
      await waitFor((e) => e.type === 'run.started')
      const cmd = {
        type: 'message.send',
        clientRequestId: 'same-key',
        conversationId: cv,
        content: '只该有一条',
      } as never
      await handleCommand(cmd, { ...deps(), ws: sock.ws })
      await handleCommand(cmd, { ...deps(), ws: sock.ws })
      expect(runs.queueOf(cv)).toHaveLength(1)
    } finally {
      held.release()
      await idle(cv)
    }
  }, 20_000)
})

describe('收尾之后的火发', () => {
  test('正常收尾自动起下一轮，正文就是排着的那一句', async () => {
    const cv = conversation()
    const held = gate(textTurn('第一轮做完了。'))
    script = [held.turn, ok(textTurn('第二轮也做完了。'))]
    const sock = socket()
    void startRun(cv, '第一句', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-q',
        conversationId: cv,
        content: '跑完再说这句',
      } as never,
      { ...deps(), ws: sock.ws },
    )
    held.release()

    await idle(cv)
    // 两条消息、两轮，顺序就是用户发的顺序。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '跑完再说这句'])
    expect(listRuns(store, cv)).toHaveLength(2)
    expect(runs.queueOf(cv)).toEqual([])
  }, 30_000)

  test('中断收尾不火发，条目留在队列且去向复位', async () => {
    const cv = conversation()
    const held = gate(textTurn('不会用到。'))
    script = [held.turn]
    const sock = socket()
    void startRun(cv, '第一句', undefined, deps())
    const started = await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-s',
        conversationId: cv,
        content: '想插一句',
        steer: true,
      } as never,
      { ...deps(), ws: sock.ws },
    )
    expect(runs.queueOf(cv)[0]?.steer).toBe(true)

    runs.interrupt((started as { runId: string }).runId as never)
    held.release()
    await idle(cv)
    await settle()

    // 不自动起下一轮。
    expect(listRuns(store, cv)).toHaveLength(1)
    // 条目还在，但「调整方向」只对发出它的那一轮成立，收尾即复位。
    expect(runs.queueOf(cv)).toHaveLength(1)
    expect(runs.queueOf(cv)[0]?.steer).toBe(false)
  }, 30_000)

  test('队列压过目标续起，但目标的收尾照走', async () => {
    const cv = conversation()
    const seeded = createGoal(store, { conversationId: cv, objective: '把活干完' })
    if (!seeded.ok) throw new Error(seeded.message)
    const live = seeded.goal
    runs.arm(cv, { goalId: live.id, revision: live.revision })

    const held = gate(textTurn('这一轮完了。'))
    script = [held.turn, ok(textTurn('跟进那一轮也完了。'))]
    const sock = socket()
    void startRun(cv, '第一句', undefined, deps(), undefined, {
      goalId: live.id,
      revision: live.revision,
    })
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-p',
        conversationId: cv,
        content: '人插的这一句',
      } as never,
      { ...deps(), ws: sock.ws },
    )
    held.release()
    await idle(cv)

    // 起的是队列那一轮（人类消息优先），不是目标续起那一轮。
    const messages = listMessages(store, cv).map((m) => m.content)
    expect(messages).toEqual(['第一句', '人插的这一句'])
    // 目标本身不受这次跳过影响：标记由那次 startRun 清掉（人类消息优先）。
    expect(runs.armedOf(cv)).toBeNull()
    expect(currentGoal(store, cv)?.status).toBe('active')
  }, 30_000)
})

describe('注入当前这一轮', () => {
  /**
   * 这条是整个功能最要紧的一条：注入之后那一次请求，必须是上一次请求的
   * **逐条前缀 + 新增的那几条**。不成立就说明注入插错了位置，
   * 缓存前缀在那里断掉，而这件事不会有任何报错。
   */
  test('在下一个 step 边界进请求，且不破坏前缀', async () => {
    const cv = conversation()
    const held = gate(toolTurn('call_1'))
    script = [held.turn, ok(textTurn('按你说的改了。'))]
    const sock = socket()

    void startRun(cv, '先看看目录', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-i',
        conversationId: cv,
        content: '改主意了，只列文件名',
        steer: true,
      } as never,
      { ...deps(), ws: sock.ws },
    )
    held.release()
    await idle(cv)

    expect(bodies).toHaveLength(2)
    const first = sentMessages(bodies[0] ?? '')
    const second = sentMessages(bodies[1] ?? '')

    // 注入的那句话进了第二次请求。
    expect(JSON.stringify(second)).toContain('改主意了，只列文件名')
    expect(JSON.stringify(first)).not.toContain('改主意了')

    /*
     * 逐条前缀。**尾区注记那一条要去掉再比**：它恒在最后一条，每轮都变，
     * 本来就不是前缀的一部分（`agent/loop.ts` 的装配顺序注释）。
     */
    const firstBody = first.slice(0, -1)
    expect(second.slice(0, firstBody.length)).toEqual(firstBody)

    // 注入消息落成一条 kind='user' 的 step，开即终态。
    const run = listRuns(store, cv)[0]
    const injected = listSteps(store, run?.id ?? ('' as never)).filter((s) => s.kind === 'user')
    expect(injected).toHaveLength(1)
    expect(injected[0]?.content).toBe('改主意了，只列文件名')
    expect(injected[0]?.status).toBe('done')
    // 队列里不再有它，事件带着 stepId 与卡片 id。
    expect(runs.queueOf(cv)).toEqual([])
    const ev = events.find((f) => f.event.type === 'message.injected')?.event
    expect(ev && 'stepId' in ev && ev.stepId).toBe(injected[0]?.id)
    expect(ev && 'followUpId' in ev && ev.followUpId).toBe('req-i')
  }, 30_000)

  /**
   * 跨 run 同形：注入那条在回放里必须仍然夹在两波工具之间，
   * 而不是被排到整个 run 的全部步骤之后。
   *
   * 用例特意让注入之后**再跑一波工具**：只有这样两种设计才区分得开——
   * 落 `messages` 表的话回放会把它挪到最后（`buildHistory` 的骨架按 message id
   * 排、每条后面挂整轮 steps），落 steps 表才留在原位。
   */
  test('下一轮从账本投影回来，仍夹在两波工具中间', async () => {
    const cv = conversation()
    const held = gate(toolTurn('call_a'))
    script = [held.turn, ok(toolTurn('call_b')), ok(textTurn('好。'))]
    const sock = socket()

    void startRun(cv, '看看目录', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-h',
        conversationId: cv,
        content: '顺带说一句',
        steer: true,
      } as never,
      { ...deps(), ws: sock.ws },
    )
    held.release()
    await idle(cv)

    const history = await buildHistory(store, cv, null, async (text) => text)
    const at = (pred: (m: (typeof history)[number]) => boolean) => history.findIndex(pred)
    const injected = at((m) => m.role === 'user' && m.content === '顺带说一句')
    const firstTool = at((m) => m.role === 'tool' && m.toolCallId === 'call_a')
    const secondTool = at((m) => m.role === 'tool' && m.toolCallId === 'call_b')

    expect(injected).toBeGreaterThan(firstTool)
    expect(firstTool).toBeGreaterThanOrEqual(0)
    // 关键的一条：它在第二波工具**之前**。排到最后就说明落错了表。
    expect(secondTool).toBeGreaterThan(injected)
  }, 30_000)

  test('标了调整方向却没赶上边界，收尾后降级为火发下一轮', async () => {
    const cv = conversation()
    const held = gate(textTurn('这一轮直接收尾。'))
    script = [held.turn, ok(textTurn('降级那一轮。'))]
    const sock = socket()

    void startRun(cv, '第一句', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-l',
        conversationId: cv,
        content: '来不及注入的一句',
        steer: true,
      } as never,
      { ...deps(), ws: sock.ws },
    )
    held.release()
    await idle(cv)

    // 没有被静默丢掉：它成了下一轮。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '来不及注入的一句'])
  }, 30_000)
})

describe('卡片上的两个可点物', () => {
  test('翻转去向；会话空闲时同一条指令当场起一轮', async () => {
    const cv = conversation()
    const held = gate(textTurn('第一轮完。'))
    script = [held.turn, ok(textTurn('被点发送那一轮。'))]
    const sock = socket()

    void startRun(cv, '第一句', undefined, deps())
    const started = await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-t',
        conversationId: cv,
        content: '待定的一句',
      } as never,
      { ...deps(), ws: sock.ws },
    )
    // 在跑：翻转，仍留在队列里。
    await handleCommand(
      { type: 'followup.steer', conversationId: cv, id: 'req-t', steer: true } as never,
      { ...deps(), ws: sock.ws },
    )
    expect(runs.queueOf(cv)[0]?.steer).toBe(true)

    // 中断掉这一轮，让会话闲下来且不火发。
    runs.interrupt((started as { runId: string }).runId as never)
    held.release()
    await idle(cv)
    expect(runs.queueOf(cv)).toHaveLength(1)

    // 空闲：同一条指令的语义换成「现在就发」。
    await handleCommand(
      { type: 'followup.steer', conversationId: cv, id: 'req-t', steer: true } as never,
      { ...deps(), ws: sock.ws },
    )
    await idle(cv)
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '待定的一句'])
    expect(runs.queueOf(cv)).toEqual([])
  }, 30_000)

  test('删掉的条目既不注入也不火发；删不掉时如实回绝', async () => {
    const cv = conversation()
    const held = gate(textTurn('第一轮完。'))
    script = [held.turn]
    const sock = socket()

    void startRun(cv, '第一句', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-d',
        conversationId: cv,
        content: '要被删的一句',
      } as never,
      { ...deps(), ws: sock.ws },
    )
    await handleCommand({ type: 'followup.drop', conversationId: cv, id: 'req-d' } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(runs.queueOf(cv)).toEqual([])

    // 再删一次：明确回绝，不静默成功——「点了删除、卡片还在」和
    // 「服务端没收到」在界面上分不出来。
    await handleCommand({ type: 'followup.drop', conversationId: cv, id: 'req-d' } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(sock.sent.at(-1)).toMatchObject({ type: 'command.rejected', reason: 'conflict' })

    held.release()
    await idle(cv)
    await settle()
    // 删掉之后不该有第二轮。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句'])
  }, 30_000)
})
