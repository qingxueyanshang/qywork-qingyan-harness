/**
 * 自持的 CDP 客户端：一条 Bun 原生 `WebSocket` 直说协议，不经第三方驱动。
 *
 * 四条不变量：
 *
 * 1. **待决请求由本客户端拒绝。** 断开、超时、取消都在本地结束 pending，
 *    不假定远端返回或 detach 会代劳；按 id 查不到待决项的迟到回包直接丢弃，
 *    不得完成另一请求。
 * 2. **取消之后发送口只放行 teardown。** 清理命令（detach、等待器 dispose、收尾 keyUp 与
 *    mouseReleased）必须能发出去，否则页面留着按下状态，人工接管后输入行为不对。
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
 * 按业务路径补发的 keyUp 会被自己的取消挡掉，页面因此留着按下状态。鼠标同理。
 */
const TEARDOWN_TAGS = new Set(['detach', 'dispose', 'keyup', 'mouseup'])

export type TeardownTag = 'detach' | 'dispose' | 'keyup' | 'mouseup'

/**
 * 功能键。
 *
 * 表在客户端维护，不接受调用方给的任意字符串：`Input.dispatchKeyEvent` 的
 * `key` / `code` / `windowsVirtualKeyCode` 三项必须自洽，缺一项网页就收到一个
 * 认不出的按键而不报错。
 */
const FUNCTION_KEYS: Record<string, KeySpec> = {
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

/**
 * US 布局的可打印键：物理 `code`、Windows 虚拟键码、无 Shift 字符、按住 Shift 的字符。
 *
 * **不要改成按字符码点算键码。** 虚拟键码是物理键的编号，与字符不是一一对应：`;` 与 `:`
 * 同一个键（186），而按码点算会得到 59 与 58 两个不存在的键；字母 `a` 与 `A` 同为 65。
 * 平台布局固定为 US，不按系统当前布局推断。
 */
const PRINTABLE_KEYS: [code: string, keyCode: number, plain: string, shifted: string][] = [
  ['Backquote', 192, '`', '~'],
  ['Digit1', 49, '1', '!'],
  ['Digit2', 50, '2', '@'],
  ['Digit3', 51, '3', '#'],
  ['Digit4', 52, '4', '$'],
  ['Digit5', 53, '5', '%'],
  ['Digit6', 54, '6', '^'],
  ['Digit7', 55, '7', '&'],
  ['Digit8', 56, '8', '*'],
  ['Digit9', 57, '9', '('],
  ['Digit0', 48, '0', ')'],
  ['Minus', 189, '-', '_'],
  ['Equal', 187, '=', '+'],
  ['BracketLeft', 219, '[', '{'],
  ['BracketRight', 221, ']', '}'],
  ['Backslash', 220, '\\', '|'],
  ['Semicolon', 186, ';', ':'],
  ['Quote', 222, "'", '"'],
  ['Comma', 188, ',', '<'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
]

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i)
  PRINTABLE_KEYS.push([`Key${lower.toUpperCase()}`, 65 + i, lower, lower.toUpperCase()])
}

/** 字符 → 按键规格。大写字母与上排符号带 `shift`，调用方据此补按 Shift。 */
const CHAR_KEYS = new Map<string, KeySpec>()
/** 物理键 → 不按 Shift 时的规格。快捷键里的字母按物理键算，用它当主键。 */
const PLAIN_BY_CODE = new Map<string, KeySpec>()
for (const [code, keyCode, plain, shifted] of PRINTABLE_KEYS) {
  const spec: KeySpec = { key: plain, code, keyCode, text: plain }
  CHAR_KEYS.set(plain, spec)
  PLAIN_BY_CODE.set(code, spec)
  CHAR_KEYS.set(shifted, { key: shifted, code, keyCode, text: shifted, shift: true })
}
CHAR_KEYS.set(' ', { key: ' ', code: 'Space', keyCode: 32, text: ' ' })

