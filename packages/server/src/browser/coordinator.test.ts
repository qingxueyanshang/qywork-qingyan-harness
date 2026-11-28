/**
 * 浏览器控制的会话归属与并发。
 *
 * 覆盖范围：`coordinator.ts` 的按执行者控制槽与页级独占、版本准入、`browserEnabled` 开关、会话归属校验、
 * 按会话关页、释放与迟到回包的收尾、宿主断开重连，动作与导航之后的静默等待、
 * 观察登记与失败说明，
 * 选项页读取不分配新编号、多事件动作未完成时仍返回观察，
 * 下载的身份登记与终态认领，以及它经 `bridge.ts` 发出的
 * `create` / `bind` / `close.conversation` / `download.arm` / `download.disarm` 帧格式，
 * 以及设计稿渲染（`renderArt`、`render.ts`，经由 `canvas/port.ts` 的画布端口）。
 *
 * 对端是自动应答的假宿主，以及只覆盖基本流程的假调试端点。本文件测试页面归属、
 * 两条会话能否同时操作各自的页、删除会话能否关闭页面，
 * 不测试 CDP 协议细节（见 `cdp.test.ts`）。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openBatchBudget, Ports, provide, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type {
  BrowserEventFrame,
  BrowserRequestFrame,
  HostReadyFrame,
  WorkspaceId,
} from '@qywork/core'
import { NATIVE_BROWSER_PATH, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import {
  type BrowserObservation,
  type BrowserOptionsPage,
  BrowserPort,
  registerBuiltinTools,
} from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import { EventBus } from '../bus.ts'
import { artRenderOf, canvasPort } from '../canvas/port.ts'
import { CanvasService } from '../canvas/service.ts'
import { handleCommand } from '../commands.ts'
import { makeDelegate } from '../delegate.ts'
import type { SocketData } from '../deps.ts'
import { RunManager } from '../runs.ts'
import { serve } from '../server.ts'
import { SubagentRegistry } from '../subagents.ts'
import { meetsRuntimeFloor } from './coordinator.ts'

const HOST_KEY = 'coordinator-host-key'

/** 用例默认位于该工作区。跨工作区的过滤由专门用例覆盖，显式传入第二个 id。 */
const WS = 'ws_a'

const config: QyConfig = {
  active: { provider: 'fake', model: 'm' },
  providers: {
    fake: {
      kind: 'openai_responses',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: { m: {} },
    },
  },
  mode: 'auto',
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 只用于确认某件事没有发生：被测代码在这些位置没有可观察的完成信号，各调用处写明原因。 */
const settle = () => new Promise((r) => setTimeout(r, 40))

/** observe 按输入返回元素表或选项页；用例只使用元素表中的第一个编号。 */
function firstRef(ob: BrowserObservation | BrowserOptionsPage | undefined): string {
  return ob && 'elements' in ob ? (ob.elements[0]?.ref ?? '') : ''
}

async function failure(pending: Promise<unknown> | undefined): Promise<Error> {
  const settled = Symbol('resolved')
  const out = await Promise.resolve(pending).then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('该调用本应失败')
  return out as Error
}

/** 等待条件成立。成员会话派出后立即返回，断言前须等待它执行到该步骤。 */
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 等待宿主的页面事件进入服务端的存活快照。`conversationId` 只决定以哪条会话的视角列出：
 * 用户页对同一工作区的任何会话都可见，会话的页只对该会话可见。建端口不发送任何帧。
 */
async function listed(
  handle: ReturnType<typeof serve>,
  tabId: string,
  present = true,
  workspaceId: string = WS,
  conversationId = 'cv_probe',
): Promise<void> {
  const probe = handle.browser?.portFor(conversationId, workspaceId)
  await until(
    async () => ((await probe?.tabs()) ?? []).some((t) => t.tabId === tabId) === present,
    `${tabId} ${present ? '进入' : '移出'}存活快照`,
  )
}

/**
 * 经宿主连接往返一次。服务端发往宿主的帧在同一条连接上按发送顺序到达，往返结束时，此前发出的帧
 * 都已被宿主收到，用于确认某个帧没有发出。往返在宿主上留下一条无对象的 `close.conversation`。
 */
async function hostRoundtrip(handle: ReturnType<typeof serve>): Promise<void> {
  await handle.browser?.closeConversation('cv_roundtrip')
}

/** 手动兑现的 Promise。屏障用例用它把第二个执行者的调用插入第一个执行者的在途阶段。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** 假调试端点的开关：用例按需修改，修改后影响此后的每一条命令。 */
interface Devtools {
  port: number
  disconnect: (index?: number) => void
  rejectConnections: boolean
  clicks: () => number
  /** 已收到的命令数。页级互斥的用例据此断言被拒绝的一方未向浏览器发送任何帧。 */
  commands: () => number
  /** 该方法的回包推迟到 `gate` 兑现后返回，用于把其他调用插入进行中的附页或收尾。 */
  hold: { method: string; gate: Promise<unknown> } | null
  /** 下一次 goto 返回该 errorText，模拟导航被拒绝。 */
  navigateError: string | null
  /** 使采集命令报错，模拟动作之后无法取得观察。 */
  failObserve: boolean
  /** 每次探针读数返回不同的变更计数，模拟持续变化的页面。 */
  churn: boolean
  /** 探针读数不含 ready 与 mutations，模拟探针无效。 */
  blindProbe: boolean
  /** 第几条按键事件返回错误：模拟多事件动作中途注入失败。 */
  failKeyAt: number | null
  /** 每条命令应答后回调一次，用于在动作与观察之间插入操作。 */
  onCommand: ((method: string, expression: string) => void) | null
  /** 收到的全部命令与参数，按到达顺序。 */
  calls: { method: string; params: Record<string, unknown> }[]
  /**
   * 每次点击时页面发出的请求：`type` 是资源类型，`finishMs` 毫秒后结束，结束时链接名称改为
   * 「已加载」并产生一次 DOM 变更；`finishMs` 为 `null` 表示请求不结束。
   */
  request: { type: string; finishMs: number | null; mimeType?: string } | null
  /** 向页会话发送一条协议事件。 */
  emit: (method: string, params: Record<string, unknown>) => void
  /** `Page.getResourceTree` 返回的帧树：各帧的文档地址与已加载的资源。缺省为一个 http 文档。 */
  resourceTree: Record<string, unknown>
}

/** 假调试端点对 `Page.captureScreenshot` 返回的截图。 */
const SHOT = 'iVBORw0KGgo='

/**
 * 只覆盖基本流程的假调试端点：一个 page target、一个可点击的下载链接、一个可读取选项的下拉框。
 *
 * 元素与动作的判定见 `page.test.ts`；此处只需使观察、点击与导航能够执行，
 * 以便串联下载的授权、触发、终态、磁盘核对，以及动作之后的静默等待与观察这两条链路。
 * 导航按真实端点的格式返回 frameId 并补发 `Page.frameNavigated`：协调器按事件确认导航，
 * 不按「令牌未变即同一文档」推断。探针按真实表达式应答并返回完整的 `ready` 与 `mutations`。
 */
function fakeDevtools(marker: string): Devtools {
  const sockets = new Set<ServerWebSocket<unknown>>()
  let clicks = 0
  let keys = 0
  let mutations = 0
  // 文档代数：每次导航加一，文档令牌随之更换。夹具只有一个页面。
  let docGen = 1
  let commands = 0
  let requests = 0
  let linkName = '下载'
  const send = (method: string, params: Record<string, unknown>) => {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method, sessionId: 'sess-1', params }))
    }
  }
  const state: Devtools = {
    port: 0,
    disconnect: (index) => {
      const targets = [...sockets]
      for (const socket of index === undefined ? targets : targets.slice(index, index + 1)) {
        socket.close()
      }
    },
    rejectConnections: false,
    clicks: () => clicks,
    commands: () => commands,
    hold: null,
    navigateError: null,
    failObserve: false,
    churn: false,
    blindProbe: false,
    failKeyAt: null,
    onCommand: null,
    calls: [],
    request: null,
    emit: send,
    resourceTree: { frame: { id: 'frame-1', url: 'http://127.0.0.1:1/page' }, resources: [] },
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/json/version') {
        if (state.rejectConnections) return new Response('调试端点暂不可用', { status: 503 })
        return Response.json({
          webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
        })
      }
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        sockets.add(ws)
      },
      close(ws: ServerWebSocket<unknown>) {
        sockets.delete(ws)
      },
      message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
        const cmd = JSON.parse(String(raw)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        commands += 1
        state.calls.push({ method: cmd.method, params: cmd.params ?? {} })
        let result: Record<string, unknown> = {}
        let error: string | null = null
        if (cmd.method === 'Target.getTargets') {
          result = { targetInfos: [{ targetId: 'page-1', type: 'page' }] }
        }
        if (cmd.method === 'Target.attachToTarget') result = { sessionId: 'sess-1' }
        if (cmd.method === 'Page.getFrameTree') {
          result = { frameTree: { frame: { id: 'frame-1' } } }
        }
        if (cmd.method === 'Page.getNavigationHistory') {
          result = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] }
        }
        if (
          cmd.method === 'Page.navigate' ||
          cmd.method === 'Page.reload' ||
          cmd.method === 'Page.navigateToHistoryEntry'
        ) {
          if (cmd.method === 'Page.navigate' && state.navigateError) {
            result = { frameId: 'frame-1', errorText: state.navigateError }
          } else {
            // 导航提交即更换文档：新文档的令牌不同，与真实浏览器相同。
            docGen += 1
            result = { frameId: 'frame-1', loaderId: 'loader-1' }
            ws.send(
              JSON.stringify({
                method: 'Page.frameNavigated',
                sessionId: 'sess-1',
                params: { frame: { id: 'frame-1', loaderId: 'loader-1' } },
              }),
            )
          }
        }
        if (cmd.method === 'DOM.getDocument') {
          if (state.failObserve) error = '采集失败'
          result = {
            root: {
              backendNodeId: 1,
              nodeName: '#document',
              nodeType: 9,
              children: [
                {
                  backendNodeId: 9,
                  nodeName: 'A',
                  nodeType: 1,
                  attributes: ['id', 'dl'],
                  children: [],
                },
                {
                  backendNodeId: 12,
                  nodeName: 'SELECT',
                  nodeType: 1,
                  attributes: ['id', 'pick'],
                  children: [],
                },
              ],
            },
          }
        }
        if (cmd.method === 'Accessibility.getFullAXTree') {
          result = {
            nodes: [
              { backendDOMNodeId: 9, role: { value: 'link' }, name: { value: linkName } },
              { backendDOMNodeId: 12, role: { value: 'combobox' }, name: { value: '选择' } },
            ],
          }
        }
        if (cmd.method === 'DOM.resolveNode') {
          result = { object: { objectId: `obj-${String(cmd.params?.backendNodeId)}` } }
        }
        if (cmd.method === 'Runtime.callFunctionOn') {
          const decl = String(cmd.params?.functionDeclaration ?? '')
          const backend = String(cmd.params?.objectId ?? '').replace('obj-', '')
          const identity = backend === '12' ? 'select|pick||' : 'a|dl||'
          const label = backend === '12' ? 'pick' : 'dl'
          if (decl.includes('qyOptions')) {
            const start = Number((cmd.params?.arguments as { value: number }[])?.[0]?.value ?? 0)
            const limit = Number((cmd.params?.arguments as { value: number }[])?.[1]?.value ?? 0)
            const all = Array.from({ length: 3 }, (_, i) => ({
              label: `选项 ${i}`,
              value: `v${i}`,
            }))
            result = {
              result: {
                value: { ok: true, total: all.length, items: all.slice(start, start + limit) },
              },
            }
          } else if (decl.includes('qyTypingTarget')) {
            result = { result: { value: { connected: true, identity, focused: true } } }
          } else {
            result = {
              result: {
                value: {
                  connected: true,
                  identity,
                  x: 10,
                  y: 10,
                  width: 40,
                  height: 12,
                  inView: true,
                  sameTree: true,
                  hit: 'a',
                  label,
                },
              },
            }
          }
        }
        if (cmd.method === 'Input.dispatchMouseEvent' && cmd.params?.type === 'mousePressed') {
          clicks += 1
        }
        // 点击的处理函数在松开时运行，请求事件先于该命令的回包到达，与真实浏览器一致。
        if (
          cmd.method === 'Input.dispatchMouseEvent' &&
          cmd.params?.type === 'mouseReleased' &&
          state.request
        ) {
          requests += 1
          const requestId = `req-${requests}`
          const { type, finishMs, mimeType } = state.request
          send('Network.requestWillBeSent', {
            requestId,
            type,
            request: { url: 'http://127.0.0.1:1/api/data', method: 'GET' },
          })
          if (mimeType) send('Network.responseReceived', { requestId, response: { mimeType } })
          if (finishMs !== null) {
            const timer = setTimeout(() => {
              linkName = '已加载'
              mutations += 1
              send('Network.loadingFinished', { requestId })
            }, finishMs)
            cleanups.push(() => clearTimeout(timer))
          }
        }
        if (cmd.method === 'Input.dispatchKeyEvent') {
          keys += 1
          if (state.failKeyAt === keys) error = '输入事件被拒'
        }
        if (cmd.method === 'Runtime.evaluate') {
          const expr = String(cmd.params?.expression ?? '')
          if (expr === 'window.__qyworkTab') result = { result: { value: marker } }
          else if (expr.includes('__qyworkDoc')) {
            result = {
              result: {
                value: { token: `doc-${docGen}`, url: 'http://127.0.0.1:1/page', title: '夹具页' },
              },
            }
          } else if (expr.includes('__qyworkProbeRead')) {
            if (state.churn) mutations += 1
            result = {
              result: {
                value: state.blindProbe ? {} : { ready: 'complete', mutations },
              },
            }
          } else if (expr.includes('__qyworkProbe(')) {
            result = { result: { value: { id: 5 } } }
          } else if (expr.includes('__qyworkWait(')) {
            result = { result: { value: { id: 7, immediate: false } } }
          } else if (expr.includes('__qyworkAwait(')) {
            result = { result: { value: { met: true, id: 7 } } }
          } else if (expr.includes("document.readyState === 'complete'")) {
            result = { result: { value: true } }
          } else result = { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
        }
        if (cmd.method === 'Page.captureScreenshot') result = { data: SHOT }
        if (cmd.method === 'Page.getResourceTree') result = { frameTree: state.resourceTree }
        const reply = JSON.stringify(
          error === null
            ? { id: cmd.id, result }
            : { id: cmd.id, error: { code: -32000, message: error } },
        )
        const held = state.hold?.method === cmd.method ? state.hold : null
        if (held) {
          state.hold = null
          void held.gate.then(() => ws.send(reply))
        } else ws.send(reply)
        state.onCommand?.(cmd.method, String(cmd.params?.expression ?? ''))
      },
    },
  })
  cleanups.push(() => server.stop(true))
  state.port = server.port ?? 0
  return state
}

