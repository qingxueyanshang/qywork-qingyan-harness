/**
 * 浏览器控制的会话归属与并发。
 *
 * 覆盖范围：`coordinator.ts` 的按会话控制槽、版本准入、会话归属校验、按会话关页、
 * 释放与迟到回包的收尾、宿主断开重连，动作与导航之后的静默等待、观察登记与失败说明，
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
import type { BrowserEventFrame, BrowserRequestFrame, HostReadyFrame } from '@qywork/core'
import { NATIVE_BROWSER_KEY_HEADER, NATIVE_BROWSER_PATH } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { serve } from '../server.ts'

const HOST_KEY = 'coordinator-host-key'

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

/** 假调试端点的开关：单条用例按需改它，改完影响其后的每一条命令。 */
interface Devtools {
  port: number
  clicks: () => number
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
  const state: Devtools = {
    port: 0,
    clicks: () => clicks,
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
        ws.send(
          JSON.stringify(
            error === null
              ? { id: cmd.id, result }
              : { id: cmd.id, error: { code: -32000, message: error } },
          ),
        )
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
  /** tabId → 尚未消费的授权。按真宿主的形状记身份与目标路径。 */
  arms = new Map<string, { downloadId: string; path: string }>()
  /** 本次连接的纪元。重连用例给新连接换一个值，旧纪元的事件随之作废。 */
  epoch = 1
  /** 答完一次 `create` 之后回调一次。用来把释放插进建页回包与登记之间。 */
  onCreate: (() => void) | null = null
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
        // 真宿主在回结果之前先发 `opened`，存活快照只从那条来。
        this.emit({
          kind: 'opened',
          tabId,
          url: String(frame.url ?? ''),
          title: '夹具页',
          marker: this.marker,
          conversationId: frame.conversationId ?? null,
        })
      }
      if (frame.op === 'bind') {
        const tabId = frame.tabId ?? ''
        const owner = this.owners.get(tabId)
        if (owner === undefined) {
          error = `认不出的标签页 ${tabId}`
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
        this.emit({ kind: 'closed', tabId: frame.tabId ?? '' })
      }
      if (frame.op === 'close.conversation') {
        for (const [tabId, owner] of [...this.owners]) {
          if (owner === frame.conversationId) {
            this.owners.delete(tabId)
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
      socket.send(
        JSON.stringify({
          type: 'browser.result',
          requestId: frame.requestId,
          connectionEpoch: frame.connectionEpoch,
          ok: error === undefined,
          ...(error === undefined ? { data } : { error }),
        }),
      )
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

  /** 用户自己新开一页：归属为 `null`，走 `opened` 进存活快照。 */
  userOpen(tabId: string, url = 'http://127.0.0.1:1/page', title = '用户开的页'): void {
    this.owners.set(tabId, null)
    this.emit({ kind: 'opened', tabId, url, title, marker: this.marker, conversationId: null })
  }

  static async connect(port: number): Promise<AutoHost> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_BROWSER_PATH}`, {
      headers: { [NATIVE_BROWSER_KEY_HEADER]: HOST_KEY },
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

function fresh(): ReturnType<typeof serve> {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-coord-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  upsertWorkspace(store, dir, 'W')
  const handle = serve({
    store,
    config,
    content,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    browserHostKey: HOST_KEY,
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
  return handle
}

async function ready(): Promise<{
  handle: ReturnType<typeof serve>
  host: AutoHost
  devtools: Devtools
}> {
  const handle = fresh()
  const host = await AutoHost.connect(handle.port)
  const devtools = fakeDevtools(host.marker)
  host.ready(devtools.port)
  await settle()
  return { handle, host, devtools }
}

test('同一条会话同时只有一个执行拿得到控制权，第二个明确失败', async () => {
  const { handle, host } = await ready()
  const first = handle.browser?.portFor('cv_1')
  const second = handle.browser?.portFor('cv_1')
  const tab = await first?.open('http://127.0.0.1:1/page')
  expect(tab?.tabId).toBe('bt_1')

  expect((await failure(second?.open('http://127.0.0.1:1/page'))).message).toMatch(/另一个任务/)
  expect((await failure(second?.observe({ tabId: 'bt_1' }))).message).toMatch(/另一个任务/)
  // 抢不到的那一方一帧都没发出去。
  expect(host.ops()).toEqual(['create'])
})

test('两条会话各自建页、观察、动作，互不相干', async () => {
  const { handle, host } = await ready()
  const a = handle.browser?.portFor('cv_a')
  const b = handle.browser?.portFor('cv_b')

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
  const a = handle.browser?.portFor('cv_a')
  const b = handle.browser?.portFor('cv_b')
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
  const a = handle.browser?.portFor('cv_a')
  const b = handle.browser?.portFor('cv_b')

  const settled = await Promise.allSettled([a?.bind('bt_u'), b?.bind('bt_u')])
  const ok = settled.filter((r) => r.status === 'fulfilled')
  expect(ok).toHaveLength(1)
  const refused = settled.find((r) => r.status === 'rejected')
  expect(String(refused?.reason)).toMatch(/另一条会话/)
})

test('停止之后同会话立刻再启动，新执行不被上一次的收尾牵连', async () => {
  const { handle, host } = await ready()
  const first = handle.browser?.portFor('cv_1')
  await first?.open('http://127.0.0.1:1/page')

  // 不等收尾完成就起下一轮：新槽要等本会话上一次清理结束再建，而不是拿到 busy。
  const releasing = first?.release()
  const second = handle.browser?.portFor('cv_1')
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

test('建页回包晚于释放时，这一页被回收，不留无人操作的孤儿', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
  // create 的回包一到就释放：登记不成立，这一页必须被关掉。
  const opening = port?.open('http://127.0.0.1:1/page')
  host.onCreate = () => {
    host.onCreate = null
    void port?.release()
  }
  expect((await failure(opening)).message).toMatch(/已经结束/)
  await settle()
  expect(host.ops()).toContain('close')
  expect(host.received.filter((f) => f.op === 'close').at(-1)?.tabId).toBe('bt_1')
  expect(await handle.browser?.portFor('cv_1').tabs()).toEqual([])
})

test('宿主断开让全部控制作废，重连之后的新执行照常建槽', async () => {
  const { handle, host } = await ready()
  const before = handle.browser?.portFor('cv_1')
  await before?.open('http://127.0.0.1:1/page')

  host.socket.close()
  await settle()
  expect(handle.browser?.available()).toBe(false)
  expect((await failure(before?.observe({ tabId: 'bt_1' }))).message).toMatch(/不可用|已经结束/)

  const again = await AutoHost.connect(handle.port)
  again.epoch = 2
  again.ready(fakeDevtools(again.marker).port)
  await settle()
  const after = handle.browser?.portFor('cv_1')
  const tab = await after?.open('http://127.0.0.1:1/page')
  expect(tab?.tabId).toBe('bt_1')
  // 旧槽的收尾按槽对象删表项，删不掉重连之后建出来的这一个。
  await settle()
  const ob = await after?.observe({ tabId: tab?.tabId ?? '' })
  expect(ob?.observationId).toBeTruthy()
})

test('不归本会话的标签页在发请求之前就被挡住，归本会话的照常带会话 id 走', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
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
  const first = handle.browser?.portFor('cv_1')
  const tab = await first?.open('http://127.0.0.1:1/page')
  await first?.observe({ tabId: tab?.tabId ?? '' })
  await first?.release()

  // 第二条消息：新端口，同一会话。直接 observe 就能用——这一页仍归 cv_1。
  const second = handle.browser?.portFor('cv_1')
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
  const owner = handle.browser?.portFor('cv_a')
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  // 另一条会话：这一页不在它的存活清单里。
  const other = handle.browser?.portFor('cv_b')
  expect(await other?.tabs()).toEqual([])
  // 硬拿这一页也拿不到：归属对不上，挡在附页之前。
  expect((await failure(other?.observe({ tabId: 'bt_1' }))).message).toMatch(/不归本会话/)
})

test('用户开的页默认不可操作，点名 bind 后才归本会话', async () => {
  const { handle, host } = await ready()
  host.userOpen('bt_u')
  await settle()

  const port = handle.browser?.portFor('cv_1')
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

test('别的会话接管不了已归他人的页', async () => {
  const { handle } = await ready()
  const owner = handle.browser?.portFor('cv_a')
  await owner?.open('http://127.0.0.1:1/page')
  await owner?.release()

  const other = handle.browser?.portFor('cv_b')
  expect((await failure(other?.bind('bt_1'))).message).toMatch(/另一条会话/)
})

test('会话删除关掉它名下的全部页，不留孤儿', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
  await port?.open('http://127.0.0.1:1/page')
  await port?.open('http://127.0.0.1:1/other')
  await port?.release()

  await handle.browser?.closeConversation('cv_1')
  await settle()
  const closer = host.received.at(-1)
  expect(closer?.op).toBe('close.conversation')
  expect(closer?.conversationId).toBe('cv_1')
  // 宿主按会话关页并回投 closed，存活快照清空。
  const next = handle.browser?.portFor('cv_1')
  expect(await next?.tabs()).toEqual([])
})

test('释放只断本次 CDP 连接，不向宿主发帧，重复释放也是空操作', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
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
  const handle = fresh()
  const host = await AutoHost.connect(handle.port)
  host.ready(fakeDevtools(host.marker).port, '110.0.1587.0')
  await settle()
  expect(handle.browser?.available()).toBe(false)
  const port = handle.browser?.portFor('cv_1')
  expect((await failure(port?.open('http://127.0.0.1:1/page'))).message).toMatch(/不可用/)
  expect(host.received).toHaveLength(0)
})

test('释放之后这个端口再也拿不到控制权', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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

  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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

test('动作发出后观察取不到时保留回执，另说明为什么没看见', async () => {
  const { handle, devtools } = await ready()
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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

  const port = handle.browser?.portFor('cv_1')
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

  const a = handle.browser?.portFor('cv_a')
  const b = handle.browser?.portFor('cv_b')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
  const port = handle.browser?.portFor('cv_1')
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
