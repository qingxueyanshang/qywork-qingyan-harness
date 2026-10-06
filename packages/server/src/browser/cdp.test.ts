/**
 * 自有 CDP 客户端的发送通道、配对与取消语义。
 *
 * 覆盖范围：`cdp.ts` 全部（连接、按标记附加、方法白名单、迟到回包、本地拒绝、
 * teardown 白名单、已按下未释放的键表与鼠标按下状态、
 * 页会话初始化、跨站子会话的登记与就绪判定、按会话过滤的事件订阅、
 * 静默探针的登记与清理）。
 *
 * 对端是按脚本回帧的假调试端点：被测的是客户端的判定时机，即命令是否已发出、
 * 待决调用由谁结算；使用真实浏览器无法测出取消之后的命令是否已发出。
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

/** 假调试端点。`replies` 按方法给出结果，缺省返回空对象；`delays` 使指定方法晚于超时返回。 */
class FakeEndpoint {
  server: Bun.Server<undefined>
  received: Command[] = []
  replies = new Map<string, (cmd: Command) => Record<string, unknown> | { error: string }>()
  delays = new Map<string, number>()
  /** 已建立的连接，用于主动发送协议事件。 */
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
   * 未登记回帧的方法的默认应答。
   *
   * 页会话初始化需要取得帧树，缺少时初始化无法完成，因此该方法由端点默认应答，
   * 各用例无需重复编写。
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

  /** 主动发送一条协议事件，与真实端点在导航、加载时的行为一致。 */
  emit(sessionId: string, method: string, params: Record<string, unknown> = {}): void {
    this.socket?.send(JSON.stringify({ method, sessionId, params }))
  }

