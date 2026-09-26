/**
 * 派活通道的事件形状。**用假 provider 跑真链路，不花钱、不联网。**
 *
 * 覆盖范围：`delegate.ts` 的 `makeDelegate()` —— 派出即返回、完成回调落格状态与回执、
 * 回执正文的形状、按会话停止、图的推进（首派 → 一格跑完派下游 → 一格失败先交回 →
 * 上游齐了发检查点回执 → approve / revise），以及 `subagents.ts` 那张在跑表。
 *
 * **为什么走真链路。** 这条通道的形状就是「派出去之后，卡上那一格跟着动、回执自己回来」。
 * 把 `runBuiltinMember` 换成桩，测到的只是「桩被调用了」；真正会坏的是装配——
 * 事件带没带 stepId（不带前端整条丢弃）、终态发没发（不发那一格永远停在进行中）、
 * 回执投没投（不投这次派活就等于丢了）。
 *
 * 外部 CLI 那一支覆盖「派出去、跑完、格里落了写入」、观察器的忽略判定，以及起不来时
 * 观察窗口照样收掉：PATH 上放一个假的 `codex.cmd`。
 * 真正的 CLI 会不会照约定输出由真机验收（`scripts/smoke-cli-receipt.ts`）。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  type AgentEvent,
  type ConversationId,
  type EventEnvelope,
  type FollowUp,
  foldWorkflow,
  parseWorkflowCall,
  type RunId,
  type StepId,
  type WorkflowCall,
} from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  appendMessage,
  appendStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  getConversation,
  listConversationChangesPage,
  listMessages,
  listRuns,
  listSteps,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { findCli } from '@qywork/team'
import { openChangeWindow } from '@qywork/tools'
import { EventBus } from './bus.ts'
import { makeDelegate } from './delegate.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

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

const say = (text: string) => () => new Response(textTurn(text), { headers: SSE_HEADERS })

/**
 * 扣住一次请求：等它真的发出来，再把响应放出去。
 *
 * **必须先等 `arrived()`**：派出即返回，子 agent 的请求在 `runGraph` 返回之后才发出去，
 * 提前放响应放的是上一个 resolver，那次请求会一直挂着。
 */
function gate() {
  let release: (response: Response) => void = () => {}
  let arrived = false
  return {
    respond: () =>
      new Promise<Response>((resolve) => {
        release = resolve
        arrived = true
      }),
    arrived: () => arrived,
    open: (text: string) => release(new Response(textTurn(text), { headers: SSE_HEADERS })),
  }
}

/**
 * 按任务正文分流。并行的格谁先发出请求不定，按下标发会串台；
 * 认不出的任务当场 401，那一格落失败终态，不会让子会话自己接着转。
 */
function byTask(map: Record<string, string>) {
  return (body: string) => {
    for (const [needle, text] of Object.entries(map)) {
      if (body.includes(needle)) return new Response(textTurn(text), { headers: SSE_HEADERS })
    }
    return new Response('脚本没有匹配项', { status: 401 })
  }
}

/** 这次请求怎么答。按顺序用完就 401；`router` 非空时改按正文分流。 */
let script: ((body: string) => Response)[] = []
let router: ((body: string) => Response | Promise<Response>) | null = null

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    if (router) return router(body)
    const next = script.shift()
    if (!next) return new Response('脚本已用完', { status: 401 })
    return next(body)
  },
})

let dir = ''
/** 账本放工作区外面：工作区观察窗口扫的是工作区，账本的 WAL 不该被扫成「改动」。 */
let dbDir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []
let receipts: FollowUp[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-delegate-'))
  dbDir = await mkdtemp(join(tmpdir(), 'qywork-delegate-db-'))
  const dbPath = join(dbDir, 'delegate.sqlite3')
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
      '另/接口': {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'qwen/model-3.8': {} },
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
  await rm(dbDir, { recursive: true, force: true }).catch(() => {})
})

/** 每个用例一条干净的会话与一份干净的脚本。 */
function conversation(): ConversationId {
  script = []
  router = null
  events = []
  receipts = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '派活',
  }).id
}

function delegate(conversationId: ConversationId) {
  return makeDelegate({
    deps: { store, content, config, bus, runs, subagents },
    workspaceRoot: dir,
    conversationId,
    deliver: (followUp) => receipts.push(followUp),
  })
}

/** 派出即返回，所以每条断言前都要等那件事真的发生。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等不到：${label}`)
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

function phasesOf(nodeId: string): string[] {
  return members()
    .filter((m) => m.nodeId === nodeId)
    .map((m) => m.state.phase)
}

/** 这一格挂在哪：run 必须是真实的一行，落盘的正文按它登记。 */
function spot(conversationId: ConversationId): { runId: RunId; stepId: string } {
  return { runId: run(conversationId, 'spot'), stepId: 'st_1' }
}