/**
 * 自动应答的假宿主。记录收到的每一帧，供归属与格式断言。
 *
 * 它按真实宿主的准入规则应答 `bind`：用户页（归属为 `null`）可被点名接管到发起会话，
 * 已归属本会话时为幂等操作，已归属另一条会话时一律拒绝。归属只由会话 id 决定，页面内容与
 * 模型给出的 tabId 都无法改变它：这一层负责跨会话隔离。
 */
class AutoHost {
  socket: WebSocket
  received: BrowserRequestFrame[] = []
  marker = 'marker-1'
  /** tabId → 归属会话 id。`null` 表示用户手动打开的页，不属于任何会话。 */
  owners = new Map<string, string | null>()
  /** tabId → 所属工作区。建页时确定，此后不变；跨工作区的 `bind` 一律拒绝。 */
  workspaces = new Map<string, string>()
  /** tabId → 尚未消费的授权。按真实宿主的格式记录身份与目标路径。 */
  arms = new Map<string, { downloadId: string; path: string }>()
  /** 本次连接的纪元。重连用例为新连接设置新值，旧纪元的事件随之作废。 */
  epoch = 1
  /** 应答一次 `create` 后回调一次，用于把释放插入建页回包与登记之间。 */
  onCreate: (() => void) | null = null
  /**
   * 该 op 的回包推迟到 `gate` 兑现后返回。
   *
   * 事件照常先发送：真实宿主同样先广播 `opened` / `control` 再返回结果，页级占用的用例
   * 需要的正是事件已到达而回包未到达的时段。
   */
  hold: { op: string; gate: Promise<unknown> } | null = null
  #nextTab = 0

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as BrowserRequestFrame
      this.received.push(frame)
      const data: Record<string, unknown> = {}
      let error: string | undefined
      if (frame.op === 'create') {
        this.#nextTab += 1
        const tabId = `bt_${this.#nextTab}`
        data.tabId = tabId
        data.marker = this.marker
        data.url = frame.url
        data.title = '夹具页'
        this.owners.set(tabId, frame.conversationId ?? null)
        this.workspaces.set(tabId, frame.workspaceId ?? '')
        // 真实宿主在返回结果之前先发送 `opened`，存活快照只来源于该事件。
        this.emit({
          kind: 'opened',
          tabId,
          url: String(frame.url ?? ''),
          title: '夹具页',
          marker: this.marker,
          workspaceId: frame.workspaceId ?? '',
          conversationId: frame.conversationId ?? null,
        })
      }
      if (frame.op === 'bind') {
        const tabId = frame.tabId ?? ''
        const owner = this.owners.get(tabId)
        if (owner === undefined) {
          error = `无法识别的标签页 ${tabId}`
        } else if (this.workspaces.get(tabId) !== frame.workspaceId) {
          error = '该页属于另一个工作区，无法接管'
        } else if (owner === null || owner === frame.conversationId) {
          // 用户页归属发起会话；已归属本会话时为幂等操作。两种情况返回同一个 marker。
          if (owner === null) {
            this.owners.set(tabId, frame.conversationId ?? null)
            this.emit({ kind: 'control', tabId, conversationId: frame.conversationId ?? null })
          }
          data.marker = this.marker
          data.url = 'http://127.0.0.1:1/page'
          data.title = '夹具页'
        } else {
          error = '该页属于另一条会话，无法接管'
        }
      }
      if (frame.op === 'close') {
        this.owners.delete(frame.tabId ?? '')
        this.workspaces.delete(frame.tabId ?? '')
        this.emit({ kind: 'closed', tabId: frame.tabId ?? '' })
      }
      if (frame.op === 'close.conversation') {
        for (const [tabId, owner] of [...this.owners]) {
          if (owner === frame.conversationId) {
            this.owners.delete(tabId)
            this.workspaces.delete(tabId)
            this.emit({ kind: 'closed', tabId })
          }
        }
      }
      if (frame.op === 'download.arm') {
        const tabId = frame.tabId ?? ''
        const path = frame.path ?? ''
        const clash = [...this.arms].find(([id, arm]) => id !== tabId && arm.path === path)
        if (clash) error = `目标路径已被标签页 ${clash[0]} 的下载授权占用`
        else this.arms.set(tabId, { downloadId: frame.downloadId ?? '', path })
      }
      if (frame.op === 'download.disarm') {
        const tabId = frame.tabId ?? ''
        const held = this.arms.get(tabId)
        const match = held !== undefined && held.downloadId === frame.downloadId
        if (match) this.arms.delete(tabId)
        data.removed = match
      }
      const reply = JSON.stringify({
        type: 'browser.result',
        requestId: frame.requestId,
        connectionEpoch: frame.connectionEpoch,
        ok: error === undefined,
        ...(error === undefined ? { data } : { error }),
      })
      const held = this.hold?.op === frame.op ? this.hold : null
      if (held) {
        this.hold = null
        void held.gate.then(() => socket.send(reply))
      } else socket.send(reply)
      if (frame.op === 'create') this.onCreate?.()
    }
  }

  /**
   * 一次下载进入终态：消费该页的授权，并把其身份写入事件。
   *
   * 真实宿主把 downloadId 绑定到 `ICoreWebView2DownloadOperation` 上并随终态回报，
   * 因此此处只能从被消费的授权取得身份，不能由调用方另行提供。
   */
  finishDownload(
    tabId: string,
    over: Omit<BrowserEventFrame, 'type' | 'connectionEpoch' | 'seq' | 'tabId' | 'downloadId'>,
  ): void {
    const arm = this.arms.get(tabId)
    this.arms.delete(tabId)
    this.emit({ ...over, tabId, ...(arm ? { downloadId: arm.downloadId } : {}) })
  }

  /** 用户在某个工作区新开一页：归属为 `null`，经由 `opened` 进入存活快照。 */
  userOpen(tabId: string, workspaceId = WS, url = 'http://127.0.0.1:1/page'): void {
    this.owners.set(tabId, null)
    this.workspaces.set(tabId, workspaceId)
    this.emit({
      kind: 'opened',
      tabId,
      url,
      title: '用户开的页',
      marker: this.marker,
      workspaceId,
      conversationId: null,
    })
  }

  static async connect(port: number): Promise<AutoHost> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_BROWSER_PATH}`, {
      headers: { [NATIVE_HOST_KEY_HEADER]: HOST_KEY },
    })
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('宿主连接失败'))
    })
    const host = new AutoHost(socket)
    cleanups.push(() => host.socket.close())
    return host
  }

  ready(debugPort: number, runtimeVersion = '152.0.4191.66'): void {
    const frame: HostReadyFrame = {
      type: 'host.ready',
      hostInstanceId: 'h1',
      connectionEpoch: this.epoch,
      platform: 'windows',
      presentation: 'embedded',
      runtimeVersion,
      debugPort,
      tabs: [],
    }
    this.socket.send(JSON.stringify(frame))
  }

  ops(): string[] {
    return this.received.map((f) => f.op)
  }

  /** 宿主主动发送的事件：归属变化、下载终态、下载被拦截、导航均经由此方法。 */
  emit(frame: Omit<BrowserEventFrame, 'type' | 'connectionEpoch' | 'seq'>): void {
    this.socket.send(
      JSON.stringify({ type: 'browser.event', connectionEpoch: this.epoch, seq: 1, ...frame }),
    )
  }
}

interface Fixture {
  handle: ReturnType<typeof serve>
  store: Store
  content: ContentStore
  dir: string
  workspaceId: WorkspaceId
}

/** `settle` 缩短动作之后的等待上限，请求不结束的用例据此不按真实时间等待 5 秒或 30 秒。 */
function fresh(settle?: { networkIdleMs?: number; ceilingMs?: number }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-coord-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  const workspaceId = upsertWorkspace(store, dir, 'W').id
  const handle = serve({
    store,
    config,
    content,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    hostKey: HOST_KEY,
    ...(settle === undefined ? {} : { browserSettle: settle }),
  })
  cleanups.push(async () => {
    await handle.stop()
    content.close()
    store.close()
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删除失败与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return { handle, store, content, dir, workspaceId }
}

async function ready(settle?: {
  networkIdleMs?: number
  ceilingMs?: number
}): Promise<Fixture & { host: AutoHost; devtools: Devtools }> {
  const fixture = fresh(settle)
  const host = await AutoHost.connect(fixture.handle.port)
  const devtools = fakeDevtools(host.marker)
  host.ready(devtools.port)
  await until(() => fixture.handle.browser?.available() === true, '浏览器宿主完成注册')
  return { ...fixture, host, devtools }
}

/** 使用真实工具出口核对模型收到的回执。投递额度不设上限：成功的观察须经投递才能写入结果。 */
function browserContext(dir: string, browser: BrowserPort | undefined): ToolContext {
  return {
    workspaceRoot: dir,
    conversationId: 'cv_1',
    runId: 'rn_1',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    sink: null,
    port: new Ports(browser ? [provide(BrowserPort, browser)] : []).get,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

/**
 * 同一会话的两个执行者各自打开页面。
 *
 * 子 agent 与并行成员共用顶层会话 id，控制槽按会话划分时，从第二个执行者起均无法使用浏览器。
 */
test('同一会话的两个执行者各自打开页面，观察与动作各自完成', async () => {
  const { handle, host } = await ready()
  const first = handle.browser?.portFor('cv_1', WS)
  const second = handle.browser?.portFor('cv_1', WS)

  const [tabA, tabB] = await Promise.all([
    first?.open('http://127.0.0.1:1/a'),
    second?.open('http://127.0.0.1:1/b'),
  ])
  expect([tabA?.tabId, tabB?.tabId].sort()).toEqual(['bt_1', 'bt_2'])

  const [obA, obB] = await Promise.all([
    first?.observe({ tabId: tabA?.tabId ?? '' }),
    second?.observe({ tabId: tabB?.tabId ?? '' }),
  ])
  const [actA, actB] = await Promise.all([
    first?.act({
      tabId: tabA?.tabId ?? '',
      action: 'click',
      ref: firstRef(obA),
    }),
    second?.act({
      tabId: tabB?.tabId ?? '',
      action: 'click',
      ref: firstRef(obB),
    }),
  ])
  expect(actA?.element).toBe('dl')
  expect(actB?.element).toBe('dl')
  expect(host.ops().filter((op) => op === 'create')).toHaveLength(2)

  // 一方释放不影响另一方：控制槽按执行者划分，收尾只处理自身的控制槽。
  await first?.release()
  const again = await second?.observe({ tabId: tabB?.tabId ?? '' })
  expect(again?.tabId).toBeTruthy()
})

/**
 * 页级独占：第二个执行者操作同一页时被拒绝，且拒绝发生在发送帧之前。
 *
 * 缺少该限制时，两个执行者会同时附加到同一页并各自发送输入，宿主按页保存的下载授权
 * 也会互相覆盖。
 */
test('页面被占用后，另一个执行者的每种页面操作均被拒绝，宿主与浏览器不收到任何帧', async () => {
  const { handle, host, devtools } = await ready()
  const holder = handle.browser?.portFor('cv_1', WS)
  const other = handle.browser?.portFor('cv_1', WS)
  const tab = await holder?.open('http://127.0.0.1:1/page')
  await holder?.observe({ tabId: tab?.tabId ?? '' })
  const tabId = tab?.tabId ?? ''

  const frames = host.received.length
  const commands = devtools.commands()
  const target = join(tmpdir(), 'qywork-busy.bin')
  const blocked = [
    other?.bind(tabId),
    other?.observe({ tabId }),
    other?.navigate({ tabId, action: 'reload' }),
    other?.act({ tabId, action: 'click', ref: '' }),
    other?.wait({ tabId, selector: '#x', state: 'visible', timeoutMs: 1_000 }),
    other?.upload({ tabId, ref: '', paths: [target] }),
    other?.download({
      tabId,
      ref: '',
      absolutePath: target,
      idleMs: 1_000,
    }),
    other?.close(tabId),
  ]
  for (const call of blocked) {
    const err = await failure(call)
    expect(err.message).toMatch(/正被另一个任务操作/)
    expect((err as Error & { errorKind?: string }).errorKind).toBe('browser_busy')
    expect((err as Error & { executed?: boolean }).executed).toBe(false)
  }
  expect(host.received).toHaveLength(frames)
  expect(devtools.commands()).toBe(commands)

  // 另开一页不受影响：互斥范围为页面，而非会话。
  const mine = await other?.open('http://127.0.0.1:1/other')
  const obOther = await other?.observe({ tabId: mine?.tabId ?? '' })
  expect(obOther?.tabId).toBeTruthy()

  // 持有者释放之后可以接手。`release` 在收尾结束、控制槽移出表之后才返回。
  await holder?.release()
  const taken = await other?.observe({ tabId })
  expect(taken?.tabId).toBeTruthy()
})

/**
 * 设置页「浏览器控制」分组标题上的开关写入 `browserEnabled`。关闭后不再发布能力，
 * 运行中已取得的端口在下一次操作时被拒绝，且不发送任何帧。
 */
test('关闭浏览器控制后不发布能力，已发出的端口按未执行拒绝，重新开启后恢复', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  expect(handle.browser?.available()).toBe(true)
  config.browserEnabled = false
  try {
    expect(handle.browser?.available()).toBe(false)
    const frames = host.received.length
    for (const call of [port?.open('http://127.0.0.1:1/page'), port?.bind('bt_u')]) {
      const err = await failure(call)
      expect((err as Error & { errorKind?: string }).errorKind).toBe('browser_unavailable')
      expect((err as Error & { executed?: boolean }).executed).toBe(false)
    }
    expect(host.received).toHaveLength(frames)
  } finally {
    delete config.browserEnabled
  }
  expect(handle.browser?.available()).toBe(true)
  expect((await port?.open('http://127.0.0.1:1/page'))?.tabId).toBeTruthy()
})

/**
 * tabId 不可见的四种拒绝均在同步段中判定，未发送任何帧，回执因此与 busy 格式相同。
 *
 * 标为已执行时，模型会认为页面已被操作，不再换一页重试。
 */
test('不可见的 tabId 一律按未执行拒绝，宿主不收到任何帧', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u', WS)
  host.userOpen('bt_ub', 'ws_b')
  await listed(handle, 'bt_u')
  await listed(handle, 'bt_ub', true, 'ws_b')
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const other = handle.browser?.portFor('cv_2', WS)
  const frames = host.received.length

  const refused = [
    port?.observe({ tabId: 'bt_ub' }),
    other?.close(tab?.tabId ?? ''),
    port?.observe({ tabId: 'bt_u' }),
    port?.observe({ tabId: 'bt_x' }),
  ]
  for (const call of refused) {
    const err = await failure(call)
    expect((err as Error & { errorKind?: string }).errorKind).toBe('invalid_argument')
    expect((err as Error & { executed?: boolean }).executed).toBe(false)
  }
  expect(host.received).toHaveLength(frames)
})

test('同一会话的两个执行者同时接管一个用户页时只有一个成功，另一个未发送 bind 帧', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')
  const a = handle.browser?.portFor('cv_1', WS)
  const b = handle.browser?.portFor('cv_1', WS)

  const settled = await Promise.allSettled([a?.bind('bt_u'), b?.bind('bt_u')])
  expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const refused = settled.find((r) => r.status === 'rejected')
  expect(String(refused?.reason)).toMatch(/正被另一个任务操作/)
  // 失败方未发送任何帧：登记与冲突检查位于同一同步段中。
  expect(host.ops().filter((op) => op === 'bind')).toHaveLength(1)
})

/**
 * 占用从登记时起成立，不等待宿主回包。
 *
 * 等待回包后再登记时，`bind` 在途期间第二个执行者无法查询到持有者，双方都会附加到该页。
 */
test('bind 回包仍在途时，同一页对另一个执行者已处于占用状态', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')
  const a = handle.browser?.portFor('cv_1', WS)
  const b = handle.browser?.portFor('cv_1', WS)

  const g = gate()
  host.hold = { op: 'bind', gate: g.promise }
  const binding = a?.bind('bt_u')
  await until(() => host.ops().includes('bind'), 'bind 帧已发出')
  // 宿主先发出归属变更、回包被按住。归属到达服务端之前，页面操作先判定该页不归本会话，检查的不是占用；
  // 只等待 bind 帧发出时，结果取决于归属事件与下一步谁先执行。
  const probe = handle.browser?.portFor('cv_1', WS)
  await until(
    async () => ((await probe?.tabs()) ?? []).some((t) => t.tabId === 'bt_u' && t.controlled),
    'bt_u 的归属到达服务端',
  )

  expect((await failure(b?.observe({ tabId: 'bt_u' }))).message).toMatch(/正被另一个任务操作/)
  g.open()
  expect((await binding)?.tabId).toBe('bt_u')
})

/**
 * 附页失败不保留占用，收尾中的占用也不提前解除。
 *
 * 旧连接的取消会清理页内等待器与按住的输入，接手者此时登记的等待器会被该次清理
 * 一并清除，因此须等整个控制槽收尾结束后再释放。
 */
test('持有者正在收尾时，接手者等待其结束后再占用页面，不报告占用中', async () => {
  const { handle, devtools } = await ready()
  const holder = handle.browser?.portFor('cv_1', WS)
  const next = handle.browser?.portFor('cv_1', WS)
  const tab = await holder?.open('http://127.0.0.1:1/page')
  await holder?.observe({ tabId: tab?.tabId ?? '' })

  const g = gate()
  devtools.hold = { method: 'Target.detachFromTarget', gate: g.promise }
  const releasing = holder?.release()

  let taken = false
  const pending = next?.observe({ tabId: tab?.tabId ?? '' }).then((ob) => {
    taken = true
    return ob
  })
  await until(
    () => devtools.calls.some((c) => c.method === 'Target.detachFromTarget'),
    '持有者的收尾阻塞于 detach',
  )
  // 收尾结束之前不释放，也不使接手者失败。接手者在等待收尾时没有可观察的标志，
  // 只能留出一段时间确认它没有提前取得该页。
  await settle()
  expect(taken).toBe(false)

  g.open()
  await releasing
  expect((await pending)?.tabId).toBeTruthy()
})

/**
 * `opened` 先于 create 回包到达，另一个执行者据此先占用了该页。
 *
 * 建页不预先占用，先操作的一方先持有；创建者随后收到明确的失败，不抢占，也不另行记录预订。
 */
test('建页不占用页面：其他执行者先操作该页时，创建者随后被拒绝，页面不被回收', async () => {
  const { handle, host } = await ready()
  const creator = handle.browser?.portFor('cv_1', WS)
  const rival = handle.browser?.portFor('cv_1', WS)

  const g = gate()
  host.hold = { op: 'create', gate: g.promise }
  const opening = creator?.open('http://127.0.0.1:1/page')
  await listed(handle, 'bt_1', true, WS, 'cv_1')
  // 回包尚未到达，`opened` 已到达：另一个执行者据此占用该页。
  const ob = await rival?.observe({ tabId: 'bt_1' })
  expect(ob?.tabId).toBeTruthy()

  g.open()
  expect((await opening)?.tabId).toBe('bt_1')
  expect((await failure(creator?.observe({ tabId: 'bt_1' }))).message).toMatch(/正被另一个任务操作/)
  // 建页不附加页面，也不因无法取得控制权而关闭页面。
  expect(host.ops()).not.toContain('close')
  expect((await creator?.tabs())?.map((t) => t.tabId)).toEqual(['bt_1'])
})

test('建页回包晚于释放时如实返回该页，不附加也不回收', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const opening = port?.open('http://127.0.0.1:1/page')
  let releasing: Promise<void> | undefined
  host.onCreate = () => {
    host.onCreate = null
    releasing = port?.release()
  }
  expect((await opening)?.tabId).toBe('bt_1')
  await releasing
  await hostRoundtrip(handle)
  expect(host.ops()).not.toContain('close')
  // 页面保留在宿主上，归属不变，下一条消息继续使用。
  expect((await handle.browser?.portFor('cv_1', WS).tabs())?.map((t) => t.tabId)).toEqual(['bt_1'])
})

test('附页过程中页面被关闭时不恢复该页，占用随之释放', async () => {
  const { handle, host, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''

  const g = gate()
  devtools.hold = { method: 'Target.attachToTarget', gate: g.promise }
  const pending = port?.observe({ tabId })
  await until(
    () => devtools.calls.some((c) => c.method === 'Target.attachToTarget'),
    '附页请求已发出',
  )
  host.emit({ kind: 'closed', tabId })
  await listed(handle, tabId, false, WS, 'cv_1')
  g.open()
  // 迟到的附加回包在 observe 失败之前处理完毕：重新登记若发生，此时已经发生。
  expect((await failure(pending)).message).toMatch(/已经关闭/)
  // 该页已不在存活表中：迟到的附加不能将其重新登记。
  expect((await failure(port?.observe({ tabId }))).message).toMatch(/无法识别的标签页/)
})

test('删除会话时收尾该会话的全部控制槽，只发送一次按会话关页', async () => {
  const { handle, host } = await ready()
  const mine = [1, 2, 3].map(() => handle.browser?.portFor('cv_1', WS))
  const other = handle.browser?.portFor('cv_2', WS)
  for (const port of mine) {
    const tab = await port?.open('http://127.0.0.1:1/page')
    await port?.observe({ tabId: tab?.tabId ?? '' })
  }
  const tabC = await other?.open('http://127.0.0.1:1/c')
  await other?.observe({ tabId: tabC?.tabId ?? '' })

  // 宿主先发出 closed 再返回结果，同一条连接按序处理：返回时存活快照已更新。
  await handle.browser?.closeConversation('cv_1')
  expect(host.received.filter((f) => f.op === 'close.conversation')).toHaveLength(1)
  // 三个控制槽均已收尾，名下的页全部关闭；其他会话的页不受影响。
  expect(await handle.browser?.portFor('cv_1', WS).tabs()).toEqual([])
  expect((await other?.tabs())?.map((t) => t.tabId)).toEqual([tabC?.tabId ?? ''])
})

test('同一会话的三个执行者逐个释放后控制槽全部清空，页面仍保留在宿主上，重复释放加入同一次收尾', async () => {
  const { handle, host } = await ready()
  const ports = [1, 2, 3].map(() => handle.browser?.portFor('cv_1', WS))
  const tabs: string[] = []
  for (const port of ports) {
    const tab = await port?.open('http://127.0.0.1:1/page')
    await port?.observe({ tabId: tab?.tabId ?? '' })
    tabs.push(tab?.tabId ?? '')
  }
  for (const port of ports) await Promise.all([port?.release(), port?.release()])
  await hostRoundtrip(handle)

  // 释放只收回控制权，不关闭页面。
  expect(host.ops()).not.toContain('close')
  const next = handle.browser?.portFor('cv_1', WS)
  expect((await next?.tabs())?.map((t) => t.tabId).sort()).toEqual([...tabs].sort())
  // 三页均不再被占用：新执行者可逐个接手。
  for (const tabId of tabs) {
    expect((await next?.observe({ tabId }))?.tabId).toBeTruthy()
  }
})

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 一轮工具调用。成员会话据此调用内置浏览器工具，经由真实的工具执行器。 */
function toolTurn(id: string, name: string, args: Record<string, unknown>): string {
  return sse([
    { type: 'response.created', response: { id: `resp_${id}` } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: `fc_${id}`,
      delta: JSON.stringify(args),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: {
        id: `resp_${id}`,
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

/**
 * 停止链路：真实的 `conversation.interrupt` 指令 → 子 agent 表 → 成员 Session 收尾 →
 * 各自释放控制槽。页面保留在宿主上，下一个执行者可以接手。
 *
 * 直接调用协调器的 release 无法替代该链路：本用例验证装配链路的每一环都能传递，
 * 缺少任一环时，停止后两页会一直被占用，且没有入口可以解除。
 */
test('停止指令收回每个成员的控制槽，页面保留在宿主上供下一个执行者使用', async () => {
  const { handle, host, store, content, dir, workspaceId } = await ready()

  const parked = gate()
  const turns = new Map<string, number>()
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const who = body.includes('开甲页') ? 'a' : 'b'
      const seen = (turns.get(who) ?? 0) + 1
      turns.set(who, seen)
      if (seen === 1) {
        const args = { action: 'create', url: `http://127.0.0.1:1/${who}` }
        return new Response(toolTurn(`${who}1`, 'browser_tabs', args), { headers: SSE_HEADERS })
      }
      if (seen === 2) {
        const tabId = /bt_\d+/.exec(body)?.[0] ?? ''
        return new Response(toolTurn(`${who}2`, 'browser_observe', { tabId }), {
          headers: SSE_HEADERS,
        })
      }
      // 两个成员都停留在本次请求上：停止发生时它们各自占用一页。
      await parked.promise
      return new Response('已取消', { status: 499 })
    },
  })
  cleanups.push(() => provider.stop(true))

  const memberConfig: QyConfig = {
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
  }

  const bus = new EventBus()
  const subagents = new SubagentRegistry()
  const runs = new RunManager(store, bus, subagents)
  const parent = createConversation(store, {
    workspaceId,
    provider: 'fake',
    model: 'm',
    title: '停止',
  }).id
  const runId = createRun(store, {
    conversationId: parent,
    workspaceId,
    provider: 'p',
    model: 'm',
    clientRequestId: 'stop-link',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
  // 顶层轮次同样登记到 RunManager：停止指令的两条分支都须实际执行。
  const parentRun = new AbortController()
  runs.reserve(parent, parentRun)
  runs.register(parent, runId)

  const deps = {
    store,
    content,
    config: memberConfig,
    bus,
    runs,
    subagents,
    ...(handle.browser ? { browser: handle.browser } : {}),
  }
  const dispatcher = makeDelegate({
    deps,
    workspaceRoot: dir,
    conversationId: parent,
    deliver: () => {},
  })
  await dispatcher.dispatch({
    target: { kind: 'temp', name: '甲' },
    task: '开甲页',
    runId,
    stepId: 'st_1',
  })
  await dispatcher.dispatch({
    target: { kind: 'temp', name: '乙' },
    task: '开乙页',
    runId,
    stepId: 'st_2',
  })
  await until(() => turns.get('a') === 3 && turns.get('b') === 3, '两个成员各占一页')
  expect(host.ops().filter((op) => op === 'create')).toHaveLength(2)

  const ws = {
    data: { authed: true, id: 'ws_1' },
    send: () => {},
  } as unknown as ServerWebSocket<SocketData>
  await handleCommand({ type: 'conversation.interrupt', conversationId: parent }, { ...deps, ws })
  expect(parentRun.signal.aborted).toBe(true)
  await until(() => !subagents.has(parent), '两个成员均已收尾')
  const frames = host.received.length

  // 收尾之后两页均不再被占用，下一个执行者可直接接手。成员移出子 agent 表之前已开始释放，
  // 接手者的观察等待各自的收尾结束后才返回。
  const next = handle.browser?.portFor(parent, workspaceId)
  expect((await next?.tabs())?.map((t) => t.tabId).sort()).toEqual(['bt_1', 'bt_2'])
  expect((await next?.observe({ tabId: 'bt_1' }))?.tabId).toBeTruthy()
  expect((await next?.observe({ tabId: 'bt_2' }))?.tabId).toBeTruthy()

  // 停止之后不再向宿主发送帧，也不关闭页面：停止只收回控制权。观察只经调试端点，不向宿主发帧；
  // 收尾已在上面两次观察返回之前结束，收尾发出的帧此时都已到达。
  expect(host.received).toHaveLength(frames)
  expect(host.ops()).not.toContain('close')
  expect(host.ops()).not.toContain('close.conversation')
  parked.open()
})