export interface KeySpec {
  key: string
  code: string
  keyCode: number
  /** 这个键产生的字符。没有字符的功能键缺席，缺席即发 `rawKeyDown`。 */
  text?: string
  /** 产生这个字符要按住 Shift。 */
  shift?: boolean
}

/** `Input.dispatchKeyEvent` 的 `modifiers` 位。 */
const MODIFIER_BITS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const

export type ModifierName = keyof typeof MODIFIER_BITS

const MODIFIER_KEYS: Record<ModifierName, KeySpec> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
}

/** 一次按键：先按下的修饰键，再主键。 */
export interface KeyStroke {
  modifiers: ModifierName[]
  key: KeySpec
}

export const PRESS_KEYS = Object.keys(FUNCTION_KEYS)

/** 一个主键名对应的规格。`Plus` 表示加号本身——`+` 是组合键的分隔符。 */
export function keySpec(name: string): KeySpec | null {
  if (name === 'Plus') return CHAR_KEYS.get('+') ?? null
  return FUNCTION_KEYS[name] ?? CHAR_KEYS.get(name) ?? null
}

/**
 * 解析一次按键：`Ctrl+Shift+Enter` 这样的写法，末段是主键，之前各段是修饰键。
 *
 * 空段、重复修饰键、认不出的修饰键或主键一律返回 `null`，由调用方拒绝整次动作。
 */
export function keyStroke(input: string): KeyStroke | null {
  const parts = input.split('+')
  if (parts.some((part) => part === '')) return null
  const main = parts.pop()
  if (main === undefined) return null
  const key = keySpec(main)
  if (!key) return null
  const modifiers: ModifierName[] = []
  for (const part of parts) {
    if (!(part in MODIFIER_BITS)) return null
    const name = part as ModifierName
    if (modifiers.includes(name)) return null
    modifiers.push(name)
  }
  if (key.shift !== true || modifiers.includes('Shift')) return { modifiers, key }
  // 大写字母与上排符号要按住 Shift 才产生，补上它，否则页面收到的是另一个字符。
  // 快捷键里的字母是例外：`Ctrl+A` 说的是 Ctrl 加 A 键，补 Shift 会变成另一个快捷键，
  // 而页面在真实的 Ctrl+A 上看到的 `key` 本来就是 `a`。
  if (key.code.startsWith('Key') && modifiers.some((name) => name !== 'Shift')) {
    return { modifiers, key: PLAIN_BY_CODE.get(key.code) ?? key }
  }
  modifiers.push('Shift')
  return { modifiers, key }
}

function bitsOf(names: readonly ModifierName[]): number {
  let bits = 0
  for (const name of names) bits |= MODIFIER_BITS[name]
  return bits
}

