/**
 * 浏览器控制的会话归属与并发。
 *
 * 覆盖范围：`coordinator.ts` 的按执行者控制槽与页级独占、版本准入、会话归属校验、
 * 按会话关页、释放与迟到回包的收尾、宿主断开重连，动作与导航之后的静默等待、
 * 观察登记与失败说明，
 * 选项页读取不发新编号、多事件动作没做完时仍带回观察，
 * 下载的身份登记与终态认领，以及它经 `bridge.ts` 发出的
 * `create` / `bind` / `close.conversation` / `download.arm` / `download.disarm` 形状。
 *
 * 对端是一个自动应答的假宿主，外加一个只走通路的假调试端点——这里问的是
 * 「哪条会话的页归谁、两条会话能不能同时操作各自的页、删会话关不关得掉页」，
 * 不是 CDP 协议细节（那在 `cdp.test.ts`）。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserObservation, BrowserOptionsPage } from '@qywork/agent'
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
import type { ServerWebSocket } from 'bun'
import { EventBus } from '../bus.ts'
import { handleCommand } from '../commands.ts'
import { makeDelegate } from '../delegate.ts'
import type { SocketData } from '../deps.ts'
import { RunManager } from '../runs.ts'
import { serve } from '../server.ts'
import { SubagentRegistry } from '../subagents.ts'

const HOST_KEY = 'coordinator-host-key'

/** 这些用例默认都在这个工作区里。跨工作区的过滤另有专门用例，显式传第二个 id。 */
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

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

const settle = () => new Promise((r) => setTimeout(r, 40))

/** observe 按输入返回元素表或选项页；这些用例只用元素表里的第一个编号。 */
function firstRef(ob: BrowserObservation | BrowserOptionsPage | undefined): string {
  return ob && 'elements' in ob ? (ob.elements[0]?.ref ?? '') : ''
}

async function failure(pending: Promise<unknown> | undefined): Promise<Error> {
  const settled = Symbol('resolved')
  const out = await Promise.resolve(pending).then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('这条调用本应失败')
  return out as Error
}

/** 等一件事发生。成员会话是派出即返回的，断言前要等它真的走到那一步。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等不到：${label}`)
}

/** 一个手动兑现的闸。屏障用例用它把第二个执行者的调用插进第一个的在途阶段。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** 假调试端点的开关：单条用例按需改它，改完影响其后的每一条命令。 */
interface Devtools {
  port: number
  clicks: () => number
  /** 收到过多少条命令。页级互斥的用例按它断言被拒的一方一帧都没发到浏览器。 */
  commands: () => number
  /** 命中这个方法的回包压后到 `gate` 兑现，用来把别的调用插进在途的附页或收尾。 */
  hold: { method: string; gate: Promise<unknown> } | null
  /** 下一次 goto 回这个 errorText，模拟导航被拒。 */
  navigateError: string | null
  /** 让采集命令报错，模拟动作之后观察取不到。 */
  failObserve: boolean
  /** 每次探针读数都换一个变更计数，模拟持续变化的页面。 */
  churn: boolean
  /** 探针读数不给 ready 与 mutations，模拟探针无效。 */
  blindProbe: boolean
  /** 第几条按键事件回错误：模拟多事件动作中途注入失败。 */
  failKeyAt: number | null
  /** 每条命令答完回调一次。用来在动作与观察之间插事。 */
  onCommand: ((method: string, expression: string) => void) | null
}

/**
 * 只走通路的假调试端点：一个 page target、一个可点的下载链接、一个可读选项的下拉。
 *
 * 元素与动作的判定在 `page.test.ts`；这里只要让观察、点击与导航能走通，
 * 好把下载的授权、触发、终态、磁盘核对，以及动作之后的静默等待与观察这两条链接起来。
 * 导航按真端点的形状回 frameId 并补发 `Page.frameNavigated`：协调器按事件确认导航，
 * 不按「令牌没变就是同文档」推断。探针按真实表达式应答并给全 `ready` 与 `mutations`。
 */
function fakeDevtools(marker: string): Devtools {
  let clicks = 0
  let keys = 0
  let mutations = 0
  let commands = 0
  const state: Devtools = {
    port: 0,
    clicks: () => clicks,
    commands: () => commands,
    hold: null,
    navigateError: null,
    failObserve: false,
    churn: false,
    blindProbe: false,
    failKeyAt: null,
    onCommand: null,
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/json/version') {
        return Response.json({
          webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
        })
      }
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
        const cmd = JSON.parse(String(raw)) as {
          id: number
          method: string
          params?: Record<string, unknown>
        }
        commands += 1
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
              { backendDOMNodeId: 9, role: { value: 'link' }, name: { value: '下载' } },
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
                value: { token: 'doc-1', url: 'http://127.0.0.1:1/page', title: '夹具页' },
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
            result = { result: { value: { found: true, id: 7 } } }
          } else result = { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
        }
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
 * 自动应答的假宿主。记下收到的每一帧，供归属与形状断言。
 *
 * 它按真宿主的准入规则答 `bind`：用户页（归属为 `null`）可被点名接管到发起会话，
 * 已归本会话是幂等，已归**另一条**会话一律拒绝。归属只跟着会话 id 走，页面内容与
 * 模型给的 tabId 都改不了它——跨会话隔离正是这一层要挡住的事。
 */
