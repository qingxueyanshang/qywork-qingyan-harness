/**
 * 跟进消息（排队 / 注入）的端到端回归测试。使用假 provider，不产生费用、不访问网络。
 *
 * 覆盖范围：`runs.ts` 的队列（入队幂等、翻转、删除、取出、复位）、
 * `commands.ts` 的 `message.send` 忙闲裁决、对子会话的拒绝、两条 `followup.*` 分支与
 * `conversation.interrupt` 同时停止三类任务、`run-control.ts` 的 `submitMessage`
 * （用户消息与子 agent 回执经由同一条路径）、收尾时发起下一轮及其与目标自动继续的优先级、
 * `agent/loop/index.ts` 在 step 边界的注入，以及 `runtime/transcript.ts` 把
 * `kind='user'` 的 step 投影回历史。
 *
 * 必须使用真实链路：该功能的行为是一轮执行过程中，模型的下一次请求
 * 多出一条用户消息。把 loop 替换为桩测试只能验证桩被调用；易出错的
 * 是装配：该消息是否进入请求、位于哪个位置、下一轮从账本投影回来后是否仍在原位。
 * 假 provider 保留每次请求的原始 body，前缀断言直接基于它比较。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { buildHistory, type QyConfig } from '@qywork/runtime'
import {
  appendStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createGoal,
  currentGoal,
  listMessages,
  listRuns,
  listSteps,
  Store,
  setStepNodeState,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { handleCommand } from './commands.ts'
import { startRun, submitMessage } from './run-control.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function usage() {
  return { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
}

/** 一轮工具调用。使用 `list_dir`：只读、不修改工作区、参数简单。 */
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

type Turn = (body: string) => Response | Promise<Response>

let script: Turn[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    const next = script.shift()
    // 脚本耗尽时返回 401（`auth_failed`，立即终止且不重发）。理由与 goal-loop 测试相同：
    // 一条正常收尾的文本响应会使服务端继续发起下一轮，导致用例之间互相干扰。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next(body)
  },
})

const ok =
  (payload: string): Turn =>
  () =>
    new Response(payload, { headers: SSE_HEADERS })

/** 挂起当前一轮，直到用例主动放行，用于构造会话运行中的状态。 */
function gate(payload: string): { turn: Turn; release: () => void } {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const turn: Turn = async () => {
    await ready
    return new Response(payload, { headers: SSE_HEADERS })
  }
  return { turn, release }
}

describe('模拟接口放行', () => {
  test('请求到达前放行仍返回响应', async () => {
    const held = gate('ok')
    held.release()
    const response = await held.turn('')
    expect(await response.text()).toBe('ok')
  })

  test('请求到达后仍须等待放行', async () => {
    const held = gate('ok')
    let completed = false
    const pending = Promise.resolve(held.turn('')).then((response) => {
      completed = true
      return response
    })
    await Bun.sleep(10)
    expect(completed).toBe(false)
    held.release()
    const response = await pending
    expect(await response.text()).toBe('ok')
  })
})

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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-followup-'))
  const dbPath = join(dir, 'followup.sqlite3')
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
  return { store, content, config, bus, runs, subagents }
}

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

/** 等待该会话完全空闲（收尾与发起下一轮的 setTimeout(0) 均已执行）。 */
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

/** 排队与发起均经由 setTimeout(0)，多等待几个周期以确认未启动下一轮。 */
async function settle(): Promise<void> {
  await Bun.sleep(160)
}

/** 请求 body 中发给模型的消息序列。前缀断言据此逐条比较。 */
function sentMessages(body: string): { role: string; content: unknown }[] {
  const parsed = JSON.parse(body) as { input?: { role?: string; content?: unknown }[] }
  return (parsed.input ?? []).map((m) => ({ role: m.role ?? '', content: m.content }))
}

// ───────────────────────── 用例 ─────────────────────────