/** 首派参数与真实入口同一条解析路径，节点字段的形状只在 core 定义一次。 */
function parsedStart(args: Record<string, unknown>): WorkflowCall {
  const parsed = parseWorkflowCall(args)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.call
}

/** 一次真实的 workflow 调用：开卡 → 推进 → 按返回值落终态，与工具那条路同形。 */
async function invoke(
  parent: ConversationId,
  runId: RunId,
  seq: number,
  args: Record<string, unknown>,
  call: WorkflowCall,
) {
  const step = appendStep(store, {
    runId,
    seq,
    kind: 'tool_action',
    toolName: 'workflow',
    toolCallId: `call_${seq}_${runId}`,
    status: 'running',
    payload: { kind: 'tool_call', args },
  })
  const result = await delegate(parent).runGraph({ call, runId, stepId: step.id })
  if (result.transition) {
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args,
      outcome: {
        status: 'success',
        executed: true,
        message: '已起跑',
        data: result.transition as unknown as Record<string, unknown>,
      },
    })
  }
  return { step, result }
}

function run(conversationId: ConversationId, key: string): RunId {
  return createRun(store, {
    conversationId,
    workspaceId: workspaceId as never,
    model: 'deepseek-v4-flash',
    clientRequestId: `${key}-${conversationId}`,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

describe('派出即返回', () => {
  test('派出去就回派出事实，产出不在返回值里', async () => {
    const cid = conversation()
    const where = spot(cid)
    script = [say('查完了')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...where,
    })

    expect(res.ok).toBe(true)
    expect(res.subagentId).toBeTruthy()
    expect(res).toMatchObject({ name: '临时', kind: 'temp', created: true })
    expect(res).not.toHaveProperty('output')
    // 返回的那一刻它才刚起跑：卡上是「进行中」，不是终态。
    expect(phasesOf('child')).toEqual(['working'])
    expect(members()[0]?.state.subagentId).toBe(res.subagentId as ConversationId)

    await until(() => phasesOf('child').includes('done'), '子 agent 落终态')
    expect(phasesOf('child')).toEqual(['working', 'done'])
    expect(members().every((m) => m.stepId === 'st_1' && m.runId === where.runId)).toBe(true)
  })

  test('结构化 provider + model 一路写进成员会话，不经过字符串拆分', async () => {
    const cid = conversation()
    script = [say('选型正确')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去执行',
      provider: '另/接口',
      model: 'qwen/model-3.8',
      ...spot(cid),
    })

    expect(res.ok).toBe(true)
    const child = getConversation(store, res.subagentId as ConversationId)
    expect(child?.provider).toBe('另/接口')
    expect(child?.model).toBe('qwen/model-3.8')
    await until(() => !runs.isBusy(cid), '子 agent 结束')
  })

  /** 派不出去那一格直接记失败：没有「跑着」那一帧，也不留一格永远等待。 */
  test('目标不存在时那一格只有一条失败状态，也没有回执', async () => {
    const cid = conversation()
    const res = await delegate(cid).dispatch({
      target: { kind: 'role', role: '查无此角色' },
      task: '执行任务',
      ...spot(cid),
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('查无此角色')
    expect(members().map((m) => m.state.phase)).toEqual(['failed'])
    expect(receipts).toEqual([])
  })

  /**
   * 拿不到卡片 id 时整条不发。发出去也没有卡片认领它（前端按 stepId 找），
   * 只是白广播——而派活本身照跑，回执与终态都不依赖这条通道。
   */
  test('没有卡片 id 时一条状态都不发，活照派、回执照回', async () => {
    const cid = conversation()
    script = [say('查完了')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      runId: 'rn_2',
    })

    expect(res.ok).toBe(true)
    await until(() => receipts.length > 0, '回执')
    expect(members()).toHaveLength(0)
  })

  /**
   * 子会话的事件按**它自己的会话 id** 广播。右侧那一页订阅的就是这个 id——
   * 不发的话它在子 agent 跑完之前一个字都画不出来。
   */
  test('子会话的事件按它自己的 id 发出去，不挂在父会话上', async () => {
    const cid = conversation()
    script = [say('看完了')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '看一眼',
      ...spot(cid),
    })
    await until(() => receipts.length > 0, '回执')

    const child = res.subagentId as ConversationId
    const inner = events.filter((f) => f.conversationId === child)
    expect(inner.map((f) => f.event.type)).toContain('run.started')
    expect(inner.map((f) => f.event.type)).toContain('run.finished')
    expect(runs.isBusy(child)).toBe(false)
    // 父会话那条上只有图卡进度，没有子会话的内层事件。
    expect(
      events
        .filter((f) => f.conversationId === cid)
        .every((f) => f.event.type === 'team.member' || f.event.type === 'team.output'),
    ).toBe(true)
  })

  /**
   * 原始失败形状：子 agent 跑着时切到另一条会话，再切回来会从正在执行的 step 回放。
   * `team.member` 只活在订阅期，入口若等终态才落库，这张回放卡没有 id、节点被禁用。
   */
  test('派出去那一刻子会话入口已经落进这条 step', async () => {
    const cid = conversation()
    const runId = run(cid, 'early-child')
    const step = appendStep(store, {
      runId,
      seq: 1,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: `call_${cid}`,
      status: 'running',
      payload: { kind: 'tool_call', args: { task: '看一眼' } },
    })
    script = [say('看完了')]

    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '看一眼',
      runId,
      stepId: step.id,
    })

    const replay = listSteps(store, runId).find((s) => s.id === step.id)
    const payload = replay?.payload
    expect(payload?.kind).toBe('tool_call')
    expect(payload?.kind === 'tool_call' ? payload.nodes?.child : undefined).toMatchObject({
      phase: 'working',
      label: '临时',
      subagentId: res.subagentId,
    })
    await until(() => !runs.isBusy(cid), '子 agent 结束')
  })
})

