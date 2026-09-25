/**
 * V25：桌面端口在**真实创建路径**上装配到位。
 *
 * 覆盖范围：`run-control.ts` 与 `team-run.ts` 两处 `new Session` 的桌面端口注入、
 * `runtime/session.ts` 的注册选项与 `ToolContext` 转发、`tools/index.ts` 的按通道注册、
 * `tools/desktop.ts` 与 `desktop/coordinator.ts` 之间的端到端往返（含有限动作序列的
 * 逐帧派发、截断与不产生额外模型请求），以及父级停止时的执行者撤销。
 *
 * **为什么必须走真链路。** 手造一个带端口的 `Session` 只能证明「端口传进去就能用」，
 * 而真正会坏的是装配：主任务与子任务两条入口各自决定给不给端口，漏掉任一条的表现是
 * 界面显示能力可用、模型手里却没有这组工具。
 *
 * 用假 provider 与假宿主，不花钱、不联网、不操作真实桌面。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, DesktopNode, DesktopOp, DesktopRequestFrame } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import type { Role } from '@qywork/team'
import { startRun } from '../run-control.ts'
import { serve } from '../server.ts'
import { SubagentRegistry } from '../subagents.ts'
import { runBuiltinMember } from '../team-run.ts'
import { FakeDesktopHost, HOST_KEY, READY, WINDOW } from './fixtures.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

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

/**
 * 一轮的应答。函数形式按这一条请求体现算——观察编号由协调器分配，脚本里写不死它。
 */
type Turn = string | ((body: string) => string)

let script: Turn[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    bodies.push(body)
    const next = script.shift()
    // 脚本用完回 401：它归 `auth_failed`，当场终结这一轮，不会让循环接着转下去。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(typeof next === 'function' ? next(body) : next, { headers: SSE_HEADERS })
  },
})

/** 这一次请求下发的工具名。注册到没到位只能从这里看。 */
function toolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: { name?: string }[] }
  return (parsed.tools ?? []).map((t) => t.name ?? '')
}

/** 这一条请求体里最近一份观察的编号。编号由协调器分配，脚本只能从模型看到的正文里读。 */
function observationIn(body: string): string {
  return /do_\d+/.exec(body)?.[0] ?? ''
}

// ───────────────────────── 装配 ─────────────────────────

let dir = ''
let store: Store
let content: ContentStore
let config: QyConfig
let handle: ReturnType<typeof serve>
let host: FakeDesktopHost
let workspaceId = ''

const closers: (() => void)[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-desktop-assembly-'))
  const dbPath = join(dir, 'a.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  config = {
    active: { provider: 'fake', model: 'm' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { m: {} },
      },
    },
    mode: 'auto',
    desktopEnabled: true,
  }
  workspaceId = upsertWorkspace(store, dir, 'W').id
  handle = serve({
    store,
    config,
    content,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    hostKey: HOST_KEY,
  })
  host = await FakeDesktopHost.connect(handle.port, HOST_KEY, closers)
  host.send(READY)
  await Bun.sleep(30)
})

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) close()
  handle?.stop()
  provider.stop(true)
  content?.close()
  store?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function deps() {
  return {
    store,
    content,
    config,
    bus: handle.bus,
    runs: handle.runs,
    subagents: new SubagentRegistry(),
    ...(handle.desktop ? { desktop: handle.desktop } : {}),
  }
}

function conversation(parentConversationId?: ConversationId): ConversationId {
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'm',
    ...(parentConversationId ? { parentConversationId, source: 'temp' as const } : {}),
  }).id
}

/**
 * 答掉这一轮收尾时的撤销帧。
 *
 * **不答的代价是后面的用例拿不到桌面**：协调器要宿主确认这个执行者名下已无在执行的
 * 请求，确认不了就把桌面挡到宿主换代际为止。
 */
async function settleCancel(from: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const cancel = host.received.slice(from).find((f) => f.op === 'cancel')
    if (cancel) {
      host.settle(cancel, 'not_dispatched')
      await Bun.sleep(30)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error('没有收到撤销帧')
}

/** 按 op 等一条请求帧，并回一份合适的观察。 */
async function serveOnce(op: DesktopOp): Promise<DesktopRequestFrame> {
  const frame = await host.next()
  expect(frame.op).toBe(op)
  if (op === 'list_windows') {
    host.reply(frame, { observation: { kind: 'windows', capturedAt: 1, windows: [WINDOW] } })
  } else if (op === 'read_tree') {
    host.reply(frame, {
      observation: {
        kind: 'tree',
        window: WINDOW.handle,
        capturedAt: 2,
        windowEnabled: true,
        windowCovered: false,
        completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: 2 },
        nodeCount: 2,
        nodes: [{ ...FORM_ROOT }, { ...NAME_BOX }],
      },
    })
  } else {
    host.reply(frame, {
      dispatch: 'unknown',
      reason: 'provider 无响应',
      observationError: '动作之后没有读到控件',
    })
  }
  return frame
}

