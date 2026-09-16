/**
 * 自写 CDP 客户端的发送口、配对与取消语义。
 *
 * 覆盖范围：`cdp.ts` 全部（连接、按标记附加、方法白名单、迟到回包、本地拒绝、
 * teardown 白名单、已按下未释放的键表、页会话初始化、按会话过滤的事件订阅、
 * 静默探针的登记与清理）。
 *
 * 对端是一个按脚本回帧的假调试端点：被测的是客户端的判定时机——命令**有没有入网**、
 * 待决调用**由谁结掉**，拿真浏览器测不出「取消之后那一条命令有没有入网」。
 */

import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  allowedMethod,
  CdpCancelledError,
  CdpClient,
  CdpInitError,
  CdpTimeoutError,
} from './cdp.ts'

interface Command {
  id: number
  method: string
  sessionId?: string
  params?: Record<string, unknown>
}

/** 假调试端点。`replies` 按方法给结果，缺省回空对象；`delays` 让某个方法回得比超时晚。 */
class FakeEndpoint {
  server: Bun.Server<undefined>
  received: Command[] = []
  replies = new Map<string, (cmd: Command) => Record<string, unknown> | { error: string }>()
  delays = new Map<string, number>()
  /** 已连上的那条连接。主动发协议事件用它。 */
  socket: ServerWebSocket<undefined> | null = null

  constructor() {
    const self = this
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === '/json/version') {
          return Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
          })
        }
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open(ws: ServerWebSocket<undefined>) {
          self.socket = ws
        },
        message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
          const cmd = JSON.parse(String(raw)) as Command
          self.received.push(cmd)
          const send = () => {
            const make = self.replies.get(cmd.method)
            const out = make ? make(cmd) : {}
            const body =
              'error' in out && typeof out.error === 'string'
                ? { id: cmd.id, error: { code: -32000, message: out.error } }
                : { id: cmd.id, result: out }
            ws.send(JSON.stringify(body))
          }
          const delay = self.delays.get(cmd.method)
          if (delay) setTimeout(send, delay)
          else send()
        },
      },
    })
  }

  methods(): string[] {
    return this.received.map((c) => c.method)
  }

  /** 主动发一条协议事件。真端点在导航、加载时这么发。 */
  emit(sessionId: string, method: string, params: Record<string, unknown> = {}): void {
    this.socket?.send(JSON.stringify({ method, sessionId, params }))
  }

  stop(): void {
    this.server.stop(true)
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

/**
 * 起一个能走完页会话初始化的端点。
 *
 * 两个 page target 的 URL 与标题完全相同，只有注入的标记不同——这正是真实形态：
 * 同 URL 的两个子视图在目标清单里分不出来。
 */
function endpointWithTwoPages(markers: Record<string, string>): FakeEndpoint {
  const endpoint = new FakeEndpoint()
  cleanups.push(() => endpoint.stop())
  endpoint.replies.set('Target.getTargets', () => ({
    targetInfos: Object.keys(markers).map((targetId) => ({
      targetId,
      type: 'page',
      url: 'http://127.0.0.1:1/page',
      title: '同一个标题',
    })),
  }))
  endpoint.replies.set('Target.attachToTarget', (cmd) => ({
    sessionId: `sess-${String(cmd.params?.targetId)}`,
  }))
  endpoint.replies.set('Runtime.evaluate', (cmd) => {
    const expression = String(cmd.params?.expression ?? '')
    if (expression === 'window.__qyworkTab') {
      const targetId = String(cmd.sessionId).replace('sess-', '')
      return { result: { value: markers[targetId] } }
    }
    if (expression.startsWith('window.__qyworkWait(')) {
      return { result: { value: { id: 7, immediate: false } } }
    }
    if (expression.startsWith('window.__qyworkAwait(')) {
      return { result: { value: { found: true, id: 7, x: 10, y: 20 } } }
    }
    return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
  })
  return endpoint
}

/**
 * 取一次失败的原因。
 *
 * 不用 `expect(...).rejects`：那个断言在等一条要靠 WebSocket 回包才结得掉的
 * Promise 时不会让出事件循环，回包因此永远到不了，测试只会撞超时。
 */
async function failure(pending: Promise<unknown>): Promise<Error> {
  const settled = Symbol('resolved')
  const out = await pending.then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('这条调用本应失败')
  return out as Error
}

async function connect(endpoint: FakeEndpoint): Promise<CdpClient> {
  const client = await CdpClient.connect(endpoint.server.port ?? 0)
  cleanups.push(() => client.close())
  return client
}

test('白名单之外的方法在入网之前就被拒，对端一帧都收不到', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'm1' })
  const client = await connect(endpoint)
  expect((await failure(client.send('Browser.setDownloadBehavior', {}))).message).toMatch(/白名单/)
  expect((await failure(client.send('Fetch.enable', {}))).message).toMatch(/白名单/)
  expect(endpoint.methods()).toEqual([])
  // 版本读取是 Browser 域里唯一放行的那一条。
  expect(allowedMethod('Browser.getVersion')).toBe(true)
  await client.send('Browser.getVersion')
  expect(endpoint.methods()).toEqual(['Browser.getVersion'])
})

