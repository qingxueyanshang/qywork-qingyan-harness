/**
 * 自持的 CDP 客户端：一条 Bun 原生 `WebSocket` 直说协议，不经第三方驱动。
 *
 * 四条不变量：
 *
 * 1. **待决请求由本客户端拒绝。** 断开、超时、取消都在本地结束 pending，
 *    不假定远端返回或 detach 会代劳；按 id 查不到待决项的迟到回包直接丢弃，
 *    不得完成另一请求。
 * 2. **取消之后发送口只放行 teardown。** 清理命令（detach、等待器 dispose、
 *    收尾 keyUp）必须能发出去，否则页面留着按下状态，人工接管后按键行为不对。
 * 3. **方法集是白名单。** 不对上层暴露任意方法调用，`Browser` 域只放行 `getVersion`。
 * 4. **等待只观察，不执行动作。** 页内等待器用 `MutationObserver` 加 `setTimeout`，
 *    不用 `requestAnimationFrame`：子视图移出可视区时不再出帧，靠出帧驱动的轮询会挂住。
 */

import { log } from '@qywork/core'

/** 允许发出的域。加一个域等于扩大模型能触达的协议面，要单独讨论。 */
const ALLOWED_DOMAINS = new Set([
  'Target',
  'Page',
  'Runtime',
  'DOM',
  'Input',
  'Accessibility',
  'Emulation',
])

/** `Browser` 域只用来读版本，下载行为一律走宿主的原生钩子。 */
const ALLOWED_BROWSER_METHODS = new Set(['Browser.getVersion'])

/**
 * 取消之后仍允许发出的命令。
 *
 * 只把这条规则写进文档而不落成白名单的代价是实测过的：取消关掉发送口之后，
 * 按业务路径补发的 keyUp 会被自己的取消挡掉，页面因此留着按下状态。
 */
const TEARDOWN_TAGS = new Set(['detach', 'dispose', 'keyup'])

export type TeardownTag = 'detach' | 'dispose' | 'keyup'

/**
 * `press` 认的按键。
 *
 * 表在客户端维护，不接受调用方给的任意字符串：`Input.dispatchKeyEvent` 的
 * `key` / `code` / `windowsVirtualKeyCode` 三项必须自洽，缺一项网页就收到一个
 * 认不出的按键而不报错。可打印字符走 `fill`，不从这里造。
 */
const KEY_TABLE: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

export interface KeySpec {
  key: string
  code: string
  keyCode: number
  text?: string
}

export const PRESS_KEYS = Object.keys(KEY_TABLE)

export function keySpec(name: string): KeySpec | null {
  return KEY_TABLE[name] ?? null
}

export class CdpError extends Error {}
export class CdpCancelledError extends CdpError {}
export class CdpTimeoutError extends CdpError {}
export class CdpDisconnectedError extends CdpError {}
/** 会话初始化命令被拒。调用方必须撤销控制，不换命令重试。 */
export class CdpInitError extends CdpError {}

export interface SendOptions {
  sessionId?: string
  timeoutMs?: number
  /** 带上即按 teardown 发送；取消之后只有这一类还能出网。 */
  teardown?: TeardownTag
}