class AutoHost {
  socket: WebSocket
  received: BrowserRequestFrame[] = []
  marker = 'marker-1'
  /** tabId → 归属会话 id。`null` = 用户手动开的页，未归任何会话。 */
  owners = new Map<string, string | null>()
  /** tabId → 所属工作区。建页时定，此后不改；`bind` 跨工作区一律拒绝。 */
  workspaces = new Map<string, string>()
  /** tabId → 尚未消费的授权。按真宿主的形状记身份与目标路径。 */
  arms = new Map<string, { downloadId: string; path: string }>()
  /** 本次连接的纪元。重连用例给新连接换一个值，旧纪元的事件随之作废。 */
  epoch = 1
  /** 答完一次 `create` 之后回调一次。用来把释放插进建页回包与登记之间。 */
  onCreate: (() => void) | null = null
  /**
   * 命中这个 op 的回包压后到 `gate` 兑现。
   *
   * 事件照常先发：真宿主也是先广播 `opened` / `control` 再回结果，页级占用的用例
   * 要的正是「事件已到、回包未到」那一段。
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
        // 真宿主在回结果之前先发 `opened`，存活快照只从那条来。
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
          error = `认不出的标签页 ${tabId}`
        } else if (this.workspaces.get(tabId) !== frame.workspaceId) {
          error = '这一页属于另一个工作区，接管不了'
        } else if (owner === null || owner === frame.conversationId) {
          // 用户页归到发起会话；已归本会话是幂等。都回同一份 marker。
          if (owner === null) {
            this.owners.set(tabId, frame.conversationId ?? null)
            this.emit({ kind: 'control', tabId, conversationId: frame.conversationId ?? null })
          }
          data.marker = this.marker
          data.url = 'http://127.0.0.1:1/page'
          data.title = '夹具页'
        } else {
          error = '这一页归另一条会话，接管不了'
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
   * 一次下载走到终态：消费掉这一页的授权，并把它的身份带进事件。
   *
   * 真宿主把 downloadId 绑在 `ICoreWebView2DownloadOperation` 上再随终态回报，
   * 所以这里也只能从被消费的那份授权取身份，不能由调用方另给一个。
   */
  finishDownload(
    tabId: string,
    over: Omit<BrowserEventFrame, 'type' | 'connectionEpoch' | 'seq' | 'tabId' | 'downloadId'>,
  ): void {
    const arm = this.arms.get(tabId)
    this.arms.delete(tabId)
    this.emit({ ...over, tabId, ...(arm ? { downloadId: arm.downloadId } : {}) })
  }

  /** 用户自己在某个工作区新开一页：归属为 `null`，走 `opened` 进存活快照。 */
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
      runtimeVersion,
      debugPort,
      tabs: [],
    }
    this.socket.send(JSON.stringify(frame))
  }

  ops(): string[] {
    return this.received.map((f) => f.op)
  }

  /** 宿主主动发的事件：归属变化、下载终态、被拦、导航都走这条。 */
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

function fresh(): Fixture {
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
  })
  cleanups.push(() => {
    handle.stop()
    content.close()
    store.close()
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删不掉与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return { handle, store, content, dir, workspaceId }
}

async function ready(): Promise<Fixture & { host: AutoHost; devtools: Devtools }> {
  const fixture = fresh()
  const host = await AutoHost.connect(fixture.handle.port)
  const devtools = fakeDevtools(host.marker)
  host.ready(devtools.port)
  await settle()
  return { ...fixture, host, devtools }
}

/**
 * 同一条会话的两个执行者各开各的页。
 *
 * 子 agent 与并行成员共用顶层会话 id，控制槽按会话分的话它们从第二个起就没有浏览器。
 */
test('同会话两个执行各开各的页，观察与动作都各自完成', async () => {
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
      observationId: obA?.observationId ?? '',
      action: 'click',
      ref: firstRef(obA),
    }),
    second?.act({
      tabId: tabB?.tabId ?? '',
      observationId: obB?.observationId ?? '',
      action: 'click',
      ref: firstRef(obB),
    }),
  ])
  expect(actA?.element).toBe('dl')
  expect(actB?.element).toBe('dl')
  expect(host.ops().filter((op) => op === 'create')).toHaveLength(2)

  // 一方释放不牵连另一方：槽按执行者分，收尾只收自己那一个。
  await first?.release()
  const again = await second?.observe({ tabId: tabB?.tabId ?? '' })
  expect(again?.observationId).toBeTruthy()
})

/**
 * 页级独占：第二个执行者碰同一页时被拒，而且拒绝发生在发帧之前。
 *
 * 少了这一条，两个执行者会双双附上同一页各发各的输入，宿主的下载授权也按页一份
 * 互相顶掉。
 */
