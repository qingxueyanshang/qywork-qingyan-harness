/**
 * 目标自动续起的端到端回归。**用假 provider，不花钱、不联网。**
 *
 * **覆盖范围**：`run-control.ts` 的续起判定（`startRun` 的 finally、排队、
 * 陈旧拒绝、停下的三条出口）与 `runs.ts` 的待续起标记。
 * 目标本身的生命周期规则在 `store/goals.test.ts`，工具那一层在 `tools/goals.test.ts`。
 *
 * ## 为什么必须走真链路
 *
 * 这个功能的形状就是「一轮结束之后**自己**又起了一轮」。把 `startRun` 换成
 * 桩来测，测到的只是「我调了我自己写的那个函数」——真正会坏的是装配：
 * 目标事件到没到得了 run-control、finally 里读到的 stopReason 对不对、
 * 下一轮的用户消息里究竟写了什么。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createGoal,
  currentGoal,
  Store,
  updateGoal,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { resumeGoal, startRun } from './run-control.ts'
import { RunManager } from './runs.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

/** 一轮工具调用。 */
function toolTurn(name: string, args: unknown): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_tool' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: `call_${name}`, name },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      delta: JSON.stringify(args),
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

function usage() {
  return { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
}

/** 这次请求怎么答。返回 null = 按脚本已经走完，给一句无害的文本收尾。 */
type Turn = (body: string) => Response | Promise<Response>

let script: Turn[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    const next = script.shift()
    if (!next) return new Response(textTurn('脚本外的一轮'), { headers: SSE_HEADERS })
    return next(body)
  },
})

const ok =
  (payload: string): Turn =>
  () =>
    new Response(payload, { headers: SSE_HEADERS })

// ───────────────────────── 装配 ─────────────────────────

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let config: QyConfig
let workspaceId = ''

/** 收到的全部事件，按顺序。断言与等待都读它。 */
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-goal-'))
  const dbPath = join(dir, 'goal.sqlite3')
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
  workspaceId = upsertWorkspace(store, dir, 'goal-ws').id
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