test('按标记认页：同 URL 的另一页被附加后立刻 detach', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a', t2: 'marker-b' })
  const client = await connect(endpoint)
  const attached = await client.attachByMarker('marker-b')
  expect(attached.targetId).toBe('t2')
  expect(attached.sessionId).toBe('sess-t2')

  const detached = endpoint.received.filter((c) => c.method === 'Target.detachFromTarget')
  expect(detached.map((c) => c.params?.sessionId)).toEqual(['sess-t1'])
  // 页会话初始化按顺序走完，焦点仿真在其中。
  expect(endpoint.methods()).toContain('Emulation.setFocusEmulationEnabled')
  expect(endpoint.methods()).toContain('Target.setAutoAttach')
})

test('焦点仿真被拒即报初始化失败，不换命令重试', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.replies.set('Emulation.setFocusEmulationEnabled', () => ({
    error: 'not supported',
  }))
  const client = await connect(endpoint)
  expect(await failure(client.attachByMarker('marker-a'))).toBeInstanceOf(CdpInitError)
  const attempts = endpoint.methods().filter((m) => m === 'Emulation.setFocusEmulationEnabled')
  expect(attempts).toHaveLength(1)
})

test('超时由本地结掉，之后到的回包不会完成另一请求', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.delays.set('Accessibility.getFullAXTree', 300)
  const client = await connect(endpoint)
  expect(
    await failure(client.send('Accessibility.getFullAXTree', {}, { timeoutMs: 60 })),
  ).toBeInstanceOf(CdpTimeoutError)
  // 迟到的那一帧到达时，下一条请求已经在等：它不能被那一帧结掉。
  expect(await client.send('Browser.getVersion', {}, { timeoutMs: 2_000 })).toBeDefined()
})

test('取消之后业务命令不入网，teardown 仍能发出', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  const before = endpoint.received.length

  await client.cancel('测试取消')
  const after = endpoint.received.slice(before)
  // 取消期间发出的只有 teardown：dispose、detach，没有业务命令。
  expect(after.map((c) => c.method)).toEqual(['Runtime.evaluate', 'Target.detachFromTarget'])
  expect(client.cancelled).toBe(true)

  const blocked = endpoint.received.length
  expect(
    await failure(client.send('Input.dispatchMouseEvent', { type: 'mousePressed' }, { sessionId })),
  ).toBeInstanceOf(CdpCancelledError)
  expect(endpoint.received).toHaveLength(blocked)
})

test('取消把已按下未释放的键补一次 keyUp，按键表随之清空', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  await client.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
    { sessionId },
  )
  expect(client.heldKeys()).toEqual([`${sessionId}|KeyA`])

  const summary = await client.cancel()
  expect(summary.keysReleased).toEqual([`${sessionId}|KeyA`])
  expect(client.heldKeys()).toEqual([])
  const keyUps = endpoint.received.filter(
    (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyUp',
  )
  expect(keyUps).toHaveLength(1)
  expect(keyUps[0]?.params?.code).toBe('KeyA')
})

