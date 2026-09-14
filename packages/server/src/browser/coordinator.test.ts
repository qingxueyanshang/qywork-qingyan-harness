/**
 * 浏览器控制的会话归属与并发。
 *
 * 覆盖范围：`coordinator.ts` 的控制槽发放、版本准入、会话归属校验、按会话关页与释放，
 * 以及它经 `bridge.ts` 发出的 `create` / `bind` / `close.conversation` / `download.arm` 形状。
 *
 * 对端是一个自动应答的假宿主，外加一个只走通路的假调试端点——这里问的是
 * 「哪条会话的页归谁、别的会话能不能操作它、删会话关不关得掉页」，不是 CDP 协议细节
 * （那在 `cdp.test.ts`）。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function failure(pending: Promise<unknown> | undefined): Promise<Error> {
  const settled = Symbol('resolved')
  const out = await Promise.resolve(pending).then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('这条调用本应失败')
  return out as Error
}

/**
 * 只走通路的假调试端点：一个 page target、一个可点的下载链接。
 *
 * 元素与动作的判定在 `page.test.ts`；这里只要让观察和点击能走通，
 * 好把下载的授权、触发、终态、磁盘核对这条链接起来。
 */
function fakeDevtools(marker: string): { port: number; clicks: () => number } {
  let clicks = 0
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
        if (cmd.method === 'Target.getTargets') {
          result = { targetInfos: [{ targetId: 'page-1', type: 'page' }] }
        }
        if (cmd.method === 'Target.attachToTarget') result = { sessionId: 'sess-1' }
        if (cmd.method === 'DOM.getDocument') {
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
              ],
            },
          }
        }
        if (cmd.method === 'Accessibility.getFullAXTree') {
          result = {
            nodes: [{ backendDOMNodeId: 9, role: { value: 'link' }, name: { value: '下载' } }],
          }
        }
        if (cmd.method === 'DOM.resolveNode') result = { object: { objectId: 'obj-9' } }
        if (cmd.method === 'Runtime.callFunctionOn') {
          result = {
            result: {
              value: {
                connected: true,
                identity: 'a|dl||',
                x: 10,
                y: 10,
                sameTree: true,
                hit: 'a',
                label: 'dl',
              },
            },
          }
        }
        if (cmd.method === 'Input.dispatchMouseEvent' && cmd.params?.type === 'mousePressed') {
          clicks += 1
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
          } else result = { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
        }
        ws.send(JSON.stringify({ id: cmd.id, result }))
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port ?? 0, clicks: () => clicks }
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
      if (frame.op === 'download.disarm') data.removed = true
      socket.send(
        JSON.stringify({
          type: 'browser.result',
          requestId: frame.requestId,
          connectionEpoch: frame.connectionEpoch,
          ok: error === undefined,
          ...(error === undefined ? { data } : { error }),
        }),
      )
    }
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
      connectionEpoch: 1,
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
      JSON.stringify({ type: 'browser.event', connectionEpoch: 1, seq: 1, ...frame }),
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
  devtools: { port: number; clicks: () => number }
}> {
  const handle = fresh()
  const host = await AutoHost.connect(handle.port)
  const devtools = fakeDevtools(host.marker)
  host.ready(devtools.port)
  await settle()
  return { handle, host, devtools }
}

test('一个宿主同一时刻只有一个执行拿得到控制权，第二个明确失败', async () => {
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

test('不归本会话的标签页在发请求之前就被挡住，归本会话的照常带会话 id 走', async () => {
  const { handle, host } = await ready()
  const port = handle.browser?.portFor('cv_1')
  await port?.open('http://127.0.0.1:1/page')
  const before = host.received.length

  expect((await failure(port?.armDownload('bt_9', 'D:\\x.bin', 5_000))).message).toMatch(/bt_9/)
  expect((await failure(port?.close('bt_9'))).message).toMatch(/bt_9/)
  expect(host.received).toHaveLength(before)

  // 归本会话的那一页照常走到宿主，并带上本会话 id。
  await port?.armDownload('bt_1', 'D:\\x.bin', 5_000)
  const arm = host.received.at(-1)
  expect(arm?.op).toBe('download.arm')
  expect(arm?.tabId).toBe('bt_1')
  expect(arm?.path).toBe('D:\\x.bin')
  expect(arm?.conversationId).toBe('cv_1')
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
          ref: ob?.elements[0]?.ref ?? '',
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
    ref: ob?.elements[0]?.ref ?? '',
    absolutePath: target,
    timeoutMs: 5_000,
  })
  await settle()
  // 授权必须先于点击到达宿主：反过来的话钩子拿不到授权，这次下载会被取消。
  const armIndex = host.received.findIndex((f) => f.op === 'download.arm')
  expect(armIndex).toBeGreaterThanOrEqual(0)
  expect(host.received[armIndex]?.path).toBe(target)
  expect(devtools.clicks()).toBe(1)

  writeFileSync(target, 'qywork', 'utf8')
  host.emit({ kind: 'download.finished', tabId: 'bt_1', path: target, success: true })
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
    ref: ob?.elements[0]?.ref ?? '',
    absolutePath: join(tmpdir(), 'never-written.bin'),
    timeoutMs: 5_000,
  })
  await settle()
  host.emit({
    kind: 'download.blocked',
    tabId: 'bt_1',
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
          ref: ob?.elements[0]?.ref ?? '',
        }),
      )
    ).message,
  ).toMatch(/失效/)
})
