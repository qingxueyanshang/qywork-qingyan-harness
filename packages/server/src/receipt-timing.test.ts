/**
 * 回执到达时序 × 父轮终态的续起裁决。**用假 provider 跑真链路，不花钱、不联网。**
 *
 * **覆盖范围**：`run-control.ts` 的 `submitMessage` 空闲分支与 `startRun` 收尾那一段
 * （`resetSteer` → `CONTINUABLE` → `fireFollowUpRound`）、`runs.ts` 的 `resetSteer`
 * 与队列取走，以及 `agent/loop.ts` 每轮开头 `takeSteered` 的注入位置。
 * 队列本身的入队幂等、翻转与删除在 `followup.test.ts`，一格失败其余照跑在
 * `delegate.test.ts`。
 *
 * **为什么必须走真链路。** 这条规则的形状是「父轮怎么收的场，决定回执能不能自己
 * 起一轮」。父轮终态由 loop 产生、经 `runtime/session.ts` 落进 `runs` 行，裁决在
 * 服务端读那一行——把其中任何一段换成桩，测到的只是桩被调用了。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope, FollowUp } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  listMessages,
  listProviderRequests,
  listRuns,
  listSteps,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { startRun, submitMessage } from './run-control.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

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

type Turn = (body: string) => Response | Promise<Response>

/** 按顺序答的脚本。`always` 为空时才轮到它。 */
let script: Turn[] = []
/** 非空时一切请求都用它答。用来把自动重发预算真的耗完。 */
let always: Turn | null = null
/** 扣住本会话的第一次请求，直到用例放行。 */
let firstHold: { wait: Promise<void>; release: () => void; arrived: boolean } | null = null
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    if (firstHold && !firstHold.arrived) {
      firstHold.arrived = true
      await firstHold.wait
    }
    const next = always ?? script.shift()
    // 脚本用完 = 401（`auth_failed`，当场终结且不重发）。用例靠「多出来的那几条 body」
    // 认出「回执不该起轮却起了轮」，所以这里必须先记账再回绝。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next(body)
  },
})

const ok =
  (payload: string): Turn =>
  () =>
    new Response(payload, { headers: SSE_HEADERS })

/**
 * `Retry-After: 0` 的容量拒绝。退避读上游给的这个值，因此整条重发预算在毫秒内跑完，
 * 「耗尽预算」这个终态在用例里是秒级可达的。
 */
const unavailable: Turn = () =>
  new Response(JSON.stringify({ error: { message: '没有可用名额' } }), {
    status: 503,
    headers: { 'retry-after': '0' },
  })

const unauthorized: Turn = () =>
  new Response(JSON.stringify({ error: { message: '密钥无效' } }), { status: 401 })

function hold(): void {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  firstHold = { wait, release, arrived: false }
}

// ───────────────────────── 装配 ─────────────────────────

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []
/** 相邻时序用它：`run.finished` 广播的那一刻挂一拍，与收尾 `finally` 竞争。 */
let onEvent: ((event: AgentEvent) => void) | null = null

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-receipt-'))
  const dbPath = join(dir, 'receipt.sqlite3')
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
  workspaceId = upsertWorkspace(store, dir, 'receipt-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => {
      events.push(frame)
      onEvent?.(frame.event)
    },
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

function conversation(): ConversationId {
  script = []
  always = null
  firstHold = null
  bodies = []
  events = []
  onEvent = null
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  }).id
}

async function waitFor(what: (e: AgentEvent) => boolean, ms = 20_000): Promise<AgentEvent | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = events.find((f) => what(f.event))
    if (hit) return hit.event
    await Bun.sleep(10)
  }
  return null
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`等不到：${label}`)
}

/** 等到这条会话真的闲下来（收尾与火发那一拍 setTimeout(0) 都过去）。 */
async function idle(cv: ConversationId, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!runs.isBusy(cv)) {
      await Bun.sleep(80)
      if (!runs.isBusy(cv)) return
    }
    await Bun.sleep(10)
  }
}

/** 排队与火发都是 setTimeout(0)，多等几拍确认**没有**下一轮起来。 */
async function settle(): Promise<void> {
  await Bun.sleep(200)
}

// ───────────────────────── 矩阵 ─────────────────────────

const RECEIPT = '[子 agent 回执] 临时 查资料 已返回'