test('一页被占住后，另一个执行的每种页面操作都被拒，宿主与浏览器一帧不收', async () => {
  const { handle, host, devtools } = await ready()
  const holder = handle.browser?.portFor('cv_1', WS)
  const other = handle.browser?.portFor('cv_1', WS)
  const tab = await holder?.open('http://127.0.0.1:1/page')
  const ob = await holder?.observe({ tabId: tab?.tabId ?? '' })
  const tabId = tab?.tabId ?? ''

  const frames = host.received.length
  const commands = devtools.commands()
  const target = join(tmpdir(), 'qywork-busy.bin')
  const blocked = [
    other?.bind(tabId),
    other?.observe({ tabId }),
    other?.navigate({ tabId, action: 'reload' }),
    other?.act({ tabId, observationId: ob?.observationId ?? '', action: 'click', ref: '' }),
    other?.wait({ tabId, selector: '#x', timeoutMs: 1_000 }),
    other?.upload({ tabId, observationId: ob?.observationId ?? '', ref: '', paths: [target] }),
    other?.download({
      tabId,
      observationId: ob?.observationId ?? '',
      ref: '',
      absolutePath: target,
      timeoutMs: 1_000,
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

  // 另开一页照常：互斥只到这一页，不到这条会话。
  const mine = await other?.open('http://127.0.0.1:1/other')
  const obOther = await other?.observe({ tabId: mine?.tabId ?? '' })
  expect(obOther?.observationId).toBeTruthy()

  // 持有者释放之后可以接手。
  await holder?.release()
  await settle()
  const taken = await other?.observe({ tabId })
  expect(taken?.observationId).toBeTruthy()
})

/**
 * 「这个 tabId 你看不见」的四种拒绝都在同步段判完，一帧未发，回执因此与 busy 同形。
 *
 * 标成已执行的话，模型会当成页面已被动过而不再换一页重试。
 */
test('看不见的 tabId 一律按未执行拒绝，宿主一帧不收', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u', WS)
  host.userOpen('bt_ub', 'ws_b')
  await settle()
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

test('同会话两个执行同时接管一个用户页，只有一个成功，另一个没发 bind 帧', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await settle()
  const a = handle.browser?.portFor('cv_1', WS)
  const b = handle.browser?.portFor('cv_1', WS)

  const settled = await Promise.allSettled([a?.bind('bt_u'), b?.bind('bt_u')])
  expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const refused = settled.find((r) => r.status === 'rejected')
  expect(String(refused?.reason)).toMatch(/正被另一个任务操作/)
  // 失败方一帧都没发：登记与冲突检查在同一个同步段里。
  expect(host.ops().filter((op) => op === 'bind')).toHaveLength(1)
})

/**
 * 占用从登记那一刻起成立，不等宿主回包。
 *
 * 等回包再登记的话，`bind` 在途的那一段里第二个执行者查不到持有者，两边都会附上去。
 */
test('bind 回包还在途时，同一页对另一个执行已经是占用中', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await settle()
  const a = handle.browser?.portFor('cv_1', WS)
  const b = handle.browser?.portFor('cv_1', WS)

  const g = gate()
  host.hold = { op: 'bind', gate: g.promise }
  const binding = a?.bind('bt_u')
  await settle()

  expect((await failure(b?.observe({ tabId: 'bt_u' }))).message).toMatch(/正被另一个任务操作/)
  g.open()
  expect((await binding)?.tabId).toBe('bt_u')
})

/**
 * 附页失败不留占用，收尾中的占用也不提前消失。
 *
 * 旧连接的取消会清掉页内等待器与按住的输入，接手者此刻登记的等待器会被那一次清理
 * 带走，因此要等整槽收尾结束再放手。
 */
test('持有者正在收尾时，接手者等它结束再占页，不报占用中', async () => {
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
  await settle()
  // 收尾没结束之前不放手，也不把接手者挡成失败。
  expect(taken).toBe(false)

  g.open()
  await releasing
  expect((await pending)?.observationId).toBeTruthy()
})

/**
 * `opened` 先于 create 回包到达，另一个执行者据此先占了这一页。
 *
 * 建页不预占，先操作的一方先持有；创建者随后拿到明确失败，不抢占、不另记一本预订账。
 */
test('建页不占页：别人先操作那一页时，创建者随后被拒，页不被回收', async () => {
  const { handle, host } = await ready()
  const creator = handle.browser?.portFor('cv_1', WS)
  const rival = handle.browser?.portFor('cv_1', WS)

  const g = gate()
  host.hold = { op: 'create', gate: g.promise }
  const opening = creator?.open('http://127.0.0.1:1/page')
  await settle()
  // 回包还没到，`opened` 已经到了：另一个执行者据此占住这一页。
  const ob = await rival?.observe({ tabId: 'bt_1' })
  expect(ob?.observationId).toBeTruthy()

  g.open()
  expect((await opening)?.tabId).toBe('bt_1')
  expect((await failure(creator?.observe({ tabId: 'bt_1' }))).message).toMatch(/正被另一个任务操作/)
  // 建页不附页，也不因为拿不到控制权就把页关掉。
  expect(host.ops()).not.toContain('close')
  expect((await creator?.tabs())?.map((t) => t.tabId)).toEqual(['bt_1'])
})

test('建页回包晚于释放时如实返回这一页，不附页也不回收', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const opening = port?.open('http://127.0.0.1:1/page')
  host.onCreate = () => {
    host.onCreate = null
    void port?.release()
  }
  expect((await opening)?.tabId).toBe('bt_1')
  await settle()
  expect(host.ops()).not.toContain('close')
  // 页留在宿主上，归属不变，下一条消息接着用。
  expect((await handle.browser?.portFor('cv_1', WS).tabs())?.map((t) => t.tabId)).toEqual(['bt_1'])
})

test('附页途中这一页被关掉时不复活它，占用随之释放', async () => {
  const { handle, host, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''

  const g = gate()
  devtools.hold = { method: 'Target.attachToTarget', gate: g.promise }
  const pending = port?.observe({ tabId })
  await settle()
  host.emit({ kind: 'closed', tabId })
  await settle()
  g.open()
  expect((await failure(pending)).message).toMatch(/已经关闭/)
  await settle()
  // 这一页已经不在存活表里：迟到的附加不能把它登记回来。
  expect((await failure(port?.observe({ tabId }))).message).toMatch(/认不出的标签页/)
})

test('会话删除收尾这条会话的全部槽，只发一次按会话关页', async () => {
  const { handle, host } = await ready()
  const mine = [1, 2, 3].map(() => handle.browser?.portFor('cv_1', WS))
  const other = handle.browser?.portFor('cv_2', WS)
  for (const port of mine) {
    const tab = await port?.open('http://127.0.0.1:1/page')
    await port?.observe({ tabId: tab?.tabId ?? '' })
  }
  const tabC = await other?.open('http://127.0.0.1:1/c')
  await other?.observe({ tabId: tabC?.tabId ?? '' })

  await handle.browser?.closeConversation('cv_1')
  await settle()
  expect(host.received.filter((f) => f.op === 'close.conversation')).toHaveLength(1)
  // 三个槽都收了尾，名下的页都关掉；别的会话的页不受影响。
  expect(await handle.browser?.portFor('cv_1', WS).tabs()).toEqual([])
  expect((await other?.tabs())?.map((t) => t.tabId)).toEqual([tabC?.tabId ?? ''])
})

test('同会话三个执行逐个释放后槽全空，页仍留在宿主上，重复释放加入同一次收尾', async () => {
  const { handle, host } = await ready()
  const ports = [1, 2, 3].map(() => handle.browser?.portFor('cv_1', WS))
  const tabs: string[] = []
  for (const port of ports) {
    const tab = await port?.open('http://127.0.0.1:1/page')
    await port?.observe({ tabId: tab?.tabId ?? '' })
    tabs.push(tab?.tabId ?? '')
  }
  for (const port of ports) await Promise.all([port?.release(), port?.release()])
  await settle()

  // 释放只收控制，不关页。
  expect(host.ops()).not.toContain('close')
  const next = handle.browser?.portFor('cv_1', WS)
  expect((await next?.tabs())?.map((t) => t.tabId).sort()).toEqual([...tabs].sort())
  // 三页都不再被占：新执行者逐个接手得了。
  for (const tabId of tabs) {
    expect((await next?.observe({ tabId }))?.observationId).toBeTruthy()
  }
})

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 一轮工具调用。成员会话按它去调内置浏览器工具，走的是真实的工具执行器。 */
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
 * 各自释放控制槽。页留在宿主上，下一个执行者接手得了。
 *
 * 直接调协调器的 release 代替不了它：要验的正是这条装配上每一环都传得到，
 * 少一环的表现是停止之后那两页永远被占着，而没有入口解得开。
 */
test('停止指令收走每个成员的控制槽，页留在宿主上给下一个执行者', async () => {
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
      // 两个成员都停在这一次请求上：停止发生时它们手里各占着一页。
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
    model: 'm',
    clientRequestId: 'stop-link',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
  // 顶层那一轮也登记进 RunManager：停止指令的两条分支都要真的走到。
  const parentRun = new AbortController()
  runs.register({ runId, conversationId: parent, controller: parentRun, startedAt: Date.now() })

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
  await until(() => !subagents.has(parent), '两个成员都收了尾')
  await settle()

  const frames = host.received.length
  await settle()
  // 停止之后不再向宿主发帧，也不关页：停止只收控制。
  expect(host.received).toHaveLength(frames)
  expect(host.ops()).not.toContain('close')
  expect(host.ops()).not.toContain('close.conversation')

  // 收尾之后这两页都不再被占，下一个执行者直接接手。
  const next = handle.browser?.portFor(parent, workspaceId)
  expect((await next?.tabs())?.map((t) => t.tabId).sort()).toEqual(['bt_1', 'bt_2'])
  expect((await next?.observe({ tabId: 'bt_1' }))?.observationId).toBeTruthy()
  expect((await next?.observe({ tabId: 'bt_2' }))?.observationId).toBeTruthy()
  parked.open()
})

test('两条会话各自建页、观察、动作，互不相干', async () => {
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
      observationId: obA?.observationId ?? '',
      action: 'click',
      ref: firstRef(obA),
    }),
    b?.act({
      tabId: tabB?.tabId ?? '',
      observationId: obB?.observationId ?? '',
      action: 'click',
      ref: firstRef(obB),
    }),
  ])
  expect(actA?.element).toBe('dl')
  expect(actB?.element).toBe('dl')
  // 两条会话各自建了一页，没有任何一条被 busy 挡掉。
  expect(host.ops().filter((op) => op === 'create')).toHaveLength(2)

  // 对方的 tabId 拿不到：归属挡在附页之前，动作连同它的观察编号一起被拦住。
  expect((await failure(a?.observe({ tabId: tabB?.tabId ?? '' }))).message).toMatch(/不归本会话/)
  expect(
    (
      await failure(
        b?.act({
          tabId: tabA?.tabId ?? '',
          observationId: obB?.observationId ?? '',
          action: 'click',
          ref: firstRef(obB),
        }),
      )
    ).message,
  ).toMatch(/不归本会话/)
})

