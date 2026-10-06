/**
 * 目标自动继续的端到端回归测试。**使用假 provider，不产生费用、不访问网络。**
 *
 * **覆盖范围**：`run-control.ts` 的自动继续判定（`startRun` 的 finally、排队、
 * 陈旧拒绝、停止的三个出口）、用户设立目标的路径（`setGoal`）、`commands.ts` 的
 * `goal.set` 分支、`runs.ts` 的自动继续标记，以及 `runtime/session.ts` 把
 * `run.error` 的正文写入 run 行的步骤（此处已有真实链路与会失败的假 provider）。
 * 目标本身的生命周期规则由 `store/goals.test.ts` 覆盖，工具层由 `tools/goals.test.ts` 覆盖。
 *
 * **必须使用真实链路的原因。** 该功能的行为是「一轮结束之后**自动**发起下一轮」。把 `startRun`
 * 替换为桩来测试，只能验证「桩被调用」；真正容易出错的是装配：
 * 目标事件能否到达 run-control、finally 中读取的 stopReason 是否正确、
 * 下一轮的用户消息写入了什么。
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
import { SubagentRegistry } from './subagents.ts'

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

/** 一轮以纯文本结束的响应。 */
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

/** 本次请求的应答方式。 */
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
     * **脚本用完时返回 401，而不是再返回一句无害的文本。**
     *
     * 循环没有轮数上限，而一条正常结束的文本响应会使服务端继续发起下一轮：脚本耗尽后，
     * 该会话会在后台持续运行，占用后续用例的脚本，所有断言都变为竞态。
     * 401 判定为 `auth_failed`，是**立即终止**的应答（不在 `CONTINUABLE` 中）→
     * 目标转为 blocked → 循环停止。用例需要执行更多轮时，相应增加脚本条目。
     *
     * 不要改为 5xx 或 400：它们归入 `provider_unavailable`，agent 循环会退避后
     * 自动重发一次，因此脚本用完后还会再发出一次请求，`bodies` 会多出一条。
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
let subagents: SubagentRegistry
let config: QyConfig
let workspaceId = ''

/** 收到的全部事件，按到达顺序排列。断言与等待都读取它。 */
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-goal-'))
  const dbPath = join(dir, 'goal.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  subagents = new SubagentRegistry()
  runs = new RunManager(store, bus, subagents)
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
  return { store, content, config, bus, runs, subagents }
}

/** 每个用例使用一条新会话与一份新脚本。 */
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

/** 排队使用 setTimeout(0)，多等待几个周期以确认**没有**启动下一轮。 */
async function settle(): Promise<void> {
  await Bun.sleep(120)
}

/**
 * 直接在账本中设立一个目标并设置自动继续标记，模拟「循环已开启」。
 *
 * 也可以经由真实链路执行到这一步，但每个用例都需要先完成设立目标的两轮对话。
 * 注意循环**没有轮数上限**：用例必须自行结束它（模型 complete / blocked，
 * 或构造一次非正常收尾），否则脚本用完后它会持续自动继续，占用后续用例的脚本。
 */
function seed(cv: ConversationId) {
  const r = createGoal(store, { conversationId: cv, objective: '慢慢做这件事' })
  if (!r.ok) throw new Error(r.message)
  runs.arm(cv, { goalId: r.goal.id, revision: r.goal.revision })
  return r.goal
}

/**
 * 设立目标并**立即发起第一轮**：对应用户 `/goal` 的路径。
 *
 * 直接写入账本再调用 `resumeGoal`（与 `setGoal` 收尾使用同一个排队入口），
 * 这样用例可以精确控制起点，无需先模拟一遍指令分发。
 */
function startLoop(cv: ConversationId) {
  const goal = seed(cv)
  const r = resumeGoal(cv, deps())
  if (!r.ok) throw new Error(r.message)
  return goal
}

// ───────────────────────── 用例 ─────────────────────────

