/**
 * V25：桌面端口在**真实创建路径**上装配到位。
 *
 * 覆盖范围：`run-control.ts` 与 `team-run.ts` 两处 `new Session` 的桌面端口注入、
 * `runtime/session.ts` 的注册选项与 `ToolContext` 转发、`tools/index.ts` 的按通道注册、
 * `tools/desktop.ts` 与 `desktop/coordinator.ts` 之间的端到端往返，以及父级停止时的
 * 执行者撤销。
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
import type { ConversationId, DesktopOp, DesktopRequestFrame } from '@qywork/core'
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

let script: string[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.text())
    const next = script.shift()
    // 脚本用完回 401：它归 `auth_failed`，当场终结这一轮，不会让循环接着转下去。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(next, { headers: SSE_HEADERS })
  },
})

/** 这一次请求下发的工具名。注册到没到位只能从这里看。 */
function toolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: { name?: string }[] }
  return (parsed.tools ?? []).map((t) => t.name ?? '')
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
        completeness: { complete: true, truncatedBy: [] },
        nodeCount: 1,
        root: {
          ref: 'w.0',
          role: 'edit',
          name: '姓名',
          automationId: 'nameBox',
          value: '',
          enabled: true,
          offscreen: false,
          actions: ['set_value'],
          children: [],
        },
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
      ref: 'w.0',
      value: '张三',
    }),
    textTurn('做完了'),
  ]
  bodies = []
  const conv = conversation()
  await startRun(conv, '把姓名填成张三', undefined, deps())

  const list = await serveOnce('list_windows')
  const tree = await serveOnce('read_tree')
  const act = await serveOnce('set_value')
  // 脚本跑完最后一轮文本才算这一轮结束。
  await Bun.sleep(400)

  // 工具真的进了下发给模型的那张表。
  expect(toolNames(bodies[0] ?? '{}')).toEqual(
    expect.arrayContaining(['desktop_windows', 'desktop_observe', 'desktop_act', 'desktop_wait']),
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
  expect(act.value).toBe('张三')

  // 结果未知如实走到模型手里：这一条不能被读成「没执行」，也不能被读成成功。
  const body = bodies.at(-1) ?? '{}'
  expect(body).toContain('结果未知')
  expect(body).toContain('不要重放')
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
  expect(names).not.toContain('desktop_observe')
  expect(names).not.toContain('desktop_wait')

  // 上一条用例里主任务那个执行者不是这一个。
  const mainExecutor = host.received.find((f) => f.op === 'set_value')?.executorId
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

test('用户关掉电脑操作之后，下一轮连工具都不注册', async () => {
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