test('一条会话释放不影响另一条：B 的页、观察与连接都还在', async () => {
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
    observationId: obB?.observationId ?? '',
    action: 'click',
    ref: firstRef(obB),
  })
  expect(acted?.element).toBe('dl')
})

test('两条会话同时接管同一个用户页，只有一条成功', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await settle()
  const a = handle.browser?.portFor('cv_a', WS)
  const b = handle.browser?.portFor('cv_b', WS)

  const settled = await Promise.allSettled([a?.bind('bt_u'), b?.bind('bt_u')])
  const ok = settled.filter((r) => r.status === 'fulfilled')
  expect(ok).toHaveLength(1)
  // 页级占用先成立，后到的一方连 bind 帧都没发出去；归属那一层由宿主在下一次拒绝。
  const refused = settled.find((r) => r.status === 'rejected')
  expect(String(refused?.reason)).toMatch(/正被另一个任务操作/)
  expect(host.ops().filter((op) => op === 'bind')).toHaveLength(1)
})

test('停止之后同会话立刻再启动，新执行不被上一次的收尾牵连', async () => {
  const { handle, host } = await ready()
  const first = handle.browser?.portFor('cv_1', WS)
  await first?.open('http://127.0.0.1:1/page')

  // 不等收尾完成就起下一轮：这一页要等上一次清理结束才放手，而不是回 busy。
  const releasing = first?.release()
  const second = handle.browser?.portFor('cv_1', WS)
  const ob = await second?.observe({ tabId: 'bt_1' })
  await releasing
  expect(ob?.observationId).toBeTruthy()

  // 收尾属于旧槽，不能把新槽的观察表清掉。
  await settle()
  const acted = await second?.act({
    tabId: 'bt_1',
    observationId: ob?.observationId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  expect(acted?.element).toBe('dl')
  expect(host.ops()).not.toContain('close')
})

test('宿主断开让全部控制作废，重连之后的新执行照常建槽', async () => {
  const { handle, host } = await ready()
  const before = handle.browser?.portFor('cv_1', WS)
  await before?.open('http://127.0.0.1:1/page')

  host.socket.close()
  await settle()
  expect(handle.browser?.available()).toBe(false)
  expect((await failure(before?.observe({ tabId: 'bt_1' }))).message).toMatch(/不可用|已经结束/)

  const again = await AutoHost.connect(handle.port)
  again.epoch = 2
  again.ready(fakeDevtools(again.marker).port)
  await settle()
  const after = handle.browser?.portFor('cv_1', WS)
  const tab = await after?.open('http://127.0.0.1:1/page')
  expect(tab?.tabId).toBe('bt_1')
  // 旧槽的收尾按槽对象删表项，删不掉重连之后建出来的这一个。
  await settle()
  const ob = await after?.observe({ tabId: tab?.tabId ?? '' })
  expect(ob?.observationId).toBeTruthy()
})

test('不归本会话的标签页在发请求之前就被挡住，归本会话的照常带会话 id 走', async () => {
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
          observationId: ob?.observationId ?? '',
          ref: firstRef(ob),
          absolutePath: target,
          timeoutMs: 5_000,
        }),
      )
    ).message,
  ).toMatch(/bt_9/)
  expect((await failure(port?.close('bt_9'))).message).toMatch(/bt_9/)
  expect(host.received).toHaveLength(before)

  // 归本会话的那一页照常走到宿主，并带上本会话 id。
  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    timeoutMs: 5_000,
  })
  await settle()
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

  // 第二条消息：新端口，同一会话。直接 observe 就能用——这一页仍归 cv_1。
  const second = handle.browser?.portFor('cv_1', WS)
  const ob = await second?.observe({ tabId: 'bt_1' })
  expect(ob?.observationId).toBeTruthy()
  // 全程没有 bind、没有交接：宿主只收到过一次 create。
  expect(host.ops()).toEqual(['create'])
  // 归属仍在，这一页对 cv_1 是可控的。
  expect(await second?.tabs()).toEqual([
    { tabId: 'bt_1', url: 'http://127.0.0.1:1/page', title: '夹具页', controlled: true },
  ])
})