describe('会话运行中发送消息', () => {
  test('不拒绝，排入队列，且不写入磁盘', async () => {
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

      // 未拒绝：既没有 run.error，也没有指令回执。
      expect(sock.sent).toEqual([])
      expect(events.some((f) => f.event.type === 'run.error')).toBe(false)
      expect(runs.queueOf(cv).map((f) => f.content)).toEqual(['排着的那一句'])
      // 队列不落盘：账本中只有发起本轮的消息。
      expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句'])
      // 队列卡片唯一的实时来源。
      expect(events.some((f) => f.event.type === 'queue.changed')).toBe(true)
    } finally {
      held.release()
      await idle(cv)
    }
  }, 20_000)

  test('同一个 clientRequestId 重发不会产生两条排队条目', async () => {
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

describe('子会话不接受直接消息', () => {
  test('向 workflow 创建的子会话发送消息被拒绝，不入队也不发起新一轮', async () => {
    const parent = conversation()
    const child = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      source: 'temp',
      sourceRef: 'ad-hoc',
      parentConversationId: parent,
    }).id
    const sock = socket()
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-child',
        conversationId: child,
        content: '直接说一句',
      } as never,
      { ...deps(), ws: sock.ws },
    )
    expect(sock.sent.at(-1)).toMatchObject({
      type: 'command.rejected',
      reason: 'conflict',
      clientRequestId: 'req-child',
    })
    expect(runs.queueOf(child)).toEqual([])
    expect(runs.isBusy(child)).toBe(false)
    expect(listRuns(store, child)).toEqual([])
    expect(listMessages(store, child)).toEqual([])
  })
})

