/**
 * 自写 CDP 客户端的发送口、配对与取消语义。
 *
 * 覆盖范围：`cdp.ts` 全部（连接、按标记附加、方法白名单、迟到回包、本地拒绝、
 * teardown 白名单、已按下未释放的键表与鼠标按下状态、
 * 页会话初始化、跨站子会话的登记与就绪判定、按会话过滤的事件订阅、
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
  CdpError,
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
            const out = make ? make(cmd) : self.fallback(cmd)
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

  /**
   * 没登记回帧的方法怎么答。
   *
   * 页会话初始化要取帧树，缺了它初始化整条走不下去，所以这一条由端点默认答出来，
   * 每个用例不必各写一遍。
   */
  fallback(cmd: Command): Record<string, unknown> {
    if (cmd.method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: `frame-${cmd.sessionId ?? 'main'}` } } }
    }
    return {}
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

test('根帧停止加载即清掉附上会话那一刻记下的在飞帧，之后按事件重新记', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.replies.set('Page.getFrameTree', () => ({
    frameTree: {
      frame: { id: 'root-1', url: 'http://127.0.0.1:1/page' },
      childFrames: [{ frame: { id: 'kid-1', url: '' } }],
    },
  }))
  endpoint.replies.set('Runtime.evaluate', (cmd) => {
    const expression = String(cmd.params?.expression ?? '')
    if (expression === 'window.__qyworkTab') return { result: { value: 'marker-a' } }
    if (expression === 'document.readyState') return { result: { value: 'loading' } }
    return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
  })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  // 附上会话时文档还在加载：帧树里尚无文档的帧先当成在导航，那一段没有事件可收。
  expect([...client.settlingFrames(sessionId)]).toEqual(['kid-1'])

  // 根帧停下来说明子树里在飞的导航都已结束，这批不能一直留着。
  endpoint.emit(sessionId, 'Page.frameStoppedLoading', { frameId: 'root-1' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual([])

  endpoint.emit(sessionId, 'Page.frameStartedLoading', { frameId: 'kid-2' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual(['kid-2'])
  // 跨站帧提交时换渲染进程，以 detach 的形式离开父会话。
  endpoint.emit(sessionId, 'Page.frameDetached', { frameId: 'kid-2' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual([])
})

test('等待器运行时不在当前文档时先补注入再登记，不把页内异常原文交出去', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  let installed = false
  endpoint.replies.set('Runtime.evaluate', (cmd) => {
    const expression = String(cmd.params?.expression ?? '')
    if (expression === 'window.__qyworkTab') return { result: { value: 'marker-a' } }
    if (expression.startsWith('(() => {')) {
      installed = true
      return { result: { value: 'installed' } }
    }
    // 运行时不在时页内抛异常：`returnByValue` 下 result.value 缺席，另带 exceptionDetails。
    if (expression.startsWith('window.__qyworkWait(') && !installed) {
      return { result: {}, exceptionDetails: { text: 'Uncaught' } }
    }
    if (expression.startsWith('window.__qyworkWait(')) {
      return { result: { value: { id: 7, immediate: false } } }
    }
    return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
  })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  installed = false

  expect(await client.startWaiter(sessionId, '#go', 5_000)).toBe(7)
  // 补的是运行时注入，不是把登记重发一遍：两次登记之间隔着一条注入。
  const evaluated = endpoint.received
    .filter((c) => c.method === 'Runtime.evaluate')
    .map((c) => String(c.params?.expression ?? ''))
  const first = evaluated.findIndex((e) => e.startsWith('window.__qyworkWait('))
  const inject = evaluated.findIndex((e, i) => i > first && e.startsWith('(() => {'))
  expect(inject).toBeGreaterThan(first)
  expect(
    evaluated.findIndex((e, i) => i > inject && e.startsWith('window.__qyworkWait(')),
  ).toBeGreaterThan(inject)
})

test('补注入之后回包仍不是对象时给可判定的失败，不解引用 undefined', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  // 注入与登记都答不出值：这一页此刻没有等待器可用。
  endpoint.replies.set('Runtime.evaluate', () => ({ result: {} }))

  const err = await failure(client.startWaiter(sessionId, '#go', 5_000))
  expect(err).toBeInstanceOf(CdpError)
  expect(err.message).toContain('页面还没准备好等待器')
  const awaited = await failure(client.awaitWaiter(sessionId, 7, 5_000))
  expect(awaited.message).toContain('页面还没准备好等待器')
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

test('子会话开完域才算数：登记之后、开域回包之前不进 childSessionsOf', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  // 子会话的开域命令晚回：这一段里它答不出 AX 树，交给采集只会得到一个空帧。
  endpoint.delays.set('Accessibility.enable', 200)
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  endpoint.emit(sessionId, 'Target.attachedToTarget', {
    sessionId: 'child-1',
    targetInfo: { targetId: 'frame-a', type: 'iframe' },
  })
  await settle()
  expect(client.childSessionsOf(sessionId)).toEqual([])
  await new Promise((r) => setTimeout(r, 300))
  expect(client.childSessionsOf(sessionId)).toEqual([{ sessionId: 'child-1', targetId: 'frame-a' }])
})

test('子会话开域失败时它不进 childSessionsOf，也不被当成不存在的帧', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.replies.set('DOM.enable', (cmd) =>
    cmd.sessionId === 'child-1' ? { error: 'No session with given id' } : {},
  )
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  endpoint.emit(sessionId, 'Target.attachedToTarget', {
    sessionId: 'child-1',
    targetInfo: { targetId: 'frame-a', type: 'iframe' },
  })
  await settle()
  expect(client.childSessionsOf(sessionId)).toEqual([])
  // 登记还在，取消时这条会话照样要 detach——不是「没有这一帧」。
  const { detached } = await client.cancel()
  expect(detached).toContain('child-1')
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

test('断连事件通知控制层，断连后注册也立即通知', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  expect(client.connected).toBe(true)
  const closed = new Promise<void>((resolve) => client.onDisconnect(resolve))
  endpoint.socket?.close()
  await closed
  expect(client.connected).toBe(false)
  await new Promise<void>((resolve) => client.onDisconnect(resolve))
  const err = await failure(client.send('Target.getTargets'))
  expect(err).toMatchObject({ errorKind: 'browser_disconnected' })
  expect(err.message).toContain('browser_observe')
  expect(endpoint.methods()).toEqual([])
})

test('取消把按下未释放的鼠标补一次 mouseReleased，坐标取最后移动到的位置', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
    { sessionId },
  )
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: 90, y: 80, button: 'left', buttons: 1 },
    { sessionId },
  )
  expect(client.heldMouse()).toEqual([`${sessionId}|left`])

  const summary = await client.cancel()
  expect(summary.mouseReleased).toEqual([`${sessionId}|left`])
  expect(client.heldMouse()).toEqual([])
  const ups = endpoint.received.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseReleased',
  )
  expect(ups).toHaveLength(1)
  // 在按下的位置抬起会让拖动落回原处，收尾用的是最后移动到的那个点。
  expect(ups[0]?.params).toMatchObject({ x: 90, y: 80, button: 'left', buttons: 0 })
})

test('正常抬起与关页都摘掉鼠标按下状态，收尾时不再补第二条', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  const press = () =>
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 },
      { sessionId },
    )

  await press()
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: 5, y: 5, button: 'left', buttons: 0, clickCount: 1 },
    { sessionId },
  )
  expect(client.heldMouse()).toEqual([])

  // 页被关掉之后这个会话在远端已经不存在，补抬起只会逐条报错。
  await press()
  client.forgetSession(sessionId)
  expect(client.heldMouse()).toEqual([])
  expect((await client.cancel()).mouseReleased).toEqual([])
})