test('别的会话看不到、也操作不了本会话的页', async () => {
  const { handle } = await ready()
  const owner = handle.browser?.portFor('cv_a', WS)
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  // 另一条会话：这一页不在它的存活清单里。
  const other = handle.browser?.portFor('cv_b', WS)
  expect(await other?.tabs()).toEqual([])
  // 硬拿这一页也拿不到：归属对不上，挡在附页之前。
  expect((await failure(other?.observe({ tabId: 'bt_1' }))).message).toMatch(/不归本会话/)
})

test('用户开的页默认不可操作，点名 bind 后才归本会话', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await settle()

  const port = handle.browser?.portFor('cv_1', WS)
  // 用户页列得出来，但标成不可控：AI 不自动操作。
  expect(await port?.tabs()).toEqual([
    { tabId: 'bt_u', url: 'http://127.0.0.1:1/page', title: '用户开的页', controlled: false },
  ])
  expect((await failure(port?.observe({ tabId: 'bt_u' }))).message).toMatch(/不归本会话/)

  // 用户在聊天里点名，模型按 tabId 接管。接管只改归属，不改这一页的标题。
  await port?.bind('bt_u')
  await settle()
  expect(await port?.tabs()).toEqual([
    { tabId: 'bt_u', url: 'http://127.0.0.1:1/page', title: '用户开的页', controlled: true },
  ])
  // 接管之后能直接操作。
  const ob = await port?.observe({ tabId: 'bt_u' })
  expect(ob?.observationId).toBeTruthy()
})