describe('回执是一条消息', () => {
  test('做成了：种类、名字、id、产出摘录与续派接法各占一行', async () => {
    const cid = conversation()
    script = [say('查完了，结论是这样')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '查资料' },
      task: '去查一下',
      ...spot(cid),
    })
    await until(() => receipts.length > 0, '回执')

    const receipt = receipts[0]!
    expect(receipt.origin).toBe('subagent')
    expect(receipt.steer).toBe(true)
    const lines = receipt.content.split('\n')
    expect(lines[0]).toBe(`[子 agent 回执] 临时 查资料（subagentId ${res.subagentId}）已返回`)
    expect(receipt.content).toContain('查完了，结论是这样')
    // 只有事实：接法在工具描述里，回执里再写一遍就是给模型的口水。
    expect(receipt.content).not.toContain('接着派它')
    expect(lines).toHaveLength(2)
  })

  test('没做成：第一行就写清原因', async () => {
    const cid = conversation()
    // 脚本空着 = 401，子会话当场终结。
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })
    await until(() => receipts.length > 0, '回执')

    expect(receipts[0]?.content.split('\n')[0]).toContain(
      `[子 agent 回执] 临时 临时（subagentId ${res.subagentId}）没做成：`,
    )
    expect(phasesOf('child')).toEqual(['working', 'failed'])
  })

  /** 产出过投递闸：一份没有上界的正文整段进上下文，压缩层已经无从下手。 */
  test('超长产出在回执里是有界摘录加定位符', async () => {
    const cid = conversation()
    const huge = '审查结论。'.repeat(40_000)
    script = [say(huge)]
    await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })
    await until(() => receipts.length > 0, '回执')

    const content = receipts[0]!.content
    expect(content.length).toBeLessThan(huge.length)
    expect(content).toContain('read_resource')
  })
})

describe('在跑表按会话', () => {
  test('派出与结束各报一次忙态，子 agent 在跑时会话是忙的', async () => {
    const cid = conversation()
    script = [say('查完了')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })

    expect(runs.isBusy(cid)).toBe(true)
    // 起轮的闸不含子 agent：它在跑不该挡住这条会话开新一轮。
    expect(runs.hasRun(cid)).toBe(false)
    expect(subagents.listOf(cid)).toEqual([
      { subagentId: res.subagentId as string, name: '临时', kind: 'temp' },
    ])

    await until(() => !runs.isBusy(cid), '子 agent 结束')
    expect(subagents.listOf(cid)).toEqual([])
    const busy = events
      .filter((f) => f.event.type === 'conversation.busy' && f.event.conversationId === cid)
      .map((f) => (f.event.type === 'conversation.busy' ? f.event.busy : null))
    expect(busy).toEqual([true, false])
  })

  /** 停止按会话全停：格落中断，而且**不发回执**——投一条进去等于停完又起一轮。 */
  test('按会话停止：格落中断，不投回执', async () => {
    const cid = conversation()
    router = () =>
      new Response(sse([{ type: 'response.created', response: { id: 'r' } }]), {
        headers: SSE_HEADERS,
      })
    await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })
    expect(subagents.interruptConversation(cid)).toBe(true)

    await until(() => phasesOf('child').includes('interrupted'), '格落中断')
    expect(receipts).toEqual([])
    expect(runs.isBusy(cid)).toBe(false)
  })

  test('没有在跑的子 agent 时停止返回 false', () => {
    const cid = conversation()
    expect(subagents.interruptConversation(cid)).toBe(false)
  })
})