/**
 * 设计稿渲染：原始失败形状是模型在 1280×800 的标签页里核对 960×1280 的设计稿卡，按错误的版面修改页面。
 * 渲染使用隐藏页（不列入界面页签条与模型的页清单），视口设为页面声明的尺寸，结束后关闭该页。
 */
test('设计稿渲染：隐藏页按页面尺寸设定视口，经引导页写入内嵌了图片的页面并截图，结束后关闭', async () => {
  const { handle, host, devtools, dir } = await ready()
  const browser = handle.browser!
  mkdirSync(join(dir, '素材'), { recursive: true })
  mkdirSync(join(dir, '设计'), { recursive: true })
  writeFileSync(join(dir, '素材', 'a.png'), Buffer.from([1, 2, 3]))
  const pagePath = join(dir, '设计', '首页.html')
  const html =
    '<!doctype html><html><head><meta name="viewport" content="width=960, height=1280"></head>' +
    '<body><img src="../素材/a.png"></body></html>'
  writeFileSync(pagePath, html)

  const during: { tabs?: Promise<unknown> } = {}
  devtools.onCommand = (method) => {
    if (method === 'Page.captureScreenshot' && !during.tabs)
      during.tabs = browser.portFor('cv_a', WS).tabs()
  }
  const service = new CanvasService({ publish: () => {} })
  await service.docs.create(dir, { path: 'board.canvas.json' })
  await service.docs.apply(dir, 'board.canvas.json', [
    { op: 'add_file', path: '设计/首页.html', name: '首页' },
  ])
  const port = canvasPort(service, { id: WS, root: dir }, artRenderOf(browser, 'cv_a', WS, dir))
  const [shot] = await port.render!('board.canvas.json', ['首页'])
  expect(shot).toEqual({ name: '首页', size: { w: 960, h: 1280 }, png: SHOT, errors: [] })

  expect(host.received.find((f) => f.op === 'create')).toMatchObject({
    conversationId: 'cv_a',
    url: 'about:blank',
    hidden: true,
  })
  expect(host.ops().at(-1)).toBe('close')
  expect(await during.tabs).toEqual([])
  const params = (method: string) =>
    devtools.calls.filter((c) => c.method === method).map((c) => c.params)
  expect(params('Emulation.setDeviceMetricsOverride')).toEqual([
    { width: 960, height: 1280, deviceScaleFactor: 1, mobile: false },
  ])
  expect(String(params('Page.navigate')[0]?.url)).toEndWith('/art/host')
  const posted = String(
    params('Runtime.evaluate').find((p) => String(p.expression).includes('qywork-art-load'))
      ?.expression,
  )
  expect(posted).toContain('src=\\"data:image/png;base64,AQID\\"')
  expect(posted).toContain('/art/lib/three.module.js')
})

