/**
 * 与 `qy serve` 的连接层。
 *
 * 桌面 WebView 和手机浏览器用的是**同一份**代码。区别只有两处：
 * - 令牌来源：桌面从注入的全局变量拿，手机从二维码带来的 URL fragment 拿。
 * - `origin` 字段：仅用于审计和「谁批准了权限」的跨端提示，不影响能力。
 *
 * 重连是这里的主要复杂度。手机在地铁里断网是常态，所以：
 * - 指数退避 + 抖动，避免服务端刚恢复就被一堆客户端同时打爆。
 * - 重连时带 `resume`（流身份 + 位置），服务端补发缺口；补不上就置 `resync`，
 *   由调用方重新拉全量。**绝不静默丢事件**——UI 停在不完整状态却自以为正确，
 *   比明确报错糟糕得多。
 */

import type {
  AgentEvent,
  ClientCommand,
  ClientOrigin,
  CommandRejectedFrame,
  EventEnvelope,
  HelloFrame,
  ServerCapabilities,
} from '@qywork/core'
import { decodePairingUrl } from '@qywork/core'
import { workspace } from './store/ui.ts'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'unauthorized' | 'closed'

/**
 * 每条 REST 都带上「问的是哪个项目」。
 *
 * **在这一个出口统一加，不在几十个调用点各写一遍。** 服务端一次服务多个项目，
 * 缺这个参数它只能落到「最近打开的那个」——那在切换的一瞬间就是错的：
 * 前端已经切到 B，而这条请求还回着 A 的会话列表。
 *
 * 调用方自己写了 `ws=` 就不覆盖（目前没有这种调用，留着是因为覆盖别人显式写的
 * 参数是那种查半天才找得到的坑）。首屏还不知道自己在哪个项目时不带，
 * 服务端回落到最近打开的那个——那正是首屏要显示的东西。
 */
function withWorkspace(path: string): string {
  const id = workspace()?.id
  if (!id || path.includes('ws=')) return path
  return `${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(id)}`
}

export interface ClientOptions {
  /**
   * 收到一帧。
   *
   * **交出整个信封，不是拆开的 `event` + `seq`。** 归属会话在信封上
   * （`EventEnvelope.conversationId`），而消费方必须据此丢弃不属于当前会话的事件——
   * 服务端的订阅过滤挡不住 `subscribe` 指令的往返窗口，那一段是物理存在的。
   * 拆参数的话这个字段就传不过去，接收方只能盲信「我收到的都是我订阅的」。
   */
  onEvent(frame: EventEnvelope<AgentEvent>): void
  onState(state: ConnectionState, detail?: string): void
  /** 服务端补发不上时触发，调用方须重拉全量。 */
  onResync(): void
  onCapabilities(caps: ServerCapabilities): void
  /**
   * 指令被服务端拒绝。**必须实现**——不处理就等同于回到从前的静默吞掉：
   * 用户点了按钮，什么都没发生，也没有任何解释。
   */
  onRejected(frame: CommandRejectedFrame): void
}

interface Endpoint {
  base: string
  token: string
  origin: ClientOrigin
}

/**
 * 这个类和浏览器之间的两个接缝。
 *
 * 存在的唯一理由是**让重连语义能被测**。之前那条「握手被拒之后还要不要重连」
 * 的判断埋在消息回调里，跑起来得有真 WebSocket 和 `location` / `sessionStorage`，
 * 于是它一直没有测试——而它恰恰出过一个 bug：版本对不上时无限重连，
 * 界面显示成「N 秒后重试」。
 *
 * 生产路径走默认实现，测试传自己的假 socket。**不是开关，是接缝**：
 * 没有第二套行为，只有第二个 socket 来源。
 */
export interface SocketLike {
  addEventListener(type: string, fn: (e: { data?: unknown }) => void, opts?: unknown): void
  send(data: string): void
  close(): void
  readonly readyState: number
}

export interface ClientDeps {
  endpoint: Endpoint
  open(url: string): SocketLike
}

/**
 * 解析接入点。
 *
 * 优先级：URL fragment（扫码进来的）> 注入的全局变量（Tauri）> 同源 + 空令牌。
 * fragment 读完立刻从地址栏抹掉——令牌留在地址栏里会被分享、被截图、
 * 被浏览器历史记录留存。
 */