test('等待器按 id 登记、等结果、单独清掉，计数读得回来', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  const waiterId = await client.startWaiter(sessionId, '#go', 5_000)
  expect(waiterId).toBe(7)
  expect(await client.awaitWaiter(sessionId, waiterId, 5_000)).toMatchObject({ found: true })
  expect(await client.disposeWaiter(sessionId, waiterId)).toEqual({
    waiters: 0,
    observers: 0,
    timers: 0,
  })

  // 页内脚本只观察：登记与清理都走 Runtime.evaluate，没有一条 Input 域命令。
  expect(endpoint.methods().filter((m) => m.startsWith('Input.'))).toEqual([])
})

test('会话事件按 sessionId 分发，取消订阅之后一条都不再收到', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  const seen: string[] = []
  const off = client.onSessionEvent(sessionId, (event) => seen.push(event.method))
  expect(client.watchers()).toBe(1)
  endpoint.emit(sessionId, 'Page.frameStartedLoading', { frameId: 'f1' })
  // 另一个会话上的同名事件不进这一份订阅：两页同时受控时它会把别的页算进来。
  endpoint.emit('sess-other', 'Page.frameNavigated', { frame: { id: 'f9' } })
  await settle()
  expect(seen).toEqual(['Page.frameStartedLoading'])

  off()
  expect(client.watchers()).toBe(0)
  endpoint.emit(sessionId, 'Page.loadEventFired')
  await settle()
  expect(seen).toEqual(['Page.frameStartedLoading'])
})

test('静默探针走等待器注册表：读数原样给出，取消时随统一清理清掉', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.replies.set('Runtime.evaluate', (cmd) => {
    const expression = String(cmd.params?.expression ?? '')
    if (expression === 'window.__qyworkTab') return { result: { value: 'marker-a' } }
    if (expression.includes('__qyworkProbeRead')) {
      return { result: { value: { ready: 'loading', mutations: 4 } } }
    }
    if (expression.includes('__qyworkProbe(')) return { result: { value: { id: 3 } } }
    return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
  })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  const probe = await client.startProbe(sessionId, 2_000)
  expect(probe).toBe(3)
  // 读数原样上交，客户端不替页面把 loading 改成 complete。
  expect(await client.readProbe(sessionId, probe, 2_000)).toEqual({
    ready: 'loading',
    mutations: 4,
  })

  // 探针不在页内时读不出字段，客户端按失效给出，不补一个就绪的默认值。
  endpoint.replies.set('Runtime.evaluate', () => ({ result: {} }))
  expect(await client.readProbe(sessionId, probe, 2_000)).toEqual({ gone: true })

  const before = endpoint.received.length
  await client.cancel()
  const disposals = endpoint.received
    .slice(before)
    .filter((c) => String(c.params?.expression ?? '').includes('__qyworkDisposeAll'))
  expect(disposals).toHaveLength(1)
  // 取消之后开不出新探针：它是业务命令，不是 teardown。
  expect(await failure(client.startProbe(sessionId, 2_000))).toBeInstanceOf(CdpCancelledError)
})

test('重复取消是空操作，不再发第二轮清理', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  await client.attachByMarker('marker-a')
  await client.cancel()
  const after = endpoint.received.length
  const again = await client.cancel()
  expect(again.detached).toEqual([])
  expect(endpoint.received).toHaveLength(after)
})

test('连接断开时待决调用由本客户端拒绝，不等远端返回', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.delays.set('Accessibility.getFullAXTree', 5_000)
  const client = await connect(endpoint)
  const pending = client.send('Accessibility.getFullAXTree', {}, { timeoutMs: 30_000 })
  client.close()
  expect((await failure(pending)).message).toMatch(/断开/)
})