test('两条会话各自建页、观察、执行动作，互不影响', async () => {
  const { handle, host } = await ready()
  const a = handle.browser?.portFor('cv_a', WS)
  const b = handle.browser?.portFor('cv_b', WS)

  const [tabA, tabB] = await Promise.all([
    a?.open('http://127.0.0.1:1/a'),
    b?.open('http://127.0.0.1:1/b'),
  ])
  expect([tabA?.tabId, tabB?.tabId].sort()).toEqual(['bt_1', 'bt_2'])

  const [obA, obB] = await Promise.all([
    a?.observe({ tabId: tabA?.tabId ?? '' }),
    b?.observe({ tabId: tabB?.tabId ?? '' }),
  ])
  const [actA, actB] = await Promise.all([
    a?.act({
      tabId: tabA?.tabId ?? '',
      action: 'click',
      ref: firstRef(obA),
    }),
    b?.act({
      tabId: tabB?.tabId ?? '',
      action: 'click',
      ref: firstRef(obB),
    }),
  ])
  expect(actA?.element).toBe('dl')
  expect(actB?.element).toBe('dl')
  // 两条会话各自建了一页，均未被 busy 拒绝。
  expect(host.ops().filter((op) => op === 'create')).toHaveLength(2)

  // 对方的 tabId 无法取得：归属检查在附页之前，动作连同其观察编号一并被拦截。
  expect((await failure(a?.observe({ tabId: tabB?.tabId ?? '' }))).message).toMatch(/不归本会话/)
  expect(
    (
      await failure(
        b?.act({
          tabId: tabA?.tabId ?? '',
          action: 'click',
          ref: firstRef(obB),
        }),
      )
    ).message,
  ).toMatch(/不归本会话/)
})

test('一条会话释放不影响另一条：B 的页、观察与连接均保留', async () => {
  const { handle } = await ready()
  const a = handle.browser?.portFor('cv_a', WS)
  const b = handle.browser?.portFor('cv_b', WS)
  const tabA = await a?.open('http://127.0.0.1:1/a')
  const tabB = await b?.open('http://127.0.0.1:1/b')
  const obB = await b?.observe({ tabId: tabB?.tabId ?? '' })

  await a?.release()

  expect((await failure(a?.observe({ tabId: tabA?.tabId ?? '' }))).message).toMatch(/已经结束/)
  const acted = await b?.act({
    tabId: tabB?.tabId ?? '',
    action: 'click',
    ref: firstRef(obB),
  })
  expect(acted?.element).toBe('dl')
})

test('两条会话同时接管同一个用户页，只有一条成功', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')
  const a = handle.browser?.portFor('cv_a', WS)
  const b = handle.browser?.portFor('cv_b', WS)

  const settled = await Promise.allSettled([a?.bind('bt_u'), b?.bind('bt_u')])
  const ok = settled.filter((r) => r.status === 'fulfilled')
  expect(ok).toHaveLength(1)
  // 页级占用先成立，后到的一方未发出 bind 帧；归属检查由宿主在下一次操作时拒绝。
  const refused = settled.find((r) => r.status === 'rejected')
  expect(String(refused?.reason)).toMatch(/正被另一个任务操作/)
  expect(host.ops().filter((op) => op === 'bind')).toHaveLength(1)
})

test('停止之后同一会话立即重新启动，新执行不受上一次收尾的影响', async () => {
  const { handle, host } = await ready()
  const first = handle.browser?.portFor('cv_1', WS)
  await first?.open('http://127.0.0.1:1/page')

  // 不等待收尾完成即启动下一轮：该页在上一次清理结束后才释放，而不是返回 busy。
  const releasing = first?.release()
  const second = handle.browser?.portFor('cv_1', WS)
  const ob = await second?.observe({ tabId: 'bt_1' })
  await releasing
  expect(ob?.tabId).toBeTruthy()

  // 收尾属于旧控制槽，不能清除新控制槽的观察表。旧控制槽的收尾已随 `releasing` 结束。
  const acted = await second?.act({
    tabId: 'bt_1',
    action: 'click',
    ref: firstRef(ob),
  })
  expect(acted?.element).toBe('dl')
  expect(host.ops()).not.toContain('close')
})

test('宿主断开使全部控制作废，重连之后的新执行照常创建控制槽', async () => {
  const { handle, host } = await ready()
  const before = handle.browser?.portFor('cv_1', WS)
  await before?.open('http://127.0.0.1:1/page')

  host.socket.close()
  await until(() => handle.browser?.available() === false, '宿主断开')
  expect((await failure(before?.observe({ tabId: 'bt_1' }))).message).toMatch(/不可用|已经结束/)

  const again = await AutoHost.connect(handle.port)
  again.epoch = 2
  again.ready(fakeDevtools(again.marker).port)
  await until(() => handle.browser?.available() === true, '宿主重连')
  const after = handle.browser?.portFor('cv_1', WS)
  const tab = await after?.open('http://127.0.0.1:1/page')
  expect(tab?.tabId).toBe('bt_1')
  // 旧控制槽的收尾按槽对象删除表项，不会删除重连之后新建的控制槽。旧槽没有调试连接，
  // 收尾只含微任务，在断开被处理时即已结束。
  const ob = await after?.observe({ tabId: tab?.tabId ?? '' })
  expect(ob?.tabId).toBeTruthy()
})

