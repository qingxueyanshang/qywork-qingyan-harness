/**
 * 任务派发通道的事件形状。使用假 provider 运行真实链路，不产生费用，不访问网络。
 *
 * 覆盖范围：`delegate.ts` 的 `makeDelegate()`：派发后立即返回、完成回调写入节点状态与回执、
 * 回执正文的形状、按会话停止、图的推进（首次派发 → 一个节点执行完毕后派发下游 → 一个节点失败时先发送失败回执 →
 * 上游全部完成后发送检查点回执 → approve / revise），以及 `subagents.ts` 的运行表。
 *
 * 使用真实链路的原因：该通道的行为是「派发之后，卡片上对应的节点随之更新，回执自动返回」。
 * 把 `runBuiltinMember` 换成桩只能验证「桩被调用」；实际可能出错的是装配：
 * 事件是否携带 stepId（不携带则前端整条丢弃）、终态是否发送（不发送则该节点始终停在进行中）、
 * 回执是否投递（不投递则本次派发等同于丢失）。
 *
 * 外部 CLI 分支覆盖「派发、执行完毕、节点记录写入」、观察器的忽略判定，以及无法启动时
 * 观察窗口照常关闭：在 PATH 上放置一个假的 `codex.cmd`。
 * 实际 CLI 是否按约定输出由真机验收（`scripts/smoke-cli-receipt.ts`）。
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

/** 一轮纯文本回复：子 agent 输出该句后结束，该句即为产出。 */
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
 * 暂缓应答一次请求：等待请求实际发出后，再返回响应。
 *
 * **必须先等待 `arrived()`**：派发后立即返回，子 agent 的请求在 `runGraph` 返回之后才发出，
 * 提前返回响应会作用于上一个 resolver，该次请求将一直挂起。
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
 * 按任务正文分流。并行节点发出请求的先后顺序不确定，按下标应答会错配；
 * 无法识别的任务立即返回 401，该节点写入失败终态，子会话不会继续执行。
 */
function byTask(map: Record<string, string>) {
  return (body: string) => {
    for (const [needle, text] of Object.entries(map)) {
      if (body.includes(needle)) return new Response(textTurn(text), { headers: SSE_HEADERS })
    }
    return new Response('脚本没有匹配项', { status: 401 })
  }
}

/** 本次请求的应答。按顺序用完后返回 401；`router` 非空时改为按正文分流。 */
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
/** 账本放在工作区之外：工作区观察窗口扫描的是工作区，账本的 WAL 不应被识别为「改动」。 */
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

/** 每个用例使用新的会话与新的脚本。 */
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

/** 派发后立即返回，因此每条断言前都须等待对应事件实际发生。 */
async function until(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等不到：${label}`)
}

/**
 * 已广播的成员事件，按发送顺序排列。
 *
 * 成员类型按 `type` 收窄取得：`@qywork/core` 不逐个导出事件成员，
 * 它们只出现在 `AgentEvent` 可辨识联合中。
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

/** 节点所属的 run 与 step：run 必须是真实存在的一行，落盘的正文按它登记。 */
function spot(conversationId: ConversationId): { runId: RunId; stepId: string } {
  return { runId: run(conversationId, 'spot'), stepId: 'st_1' }
}

/** 首次派发的参数与真实入口使用同一条解析路径，节点字段的结构只在 core 中定义一次。 */
function parsedStart(args: Record<string, unknown>): WorkflowCall {
  const parsed = parseWorkflowCall(args)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.call
}

/** 一次真实的 workflow 调用：创建卡片 → 推进 → 按返回值写入终态，与工具的调用路径一致。 */
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

/** 替换指定厂商的本机入口，保持真实探测、进程执行、调度和账本链路。 */
async function withCliOutput(
  id: string,
  stdout: string,
  exitCode: number,
  check: () => Promise<void>,
) {
  const bin = await mkdtemp(join(dir, 'receipt-cli-'))
  const code = `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exitCode};`
  await mkdir(join(bin, 'node_modules', 'fake-cli'), { recursive: true })
  await writeFile(join(bin, 'node_modules', 'fake-cli', 'index.js'), code)
  await writeFile(join(bin, id), `#!/usr/bin/env node\n${code}\n`, { mode: 0o755 })
  await writeFile(
    join(bin, `${id}.cmd`),
    [
      '@ECHO off',
      'SET dp0=%~dp0',
      'SET "_prog=node"',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\index.js" %*',
      '',
    ].join('\r\n'),
  )
  const path = process.env.PATH
  process.env.PATH = [bin, path].filter(Boolean).join(delimiter)
  try {
    await check()
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
}

