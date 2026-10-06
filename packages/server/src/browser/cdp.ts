/**
 * 自有的 CDP 客户端：通过一条 Bun 原生 `WebSocket` 直接收发协议消息，不经由第三方驱动。
 *
 * 四条不变量：
 *
 * 1. 待决请求由本客户端拒绝。断开、超时、取消均在本地结束 pending，
 *    不依赖远端返回或 detach 结束 pending；按 id 查不到待决项的迟到回包直接丢弃，
 *    不得完成另一请求。
 * 2. 取消之后发送通道只放行 teardown。清理命令（detach、等待器 dispose、收尾 keyUp 与
 *    mouseReleased）必须能够发出，否则页面保持按下状态，人工接管后输入行为异常。
 * 3. 方法集为白名单。不对上层暴露任意方法调用，`Browser` 域只放行 `getVersion`。
 * 4. 等待只观察，不执行动作。页内等待器使用 `MutationObserver` 加定时复核，
 *    不使用 `requestAnimationFrame`：子视图移出可视区时不再产生帧，依赖帧驱动的轮询会停滞。
 */

import { log } from '@qywork/core'

/** 允许发出的域。增加一个域即扩大模型可访问的协议范围，须单独评估。 */
const ALLOWED_DOMAINS = new Set([
  'Target',
  'Page',
  'Runtime',
  'DOM',
  'Input',
  'Accessibility',
  'Emulation',
])

/** `Browser` 域只用于读取版本，下载行为一律经由宿主的原生钩子。 */
const ALLOWED_BROWSER_METHODS = new Set(['Browser.getVersion'])

/**
 * 取消之后仍允许发出的命令。
 *
 * 该规则必须实现为白名单，不能只写在文档中：取消关闭发送通道后，
 * 按业务路径补发的 keyUp 会被取消状态拦截，页面因此保持按下状态。鼠标同理。
 */
const TEARDOWN_TAGS = new Set(['detach', 'dispose', 'keyup', 'mouseup'])

export type TeardownTag = 'detach' | 'dispose' | 'keyup' | 'mouseup'

export class CdpError extends Error {}
export class CdpCancelledError extends CdpError {}
export class CdpTimeoutError extends CdpError {}
export class CdpDisconnectedError extends CdpError {
  readonly errorKind = 'browser_disconnected' as const

  constructor(readonly detail: string) {
    super(
      `${detail}。浏览器控制连接不可用，页面可能仍正常显示；` +
        '已发出的操作结果可能不明，不要直接重复点击、输入或提交。' +
        '先对原 tabId 调用 browser_observe，重新连接并核对页面；再次失败时停止重复调用并报告。',
    )
  }
}
/** 会话初始化命令被拒绝。调用方必须撤销控制，不换用其他命令重试。 */
export class CdpInitError extends CdpError {}

export interface SendOptions {
  sessionId?: string
  timeoutMs?: number
  /** 携带时按 teardown 发送；取消之后只有此类命令仍能发出。 */
  teardown?: TeardownTag
}

