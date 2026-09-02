/**
 * 目标自动续起的端到端回归。**用假 provider，不花钱、不联网。**
 *
 * **覆盖范围**：`run-control.ts` 的续起判定（`startRun` 的 finally、排队、
 * 陈旧拒绝、停下的三条出口）、用户立目标那条路（`setGoal`）、`commands.ts` 的
 * `goal.set` 分支、`runs.ts` 的待续起标记，以及 `runtime/session.ts` 把
 * `run.error` 的正文写进 run 行那一手（这里有现成的真链路 + 会失败的假 provider）。
 * 目标本身的生命周期规则在 `store/goals.test.ts`，工具那一层在 `tools/goals.test.ts`。
 *
 * **为什么必须走真链路。** 这个功能的形状就是「一轮结束之后**自己**又起了一轮」。把 `startRun` 换成
 * 桩来测，测到的只是「桩被调用了」——真正会坏的是装配：
 * 目标事件到没到得了 run-control、finally 里读到的 stopReason 对不对、
 * 下一轮的用户消息里写了什么。
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
  listRuns,
  Store,
  updateGoal,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import { resumeGoal, setGoal, startRun } from './run-control.ts'
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

/** 这次请求怎么答。 */
type Turn = (body: string) => Response | Promise<Response>

let script: Turn[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    const next = script.shift()
    /*
     * **脚本用完 = 401，不是再给一句无害的文本。**
     *
     * 循环没有轮数上限，而一句正常收尾的文本会让服务端接着起下一轮——脚本一空，
     * 那条会话就在后台持续转下去，占用后面用例的脚本，断言全成赛跑。
     * 401 判成 `auth_failed`，是个**当场终结**的答复（不在 `CONTINUABLE` 里）→
     * 目标转 blocked → 循环停下。用例要多跑几轮就多写几条脚本。
     *
     * 不要换成 5xx 或 400：那一档归 `provider_unavailable`，agent 循环会退避后
     * 自动重发一次，因此脚本用完还会再打一次请求，`bodies` 平白多一条。
     */
    if (!next) return new Response('脚本已用完', { status: 401 })
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

/** 排队是 setTimeout(0)，多等几拍确认**没有**下一轮起来。 */
async function settle(): Promise<void> {
  await Bun.sleep(120)
}

/**
 * 直接往账本里立一个目标并挂上待续起标记 —— 模拟「循环正开着」。
 *
 * 用真链路跑到那一步也可以，但那样每个用例都得先演一遍立目标的两轮对话。
 * 注意循环**没有轮数上限**：用例必须自己把它收掉（模型 complete / blocked，
 * 或制造一次非正常收尾），否则脚本一用完它会持续续起，占用后面用例的脚本。
 */
function seed(cv: ConversationId) {
  const r = createGoal(store, { conversationId: cv, objective: '慢慢做这件事' })
  if (!r.ok) throw new Error(r.message)
  runs.arm(cv, { goalId: r.goal.id, revision: r.goal.revision })
  return r.goal
}

/**
 * 立目标并**当场起第一轮** —— 用户 `/goal` 那条路。
 *
 * 直接落账本再走 `resumeGoal`（与 `setGoal` 收尾同一个排队入口），
 * 这样用例可以精确控制起点，不必先演一遍指令分发。
 */
function startLoop(cv: ConversationId) {
  const goal = seed(cv)
  const r = resumeGoal(cv, deps())
  if (!r.ok) throw new Error(r.message)
  return goal
}

// ───────────────────────── 用例 ─────────────────────────

describe('一轮接一轮', () => {
  /**
   * 原始缺口：`loop.ts` 的 step 循环是 **run 内**的，一轮跑完就真的结束了，
   * 没有任何代码会自动再起一轮。这条走的是**用户 `/goal` 那条真入口**——
   * 立目标当场起第一轮，第二轮的请求必须由服务端自己发出来。
   *
   */
  test('用户立目标 → 当场起一轮 → 自己续下一轮 → 模型宣布完成就停', async () => {
    const cv = conversation()
    script = [
      (body) => {
        expect(body).toContain('[自动续起]')
        expect(body).toContain('把 calc 修好')
        return new Response(textTurn('先看一眼代码。'), { headers: SSE_HEADERS })
      },
      // 第二轮：模型这次读到的 goal_id / revision 是真的，所以拿账本里的值来答。
      (body) => {
        const goal = currentGoal(store, cv)
        expect(body).toContain('[自动续起]')
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

    const set = setGoal(cv, '把 calc 修好，跑到测试全绿', deps())
    expect(set.ok).toBe(true)
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'active')

    const done = await waitFor((e) => e.type === 'goal' && e.goal.status === 'completed')
    expect(done).not.toBeNull()

    await settle()
    const goal = currentGoal(store, cv)
    expect(goal?.status).toBe('completed')
    expect(goal?.objective).toContain('把 calc 修好')
    // 两轮 = 三个请求（第一轮一个、第二轮工具调用加收尾）。第三轮不该存在。
    expect(bodies).toHaveLength(3)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /**
   * 同一条会话再 `/goal` 一次 = **改写现在这个**，不是并排立第二个。
   *
   * 起点是一个模型自己宣布受阻的目标：那之后循环停着、没有 run 在跑，
   * 正是用户会再敲一次 `/goal` 的那一刻。
   */
  test('对着停下的目标再 /goal 一次 —— 改写正文并接着跑，不新开一个', async () => {
    const cv = conversation()
    script = [
      () => {
        const g = currentGoal(store, cv)
        return new Response(
          toolTurn('update_goal', {
            goal_id: g?.id,
            revision: g?.revision,
            action: 'blocked',
            blocked_reason: '缺依赖',
          }),
          { headers: SSE_HEADERS },
        )
      },
      ok(textTurn('先停在这。')),
    ]

    const first = startLoop(cv)
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    await settle()

    // 改写之后那一轮的脚本与请求单独看：验的是「新指令真的被跑了」。
    script = [ok(textTurn('换个方向做。'))]
    bodies = []
    events = []
    expect(setGoal(cv, '改成做乙', deps()).ok).toBe(true)
    // 那一轮跑完脚本就空了，下一轮 500 收尾——循环不会留在后台转。
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    await settle()

    const second = currentGoal(store, cv)
    // 同一个目标改了正文，不是并排立了第二个——账本里一条会话只有一个目标。
    expect(second?.id).toBe(first.id)
    expect(second?.objective).toBe('改成做乙')
    // 改写之后循环真的接着跑了，跑的是新指令。
    expect(bodies[0]).toContain('改成做乙')
  }, 20_000)

  /** 有一轮在跑的时候不许改目标——那等于中途换掉它正在执行的指令。 */
  test('正在跑的时候拒绝立目标，且说得出为什么', async () => {
    const cv = conversation()
    const hang: { release: (() => void) | null } = { release: null }
    script = [
      () =>
        new Promise<Response>((resolve) => {
          hang.release = () => resolve(new Response(textTurn('迟到'), { headers: SSE_HEADERS }))
        }),
    ]
    try {
      await startRun(cv, '先干点别的', undefined, deps())
      await waitFor((e) => e.type === 'run.started')
      const r = setGoal(cv, '插进来的目标', deps())
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.message).toContain('已有任务在执行')
      expect(currentGoal(store, cv)).toBeNull()
    } finally {
      hang.release?.()
    }
  }, 20_000)

  /**
   * **循环不会自己停。** 没有轮数上限：模型不宣布收尾，它就一轮接一轮跑下去。
   *
   * 这条锁的是那个决定本身。反过来说也是这条用例的价值——哪天有人给循环加回
   * 一个静默的配额，这里会立刻红。收尾靠中断，不靠等它自己累死。
   */
  test('模型不收尾就一直续起，不存在自动上限', async () => {
    const cv = conversation()
    const ROUNDS = 5
    // 状态在**每一轮里面**取：跑完再取是赛跑——脚本一耗尽下一轮立刻 500 转 blocked。
    const seen: (string | undefined)[] = []
    script = Array.from({ length: ROUNDS }, (_, i) => () => {
      seen.push(currentGoal(store, cv)?.status)
      return new Response(textTurn(`第 ${i + 1} 次：还没做完。`), { headers: SSE_HEADERS })
    })

    startLoop(cv)
    // 收尾靠脚本耗尽（500 → blocked），不是靠等它自己累死。
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    await settle()

    // 五轮全都在目标 active 的状态下跑掉了——旧世界默认 12 轮，这里没有那个数。
    expect(seen).toEqual(Array(ROUNDS).fill('active'))
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)
})

describe('四条防失控', () => {
  /**
   * 人类消息优先。原始失败形状：用户插一句话，而排着的那次自动续起照样发出去，
   * 因此模型手上同时有两条互相打架的指令。
   */
  test('用户发消息就把待续起标记清掉', async () => {
    const cv = conversation()
    // 目标直接落账本、标记手工挂上：这条用例要验的是「人一说话会怎样」，
    // 前面那段怎么进入循环由别的用例覆盖。
    expect(seed(cv).status).toBe('active')

    script = [ok(textTurn('收到。'))]
    await startRun(cv, '先停一下，看看这个', undefined, deps())
    // 同步就该清掉：清得晚一点，中间那次排队照样会发出去。
    expect(runs.armedOf(cv)).toBeNull()

    await waitFor((e) => e.type === 'run.finished')
    await settle()
    // 人类那一轮之后没有再自动起轮。
    expect(bodies).toHaveLength(1)
    expect(currentGoal(store, cv)?.status).toBe('active')
  }, 20_000)

  /**
   * 预留 + 陈旧拒绝。排队时记下 {goalId, revision}，真正发起前重读——
   * 版本变了就丢弃这次排队。
   */
  test('排队期间目标被改过，这次排队作废', async () => {
    const cv = conversation()
    const goal = seed(cv)

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
    // 一个请求都没发出去——按几秒前的版本继续跑，跑的就不是这件事了。
    expect(bodies).toHaveLength(0)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /**
   * 不自动重试异常。**provider 的错不会抛出 `session.ask`**，它被就地转成
   * `run.finished{stopReason:'provider_error'}`——只认异常的话，一次故障会被
   * 判成「正常跑完」然后接着续起，把一次失败放大成一串。
   */
  test('provider 报错之后停在 blocked，不再自动重试', async () => {
    const cv = conversation()
    script = [() => new Response('boom', { status: 500 })]

    startLoop(cv)
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
      () =>
        new Promise<Response>((resolve) => {
          hang.release = () =>
            resolve(new Response(textTurn('迟到的回答'), { headers: SSE_HEADERS }))
        }),
    ]

    try {
      startLoop(cv)
      const started = await waitFor((e) => e.type === 'run.started')
      expect(started).not.toBeNull()
      expect(runs.armedOf(cv)).not.toBeNull()

      runs.interrupt((started as { runId: string }).runId as never)
      const paused = await waitFor((e) => e.type === 'goal' && e.goal.status === 'paused')
      expect(paused).not.toBeNull()
      expect(runs.armedOf(cv)).toBeNull()

      await settle()
      expect(currentGoal(store, cv)?.status).toBe('paused')
      expect(listRuns(store, cv).at(-1)?.interruption).toMatchObject({
        source: 'user',
        ambiguousToolExecution: false,
      })
    } finally {
      hang.release?.()
    }
  }, 20_000)
})

/**
 * 指令入口那一格。`handleCommand` 的分支只有一行，但**未实现 / 被拒的分支
 * 静默 return 是这个文件顶部点名的头号毛病**——客户端发完等不到任何反馈，
 * 界面上和「服务端正在处理」分不出来。
 */
describe('goal.set 指令', () => {
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

  test('指令走通到账本，第一轮当场起来', async () => {
    const cv = conversation()
    // 第一轮就把目标收掉：留着一个 12 轮的循环在跑，会占用后面用例的脚本。
    script = [
      () => {
        const goal = currentGoal(store, cv)
        return new Response(
          toolTurn('update_goal', {
            goal_id: goal?.id,
            revision: goal?.revision,
            action: 'complete',
          }),
          { headers: SSE_HEADERS },
        )
      },
      ok(textTurn('做完了。')),
    ]
    const sock = socket()

    await handleCommand(
      { type: 'goal.set', conversationId: cv, objective: '把测试跑绿' } as never,
      {
        ...deps(),
        ws: sock.ws,
      },
    )
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'completed')

    await settle()
    expect(currentGoal(store, cv)?.objective).toBe('把测试跑绿')
    // 指令被接受就不该有回执——回执只在拒绝时发。
    expect(sock.sent).toHaveLength(0)
  }, 20_000)

  /** 空正文被账本拒，理由必须**回到客户端**，不能只在服务端消失。 */
  test('空正文被拒，且拒绝有回执', async () => {
    const cv = conversation()
    const sock = socket()

    await handleCommand({ type: 'goal.set', conversationId: cv, objective: '   ' } as never, {
      ...deps(),
      ws: sock.ws,
    })

    expect(currentGoal(store, cv)).toBeNull()
    expect(sock.sent).toHaveLength(1)
    expect(sock.sent[0]?.type).toBe('command.rejected')
  })
})

/**
 * 停止按钮那一格。
 *
 * `runs.interrupt` 一直返回 `boolean`，而指令入口把它丢了。丢掉的表现是这一整类
 * 里最难查的一种：用户点了停止，按钮没反应、转圈继续转、一条日志都没有，
 * 「服务端在处理」和「这条指令没人接」在界面上完全一样。
 */
describe('run.interrupt 指令', () => {
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

  test('注册表里没有这条 run 时必须回绝，不能静默', async () => {
    const sock = socket()
    await handleCommand({ type: 'run.interrupt', runId: 'rn_not_running' } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(sock.sent).toHaveLength(1)
    expect(sock.sent[0]?.type).toBe('command.rejected')
    expect(sock.sent[0]?.command).toBe('run.interrupt')
  })

  test('真的中断到了就不发回执 —— 回执只在拒绝时发', async () => {
    const sock = socket()
    const d = deps()
    const controller = new AbortController()
    d.runs.register({
      runId: 'rn_live' as never,
      conversationId: 'cv_live' as never,
      controller,
    } as never)

    await handleCommand({ type: 'run.interrupt', runId: 'rn_live' } as never, {
      ...d,
      ws: sock.ws,
    })
    expect(controller.signal.aborted).toBe(true)
    expect(sock.sent).toHaveLength(0)
  })
})

describe('用户点继续', () => {
  /**
   * resume **自己发起一轮**，不能等下一次别的 run 收尾——那时候用户已经等了
   * 不知道多久，而界面上什么都没发生。
   */
  test('resume 把目标转回 active 并当场起一轮', async () => {
    const cv = conversation()
    const goal = seed(cv)
    const paused = updateGoal(store, {
      conversationId: cv,
      goalId: goal.id,
      revision: goal.revision,
      action: 'pause',
    })
    expect(paused.ok).toBe(true)
    runs.disarm(cv)

    // 这一轮里就把目标收掉：循环没有上限，不收的话它会持续占用后面用例的脚本。
    script = [
      () => {
        const g = currentGoal(store, cv)
        return new Response(
          toolTurn('update_goal', {
            goal_id: g?.id,
            revision: g?.revision,
            action: 'complete',
          }),
          { headers: SSE_HEADERS },
        )
      },
      ok(textTurn('做完了。')),
    ]
    expect(resumeGoal(cv, deps())).toEqual({ ok: true })

    await waitFor((e) => e.type === 'goal' && e.goal.status === 'completed')
    await settle()
    expect(bodies[0]).toContain('[自动续起]')
    expect(bodies[0]).toContain('慢慢做这件事')
    expect(runs.armedOf(cv)).toBeNull()
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

/**
 * 报错正文落账本。覆盖 `runtime/session.ts` 收 `run.error` 那一手。
 *
 * **原始失败形状**：一条 `stop_reason = 'provider_error'` 的 run，账本里的
 * `error_message` 是 `null`——两列从建表起就在、`RunRecord` 也一直转出去，
 * 只是从来没有人写过。表现是刷新之后「为什么停」只剩「模型服务出错」，
 * 连不上、key 错了、上下文满了，看起来一模一样。
 */
describe('报错正文落账本', () => {
  test('provider 报错的那一轮，error_message 与 error_code 都读得回来', async () => {
    const cv = conversation()
    // 脚本留空 = 假 provider 回 401，正是一次真实的 provider 失败。
    await startRun(cv, '随便说点什么', undefined, deps())
    await waitFor((e) => e.type === 'run.finished')

    const run = listRuns(store, cv).at(-1)
    expect(run?.stopReason).toBe('provider_error')
    expect(run?.errorCode).toBe('auth_failed')
    expect(run?.errorMessage).toBeTruthy()
  }, 20_000)

  /** 正常收尾不留报错正文——留了的话每一轮读数条上都挂着上一次的错。 */
  test('正常收尾的那一轮两列都是 null', async () => {
    const cv = conversation()
    script = [ok(textTurn('好了。'))]
    await startRun(cv, '随便说点什么', undefined, deps())
    await waitFor((e) => e.type === 'run.finished')

    const run = listRuns(store, cv).at(-1)
    expect(run?.stopReason).toBe('completed')
    expect(run?.errorMessage).toBe(null)
    expect(run?.errorCode).toBe(null)
  }, 20_000)
})