describe('收尾之后发起下一轮', () => {
  test('正常收尾后自动发起下一轮，正文即排队中的消息', async () => {
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
    // 两条消息、两轮，顺序与用户发送顺序一致。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '跑完再说这句'])
    expect(listRuns(store, cv)).toHaveLength(2)
    expect(runs.queueOf(cv)).toEqual([])
  }, 30_000)

  test('中断收尾时不发起下一轮，条目留在队列且去向复位', async () => {
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

    // 不自动发起下一轮。
    expect(listRuns(store, cv)).toHaveLength(1)
    // 条目仍在队列中，但「调整方向」只对标记时的那一轮有效，收尾时复位。
    expect(runs.queueOf(cv)).toHaveLength(1)
    expect(runs.queueOf(cv)[0]?.steer).toBe(false)
  }, 30_000)

  test('队列优先于目标自动继续，但目标的收尾处理照常执行', async () => {
    const cv = conversation()
    const seeded = createGoal(store, { conversationId: cv, objective: '把活干完' })
    if (!seeded.ok) throw new Error(seeded.message)
    const live = seeded.goal
    runs.arm(cv, { goalId: live.id, revision: live.revision })

    const held = gate(textTurn('这一轮完了。'))
    script = [held.turn, ok(textTurn('跟进那一轮也完了。'))]
    const sock = socket()
    void startRun(cv, '第一句', undefined, deps(), undefined, {
      kind: 'goal',
      arm: { goalId: live.id, revision: live.revision },
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

    // 发起的是队列中消息对应的一轮（用户消息优先），而不是目标自动继续的一轮。
    const messages = listMessages(store, cv).map((m) => m.content)
    expect(messages).toEqual(['第一句', '人插的这一句'])
    // 目标本身不受此次跳过影响：标记由该次 startRun 清除（用户消息优先）。
    expect(runs.armedOf(cv)).toBeNull()
    expect(currentGoal(store, cv)?.status).toBe('active')
  }, 30_000)
})

describe('注入当前一轮', () => {
  /**
   * 该功能最关键的断言：注入之后的请求必须由上一次请求的
   * 逐条前缀加新增条目构成。不成立说明注入位置错误，
   * 缓存前缀在该处中断，且不会产生任何报错。
   */
  test('在下一个 step 边界进入请求，且不破坏前缀', async () => {
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

    // 注入的消息进入了第二次请求。
    expect(JSON.stringify(second)).toContain('改主意了，只列文件名')
    expect(JSON.stringify(first)).not.toContain('改主意了')

    // run 上下文已与真实用户消息绑定；跟进消息只向 transcript 追加，已发送的消息不变。
    expect(second.slice(0, first.length)).toEqual(first)

    // 注入消息写入为一条 kind='user' 的 step，创建时即为终态。
    const run = listRuns(store, cv)[0]
    const injected = listSteps(store, run?.id ?? ('' as never)).filter((s) => s.kind === 'user')
    expect(injected).toHaveLength(1)
    expect(injected[0]?.content).toBe('改主意了，只列文件名')
    expect(injected[0]?.status).toBe('done')
    // 队列中不再有该条目，事件带有 stepId 与卡片 id。
    expect(runs.queueOf(cv)).toEqual([])
    const ev = events.find((f) => f.event.type === 'message.injected')?.event
    expect(ev && 'stepId' in ev && ev.stepId).toBe(injected[0]?.id)
    expect(ev && 'followUpId' in ev && ev.followUpId).toBe('req-i')
  }, 30_000)

  /**
   * 跨 run 结构一致：注入的消息在回放中必须仍位于两批工具之间，
   * 而不是排在整个 run 的全部步骤之后。
   *
   * 用例特意在注入之后再执行一批工具：只有这样才能区分两种设计。
   * 写入 `messages` 表时回放会把它移到最后（`buildHistory` 的骨架按 message id
   * 排序、每条消息之后附加整轮 steps），写入 steps 表才保持原位。
   */
  test('下一轮从账本投影回来后，仍位于两批工具之间', async () => {
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
    // 关键断言：注入消息位于第二批工具之前。若排在最后，说明写入了错误的表。
    expect(secondTool).toBeGreaterThan(injected)
  }, 30_000)

  test('标记了调整方向但未赶上边界时，收尾后降级为发起下一轮', async () => {
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

    // 未被静默丢弃：它成为下一轮。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '来不及注入的一句'])
  }, 30_000)
})

describe('队列卡片上的两个操作', () => {
  test('翻转去向；会话空闲时同一条指令立即发起一轮', async () => {
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
    // 运行中：翻转去向，条目仍留在队列中。
    await handleCommand(
      { type: 'followup.steer', conversationId: cv, id: 'req-t', steer: true } as never,
      { ...deps(), ws: sock.ws },
    )
    expect(runs.queueOf(cv)[0]?.steer).toBe(true)

    // 中断当前一轮，使会话空闲且不发起下一轮。
    runs.interrupt((started as { runId: string }).runId as never)
    held.release()
    await idle(cv)
    expect(runs.queueOf(cv)).toHaveLength(1)

    // 空闲时：同一条指令的语义变为「立即发送」。
    await handleCommand(
      { type: 'followup.steer', conversationId: cv, id: 'req-t', steer: true } as never,
      { ...deps(), ws: sock.ws },
    )
    await idle(cv)
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句', '待定的一句'])
    expect(runs.queueOf(cv)).toEqual([])
  }, 30_000)

  test('已删除的条目既不注入也不发起下一轮；无法删除时如实拒绝', async () => {
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

    // 再次删除：明确拒绝，不静默成功，否则「点击删除后卡片仍在」与
    // 「服务端未收到」在界面上无法区分。
    await handleCommand({ type: 'followup.drop', conversationId: cv, id: 'req-d' } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(sock.sent.at(-1)).toMatchObject({ type: 'command.rejected', reason: 'conflict' })

    held.release()
    await idle(cv)
    await settle()
    // 删除之后不应有第二轮。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['第一句'])
  }, 30_000)
})

/**
 * 子 agent 的回执与用户发送的消息经由同一个函数（`submitMessage`）：忙时排入队列，在下一个
 * step 边界注入；空闲时立即发起一轮。两处各自实现时，「判定忙闲与发起新一轮在同一个同步块中」
 * 这一约束需要维护两次，而遗漏的一处不会报错。
 */
describe('回执进入同一条队列', () => {
  const receipt = (id: string, content: string) => ({
    id,
    content,
    steer: true,
    origin: 'subagent' as const,
  })

  test('有 run 运行时：排入队列，在下一个 step 边界注入，来源随 step 落盘', async () => {
    const cv = conversation()
    const held = gate(toolTurn('call_receipt'))
    script = [held.turn, ok(textTurn('看到回执了。'))]
    void startRun(cv, '先派个活', undefined, deps())
    await waitFor((e) => e.type === 'run.started')

    await submitMessage(cv, receipt('rc_1', '[子 agent 回执] 临时 查资料 已返回'), deps())
    expect(runs.queueOf(cv).map((f) => f.origin)).toEqual(['subagent'])
    held.release()

    const injected = await waitFor((e) => e.type === 'message.injected')
    expect(injected?.type === 'message.injected' && injected.content).toContain('子 agent 回执')
    // 事件与落库的值一致：界面据此决定渲染为回执行还是气泡。两侧不一致时，
    // 同一条消息实时渲染为气泡，刷新后变为回执行。
    expect(injected?.type === 'message.injected' && injected.origin).toBe('subagent')
    await idle(cv)

    const step = listRuns(store, cv)
      .flatMap((r) => listSteps(store, r.id))
      .find((s) => s.kind === 'user')
    expect(step?.payload).toMatchObject({ kind: 'user', origin: 'subagent' })
    // 回执不是用户发言：它不应在 messages 表中新增一行。
    expect(listMessages(store, cv).map((m) => m.content)).toEqual(['先派个活'])
  }, 30_000)

  test('会话空闲：立即发起一轮，消息行记录来源', async () => {
    const cv = conversation()
    script = [ok(textTurn('收到回执，接着做。'))]

    await submitMessage(cv, receipt('rc_2', '[子 agent 回执] 临时 查资料 已返回'), deps())
    await idle(cv)

    expect(listRuns(store, cv)).toHaveLength(1)
    const rows = listMessages(store, cv)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.origin).toBe('subagent')
    expect(runs.queueOf(cv)).toEqual([])
    // 发起事件同样带来源：本轮正文只经由该事件到达界面，缺少来源时会实时渲染为用户气泡。
    const started = await waitFor((e) => e.type === 'run.started')
    expect(started?.type === 'run.started' && started.userMessage?.origin).toBe('subagent')
  }, 30_000)

  /**
   * 回执不是用户的操作：它发起的一轮不能清除目标的自动继续标记，
   * 否则循环最多再执行一轮就会中途停止。
   */
  test('回执发起的一轮不清除目标的自动继续标记', async () => {
    const cv = conversation()
    // 用 gate 阻塞当前一轮：标记必须在本轮仍在运行时检查，收尾之后由目标自身的收尾逻辑裁决。
    const held = gate(textTurn('收到回执。'))
    script = [held.turn]
    const seeded = createGoal(store, { conversationId: cv, objective: '把这件事做完' })
    if (!seeded.ok) throw new Error(seeded.message)
    runs.arm(cv, { goalId: seeded.goal.id, revision: seeded.goal.revision })

    await submitMessage(cv, receipt('rc_3', '[子 agent 回执] 临时 查资料 已返回'), deps())
    await waitFor((e) => e.type === 'run.started')
    expect(runs.armedOf(cv)).not.toBeNull()

    // 改为用户发送消息：用户发言后，已排队的自动继续即作废。
    await handleCommand(
      {
        type: 'message.send',
        clientRequestId: 'req-human',
        conversationId: cv,
        content: '人插的这一句',
        steer: false,
      } as never,
      { ...deps(), ws: socket().ws },
    )
    held.release()
    await idle(cv)
    expect(runs.armedOf(cv)).toBeNull()
  }, 30_000)
})

/**
 * 停止按会话全部停止：本轮、已派发的子 agent，以及图上尚未派发的节点。
 * 遗漏任何一类的结果相同：界面上该会话仍显示运行中，而用户已经点击过停止。
 */
describe('按会话停止', () => {
  test('run 与子 agent 一并停止，图上未进入终态的节点标记为中断', async () => {
    const cv = conversation()
    const held = gate(textTurn('不会用到。'))
    script = [held.turn]
    const sock = socket()
    void startRun(cv, '先跑起来', undefined, deps())
    const started = await waitFor((e) => e.type === 'run.started')
    const runId = started?.type === 'run.started' ? started.runId : ''
    const step = appendStep(store, {
      runId: runId as never,
      seq: 99,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_stop',
      status: 'running',
      payload: { kind: 'tool_call', args: {} },
    })
    setStepNodeState(store, step.id, 'slow', { phase: 'working', label: '慢' })
    const controller = new AbortController()
    subagents.add(cv, 'cv_child', { name: '慢', kind: 'temp', controller })

    await handleCommand({ type: 'conversation.interrupt', conversationId: cv } as never, {
      ...deps(),
      ws: sock.ws,
    })

    // 任何一类都不得遗漏；也不得发送拒绝回执，因为该指令确实执行了停止。
    expect(sock.sent).toEqual([])
    expect(controller.signal.aborted).toBe(true)
    const nodes = (
      listSteps(store, runId as never).find((s) => s.id === step.id)?.payload as {
        nodes?: Record<string, { phase: string }>
      }
    ).nodes
    expect(nodes?.slow?.phase).toBe('interrupted')
    expect(events.some((f) => f.event.type === 'team.member')).toBe(true)
    held.release()
    subagents.remove(cv, 'cv_child')
    await idle(cv)
  }, 30_000)

  test('只有子 agent 运行时同样能停止，不拒绝', async () => {
    const cv = conversation()
    const sock = socket()
    const controller = new AbortController()
    subagents.add(cv, 'cv_only', { name: '慢', kind: 'temp', controller })

    await handleCommand({ type: 'conversation.interrupt', conversationId: cv } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(controller.signal.aborted).toBe(true)
    expect(sock.sent).toEqual([])
    subagents.remove(cv, 'cv_only')
  })

  test('没有任何任务运行时如实拒绝', async () => {
    const cv = conversation()
    const sock = socket()
    await handleCommand({ type: 'conversation.interrupt', conversationId: cv } as never, {
      ...deps(),
      ws: sock.ws,
    })
    expect(sock.sent[0]).toMatchObject({ type: 'command.rejected', reason: 'conflict' })
  })
})