/** AI 主动关页与别的页面操作走同一道准入：归属、工作区、页级占用一个都不少。 */
test('本槽持有的页关得掉，未接管的用户页与别的会话的页关不掉', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const tabId = tab?.tabId ?? ''
  await port?.observe({ tabId })
  host.userOpen('bt_u')
  await settle()

  expect((await failure(port?.close('bt_u'))).message).toMatch(/不归本会话/)
  const other = handle.browser?.portFor('cv_2', WS)
  expect((await failure(other?.close(tabId))).message).toMatch(/不归本会话/)
  expect(host.ops()).not.toContain('close')

  await port?.close(tabId)
  expect(host.received.filter((f) => f.op === 'close').map((f) => f.tabId)).toEqual([tabId])
  expect((await port?.tabs())?.map((t) => t.tabId)).toEqual(['bt_u'])
})

test('持有者释放之后，另一个执行者关得掉那一页', async () => {
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

test('别的会话接管不了已归他人的页', async () => {
  const { handle } = await ready()
  const owner = handle.browser?.portFor('cv_a', WS)
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  const other = handle.browser?.portFor('cv_b', WS)
  expect((await failure(other?.bind('bt_1'))).message).toMatch(/另一条会话/)
})

/**
 * 工作区是列页的第一道过滤，会话归属在它之上。
 *
 * 少了这一道，B 工作区的用户页会出现在 A 的会话清单里并可被 `bind` 接管——
 * 那一页此后归 A 的会话，而它摆在 B 的页签条上。
 */
test('只列本工作区里归本会话或归用户的页', async () => {
  const { handle, host } = await ready()
  const other = 'ws_b'
  host.userOpen('bt_ua', WS)
  host.userOpen('bt_ub', other)
  await settle()

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
  // 建页请求带着各自的工作区，宿主按它落归属。
  const creates = host.received.filter((f) => f.op === 'create')
  expect(creates.map((f) => f.workspaceId)).toEqual([WS, other])
})

test('硬传另一个工作区的 tabId，bind 与 observe 都被拒', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_ub', 'ws_b')
  await settle()

  const inA = handle.browser?.portFor('cv_a', WS)
  expect((await failure(inA?.bind('bt_ub'))).message).toMatch(/不在本工作区/)
  expect((await failure(inA?.observe({ tabId: 'bt_ub' }))).message).toMatch(/不在本工作区/)
  expect((await failure(inA?.close('bt_ub'))).message).toMatch(/不在本工作区/)
  // 一帧都没发到宿主：跨工作区在本地就挡住了。
  expect(host.ops()).toEqual([])
})

test('会话删除关掉它名下的全部页，不留孤儿', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  await port?.open('http://127.0.0.1:1/other')
  await port?.release()

  await handle.browser?.closeConversation('cv_1')
  await settle()
  const closer = host.received.at(-1)
  expect(closer?.op).toBe('close.conversation')
  expect(closer?.conversationId).toBe('cv_1')
  // 宿主按会话关页并回投 closed，存活快照清空。
  const next = handle.browser?.portFor('cv_1', WS)
  expect(await next?.tabs()).toEqual([])
})

test('释放只断本次 CDP 连接，不向宿主发帧，重复释放也是空操作', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  const after = host.received.length

  await port?.release()
  // 释放不经宿主：没有 cancel，也没有 close，页留给下一条消息。
  expect(host.received).toHaveLength(after)
  expect(host.ops()).not.toContain('close')

  await port?.release()
  expect(host.received).toHaveLength(after)
})

test('运行时版本低于下限时不发控制权，也不向宿主发请求', async () => {
  const { handle } = fresh()
  const host = await AutoHost.connect(handle.port)
  host.ready(fakeDevtools(host.marker).port, '110.0.1587.0')
  await settle()
  expect(handle.browser?.available()).toBe(false)
  const port = handle.browser?.portFor('cv_1', WS)
  expect((await failure(port?.open('http://127.0.0.1:1/page'))).message).toMatch(/不可用/)
  expect(host.received).toHaveLength(0)
})

test('释放之后这个端口再也拿不到控制权', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  await port?.open('http://127.0.0.1:1/page')
  await port?.release()

  const before = host.received.length
  expect((await failure(port?.open('http://127.0.0.1:1/page'))).message).toMatch(/已经结束/)
  expect((await failure(port?.observe({ tabId: 'bt_1' }))).message).toMatch(/已经结束/)
  // 一条请求都没发出去：拒绝发生在取控制槽那一步。
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
          observationId: ob?.observationId ?? '',
          action: 'click',
          ref: firstRef(ob),
        }),
      )
    ).message,
  ).toMatch(/已经结束/)
  expect(host.ops()).not.toContain('close')
})

