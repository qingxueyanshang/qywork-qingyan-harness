/**
 * 原生浏览器宿主连接的准入、配对与断线语义。
 *
 * 覆盖范围：`bridge.ts` 全部、`server.ts` 中 `/native/browser` 的升级与帧分派、
 * `coordinator.ts` 的版本准入，以及 `packages/core/src/protocol/native-browser.ts`
 * 与 Rust 侧共用的 JSON 样例（Rust 一侧在 `browser/frames.rs` 的测试中）。
 *
 * 使用真实 WebSocket 连接真实的 `serve()`：凭据判定、回环判定与升级分派均位于
 * `server.ts` 的 fetch 中，使用假 socket 会跳过被测代码。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserEventFrame,
  BrowserRequestFrame,
  BrowserResultFrame,
  HostReadyFrame,
  NativeBrowserUpFrame,
} from '@qywork/core'
import { NATIVE_BROWSER_PATH, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'

const HOST_KEY = 'browser-host-key-for-tests'

/** 样例快照中两页所在的工作区。端口按它取得，跨工作区的过滤见 `coordinator.test.ts`。 */
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

function fresh(): ReturnType<typeof serve> {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-browser-'))
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
    hostKey: HOST_KEY,
  })
  cleanups.push(() => {
    handle.stop()
    content.close()
    store.close()
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删除失败与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return handle
}

/** 样例为 TS 与 Rust 两侧共用的同一份，不在此处另行复制。 */
function samples(): Record<string, Record<string, unknown>> {
  const file = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'core',
    'src',
    'protocol',
    'native-browser.samples.json',
  )
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
}

/** 假宿主：一条真实的 WebSocket 连接，按需回帧。 */
class FakeHost {
  socket: WebSocket
  received: BrowserRequestFrame[] = []
  #waiters: ((frame: BrowserRequestFrame) => void)[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as BrowserRequestFrame
      this.received.push(frame)
      this.#waiters.shift()?.(frame)
    }
  }

  static async connect(port: number, key = HOST_KEY): Promise<FakeHost> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_BROWSER_PATH}`, {
      headers: { [NATIVE_HOST_KEY_HEADER]: key },
    })
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onclose = () => reject(new Error('宿主连接被拒'))
      socket.onerror = () => reject(new Error('宿主连接失败'))
    })
    const host = new FakeHost(socket)
    cleanups.push(() => host.socket.close())
    return host
  }

  send(frame: NativeBrowserUpFrame): void {
    this.socket.send(JSON.stringify(frame))
  }

  ready(over: Partial<HostReadyFrame> = {}): void {
    const sample = samples().hostReady as unknown as HostReadyFrame
    this.send({ ...sample, ...over })
  }

  next(): Promise<BrowserRequestFrame> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  reply(frame: BrowserRequestFrame, over: Partial<BrowserResultFrame> = {}): void {
    this.send({
      type: 'browser.result',
      requestId: frame.requestId,
      connectionEpoch: frame.connectionEpoch,
      ok: true,
      data: { tabId: 'bt_1', marker: '9a3f' },
      ...over,
    })
  }

  refuse(frame: BrowserRequestFrame, error: string): void {
    this.send({
      type: 'browser.result',
      requestId: frame.requestId,
      connectionEpoch: frame.connectionEpoch,
      ok: false,
      error,
    })
  }
}

/** 让事件循环派发完已到达的帧。 */
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * 取得一次调用失败的原因。
 *
 * 不使用 `expect(...).rejects`：该断言在等待一个须由 WebSocket 响应帧才能结算的
 * Promise 时不会让出事件循环，响应帧因此永远无法到达，测试只会超时。
 */
async function failure(pending: Promise<unknown> | undefined): Promise<Error> {
  const settled = Symbol('resolved')
  const out = await Promise.resolve(pending).then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('这条调用本应失败')
  return out as Error
}

test('凭据错误或缺少凭据的连接一律拒绝，不进入宿主生命周期', async () => {
  const handle = fresh()
  expect(await failure(FakeHost.connect(handle.port, 'wrong-key'))).toBeInstanceOf(Error)
  const bare = new WebSocket(`ws://127.0.0.1:${handle.port}${NATIVE_BROWSER_PATH}`)
  await new Promise<void>((resolve) => {
    bare.onclose = () => resolve()
    bare.onerror = () => resolve()
  })
  expect(handle.browser?.available()).toBe(false)
})