/** 回执相对父轮收尾到达的三个时刻。 */
type Timing = 'early' | 'late' | 'adjacent'
/** 父轮怎么收的场。 */
type Terminal = 'completed' | 'provider_error' | 'auth_failed' | 'user_stop'

const TIMINGS: Record<Timing, string> = {
  early: '早到（父轮仍在运行）',
  late: '晚到（会话已空闲）',
  adjacent: '相邻（与收尾竞争）',
}

const TERMINALS: Record<Terminal, string> = {
  completed: '正常完成',
  provider_error: '容量拒绝耗尽预算',
  auth_failed: '不可恢复错误',
  user_stop: '用户停止',
}

function receiptItem(id: string): FollowUp {
  return { id, content: RECEIPT, steer: true, origin: 'subagent' }
}

/** 回执一共被交给模型几次：起轮算一次，注入算一次。 */
function deliveriesOf(cv: ConversationId, text: string): number {
  const asRound = listMessages(store, cv).filter((m) => m.content === text).length
  const asInjection = listRuns(store, cv)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === 'user' && s.content === text).length
  return asRound + asInjection
}

interface Reading {
  /** 父轮自己发出去的请求数，取自它那些请求账行。 */
  parentRequests: number
  /** 回执到达之后新增的请求数。 */
  afterReceipt: number
  queue: { id: string; steer: boolean; origin?: string }[]
  /** 之后那条真实用户消息起的那一轮，首个请求里有没有回执。 */
  receiptInFirstBody: boolean
  deliveries: number
  stopReason: string | null
}

/**
 * 跑完一格：父轮 → 回执按 `timing` 到达 → 一条真实用户消息。
 *
 * 用户消息那一步四种终态都要走：失败终态下它是唯一能把回执交出去的入口，
 * 正常完成下它用来确认回执没有被交第二次。
 */
async function cell(terminal: Terminal, timing: Timing): Promise<Reading> {
  const cv = conversation()
  hold()
  // 容量拒绝那一格由 `always` 接管全部请求，预算按真实重发次数耗尽；
  // 其余三种终态第一条脚本就是父轮的答复。
  if (terminal === 'provider_error') always = unavailable
  else script.push(terminal === 'auth_failed' ? unauthorized : ok(textTurn('父轮说完了。')))
  if (terminal === 'completed') script.push(ok(textTurn('回执那一轮说完了。')))
  script.push(ok(textTurn('用户那一轮说完了。')))

  const rc = receiptItem(`rc_${terminal}_${timing}`)
  let scheduled = false
  let delivered = false
  if (timing === 'adjacent') {
    onEvent = (event) => {
      if (event.type !== 'run.finished' || scheduled) return
      scheduled = true
      // 挂一拍：收尾 `finally` 与它排的那次火发都在这一拍之前跑完，
      // 回执正落在两者之间的空档上。
      setTimeout(() => {
        void submitMessage(cv, rc, deps()).then(() => {
          delivered = true
        })
      }, 0)
    }
  }

  void startRun(cv, '先派个活', undefined, deps())
  await waitFor((e) => e.type === 'run.started')
  await until(() => firstHold?.arrived === true, '父轮请求到达')

  if (timing === 'early') await submitMessage(cv, rc, deps())
  if (terminal === 'user_stop') runs.interruptConversation(cv)
  firstHold?.release()
  await idle(cv)
  if (timing === 'adjacent') await until(() => delivered, '相邻投递完成')
  await idle(cv)
  await settle()
  always = null

  const parentRun = listRuns(store, cv)[0]
  const parentRequests = parentRun ? listProviderRequests(store, parentRun.id).length : 0
  if (timing === 'late') {
    await submitMessage(cv, rc, deps())
    await idle(cv)
    await settle()
  }
  const afterReceipt = bodies.length - parentRequests
  const queue = runs.queueOf(cv).map((f) => ({
    id: f.id,
    steer: f.steer,
    ...(f.origin ? { origin: f.origin } : {}),
  }))

  const mark = bodies.length
  await submitMessage(
    cv,
    { id: `u_${terminal}_${timing}`, content: '接着做', steer: false },
    deps(),
  )
  await idle(cv)
  await settle()

  return {
    parentRequests,
    afterReceipt,
    queue,
    receiptInFirstBody: (bodies[mark] ?? '').includes(RECEIPT),
    deliveries: deliveriesOf(cv, RECEIPT),
    stopReason: parentRun?.stopReason ?? null,
  }
}