/**
 * 主任务那条入口：`startRun` → `new Session` → `registerBuiltinTools` → `ToolContext`。
 *
 * 一次跑完窗口发现、结构化观察与一次动作，一并验三态回执如实走到工具结果。
 */
test('主任务从 startRun 拿到桌面工具，身份字段齐全，三态回执透传', async () => {
  script = [
    toolTurn('desktop_windows', {}),
    toolTurn('desktop_observe', { windowId: 'dw_1' }),
    toolTurn('desktop_act', {
      windowId: 'dw_1',
      observationId: 'do_1',
      action: 'set_value',
      ref: 'e2',
      value: '张三',
    }),
    textTurn('做完了'),
  ]
  bodies = []
  const seen = host.received.length
  const conv = conversation()
  await startRun(conv, '把姓名填成张三', undefined, deps())

  const list = await serveOnce('list_windows')
  const tree = await serveOnce('read_tree')
  const act = await serveOnce('act')
  // 脚本跑完最后一轮文本才算这一轮结束。
  await Bun.sleep(400)
  await settleCancel(seen)

  // 工具真的进了下发给模型的那张表。
  expect(toolNames(bodies[0] ?? '{}')).toEqual(
    expect.arrayContaining([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ]),
  )

  // 身份四项逐条落在帧上，动作另有 actionId。
  for (const frame of [list, tree, act]) {
    expect(frame.hostId).toBe(READY.hostId)
    expect(frame.hostEpoch).toBe(READY.hostEpoch)
    expect(frame.connectionEpoch).toBe(READY.connectionEpoch)
    expect(frame.executorId).toMatch(/^dx_/)
    expect(frame.deadline).toBeGreaterThan(0)
  }
  expect(list.executorId).toBe(act.executorId)
  expect(act.actionId).toMatch(/^da_/)
  // 目标身份三项一起给，OS 句柄只走这条连接。
  expect(act.target).toEqual({
    window: WINDOW.handle,
    pid: WINDOW.pid,
    processStartedAt: WINDOW.processStartedAt,
  })
  expect(act.action).toEqual({ kind: 'set_value', value: '张三' })

  // 结果未知如实走到模型手里：这一条不能被读成「没执行」，也不能被读成成功。
  const body = bodies.at(-1) ?? '{}'
  expect(body).toContain('结果未知')
})

/** 整窗读取的第一项：窗口元素本身。 */
const FORM_ROOT: DesktopNode = {
  ref: 'w#1',
  depth: 0,
  role: 'window',
  name: '表单',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
/** 序列用的控件表：窗口下三个各自可动的后台控件，够走三步。 */
const NAME_BOX: DesktopNode = {
  ref: 'w.0#7',
  parentRef: 'w#1',
  depth: 1,
  role: 'edit',
  name: '姓名',
  automationId: 'nameBox',
  value: '',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_value', delivery: ['background'] }],
}
const AGREE_BOX: DesktopNode = {
  ref: 'w.1#8',
  parentRef: 'w#1',
  depth: 1,
  role: 'check_box',
  name: '同意',
  automationId: 'agree',
  enabled: true,
  offscreen: false,
  toggle: 'off',
  actions: [{ action: 'set_toggle', delivery: ['background'] }],
}
const SAVE_BUTTON: DesktopNode = {
  ref: 'w.2#9',
  parentRef: 'w#1',
  depth: 1,
  role: 'button',
  name: '保存',
  automationId: 'save',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}

/**
 * 有限动作序列走完真链路：一次工具调用，逐动作一帧，停下之后不再发帧。
 *
 * 断言的是帧而不是工具内部状态：序列要证明的就是「模型发一次、宿主收到几次」。
 * 第一份观察是整窗，动作帧不带范围，宿主回一份整窗重读；第二、三步给的编号在重读里
 * 仍然存在，所以照常可用。姓名框的 RuntimeId 与上一条用例里那一个相同，编号表是窗口级的，
 * 它因此还是 `e2`；帧上是宿主的完整 ref。
 */
test('一次序列调用逐动作发帧，actionId 各不相同，截断后不再发帧', async () => {
  script = [
    toolTurn('desktop_observe', { windowId: 'dw_1' }),
    (body) =>
      toolTurn('desktop_act_sequence', {
        windowId: 'dw_1',
        observationId: observationIn(body),
        steps: [
          { action: 'set_value', ref: 'e2', value: '张三' },
          { action: 'set_toggle', ref: 'e3', state: 'on' },
          { action: 'invoke', ref: 'e4' },
        ],
      }),
    textTurn('停在第二步了'),
  ]
  bodies = []
  const seen = host.received.length
  const conv = conversation()
  // 窗口不必再发现一次：`dw_1` 由上面那条用例登记过，窗口表是协调器级的。
  await startRun(conv, '把表单填好', undefined, deps())

  const tree = await host.next()
  expect(tree.op).toBe('read_tree')
  host.reply(tree, {
    observation: {
      kind: 'tree',
      window: WINDOW.handle,
      capturedAt: 2,
      windowEnabled: true,
      windowCovered: false,
      completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: 4 },
      nodeCount: 4,
      nodes: [{ ...FORM_ROOT }, { ...NAME_BOX }, { ...AGREE_BOX }, { ...SAVE_BUTTON }],
    },
  })

  const first = await host.next()
  expect(first.op).toBe('act')
  expect(first.ref).toBe('w.0#7')
  expect(first.root).toBeUndefined()
  host.reply(first, {
    dispatch: 'submitted',
    observation: {
      kind: 'tree',
      window: WINDOW.handle,
      capturedAt: 3,
      windowEnabled: true,
      windowCovered: false,
      completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: 4 },
      nodeCount: 4,
      nodes: [
        { ...FORM_ROOT },
        { ...NAME_BOX, value: '张三' },
        { ...AGREE_BOX },
        { ...SAVE_BUTTON },
      ],
    },
  })

  const second = await host.next()
  expect(second.op).toBe('act')
  // 第二步给的编号在第一步之后的整窗重读里仍然存在。
  expect(second.ref).toBe('w.1#8')
  host.reply(second, { dispatch: 'unknown', reason: 'provider 无响应' })

  await Bun.sleep(400)

  // 第三步一帧都没发：`unknown` 之后后缀不执行。
  const acts = host.received.slice(seen).filter((f) => f.op === 'act')
  expect(acts.map((f) => f.ref)).toEqual(['w.0#7', 'w.1#8'])
  expect(acts[0]?.actionId).not.toBe(acts[1]?.actionId)

  // 序列本身不产生模型请求：观察一轮、序列一轮、收尾一轮，一共三条。
  expect(bodies).toHaveLength(3)
  const body = bodies.at(-1) ?? '{}'
  expect(body).toContain('结果未知')
  expect(body).toContain('未执行 3 invoke')
  await settleCancel(seen)
})