describe('连续执行多轮', () => {
  /**
   * 原始缺口：`agent/loop/index.ts` 的 step 循环在 **run 内**，一轮执行完毕即结束，
   * 没有任何代码会自动发起下一轮。本用例经由**用户 `/goal` 的真实入口**：
   * 设立目标时立即发起第一轮，第二轮的请求必须由服务端自行发出。
   */
  test('用户设立目标 → 立即发起一轮 → 自动继续下一轮 → 模型宣布完成后停止', async () => {
    const cv = conversation()
    script = [
      (body) => {
        expect(body).toContain('[自动继续]')
        expect(body).toContain('把 calc 修好')
        return new Response(textTurn('先看一眼代码。'), { headers: SSE_HEADERS })
      },
      // 第二轮：模型此次读取到的 goal_id / revision 是真实值，因此用账本中的值应答。
      (body) => {
        const goal = currentGoal(store, cv)
        expect(body).toContain('[自动继续]')
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
    // 两轮共三个请求（第一轮一个，第二轮为工具调用与收尾）。不应存在第三轮。
    expect(bodies).toHaveLength(3)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /**
   * 同一条会话再执行一次 `/goal` 即**改写当前目标**，而不是另立第二个。
   *
   * 起点是一个由模型宣布受阻的目标：此后循环停止、没有 run 在运行，
   * 正是用户会再次输入 `/goal` 的时刻。
   */
  test('对已停止的目标再执行一次 /goal：改写正文并继续执行，不新建目标', async () => {
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

    // 单独检查改写之后那一轮的脚本与请求：验证「新指令确实被执行」。
    script = [ok(textTurn('换个方向做。'))]
    bodies = []
    events = []
    expect(setGoal(cv, '改成做乙', deps()).ok).toBe(true)
    // 该轮执行完毕后脚本即用尽，下一轮以 401 结束，循环不会留在后台运行。
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    await settle()

    const second = currentGoal(store, cv)
    // 同一个目标改写了正文，而不是另立第二个：账本中一条会话只有一个目标。
    expect(second?.id).toBe(first.id)
    expect(second?.objective).toBe('改成做乙')
    // 改写之后循环确实继续执行，执行的是新指令。
    expect(bodies[0]).toContain('改成做乙')
  }, 20_000)

  /** 有一轮在运行时不允许修改目标：否则等于中途替换其正在执行的指令。 */
  test('运行中拒绝设立目标，并给出原因', async () => {
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
   * **循环不会自行停止。** 没有轮数上限：模型不宣布结束，就会持续执行下一轮。
   *
   * 本用例锁定这一设计决定：给循环加入静默的配额时，本用例会立即失败。
   * 结束依靠中断，而不是等待其自行耗尽。
   */
  test('模型不宣布结束就持续自动继续，不存在自动上限', async () => {
    const cv = conversation()
    const ROUNDS = 5
    // 状态在**每一轮内部**读取：执行完毕后再读取会产生竞态，因为脚本耗尽后下一轮立即以 401 转为 blocked。
    const seen: (string | undefined)[] = []
    script = Array.from({ length: ROUNDS }, (_, i) => () => {
      seen.push(currentGoal(store, cv)?.status)
      return new Response(textTurn(`第 ${i + 1} 次：还没做完。`), { headers: SSE_HEADERS })
    })

    startLoop(cv)
    // 结束依靠脚本耗尽（401 → blocked），而不是等待循环自行终止。
    await waitFor((e) => e.type === 'goal' && e.goal.status === 'blocked')
    await settle()

    // 五轮全都在目标 active 的状态下执行完毕，不存在默认 12 轮的上限。
    expect(seen).toEqual(Array(ROUNDS).fill('active'))
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)
})

describe('四条防失控规则', () => {
  /**
   * 用户消息优先。原始失败形状：用户插入一条消息，而已排队的自动继续仍被发出，
   * 模型因此同时持有两条相互冲突的指令。
   */
  test('用户发送消息即清除自动继续标记', async () => {
    const cv = conversation()
    // 目标直接写入账本、标记手动设置：本用例验证的是「用户发言后的行为」，
    // 如何进入循环由其他用例覆盖。
    expect(seed(cv).status).toBe('active')

    script = [ok(textTurn('收到。'))]
    await startRun(cv, '先停一下，看看这个', undefined, deps())
    // 必须同步清除：清除稍晚时，期间已排队的那一次仍会被发出。
    expect(runs.armedOf(cv)).toBeNull()

    await waitFor((e) => e.type === 'run.finished')
    await settle()
    // 用户发起的那一轮之后没有再自动发起新一轮。
    expect(bodies).toHaveLength(1)
    expect(currentGoal(store, cv)?.status).toBe('active')
  }, 20_000)

  /**
   * 预留与陈旧拒绝。排队时记录 {goalId, revision}，实际发起前重新读取；
   * 版本变化即丢弃本次排队。
   */
  test('排队期间目标被修改，本次排队作废', async () => {
    const cv = conversation()
    const goal = seed(cv)

    // 排队之后、发起之前，目标被修改了一次（由另一端改写，或由模型修改）。
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
    // 未发出任何请求：按数秒前的版本继续执行，执行的就不再是当前的目标。
    expect(bodies).toHaveLength(0)
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  /**
   * 不自动重试异常。**provider 的错误不会从 `session.ask` 抛出**，它被就地转换为
   * `run.finished{stopReason:'provider_error'}`：只识别异常时，一次故障会被
   * 判定为「正常执行完毕」并继续自动执行，把一次失败放大为一连串失败。
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
    // 报错的那一轮之后不应再发出任何请求。
    const after = bodies.length
    await settle()
    expect(bodies.length).toBe(after)
  }, 20_000)

  /** 取消之后暂停，不自动重启。 */
  test('中断本轮时目标转为 paused 并解除标记', async () => {
    const cv = conversation()
    // 存放在对象上而不是独立的 `let` 变量：赋值发生在回调中，TS 的控制流分析无法识别，
    // 独立变量在 finally 所在行会被收窄为 `never`。
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
 * 指令入口。`handleCommand` 的分支只有一行，但**未实现或被拒绝的分支不得静默 return**：
 * 静默 return 时客户端发送后收不到任何反馈，
 * 界面上与「服务端正在处理」无法区分。
 */
describe('goal.set 指令', () => {
  /** 接收指令的假连接：只记录回执，不打开真实的 socket。 */
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

  test('指令写入账本，并立即发起第一轮', async () => {
    const cv = conversation()
    // 第一轮即结束目标：留下一个运行中的循环会占用后续用例的脚本。
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
    // 指令被接受时不应有回执：回执只在拒绝时发送。
    expect(sock.sent).toHaveLength(0)
  }, 20_000)

  /** 空正文被账本拒绝，原因必须**返回给客户端**，不能只停留在服务端。 */
  test('空正文被拒绝，且拒绝有回执', async () => {
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
 * 停止按钮。
 *
 * 按会话中断返回 `boolean`，指令入口必须把它作为应答返回。丢弃该返回值时问题最难排查：
 * 用户点击停止后按钮无响应、运行状态持续、没有任何日志，
 * 「服务端正在处理」与「该指令无人处理」在界面上完全相同。
 */
describe('conversation.interrupt 指令', () => {
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

  test('会话没有运行中的 run 时必须拒绝，不能静默', async () => {
    const sock = socket()
    await handleCommand({ type: 'conversation.interrupt', conversationId: 'cv_idle' } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(sock.sent).toHaveLength(1)
    expect(sock.sent[0]?.type).toBe('command.rejected')
    expect(sock.sent[0]?.command).toBe('conversation.interrupt')
  })

  test('实际中断成功时不发送回执：回执只在拒绝时发送', async () => {
    const sock = socket()
    const d = deps()
    const controller = new AbortController()
    d.runs.register({
      runId: 'rn_live' as never,
      conversationId: 'cv_live' as never,
      controller,
    } as never)

    await handleCommand({ type: 'conversation.interrupt', conversationId: 'cv_live' } as never, {
      ...d,
      ws: sock.ws,
    })
    expect(controller.signal.aborted).toBe(true)
    expect(sock.sent).toHaveLength(0)
  })
})

describe('用户点击继续', () => {
  /**
   * resume **自行发起一轮**，不能等待下一次其他 run 收尾：届时用户已等待了
   * 不确定的时长，而界面上没有任何变化。
   */
  test('resume 把目标转回 active 并立即发起一轮', async () => {
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

    // 本轮即结束目标：循环没有上限，不结束时会持续占用后续用例的脚本。
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
    expect(bodies[0]).toContain('[自动继续]')
    expect(bodies[0]).toContain('慢慢做这件事')
    expect(runs.armedOf(cv)).toBeNull()
  }, 20_000)

  test('会话正忙时拒绝，不排入第二轮', () => {
    const cv = conversation()
    runs.reserve(cv)
    const r = resumeGoal(cv, deps())
    expect(r.ok).toBe(false)
    runs.release(cv)
  })

  test('没有目标时明确说明没有目标', () => {
    const cv = conversation()
    const r = resumeGoal(cv, deps())
    expect(r).toEqual({ ok: false, message: '该会话没有目标' })
  })
})

/**
 * 报错正文写入账本。覆盖 `runtime/session.ts` 接收 `run.error` 的步骤。
 *
 * **原始失败形状**：一条 `stop_reason = 'provider_error'` 的 run，账本中的
 * `error_message` 为 `null`：两列自建表起即存在、`RunRecord` 也一直输出它们，
 * 但从未有代码写入。刷新之后「停止原因」只剩「模型服务出错」，
 * 连接失败、key 错误、上下文已满三种情形无法区分。
 */
describe('报错正文写入账本', () => {
  test('provider 报错的那一轮，error_message 与 error_code 都能读取', async () => {
    const cv = conversation()
    // 脚本为空时假 provider 返回 401，即一次真实的 provider 失败。
    await startRun(cv, '随便说点什么', undefined, deps())
    await waitFor((e) => e.type === 'run.finished')

    const run = listRuns(store, cv).at(-1)
    expect(run?.stopReason).toBe('provider_error')
    expect(run?.errorCode).toBe('auth_failed')
    expect(run?.errorMessage).toBeTruthy()
  }, 20_000)

  /** 正常结束时不保留报错正文：保留时每一轮的读数条上都会显示上一次的错误。 */
  test('正常结束的一轮两列均为 null', async () => {
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