export function resolveEndpoint(): Endpoint {
  const injected = (globalThis as Record<string, any>).__QYWORK__ as
    | { token?: string; base?: string }
    | undefined

  if (location.hash.includes('t=')) {
    const decoded = decodePairingUrl(location.href)
    if (decoded?.token) {
      history.replaceState(null, '', `${location.pathname}${location.search}`)
      try {
        sessionStorage.setItem('qywork.token', decoded.token)
      } catch {
        // 隐私模式下 sessionStorage 可能不可用；仅影响刷新后要重扫，不致命。
      }
      return { base: decoded.url || location.origin, token: decoded.token, origin: 'mobile' }
    }
  }

  if (injected?.token) {
    return { base: injected.base ?? location.origin, token: injected.token, origin: 'desktop' }
  }

  let stored = ''
  try {
    stored = sessionStorage.getItem('qywork.token') ?? ''
  } catch {
    stored = ''
  }
  return {
    base: location.origin,
    token: stored,
    origin: isMobileViewport() ? 'mobile' : 'desktop',
  }
}

function isMobileViewport(): boolean {
  return matchMedia('(max-width: 820px)').matches
}

/**
 * REST 调用失败。
 *
 * **`detail` 是给用户看的那一句，`message` 是给日志看的那一行。** 服务端的错误体
 * 是 `{ error, message }`，整段 JSON 贴到界面上就是「409 /api/files/create:
 * {"error":"exists","message":"notes.md 已存在"}」——用户要看的只有最后四个字。
 * 所以这里当场把 `message` 抠出来；不是 JSON 就退回原文。
 */
export class ApiError extends Error {
  readonly detail: string