interface Pending {
  method: string
  /** 收尾命令。取消时照常等待回包，只有断连时才结算。 */
  teardown: boolean
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** `Page.getFrameTree` 的一层。`url` 为空表示该帧尚未提交任何文档。 */
interface FrameTreeNode {
  frame: { id: string; url?: string }
  childFrames?: FrameTreeNode[]
}

/** 未跟踪帧导航状态的会话返回该集合。调用方只读，不得写入。 */
const NO_FRAMES: ReadonlySet<string> = new Set()

interface CdpMessage {
  id?: number
  method?: string
  sessionId?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

export interface WaiterStats {
  waiters: number
  observers: number
  timers: number
}

/**
 * 一次静默探针读数。
 *
 * 三个字段都可能缺失，缺失即探针无效。调用方不得把缺失视为文档已就绪：
 * 否则仍在加载的页面会提前通过静默判定。
 */
export interface ProbeRead {
  /** `document.readyState`。 */
  ready?: string
  /** 探针建立以来的 DOM 变更条数。 */
  mutations?: number
  /** 该探针已不在当前文档中：文档已更换，或探针已被清理。 */
  gone?: boolean
}

/** 一条协议事件。订阅方按 `method` 分派，`params` 原样给出。 */
export interface CdpEvent {
  method: string
  params: Record<string, unknown>
}

export interface CancelSummary {
  rejectedPending: number
  waiterStats: WaiterStats[]
  keysReleased: string[]
  /** 补发过 `mouseReleased` 的按下状态，形如 `会话|按键`。 */
  mouseReleased: string[]
  detached: string[]
}

/**
 * 页内等待器与静默探针。只用 `querySelector` 观察、只统计 DOM 变更，不点击、不提交、不输入。
 *
 * 注册表挂载在 `window` 上，因此可按 id 单独清理，并读取 observer 与 timer
 * 的计数作为清理证据。探针必须经由该注册表创建：另行注册观察器时，取消与断连时
 * 的清理路径无法找到它，它会在文档存续期间持续观察。
 *
 * 等待器按状态判定选择器命中的第一个元素，状态的含义见 `BrowserWaitState`。除 DOM 变更外
 * 每 100 ms 复核一次：CSS 过渡、动画与布局变化不产生 DOM 变更，只依赖观察器会遗漏可见性变化。
 */
const WAITER_RUNTIME = `(() => {
  if (window.__qyworkWaiters) return 'already'
  window.__qyworkWaiters = new Map()
  window.__qyworkSeq = 0
  window.__qyworkLive = { observers: 0, timers: 0 }
  const make = () => {
    let settle
    const rec = { id: ++window.__qyworkSeq, done: false, obs: null, timer: null, poll: null, mutations: 0 }
    rec.promise = new Promise((r) => { settle = r })
    rec.finish = (result) => {
      if (rec.done) return
      rec.done = true
      if (rec.obs) { rec.obs.disconnect(); rec.obs = null; window.__qyworkLive.observers-- }
      if (rec.timer !== null) { clearTimeout(rec.timer); rec.timer = null; window.__qyworkLive.timers-- }
      if (rec.poll !== null) { clearInterval(rec.poll); rec.poll = null; window.__qyworkLive.timers-- }
      settle(result)
    }
    window.__qyworkWaiters.set(rec.id, rec)
    return rec
  }
  const watch = (rec, fn) => {
    rec.obs = new MutationObserver(fn)
    window.__qyworkLive.observers++
    rec.obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  }
  const visible = (el) => {
    if (!el.isConnected) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    return el.checkVisibility({ visibilityProperty: true })
  }
  const states = {
    attached: (el) => el !== null,
    visible: (el) => el !== null && visible(el),
    hidden: (el) => el === null || !visible(el),
    enabled: (el) => el !== null && visible(el) && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true',
    text: (el, want) => el !== null && (el.textContent || '').replace(/\\s+/g, ' ').trim() === want,
    value: (el, want) => el !== null && 'value' in el && String(el.value) === want,
  }
  window.__qyworkWait = (selector, timeoutMs, state, expected) => {
    const rec = make()
    const id = rec.id
    const test = states[state]
    const check = () => {
      if (!test(document.querySelector(selector), expected)) return false
      rec.finish({ met: true, id })
      return true
    }
    if (check()) return { id, immediate: true }
    watch(rec, () => { check() })
    rec.timer = setTimeout(() => rec.finish({ met: false, reason: 'timeout', id }), timeoutMs)
    window.__qyworkLive.timers++
    rec.poll = setInterval(check, 100)
    window.__qyworkLive.timers++
    return { id, immediate: false }
  }
  window.__qyworkProbe = () => {
    const rec = make()
    watch(rec, (records) => { rec.mutations += records.length })
    return { id: rec.id }
  }
  window.__qyworkProbeRead = (id) => {
    const rec = window.__qyworkWaiters.get(id)
    if (!rec || rec.done) return { gone: true }
    return { ready: document.readyState, mutations: rec.mutations }
  }
  window.__qyworkAwait = (id) => {
    const rec = window.__qyworkWaiters.get(id)
    return rec ? rec.promise : Promise.resolve({ met: false, reason: 'gone', id })
  }
  window.__qyworkDispose = (id) => {
    const rec = window.__qyworkWaiters.get(id)
    if (rec) rec.finish({ met: false, reason: 'cancelled', id })
    window.__qyworkWaiters.delete(id)
    return window.__qyworkStats()
  }
  window.__qyworkDisposeAll = () => {
    for (const id of Array.from(window.__qyworkWaiters.keys())) window.__qyworkDispose(id)
    return window.__qyworkStats()
  }
  window.__qyworkStats = () => ({
    waiters: window.__qyworkWaiters.size,
    observers: window.__qyworkLive.observers,
    timers: window.__qyworkLive.timers,
  })
  return 'installed'
})()`

export class CdpClient {
  #socket: WebSocket
  #seq = 0
  #pending = new Map<number, Pending>()
  #pageSessions = new Set<string>()
  /**
   * 跨站 iframe 的子会话。
   *
   * 按父会话记录子会话，而不是使用一张平表：观察须按页取得该页自身的帧，
   * 平表在同时控制多页时会把其他页的帧计入。
   *
   * `ready` 表示 `#initChildSession` 已经执行完毕。登记发生在 `Target.attachedToTarget`
   * 到达时，启用域是随后的异步命令，两者之间该会话无法返回 AX 树。
   */
  #childSessions = new Map<string, { parent: string; targetId: string; ready: boolean }>()
  /**
   * 每个会话的根帧编号，以及其文档树中当前有导航进行中的帧。
   *
   * 观察需要判定的是等待后该帧是否会有内容，而 DOM 快照无法回答：
   * `loading="lazy"` 尚未触发的帧与正在导航的帧，在快照中都是 `about:blank`
   * 空文档。按快照内容判定时，页面上所有延迟加载的帧每次观察都会被计为未就位。
   *
   * 加入与移除依据浏览器报告的事件：`Page.frameStartedLoading` 加入，`frameStoppedLoading` 与
   * `frameDetached` 移除；跨站帧提交时切换渲染进程，以 detach 的形式离开父会话。
   */
  #frameLoads = new Map<string, { root: string; loading: Set<string> }>()
  /**
   * 本客户端按下、尚未确认抬起的键，键为 `会话|code`。取消与收尾据此补发 keyUp。
   *
   * 按下在发出前登记，抬起在收到回包之后才移除：超时、断连时抬起可能未到达页面，
   * 提前移除会失去补发依据，也无法报告哪个键可能仍处于按下状态。移除前核对条目身份，
   * 同一个键在抬起回包之前再次按下时，旧回包不移除新条目。
   */
  #heldKeys = new Map<string, Held<{ params: Record<string, unknown> }>>()
  /**
   * 本客户端按下、尚未确认抬起的鼠标键，连同最后一次移动到的坐标。登记与移除规则同 `#heldKeys`。
   *
   * 只记录本客户端发出的按下：收尾时据此补发 `mouseReleased`，不对其他会话或用户
   * 桌面释放输入。不依赖成功路径最后的 `mouseReleased`：拖动中途失败时它无法发出。
   */
  #heldMouse = new Map<string, Held<{ button: string; x: number; y: number }>>()
  /** 取消或断开时触发。输入执行器的计时等待据此提前结束，不等待完整的按住时长。 */
  #halt = new AbortController()
  /** 短期事件订阅。每一项只服务一次调用，由建立方在结束时移除。 */
  #watchers = new Set<{ sessionId: string; listener: (event: CdpEvent) => void }>()
  #businessClosed = false
  #cancelled = false

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.onmessage = (ev) => this.#onMessage(String(ev.data))
    socket.onclose = () => {
      this.#halt.abort()
      this.#failPending(new CdpDisconnectedError('CDP 连接已断开'))
    }
    socket.onerror = () => {}
  }