test('下载：先授权再点，等宿主给终态，最后核对磁盘', async () => {
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
    observationId: ob?.observationId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    timeoutMs: 5_000,
  })
  await settle()
  // 授权必须先于点击到达宿主：反过来的话钩子拿不到授权，这次下载会被取消。
  const armIndex = host.received.findIndex((f) => f.op === 'download.arm')
  expect(armIndex).toBeGreaterThanOrEqual(0)
  expect(host.received[armIndex]?.path).toBe(target)
  expect(devtools.clicks()).toBe(1)

  expect(host.received[armIndex]?.downloadId).toBeTruthy()

  writeFileSync(target, 'qywork', 'utf8')
  host.finishDownload('bt_1', { kind: 'download.finished', path: target, success: true })
  expect(await pending).toEqual({ path: target, bytes: 6 })
})

test('被拦下的下载如实进结果，不谎报成功', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    ref: firstRef(ob),
    absolutePath: join(tmpdir(), 'never-written.bin'),
    timeoutMs: 5_000,
  })
  await settle()
  host.finishDownload('bt_1', {
    kind: 'download.blocked',
    reason: 'exists',
    suggestedName: 'fixture.bin',
  })
  expect(await pending).toEqual({ blocked: 'exists', suggestedName: 'fixture.bin' })
})

test('换一次导航就作废旧观察，动作拿不到过期编号', async () => {
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
          observationId: ob?.observationId ?? '',
          action: 'click',
          ref: firstRef(ob),
        }),
      )
    ).message,
  ).toMatch(/失效/)
})

test('导航只作废目标页的观察，别的标签页的编号照常可用', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const one = await port?.open('http://127.0.0.1:1/page')
  const two = await port?.open('http://127.0.0.1:1/other')
  const obOne = await port?.observe({ tabId: one?.tabId ?? '' })
  const obTwo = await port?.observe({ tabId: two?.tabId ?? '' })

  await port?.navigate({ tabId: one?.tabId ?? '', action: 'reload' })

  // 另一页没被这次导航动过，它的编号仍然指得到节点。
  const other = await port?.act({
    tabId: two?.tabId ?? '',
    observationId: obTwo?.observationId ?? '',
    action: 'click',
    ref: firstRef(obTwo),
  })
  expect(other?.element).toBe('dl')
  // 导航的那一页旧编号作废。
  expect(
    (
      await failure(
        port?.act({
          tabId: one?.tabId ?? '',
          observationId: obOne?.observationId ?? '',
          action: 'click',
          ref: firstRef(obOne),
        }),
      )
    ).message,
  ).toMatch(/失效/)
})

test('动作之后直接给出新观察，用它再动作一次不必中间再观察', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const first = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!first || first.observation === null) throw new Error('这次动作本应带回观察')
  expect(first.element).toBe('dl')
  expect(first.settle).toBe('quiet')
  expect(first.observation.observationId).not.toBe(ob?.observationId)

  // 拿回来的编号直接用：这中间一次 observe 都没有。
  const second = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: first.observation.observationId,
    action: 'click',
    ref: first.observation.elements[0]?.ref ?? '',
  })
  if (!second || second.observation === null) throw new Error('这次动作本应带回观察')
  expect(second.element).toBe('dl')
})

/**
 * `browser_act` 的说明让模型在同一轮里用同一个 observationId 连发多个输入。
 * 动作后的自动观察只登记新编号，不作废同一文档里先前的那一份。
 */
test('动作之后先前那份观察仍可用：同一个 observationId 连发两次动作', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  const input = {
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'click' as const,
    ref: firstRef(ob),
  }

  const first = await port?.act(input)
  const second = await port?.act(input)

  expect(first?.element).toBe('dl')
  expect(second?.element).toBe('dl')
})

test('动作发出后观察取不到时保留回执，另说明为什么没看见', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  devtools.failObserve = true
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation !== null) throw new Error('这次观察本应取不到')
  // 动作已经发出去了：回执留着，模型据此知道不该重复点。
  expect(r.element).toBe('dl')
  expect(r.point).toEqual({ x: 10, y: 10 })
  expect(r.observationError).toContain('采集失败')
  expect(devtools.clicks()).toBe(1)
})

test('探针读数缺字段时不报静默，按阶段上限如实标注', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  devtools.blindProbe = true
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation === null) throw new Error('这次动作本应带回观察')
  expect(r.settle).toBe('deadline')
})

test('取消之后不再开新观察，动作回执仍然给得出', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  // 点击已经发出、静默探针刚登记上就释放控制：这一刻之后不得再开新观察。
  devtools.onCommand = (_method, expression) => {
    if (!expression.includes('__qyworkProbe(')) return
    devtools.onCommand = null
    void port?.release()
  }
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'click',
    ref: firstRef(ob),
  })
  if (!r || r.observation !== null) throw new Error('这次观察本应取不到')
  expect(r.element).toBe('dl')
  expect(r.observationError).toMatch(/取消/)
  expect(devtools.clicks()).toBe(1)
})

test('导航回的是导航之后的观察，不再另回一份标签信息', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')

  const r = await port?.navigate({
    tabId: tab?.tabId ?? '',
    action: 'goto',
    url: 'http://127.0.0.1:1/next',
  })
  if (!r || r.observation === null) throw new Error('这次导航本应带回观察')
  // 地址取自观察，是页面此刻的实际地址，不是请求过的那个。
  expect(r.observation.url).toBe('http://127.0.0.1:1/page')
  expect(r.observation.elements.length).toBeGreaterThan(0)
  expect(r.settle).toBe('quiet')
})