  constructor(
    readonly status: number,
    path: string,
    body: string,
  ) {
    const parsed = (() => {
      try {
        const obj = JSON.parse(body) as { message?: unknown; error?: unknown }
        const m = obj.message ?? obj.error
        return typeof m === 'string' && m ? m : ''
      } catch {
        return ''
      }
    })()
    super(`${status} ${path}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'ApiError'
    this.detail = parsed || body.slice(0, 200) || `请求失败（${status}）`
  }
}

export class QyClient {
  private ws: SocketLike | null = null
  private lastSeq = 0
  /**
   * 服务端那条事件流的身份。**`null` = 还没握过手，此时 `lastSeq` 无处安放。**
   *
   * 位置离开流身份就没有意义：sidecar 重启后 seq 从 0 重新数，光报一个数字
   * 会被判成「已是最新」。所以这两个值只以 `resume` 整体出现，见 `HelloFrame`。
   */
  private streamId: string | null = null
  private attempt = 0
  private closed = false
  /**
   * 终态已经带着具体原因报过了。
   *
   * `closed` 只说「别再重连」，说不出**为什么**。握手被拒时服务端发完 hello.err
   * 立刻 close，两个事件前后脚到：先报了 unauthorized（「令牌无效」），
   * 紧接着 close 处理器又无条件报一遍 closed（「连接已断开」），
   * 用户最终看到的是后面那句泛化的——而真正能指导他下一步的是前面那句。
   */
  private terminalReported = false
  private readonly endpoint: Endpoint
  private readonly open: (url: string) => SocketLike
  /**
   * 声明过的订阅。**`null` = 还没声明过，和「声明了空集」是两件事。**
   *
   * 这个区分要一路传到服务端：重连时 hello 帧带着它，服务端按同一口径解释
   * （`Subscriber.conversations`）。写成 `[]` 起步、再用 `length` 判断要不要带上的话，
   * 「我明确一条都不要」会被压成「我没说过」，服务端于是给全订阅——
   * 切项目之后重连一次，串台就全回来了。
   */
  private subscribed: string[] | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly opts: ClientOptions,
    deps?: ClientDeps,
  ) {
    this.endpoint = deps?.endpoint ?? resolveEndpoint()
    this.open = deps?.open ?? ((url) => new WebSocket(url) as unknown as SocketLike)
  }

  /** 这条连接是不是已经放弃重连。握手被拒、或调用方主动 close 之后为真。 */
  get terminated(): boolean {
    return this.closed
  }

  get token(): string {
    return this.endpoint.token
  }
  get base(): string {
    return this.endpoint.base
  }
  get paired(): boolean {
    return this.endpoint.token.length > 0
  }

  connect(): void {
    if (this.closed) return
    if (!this.endpoint.token) {
      this.opts.onState('unauthorized', '未配对：请在桌面端扫码')
      return
    }

    this.opts.onState(this.attempt === 0 ? 'connecting' : 'reconnecting')

    const wsBase = this.endpoint.base.replace(/^http/, 'ws')
    const url = `${wsBase}/stream?token=${encodeURIComponent(this.endpoint.token)}&origin=${this.endpoint.origin}`
    const ws = this.open(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      const hello: HelloFrame = {
        type: 'hello',
        token: this.endpoint.token,
        origin: this.endpoint.origin,
        ...(this.streamId && this.lastSeq > 0
          ? { resume: { streamId: this.streamId, lastSeq: this.lastSeq } }
          : {}),
        // 判 `!== null` 而不是 `.length`：空集要原样带上去，见 `subscribed` 的注释。
        ...(this.subscribed !== null ? { subscribe: this.subscribed as never } : {}),
      }
      ws.send(JSON.stringify(hello))
    })

    ws.addEventListener('message', (e) => {
      let msg: any
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }

      if (msg.type === 'hello.ok') {
        // 握手成功才重置退避计数——open 事件不代表服务端接受了我们。
        this.attempt = 0
        // 换了一条流（服务端重启过）与服务端放弃补发，两种情形下手里那个 seq
        // 都不再是有效位置，一律对齐到服务端当前值。
        const sameStream = msg.streamId === this.streamId
        this.streamId = msg.streamId
        if (!sameStream || msg.resync) this.lastSeq = msg.currentSeq
        this.opts.onCapabilities(msg.capabilities)
        this.opts.onState('ready')
        if (msg.resync) this.opts.onResync()
        return
      }
      if (msg.type === 'hello.err') {
        this.opts.onState('unauthorized', msg.message)
        this.terminalReported = true
        // **握手被拒是终态**，不按 reason 分支。
        //
        // 服务端只会发 `bad_token`，而它重连一万次带的还是同一个令牌。
        //
        // 以后真出现「等等就好」的原因（连接数超限之类），在这里按 reason
        // 分支。现在不预留那个分支：没有生产者的分支只会让人以为它生效过。
        this.closed = true
        return
      }
      if (msg.type === 'command.rejected') {
        this.opts.onRejected(msg as CommandRejectedFrame)
        return
      }
      if (typeof msg.seq === 'number' && msg.event) {
        const frame = msg as EventEnvelope<AgentEvent>
        this.lastSeq = Math.max(this.lastSeq, frame.seq)
        this.opts.onEvent(frame)
      }
    })

    ws.addEventListener('close', () => {
      this.ws = null
      if (this.closed) {
        // 已经报过带原因的终态就不要再盖一层泛化的。
        if (!this.terminalReported) this.opts.onState('closed')
        return
      }
      this.scheduleReconnect()
    })

    // error 之后必然跟一个 close，重连逻辑只挂在 close 上，避免退避被加倍推进。
    ws.addEventListener('error', () => {})
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.attempt++
    // 指数退避封顶 15s，叠 30% 抖动打散同时重连的客户端。
    const backoff = Math.min(15_000, 400 * 2 ** Math.min(this.attempt, 6))
    const delay = backoff * (0.7 + Math.random() * 0.6)
    this.opts.onState('reconnecting', `${Math.round(delay / 1000)} 秒后重试`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /**
   * 发一条指令。
   *
   * **连接不可用时必须有终态。** 写成 `if (OPEN) send()` 的话，不在 OPEN 就什么也
   * 不做：不抛、不排队、不回执。而切模型、切思考强度、中断、重试、发消息全走这里，
   * 且 `setModel` 刻意不做乐观更新（等服务端广播回来才改显示）。两件事叠在一起的
   * 结果是：用户点了模型，界面一动不动，和「服务端还没回」完全无法区分。
   * 这正是 C1 第 2 款点名的形状——静默 no-op 比明确报错糟得多。
   *
   * 落在已有的拒绝回执通道上，而不是抛出：五个调用点都是同步 `void` 函数，
   * 让它们各自 try/catch 是把同一件事写五遍。
   */
  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
      return
    }
    this.opts.onRejected({
      type: 'command.rejected',
      command: cmd.type,
      reason: 'not_ready',
      message: this.closed ? '连接已断开，请重新打开应用' : '正在重连，稍后再试',
    })
  }

  /**
   * 声明这条连接要看哪些会话。
   *
   * **空数组是「一条都不要」，不是「全都要」。** 服务端按同一口径解释
   * （`Subscriber.conversations`）：没声明过 = 全收，空集 = 明确退订。
   * 这个区分是切项目时必须的——那一刻旧会话已经不该再推了，而新的还没选好。
   */
  subscribe(conversationIds: string[]): void {
    this.subscribed = conversationIds
    this.send({ type: 'subscribe', conversationIds: conversationIds as never })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  /** REST 请求。令牌走 Authorization 头，不放 query（不进访问日志）。 */
  async api<T>(path: string, init?: RequestInit): Promise<T> {
    // 只在调用方**没有**自己指定时才默认 JSON。写在后面无条件覆盖的话，
    // 二进制上传（附件）的 `image/png` 会被改写成 `application/json`，
    // 服务端据此归类，结果是每张图都被当成文件。
    const given = new Headers(init?.headers ?? {})
    if (init?.body && !given.has('content-type')) {
      given.set('content-type', 'application/json')
    }
    given.set('authorization', `Bearer ${this.endpoint.token}`)
    const res = await fetch(`${this.endpoint.base}${withWorkspace(path)}`, {
      ...init,
      headers: given,
    })
    if (!res.ok) {
      throw new ApiError(res.status, path, await res.text().catch(() => ''))
    }
    return (await res.json()) as T
  }
}