interface Pending {
  method: string
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

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

export interface CancelSummary {
  rejectedPending: number
  waiterStats: WaiterStats[]
  keysReleased: string[]
  detached: string[]
}

/**
 * 页内等待器。只 `querySelector` 观察并返回坐标，不点击、不提交、不输入。
 *
 * 注册表挂在 `window` 上，因此可以按 id 单独清理，并读回 observer 与 timer
 * 的计数作为清理证据。
 */
const WAITER_RUNTIME = `(() => {
  if (window.__qyworkWaiters) return 'already'
  window.__qyworkWaiters = new Map()
  window.__qyworkSeq = 0
  window.__qyworkLive = { observers: 0, timers: 0 }
  window.__qyworkWait = (selector, timeoutMs) => {
    const id = ++window.__qyworkSeq
    let settle
    const rec = { id, done: false, obs: null, timer: null }
    rec.promise = new Promise((r) => { settle = r })
    rec.finish = (result) => {
      if (rec.done) return
      rec.done = true
      if (rec.obs) { rec.obs.disconnect(); rec.obs = null; window.__qyworkLive.observers-- }
      if (rec.timer !== null) { clearTimeout(rec.timer); rec.timer = null; window.__qyworkLive.timers-- }
      settle(result)
    }
    window.__qyworkWaiters.set(id, rec)
    const check = () => {
      const el = document.querySelector(selector)
      if (!el) return false
      const r = el.getBoundingClientRect()
      rec.finish({ found: true, id, x: r.x + r.width / 2, y: r.y + r.height / 2 })
      return true
    }
    if (check()) return { id, immediate: true }
    rec.obs = new MutationObserver(() => { check() })
    window.__qyworkLive.observers++
    rec.obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    rec.timer = setTimeout(() => rec.finish({ found: false, reason: 'timeout', id }), timeoutMs)
    window.__qyworkLive.timers++
    return { id, immediate: false }
  }
  window.__qyworkAwait = (id) => {
    const rec = window.__qyworkWaiters.get(id)
    return rec ? rec.promise : Promise.resolve({ found: false, reason: 'gone', id })
  }
  window.__qyworkDispose = (id) => {
    const rec = window.__qyworkWaiters.get(id)
    if (rec) rec.finish({ found: false, reason: 'cancelled', id })
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
   * 记的是「谁的子会话」而不是一张平表：观察要按页取它自己那几个帧，
   * 平表在同时控制多页时会把别的页的帧算进来。
   */
  #childSessions = new Map<string, { parent: string; targetId: string }>()
  /** 本客户端按下但尚未释放的键。取消时按它补发 keyUp。 */
  #heldKeys = new Map<string, { sessionId: string; params: Record<string, unknown> }>()
  #businessClosed = false
  #cancelled = false

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.onmessage = (ev) => this.#onMessage(String(ev.data))
    socket.onclose = () => this.#failPending(new CdpDisconnectedError('CDP 连接已断开'))
    socket.onerror = () => {}
  }

  /** 连上宿主分配的回环端点。端点只有在第一个子视图建出来之后才开始监听。 */
  static async connect(debugPort: number, timeoutMs = 10_000): Promise<CdpClient> {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const version = (await res.json()) as { webSocketDebuggerUrl?: string }
    const url = version.webSocketDebuggerUrl
    if (!url) throw new CdpError('调试端点没有给出 WebSocket 地址')
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpTimeoutError('CDP 连接超时')), timeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new CdpDisconnectedError('CDP 连接失败'))
      }
    })
    return new CdpClient(socket)
  }

  get cancelled(): boolean {
    return this.#cancelled
  }

  /**
   * 发一条命令。
   *
   * 白名单、取消状态、连接状态三项在**入网之前**判定：判定放到回包那一侧的话，
   * 取消之后的命令已经到了网站上。
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
      return Promise.reject(new CdpError(`认不出的 teardown 标记：${teardown}`))
    }
    if (!teardown && this.#businessClosed) {
      return Promise.reject(new CdpCancelledError(`发送口已关闭，拒绝 ${method}`))
    }
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpDisconnectedError(`连接不可用，拒绝 ${method}`))
    }
    const timeoutMs = options.timeoutMs ?? 15_000
    this.#seq += 1
    const id = this.#seq
    if (method === 'Input.dispatchKeyEvent' && !teardown) {
      this.#trackKey(options.sessionId, params)
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new CdpTimeoutError(`${method} 超过 ${timeoutMs}ms 未返回`))
      }, timeoutMs)
      this.#pending.set(id, {
        method,
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
  }

  /**
   * 按宿主注入的标记找到这一页并附加。
   *
   * 不按 URL 或标题匹配：两个同 URL 的子视图在目标清单里完全相同。
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
    throw new CdpError('目标清单里没有带这个标记的页面')
  }

  /**
   * 页会话初始化。
   *
   * 焦点仿真被拒即撤销控制，不换命令重试——没有它，网页里的输入框焦点判定不成立。
   * 生效与否只看命令回包：CDP 合成点击会把 `document.hasFocus()` 变成 true 并保持，
   * 按它判会得到假阳性。
   */
  async #initPageSession(sessionId: string): Promise<void> {
    await this.send('Page.enable', {}, { sessionId })
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
      throw new CdpInitError(`焦点仿真被拒：${err instanceof Error ? err.message : String(err)}`)
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
   * 一页的跨站 iframe 子会话，含嵌套的那几层。
   *
   * 按父链归属，不按附加顺序：同时控制两页时，平表会把另一页的帧算进这一页。
   */
  childSessionsOf(pageSessionId: string): { sessionId: string; targetId: string }[] {
    const out: { sessionId: string; targetId: string }[] = []
    const owned = new Set([pageSessionId])
    // 子会话可能先于它的父会话登记，所以按表长度兜一圈直到不再增长。
    for (let pass = 0; pass < this.#childSessions.size + 1; pass++) {
      let grew = false
      for (const [sessionId, info] of this.#childSessions) {
        if (owned.has(sessionId) || !owned.has(info.parent)) continue
        owned.add(sessionId)
        out.push({ sessionId, targetId: info.targetId })
        grew = true
      }
      if (!grew) break
    }
    return out
  }

  /**
   * 忘掉一个页会话及它的子会话。
   *
   * 页被关掉之后这些会话在远端已经不存在了，留在表里只会让取消时的清理命令
   * 逐条报 `No session with given id`。
   */
  forgetSession(pageSessionId: string): void {
    for (const child of this.childSessionsOf(pageSessionId)) {
      this.#childSessions.delete(child.sessionId)
    }
    this.#pageSessions.delete(pageSessionId)
    for (const [key, held] of [...this.#heldKeys]) {
      if (held.sessionId === pageSessionId) this.#heldKeys.delete(key)
    }
  }

  /** 按表里的规格发一次按下加抬起。按下状态进收尾表，中途取消时补 keyUp。 */
  async pressKey(sessionId: string, spec: KeySpec): Promise<void> {
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    }
    await this.send(
      'Input.dispatchKeyEvent',
      {
        type: spec.text ? 'keyDown' : 'rawKeyDown',
        ...base,
        ...(spec.text ? { text: spec.text } : {}),
      },
      { sessionId },
    )
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { sessionId })
  }

  async #initChildSession(sessionId: string): Promise<void> {
    await this.send('Runtime.enable', {}, { sessionId })
    await this.send('DOM.enable', {}, { sessionId })
    await this.send('Accessibility.enable', {}, { sessionId })
    // 嵌套的跨站 iframe 同样要附加，否则第二层帧里的元素观察不到。
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      { sessionId },
    )
  }

  /** 登记一个等待器并返回它的页内 id。返回后调用方用 `awaitWaiter` 等结果。 */
  async startWaiter(sessionId: string, selector: string, timeoutMs: number): Promise<number> {
    const created = await this.send<{ result: { value: { id: number } } }>(
      'Runtime.evaluate',
      {
        expression: `window.__qyworkWait(${JSON.stringify(selector)}, ${timeoutMs})`,
        returnByValue: true,
      },
      { sessionId },
    )
    return created.result.value.id
  }

  async awaitWaiter(
    sessionId: string,
    waiterId: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const done = await this.send<{ result: { value: Record<string, unknown> } }>(
      'Runtime.evaluate',
      {
        expression: `window.__qyworkAwait(${waiterId})`,
        returnByValue: true,
        awaitPromise: true,
      },
      { sessionId, timeoutMs },
    )
    return done.result.value
  }

  /** 清掉一个页内等待器并读回计数。计数是清理证据，不是调试输出。 */
  async disposeWaiter(sessionId: string, waiterId: number): Promise<WaiterStats> {
    const r = await this.send<{ result: { value: WaiterStats } }>(
      'Runtime.evaluate',
      { expression: `window.__qyworkDispose(${waiterId})`, returnByValue: true },
      { sessionId, teardown: 'dispose', timeoutMs: 5_000 },
    )
    return r.result.value
  }

  /**
   * 取消：关业务发送口 → 本地拒绝 pending → 清页内等待器 → 收尾按下的键 →
   * detach 子会话与页会话。原生页不关。重复调用是空操作。
   */
  async cancel(reason = '已取消'): Promise<CancelSummary> {
    if (this.#cancelled) {
      return { rejectedPending: 0, waiterStats: [], keysReleased: [], detached: [] }
    }
    this.#cancelled = true
    this.#businessClosed = true
    const rejectedPending = this.#failPending(new CdpCancelledError(reason))
    const waiterStats: WaiterStats[] = []
    for (const sessionId of this.#pageSessions) {
      try {
        const r = await this.send<{ result: { value: WaiterStats | null } }>(
          'Runtime.evaluate',
          {
            expression: 'window.__qyworkDisposeAll ? window.__qyworkDisposeAll() : null',
            returnByValue: true,
          },
          { sessionId, teardown: 'dispose', timeoutMs: 5_000 },
        )
        if (r.result.value) waiterStats.push(r.result.value)
      } catch (err) {
        log.warn('browser', `等待器清理失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const keysReleased = await this.releaseHeldKeys()
    const detached: string[] = []
    for (const sessionId of [...this.#childSessions.keys(), ...this.#pageSessions]) {
      try {
        await this.send(
          'Target.detachFromTarget',
          { sessionId },
          { teardown: 'detach', timeoutMs: 3_000 },
        )
        detached.push(sessionId)
      } catch (err) {
        log.warn('browser', `detach 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.#childSessions.clear()
    this.#pageSessions.clear()
    return { rejectedPending, waiterStats, keysReleased, detached }
  }

  /** 把已按下未释放的键补一次 keyUp。走 teardown 身份，不是新的业务动作。 */
  async releaseHeldKeys(): Promise<string[]> {
    const released: string[] = []
    for (const [key, held] of [...this.#heldKeys]) {
      this.#heldKeys.delete(key)
      try {
        await this.send(
          'Input.dispatchKeyEvent',
          {
            type: 'keyUp',
            key: held.params.key,
            code: held.params.code,
            windowsVirtualKeyCode: held.params.windowsVirtualKeyCode,
            modifiers: held.params.modifiers ?? 0,
          },
          { sessionId: held.sessionId, teardown: 'keyup', timeoutMs: 3_000 },
        )
        released.push(key)
      } catch (err) {
        log.warn('browser', `收尾按键失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return released
  }

  heldKeys(): string[] {
    return [...this.#heldKeys.keys()]
  }

  close(): void {
    this.#socket.close()
  }

  #trackKey(sessionId: string | undefined, params: Record<string, unknown>): void {
    const key = `${sessionId ?? ''}|${String(params.code ?? params.key ?? '')}`
    const type = params.type
    if (type === 'keyDown' || type === 'rawKeyDown') {
      this.#heldKeys.set(key, { sessionId: sessionId ?? '', params })
    }
    if (type === 'keyUp') this.#heldKeys.delete(key)
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
      // 迟到回包：对应 pending 已被本地拒绝并删除，丢弃即可。
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
        this.#childSessions.set(sessionId, {
          parent: msg.sessionId ?? '',
          targetId: info?.targetId ?? '',
        })
        // 子会话要先开域才观察得到。附加是事件驱动的，这里只能异步补；
        // 失败不影响主文档，观察时这一帧拿不到元素而已。
        void this.#initChildSession(sessionId).catch((err) => {
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
    }
  }

  #failPending(err: Error): number {
    const ids = [...this.#pending.keys()]
    for (const id of ids) {
      const pending = this.#pending.get(id)
      if (!pending) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    return ids.length
  }
}

export function allowedMethod(method: string): boolean {
  if (ALLOWED_BROWSER_METHODS.has(method)) return true
  const domain = method.split('.')[0] ?? ''
  return ALLOWED_DOMAINS.has(domain)
}