/**
 * 子任务那条入口：`runBuiltinMember` → `new Session`。
 *
 * 同时验三件事：allowedTools 过滤对新工具照样生效、成员领的是另一个执行者身份、
 * 父级停止只撤销它自己名下的排队请求。
 */
test('子任务领独立执行者，allowedTools 挡得住，父级停止撤销它名下的请求', async () => {
  script = [toolTurn('desktop_windows', {})]
  bodies = []
  const parent = conversation()
  const sub = conversation(parent)
  const role: Role = {
    id: 'looker',
    name: '观察者',
    description: '只看不动',
    systemPrompt: '',
    allowedTools: ['desktop_windows'],
  }
  const controller = new AbortController()
  const member = runBuiltinMember(
    { role, prompt: '看看有哪些窗口', signal: controller.signal, conversationId: sub },
    { deps: deps(), workspaceRoot: dir },
  )

  const frame = await host.next()
  expect(frame.op).toBe('list_windows')

  // 只放行的那一个进了工具表，别的桌面工具一个都没有。
  const names = toolNames(bodies[0] ?? '{}')
  expect(names).toContain('desktop_windows')
  expect(names).not.toContain('desktop_act')
  expect(names).not.toContain('desktop_act_sequence')
  expect(names).not.toContain('desktop_observe')
  expect(names).not.toContain('desktop_wait')

  // 上一条用例里主任务那个执行者不是这一个。
  const mainExecutor = host.received.find((f) => f.op === 'act')?.executorId
  expect(mainExecutor).toBeTruthy()
  expect(frame.executorId).not.toBe(mainExecutor)

  // 父级停止：撤销帧点名的是成员自己的执行者，排队中的那一条不再有回执可等。
  const cancelling = host.next()
  controller.abort()
  const cancel = await cancelling
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(frame.executorId)
  host.reply(cancel)

  const out = await member
  expect(out.ok).toBe(false)
})

test('用户关掉电脑控制之后，下一轮连工具都不注册', async () => {
  config.desktopEnabled = false
  script = [textTurn('好的')]
  bodies = []
  const conv = conversation()
  await startRun(conv, '随便说一句', undefined, deps())
  await Bun.sleep(400)
  config.desktopEnabled = true

  const names = toolNames(bodies[0] ?? '{}')
  expect(names).not.toContain('desktop_windows')
  expect(names).not.toContain('desktop_act')
})

/**
 * 缺席按启用。用户的配置文件里从来没有过这一格，按「等于 true 才算开」判的话，
 * 模型手里一个桌面工具都没有，只能绕去 run_command 自己写截图脚本。
 */
test('配置里没有这一格时这组工具照常注册', async () => {
  delete config.desktopEnabled
  script = [textTurn('好的')]
  bodies = []
  const conv = conversation()
  await startRun(conv, '随便说一句', undefined, deps())
  await Bun.sleep(400)
  config.desktopEnabled = true

  const names = toolNames(bodies[0] ?? '{}')
  expect(names).toContain('desktop_windows')
  expect(names).toContain('desktop_act')
  expect(names).toContain('desktop_observe')
})