describe('外部 CLI 失败回执', () => {
  test('六种 CLI 的失败进入节点、持久化记录和单项回执', async () => {
    const cases = [
      {
        id: 'codex',
        stdout: [
          { type: 'thread.started', thread_id: 'failed-codex-session' },
          { type: 'turn.failed', error: { message: 'Codex 模型不可用' } },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n'),
        exitCode: 1,
        error: 'Codex 模型不可用',
        session: 'failed-codex-session',
      },
      {
        id: 'claude',
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['Claude 达到轮次上限'],
          session_id: 'failed-claude-session',
        }),
        exitCode: 0,
        error: 'Claude 达到轮次上限',
        session: 'failed-claude-session',
      },
      {
        id: 'grok',
        stdout: JSON.stringify({
          text: '已开始',
          stopReason: 'cancelled',
          sessionId: 'failed-grok-session',
        }),
        exitCode: 0,
        error: 'cancelled',
        session: 'failed-grok-session',
      },
      { id: 'gemini', stdout: '登录失效', exitCode: 1, error: '登录失效' },
      { id: 'qwen', stdout: '', exitCode: 0, error: '没有返回有效结果' },
      { id: 'kimi', stdout: '', exitCode: 0, error: '没有返回有效结果' },
    ]
    for (const sample of cases) {
      await withCliOutput(sample.id, sample.stdout, sample.exitCode, async () => {
        const cid = conversation()
        const runId = run(cid, `调用 ${sample.id}`)
        const step = appendStep(store, {
          runId,
          seq: 1,
          kind: 'tool_action',
          toolName: 'subagent',
          toolCallId: `call_${cid}`,
          status: 'running',
          payload: { kind: 'tool_call', args: { task: '验证任务' } },
        })
        const result = await delegate(cid).dispatch({
          target: { kind: 'cli', cli: sample.id },
          task: '验证任务',
          runId,
          stepId: step.id,
        })
        expect(result.ok).toBe(true)
        await until(() => receipts.length > 0, `${sample.id} 失败回执`, 10_000)
        expect(members().at(-1)?.state.phase).toBe('failed')
        expect(members().at(-1)?.state.error).toContain(sample.error)
        expect(receipts[0]?.content).toContain(sample.error)
        expect(JSON.stringify(listSteps(store, runId))).toContain(sample.error)
        if (sample.session) {
          expect(getConversation(store, result.subagentId as ConversationId)?.externalSession).toBe(
            sample.session,
          )
        }
      })
    }
  }, 30_000)

  test('工作流外部 CLI 的具体错误进入回执，依赖节点不按成功推进', async () => {
    await withCliOutput(
      'codex',
      JSON.stringify({ type: 'turn.failed', error: { message: '上游拒绝该模型' } }),
      1,
      async () => {
        const cid = conversation()
        const graph = {
          goal: '失败链路验证',
          nodes: [
            { id: 'external', kind: 'cli', cli: 'codex', task: '执行任务' },
            { id: 'next', kind: 'temp', name: '后续', task: '继续', needs: ['external'] },
            { id: 'check', kind: 'checkpoint', label: '检查', needs: ['next'] },
          ],
        }
        const runId = run(cid, 'cli-error-graph')
        await invoke(cid, runId, 1, graph, parsedStart(graph))
        await until(() => phasesOf('next').includes('skipped'), '依赖节点跳过', 10_000)
        expect(receipts.map((receipt) => receipt.content).join('\n')).toContain('上游拒绝该模型')
        expect(JSON.stringify(listSteps(store, runId))).toContain('上游拒绝该模型')
      },
    )
  })
})