describe('父轮正常完成后的回执照常自动起轮', () => {
  for (const timing of ['early', 'late', 'adjacent'] as const) {
    test(`${TIMINGS[timing]} —— 自动交给模型，且只交一次`, async () => {
      const r = await cell('completed', timing)
      expect(r.stopReason).toBe('completed')
      expect(r.parentRequests).toBe(1)
      expect(r.afterReceipt).toBe(1)
      expect(r.queue).toEqual([])
      expect(r.deliveries).toBe(1)
    }, 60_000)
  }
})

/**
 * 三种非正常终态共用一条规则：回执只保留在队列里，不因到达时机不同取得新一轮预算；
 * 下一条真实用户消息起的那一轮，首个请求把它一起交出去，且恰好一次。
 */
describe('父轮失败或被停止后的回执只保留', () => {
  for (const terminal of ['provider_error', 'auth_failed', 'user_stop'] as const) {
    for (const timing of ['early', 'late', 'adjacent'] as const) {
      test(`${TERMINALS[terminal]} + ${TIMINGS[timing]} —— 不新增请求，随下一条用户消息一次交付`, async () => {
        const r = await cell(terminal, timing)
        expect(r.stopReason).toBe(terminal === 'user_stop' ? 'user_interrupt' : 'provider_error')
        // 容量拒绝那一格真的把预算用掉了，不是一次就停。
        if (terminal === 'provider_error') expect(r.parentRequests).toBeGreaterThan(1)
        else expect(r.parentRequests).toBe(1)
        // 回执自己一条请求都不许发。
        expect(r.afterReceipt).toBe(0)
        // 注入资格留着：下一轮首个边界就取得到。
        expect(r.queue).toEqual([
          { id: `rc_${terminal}_${timing}`, steer: true, origin: 'subagent' },
        ])
        expect(r.receiptInFirstBody).toBe(true)
        expect(r.deliveries).toBe(1)
      }, 60_000)
    }
  }
})

describe('并行回执与用户条目', () => {
  /**
   * 两个独立子任务的回执都在父轮失败前到达：两条都留着，下一条用户消息的首个请求
   * 同时带上它们，各一次。
   */
  test('父轮失败前到达的两条回执一次全部交付', async () => {
    const cv = conversation()
    hold()
    script = [unauthorized, ok(textTurn('用户那一轮说完了。'))]
    const first = '[子 agent 回执] 甲 已返回'
    const second = '[子 agent 回执] 乙 已返回'

    void startRun(cv, '派两个活', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await until(() => firstHold?.arrived === true, '父轮请求到达')
    await submitMessage(cv, { ...receiptItem('rc_a'), content: first }, deps())
    await submitMessage(cv, { ...receiptItem('rc_b'), content: second }, deps())
    firstHold?.release()
    await idle(cv)
    await settle()

    expect(bodies).toHaveLength(1)
    expect(runs.queueOf(cv).map((f) => f.id)).toEqual(['rc_a', 'rc_b'])

    await submitMessage(cv, { id: 'u_two', content: '接着做', steer: false }, deps())
    await idle(cv)
    await settle()

    expect(bodies[1] ?? '').toContain(first)
    expect(bodies[1] ?? '').toContain(second)
    expect(runs.queueOf(cv)).toEqual([])
    expect(deliveriesOf(cv, first)).toBe(1)
    expect(deliveriesOf(cv, second)).toBe(1)
  }, 60_000)

  /**
   * 用户自己标的「调整方向」仍然只对发出它的那一轮成立：父轮收尾即复位，
   * 下一轮由队首火发而不是注入。两种去向同在一份队列里，不能互相带走。
   */
  test('同一队列里用户条目复位、回执保留', async () => {
    const cv = conversation()
    hold()
    script = [unauthorized]

    void startRun(cv, '先派个活', undefined, deps())
    await waitFor((e) => e.type === 'run.started')
    await until(() => firstHold?.arrived === true, '父轮请求到达')
    await submitMessage(cv, { id: 'u_steer', content: '插一句', steer: true }, deps())
    await submitMessage(cv, receiptItem('rc_keep'), deps())
    firstHold?.release()
    await idle(cv)
    await settle()

    expect(runs.queueOf(cv).map((f) => ({ id: f.id, steer: f.steer }))).toEqual([
      { id: 'u_steer', steer: false },
      { id: 'rc_keep', steer: true },
    ])
  }, 60_000)
})