test('CDP 单独断连后，同一执行可观察原页和新页，旧观察失效且其他执行不受影响', async () => {
  const { handle, host, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const other = handle.browser?.portFor('cv_2', WS)
  await port?.open('http://127.0.0.1:1/page')
  const old = await port?.observe({ tabId: 'bt_1' })
  await other?.open('http://127.0.0.1:1/page')
  const unaffected = await other?.observe({ tabId: 'bt_2' })

  devtools.disconnect(0)
  // 调试连接由端点一侧关闭，客户端收到关闭帧后才收尾该控制槽，这一步没有宿主帧或调试命令
  // 可供观察（Bun 服务端的 close 回调在调用 close 时同步执行，早于客户端收到关闭帧）。
  await settle()
  expect(handle.browser?.available()).toBe(true)
  expect(host.owners.get('bt_1')).toBe('cv_1')
  const restored = await port?.observe({ tabId: 'bt_1' })
  expect(restored?.tabId).toBeTruthy()
  // 文档未更换：重连之后同一个节点仍是原编号，断开之前取得的编号照常可用。
  expect(firstRef(restored)).toBe(firstRef(old))
  const again = await port?.act({ tabId: 'bt_1', action: 'click', ref: firstRef(old) })
  expect(again?.element).toBe('dl')
  expect(devtools.clicks()).toBe(1)
  expect(
    (
      await other?.act({
        tabId: 'bt_2',
        action: 'click',
        ref: firstRef(unaffected),
      })
    )?.element,
  ).toBe('dl')

  await port?.open('http://127.0.0.1:1/page')
  expect(
    (await port?.wait({ tabId: 'bt_3', selector: 'h1', state: 'visible', timeoutMs: 1000 }))?.met,
  ).toBe(true)
  expect(host.ops()).not.toContain('close')
})

test('控制连接建立失败明确声明页面操作未执行，端点恢复后同一执行可继续观察', async () => {
  const { handle, devtools, dir } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, new Ports([provide(BrowserPort, {} as BrowserPort)]))
  await port?.open('http://127.0.0.1:1/page')
  devtools.rejectConnections = true
  const result = await registry
    .get('browser_observe')
    ?.fn({ tabId: 'bt_1' }, browserContext(dir, port))
  expect(result).toMatchObject({
    status: 'failure',
    errorKind: 'browser_disconnected',
    executed: false,
  })
  expect(result?.message).toContain('browser_observe')
  expect(result?.message).toContain('未执行')
  expect(devtools.commands()).toBe(0)
  devtools.rejectConnections = false
  expect((await port?.observe({ tabId: 'bt_1' }))?.tabId).toBeTruthy()
})

/**
 * 页面中指向凭证文件的帧在受控之前已加载（建页时的首次加载即如此）：观察与等待都不采集页面内容，回执说明
 * 重新加载；在拦截下重新加载之后该帧显示错误页，观察照常进行。工作区中的本地页面与其子资源不受影响。
 *
 * 原始失败形状：观察按 DOM 与 AX 树采集全部同进程帧，`<iframe src="file:///…/.ssh/id_rsa">` 中的私钥
 * 随元素表交给模型。
 */
test('受控之前加载了凭证文件的页：读取页面内容之前拒绝，重新加载之后照常观察', async () => {
  const { handle, devtools, dir } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, new Ports([provide(BrowserPort, {} as BrowserPort)]))
  const page = pathToFileURL(join(dir, 'site', 'index.html')).href
  const style = pathToFileURL(join(dir, 'site', 'style.css')).href
  const key = pathToFileURL(join(dir, 'home', '.ssh', 'id_rsa')).href
  await port?.open(page)
  devtools.resourceTree = {
    frame: { id: 'frame-1', url: page },
    resources: [{ url: style, type: 'Stylesheet' }],
    childFrames: [{ frame: { id: 'frame-2', url: key }, resources: [] }],
  }
  const ctx = browserContext(dir, port)
  const observed = await registry.get('browser_observe')?.fn({ tabId: 'bt_1' }, ctx)
  expect(observed).toMatchObject({
    status: 'failure',
    executed: false,
    errorKind: 'credential_path',
  })
  expect(observed?.message).toContain(key)
  expect(observed?.message).toContain('reload')
  const waited = await registry.get('browser_wait')?.fn({ tabId: 'bt_1', selector: 'pre' }, ctx)
  expect(waited).toMatchObject({ status: 'failure', executed: false, errorKind: 'credential_path' })
  // 页面内容一项都没有读取：DOM 快照、AX 树、截图与页内等待器均未发出。
  const reads = devtools.calls.filter(
    (c) =>
      ['DOM.getDocument', 'Accessibility.getFullAXTree', 'Page.captureScreenshot'].includes(
        c.method,
      ) || String(c.params.expression ?? '').startsWith('window.__qyworkWait('),
  )
  expect(reads).toEqual([])

  // 拦截下重新加载：凭证帧以拒绝访问失败并显示错误页，作为图片引用的同一文件加载失败。
  devtools.resourceTree = {
    frame: { id: 'frame-1', url: page },
    resources: [
      { url: style, type: 'Stylesheet' },
      { url: key, type: 'Image', failed: true },
    ],
    childFrames: [
      { frame: { id: 'frame-2', url: 'chrome-error://chromewebdata/', unreachableUrl: key } },
    ],
  }
  const reloaded = await registry
    .get('browser_navigate')
    ?.fn({ tabId: 'bt_1', action: 'reload' }, ctx)
  expect(reloaded?.status).toBe('success')
})

/**
 * 受控期间页面发出的 file 请求按最近一次调用的读取范围逐个裁决：凭证文件以拒绝访问失败，工作区中的文件继续加载；
 * 切换为完全访问之后的调用提供不裁决的范围。
 *
 * 原始失败形状：页会话不拦截任何请求，受控期间页面的脚本跳转与新插入的 iframe 直接加载凭证文件。
 */
test('受控期间页面发出的 file 请求按本次调用的读取范围裁决', async () => {
  const { handle, devtools, dir } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, new Ports([provide(BrowserPort, {} as BrowserPort)]))
  const key = pathToFileURL(join(dir, 'home', '.ssh', 'id_rsa')).href
  const local = pathToFileURL(join(dir, 'site', 'next.html')).href
  await port?.open('http://127.0.0.1:1/page')
  const ctx = browserContext(dir, port)
  expect(await registry.get('browser_observe')?.fn({ tabId: 'bt_1' }, ctx)).toMatchObject({
    status: 'success',
  })
  const answer = (requestId: string) =>
    devtools.calls.find(
      (c) =>
        c.method !== 'Fetch.enable' &&
        c.method.startsWith('Fetch.') &&
        c.params.requestId === requestId,
    )
  const paused = (requestId: string, url: string) =>
    devtools.emit('Fetch.requestPaused', { requestId, request: { url } })
  paused('r1', key)
  paused('r2', local)
  await until(() => answer('r1') !== undefined && answer('r2') !== undefined, '两个请求均已应答')
  expect(answer('r1')).toMatchObject({
    method: 'Fetch.failRequest',
    params: { errorReason: 'AccessDenied' },
  })
  expect(answer('r2')?.method).toBe('Fetch.continueRequest')

  await registry.get('browser_observe')?.fn({ tabId: 'bt_1' }, { ...ctx, unrestrictedPaths: true })
  paused('r3', key)
  await until(() => answer('r3') !== undefined, '完全访问下的请求已应答')
  expect(answer('r3')?.method).toBe('Fetch.continueRequest')
})

test('浏览器工具从未设置本机文件裁决的执行中，file 请求一律拒绝', async () => {
  const { handle, devtools, dir } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  await port?.observe({ tabId: 'bt_1' })
  devtools.emit('Fetch.requestPaused', {
    requestId: 'r1',
    request: { url: pathToFileURL(join(dir, 'site', 'index.html')).href },
  })
  await until(
    () => devtools.calls.some((c) => c.method === 'Fetch.failRequest'),
    '未设置裁决时的请求已应答',
  )
  expect(devtools.calls.some((c) => c.method === 'Fetch.continueRequest')).toBe(false)
})

test('点击发出后 CDP 断连时保留结果不明，不重放点击，下一次观察时恢复', async () => {
  const { handle, devtools, dir } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, new Ports([provide(BrowserPort, {} as BrowserPort)]))
  await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: 'bt_1' })
  const held = gate()
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent') return
    if (devtools.clicks() === 0) {
      devtools.hold = { method, gate: held.promise }
    } else devtools.disconnect()
  }
  const result = await registry.get('browser_act')?.fn(
    {
      tabId: 'bt_1',
      action: 'click',
      ref: firstRef(ob),
    },
    browserContext(dir, port),
  )
  held.open()
  // 按下已发出而抬起无法发出：结果未知，如实列出按下的鼠标键，不按未执行处理。
  expect(result).toMatchObject({
    status: 'failure',
    errorKind: 'browser_unknown',
    executed: true,
  })
  expect(result?.message).toContain('结果未知（CDP 连接已断开）')
  expect(result?.message).toContain('未确认松开：left')
  expect(result?.message).toContain('结果可能不明')
  expect(result?.message).toContain('不要直接重复')
  expect(devtools.clicks()).toBe(1)
  devtools.onCommand = null
  expect((await port?.observe({ tabId: 'bt_1' }))?.tabId).toBeTruthy()
  expect(devtools.clicks()).toBe(1)
})

test('不属于本会话的标签页在发送请求之前被拦截，属于本会话的照常携带会话 id 发送', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  const before = host.received.length

  const target = join(tmpdir(), 'qywork-not-owned.bin')
  expect(
    (
      await failure(
        port?.download({
          tabId: 'bt_9',
          ref: firstRef(ob),
          absolutePath: target,
          idleMs: 5_000,
        }),
      )
    ).message,
  ).toMatch(/bt_9/)
  expect((await failure(port?.close('bt_9'))).message).toMatch(/bt_9/)
  expect(host.received).toHaveLength(before)

  // 属于本会话的页照常发送到宿主，并携带本会话 id。
  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    idleMs: 5_000,
  })
  await until(() => host.arms.has('bt_1'), '宿主登记下载授权')
  const arm = host.received.findLast((f) => f.op === 'download.arm')
  expect(arm?.tabId).toBe('bt_1')
  expect(arm?.path).toBe(target)
  expect(arm?.conversationId).toBe('cv_1')

  host.finishDownload('bt_1', { kind: 'download.blocked', reason: 'exists' })
  expect(await pending).toEqual({ blocked: 'exists' })
})

test('归属跨消息稳定：同一会话的下一条消息直接操作，不经交接、不经 bind', async () => {
  const { handle, host } = await ready()
  // 第一条消息：建页、观察、释放。
  const first = handle.browser?.portFor('cv_1', WS)
  const tab = await first?.open('http://127.0.0.1:1/page')
  await first?.observe({ tabId: tab?.tabId ?? '' })
  await first?.release()

  // 第二条消息：新端口，同一会话。直接调用 observe 即可：该页仍属于 cv_1。
  const second = handle.browser?.portFor('cv_1', WS)
  const ob = await second?.observe({ tabId: 'bt_1' })
  expect(ob?.tabId).toBeTruthy()
  // 全程没有 bind、没有交接：宿主只收到过一次 create。
  expect(host.ops()).toEqual(['create'])
  // 归属保留，该页对 cv_1 可控。
  expect(await second?.tabs()).toEqual([
    { tabId: 'bt_1', url: 'http://127.0.0.1:1/page', title: '夹具页', controlled: true },
  ])
})

test('其他会话无法查看或操作本会话的页', async () => {
  const { handle } = await ready()
  const owner = handle.browser?.portFor('cv_a', WS)
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  // 另一条会话：该页不在其存活清单中。
  const other = handle.browser?.portFor('cv_b', WS)
  expect(await other?.tabs()).toEqual([])
  // 强制指定该页同样无法取得：归属不一致，在附页之前即被拦截。
  expect((await failure(other?.observe({ tabId: 'bt_1' }))).message).toMatch(/不归本会话/)
})

test('用户打开的页默认不可操作，点名 bind 后才归属本会话', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')

  const port = handle.browser?.portFor('cv_1', WS)
  // 用户页会列出，但标记为不可控：AI 不自动操作。
  expect(await port?.tabs()).toEqual([
    { tabId: 'bt_u', url: 'http://127.0.0.1:1/page', title: '用户开的页', controlled: false },
  ])
  expect((await failure(port?.observe({ tabId: 'bt_u' }))).message).toMatch(/不归本会话/)

  // 用户在聊天中点名，模型按 tabId 接管。接管只修改归属，不修改该页的标题。
  // 宿主先发出 control 再返回结果，bind 返回时快照已带有新归属。
  await port?.bind('bt_u')
  expect(await port?.tabs()).toEqual([
    { tabId: 'bt_u', url: 'http://127.0.0.1:1/page', title: '用户开的页', controlled: true },
  ])
  // 接管之后可直接操作。
  const ob = await port?.observe({ tabId: 'bt_u' })
  expect(ob?.tabId).toBeTruthy()
})

/** AI 主动关页与其他页面操作经由同一准入检查：归属、工作区、页级占用均须校验。 */
test('本控制槽持有的页可以关闭，未接管的用户页与其他会话的页无法关闭', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  await port?.observe({ tabId })
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')

  expect((await failure(port?.close('bt_u'))).message).toMatch(/不归本会话/)
  const other = handle.browser?.portFor('cv_2', WS)
  expect((await failure(other?.close(tabId))).message).toMatch(/不归本会话/)
  expect(host.ops()).not.toContain('close')

  await port?.close(tabId)
  expect(host.received.filter((f) => f.op === 'close').map((f) => f.tabId)).toEqual([tabId])
  expect((await port?.tabs())?.map((t) => t.tabId)).toEqual(['bt_u'])
})

