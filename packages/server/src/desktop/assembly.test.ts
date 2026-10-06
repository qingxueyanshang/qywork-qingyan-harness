/**
 * 桌面端口在**真实创建路径**上正确装配。
 *
 * 覆盖范围：`run-control.ts` 与 `team-run.ts` 两处 `new Session` 的桌面端口注入、
 * `runtime/session.ts` 的注册选项与 `ToolContext` 转发、`tools/index.ts` 的按通道注册、
 * `tools/desktop.ts` 与 `desktop/coordinator.ts` 之间的端到端往返（含有限动作序列的
 * 逐帧派发、截断与不产生额外模型请求），以及父级停止时的执行者撤销。
 *
 * **必须经由真实链路。** 手动构造带端口的 `Session` 只能证明端口传入后可用，
 * 而易出错的是装配：主任务与子任务两个入口各自决定是否提供端口，遗漏任一入口会导致
 * 界面显示能力可用、模型却没有这组工具。
 *
 * 使用假 provider 与假宿主，不产生费用、不访问网络、不操作真实桌面。
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
 * 一轮的应答。函数形式按当前请求体实时生成：观察编号由协调器分配，无法在脚本中写成固定值。
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
    // 脚本用完后返回 401：它归入 `auth_failed`，立即终止该轮，循环不再继续。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(typeof next === 'function' ? next(body) : next, { headers: SSE_HEADERS })
  },
})

/** 本次请求下发的工具名。只能据此判断工具是否已注册。 */
function toolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: { name?: string }[] }
  return (parsed.tools ?? []).map((t) => t.name ?? '')
}

/** 请求体中最近一份观察的编号。编号由协调器分配，脚本只能从模型可见的正文中读取。 */
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
 * 回复本轮结束时的撤销帧。
 *
 * **不回复会使后续用例无法取得桌面**：协调器需要宿主确认该执行者名下已无执行中的
 * 请求，无法确认时桌面一直处于占用状态，直到宿主更换代际。
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

/** 按 op 等待一条请求帧，并回复对应的观察。 */
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
 * 主任务入口：`startRun` → `new Session` → `registerBuiltinTools` → `ToolContext`。
 *
 * 依次执行窗口发现、结构化观察与一次动作，同时验证三态回执如实传递到工具结果。
 */
test('主任务从 startRun 取得桌面工具，身份字段齐全，三态回执透传', async () => {
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
  // 脚本执行完最后一轮文本后该轮才结束。
  await Bun.sleep(400)
  await settleCancel(seen)

  // 工具确实进入了下发给模型的工具表。
  expect(toolNames(bodies[0] ?? '{}')).toEqual(
    expect.arrayContaining([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ]),
  )

  // 四项身份字段均写在帧上，动作另有 actionId。
  for (const frame of [list, tree, act]) {
    expect(frame.hostId).toBe(READY.hostId)
    expect(frame.hostEpoch).toBe(READY.hostEpoch)
    expect(frame.connectionEpoch).toBe(READY.connectionEpoch)
    expect(frame.executorId).toMatch(/^dx_/)
    expect(frame.deadline).toBeGreaterThan(0)
  }
  expect(list.executorId).toBe(act.executorId)
  expect(act.actionId).toMatch(/^da_/)
  // 目标身份的三项同时提供，OS 句柄只经由宿主连接传递。
  expect(act.target).toEqual({
    window: WINDOW.handle,
    pid: WINDOW.pid,
    processStartedAt: WINDOW.processStartedAt,
  })
  expect(act.action).toEqual({ kind: 'set_value', value: '张三' })

  // 「结果未确认」如实传递给模型：该结果不能被解读为未执行，也不能被解读为成功。
  const body = bodies.at(-1) ?? '{}'
  expect(body).toContain('结果未确认')
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
/** 序列使用的控件表：窗口下三个可分别操作的后台控件，足够执行三步。 */
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
 * 有限动作序列经由真实链路执行：一次工具调用，每个动作一帧，停止后不再发帧。
 *
 * 断言的是帧而不是工具内部状态：序列要证明的是模型调用一次时宿主收到的帧数。
 * 第一份观察是整窗，动作帧不带范围，宿主返回一份整窗重读；第二、三步给出的编号在重读中
 * 仍然存在，因此照常可用。姓名框的 RuntimeId 与上一条用例中的相同，编号表是窗口级的，
 * 因此它仍是 `e2`；帧上是宿主的完整 ref。
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
  // 无需再次发现窗口：`dw_1` 已由上一条用例登记，窗口表是协调器级的。
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
  // 第二步给出的编号在第一步之后的整窗重读中仍然存在。
  expect(second.ref).toBe('w.1#8')
  host.reply(second, { dispatch: 'unknown', reason: 'provider 无响应' })

  await Bun.sleep(400)

  // 第三步未发出任何帧：出现 `unknown` 后，其后的动作不再执行。
  const acts = host.received.slice(seen).filter((f) => f.op === 'act')
  expect(acts.map((f) => f.ref)).toEqual(['w.0#7', 'w.1#8'])
  expect(acts[0]?.actionId).not.toBe(acts[1]?.actionId)

  // 序列本身不产生模型请求：观察、序列、结束各一轮，共三条。
  expect(bodies).toHaveLength(3)
  const body = bodies.at(-1) ?? '{}'
  expect(body).toContain('结果未确认')
  expect(body).toContain('未执行 3 invoke')
  await settleCancel(seen)
})

/**
 * 子任务入口：`runBuiltinMember` → `new Session`。
 *
 * 同时验证三项：allowedTools 过滤对新工具同样生效、成员领取独立的执行者身份、
 * 父级停止只撤销其名下的排队请求。
 */
test('子任务领取独立执行者，allowedTools 过滤生效，父级停止撤销其名下的请求', async () => {
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

  // 只有被放行的工具进入工具表，其他桌面工具均不存在。
  const names = toolNames(bodies[0] ?? '{}')
  expect(names).toContain('desktop_windows')
  expect(names).not.toContain('desktop_act')
  expect(names).not.toContain('desktop_act_sequence')
  expect(names).not.toContain('desktop_observe')
  expect(names).not.toContain('desktop_wait')

  // 成员的执行者与上一条用例中主任务的执行者不同。
  const mainExecutor = host.received.find((f) => f.op === 'act')?.executorId
  expect(mainExecutor).toBeTruthy()
  expect(frame.executorId).not.toBe(mainExecutor)

  // 父级停止：撤销帧指定的是成员自身的执行者，排队中的请求不再等待回执。
  const cancelling = host.next()
  controller.abort()
  const cancel = await cancelling
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(frame.executorId)
  host.reply(cancel)

  const out = await member
  expect(out.ok).toBe(false)
})

test('用户关闭电脑控制后，下一轮不注册桌面工具', async () => {
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
 * 缺省视为启用。现有配置文件中没有该字段，若按「等于 true 才启用」判定，
 * 模型将没有任何桌面工具，只能改用 run_command 自行编写截图脚本。
 */
test('配置中没有该字段时桌面工具照常注册', async () => {
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