/** 每个用例一条干净的会话与一份干净的脚本。 */
function conversation(): ConversationId {
  script = []
  bodies = []
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
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

/** 排队是 setTimeout(0)，多等几拍确认**没有**下一轮起来。 */
async function settle(): Promise<void> {
  await Bun.sleep(120)
}

/**
 * 直接往账本里立一个目标并挂上待续起标记 —— 模拟「循环正开着」。
 *
 * 用真链路跑到那一步也可以，但那样每个用例都得先演一遍立目标的两轮对话，
 * 而且脚本一用完模型就会一直被续起到跑满轮数，断言全成了赛跑。
 */
function seed(cv: ConversationId, maxRounds: number) {
  const r = createGoal(store, { conversationId: cv, objective: '慢慢做这件事', maxRounds })
  if (!r.ok) throw new Error(r.message)
  runs.arm(cv, { goalId: r.goal.id, revision: r.goal.revision })
  return r.goal
}

// ───────────────────────── 用例 ─────────────────────────

describe('一轮接一轮', () => {
  /**
   * 原始缺口：`loop.ts` 的 step 循环是 **run 内**的，一轮跑完就真的结束了，
   * 没有任何代码会自动再起一轮。这条用例直接复现那个形状——
   * 模型只在第一轮里立了目标，第二轮的请求必须由服务端自己发出来。
   */
  test('立了目标就会自己起下一轮，做完就停', async () => {
    const cv = conversation()
    script = [
      ok(toolTurn('create_goal', { objective: '把 calc 修好', max_rounds: 2 })),
      ok(textTurn('目标已立，先看一眼代码。')),
      // 第二轮：模型这次读到的 goal_id / revision 是真的，所以拿账本里的值来答。
      (body) => {
        const goal = currentGoal(store, cv)
        expect(body).toContain('[自动续起] 第 1/2 轮')
        expect(body).toContain('把 calc 修好')
        return new Response(
          toolTurn('update_goal', {
            goal_id: goal?.id,
            revision: goal?.revision,
            action: 'complete',
          }),
          { headers: SSE_HEADERS },
        )
      },
      ok(textTurn('修好了，测试全绿。')),
    ]

    await startRun(cv, '把 calc 修好，跑到测试全绿', undefined, deps())
    const done = await waitFor((e) => e.type === 'goal' && e.goal.status === 'completed')
    expect(done).not.toBeNull()

    await settle()
    const goal = currentGoal(store, cv)
    expect(goal?.status).toBe('completed')
    // 一轮自动续起 = 两次 run，每次两个请求。第三轮不该存在。
    expect(bodies).toHaveLength(4)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /** 轮数是唯一的护栏，撞上了要**说得出为什么**，不能只留两个字。 */
  test('跑满轮数就 blocked，理由里带着轮数', async () => {
    const cv = conversation()
    script = [
      ok(toolTurn('create_goal', { objective: '一件做不完的事', max_rounds: 1 })),
      ok(textTurn('先做一点。')),
      ok(textTurn('还没做完。')),
    ]

    await startRun(cv, '开始吧', undefined, deps())
    const blocked = await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    expect(blocked).not.toBeNull()

    await settle()
    const goal = currentGoal(store, cv)
    expect(goal?.round).toBe(1)
    expect(goal?.blockedCode).toBe('max_rounds')
    expect(goal?.blockedReason).toContain('1 轮')
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)
})

describe('四条防跑飞', () => {
  /**
   * 人类消息优先。原始失败形状：用户插一句话，而排着的那次自动续起照样发出去，
   * 于是模型手上同时有两条互相打架的指令。
   */
  test('用户发消息就把待续起标记清掉，且不占轮数', async () => {
    const cv = conversation()
    // 目标直接落账本、标记手工挂上：这条用例要验的是「人一说话会怎样」，
    // 前面那段怎么进入循环由别的用例覆盖。
    expect(seed(cv, 5).round).toBe(0)

    script = [ok(textTurn('收到。'))]
    await startRun(cv, '先停一下，看看这个', undefined, deps())
    // 同步就该清掉：清得晚一点，中间那次排队照样会发出去。
    expect(runs.armedOf(cv)).toBeNull()

    await waitFor((e) => e.type === 'run.finished')
    await settle()
    // 人类那一轮之后没有再自动起轮，轮数也没涨。
    expect(bodies).toHaveLength(1)
    expect(currentGoal(store, cv)?.round).toBe(0)
  }, 20_000)

  /**
   * 轮次预留 + 陈旧拒绝。排队时记下 {goalId, revision}，真正发起前重读——
   * 版本变了就丢弃这次排队，**且不增加轮数**。
   */
  test('排队期间目标被改过，这次排队作废且不计轮数', async () => {
    const cv = conversation()
    const goal = seed(cv, 5)

    // 排队之后、发起之前，目标被改了一次（另一端改写，或者模型自己改的）。
    expect(resumeGoal(cv, deps())).toEqual({ ok: true })
    const edited = updateGoal(store, {
      conversationId: cv,
      goalId: goal.id,
      revision: goal.revision,
      action: 'edit',
      objective: '改成另一件事',
    })
    expect(edited.ok).toBe(true)

    await settle()
    // 一个请求都没发出去，轮数也没动——按几秒前的版本继续跑，跑的就不是这件事了。
    expect(bodies).toHaveLength(0)
    expect(currentGoal(store, cv)?.round).toBe(0)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /**
   * 不自动重试异常。**provider 的错不会抛出 `session.ask`**，它被就地转成
   * `run.finished{stopReason:'provider_error'}`——只认异常的话，一次故障会被
   * 判成「正常跑完」然后接着续起，把一次失败放大成一串。
   */
  test('provider 报错之后停在 blocked，不再自动重试', async () => {
    const cv = conversation()
    script = [
      ok(toolTurn('create_goal', { objective: '会撞上报错的目标', max_rounds: 5 })),
      ok(textTurn('好。')),
      () => new Response('boom', { status: 500 }),
    ]

    await startRun(cv, '开始', undefined, deps())
    const blocked = await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    expect(blocked).not.toBeNull()

    await settle()
    const goal = currentGoal(store, cv)
    expect(goal?.status).toBe('blocked')
    expect(goal?.blockedCode).toBe('provider_error')
    expect(goal?.blockedReason).toBeTruthy()
    expect(runs.armedOf(cv)).toBeNull()
    // 报错那一轮之后一个请求都不该再发。
    const after = bodies.length
    await settle()
    expect(bodies.length).toBe(after)
  }, 20_000)

  /** 取消之后暂停，不自动重启。 */
  test('中断这一轮 = 目标转 paused 并解除标记', async () => {
    const cv = conversation()
    // 挂在对象上而不是裸 `let`：赋值发生在回调里，TS 的控制流分析看不见它，
    // 裸变量在 finally 那一行会被窄化成 `never`。
    const hang: { release: (() => void) | null } = { release: null }
    script = [
      ok(toolTurn('create_goal', { objective: '会被中断的目标', max_rounds: 5 })),
      () =>
        new Promise<Response>((resolve) => {
          hang.release = () =>
            resolve(new Response(textTurn('迟到的回答'), { headers: SSE_HEADERS }))
        }),
    ]

    try {
      await startRun(cv, '开始', undefined, deps())
      await waitFor((e) => e.type === 'goal' && e.goal.status === 'active')
      const started = await waitFor((e) => e.type === 'run.started')
      expect(started).not.toBeNull()
      expect(runs.armedOf(cv)).not.toBeNull()

      runs.interrupt((started as { runId: string }).runId as never)
      const paused = await waitFor((e) => e.type === 'goal' && e.goal.status === 'paused')
      expect(paused).not.toBeNull()
      expect(runs.armedOf(cv)).toBeNull()

      await settle()
      expect(currentGoal(store, cv)?.status).toBe('paused')
    } finally {
      hang.release?.()
    }
  }, 20_000)
})

describe('用户点继续', () => {
  /**
   * resume **自己发起一轮**，不能等下一次别的 run 收尾——那时候用户已经等了
   * 不知道多久，而界面上什么都没发生。
   */
  test('resume 把目标转回 active 并当场起一轮', async () => {
    const cv = conversation()
    // 上限设 1：这一轮跑完循环自己就停了，用例不会在后台一直转。
    const goal = seed(cv, 1)
    const paused = updateGoal(store, {
      conversationId: cv,
      goalId: goal.id,
      revision: goal.revision,
      action: 'pause',
    })
    expect(paused.ok).toBe(true)
    runs.disarm(cv)

    script = [ok(textTurn('接着做。'))]
    expect(resumeGoal(cv, deps())).toEqual({ ok: true })

    await waitFor((e) => e.type === 'run.finished')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('[自动续起] 第 1/1 轮')
    expect(currentGoal(store, cv)?.round).toBe(1)
  }, 20_000)

  test('会话正忙时回绝，不排第二轮进去', () => {
    const cv = conversation()
    runs.reserve(cv)
    const r = resumeGoal(cv, deps())
    expect(r.ok).toBe(false)
    runs.release(cv)
  })

  test('没有目标时说清楚是没有目标', () => {
    const cv = conversation()
    const r = resumeGoal(cv, deps())
    expect(r).toEqual({ ok: false, message: '这条会话没有目标' })
  })
})