test('持有者释放之后，另一个执行者可以关闭该页', async () => {
  const { handle, host } = await ready()
  const holder = handle.browser?.portFor('cv_1', WS)
  const next = handle.browser?.portFor('cv_1', WS)
  const tab = await holder?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  await holder?.observe({ tabId })

  expect((await failure(next?.close(tabId))).message).toMatch(/正被另一个任务操作/)
  await holder?.release()
  await next?.close(tabId)
  expect(host.received.filter((f) => f.op === 'close').map((f) => f.tabId)).toEqual([tabId])
})

test('其他会话无法接管已归属其他会话的页', async () => {
  const { handle } = await ready()
  const owner = handle.browser?.portFor('cv_a', WS)
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  const other = handle.browser?.portFor('cv_b', WS)
  expect((await failure(other?.bind('bt_1'))).message).toMatch(/另一条会话/)
})

/**
 * 工作区是列出页面时的第一层过滤，会话归属在其之上。
 *
 * 缺少该过滤时，B 工作区的用户页会出现在 A 的会话清单中并可被 `bind` 接管，
 * 该页此后属于 A 的会话，却显示在 B 的页签栏上。
 */
test('只列出本工作区中属于本会话或用户的页', async () => {
  const { handle, host } = await ready()
  const other = 'ws_b'
  host.userOpen('bt_ua', WS)
  host.userOpen('bt_ub', other)
  await listed(handle, 'bt_ua')
  await listed(handle, 'bt_ub', true, other)

  const inA = handle.browser?.portFor('cv_a', WS)
  const inB = handle.browser?.portFor('cv_b', other)
  const tabA = await inA?.open('http://127.0.0.1:1/a')
  const tabB = await inB?.open('http://127.0.0.1:1/b')

  expect((await inA?.tabs())?.map((t) => t.tabId).sort()).toEqual(
    [tabA?.tabId ?? '', 'bt_ua'].sort(),
  )
  expect((await inB?.tabs())?.map((t) => t.tabId).sort()).toEqual(
    [tabB?.tabId ?? '', 'bt_ub'].sort(),
  )
  // 建页请求携带各自的工作区，宿主据此确定归属。
  const creates = host.received.filter((f) => f.op === 'create')
  expect(creates.map((f) => f.workspaceId)).toEqual([WS, other])
})

test('强制传入另一个工作区的 tabId 时，bind 与 observe 均被拒绝', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_ub', 'ws_b')
  await listed(handle, 'bt_ub', true, 'ws_b')

  const inA = handle.browser?.portFor('cv_a', WS)
  expect((await failure(inA?.bind('bt_ub'))).message).toMatch(/不在本工作区/)
  expect((await failure(inA?.observe({ tabId: 'bt_ub' }))).message).toMatch(/不在本工作区/)
  expect((await failure(inA?.close('bt_ub'))).message).toMatch(/不在本工作区/)
  // 未向宿主发送任何帧：跨工作区请求在本地即被拦截。
  expect(host.ops()).toEqual([])
})

test('删除会话时关闭其名下的全部页，不留下孤立页面', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  await port?.open('http://127.0.0.1:1/other')
  await port?.release()

  // 宿主先发出 closed 再返回结果，同一条连接按序处理：返回时存活快照已更新。
  await handle.browser?.closeConversation('cv_1')
  const closer = host.received.at(-1)
  expect(closer?.op).toBe('close.conversation')
  expect(closer?.conversationId).toBe('cv_1')
  // 宿主按会话关页并回发 closed，存活快照清空。
  const next = handle.browser?.portFor('cv_1', WS)
  expect(await next?.tabs()).toEqual([])
})

test('释放只断开本次 CDP 连接，不向宿主发送帧，重复释放为空操作', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  const after = host.received.length

  await port?.release()
  // 释放不经由宿主：没有 cancel，也没有 close，页面保留给下一条消息。
  expect(host.received).toHaveLength(after)
  expect(host.ops()).not.toContain('close')

  await port?.release()
  expect(host.received).toHaveLength(after)
})

test('运行时版本低于下限时不授予控制权，也不向宿主发送请求', async () => {
  const { handle } = fresh()
  // 版本不达标时 `available()` 与宿主未注册时同为 false，须先确认宿主帧已被处理。
  let registered = false
  handle.bus.subscribe({
    id: 'probe',
    origin: 'cli',
    conversations: null,
    send: ({ event }) => {
      if (event.type === 'browser.state' && event.browser.connected) registered = true
    },
  })
  const host = await AutoHost.connect(handle.port)
  host.ready(fakeDevtools(host.marker).port, '110.0.1587.0')
  await until(() => registered, '宿主完成注册')
  expect(handle.browser?.available()).toBe(false)
  const port = handle.browser?.portFor('cv_1', WS)
  expect((await failure(port?.open('http://127.0.0.1:1/page'))).message).toMatch(/不可用/)
  expect(host.received).toHaveLength(0)
})

/**
 * 下限必须按 Chromium 主版本比较：写成 WebView2 构建号 `152.0.4191.66` 并逐段比较时，
 * 主版本同为 152 的较早 Edge 构建 `152.0.4100.12` 会被判定为不达标，AI 控制不发布。
 */
test('运行时下限按 Chromium 主版本判定，主版本达标的任一构建均放行', async () => {
  const { handle } = fresh()
  const host = await AutoHost.connect(handle.port)
  host.ready(fakeDevtools(host.marker).port, '152.0.4100.12')
  await until(() => handle.browser?.available() === true, '宿主完成注册')

  expect(meetsRuntimeFloor('154.0.8037.57')).toBe(true)
  expect(meetsRuntimeFloor('152.0.1.0')).toBe(true)
  expect(meetsRuntimeFloor('151.0.9999.99')).toBe(false)
  expect(meetsRuntimeFloor('')).toBe(false)
  expect(meetsRuntimeFloor('dev')).toBe(false)
})

test('释放之后该端口无法再取得控制权', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  await port?.release()

  const before = host.received.length
  expect((await failure(port?.open('http://127.0.0.1:1/page'))).message).toMatch(/已经结束/)
  expect((await failure(port?.observe({ tabId: 'bt_1' }))).message).toMatch(/已经结束/)
  // 未发出任何请求：拒绝发生在获取控制槽的步骤。
  expect(host.received).toHaveLength(before)
})

test('释放之后旧端口的观察与动作一并失败', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  await port?.release()

  expect(
    (
      await failure(
        port?.act({
          tabId: tab?.tabId ?? '',
          action: 'click',
          ref: firstRef(ob),
        }),
      )
    ).message,
  ).toMatch(/已经结束/)
  expect(host.ops()).not.toContain('close')
})

test('下载：先授权再点击，等待宿主返回终态，最后核对磁盘', async () => {
  const { handle, host, devtools } = await ready()
  const dir = mkdtempSync(join(tmpdir(), 'qywork-dl-'))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const target = join(dir, 'ok.bin')

  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    idleMs: 5_000,
  })
  await until(() => devtools.clicks() === 1, '下载点击已发出')
  // 授权必须先于点击到达宿主：顺序颠倒时钩子无法取得授权，本次下载会被取消。
  const armIndex = host.received.findIndex((f) => f.op === 'download.arm')
  expect(armIndex).toBeGreaterThanOrEqual(0)
  expect(host.received[armIndex]?.path).toBe(target)
  expect(devtools.clicks()).toBe(1)

  expect(host.received[armIndex]?.downloadId).toBeTruthy()

  writeFileSync(target, 'qywork', 'utf8')
  host.finishDownload('bt_1', { kind: 'download.finished', path: target, success: true })
  expect(await pending).toEqual({ path: target, bytes: 6 })
})

test('被拦截的下载如实写入结果，不误报成功', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: join(tmpdir(), 'never-written.bin'),
    idleMs: 5_000,
  })
  await until(() => host.arms.has('bt_1'), '宿主登记下载授权')
  host.finishDownload('bt_1', {
    kind: 'download.blocked',
    reason: 'exists',
    suggestedName: 'fixture.bin',
  })
  expect(await pending).toEqual({ blocked: 'exists', suggestedName: 'fixture.bin' })
})

test('宿主上报进展时重新计时：持续写入超过静默上限不判定失败；没有进展时按静默上限失败', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  const target = join(tmpdir(), `progress-${Date.now()}.bin`)
  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    idleMs: 300,
  })
  await until(() => host.arms.has('bt_1'), '宿主登记下载授权')
  const downloadId = host.arms.get('bt_1')?.downloadId ?? ''
  // 进展持续 600 毫秒，长于静默上限 300 毫秒。
  for (let i = 1; i <= 6; i++) {
    await Bun.sleep(100)
    host.emit({ kind: 'download.progress', tabId: 'bt_1', receivedBytes: i * 1024, downloadId })
  }
  writeFileSync(target, 'qywork', 'utf8')
  host.finishDownload('bt_1', { kind: 'download.finished', path: target, success: true })
  expect(await pending).toEqual({ path: target, bytes: 6 })

  const again = await port?.observe({ tabId: tab?.tabId ?? '' })
  const stalled = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(again),
    absolutePath: join(tmpdir(), `stalled-${Date.now()}.bin`),
    idleMs: 1_000,
  })
  await expect(stalled).rejects.toThrow('下载连续 1 秒没有开始或没有进展，授权已撤销')
})

test('导航一次即作废旧观察，动作无法使用过期编号', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  await port?.navigate({ tabId: tab?.tabId ?? '', action: 'reload' })

  expect(
    (
      await failure(
        port?.act({
          tabId: tab?.tabId ?? '',
          action: 'click',
          ref: firstRef(ob),
        }),
      )
    ).message,
  ).toMatch(/失效/)
})

test('动作之后直接返回新观察，据此再次执行动作时无需另行观察', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const first = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!first || first.observation === null) throw new Error('本次动作本应返回观察')
  expect(first.element).toBe('dl')
  expect(first.settle).toBe('quiet')
  // 同一份文档内编号固定：动作之后的观察中同一个节点仍是原编号。
  expect(first.observation.elements[0]?.ref).toBe(firstRef(ob))

  // 取回的编号直接使用：其间没有任何一次 observe。
  const second = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: first.observation.elements[0]?.ref ?? '',
  })
  if (!second || second.observation === null) throw new Error('本次动作本应返回观察')
  expect(second.element).toBe('dl')
})

/**
 * `browser_act` 的说明允许模型在同一轮中按先前取得的编号连续发送多个输入。
 * 动作后的自动观察合并进同一文档的定位信息，不作废先前取得的编号。
 */
test('动作之后先前取得的编号仍可用：同一个编号连续执行两次动作', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  const input = {
    tabId: tab?.tabId ?? '',
    action: 'click' as const,
    ref: firstRef(ob),
  }

  const first = await port?.act(input)
  const second = await port?.act(input)

  expect(first?.element).toBe('dl')
  expect(second?.element).toBe('dl')
})

test('动作发出后无法取得观察时保留回执，并说明未能观察的原因', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  devtools.failObserve = true
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation !== null) throw new Error('本次观察本应为空')
  // 动作已发出：回执保留，模型据此得知不应重复点击。
  expect(r.element).toBe('dl')
  expect(r.point).toEqual({ x: 10, y: 10 })
  expect(r.observationError).toContain('采集失败')
  expect(devtools.clicks()).toBe(1)
})

test('探针读数缺少字段时不报告静默，按阶段上限如实标注', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  devtools.blindProbe = true
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('deadline')
})

/**
 * 打开一页、观察一次，返回点击第一个元素的调用。`observe` 再观察一次该页：调试端点在同一条连接上
 * 按序发送，它返回时，此前发出的协议事件都已被客户端处理。
 */
async function clickOnce(settle?: { networkIdleMs?: number; ceilingMs?: number }): Promise<{
  devtools: Devtools
  click: () => ReturnType<BrowserPort['act']>
  observe: () => Promise<unknown>
}> {
  const { handle, devtools } = await ready(settle)
  const port = handle.browser?.portFor('cv_1', WS)
  if (!port) throw new Error('浏览器端口本应可用')
  const tab = await port.open('http://127.0.0.1:1/page')
  const ob = await port.observe({ tabId: tab.tabId })
  const click = () =>
    port.act({
      tabId: tab.tabId,
      action: 'click',
      ref: firstRef(ob),
    })
  return { devtools, click, observe: () => port.observe({ tabId: tab.tabId }) }
}

test('点击发出的 XHR 结束之后才采集观察，回执是请求返回后的页面', async () => {
  const { devtools, click } = await clickOnce()
  devtools.request = { type: 'XHR', finishMs: 800 }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('quiet')
  expect(r.observation.elements[0]?.name).toBe('已加载')
})