  /** 连接宿主分配的回环端点。端点在第一个子视图创建之后才开始监听。 */
  static async connect(debugPort: number, timeoutMs = 10_000): Promise<CdpClient> {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`调试端点返回 HTTP ${res.status}`)
      const version = (await res.json()) as { webSocketDebuggerUrl?: string }
      const url = version.webSocketDebuggerUrl
      if (!url) throw new Error('调试端点未返回 WebSocket 地址')
      const socket = new WebSocket(url)
      await new Promise<void>((resolve, reject) => {
        const fail = (detail: string) => {
          clearTimeout(timer)
          reject(new Error(detail))
          socket.close()
        }
        const timer = setTimeout(() => fail('CDP 连接超时'), timeoutMs)
        socket.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        socket.onerror = () => fail('CDP 连接失败')
        socket.onclose = () => fail('CDP 握手期间连接已断开')
      })
      return new CdpClient(socket)
    } catch (err) {
      throw new CdpDisconnectedError(
        `控制连接建立失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  get connected(): boolean {
    return this.#socket.readyState === WebSocket.OPEN
  }

  /** 断连通知交给控制槽统一收尾；注册前已断开的连接立即通知。 */
  onDisconnect(listener: () => void): void {
    if (!this.connected) listener()
    else this.#socket.addEventListener('close', listener, { once: true })
  }

  get cancelled(): boolean {
    return this.#cancelled
  }

  /** 取消或连接断开时置位。此后业务命令一律无法发出。 */
  get halted(): AbortSignal {
    return this.#halt.signal
  }

  /**
   * 发送一条命令。
   *
   * 白名单、取消状态、连接状态三项在发出之前判定：在回包一侧判定时，
   * 取消之后的命令已经送达网站。
   */
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: SendOptions = {},
  ): Promise<T> {
    const teardown = options.teardown
    if (!allowedMethod(method)) {
      return Promise.reject(new CdpError(`方法不在白名单内：${method}`))
    }
    if (teardown && !TEARDOWN_TAGS.has(teardown)) {
      return Promise.reject(new CdpError(`无法识别的 teardown 标记：${teardown}`))
    }
    if (!teardown && this.#businessClosed) {
      return Promise.reject(new CdpCancelledError(`发送通道已关闭，拒绝 ${method}`))
    }
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpDisconnectedError(`连接不可用，拒绝 ${method}`))
    }
    const timeoutMs = options.timeoutMs ?? 15_000
    this.#seq += 1
    const id = this.#seq
    const settle =
      method === 'Input.dispatchKeyEvent'
        ? this.#trackKey(options.sessionId, params)
        : method === 'Input.dispatchMouseEvent'
          ? this.#trackMouse(options.sessionId, params)
          : null
    const sent = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new CdpTimeoutError(`${method} 超过 ${timeoutMs}ms 未返回`))
      }, timeoutMs)
      this.#pending.set(id, {
        method,
        teardown: teardown !== undefined,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
      })
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        }),
      )
    })
    // 先于调用方的 await 注册：调用方取得回包时，按键记录已处于确认后的状态。
    if (settle) {
      sent.then(
        () => settle('applied'),
        (err: unknown) => settle(unconfirmed(err) ? 'unknown' : 'rejected'),
      )
    }
    return sent
  }

  /**
   * 按宿主注入的标记找到目标页并附加。
   *
   * 不按 URL 或标题匹配：两个同 URL 的子视图在目标清单中完全相同。
   */
  async attachByMarker(marker: string): Promise<{ targetId: string; sessionId: string }> {
    const { targetInfos } = await this.send<{
      targetInfos: { targetId: string; type: string }[]
    }>('Target.getTargets')
    const pages = targetInfos.filter((t) => t.type === 'page')
    for (const page of pages) {
      const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true,
      })
      const read = await this.send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'window.__qyworkTab', returnByValue: true },
        { sessionId },
      )
      if (read.result.value === marker) {
        this.#pageSessions.add(sessionId)
        await this.#initPageSession(sessionId)
        return { targetId: page.targetId, sessionId }
      }
      await this.send('Target.detachFromTarget', { sessionId }, { teardown: 'detach' })
    }
    throw new CdpError('目标清单中没有带该标记的页面')
  }

  /**
   * 页会话初始化。
   *
   * 焦点仿真被拒绝时撤销控制，不换用其他命令重试：缺少焦点仿真时，网页中的输入框焦点判定不成立。
   * 是否生效只依据命令回包：CDP 合成点击会使 `document.hasFocus()` 变为 true 并保持，
   * 依据它判定会得到假阳性。
   */
  async #initPageSession(sessionId: string): Promise<void> {
    await this.#watchFrames(sessionId)
    await this.send('Runtime.enable', {}, { sessionId })
    await this.send('DOM.enable', {}, { sessionId })
    await this.send('Accessibility.enable', {}, { sessionId })
    // 跨站 iframe 以子会话形式附加；子会话 id 由 Target.attachedToTarget 事件收集。
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      { sessionId },
    )
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { sessionId })
    } catch (err) {
      if (err instanceof CdpDisconnectedError) throw err
      throw new CdpInitError(`焦点仿真被拒绝：${err instanceof Error ? err.message : String(err)}`)
    }
    await this.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: WAITER_RUNTIME },
      { sessionId },
    )
    await this.send(
      'Runtime.evaluate',
      { expression: WAITER_RUNTIME, returnByValue: true },
      {
        sessionId,
      },
    )
  }

  /**
   * 一页的跨站 iframe 子会话，包括嵌套的各层。
   *
   * 按父链归属，不按附加顺序：同时控制两页时，平表会把另一页的帧计入本页。
   */
  #ownedChildren(pageSessionId: string): { sessionId: string; targetId: string; ready: boolean }[] {
    const out: { sessionId: string; targetId: string; ready: boolean }[] = []
    const owned = new Set([pageSessionId])
    // 子会话可能先于其父会话登记，因此重复遍历直到结果不再增长，遍历次数以表长度为上限。
    for (let pass = 0; pass < this.#childSessions.size + 1; pass++) {
      let grew = false
      for (const [sessionId, info] of this.#childSessions) {
        if (owned.has(sessionId) || !owned.has(info.parent)) continue
        owned.add(sessionId)
        out.push({ sessionId, targetId: info.targetId, ready: info.ready })
        grew = true
      }
      if (!grew) break
    }
    return out
  }

  /**
   * 一页中已启用域的跨站 iframe 子会话。
   *
   * 只返回已就绪的会话：刚登记、`Runtime` / `DOM` / `Accessibility` 尚未启用的会话无法返回 AX 树，
   * 交给采集只会得到空帧。调用方据此判定该帧尚未就位，不要改为返回全部会话。
   */
  childSessionsOf(pageSessionId: string): { sessionId: string; targetId: string }[] {
    return this.#ownedChildren(pageSessionId)
      .filter((c) => c.ready)
      .map((c) => ({ sessionId: c.sessionId, targetId: c.targetId }))
  }

  /**
   * 移除一个页会话及其子会话的记录。
   *
   * 页面关闭后这些会话在远端已不存在，保留在表中只会使取消时的清理命令
   * 逐条报 `No session with given id`。
   */
  forgetSession(pageSessionId: string): void {
    for (const child of this.#ownedChildren(pageSessionId)) {
      this.#childSessions.delete(child.sessionId)
      this.#frameLoads.delete(child.sessionId)
    }
    this.#pageSessions.delete(pageSessionId)
    this.#frameLoads.delete(pageSessionId)
    for (const [key, held] of [...this.#heldKeys]) {
      if (held.sessionId === pageSessionId) this.#heldKeys.delete(key)
    }
    for (const [key, held] of [...this.#heldMouse]) {
      if (held.sessionId === pageSessionId) this.#heldMouse.delete(key)
    }
  }

  async #initChildSession(sessionId: string): Promise<void> {
    // 帧导航状态最先启用：子会话附加时其文档刚提交，其中的帧随后才创建，提前启用可避免遗漏帧。
    await this.#watchFrames(sessionId)
    await this.send('Runtime.enable', {}, { sessionId })
    await this.send('DOM.enable', {}, { sessionId })
    await this.send('Accessibility.enable', {}, { sessionId })
    // 嵌套的跨站 iframe 同样需要附加，否则无法观察第二层帧中的元素。
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      { sessionId },
    )
  }

  /**
   * 启用 `Page` 域并开始记录该会话的帧导航状态。
   *
   * 登记在 `Page.enable` 之前：该命令生效后事件随即到达，登记晚于命令会遗漏这些事件。
   * `Page` 域同时是导航订阅（`onSessionEvent`）的事件来源。
   *
   * 附加会话时已在进行的导航不会产生事件，因此文档尚未 `complete` 时，
   * 把帧树中尚无文档的帧一并记为导航中，由根帧的 `frameStoppedLoading` 统一清除：
   * 根帧在子树中全部进行中的导航结束后才停止加载。文档已 `complete` 时不记录任何帧：
   * 此时没有进行中的导航，清除记录的事件也不会再到达，记录后将一直处于未就位状态。
   */
  async #watchFrames(sessionId: string): Promise<void> {
    const entry = { root: '', loading: new Set<string>() }
    this.#frameLoads.set(sessionId, entry)
    await this.send('Page.enable', {}, { sessionId })
    const tree = await this.send<{ frameTree: FrameTreeNode }>(
      'Page.getFrameTree',
      {},
      { sessionId },
    )
    entry.root = tree.frameTree.frame.id
    const state = await this.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      { sessionId },
    )
    if (state.result.value === 'complete') return
    const walk = (node: FrameTreeNode): void => {
      for (const child of node.childFrames ?? []) {
        if (!child.frame.url) entry.loading.add(child.frame.id)
        walk(child)
      }
    }
    walk(tree.frameTree)
  }

  /**
   * 该页中当前尚未就位的帧，包括嵌套的各层。
   *
   * 两种来源：浏览器报告有导航进行中的帧，以及子会话已附加但域尚未启用完毕的帧
   * （此期间它无法返回 AX 树）。观察据此判定等待后能否取得该帧的内容，见 `page.ts` 的
   * `pendingFrames`。不属于这两类的帧，要么已可采集，要么由页面自身推迟加载
   * （`loading="lazy"` 未触发），等待它们只会浪费时间。
   */
  settlingFrames(pageSessionId: string): ReadonlySet<string> {
    const out = new Set<string>(this.#frameLoads.get(pageSessionId)?.loading ?? NO_FRAMES)
    for (const child of this.#ownedChildren(pageSessionId)) {
      if (!child.ready) out.add(child.targetId)
      for (const frame of this.#frameLoads.get(child.sessionId)?.loading ?? NO_FRAMES) {
        out.add(frame)
      }
    }
    return out
  }

  /**
   * 订阅一个页会话上的协议事件，返回取消函数。
   *
   * 只服务一次调用：在发送命令之前建立，结束时必须调用返回的函数。不调用时订阅表会随
   * 轮数增长，且上一次调用的判定会被本次的事件改写。`Page` 域的事件由
   * `Page.enable` 发布，页会话初始化时已启用。
   */
  onSessionEvent(sessionId: string, listener: (event: CdpEvent) => void): () => void {
    const entry = { sessionId, listener }
    this.#watchers.add(entry)
    return () => {
      this.#watchers.delete(entry)
    }
  }

  /** 当前订阅数。清理证据，不是调试输出。 */
  watchers(): number {
    return this.#watchers.size
  }

  /** 登记一个静默探针并返回它的页内 id。探针只统计 DOM 变更，不查询选择器、不修改页面。 */
  async startProbe(sessionId: string, timeoutMs: number): Promise<number> {
    const created = await this.#evalObject<{ id?: number }>(
      sessionId,
      'window.__qyworkProbe()',
      timeoutMs,
    )
    const id = created.id
    if (typeof id !== 'number') throw new CdpError('静默探针登记失败')
    return id
  }

  /**
   * 读取一次探针。结果按 `ProbeRead` 判定，缺少字段的读数不得视为就绪。
   *
   * 运行时缺失时在表达式中直接返回 `gone`，不经由 `#evalObject` 的补注入：探针随文档存续，
   * 文档更换后探针已失效，`gone` 正是调用方需要的终态，调用方据此重建探针，
   * 重建经由 `startProbe`，注入在该路径中补发。
   */
  async readProbe(sessionId: string, probeId: number, timeoutMs: number): Promise<ProbeRead> {
    const r = await this.send<{ result: { value?: ProbeRead } }>(
      'Runtime.evaluate',
      {
        expression: `window.__qyworkProbeRead ? window.__qyworkProbeRead(${probeId}) : { gone: true }`,
        returnByValue: true,
      },
      { sessionId, timeoutMs },
    )
    return r.result.value ?? { gone: true }
  }

  /** 登记一个等待器并返回它的页内 id。返回后调用方使用 `awaitWaiter` 等待结果。 */
  async startWaiter(
    sessionId: string,
    spec: { selector: string; state: string; expected?: string },
    timeoutMs: number,
  ): Promise<number> {
    const args = [spec.selector, timeoutMs, spec.state, spec.expected ?? null]
      .map((arg) => JSON.stringify(arg))
      .join(', ')
    const created = await this.#evalObject<{ id?: number }>(
      sessionId,
      `window.__qyworkWait(${args})`,
    )
    const id = created.id
    if (typeof id !== 'number') throw new CdpError('页内等待器登记失败')
    return id
  }

  async awaitWaiter(
    sessionId: string,
    waiterId: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return this.#evalObject<Record<string, unknown>>(
      sessionId,
      `window.__qyworkAwait(${waiterId})`,
      timeoutMs,
    )
  }