describe('图按事件推进', () => {
  const twoStage = {
    goal: '两段做完',
    nodes: [
      { id: 'a', kind: 'temp', name: 'a', task: '做 A' },
      { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
      { id: 'b', kind: 'temp', name: 'b', task: '做 B', needs: ['cp'] },
      { id: 'cp2', kind: 'checkpoint', label: '再审查', needs: ['b'] },
    ],
  }

  test('首派只派就绪的格，全图先标等待', async () => {
    const parent = conversation()
    router = byTask({ '做 A': 'A 的产出' })
    const runId = run(parent, 'wf-first')
    const { result } = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))

    expect(result.ok).toBe(true)
    expect(result.transition?.dispatched).toEqual(['a'])
    expect(result.completed).toBe(false)
    // 刷新之后要看得见全貌：没派的格也有一帧等待。
    expect(phasesOf('b')).toEqual(['waiting'])
    await until(() => receipts.length > 0, '检查点回执')
  })

  /**
   * 解析目标要 await（读角色库、探测 CLI）。那段窗口里另一格跑完会重新推进一次，
   * 而那时这一格在账本上还没有状态——推进器会把它再派一次，同一格因此有两个子 agent。
   */
  test('推进返回时派出去的格在账本上已经是 working', async () => {
    const parent = conversation()
    const slow = gate()
    router = slow.respond
    const runId = run(parent, 'wf-reserve')
    const { step } = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))

    // 同步断言：这一刻子 agent 连请求都还没发出去，格上却已经写着「进行中」。
    const states = (
      listSteps(store, runId).find((s) => s.id === step.id)?.payload as {
        nodes?: Record<string, { phase: string }>
      }
    ).nodes
    expect(states?.a?.phase).toBe('working')

    await until(slow.arrived, '子 agent 发出请求')
    slow.open('A 的产出')
    await until(() => receipts.length > 0, '检查点回执')
  })

  test('一格跑完到检查点：回执列出上游各格，末行只有 id', async () => {
    const parent = conversation()
    router = byTask({ '做 A': 'A 的产出' })
    const runId = run(parent, 'wf-checkpoint')
    const { step } = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))
    await until(() => receipts.length > 0, '检查点回执')

    const receipt = receipts[0]!
    expect(receipt.origin).toBe('workflow')
    expect(receipt.content).toContain('[workflow 回执] 检查点 主会话审查 的上游已经全部返回')
    expect(receipt.content).toContain('### a（a）已返回')
    expect(receipt.content).toContain('A 的产出')
    expect(receipt.content).toContain(`workflowId=${step.id}，checkpointId=cp`)
    // 接法在工具描述里，回执不再教一遍。
    expect(receipt.content).not.toContain('approve')
  })

  test('approve 之后派下一批，全部批准且格全终态时报完成', async () => {
    const parent = conversation()
    router = byTask({ '做 A': 'A 的产出', '做 B': 'B 的产出' })
    const runId = run(parent, 'wf-approve')
    const first = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))
    await until(() => receipts.length > 0, '检查点回执')

    const approveArgs = {
      workflowId: first.step.id,
      checkpointId: 'cp',
      decision: 'approve' as const,
      note: '通过',
    }
    const second = await invoke(parent, runId, 2, approveArgs, {
      kind: 'review',
      ...approveArgs,
      revisions: [],
    })
    expect(second.result.transition?.dispatched).toEqual(['b'])
    expect(second.result.transition?.review).toMatchObject({
      checkpointId: 'cp',
      decision: 'approve',
    })
    await until(() => receipts.length > 1, '第二个检查点回执')
    expect(receipts[1]?.content).toContain('checkpointId=cp2')

    const cp2Args = {
      workflowId: first.step.id,
      checkpointId: 'cp2',
      decision: 'approve' as const,
      note: '收工',
    }
    const third = await invoke(parent, runId, 3, cp2Args, {
      kind: 'review',
      ...cp2Args,
      revisions: [],
    })
    expect(third.result.completed).toBe(true)
  })

  test('一格失败：先单发失败回执，其余格照跑', async () => {
    const parent = conversation()
    const parallel = {
      goal: '两个候选',
      nodes: [
        { id: 'x', kind: 'temp', name: 'x', task: '做 X' },
        { id: 'y', kind: 'temp', name: 'y', task: '做 Y' },
        { id: 'cp', kind: 'checkpoint', label: '验收', needs: ['x', 'y'] },
      ],
    }
    const slow = gate()
    router = (body) => {
      if (body.includes('做 X')) return new Response('脚本没有匹配项', { status: 401 })
      // Y 慢：失败回执必须在它跑完之前就到。
      return slow.respond()
    }
    const runId = run(parent, 'wf-fail')
    await invoke(parent, runId, 1, parallel, parsedStart(parallel))

    await until(() => receipts.length > 0, '失败回执')
    expect(receipts[0]?.origin).toBe('workflow')
    expect(receipts[0]?.content).toContain('[workflow 回执] x（x）没做成')
    expect(receipts[0]?.content).toContain('workflowId=')
    expect(receipts[0]?.content).not.toContain('其余格照跑')
    expect(phasesOf('y').at(-1)).toBe('working')

    await until(slow.arrived, 'Y 发出请求')
    slow.open('Y 的产出')
    await until(() => receipts.length > 1, '检查点回执')
    expect(receipts[1]?.content).toContain('检查点 验收 的上游已经全部返回')
    expect(receipts[1]?.content).toContain('### x（x）没做成')
  })

  test('上游没成功时下游跳过，检查点照样到得了', async () => {
    const parent = conversation()
    const chain = {
      goal: '串起来',
      nodes: [
        { id: 'a', kind: 'temp', name: 'a', task: '做 A' },
        { id: 'b', kind: 'temp', name: 'b', task: '做 B', needs: ['a'] },
        { id: 'cp', kind: 'checkpoint', label: '验收', needs: ['b'] },
      ],
    }
    router = () => new Response('脚本没有匹配项', { status: 401 })
    const runId = run(parent, 'wf-skip')
    await invoke(parent, runId, 1, chain, parsedStart(chain))

    await until(() => phasesOf('b').includes('skipped'), 'b 落跳过')
    await until(() => receipts.some((r) => r.content.includes('检查点 验收')), '检查点回执')
  })

  /** 图跑着时刷新页面要能重画：子会话 id 必须在派出时按节点写进这条 step。 */
  test('每个节点的子会话入口按节点落库，节点 id 带点号也不当路径解析', async () => {
    const parent = conversation()
    const dotted = {
      goal: '两个候选',
      nodes: [
        { id: 'build.glm', kind: 'temp', name: 'build.glm', task: '做 glm 版' },
        { id: 'build.qwen', kind: 'temp', name: 'build.qwen', task: '做 qwen 版' },
        { id: 'audit', kind: 'checkpoint', label: '验收', needs: ['build.glm', 'build.qwen'] },
      ],
    }
    router = byTask({ '做 glm 版': 'glm 稿', '做 qwen 版': 'qwen 稿' })
    const runId = run(parent, 'wf-dotted')
    const { step } = await invoke(parent, runId, 1, dotted, parsedStart(dotted))
    await until(() => receipts.length > 0, '检查点回执')

    const replay = listSteps(store, runId).find((s) => s.id === step.id)
    const states = replay?.payload?.kind === 'tool_result' ? replay.payload.nodes : undefined
    expect(Object.keys(states ?? {}).sort()).toEqual(['build.glm', 'build.qwen'])
    for (const state of Object.values(states ?? {})) {
      expect(state.phase).toBe('done')
      expect(state.subagentId).toBeTruthy()
      expect(state.output).toBeTruthy()
    }
  })

  /**
   * 原始失败形状：agent 节点全部失败，主会话仍在检查点批准，此后要让其中一个节点
   * 在它自己那条子会话里继续做。批准即解散时模型只剩 subagent，而那条每次新建会话。
   */
  test('approve 之后 revise 仍向首派那条子会话续发', async () => {
    const parent = conversation()
    const both = {
      goal: '各做一版',
      nodes: [
        { id: 'build-glm', kind: 'temp', name: 'build-glm', task: '做 glm 版' },
        { id: 'build-qwen', kind: 'temp', name: 'build-qwen', task: '做 qwen 版' },
        {
          id: 'audit-builds',
          kind: 'checkpoint',
          label: '主会话验收',
          needs: ['build-glm', 'build-qwen'],
        },
      ],
    }
    router = byTask({
      '做 glm 版': 'glm 初稿',
      '做 qwen 版': 'qwen 初稿',
      '按 bug 列表继续改': 'qwen 修订稿',
    })
    const runId = run(parent, 'wf-reflow')
    const first = await invoke(parent, runId, 1, both, parsedStart(both))
    await until(() => receipts.length > 0, '检查点回执')

    const folded = foldWorkflow(
      listSteps(store, runId)
        .filter((s) => s.toolName === 'workflow')
        .map((s) => ({
          stepId: s.id,
          ...(s.payload?.kind === 'tool_result' && s.payload.args ? { args: s.payload.args } : {}),
          ...(s.payload?.kind === 'tool_result' ? { outcome: s.payload.outcome } : {}),
          ...(s.payload?.kind === 'tool_result' && s.payload.nodes
            ? { nodes: s.payload.nodes }
            : {}),
          status: 'success' as const,
        })),
      first.step.id,
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    const qwenChild = folded.projection.results['build-qwen']?.subagentId
    expect(qwenChild).toBeTruthy()

    const approveArgs = {
      workflowId: first.step.id,
      checkpointId: 'audit-builds',
      decision: 'approve' as const,
      note: '均已产生代码，现批准',
    }
    const approved = await invoke(parent, runId, 2, approveArgs, {
      kind: 'review',
      ...approveArgs,
      revisions: [],
    })
    expect(approved.result.completed).toBe(true)

    const reviseArgs = {
      workflowId: first.step.id,
      checkpointId: 'audit-builds',
      decision: 'revise' as const,
      note: '继续优化 qwen 版',
      revisions: [{ nodeId: 'build-qwen', instruction: '按 bug 列表继续改' }],
    }
    const revised = await invoke(parent, runId, 3, reviseArgs, { kind: 'review', ...reviseArgs })
    expect(revised.result.transition?.dispatched).toEqual(['build-qwen'])
    // 续发到首派那条子会话，不是新开一条。
    const lastAsked = () =>
      listMessages(store, qwenChild as ConversationId)
        .filter((message) => message.role === 'user')
        .at(-1)?.content ?? ''
    await until(() => lastAsked().includes('按 bug 列表继续改'), '续发指令进原子会话')
  })

  test('首派落失败终态之后 approve 报重新派发，不再说不是待审查状态', async () => {
    const parent = conversation()
    const runId = run(parent, 'wf-dead')
    const args = {
      goal: '目标',
      nodes: [
        { id: 'a', kind: 'temp', name: 'a', task: '做' },
        { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
      ],
    }
    const step = appendStep(store, {
      runId,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_dead',
      status: 'running',
      payload: { kind: 'tool_call', args },
    })
    // 进程退出收尾把 running 的 step 原地落成没有 transition 数据的失败终态。
    settleToolStep(store, step.id, 'failure', {
      kind: 'tool_result',
      args,
      outcome: { status: 'failure', executed: true, message: '上一轮在工具执行期间中断' },
    })

    const result = await delegate(parent).runGraph({
      call: {
        kind: 'review',
        workflowId: step.id,
        checkpointId: 'cp',
        decision: 'approve',
        note: '接受',
        revisions: [],
      },
      runId,
      stepId: 'st_dead_review' as StepId,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已失败，请重新派发')
  })

  test('普通会话不能被伪装成 workflow 子节点续接', async () => {
    const parent = conversation()
    const ordinary = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      title: '普通会话',
    })
    const args = {
      goal: '目标',
      nodes: [
        { id: 'a', subagent: ordinary.id, task: '接着做' },
        { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
      ],
    }
    const runId = run(parent, 'wf-foreign')
    const step = appendStep(store, {
      runId,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_foreign',
      status: 'running',
      payload: { kind: 'tool_call', args },
    })
    const result = await delegate(parent).runGraph({
      call: parsedStart(args),
      runId,
      stepId: step.id,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不在本会话里')
    expect(listRuns(store, ordinary.id)).toHaveLength(0)
  })

  /** 续接已有子 agent 的格接的是它自己的会话：历史在那边，任务不重抄一遍。 */
  test('续接已有子 agent 的格发进同一条子会话', async () => {
    const parent = conversation()
    const child = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
      title: '节点 a',
      source: 'temp',
      parentConversationId: parent,
    })
    appendMessage(store, { conversationId: child.id, role: 'user', content: '先给一个初稿' })
    const args = {
      goal: '目标',
      nodes: [
        { id: 'a', subagent: child.id, task: '补充两条可核验证据' },
        { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
      ],
    }
    router = byTask({ 补充两条可核验证据: '修订稿：已经补充两条证据' })
    const runId = run(parent, 'wf-resume')
    await invoke(parent, runId, 1, args, parsedStart(args))
    await until(
      () =>
        listMessages(store, child.id)
          .filter((message) => message.role === 'user')
          .at(-1)
          ?.content.includes('补充两条可核验证据') === true &&
        receipts.some((receipt) => receipt.content.includes('修订稿：已经补充两条证据')),
      '续接任务与检查点回执',
    )

    expect(
      listMessages(store, child.id)
        .filter((message) => message.role === 'user')
        .at(-1)?.content,
    ).toContain('补充两条可核验证据')
    expect(receipts.some((receipt) => receipt.content.includes('修订稿：已经补充两条证据'))).toBe(
      true,
    )
    expect(listRuns(store, child.id)).toHaveLength(1)
  })
})

/**
 * 变更页并进子 agent 与外部 CLI 的写入，走真链路：
 * - 内置子 agent：假 provider 让子会话真的调 `write_file`，写入落在子会话的 step 里，
 *   投影按父 step 的 `subagentId` 与执行窗口归到父轮；
 * - 外部 CLI：PATH 上放一个假的 `codex.cmd`，它往工作区写一个文件，
 *   派活期间的工作区观察窗口把路径写进那一格，投影从格里取。
 */
describe('变更页并进子 agent 与外部 CLI 的写入', () => {
  /** 子会话第一轮：调 write_file 往工作区写一个文件。 */
  function writeTurn(path: string, content: string): string {
    return sse([
      { type: 'response.created', response: { id: 'resp_write' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_w', call_id: 'call_w', name: 'write_file' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_w',
        delta: JSON.stringify({ path, mode: 'create', content }),
      },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_write',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ])
  }

  /** 父会话里一条有用户消息的轮，派活 step 是真实的一行：投影按它归轮。 */
  function parentTurn(cid: ConversationId, text: string) {
    const user = appendMessage(store, { conversationId: cid, role: 'user', content: text })
    const runId = createRun(store, {
      conversationId: cid,
      workspaceId: workspaceId as never,
      model: 'deepseek-v4-flash',
      clientRequestId: `changes-${cid}`,
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    }).id
    const step = appendStep(store, {
      runId,
      seq: 1,
      kind: 'tool_action',
      toolName: 'subagent',
      status: 'running',
      payload: { kind: 'tool_call', args: { task: text } },
    })
    return { runId, step }
  }

  /** 派出即返回：真实的循环在派出后立刻收尾这一步，时长只有一百多毫秒，子会话还在跑。 */
  function settle(stepId: string, task: string) {
    settleToolStep(
      store,
      stepId as StepId,
      'success',
      {
        kind: 'tool_result',
        args: { task },
        outcome: { status: 'success', executed: true, message: '已派出' },
      },
      1,
    )
  }

  test('子会话里的 write_file 出现在父轮里，标着子 agent 的名字', async () => {
    const cid = conversation()
    const { runId, step } = parentTurn(cid, '派个写手')
    script = [
      () => new Response(writeTurn('sub.txt', 'hello\n'), { headers: SSE_HEADERS }),
      say('写完了'),
    ]

    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '写手' },
      task: '写一个文件',
      runId,
      stepId: step.id,
    })
    expect(res.ok).toBe(true)
    settle(step.id, '派个写手')
    await until(
      () =>
        members().some(
          (member) =>
            member.nodeId === 'child' &&
            member.state.subagentId === res.subagentId &&
            member.state.phase === 'done',
        ),
      '本次子 agent 落终态',
    )
    expect(await Bun.file(join(dir, 'sub.txt')).text()).toBe('hello\n')
    // 来源在建 run 时就写上了：投影按它归轮，不看时间。
    expect(listRuns(store, res.subagentId as ConversationId).at(-1)).toMatchObject({
      dispatchStepId: step.id,
      dispatchNodeId: 'child',
    })
    const page = listConversationChangesPage(store, cid, { limit: 10 })
    expect(page.turns.map((t) => t.text)).toEqual(['派个写手'])
    expect(
      page.turns[0]?.steps.map((s) => [
        s.toolName,
        s.via?.name,
        s.fileChanges.map((c) => [c.path, c.changeType, typeof c.additions === 'number']),
      ]),
    ).toEqual([['write_file', '写手', [['sub.txt', 'created', true]]]])
    expect(page.totals.paths).toEqual(['sub.txt'])
    expect(page.totals.additions).toBeGreaterThan(0)
  })

  test('外部 CLI 改的文件出现在父轮里，标着节点名；项目点路径进账，被忽略的缓存不进', async () => {
    const bin = join(dir, 'fake-bin')
    await mkdir(bin, { recursive: true })
    // 假的 codex：不看参数，往当前目录写三个文件（普通、项目点路径、被忽略的缓存），
    // 再按 codex 的 jsonl 形状报一句结果。两份写法都放：Windows 按 PATHEXT 取 `.cmd`，
    // POSIX 取无后缀的 sh 脚本。
    await writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        'echo made > cli-made.txt',
        'mkdir -p .github/workflows',
        'echo ci > .github/workflows/ci.yml',
        'mkdir -p .profile-cache',
        'echo x > .profile-cache/state.bin',
        `echo '{"type":"item.completed","item":{"text":"done"}}'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    await writeFile(
      join(bin, 'codex.cmd'),
      [
        '@echo off',
        'echo made> "%CD%\\cli-made.txt"',
        'mkdir "%CD%\\.github\\workflows" 2>nul',
        'echo ci> "%CD%\\.github\\workflows\\ci.yml"',
        'mkdir "%CD%\\.profile-cache" 2>nul',
        'echo x> "%CD%\\.profile-cache\\state.bin"',
        'echo {"type":"item.completed","item":{"text":"done"}}',
        '',
      ].join('\r\n'),
    )
    // 观察器的忽略判定问的是 git，忽略规则得有来源，所以这条测试把夹具目录做成仓库。
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    await writeFile(join(dir, '.gitignore'), '.profile-cache/\n')
    const env = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    // 只留假 CLI、系统目录（Windows 上 `.cmd` 要靠 cmd.exe 起，POSIX 上脚本要用 sleep 与 mkdir）与 git
    // 所在目录；凭证判据是这个变量有值。
    // git 必须留着：观察器收尾时要起它判忽略规则，找不到就只能报观察范围不完整。
    const gitDir = dirname(Bun.which('git') ?? '')
    const sys =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        : dirname(Bun.which('mkdir') ?? '/bin/mkdir')
    process.env.PATH = [bin, sys, gitDir].join(delimiter)
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      const cid = conversation()
      const { runId, step } = parentTurn(cid, '派给 codex')
      const res = await delegate(cid).dispatch({
        target: { kind: 'cli', cli: 'codex', name: 'codex 节点' },
        task: '改一个文件',
        runId,
        stepId: step.id,
      })
      expect(res).toMatchObject({ ok: true, kind: 'cli' })
      settle(step.id, '派给 codex')
      await until(() => phasesOf('child').includes('done'), 'CLI 落终态')

      expect(await Bun.file(join(dir, 'cli-made.txt')).exists()).toBe(true)
      expect(await Bun.file(join(dir, '.profile-cache', 'state.bin')).exists()).toBe(true)
      const page = listConversationChangesPage(store, cid, { limit: 10 })
      expect(page.turns.map((t) => t.text)).toEqual(['派给 codex'])
      expect(
        page.turns[0]?.steps.map((s) => [
          s.toolName,
          s.via?.name,
          s.fileChanges.map((c) => [c.path, c.changeType, c.additions]).sort(),
        ]),
      ).toEqual([
        [
          'cli',
          'codex 节点',
          [
            ['.github/workflows/ci.yml', 'created', 2],
            ['cli-made.txt', 'created', 2],
          ],
        ],
      ])
      // 项目的点路径进账，被 `.gitignore` 挡住的缓存不进。
      expect([...page.totals.paths].sort()).toEqual(['.github/workflows/ci.yml', 'cli-made.txt'])
      expect(page.totals.additions).toBe(4)
      expect(page.totals.deletions).toBe(0)
    } finally {
      process.env.PATH = env.PATH
      if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
    }
  })

  /**
   * 原始失败形状：外部 CLI 起不来（`Bun.spawn` 找不到可执行文件）时观察窗口没有收掉。窗口先于进程
   * 打开，漏收的那个一直排在最前，此后同一工作区的窗口收不到任何事件，删除一条都报不出来。
   */
  test('外部 CLI 起不来时收掉观察窗口，此后的窗口照常收到删除', async () => {
    const bin = join(dir, 'vanished-bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(bin, 'codex.cmd'), '@echo off\r\n')
    const env = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    process.env.PATH = bin
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      // 识别结果按 PATH 缓存：先识别到再删掉文件，派活时 spawn 才找不到它。
      expect((await findCli('codex'))?.id).toBe('codex')
      await rm(bin, { recursive: true, force: true })
      const cid = conversation()
      const { runId, step } = parentTurn(cid, '派给不存在的 codex')
      const res = await delegate(cid).dispatch({
        target: { kind: 'cli', cli: 'codex', name: 'codex 节点' },
        task: '改一个文件',
        runId,
        stepId: step.id,
      })
      expect(res).toMatchObject({ ok: true, kind: 'cli' })
      settle(step.id, '派给不存在的 codex')
      await until(() => phasesOf('child').includes('failed'), 'CLI 落失败终态')
    } finally {
      process.env.PATH = env.PATH
      if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
    }

    // 删除只有事件看得见，收尾扫描补不上：前一个窗口漏收时这一条报不出来。
    await writeFile(join(dir, 'doomed.txt'), 'x\n')
    const window = openChangeWindow(dir)
    await Bun.sleep(250)
    await rm(join(dir, 'doomed.txt'))
    await Bun.sleep(250)
    const got = await window.close()
    expect(got.changes).toContainEqual({ path: 'doomed.txt', changeType: 'deleted' })
  })
})