test('请求持续超过静默阶段上限时继续等待，请求结束后报告静默', async () => {
  const { devtools, click } = await clickOnce()
  devtools.request = { type: 'Fetch', finishMs: 1_800 }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('quiet')
  expect(r.observation.elements[0]?.name).toBe('已加载')
})

test('请求不结束时到达上限报告 deadline，观察照常返回', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 300 })
  devtools.request = { type: 'Fetch', finishMs: null }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('deadline')
  expect(r.observation.elements[0]?.name).toBe('下载')
})

test('图片与 EventSource 请求不影响静默判定', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 300 })
  for (const type of ['Image', 'EventSource']) {
    devtools.request = { type, finishMs: null }
    const r = await click()
    if (r.observation === null) throw new Error('本次动作本应返回观察')
    expect(r.settle).toBe('quiet')
  }
})

/**
 * 页面在动作之后依次请求多个新地址（请求 `count` 个，每个 `stepMs` 后结束并发出下一个），`url(k)` 给出第 k 个的地址，
 * `overlapMs` 为前一个结束之前下一个已发出的时长。返回停止函数。
 */
function chainRequests(
  devtools: Devtools,
  opts: { count: number; stepMs: number; url: (k: number) => string; overlapMs?: number },
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  let started = false
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent' || started) return
    started = true
    for (let k = 0; k < opts.count; k++) {
      const at = k * opts.stepMs
      timers.push(
        setTimeout(() => {
          devtools.emit('Network.requestWillBeSent', {
            requestId: `chain-${k}`,
            type: 'XHR',
            request: { url: opts.url(k), method: 'GET' },
          })
        }, at),
        setTimeout(
          () => devtools.emit('Network.loadingFinished', { requestId: `chain-${k}` }),
          at + opts.stepMs + (opts.overlapMs ?? 0),
        ),
      )
    }
  }
  return () => {
    for (const t of timers) clearTimeout(t)
  }
}

/**
 * 原始失败形状：等待上限自动作完成起算，依次请求多个新地址的页面在总时长超过上限时以 `deadline` 返回加载到一半的页面，
 * 账本中其后模型立即手动等待的占 47%。
 */
test('依次请求新地址、总时长超过等待上限时按进展继续等待，加载完后报告静默', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 300 })
  const stop = chainRequests(devtools, {
    count: 5,
    stepMs: 200,
    url: (k) => `http://127.0.0.1:1/step/${k}`,
  })
  try {
    const started = Date.now()
    const r = await click()
    if (r.observation === null) throw new Error('本次动作本应返回观察')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(r.settle).toBe('quiet')
  } finally {
    stop()
  }
})

test('重复请求同一地址（带不同查询参数）不计为进展，持续轮询的页面在最后一次进展后按静默时长返回', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 3_000 })
  // 每 100 ms 发出一次、各持续 150 ms：始终有请求未结束，页面不会静默。
  const stop = chainRequests(devtools, {
    count: 60,
    stepMs: 100,
    overlapMs: 50,
    url: (k) => `http://127.0.0.1:1/poll?t=${k}`,
  })
  try {
    const started = Date.now()
    const r = await click()
    if (r.observation === null) throw new Error('本次动作本应返回观察')
    // 等待上限按 3 秒设置；首次请求结束后不再有进展，约 1.5 秒后返回。
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(r.settle).toBe('deadline')
  } finally {
    stop()
  }
})

test('不断请求新地址的页面在总上限处返回观察，标注 deadline', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 300, ceilingMs: 800 })
  const stop = chainRequests(devtools, {
    count: 60,
    stepMs: 100,
    overlapMs: 50,
    url: (k) => `http://127.0.0.1:1/item/${k}`,
  })
  try {
    const started = Date.now()
    const r = await click()
    if (r.observation === null) throw new Error('本次动作本应返回观察')
    expect(Date.now() - started).toBeGreaterThanOrEqual(800)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(r.settle).toBe('deadline')
  } finally {
    stop()
  }
})

/**
 * 原始失败形状：点击后页面跳转期间，读取旧文档的静默采样超过探针上限，整个等待随之结束，
 * 观察在新页面加载完之前采集（真实浏览器中点击链接跳转到首字节 2.5 秒的页面时复现）。
 */
test('静默采样超时时按未静默处理并继续等待，请求结束后报告静默', async () => {
  const { devtools, click } = await clickOnce()
  devtools.request = { type: 'XHR', finishMs: 3_000 }
  let armed = false
  // 动作的第一条鼠标事件之后，下一条页内读取是静默采样：推迟到探针上限之后才应答。
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent' || armed) return
    armed = true
    devtools.hold = { method: 'Runtime.evaluate', gate: Bun.sleep(2_500) }
  }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('quiet')
  expect(r.observation.elements[0]?.name).toBe('已加载')
})

/**
 * 原始失败形状：点击「登录」后页面跳转，动作之后的观察只能使用等待剩下的时间，读取资源清单受 2 秒探针上限，
 * 「Page.getResourceTree 超过 2000ms 未返回」，动作已发出而观察失败。
 */
test('动作之后读取资源清单超过 2 秒时观察照常完成', async () => {
  const { devtools, click } = await clickOnce()
  devtools.hold = { method: 'Page.getResourceTree', gate: Bun.sleep(2_500) }
  const r = await click()
  if (r.observation === null) throw new Error(`本次动作本应返回观察：${r.observationError}`)
  expect(r.observation.elements.length).toBeGreaterThan(0)
})

test('以 fetch 读取的事件流在响应头到达后不再等待', async () => {
  const { devtools, click } = await clickOnce({ networkIdleMs: 300 })
  devtools.request = { type: 'Fetch', finishMs: null, mimeType: 'text/event-stream' }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('quiet')
})

test('动作之前发出的请求不计入，其结束事件不抵消动作之后发出的请求', async () => {
  const { devtools, click, observe } = await clickOnce()
  devtools.emit('Network.requestWillBeSent', { requestId: 'early-1', type: 'XHR' })
  devtools.emit('Network.requestWillBeSent', { requestId: 'early-2', type: 'XHR' })
  // 两条事件须先于动作到达客户端：再观察一次，它的回包排在两条事件之后。同一文档上的观察不作废先前的编号。
  await observe()
  // 动作之前发出的两个请求：一个在点击时结束，另一个始终不结束。
  devtools.onCommand = (method) => {
    if (method === 'Input.dispatchMouseEvent') {
      devtools.emit('Network.loadingFinished', { requestId: 'early-2' })
    }
  }
  devtools.request = { type: 'XHR', finishMs: 800 }
  const r = await click()
  if (r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.settle).toBe('quiet')
  expect(r.observation.elements[0]?.name).toBe('已加载')
})

test('取消之后不再开始新观察，仍能返回动作回执', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  // 点击已发出、静默采样第一次读取探针时释放控制：此后不得再开始新观察。探针在点击之前登记，不能以登记作为触发点。
  devtools.onCommand = (_method, expression) => {
    if (!expression.includes('__qyworkProbeRead(')) return
    devtools.onCommand = null
    void port?.release()
  }
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation !== null) throw new Error('本次观察本应为空')
  expect(r.element).toBe('dl')
  expect(r.observationError).toMatch(/取消/)
  expect(devtools.clicks()).toBe(1)
})

/**
 * 原始失败形状：主文档加载超过静默阶段上限（1.5 s）时，导航之后的观察在页面加载到一半时采集，
 * 账本中跳转之后紧接一次观察或等待的占 77/170。主文档仍在加载时与未结束的请求一样顺延上限。
 */
test('导航之后主文档仍在加载时等待加载结束再观察，结果为静默而不是到期', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  await port?.observe({ tabId: tab?.tabId ?? '' })
  devtools.onCommand = (method) => {
    if (method !== 'Page.reload') return
    devtools.onCommand = null
    devtools.emit('Page.frameStartedLoading', { frameId: 'frame-1' })
    setTimeout(() => devtools.emit('Page.frameStoppedLoading', { frameId: 'frame-1' }), 1_800)
  }
  const started = Date.now()
  const r = await port?.navigate({ tabId: tab?.tabId ?? '', action: 'reload' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_800)
  if (!r || r.observation === null) throw new Error('本次导航本应返回观察')
  expect(r.settle).toBe('quiet')
})

test('导航返回导航之后的观察，不再另外返回标签信息', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')

  const r = await port?.navigate({
    tabId: tab?.tabId ?? '',
    action: 'goto',
    url: 'http://127.0.0.1:1/next',
  })
  if (!r || r.observation === null) throw new Error('本次导航本应返回观察')
  // 地址取自观察，是页面当前的实际地址，而非请求的地址。
  expect(r.observation.url).toBe('http://127.0.0.1:1/page')
  expect(r.observation.elements.length).toBeGreaterThan(0)
  expect(r.settle).toBe('quiet')
})

test('导航被拒绝时报告失败，不以旧页快照冒充跳转成功', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')

  devtools.navigateError = 'net::ERR_NAME_NOT_RESOLVED'
  const err = await failure(
    port?.navigate({
      tabId: tab?.tabId ?? '',
      action: 'goto',
      url: 'http://127.0.0.1:1/missing',
    }),
  )
  expect(err.message).toMatch(/ERR_NAME_NOT_RESOLVED/)
})

test('等待结束后直接采集一次观察，不做静默等待也不附带静默标注', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')

  const r = await port?.wait({
    tabId: tab?.tabId ?? '',
    selector: '#dl',
    state: 'visible',
    timeoutMs: 1_000,
  })
  expect(r?.met).toBe(true)
  if (!r || r.observation === null) throw new Error('本次等待本应返回观察')
  expect('settle' in r).toBe(false)
  expect(r.observation.elements.length).toBeGreaterThan(0)
})
test('同一页上一次调用的迟到终态不结算本次调用，无授权的终态不结算任何调用', async () => {
  const { handle, host } = await ready()
  const dir = mkdtempSync(join(tmpdir(), 'qywork-dl-'))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const target = join(dir, 'second.bin')

  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    idleMs: 3_000,
  })
  await until(() => host.arms.has(tab?.tabId ?? ''), '宿主登记下载授权')
  const mine = host.received.findLast((f) => f.op === 'download.arm')?.downloadId
  expect(mine).toBeTruthy()

  // 同一页上另一个身份的终态：既不属于本次调用，也没有其他调用在等待它。
  writeFileSync(target, 'qywork', 'utf8')
  host.emit({
    kind: 'download.finished',
    tabId: tab?.tabId ?? '',
    path: target,
    success: true,
    downloadId: 'dl_stale',
  })
  // 没有身份的终态同样不结算。
  host.emit({ kind: 'download.finished', tabId: tab?.tabId ?? '', path: target, success: true })

  // 只有携带本次身份的终态能结算。三条事件经同一条宿主连接按序处理。
  host.finishDownload(tab?.tabId ?? '', { kind: 'download.finished', path: target, success: true })
  expect(await pending).toEqual({ path: target, bytes: 6 })
})

test('两条会话下载到同一路径时后一份授权被拒绝，路径不同时均放行', async () => {
  const { handle, host } = await ready()
  const dir = mkdtempSync(join(tmpdir(), 'qywork-dl-'))
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const shared = join(dir, 'same.bin')

  const a = handle.browser?.portFor('cv_a', WS)
  const b = handle.browser?.portFor('cv_b', WS)
  const tabA = await a?.open('http://127.0.0.1:1/a')
  const tabB = await b?.open('http://127.0.0.1:1/b')
  const obA = await a?.observe({ tabId: tabA?.tabId ?? '' })
  const obB = await b?.observe({ tabId: tabB?.tabId ?? '' })

  const held = a?.download({
    tabId: tabA?.tabId ?? '',
    ref: firstRef(obA),
    absolutePath: shared,
    idleMs: 5_000,
  })
  const heldOutcome = failure(held)
  await until(() => host.arms.has(tabA?.tabId ?? ''), '宿主登记 A 的下载授权')

  expect(
    (
      await failure(
        b?.download({
          tabId: tabB?.tabId ?? '',
          ref: firstRef(obB),
          absolutePath: shared,
          idleMs: 5_000,
        }),
      )
    ).message,
  ).toMatch(/路径已被/)

  // 路径不同时不冲突：授权照常登记，点击照常发出。
  const other = b?.download({
    tabId: tabB?.tabId ?? '',
    ref: firstRef(obB),
    absolutePath: join(dir, 'other.bin'),
    idleMs: 5_000,
  })
  await until(() => host.arms.has(tabB?.tabId ?? ''), '宿主登记 B 的下载授权')
  expect(host.received.findLast((f) => f.op === 'download.arm')?.path).toBe(join(dir, 'other.bin'))

  host.finishDownload(tabB?.tabId ?? '', { kind: 'download.blocked', reason: 'exists' })
  expect(await other).toEqual({ blocked: 'exists' })
  await a?.release()
  await heldOutcome
})