  /**
   * 在页内求值一次，回包必须是对象。
   *
   * 等待器运行时不在当前文档中时（尚未注入完成，或文档已更换），页内求值抛出
   * `undefined is not an object`，`returnByValue` 下 `result.value` 为 `undefined`。
   * 必须在此处处理：直接交给调用方时，下一步解引用会以内部异常原文结束，
   * 而该信息无法指导调用方的下一步操作。
   *
   * 缺失时先补发一次注入再求值一次：注入是运行时既有的路径，页面状态不受影响；
   * 重发的是取值，而非业务动作。补发后仍不成立时报告失败。
   */
  async #evalObject<T>(sessionId: string, expression: string, timeoutMs?: number): Promise<T> {
    const opts = { sessionId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
    for (const attempt of [0, 1]) {
      const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        opts,
      )
      const value = r.result.value
      if (r.exceptionDetails === undefined && typeof value === 'object' && value !== null) {
        return value as T
      }
      if (attempt === 0) {
        await this.send(
          'Runtime.evaluate',
          { expression: WAITER_RUNTIME, returnByValue: true },
          opts,
        )
      }
    }
    throw new CdpError('页面尚未准备好等待器，请重新观察后再等待')
  }

  /** 清理一个页内等待器或探针并读取计数。计数是清理证据，不是调试输出。 */
  async disposeWaiter(sessionId: string, waiterId: number): Promise<WaiterStats> {
    const r = await this.send<{ result: { value: WaiterStats } }>(
      'Runtime.evaluate',
      { expression: `window.__qyworkDispose(${waiterId})`, returnByValue: true },
      { sessionId, teardown: 'dispose', timeoutMs: 5_000 },
    )
    return r.result.value
  }

  /**
   * 取消：关闭业务发送通道 → 本地拒绝 pending → 清理页内等待器 → 释放已按下的键 →
   * detach 子会话与页会话。原生页不关闭。重复调用为空操作。
   *
   * `deadline` 是整次收尾的绝对截止时刻，每条清理命令的超时取剩余时间与单条上限中的较小值。
   * 每页各分配完整额度时，收尾时长随本客户端控制的页数线性增长。
   */
  async cancel(reason = '已取消', deadline?: number): Promise<CancelSummary> {
    if (this.#cancelled) {
      return {
        rejectedPending: 0,
        waiterStats: [],
        keysReleased: [],
        mouseReleased: [],
        detached: [],
      }
    }
    this.#cancelled = true
    this.#businessClosed = true
    this.#halt.abort()
    const left = (cap: number) =>
      deadline === undefined ? cap : Math.max(1, Math.min(cap, deadline - Date.now()))
    // 进行中的收尾命令不结算：动作自身的收尾可能正在补发抬起，结算它会使该键保持按下状态。
    const rejectedPending = this.#failPending(new CdpCancelledError(reason), true)
    const waiterStats: WaiterStats[] = []
    for (const sessionId of this.#pageSessions) {
      try {
        const r = await this.send<{ result: { value: WaiterStats | null } }>(
          'Runtime.evaluate',
          {
            expression: 'window.__qyworkDisposeAll ? window.__qyworkDisposeAll() : null',
            returnByValue: true,
          },
          { sessionId, teardown: 'dispose', timeoutMs: left(5_000) },
        )
        if (r.result.value) waiterStats.push(r.result.value)
      } catch (err) {
        log.warn('browser', `等待器清理失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const keysReleased = await this.releaseHeldKeys(deadline)
    const mouseReleased = await this.releaseHeldMouse(deadline)
    const detached: string[] = []
    for (const sessionId of [...this.#childSessions.keys(), ...this.#pageSessions]) {
      try {
        await this.send(
          'Target.detachFromTarget',
          { sessionId },
          { teardown: 'detach', timeoutMs: left(3_000) },
        )
        detached.push(sessionId)
      } catch (err) {
        log.warn('browser', `detach 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.#childSessions.clear()
    this.#pageSessions.clear()
    this.#frameLoads.clear()
    return { rejectedPending, waiterStats, keysReleased, mouseReleased, detached }
  }

  /**
   * 为已按下未确认抬起的键补发一次 keyUp。使用 teardown 身份，不是新的业务动作。
   *
   * 取消与动作收尾可能同时执行到此处：同一条目的进行中释放只发送一次，后到者等待同一结果。
   * 未确认的条目保留在表中，由 `heldKeys` 报告。
   */
  async releaseHeldKeys(deadline?: number): Promise<string[]> {
    const released: string[] = []
    for (const [key, held] of [...this.#heldKeys]) {
      held.release ??= this.#releaseOnce(held, 'keyup', () =>
        this.send(
          'Input.dispatchKeyEvent',
          {
            type: 'keyUp',
            key: held.params.key,
            code: held.params.code,
            windowsVirtualKeyCode: held.params.windowsVirtualKeyCode,
            nativeVirtualKeyCode: held.params.nativeVirtualKeyCode,
            modifiers: held.params.modifiers ?? 0,
          },
          { sessionId: held.sessionId, teardown: 'keyup', timeoutMs: teardownLimit(deadline) },
        ),
      )
      if (await held.release) released.push(key)
    }
    return released
  }

  /**
   * 为已按下未确认抬起的鼠标键补发一次 `mouseReleased`。使用 teardown 身份，不是新的业务动作。
   *
   * 坐标取最后一次移动到的位置：在起点释放会使拖动回到原处，与页面当前状态不符。
   */
  async releaseHeldMouse(deadline?: number): Promise<string[]> {
    const released: string[] = []
    for (const [key, held] of [...this.#heldMouse]) {
      held.release ??= this.#releaseOnce(held, 'mouseup', () =>
        this.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseReleased',
            x: held.x,
            y: held.y,
            button: held.button,
            buttons: 0,
            clickCount: 1,
          },
          { sessionId: held.sessionId, teardown: 'mouseup', timeoutMs: teardownLimit(deadline) },
        ),
      )
      if (await held.release) released.push(key)
    }
    return released
  }

  /** 一次收尾释放。结束后清除进行中标记：失败的条目保留在表中，下一次收尾可以重试。 */
  #releaseOnce<T extends object>(
    held: Held<T>,
    kind: 'keyup' | 'mouseup',
    send: () => Promise<unknown>,
  ): Promise<boolean> {
    return send()
      .then(
        () => true,
        (err: unknown) => {
          const what = kind === 'keyup' ? '按键' : '鼠标'
          log.warn(
            'browser',
            `释放${what}失败：${err instanceof Error ? err.message : String(err)}`,
          )
          return false
        },
      )
      .finally(() => {
        held.release = null
      })
  }

  /** 按下未确认抬起的键，形如 `会话|code`。 */
  heldKeys(): string[] {
    return [...this.#heldKeys.keys()]
  }

  /** 按下未确认抬起的鼠标键，形如 `会话|按键`。 */
  heldMouse(): string[] {
    return [...this.#heldMouse.keys()]
  }

  close(): void {
    this.#socket.close()
  }

  /**
   * 按键记录：按下在发出前登记，返回回包到达时的处理函数。
   *
   * 按下被协议明确拒绝即未生效，移除记录；超时、断连、取消时按下可能已生效，保留记录。
   * 抬起在确认之后才移除，且只移除发出时对应的条目。
   */
  #trackKey(
    sessionId: string | undefined,
    params: Record<string, unknown>,
  ): ((outcome: Outcome) => void) | null {
    const key = `${sessionId ?? ''}|${String(params.code ?? params.key ?? '')}`
    const type = params.type
    if (type === 'keyDown' || type === 'rawKeyDown') {
      const entry: Held<{ params: Record<string, unknown> }> = {
        sessionId: sessionId ?? '',
        params,
        release: null,
      }
      this.#heldKeys.set(key, entry)
      return (outcome) => {
        if (outcome === 'rejected' && this.#heldKeys.get(key) === entry) this.#heldKeys.delete(key)
      }
    }
    if (type !== 'keyUp') return null
    const entry = this.#heldKeys.get(key)
    if (!entry) return null
    return (outcome) => {
      if (outcome === 'applied' && this.#heldKeys.get(key) === entry) this.#heldKeys.delete(key)
    }
  }

  /** 鼠标按下状态：登记与移除同 `#trackKey`；移动在发出前更新坐标，滚轮不改变按下状态。 */
  #trackMouse(
    sessionId: string | undefined,
    params: Record<string, unknown>,
  ): ((outcome: Outcome) => void) | null {
    const session = sessionId ?? ''
    const button = String(params.button ?? 'left')
    const key = `${session}|${button}`
    const type = params.type
    if (type === 'mousePressed') {
      const entry: Held<{ button: string; x: number; y: number }> = {
        sessionId: session,
        button,
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
        release: null,
      }
      this.#heldMouse.set(key, entry)
      return (outcome) => {
        if (outcome === 'rejected' && this.#heldMouse.get(key) === entry)
          this.#heldMouse.delete(key)
      }
    }
    if (type === 'mouseReleased') {
      const entry = this.#heldMouse.get(key)
      if (!entry) return null
      return (outcome) => {
        if (outcome === 'applied' && this.#heldMouse.get(key) === entry) {
          this.#heldMouse.delete(key)
        }
      }
    }
    if (type !== 'mouseMoved') return null
    for (const held of this.#heldMouse.values()) {
      if (held.sessionId !== session) continue
      held.x = Number(params.x ?? held.x)
      held.y = Number(params.y ?? held.y)
    }
    return null
  }

  #onMessage(raw: string): void {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id)
      // 迟到回包：对应 pending 已被本地拒绝并删除，直接丢弃。
      if (!pending) return
      this.#pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new CdpError(`${pending.method}: ${msg.error.message}`))
      else pending.resolve(msg.result ?? {})
      return
    }
    if (msg.method === 'Target.attachedToTarget') {
      const sessionId = (msg.params?.sessionId as string | undefined) ?? ''
      const info = msg.params?.targetInfo as { targetId?: string } | undefined
      if (sessionId) {
        const entry = {
          parent: msg.sessionId ?? '',
          targetId: info?.targetId ?? '',
          ready: false,
        }
        this.#childSessions.set(sessionId, entry)
        // 子会话须先启用域才能观察。附加由事件驱动，此处只能异步启用，完成后才置 ready；
        // 失败时该帧保持未就绪，由观察侧报告，不视为该帧不存在。
        void this.#initChildSession(sessionId)
          .then(() => {
            // 期间可能已 detach 并附加了另一条会话，只处理本次登记的会话。
            if (this.#childSessions.get(sessionId) === entry) entry.ready = true
          })
          .catch((err) => {
            log.warn(
              'browser',
              `子帧会话初始化失败：${err instanceof Error ? err.message : String(err)}`,
            )
          })
      }
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const sessionId = (msg.params?.sessionId as string | undefined) ?? ''
      this.#childSessions.delete(sessionId)
      this.#frameLoads.delete(sessionId)
    }
    this.#trackFrameLoad(msg)
    if (!msg.method) return
    const event: CdpEvent = { method: msg.method, params: msg.params ?? {} }
    for (const watcher of [...this.#watchers]) {
      if (watcher.sessionId !== (msg.sessionId ?? '')) continue
      try {
        watcher.listener(event)
      } catch (err) {
        log.warn('browser', `事件订阅出错：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * 按 `Page` 的帧事件维护各帧的导航状态。
   *
   * 根帧停止加载意味着子树中进行中的导航均已结束，附加会话时记录的帧随之作废，
   * 见 `#watchFrames`。
   */
  #trackFrameLoad(msg: CdpMessage): void {
    const entry = this.#frameLoads.get(msg.sessionId ?? '')
    if (!entry) return
    const frameId = (msg.params?.frameId as string | undefined) ?? ''
    if (!frameId) return
    if (msg.method === 'Page.frameStartedLoading') entry.loading.add(frameId)
    if (msg.method === 'Page.frameDetached') entry.loading.delete(frameId)
    if (msg.method === 'Page.frameStoppedLoading') {
      entry.loading.delete(frameId)
      if (frameId === entry.root) entry.loading.clear()
    }
  }

  #failPending(err: Error, keepTeardown = false): number {
    let rejected = 0
    for (const [id, pending] of [...this.#pending]) {
      if (keepTeardown && pending.teardown) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(err)
      rejected += 1
    }
    return rejected
  }
}

/** 一条输入命令的回包结果：生效、被协议拒绝（未生效）、不明（超时、断连、取消）。 */
type Outcome = 'applied' | 'rejected' | 'unknown'

/** 一条按下记录。`release` 是进行中的收尾释放，非空时后到的释放方等待它，不再发送第二条。 */
type Held<T> = T & { sessionId: string; release: Promise<boolean> | null }

/** 收尾命令的超时：剩余预算与单条上限取小。 */
function teardownLimit(deadline: number | undefined): number {
  return deadline === undefined ? 3_000 : Math.max(1, Math.min(3_000, deadline - Date.now()))
}

/**
 * 该失败发生后命令可能已在页面上生效：超时、断连、取消均属于已发出未确认。
 * 协议错误回包表示对端拒绝了该命令，命令未生效。
 */
function unconfirmed(err: unknown): boolean {
  return (
    err instanceof CdpTimeoutError ||
    err instanceof CdpDisconnectedError ||
    err instanceof CdpCancelledError
  )
}

export function allowedMethod(method: string): boolean {
  if (ALLOWED_BROWSER_METHODS.has(method)) return true
  const domain = method.split('.')[0] ?? ''
  return ALLOWED_DOMAINS.has(domain)
}