test('导航被拒时报失败，不拿旧页快照冒充跳转成功', async () => {
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

test('等待结束后直接采一次观察，不做静默等待也不带静默标注', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')

  const r = await port?.wait({ tabId: tab?.tabId ?? '', selector: '#dl', timeoutMs: 1_000 })
  expect(r?.found).toBe(true)
  if (!r || r.observation === null) throw new Error('这次等待本应带回观察')
  expect('settle' in r).toBe(false)
  expect(r.observation.elements.length).toBeGreaterThan(0)
})
test('同一页上一次调用的迟到终态不结算这一次，无授权的终态谁也不结算', async () => {
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
    observationId: ob?.observationId ?? '',
    ref: firstRef(ob),
    absolutePath: target,
    timeoutMs: 3_000,
  })
  await settle()
  const mine = host.received.findLast((f) => f.op === 'download.arm')?.downloadId
  expect(mine).toBeTruthy()

  // 同一页上另一个身份的终态：既不是本次调用的，也没有别的调用在等它。
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
  await settle()

  // 只有带本次身份的那一条能结算。
  host.finishDownload(tab?.tabId ?? '', { kind: 'download.finished', path: target, success: true })
  expect(await pending).toEqual({ path: target, bytes: 6 })
})

test('两条会话下载到同一个路径时后一份授权被拒，各自路径则都放行', async () => {
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
    observationId: obA?.observationId ?? '',
    ref: firstRef(obA),
    absolutePath: shared,
    timeoutMs: 5_000,
  })
  const heldOutcome = failure(held)
  await settle()

  expect(
    (
      await failure(
        b?.download({
          tabId: tabB?.tabId ?? '',
          observationId: obB?.observationId ?? '',
          ref: firstRef(obB),
          absolutePath: shared,
          timeoutMs: 5_000,
        }),
      )
    ).message,
  ).toMatch(/路径已被/)

  // 换一个路径就不冲突：授权照常登记，点击照常发出。
  const other = b?.download({
    tabId: tabB?.tabId ?? '',
    observationId: obB?.observationId ?? '',
    ref: firstRef(obB),
    absolutePath: join(dir, 'other.bin'),
    timeoutMs: 5_000,
  })
  await settle()
  expect(host.received.findLast((f) => f.op === 'download.arm')?.path).toBe(join(dir, 'other.bin'))

  host.finishDownload(tabB?.tabId ?? '', { kind: 'download.blocked', reason: 'exists' })
  expect(await other).toEqual({ blocked: 'exists' })
  await a?.release()
  await heldOutcome
})

test('释放撤销未消费的授权，正在等终态的下载按未确认返回', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  const pending = port?.download({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    ref: firstRef(ob),
    absolutePath: join(tmpdir(), 'qywork-never.bin'),
    timeoutMs: 30_000,
  })
  // 先挂上失败处理再释放：释放会就地终结这次等待，晚一步接就成了没人处理的拒绝。
  const outcome = failure(pending)
  await settle()
  const armed = host.received.findLast((f) => f.op === 'download.arm')?.downloadId

  await port?.release()
  // 不等 30 秒期限：等待随释放结束，且明确说没有确认到终态。
  expect((await outcome).message).toMatch(/没有确认到终态/)
  const disarm = host.received.findLast((f) => f.op === 'download.disarm')
  expect(disarm?.downloadId).toBe(armed)
  expect(host.arms.size).toBe(0)
})

test('optionsFor 按原观察读一页选项，不产生新的观察编号', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })
  if (!ob || !('elements' in ob)) throw new Error('这次观察本应给出元素表')
  const pick = ob.elements.find((e) => e.tag === 'select')

  const options = await port?.observe({
    tabId: tab?.tabId ?? '',
    optionsFor: { observationId: ob.observationId, ref: pick?.ref ?? '' },
  })
  if (!options || 'elements' in options) throw new Error('这次读取本应给出选项页')
  expect(options.observationId).toBe(ob.observationId)
  expect(options.total).toBe(3)
  expect(options.items).toHaveLength(3)

  // 没发新编号：原观察里的动作照常可用。
  const acted = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob.observationId,
    action: 'click',
    ref: firstRef(ob),
  })
  expect(acted?.element).toBe('dl')
})

test('optionsFor 用过期观察时明确失败，不改成采一份新观察', async () => {
  const { handle } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  expect(
    (
      await failure(
        port?.observe({
          tabId: tab?.tabId ?? '',
          optionsFor: { observationId: 'ob_gone', ref: 'e1' },
        }),
      )
    ).message,
  ).toMatch(/失效/)
  expect(ob?.observationId).toBeTruthy()
})

test('多事件动作中途失败仍带回后续观察，回执如实标注没做完', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1', WS)
  const tab = await port?.open('http://127.0.0.1:1/page')
  const ob = await port?.observe({ tabId: tab?.tabId ?? '' })

  // 第 3 条按键事件是第二个字符的按下：第一个字符已经进了页面。
  devtools.failKeyAt = 3
  const r = await port?.act({
    tabId: tab?.tabId ?? '',
    observationId: ob?.observationId ?? '',
    action: 'type',
    ref: firstRef(ob),
    text: 'ab',
  })
  if (!r || r.observation === null) throw new Error('这次动作本应带回观察')
  expect(r.execution).toEqual({ state: 'partial', confirmedUnits: 1 })
  expect(r.observation.observationId).not.toBe(ob?.observationId)
})