  stop(): void {
    this.server.stop(true)
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

/** 登记等待器使用的条件。 */
const GO = { selector: '#go', state: 'visible' }

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

/**
 * 启动一个能完成页会话初始化的端点。
 *
 * 两个 page target 的 URL 与标题完全相同，只有注入的标记不同，与真实情况一致：
 * 同 URL 的两个子视图在目标清单中无法区分。
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
      return { result: { value: { met: true, id: 7 } } }
    }
    return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
  })
  return endpoint
}

/**
 * 取得一次调用失败的原因。
 *
 * 不使用 `expect(...).rejects`：该断言在等待一个须由 WebSocket 响应帧才能结算的
 * Promise 时不会让出事件循环，响应帧因此永远无法到达，测试只会超时。
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

test('白名单之外的方法在发出之前即被拒绝，对端收不到任何帧', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'm1' })
  const client = await connect(endpoint)
  expect((await failure(client.send('Browser.setDownloadBehavior', {}))).message).toMatch(/白名单/)
  expect((await failure(client.send('Fetch.enable', {}))).message).toMatch(/白名单/)
  expect(endpoint.methods()).toEqual([])
  // 读取版本是 Browser 域中唯一放行的命令。
  expect(allowedMethod('Browser.getVersion')).toBe(true)
  await client.send('Browser.getVersion')
  expect(endpoint.methods()).toEqual(['Browser.getVersion'])
})

test('按标记识别页面：同 URL 的另一页被附加后立即 detach', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a', t2: 'marker-b' })
  const client = await connect(endpoint)
  const attached = await client.attachByMarker('marker-b')
  expect(attached.targetId).toBe('t2')
  expect(attached.sessionId).toBe('sess-t2')

  const detached = endpoint.received.filter((c) => c.method === 'Target.detachFromTarget')
  expect(detached.map((c) => c.params?.sessionId)).toEqual(['sess-t1'])
  // 页会话初始化按顺序执行完毕，其中包含焦点仿真。
  expect(endpoint.methods()).toContain('Emulation.setFocusEmulationEnabled')
  expect(endpoint.methods()).toContain('Target.setAutoAttach')
})

test('焦点仿真被拒绝时报告初始化失败，不换用其他命令重试', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.replies.set('Emulation.setFocusEmulationEnabled', () => ({
    error: 'not supported',
  }))
  const client = await connect(endpoint)
  expect(await failure(client.attachByMarker('marker-a'))).toBeInstanceOf(CdpInitError)
  const attempts = endpoint.methods().filter((m) => m === 'Emulation.setFocusEmulationEnabled')
  expect(attempts).toHaveLength(1)
})

test('超时由本地结算，之后到达的回包不会完成另一请求', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  endpoint.delays.set('Accessibility.getFullAXTree', 300)
  const client = await connect(endpoint)
  expect(
    await failure(client.send('Accessibility.getFullAXTree', {}, { timeoutMs: 60 })),
  ).toBeInstanceOf(CdpTimeoutError)
  // 迟到的帧到达时，下一条请求已在等待：它不能被该帧结算。
  expect(await client.send('Browser.getVersion', {}, { timeoutMs: 2_000 })).toBeDefined()
})

test('取消之后业务命令不发出，teardown 仍能发出', async () => {
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

test('取消时为已按下未释放的键补发一次 keyUp，按键表随之清空', async () => {
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

/** 发送一条按键事件。 */
function key(
  client: CdpClient,
  sessionId: string,
  type: 'keyDown' | 'keyUp',
  code: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return client.send(
    'Input.dispatchKeyEvent',
    { type, key: code.slice(-1).toLowerCase(), code, windowsVirtualKeyCode: 65 },
    { sessionId, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  )
}

test('抬起未收到回包时保留按下记录，收尾时补发一次，确认后才移除', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  await key(client, sessionId, 'keyDown', 'KeyA')
  endpoint.delays.set('Input.dispatchKeyEvent', 200)
  expect(await failure(key(client, sessionId, 'keyUp', 'KeyA', 30))).toBeInstanceOf(CdpTimeoutError)
  // 抬起可能未到达页面：保留记录，收尾时据此补发，回执中能报告该键。
  expect(client.heldKeys()).toEqual([`${sessionId}|KeyA`])

  endpoint.delays.delete('Input.dispatchKeyEvent')
  expect((await client.cancel()).keysReleased).toEqual([`${sessionId}|KeyA`])
  expect(client.heldKeys()).toEqual([])
  const ups = endpoint.received.filter(
    (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyUp',
  )
  expect(ups).toHaveLength(2)
})

test('按下被协议拒绝时移除记录，未收到回包的按下保留', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  endpoint.replies.set('Input.dispatchKeyEvent', (cmd) =>
    cmd.params?.code === 'KeyB' ? { error: 'Invalid parameters' } : {},
  )

  expect(await failure(key(client, sessionId, 'keyDown', 'KeyB'))).toBeInstanceOf(CdpError)
  expect(client.heldKeys()).toEqual([])

  endpoint.delays.set('Input.dispatchKeyEvent', 200)
  expect(await failure(key(client, sessionId, 'keyDown', 'KeyC', 30))).toBeInstanceOf(
    CdpTimeoutError,
  )
  expect(client.heldKeys()).toEqual([`${sessionId}|KeyC`])
})

test('旧抬起的回包不移除同一个键随后的按下', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  await key(client, sessionId, 'keyDown', 'KeyA')
  endpoint.delays.set('Input.dispatchKeyEvent', 40)
  // 抬起回包到达之前同一个键再次按下：页面上该键处于按下状态。
  await Promise.all([
    key(client, sessionId, 'keyUp', 'KeyA'),
    key(client, sessionId, 'keyDown', 'KeyA'),
  ])
  expect(client.heldKeys()).toEqual([`${sessionId}|KeyA`])
})

test('取消与动作收尾同时释放同一个键时只发送一次抬起', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  await key(client, sessionId, 'keyDown', 'KeyA')
  endpoint.delays.set('Input.dispatchKeyEvent', 40)
  const [settled, summary] = await Promise.all([client.releaseHeldKeys(), client.cancel()])
  expect(settled).toEqual([`${sessionId}|KeyA`])
  expect(summary.keysReleased).toEqual([`${sessionId}|KeyA`])
  const ups = endpoint.received.filter(
    (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyUp',
  )
  expect(ups).toHaveLength(1)
})

test('取消与断开都使 halted 置位，按住计时据此提前结束', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const cancelled = await connect(endpoint)
  expect(cancelled.halted.aborted).toBe(false)
  await cancelled.cancel()
  expect(cancelled.halted.aborted).toBe(true)

  const dropped = await connect(endpoint)
  endpoint.socket?.close()
  await settle()
  expect(dropped.halted.aborted).toBe(true)
})

test('等待器按 id 登记、等待结果、单独清理，计数可读取', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  const waiterId = await client.startWaiter(sessionId, GO, 5_000)
  expect(waiterId).toBe(7)
  expect(await client.awaitWaiter(sessionId, waiterId, 5_000)).toMatchObject({ met: true })
  expect(await client.disposeWaiter(sessionId, waiterId)).toEqual({
    waiters: 0,
    observers: 0,
    timers: 0,
  })

  // 页内脚本只观察：登记与清理均经由 Runtime.evaluate，不发送任何 Input 域命令。
  expect(endpoint.methods().filter((m) => m.startsWith('Input.'))).toEqual([])
})