/** 一条按键事件里描述这个键的三项。三项必须自洽，缺一项网页收到的是认不出的按键。 */
function keyFields(spec: KeySpec): Record<string, unknown> {
  return {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  }
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

/**
 * 一次静默探针读数。
 *
 * 三个字段都可能缺席，缺席即探针不成立。**调用方不得把缺席当作「文档已就绪」**：
 * 那会让一个还在加载的页面提前通过静默判定。
 */
export interface ProbeRead {
  /** `document.readyState`。 */
  ready?: string
  /** 探针建立以来的 DOM 变更条数。 */
  mutations?: number
  /** 这个探针已经不在当前文档里：换过文档，或已被清理。 */
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
 * 页内等待器与静默探针。只 `querySelector` 观察、只数 DOM 变更，不点击、不提交、不输入。
 *
 * 注册表挂在 `window` 上，因此可以按 id 单独清理，并读回 observer 与 timer
 * 的计数作为清理证据。**探针必须走这张表建**：另挂一个观察器的话，取消与断连时
 * 的清理路径找不到它，它会跟着文档一直观察下去。
 */
const WAITER_RUNTIME = `(() => {
  if (window.__qyworkWaiters) return 'already'
  window.__qyworkWaiters = new Map()
  window.__qyworkSeq = 0
  window.__qyworkLive = { observers: 0, timers: 0 }
  const make = () => {
    let settle
    const rec = { id: ++window.__qyworkSeq, done: false, obs: null, timer: null, mutations: 0 }
    rec.promise = new Promise((r) => { settle = r })
    rec.finish = (result) => {
      if (rec.done) return
      rec.done = true
      if (rec.obs) { rec.obs.disconnect(); rec.obs = null; window.__qyworkLive.observers-- }
      if (rec.timer !== null) { clearTimeout(rec.timer); rec.timer = null; window.__qyworkLive.timers-- }
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
  window.__qyworkWait = (selector, timeoutMs) => {
    const rec = make()
    const id = rec.id
    const check = () => {
      const el = document.querySelector(selector)
      if (!el) return false
      const r = el.getBoundingClientRect()
      rec.finish({ found: true, id, x: r.x + r.width / 2, y: r.y + r.height / 2 })
      return true
    }
    if (check()) return { id, immediate: true }
    watch(rec, () => { check() })
    rec.timer = setTimeout(() => rec.finish({ found: false, reason: 'timeout', id }), timeoutMs)
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
  /**
   * 本客户端按下但尚未释放的鼠标键，连同最后一次移动到的坐标。
   *
   * 只记本客户端自己发出去的按下：收尾时按它补 `mouseReleased`，不对别的会话或用户
   * 桌面释放输入。不靠成功路径最后那一条 `mouseReleased` ——拖动中途失败时它发不出来。
   */
  #heldMouse = new Map<string, { sessionId: string; button: string; x: number; y: number }>()
  /** 短寿命事件订阅。每一项只服务一次调用，由建立方在结束时摘掉。 */
  #watchers = new Set<{ sessionId: string; listener: (event: CdpEvent) => void }>()
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
    if (method === 'Input.dispatchMouseEvent' && !teardown) {
      this.#trackMouse(options.sessionId, params)
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
    for (const [key, held] of [...this.#heldMouse]) {
      if (held.sessionId === pageSessionId) this.#heldMouse.delete(key)
    }
  }

  /**
   * 发一次按键：修饰键依次按下 → 主键按下抬起 → 修饰键逆序抬起。
   *
   * 每条事件的 `modifiers` 与发出它那一刻的按下集合一致：修饰键自己的 keyDown 含自身，
   * keyUp 不含自身。含 Ctrl / Alt / Meta 时主键不附 `text` ——那时页面收到的是快捷键，
   * 附上文本会让输入框同时插进一个字符。
   *
   * 中途失败不在这里补抬起：按下的键留在按下表里，由调用方走收尾原语统一释放。
   */
  async pressStroke(sessionId: string, stroke: KeyStroke, timeoutMs?: number): Promise<void> {
    const limit = timeoutMs === undefined ? {} : { timeoutMs }
    const down: ModifierName[] = []
    const send = (params: Record<string, unknown>) =>
      this.send('Input.dispatchKeyEvent', params, { sessionId, ...limit })
    for (const name of stroke.modifiers) {
      const spec = MODIFIER_KEYS[name]
      down.push(name)
      await send({ type: 'rawKeyDown', ...keyFields(spec), modifiers: bitsOf(down) })
    }
    const modifiers = bitsOf(down)
    // 快捷键没有文本：Ctrl / Alt / Meta 按下时主键不产生字符。
    const text = down.some((n) => n !== 'Shift') ? undefined : stroke.key.text
    await send({
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      ...keyFields(stroke.key),
      modifiers,
      ...(text === undefined ? {} : { text }),
    })
    await send({ type: 'keyUp', ...keyFields(stroke.key), modifiers })
    for (let i = down.length - 1; i >= 0; i--) {
      const name = down[i] as ModifierName
      down.pop()
      await send({ type: 'keyUp', ...keyFields(MODIFIER_KEYS[name]), modifiers: bitsOf(down) })
    }
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

  /**
   * 订阅一个页会话上的协议事件，返回取消函数。
   *
   * 只服务一次调用：在发命令之前建立，结束时必须调返回的函数。不调的话订阅表会跟着
   * 轮数长，而且上一次调用的判断会被这一次的事件改写。`Page` 域的事件由
   * `Page.enable` 发布，页会话初始化时已经开过。
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

  /** 登记一个静默探针并返回它的页内 id。探针只数 DOM 变更，不查选择器、不动页面。 */
  async startProbe(sessionId: string, timeoutMs: number): Promise<number> {
    const created = await this.send<{ result: { value: { id?: number } } }>(
      'Runtime.evaluate',
      { expression: 'window.__qyworkProbe()', returnByValue: true },
      { sessionId, timeoutMs },
    )
    const id = created.result.value?.id
    if (typeof id !== 'number') throw new CdpError('静默探针没有登记成功')
    return id
  }

  /** 读一次探针。结果按 `ProbeRead` 判定，缺字段的读数不得当作就绪。 */
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

  /** 清掉一个页内等待器或探针并读回计数。计数是清理证据，不是调试输出。 */
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
   *
   * `deadline` 是整次收尾的绝对截止时刻，每条清理命令的超时从剩余时间取小。
   * 按页各给满额度的话，收尾时长随本客户端控制的页数线性增长。
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
    const left = (cap: number) =>
      deadline === undefined ? cap : Math.max(1, Math.min(cap, deadline - Date.now()))
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
    return { rejectedPending, waiterStats, keysReleased, mouseReleased, detached }
  }

  /** 把已按下未释放的键补一次 keyUp。走 teardown 身份，不是新的业务动作。 */
  async releaseHeldKeys(deadline?: number): Promise<string[]> {
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
          {
            sessionId: held.sessionId,
            teardown: 'keyup',
            timeoutMs:
              deadline === undefined ? 3_000 : Math.max(1, Math.min(3_000, deadline - Date.now())),
          },
        )
        released.push(key)
      } catch (err) {
        log.warn('browser', `收尾按键失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return released
  }

  /**
   * 把已按下未释放的鼠标键补一次 `mouseReleased`。走 teardown 身份，不是新的业务动作。
   *
   * 坐标取最后一次移动到的位置：在起点释放会让拖动落回原处，而那不是页面此刻的状态。
   */
  async releaseHeldMouse(deadline?: number): Promise<string[]> {
    const released: string[] = []
    for (const [key, held] of [...this.#heldMouse]) {
      this.#heldMouse.delete(key)
      try {
        await this.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseReleased',
            x: held.x,
            y: held.y,
            button: held.button,
            buttons: 0,
            clickCount: 1,
          },
          {
            sessionId: held.sessionId,
            teardown: 'mouseup',
            timeoutMs:
              deadline === undefined ? 3_000 : Math.max(1, Math.min(3_000, deadline - Date.now())),
          },
        )
        released.push(key)
      } catch (err) {
        log.warn('browser', `收尾鼠标失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return released
  }

  heldKeys(): string[] {
    return [...this.#heldKeys.keys()]
  }

  heldMouse(): string[] {
    return [...this.#heldMouse.keys()]
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

  /** 鼠标按下状态：按下登记、抬起摘掉、移动更新坐标。滚轮不改按下状态。 */
  #trackMouse(sessionId: string | undefined, params: Record<string, unknown>): void {
    const session = sessionId ?? ''
    const button = String(params.button ?? 'left')
    const key = `${session}|${button}`
    const type = params.type
    if (type === 'mousePressed') {
      this.#heldMouse.set(key, {
        sessionId: session,
        button,
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
      })
      return
    }
    if (type === 'mouseReleased') {
      this.#heldMouse.delete(key)
      return
    }
    if (type !== 'mouseMoved') return
    for (const held of this.#heldMouse.values()) {
      if (held.sessionId !== session) continue
      held.x = Number(params.x ?? held.x)
      held.y = Number(params.y ?? held.y)
    }
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
