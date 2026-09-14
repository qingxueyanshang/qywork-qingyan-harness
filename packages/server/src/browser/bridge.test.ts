/**
 * 原生浏览器宿主连接的准入、配对与断线语义。
 *
 * 覆盖范围：`bridge.ts` 全部、`server.ts` 里 `/native/browser` 的升级与帧分派、
 * `coordinator.ts` 的版本准入，以及 `packages/core/src/protocol/native-browser.ts`
 * 与 Rust 侧共用的那组 JSON 样例（Rust 那半在 `browser/frames.rs` 的测试里）。
 *
 * 用真 WebSocket 连真 `serve()`：凭据判定、回环判定、升级分派三件事都在
 * `server.ts` 的 fetch 里，拿假 socket 测等于把被测那一段跳过去。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserRequestFrame,
  BrowserResultFrame,
  HostReadyFrame,
  NativeBrowserUpFrame,
} from '@qywork/core'
import { NATIVE_BROWSER_KEY_HEADER, NATIVE_BROWSER_PATH } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'

const HOST_KEY = 'browser-host-key-for-tests'

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

/** 样例是 TS / Rust 两侧共用的那一份，不在这里另抄一遍。 */
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

/** 假宿主：一条真 WebSocket，按需回帧。 */
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
      headers: { [NATIVE_BROWSER_KEY_HEADER]: key },
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

/** 让事件循环把已经到达的帧派发完。 */
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * 取一次失败的原因。
 *
 * 不用 `expect(...).rejects`：那个断言在等一条要靠 WebSocket 回帧才结得掉的
 * Promise 时不会让出事件循环，回帧因此永远到不了，测试只会撞超时。
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

test('凭据不对或缺凭据的连接一律拒绝，不进入宿主生命周期', async () => {
  const handle = fresh()
  expect(await failure(FakeHost.connect(handle.port, 'wrong-key'))).toBeInstanceOf(Error)
  const bare = new WebSocket(`ws://127.0.0.1:${handle.port}${NATIVE_BROWSER_PATH}`)
  await new Promise<void>((resolve) => {
    bare.onclose = () => resolve()
    bare.onerror = () => resolve()
  })
  expect(handle.browser?.available()).toBe(false)
})

test('普通配对连接自报 desktop 也注册不了宿主', async () => {
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

test('断线让所有待决调用失败，并把能力一起下线', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge')
  const pending = port?.open('http://127.0.0.1:1/page')
  await host.next()
  host.socket.close()
  expect((await failure(pending)).message).toMatch(/断开|重连/)
  await settle()
  expect(handle.browser?.available()).toBe(false)
})

/**
 * 用户自己新开的页也要进服务端的存活快照，`control` 事件改它的归属。
 *
 * 少了 opened 这一条，模型在 `browser_tabs` 里只看得见 AI 自己建的那些页；
 * 用户在聊天里点名接管后，宿主发 `control` 把归属落到这条会话，快照随之更新。
 */
test('宿主的 opened 事件是新页进存活快照的唯一途径，control 改归属', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.send({ ...(samples().hostReady as unknown as HostReadyFrame), tabs: [] })
  await settle()
  expect(await handle.browser?.portFor('cv_bridge').tabs()).toEqual([])

  host.send({
    type: 'browser.event',
    connectionEpoch: 3,
    seq: 1,
    kind: 'opened',
    tabId: 'bt_7',
    url: 'http://127.0.0.1:1/page',
    title: '人工开的页',
    marker: 'm7',
    conversationId: null,
  })
  await settle()
  // 用户页对任何会话都是不可控。
  expect(await handle.browser?.portFor('cv_bridge').tabs()).toEqual([
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
  // 归到 cv_bridge 之后，这一页对它可控。
  expect(await handle.browser?.portFor('cv_bridge').tabs()).toEqual([
    { tabId: 'bt_7', url: 'http://127.0.0.1:1/page', title: '人工开的页', controlled: true },
  ])

  host.send({ type: 'browser.event', connectionEpoch: 3, seq: 3, kind: 'closed', tabId: 'bt_7' })
  await settle()
  expect(await handle.browser?.portFor('cv_bridge').tabs()).toEqual([])
})

test('重连取到的是完整存活页快照，旧快照不残留', async () => {
  const handle = fresh()
  const first = await FakeHost.connect(handle.port)
  first.ready()
  await settle()
  // 样例里 bt_1 归 cv_a1、bt_2 是用户页；从 cv_a1 看得见两页。
  expect(await handle.browser?.portFor('cv_a1').tabs()).toHaveLength(2)
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
        conversationId: null,
      },
    ],
  })
  await settle()
  const tabs = await handle.browser?.portFor('cv_a1').tabs()
  expect(tabs?.map((t) => t.tabId)).toEqual(['bt_9'])
})

test('旧纪元的结果不能完成新纪元的调用', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge')
  const pending = port?.open('http://127.0.0.1:1/page')
  const request = await host.next()
  expect(request.connectionEpoch).toBe(3)
  // 同一个 requestId，纪元对不上：这一帧属于上一条连接，不得完成本次调用。
  host.reply(request, { connectionEpoch: 2 })
  await settle()
  // 调用仍然待决——用断开来证明它没有被那一帧结掉。
  host.socket.close()
  expect((await failure(pending)).message).toMatch(/断开|重连/)
})

test('请求帧的线上形状与 Rust 侧共用同一份样例', async () => {
  const handle = fresh()
  const host = await FakeHost.connect(handle.port)
  host.ready()
  await settle()
  const port = handle.browser?.portFor('cv_bridge')
  const opening = port?.open('http://127.0.0.1:1/page')
  const create = await host.next()
  expect(create.type).toBe('browser.request')
  expect(create.op).toBe('create')
  expect(create.connectionEpoch).toBe(3)
  expect(create.url).toBe('http://127.0.0.1:1/page')
  expect(create.conversationId).toBe('cv_bridge')
  expect(create.deadline).toBeGreaterThan(Date.now())

  host.refuse(create, 'refused')
  expect((await failure(opening)).message).toBe('refused')

  const sample = samples().request as unknown as BrowserRequestFrame
  expect(Object.keys(sample).sort()).toEqual(
    [
      'connectionEpoch',
      'conversationId',
      'deadline',
      'op',
      'path',
      'requestId',
      'tabId',
      'type',
    ].sort(),
  )
})