test('根帧停止加载时清除附加会话时记录的导航中帧，之后按事件重新记录', async () => {
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
  // 附加会话时文档仍在加载：帧树中尚无文档的帧先视为导航中，该时段内没有事件可接收。
  expect([...client.settlingFrames(sessionId)]).toEqual(['kid-1'])

  // 根帧停止加载说明子树中进行中的导航均已结束，这些记录不能一直保留。
  endpoint.emit(sessionId, 'Page.frameStoppedLoading', { frameId: 'root-1' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual([])

  endpoint.emit(sessionId, 'Page.frameStartedLoading', { frameId: 'kid-2' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual(['kid-2'])
  // 跨站帧提交时切换渲染进程，以 detach 的形式离开父会话。
  endpoint.emit(sessionId, 'Page.frameDetached', { frameId: 'kid-2' })
  await settle()
  expect([...client.settlingFrames(sessionId)]).toEqual([])
})

test('等待器运行时不在当前文档中时先补注入再登记，不返回页内异常原文', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  let installed = false
  endpoint.replies.set('Runtime.evaluate', (cmd) => {
    const expression = String(cmd.params?.expression ?? '')
    if (expression === 'window.__qyworkTab') return { result: { value: 'marker-a' } }
    if (expression.startsWith('(() => {')) {
      installed = true
      return { result: { value: 'installed' } }
    }
    // 运行时不存在时页内抛出异常：`returnByValue` 下 result.value 缺失，另附 exceptionDetails。
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

  expect(await client.startWaiter(sessionId, GO, 5_000)).toBe(7)
  // 补发的是运行时注入，而不是重发登记：两次登记之间有一条注入命令。
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

test('补注入后回包仍不是对象时返回可判定的失败，不解引用 undefined', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')
  // 注入与登记均无法返回值：该页当前没有可用的等待器。
  endpoint.replies.set('Runtime.evaluate', () => ({ result: {} }))

  const err = await failure(client.startWaiter(sessionId, GO, 5_000))
  expect(err).toBeInstanceOf(CdpError)
  expect(err.message).toContain('页面尚未准备好等待器')
  const awaited = await failure(client.awaitWaiter(sessionId, 7, 5_000))
  expect(awaited.message).toContain('页面尚未准备好等待器')
})

test('会话事件按 sessionId 分发，取消订阅后不再收到任何事件', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  const { sessionId } = await client.attachByMarker('marker-a')

  const seen: string[] = []
  const off = client.onSessionEvent(sessionId, (event) => seen.push(event.method))
  expect(client.watchers()).toBe(1)
  endpoint.emit(sessionId, 'Page.frameStartedLoading', { frameId: 'f1' })
  // 另一个会话上的同名事件不进入本订阅：否则两页同时受控时会计入另一页的事件。
  endpoint.emit('sess-other', 'Page.frameNavigated', { frame: { id: 'f9' } })
  await settle()
  expect(seen).toEqual(['Page.frameStartedLoading'])

  off()
  expect(client.watchers()).toBe(0)
  endpoint.emit(sessionId, 'Page.loadEventFired')
  await settle()
  expect(seen).toEqual(['Page.frameStartedLoading'])
})

test('静默探针经由等待器注册表：读数原样返回，取消时随统一清理移除', async () => {
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
  // 读数原样返回，客户端不把页面的 loading 改为 complete。
  expect(await client.readProbe(sessionId, probe, 2_000)).toEqual({
    ready: 'loading',
    mutations: 4,
  })

  // 探针不在页内时无法读取字段，客户端按失效返回，不补充就绪的默认值。
  endpoint.replies.set('Runtime.evaluate', () => ({ result: {} }))
  expect(await client.readProbe(sessionId, probe, 2_000)).toEqual({ gone: true })

  const before = endpoint.received.length
  await client.cancel()
  const disposals = endpoint.received
    .slice(before)
    .filter((c) => String(c.params?.expression ?? '').includes('__qyworkDisposeAll'))
  expect(disposals).toHaveLength(1)
  // 取消之后无法创建新探针：它是业务命令，而非 teardown。
  expect(await failure(client.startProbe(sessionId, 2_000))).toBeInstanceOf(CdpCancelledError)
})

test('子会话启用域之后才就绪：登记之后、启用域的回包到达之前不进入 childSessionsOf', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  // 子会话的启用域命令延迟返回：此期间它无法返回 AX 树，交给采集只会得到空帧。
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

test('子会话启用域失败时不进入 childSessionsOf，也不被视为不存在的帧', async () => {
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
  // 登记仍保留，取消时该会话仍须 detach，不能按该帧不存在处理。
  const { detached } = await client.cancel()
  expect(detached).toContain('child-1')
})

test('重复取消为空操作，不再发送第二轮清理', async () => {
  const endpoint = endpointWithTwoPages({ t1: 'marker-a' })
  const client = await connect(endpoint)
  await client.attachByMarker('marker-a')
  await client.cancel()
  const after = endpoint.received.length
  const again = await client.cancel()
  expect(again.detached).toEqual([])
  expect(endpoint.received).toHaveLength(after)
})

test('连接断开时待决调用由本客户端拒绝，不等待远端返回', async () => {
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

test('取消时为按下未释放的鼠标补发一次 mouseReleased，坐标取最后移动到的位置', async () => {
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
  // 在按下的位置抬起会使拖动回到原处，收尾使用最后移动到的位置。
  expect(ups[0]?.params).toMatchObject({ x: 90, y: 80, button: 'left', buttons: 0 })
})

test('正常抬起与关闭页面都会清除鼠标按下状态，收尾时不再补发第二条', async () => {
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

  // 页面关闭后该会话在远端已不存在，补发抬起只会逐条报错。
  await press()
  client.forgetSession(sessionId)
  expect(client.heldMouse()).toEqual([])
  expect((await client.cancel()).mouseReleased).toEqual([])
})
