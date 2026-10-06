/**
 * 回执到达时序 × 父轮终态的自动继续裁决。**使用假 provider 运行真实链路，不产生费用、不访问网络。**
 *
 * **覆盖范围**：`run-control.ts` 的 `submitMessage` 空闲分支与 `startRun` 收尾阶段
 * （`resetSteer` → `CONTINUABLE` → `fireFollowUpRound`）、`runs.ts` 的 `resetSteer`
 * 与队列取出，以及 `agent/loop/index.ts` 每轮开头 `takeSteered` 的注入位置。
 * 队列本身的入队幂等、翻转与删除由 `followup.test.ts` 覆盖，单项失败时其余项照常执行由
 * `delegate.test.ts` 覆盖。
 *
 * 必须使用真实链路：该规则的内容是父轮的结束方式决定回执能否自行
 * 发起一轮。父轮终态由 loop 产生、经 `runtime/session.ts` 写入 `runs` 行，裁决时
 * 服务端读取该行：把其中任何一段替换为桩，只能验证桩被调用。
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

/** 按顺序应答的脚本。`always` 为空时才使用它。 */
let script: Turn[] = []
/** 非空时所有请求都由它应答。用于实际耗尽自动重发预算。 */
let always: Turn | null = null
/** 阻塞本会话的第一次请求，直到用例放行。 */
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
    // 脚本耗尽时返回 401（`auth_failed`，立即终止且不重发）。用例依据多出的请求 body
    // 识别回执不应发起新一轮却发起了新一轮的情形，因此此处必须先记录再拒绝。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next(body)
  },
})

const ok =
  (payload: string): Turn =>
  () =>
    new Response(payload, { headers: SSE_HEADERS })

/**
 * `Retry-After: 0` 的容量拒绝。退避读取上游给出的该值，因此全部重发预算在毫秒内耗尽，
 * 「耗尽预算」这一终态在用例中数秒内即可到达。
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
/** 用于相邻时序：在 `run.finished` 广播时延迟一个周期，与收尾 `finally` 竞争。 */
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

/** 等待该会话完全空闲（收尾与发起下一轮的 setTimeout(0) 均已执行）。 */
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

/** 排队与发起均经由 setTimeout(0)，多等待几个周期以确认未启动下一轮。 */
async function settle(): Promise<void> {
  await Bun.sleep(200)
}

// ───────────────────────── 矩阵 ─────────────────────────

const RECEIPT = '[子 agent 回执] 临时 查资料 已返回'

/** 回执相对父轮收尾到达的三个时刻。 */
type Timing = 'early' | 'late' | 'adjacent'
/** 父轮的结束方式。 */
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

/** 回执被交给模型的总次数：发起新一轮计一次，注入计一次。 */
function deliveriesOf(cv: ConversationId, text: string): number {
  const asRound = listMessages(store, cv).filter((m) => m.content === text).length
  const asInjection = listRuns(store, cv)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === 'user' && s.content === text).length
  return asRound + asInjection
}

interface Reading {
  /** 父轮自身发出的请求数，取自其请求记录行。 */
  parentRequests: number
  /** 回执到达之后新增的请求数。 */
  afterReceipt: number
  queue: { id: string; steer: boolean; origin?: string }[]
  /** 之后由真实用户消息发起的那一轮，其首个请求中是否包含回执。 */
  receiptInFirstBody: boolean
  deliveries: number
  stopReason: string | null
}

/**
 * 执行矩阵中的一项：父轮 → 回执按 `timing` 到达 → 一条真实用户消息。
 *
 * 四种终态都要执行用户消息这一步：失败终态下它是唯一能交付回执的入口，
 * 正常完成时它用于确认回执没有被交付第二次。
 */
async function cell(terminal: Terminal, timing: Timing): Promise<Reading> {
  const cv = conversation()
  hold()
  // 容量拒绝一项由 `always` 应答全部请求，预算按实际重发次数耗尽；
  // 其余三种终态的第一条脚本即为父轮的应答。
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
      // 延后一个周期：收尾 `finally` 与其安排的发起都在该周期之前执行完毕，
      // 回执恰好在两者之间到达。
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

describe('父轮正常完成后的回执照常自动发起新一轮', () => {
  for (const timing of ['early', 'late', 'adjacent'] as const) {
    test(`${TIMINGS[timing]}：自动交给模型，且只交付一次`, async () => {
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
 * 三种非正常终态共用一条规则：回执只保留在队列中，不因到达时机不同而取得新一轮预算；
 * 由下一条真实用户消息发起的那一轮，在首个请求中一并交付回执，且恰好一次。
 */
describe('父轮失败或被停止后的回执只保留在队列中', () => {
  for (const terminal of ['provider_error', 'auth_failed', 'user_stop'] as const) {
    for (const timing of ['early', 'late', 'adjacent'] as const) {
      test(`${TERMINALS[terminal]} + ${TIMINGS[timing]}：不新增请求，随下一条用户消息一次交付`, async () => {
        const r = await cell(terminal, timing)
        expect(r.stopReason).toBe(terminal === 'user_stop' ? 'user_interrupt' : 'provider_error')
        // 容量拒绝一项确实耗尽了预算，而不是一次即停止。
        if (terminal === 'provider_error') expect(r.parentRequests).toBeGreaterThan(1)
        else expect(r.parentRequests).toBe(1)
        // 回执自身不得发出任何请求。
        expect(r.afterReceipt).toBe(0)
        // 注入资格保留：下一轮的首个边界即可取得。
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
   * 两个独立子任务的回执都在父轮失败前到达：两条都保留，下一条用户消息的首个请求
   * 同时包含这两条回执，各一次。
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
   * 用户标记的「调整方向」仍只对标记时的那一轮有效：父轮收尾时复位，
   * 下一轮由队首条目发起而不是注入。两种去向同在一份队列中，处理一种时不得连带另一种。
   */
  test('同一队列中用户条目复位、回执保留', async () => {
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