test('普通配对连接自报 desktop 时同样无法注册宿主', async () => {
  const handle = fresh()
  const ws = new WebSocket(
    `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
  )
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('配对连接应当能建立'))
  })
  cleanups.push(() => ws.close())
  ws.send(JSON.stringify(samples().hostReady))
  await settle()
  expect(handle.browser?.available()).toBe(false)
})

test('宿主 host.ready 之后能力可用，运行时版本低于下限则不发布', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  expect(handle.browser?.available()).toBe(true)

  const low = fresh()
  const lowHost = await FakeHost.connect(low.port)
  lowHost.ready({ runtimeVersion: '110.0.1587.0' })
  await settle()
  expect(low.browser?.available()).toBe(false)
})

/**
 * 宿主已连接但没有可用浏览器（未找到，或浏览器进程退出）时，能力下线并附带原因；
 * 浏览器重新启动后宿主在同一连接上重发 `host.ready`，能力恢复，原因清除。
 */
test('host.unavailable 撤销能力并报告原因，同一连接上的 host.ready 恢复能力', async () => {
  const handle = fresh()
  const seen: unknown[] = []
  cleanups.push(
    handle.bus.subscribe({
      id: 'probe',
      origin: 'desktop',
      conversations: null,
      send: (frame) => {
        if (frame.event.type === 'browser.state') seen.push(frame.event.browser)
      },
    }),
  )
  const host = await FakeHost.connect(handle.port)
  host.send(samples().hostUnavailable as unknown as NativeBrowserUpFrame)
  await settle()
  expect(handle.browser?.available()).toBe(false)
  expect(seen.at(-1)).toEqual({
    connected: false,
    runtimeSupported: false,
    unavailable: 'not_found',
  })

  host.ready()
  await settle()
  expect(handle.browser?.available()).toBe(true)
  expect(seen.at(-1)).toEqual({
    connected: true,
    runtimeSupported: true,
    presentation: 'embedded',
  })

  // 浏览器进程退出：进行中的调用失败，快照清空，原因变为 exited。
  const pending = handle.browser?.portFor('cv_bridge', WS).open('http://127.0.0.1:1/page')
  await host.next()
  host.send({ type: 'host.unavailable', reason: 'exited' })
  expect((await failure(pending)).message).toMatch(/没有可用的浏览器/)
  await settle()
  expect(await handle.browser?.portFor('cv_a1', WS).tabs()).toEqual([])
  expect(seen.at(-1)).toEqual({ connected: false, runtimeSupported: false, unavailable: 'exited' })

  // 连接断开后原因不再成立：此时是没有宿主，而不是宿主没有浏览器。
  host.socket.close()
  await settle()
  expect(seen.at(-1)).toEqual({ connected: false, runtimeSupported: false })
})

/**
 * 页面显示在面板中还是浏览器自身的窗口中，只由宿主的 `host.ready` 声明；能力将其原样传给界面，
 * 宿主不在时该字段缺席。界面按它显示，不按 UA 判断。
 */
test('页面的显示位置随 host.ready 进入能力，宿主断开后缺席', async () => {
  const handle = fresh()
  const seen: unknown[] = []
  cleanups.push(
    handle.bus.subscribe({
      id: 'probe',
      origin: 'desktop',
      conversations: null,
      send: (frame) => {
        if (frame.event.type === 'browser.state') seen.push(frame.event.browser)
      },
    }),
  )
  const host = await FakeHost.connect(handle.port)
  host.ready({ platform: 'linux', presentation: 'window', runtimeVersion: '154.0.8037.57' })
  await settle()
  expect(seen.at(-1)).toEqual({ connected: true, runtimeSupported: true, presentation: 'window' })

  host.socket.close()
  await settle()
  expect(seen.at(-1)).toEqual({ connected: false, runtimeSupported: false })
})

test('断线使所有待决调用失败，能力随之下线', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge', WS)
  const pending = port?.open('http://127.0.0.1:1/page')
  await host.next()
  host.socket.close()
  expect((await failure(pending)).message).toMatch(/断开|重连/)
  await settle()
  expect(handle.browser?.available()).toBe(false)
})

/**
 * 用户新开的页同样进入服务端的存活快照，`control` 事件修改其归属。
 *
 * 缺少 opened 事件时，模型在 `browser_tabs` 中只能看到 AI 创建的页；
 * 用户在聊天中点名接管后，宿主发送 `control` 将归属改为该会话，快照随之更新。
 */
test('宿主的 opened 事件是新页进入存活快照的唯一途径，control 修改归属', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.send({ ...(samples().hostReady as unknown as HostReadyFrame), tabs: [] })
  await settle()
  expect(await handle.browser?.portFor('cv_bridge', WS).tabs()).toEqual([])

  host.send({
    type: 'browser.event',
    connectionEpoch: 3,
    seq: 1,
    kind: 'opened',
    tabId: 'bt_7',
    url: 'http://127.0.0.1:1/page',
    title: '人工开的页',
    marker: 'm7',
    workspaceId: WS,
    conversationId: null,
  })
  await settle()
  // 用户页对任何会话都不可控。
  expect(await handle.browser?.portFor('cv_bridge', WS).tabs()).toEqual([
    { tabId: 'bt_7', url: 'http://127.0.0.1:1/page', title: '人工开的页', controlled: false },
  ])

  host.send({
    type: 'browser.event',
    connectionEpoch: 3,
    seq: 2,
    kind: 'control',
    tabId: 'bt_7',
    conversationId: 'cv_bridge',
  })
  await settle()
  // 归属改为 cv_bridge 后，该页对它可控。
  expect(await handle.browser?.portFor('cv_bridge', WS).tabs()).toEqual([
    { tabId: 'bt_7', url: 'http://127.0.0.1:1/page', title: '人工开的页', controlled: true },
  ])

  host.send({ type: 'browser.event', connectionEpoch: 3, seq: 3, kind: 'closed', tabId: 'bt_7' })
  await settle()
  expect(await handle.browser?.portFor('cv_bridge', WS).tabs()).toEqual([])
})

test('重连后取得完整的存活页快照，旧快照不残留', async () => {
  const handle = fresh()
  const first = await FakeHost.connect(handle.port)
  first.ready()
  await settle()
  // 样例中 bt_1 归属 cv_a1，bt_2 是用户页；cv_a1 可见两页。
  expect(await handle.browser?.portFor('cv_a1', WS).tabs()).toHaveLength(2)
  first.socket.close()
  await settle()

  const second = await FakeHost.connect(handle.port)
  const sample = samples().hostReady as unknown as HostReadyFrame
  second.send({
    ...sample,
    connectionEpoch: 4,
    tabs: [
      {
        tabId: 'bt_9',
        url: 'http://127.0.0.1:1/x',
        title: 'X',
        marker: 'm9',
        workspaceId: WS,
        conversationId: null,
      },
    ],
  })
  await settle()
  const tabs = await handle.browser?.portFor('cv_a1', WS).tabs()
  expect(tabs?.map((t) => t.tabId)).toEqual(['bt_9'])
})

test('旧纪元的结果不能完成新纪元的调用', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge', WS)
  const pending = port?.open('http://127.0.0.1:1/page')
  const request = await host.next()
  expect(request.connectionEpoch).toBe(3)
  // requestId 相同而纪元不一致：该帧属于上一条连接，不得完成本次调用。
  host.reply(request, { connectionEpoch: 2 })
  await settle()
  // 调用仍处于待决状态：以断开连接证明它未被该帧结算。
  host.socket.close()
  expect((await failure(pending)).message).toMatch(/断开|重连/)
})

test('请求帧的线上格式与 Rust 侧共用同一份样例', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge', WS)
  const opening = port?.open('http://127.0.0.1:1/page')
  const create = await host.next()
  expect(create.type).toBe('browser.request')
  expect(create.op).toBe('create')
  expect(create.connectionEpoch).toBe(3)
  expect(create.url).toBe('http://127.0.0.1:1/page')
  expect(create.conversationId).toBe('cv_bridge')
  expect(create.workspaceId).toBe(WS)
  expect(create.deadline).toBeGreaterThan(Date.now())

  host.refuse(create, 'refused')
  expect((await failure(opening)).message).toBe('refused')

  const sample = samples().request as unknown as BrowserRequestFrame
  expect(Object.keys(sample).sort()).toEqual(
    [
      'connectionEpoch',
      'conversationId',
      'deadline',
      'downloadId',
      'op',
      'path',
      'requestId',
      'tabId',
      'type',
    ].sort(),
  )

  const creating = samples().createRequest as unknown as BrowserRequestFrame
  expect(Object.keys(creating).sort()).toEqual(
    [
      'connectionEpoch',
      'conversationId',
      'deadline',
      'op',
      'requestId',
      'type',
      'url',
      'workspaceId',
    ].sort(),
  )
})

/**
 * 缺少工作区的页不进入服务端存活表。
 *
 * 用空字符串填充时，该页不属于任何工作区却在所有工作区中可见；服务端没有
 * 「当前工作区」可供推断，因此只能拒收。
 */
test('host.ready 中有页缺少工作区时拒绝该连接，缺少工作区的 opened 不进入快照', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  const sample = samples().hostReady as unknown as HostReadyFrame
  host.send({
    ...sample,
    tabs: [{ tabId: 'bt_1', url: 'http://127.0.0.1:1/x', title: 'X', marker: 'm1' }],
  } as unknown as HostReadyFrame)
  await settle()
  expect(handle.browser?.available()).toBe(false)

  host.send({ ...sample, tabs: [] })
  await settle()
  expect(handle.browser?.available()).toBe(true)

  host.send({
    type: 'browser.event',
    connectionEpoch: 3,
    seq: 1,
    kind: 'opened',
    tabId: 'bt_8',
    url: 'http://127.0.0.1:1/y',
    title: 'Y',
    marker: 'm8',
    conversationId: null,
  })
  await settle()
  expect(await handle.browser?.portFor('cv_bridge', WS).tabs()).toEqual([])
})

/**
 * 下载终态携带被消费的授权身份。
 *
 * 缺少该身份时服务端只能按 tabId 认领，同一页上先发起的调用会取得后发起调用的结果。
 */
test('下载终态样例携带身份字段，两侧按同一格式编解码', async () => {
  const sample = samples().downloadFinished as unknown as BrowserEventFrame
  expect(sample.kind).toBe('download.finished')
  expect(sample.downloadId).toBe('dl_4')
  expect(sample.success).toBe(true)

  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  let seen: BrowserEventFrame | null = null
  handle.browser?.onEvent((frame) => {
    seen = frame
  })
  host.send(sample)
  await settle()
  expect((seen as BrowserEventFrame | null)?.downloadId).toBe('dl_4')
})