describe('派发后立即返回', () => {
  test('派发后立即返回派发事实，产出不在返回值中', async () => {
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
    // 返回时任务刚开始执行：卡片显示「进行中」，而不是终态。
    expect(phasesOf('child')).toEqual(['working'])
    expect(members()[0]?.state.subagentId).toBe(res.subagentId as ConversationId)

    await until(() => phasesOf('child').includes('done'), '子 agent 落终态')
    expect(phasesOf('child')).toEqual(['working', 'done'])
    expect(members().every((m) => m.stepId === 'st_1' && m.runId === where.runId)).toBe(true)
  })

  test('结构化 provider + model 沿整条链路写入成员会话，不经过字符串拆分', async () => {
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

  /** 无法派发的节点直接记为失败：不产生「运行中」状态，也不遗留永远等待的节点。 */
  test('目标不存在时该节点只有一条失败状态，也没有回执', async () => {
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
   * 无法取得卡片 id 时不发送任何状态：发出后也没有卡片认领（前端按 stepId 查找），
   * 只是无效广播；任务派发本身照常执行，回执与终态均不依赖该通道。
   */
  test('没有卡片 id 时不发送任何状态，任务照常派发、回执照常返回', async () => {
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
   * 子会话的事件按其自身的会话 id 广播。右侧面板订阅的即是该 id：
   * 不按该 id 发送时，右侧面板在子 agent 执行完毕之前无法渲染任何内容。
   */
  test('子会话的事件按其自身的 id 发送，不归入父会话', async () => {
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
    // 父会话中只有图卡进度，没有子会话的内层事件。
    expect(
      events
        .filter((f) => f.conversationId === cid)
        .every((f) => f.event.type === 'team.member' || f.event.type === 'team.output'),
    ).toBe(true)
  })

  /**
   * 原始失败形状：子 agent 运行时切换到另一条会话，再切换回来时从正在执行的 step 回放。
   * `team.member` 只存在于订阅期间，入口若等到终态才落库，回放的卡片没有 id，节点被禁用。
   */
  test('派发时子会话入口已写入这条 step', async () => {
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
  test('成功：种类、名称、id、产出摘录与续派方式各占一行', async () => {
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
    // 只包含事实：续派方式已写在工具描述中，回执中重复只会增加冗余内容。
    expect(receipt.content).not.toContain('接着派它')
    expect(lines).toHaveLength(2)
  })

  test('失败：第一行写明原因', async () => {
    const cid = conversation()
    // 脚本为空时返回 401，子会话立即终止。
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })
    await until(() => receipts.length > 0, '回执')

    expect(receipts[0]?.content.split('\n')[0]).toContain(
      `[子 agent 回执] 临时 临时（subagentId ${res.subagentId}）失败：`,
    )
    expect(phasesOf('child')).toEqual(['working', 'failed'])
  })

  /** 产出经过投递限制：没有上限的正文若整段进入上下文，压缩层无法处理。 */
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

describe('运行表按会话管理', () => {
  test('派发与结束各报告一次忙态，子 agent 运行时会话处于忙碌状态', async () => {
    const cid = conversation()
    script = [say('查完了')]
    const res = await delegate(cid).dispatch({
      target: { kind: 'temp', name: '临时' },
      task: '去查一下',
      ...spot(cid),
    })

    expect(runs.isBusy(cid)).toBe(true)
    // 发起轮次的忙碌检查不包含子 agent：子 agent 运行中不应阻止该会话发起新一轮。
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

  /** 按会话停止时全部停止：节点写入中断状态，且不发送回执，因为投递回执会在停止后再次发起一轮。 */
  test('按会话停止：节点写入中断，不投递回执', async () => {
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

  test('没有运行中的子 agent 时停止返回 false', () => {
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

  test('首次派发只派发就绪的节点，全图先标记为等待', async () => {
    const parent = conversation()
    router = byTask({ '做 A': 'A 的产出' })
    const runId = run(parent, 'wf-first')
    const { result } = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))

    expect(result.ok).toBe(true)
    expect(result.transition?.dispatched).toEqual(['a'])
    expect(result.completed).toBe(false)
    // 刷新之后须能看到全貌：未派发的节点也有一条等待状态。
    expect(phasesOf('b')).toEqual(['waiting'])
    await until(() => receipts.length > 0, '检查点回执')
  })

  /**
   * 解析目标需要 await（读取角色库、探测 CLI）。在此期间另一个节点执行完毕会重新推进一次，
   * 而此时该节点在账本中尚无状态：推进器会再次派发它，同一节点因此有两个子 agent。
   */
  test('推进返回时已派发的节点在账本中已是 working', async () => {
    const parent = conversation()
    const slow = gate()
    router = slow.respond
    const runId = run(parent, 'wf-reserve')
    const { step } = await invoke(parent, runId, 1, twoStage, parsedStart(twoStage))

    // 同步断言：此时子 agent 尚未发出请求，节点状态已经是「进行中」。
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

  test('一个节点执行完毕后到达检查点：回执列出上游各节点，末行只有 id', async () => {
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
    // 续派方式已写在工具描述中，回执中不再重复。
    expect(receipt.content).not.toContain('approve')
  })

  test('approve 之后派发下一批，全部批准且所有节点均为终态时报告完成', async () => {
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

  test('一个节点失败：先单独发送失败回执，其余节点照常执行', async () => {
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
      // Y 较慢：失败回执必须在它执行完毕之前到达。
      return slow.respond()
    }
    const runId = run(parent, 'wf-fail')
    await invoke(parent, runId, 1, parallel, parsedStart(parallel))

    await until(() => receipts.length > 0, '失败回执')
    expect(receipts[0]?.origin).toBe('workflow')
    expect(receipts[0]?.content).toContain('[workflow 回执] x（x）失败')
    expect(receipts[0]?.content).toContain('workflowId=')
    expect(receipts[0]?.content).not.toContain('其余格照跑')
    expect(phasesOf('y').at(-1)).toBe('working')

    await until(slow.arrived, 'Y 发出请求')
    slow.open('Y 的产出')
    await until(() => receipts.length > 1, '检查点回执')
    expect(receipts[1]?.content).toContain('检查点 验收 的上游已经全部返回')
    expect(receipts[1]?.content).toContain('### x（x）失败')
  })

  test('上游未成功时下游跳过，检查点仍可到达', async () => {
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

  /** 图运行时刷新页面须能重新渲染：子会话 id 必须在派发时按节点写入该 step。 */
  test('每个节点的子会话入口按节点落库，节点 id 含点号时也不按路径解析', async () => {
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
   * 原始失败形状：agent 节点全部失败，主会话仍在检查点批准，此后需要其中一个节点
   * 在其自身的子会话中继续执行。批准即解散时模型只能使用 subagent，而 subagent 每次都新建会话。
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
    // 续发到首次派发的子会话，而不是新建会话。
    const lastAsked = () =>
      listMessages(store, qwenChild as ConversationId)
        .filter((message) => message.role === 'user')
        .at(-1)?.content ?? ''
    await until(() => lastAsked().includes('按 bug 列表继续改'), '续发指令进原子会话')
  })

  test('首次派发写入失败终态之后 approve 报告重新派发，不报告非待审查状态', async () => {
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
    // 进程退出时的收尾将 running 的 step 原地写为没有 transition 数据的失败终态。
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

  /** 续接已有子 agent 的节点接入其自身的会话：历史保存在该会话中，任务不重复写入。 */
  test('续接已有子 agent 的节点发送到同一条子会话', async () => {
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
 * 变更页合并子 agent 与外部 CLI 的写入，使用真实链路：
 * - 内置子 agent：假 provider 使子会话实际调用 `write_file`，写入记录在子会话的 step 中，
 *   投影按父 step 的 `subagentId` 与执行窗口归入父轮；
 * - 外部 CLI：在 PATH 上放置一个假的 `codex.cmd`，它向工作区写入一个文件，
 *   任务派发期间的工作区观察窗口将路径写入对应的节点，投影从节点中读取。
 */
describe('变更页合并子 agent 与外部 CLI 的写入', () => {
  /** 子会话第一轮：调用 write_file 向工作区写入一个文件。 */
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

  /** 父会话中一条有用户消息的轮，派发任务的 step 是真实的一行：投影按它归轮。 */
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

  /** 派发后立即返回：真实循环在派发后立即结束该 step，耗时约一百多毫秒，子会话仍在运行。 */
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

  test('子会话中的 write_file 出现在父轮中，并标注子 agent 的名称', async () => {
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
    // 来源在创建 run 时写入：投影按来源归入轮次，不按时间判断。
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

  test('外部 CLI 修改的文件出现在父轮中，并标注节点名；项目点路径计入，被忽略的缓存不计入', async () => {
    const bin = join(dir, 'fake-bin')
    await mkdir(bin, { recursive: true })
    // 假的 codex：忽略参数，向当前目录写入三个文件（普通文件、项目点路径、被忽略的缓存），
    // 再按 codex 的 jsonl 格式输出一条结果。Windows 使用 npm 的 Node 入口，POSIX 使用 sh 入口。
    await writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        'echo made > cli-made.txt',
        'mkdir -p .github/workflows',
        'echo ci > .github/workflows/ci.yml',
        'mkdir -p .profile-cache',
        'echo x > .profile-cache/state.bin',
        `echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'`,
        `echo '{"type":"turn.completed"}'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    await writeFile(
      join(bin, 'codex.cmd'),
      [
        '@ECHO off',
        'SET dp0=%~dp0',
        'SET "_prog=node"',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\index.js" %*',
        '',
      ].join('\r\n'),
    )
    await mkdir(join(bin, 'node_modules', 'fake-cli'), { recursive: true })
    await writeFile(
      join(bin, 'node_modules', 'fake-cli', 'index.js'),
      `const fs = require('node:fs');
fs.writeFileSync('cli-made.txt', 'made\\n');
fs.mkdirSync('.github/workflows', { recursive: true });
fs.writeFileSync('.github/workflows/ci.yml', 'ci\\n');
fs.mkdirSync('.profile-cache', { recursive: true });
fs.writeFileSync('.profile-cache/state.bin', 'x\\n');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));`,
    )
    // 观察器的忽略判定查询 git，忽略规则须有来源，因此本测试将夹具目录初始化为仓库。
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    await writeFile(join(dir, '.gitignore'), '.profile-cache/\n')
    const env = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    // 只保留假 CLI、系统命令、Git 与 Node 所在目录；凭证按该变量是否有值判定。
    // 必须保留 git：观察器收尾时须启动它判定忽略规则，未找到时只能报告观察范围不完整。
    const gitDir = dirname(Bun.which('git') ?? '')
    const nodeDir = dirname(Bun.which('node') ?? '')
    const sys =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        : dirname(Bun.which('mkdir') ?? '/bin/mkdir')
    process.env.PATH = [bin, sys, gitDir, nodeDir].join(delimiter)
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
      await until(() => phasesOf('child').some((p) => p === 'done' || p === 'failed'), 'CLI 落终态')
      expect(members().at(-1)?.state).toMatchObject({ phase: 'done' })

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
      // 项目的点路径计入，被 `.gitignore` 忽略的缓存不计入。
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
   * 原始失败形状：外部 CLI 无法启动（`Bun.spawn` 未找到可执行文件）时观察窗口未关闭。窗口先于进程
   * 打开，未关闭的窗口始终排在最前，此后同一工作区的窗口无法收到任何事件，删除也无法报告。
   */
  test('外部 CLI 无法启动时关闭观察窗口，此后的窗口照常收到删除', async () => {
    const bin = join(dir, 'vanished-bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(bin, 'codex.cmd'), '@echo off\r\n')
    const env = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    process.env.PATH = bin
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      // 识别结果按 PATH 缓存：先完成识别，然后删除文件，派发任务时 spawn 才会无法找到它。
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
      // 观察窗口的屏障最多等待 5 秒；必须等收尾结束后再断言并关闭测试数据库。
      await until(() => phasesOf('child').includes('failed'), 'CLI 落失败终态', 10_000)
    } finally {
      process.env.PATH = env.PATH
      if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
    }

    // 删除只能通过事件观察到，收尾扫描无法补充：前一个窗口未关闭时该删除无法报告。
    await writeFile(join(dir, 'doomed.txt'), 'x\n')
    const window = openChangeWindow(dir)
    await Bun.sleep(250)
    await rm(join(dir, 'doomed.txt'))
    await Bun.sleep(250)
    const got = await window.close()
    expect(got.changes).toContainEqual({ path: 'doomed.txt', changeType: 'deleted' })
  }, 20_000)
})