test('释放撤销未消费的授权，正在等待终态的下载按未确认返回', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    absolutePath: join(tmpdir(), 'qywork-never.bin'),
    idleMs: 30_000,
  })
  // 先注册失败处理再释放：释放会立即终结本次等待，注册晚于释放时会成为未处理的拒绝。
  const outcome = failure(pending)
  await until(() => host.arms.has(tab?.tabId ?? ''), '宿主登记下载授权')
  const armed = host.received.findLast((f) => f.op === 'download.arm')?.downloadId

  await port?.release()
  // 不等待 30 秒期限：等待随释放结束，并明确说明未确认终态。
  expect((await outcome).message).toMatch(/未确认终态/)
  const disarm = host.received.findLast((f) => f.op === 'download.disarm')
  expect(disarm?.downloadId).toBe(armed)
  expect(host.arms.size).toBe(0)
})

/**
 * 原始失败形状：负载高时释放落在点击的发送途中，发送通道关闭使点击以「发送通道已关闭」失败，
 * 下载返回该原文而不是释放的结论（macOS x64 发布构建实测）。此处使点击的回包保持未返回，以确定地复现该时序。
 */
test('点击发送途中释放，下载同样按未确认终态返回，授权随之撤销', async () => {
  const { handle, host, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const g = gate()
  devtools.hold = { method: 'Input.dispatchMouseEvent', gate: g.promise }
  const outcome = failure(
    port?.download({
      tabId: tab?.tabId ?? '',
      ref: firstRef(ob),
      absolutePath: join(tmpdir(), 'qywork-never-click.bin'),
      idleMs: 30_000,
    }),
  )
  await until(
    () => devtools.calls.some((c) => c.method === 'Input.dispatchMouseEvent'),
    '点击阻塞于发送途中',
  )
  const armed = host.received.findLast((f) => f.op === 'download.arm')?.downloadId

  await port?.release()
  try {
    expect((await outcome).message).toMatch(/未确认终态/)
    expect(host.received.findLast((f) => f.op === 'download.disarm')?.downloadId).toBe(armed)
    expect(host.arms.size).toBe(0)
  } finally {
    g.open()
  }
})

test('optionsFor 按编号读取一页选项，不改变元素编号', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  if (!ob || !('elements' in ob)) throw new Error('本次观察本应返回元素表')
  const pick = ob.elements.find((e) => e.tag === 'select')

  const options = await port?.observe({
    tabId: tab?.tabId ?? '',
    optionsFor: { ref: pick?.ref ?? '' },
  })
  if (!options || 'elements' in options) throw new Error('本次读取本应返回选项页')
  expect(options.total).toBe(3)
  expect(options.items).toHaveLength(3)

  // 未分配新编号：原观察中的动作照常可用。
  const acted = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  expect(acted?.element).toBe('dl')
})

test('optionsFor 使用本页没有的编号时明确失败，不改为采集新观察', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const gone = await failure(
    port?.observe({
      tabId: tab?.tabId ?? '',
      optionsFor: { ref: 'e999' },
    }),
  )
  expect(gone.message).toMatch(/失效/)
  // 判定先于任何帧：按执行前拒绝声明，调用方据此知道页面未被改动。
  expect(gone).toMatchObject({ executed: false, errorKind: 'stale_ref' })
  expect(ob?.tabId).toBeTruthy()
})

test('多事件动作中途失败时仍返回后续观察，回执如实标注未完成', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  // 第 3 条按键事件是第二个字符的按下：第一个字符已输入页面。
  devtools.failKeyAt = 3
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    action: 'type',
    ref: firstRef(ob),
    text: 'ab',
  })
  if (!r || r.observation === null) throw new Error('本次动作本应返回观察')
  expect(r.execution).toMatchObject({ state: 'partial', confirmedUnits: 1 })
  expect(r.execution?.reason).toContain('Input.dispatchKeyEvent')
  expect(r.observation.elements.length).toBeGreaterThan(0)
})

/**
 * 动作期间页面上发生的事（`activity`）。原始失败形状：点击之后结果只有「已发出」，模型无从得知页面没有任何反应。
 */
test('动作结果给出动作期间的事实：未跳转、未发出请求、DOM 未变化', async () => {
  const { click } = await clickOnce()
  const r = await click()
  expect(r.activity).toEqual({ navigated: false, requests: 0, domChanged: false })
})

test('动作之后发出的请求与 DOM 变化计入动作期间的事实', async () => {
  const { devtools, click } = await clickOnce()
  devtools.request = { type: 'XHR', finishMs: 50 }
  const r = await click()
  expect(r.activity?.requests).toBe(1)
  expect(r.activity?.domChanged).toBe(true)
  expect(r.activity?.navigated).toBe(false)
})

test('动作期间页面打开的本会话新页与未授权的被拦截下载计入动作期间的事实', async () => {
  const { handle, host, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent') return
    devtools.onCommand = null
    host.emit({
      kind: 'opened',
      tabId: 'bt_9',
      url: 'http://127.0.0.1:1/popup',
      title: '弹出页',
      marker: 'marker-9',
      workspaceId: WS,
      conversationId: 'cv_1',
    })
    host.emit({
      kind: 'download.blocked',
      tabId: tab?.tabId ?? '',
      reason: 'unauthorized',
      suggestedName: 'a.zip',
    })
    // 另一条会话的新页与已授权下载的终态不属于本次动作。
    host.emit({
      kind: 'opened',
      tabId: 'bt_8',
      url: 'x',
      title: '',
      marker: 'm8',
      workspaceId: WS,
      conversationId: 'cv_2',
    })
  }
  const r = await port?.act({ tabId: tab?.tabId ?? '', action: 'click', ref: firstRef(ob) })
  expect(r?.activity?.opened?.map((t) => t.tabId)).toEqual(['bt_9'])
  expect(r?.activity?.downloadsBlocked).toEqual([
    { reason: 'unauthorized', suggestedName: 'a.zip' },
  ])
})

/**
 * 原始失败形状：点击弹出确认框之后，输入事件 5 秒后结果未知，此后每次读取页面都超时，模型只能请用户处理。
 */
test('动作弹出对话框时立即返回对话框的文字，处理之前拒绝读取，由 dialog 动作选择确定', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  const ob = await port?.observe({ tabId })
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent') return
    devtools.onCommand = null
    devtools.emit('Page.javascriptDialogOpening', { type: 'confirm', message: '确定删除？' })
  }
  const r = await port?.act({ tabId, action: 'click', ref: firstRef(ob) })
  expect(r?.observation).toBeNull()
  expect(r?.activity?.dialog).toEqual({ type: 'confirm', message: '确定删除？' })

  // 对话框打开期间页面无法读取：在发出任何命令之前拒绝，并说明如何处理。
  const before = devtools.commands()
  const blocked = await failure(port?.observe({ tabId }))
  expect(blocked.message).toContain('确认框：「确定删除？」')
  expect(blocked).toMatchObject({ executed: false, errorKind: 'target_blocked' })
  expect(devtools.commands()).toBe(before)

  const answered = await port?.act({ tabId, action: 'dialog', accept: true })
  const sent = devtools.calls.filter((c) => c.method === 'Page.handleJavaScriptDialog')
  expect(sent.map((c) => c.params)).toEqual([{ accept: true }])
  expect(answered?.element).toBe('确认框')
  expect(answered?.observation).not.toBeNull()
  expect((await port?.observe({ tabId }))?.tabId).toBe(tabId)
})

test('页面上没有对话框时 dialog 动作按参数错误拒绝，不发送处理命令', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  await port?.observe({ tabId: tab?.tabId ?? '' })
  const err = await failure(port?.act({ tabId: tab?.tabId ?? '', action: 'dialog', accept: false }))
  expect(err).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  expect(devtools.calls.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false)
})

/**
 * 原始失败形状：页面把文件输入框隐藏，只显示样式按钮；点击按钮弹出系统选择窗口，模型无法操作，
 * 隐藏的输入框不在元素表中，上传工具没有目标。
 */
test('动作期间页面要求选择文件时写入动作事实，不带 ref 的上传交给该请求', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  const ob = await port?.observe({ tabId })
  devtools.onCommand = (method) => {
    if (method !== 'Input.dispatchMouseEvent') return
    devtools.onCommand = null
    devtools.emit('Page.fileChooserOpened', {
      frameId: 'frame-1',
      mode: 'selectSingle',
      backendNodeId: 77,
    })
  }
  const r = await port?.act({ tabId, action: 'click', ref: firstRef(ob) })
  expect(r?.activity?.fileChooser).toEqual({ multiple: false })
  // 只在动作期间拦截：动作前开启，动作后关闭。关闭命令不等待回包，按到达判定。
  const toggles = () =>
    devtools.calls
      .filter((c) => c.method === 'Page.setInterceptFileChooserDialog')
      .map((c) => c.params.enabled)
  await until(() => toggles().length === 2, '拦截已关闭')
  expect(toggles()).toEqual([true, false])

  const single = await failure(port?.upload({ tabId, paths: ['C:/a.txt', 'C:/b.txt'] }))
  expect(single.message).toContain('只接受一个文件')
  expect(await port?.upload({ tabId, paths: ['C:/a.txt'] })).toEqual({ files: ['C:/a.txt'] })
  const set = devtools.calls.filter((c) => c.method === 'DOM.setFileInputFiles')
  expect(set.map((c) => c.params)).toEqual([{ files: ['C:/a.txt'], backendNodeId: 77 }])
  // 请求已提交：再次不带 ref 上传时没有目标。
  const again = await failure(port?.upload({ tabId, paths: ['C:/a.txt'] }))
  expect(again).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
})

test('动作缺省 screenshot 时观察不带截图，也不发出截图命令', async () => {
  const { devtools, click } = await clickOnce()
  const plain = await click()
  if (plain.observation === null) throw new Error('本次动作本应返回观察')
  expect(plain.observation.image).toBeUndefined()
  expect(devtools.calls.filter((c) => c.method === 'Page.captureScreenshot')).toHaveLength(0)
})

test('screenshot=true 的动作回执观察带截图；动作未完成时同样带截图', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  const base = {
    tabId: tab?.tabId ?? '',
    ref: firstRef(ob),
    screenshot: true,
  }

  const clicked = await port?.act({ ...base, action: 'click' })
  if (!clicked || clicked.observation === null) throw new Error('本次动作本应返回观察')
  expect(clicked.observation.image?.data).toBe(SHOT)

  devtools.failKeyAt = 3
  const typed = await port?.act({ ...base, action: 'type', text: 'ab' })
  if (!typed || typed.observation === null) throw new Error('本次动作本应返回观察')
  expect(typed.execution).toMatchObject({ state: 'partial' })
  expect(typed.observation.image?.data).toBe(SHOT)
})

/**
 * 原始失败形状：指定的页已关闭或属于上一次启动，拒绝说明只有编号，调用方先列出一次标签页再新建或改用现有的页。
 */
test('标签页不存在或不归本会话时，拒绝说明列出本会话当前的标签页；没有时说明新建', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const none = await failure(port?.observe({ tabId: 'bt_404' }))
  expect(none).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  expect(none.message).toBe(
    '无法识别的标签页 bt_404；本会话当前没有标签页，用 browser_tabs 的 create 打开',
  )

  const tab = await port?.open('http://127.0.0.1:1/page')
  await listed(handle, tab?.tabId ?? '', true, WS, 'cv_1')
  host.userOpen('bt_u')
  await listed(handle, 'bt_u')
  const gone = await failure(port?.navigate({ tabId: 'bt_404', action: 'reload' }))
  expect(gone.message).toMatch(
    new RegExp(`^无法识别的标签页 bt_404；本会话当前的标签页：${tab?.tabId}（`),
  )
  expect(gone.message).not.toContain('bt_u')
  const theirs = await failure(port?.observe({ tabId: 'bt_u' }))
  expect(theirs.message).toMatch(
    new RegExp(`^标签页 bt_u 不归本会话；本会话当前的标签页：${tab?.tabId}（`),
  )
})

test('screenshot=true 的导航与等待之后的观察带截图，缺省时不截图', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  const shots = () => devtools.calls.filter((c) => c.method === 'Page.captureScreenshot').length

  const plain = await port?.navigate({ tabId, action: 'reload' })
  expect(plain?.observation?.image).toBeUndefined()
  expect(shots()).toBe(0)
  const navigated = await port?.navigate({ tabId, action: 'reload', screenshot: true })
  expect(navigated?.observation?.image?.data).toBe(SHOT)
  const waited = await port?.wait({
    tabId,
    selector: 'h1',
    state: 'visible',
    timeoutMs: 1000,
    screenshot: true,
  })
  expect(waited?.observation?.image?.data).toBe(SHOT)
  expect(shots()).toBe(2)
})
