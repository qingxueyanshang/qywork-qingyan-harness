/**
 * 与 `qy serve` 的连接层。
 *
 * 桌面 WebView 与手机浏览器使用同一份代码，区别只有两处：
 * - 令牌来源：桌面从注入的全局变量读取，手机从二维码携带的 URL fragment 读取。
 * - `origin` 字段：仅用于审计与「谁批准了权限」的跨端提示，不影响能力。
 *
 * 主要复杂度在重连。移动网络断线是常态，因此：
 * - 使用指数退避加抖动，避免服务端恢复时被全部客户端同时重连压垮。
 * - 重连时携带 `resume`（流身份与位置），由服务端补发缺口；无法补发时置 `resync`，
 *   由调用方重新获取全量数据。不得静默丢弃事件：界面停在不完整状态且没有任何提示，
 *   比明确报错更难排查。
 */

import type {
  AgentEvent,
  ClientCommand,
  ClientOrigin,
  CommandRejectedFrame,
  ConversationId,
  EventEnvelope,
  HelloErrFrame,
  HelloFrame,
  HelloOkFrame,
  ServerCapabilities,
} from '@qywork/core'
import { decodePairingUrl } from '@qywork/core'
import { workspace } from './store/ui.ts'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'unauthorized' | 'closed'

/**
 * 每个 REST 请求都携带所属项目。
 *
 * 在这一个出口统一添加，不在各调用点分别添加。服务端同时服务多个项目，
 * 缺少该参数时回落到最近打开的项目；切换项目的瞬间该回落是错误的：
 * 前端已切换到 B，而请求返回的仍是 A 的会话列表。
 *
 * 调用方已写入 `ws=` 时不覆盖（目前没有这类调用；覆盖调用方显式指定的参数
 * 是最难排查的一类问题）。首屏尚未确定项目时不携带，服务端回落到最近打开的项目，
 * 即首屏要显示的项目。
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
   * 交出整个信封，而不是拆开的 `event` 与 `seq`。所属会话记录在信封上
   * （`EventEnvelope.conversationId`），消费方必须据此丢弃不属于当前会话的事件：
   * 服务端的订阅过滤无法覆盖 `subscribe` 指令的往返窗口。
   * 拆开参数后该字段无法传递，接收方只能假定收到的事件都属于已订阅的会话。
   */
  onEvent(frame: EventEnvelope<AgentEvent>): void
  onState(state: ConnectionState, detail?: string): void
  /** 服务端无法补发时触发，调用方须重新获取全量数据。 */
  onResync(): void
  /**
   * 握手完成之后，服务端事件流身份发生了变化。
   *
   * 这是区分「同一连接断线后重连」与「sidecar 已替换为另一个进程」的唯一可靠依据。
   * 开发编排据此在后端完成替换后刷新整页，使页面与后端同时更新；
   * 普通断线重连不会触发。
   */
  onStreamChanged(): void
  onCapabilities(caps: ServerCapabilities): void
  /**
   * 握手报告的当前运行中会话。每次握手都必须整表替换：
   * 重连无法补齐缺口时，客户端持有的是断线前的数据，已执行完毕的轮次会持续显示为运行中。
   */
  onBusy(conversations: ConversationId[]): void
  /**
   * 指令被服务端拒绝。必须实现：不处理即为静默丢弃，用户的操作得不到任何反馈。
   */
  onRejected(frame: CommandRejectedFrame): void
}

interface Endpoint {
  base: string
  token: string
  origin: ClientOrigin
}

/**
 * 本类与浏览器之间的两个接缝。
 *
 * 用途是使重连语义可测试。不要把「握手被拒后是否重连」的判断放回消息回调：
 * 那样运行时依赖真实 WebSocket 与 `location` / `sessionStorage`，无法用测试锁定
 * 「版本不一致时不得无限重连」这一行为。
 *
 * 生产环境使用默认实现，测试传入替身 socket。这是接缝而不是开关：
 * 行为只有一套，只是 socket 来源有两个。
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
 * 优先级：URL fragment（扫码进入）> 注入的全局变量（Tauri）> 同源加空令牌。
 * fragment 读取后立即从地址栏清除：令牌留在地址栏中会随分享、截图与浏览器历史记录泄露。
 */
export function resolveEndpoint(): Endpoint {
  const injected = (globalThis as Record<string, unknown>).__QYWORK__ as
    | { token?: string; base?: string }
    | undefined

  if (location.hash.includes('t=')) {
    const decoded = decodePairingUrl(location.href)
    if (decoded?.token) {
      history.replaceState(null, '', `${location.pathname}${location.search}`)
      try {
        sessionStorage.setItem('qywork.token', decoded.token)
      } catch {
        // 隐私模式下 sessionStorage 可能不可用；影响仅限于刷新后需要重新扫码。
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
 * `detail` 是显示给用户的一句，`message` 是写入日志的一行。服务端的错误体
 * 是 `{ error, message }`，整段 JSON 显示在界面上会成为「409 /api/files/create:
 * {"error":"exists","message":「notes.md 已存在」}」，而用户需要的只有 `message` 字段。
 * 因此在此处取出 `message`；不是 JSON 时退回原文。
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
   * 服务端事件流的身份。`null` 表示尚未握手，此时 `lastSeq` 不能用于续传。
   *
   * 位置脱离流身份没有意义：sidecar 重启后 seq 从 0 重新计数，只报告一个数字
   * 会被判定为「已是最新」。因此这两个值只以 `resume` 整体出现，见 `HelloFrame`。
   */
  private streamId: string | null = null
  private attempt = 0
  private closed = false
  /**
   * 终态已连同具体原因报告过。
   *
   * `closed` 只表示「不再重连」，不包含原因。握手被拒时服务端发出 hello.err 后
   * 立即 close，两个事件相继到达：先报告 unauthorized（「令牌无效」），
   * 若 close 处理器随后无条件报告 closed（「连接已断开」），泛化的提示会覆盖
   * 能指导用户下一步操作的具体原因。
   */
  private terminalReported = false
  private readonly endpoint: Endpoint
  private readonly open: (url: string) => SocketLike
  /**
   * 已声明的订阅。`null` 表示尚未声明，与「声明了空集」含义不同。
   *
   * 该区分须逐层传到服务端：重连时 hello 帧携带它，服务端按同一规则解释
   * （`Subscriber.conversations`）。若以 `[]` 初始化、再用 `length` 判断是否携带，
   * 「明确订阅空集」会退化为「未声明」，服务端因此推送全部会话，
   * 切换项目后重连一次就会重新收到其他会话的事件。
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

  /** 连接是否已放弃重连。握手被拒或调用方主动 close 之后为真。 */
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
    /*
     * 已存在连接时不再新建。
     *
     * 服务端按连接注册订阅者，两条连接会产生两份相同的事件流，而回调的是同一个
     * `onEvent`：正文每个 token 显示两次，同一轮出现两条读数条（第二条为 0.0s，
     * 因为 `runStartedAt` 已被第一条清除）。断开时由 `close` 处理器把 `ws` 置为 null，
     * 重连经由 `scheduleReconnect`，因此本判断不会阻止正常重连。
     */
    if (this.ws) return
    if (!this.endpoint.token) {
      this.opts.onState('unauthorized', '未配对，请在桌面端扫码配对')
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
        // 判定 `!== null` 而不是 `.length`：空集须原样携带，见 `subscribed` 的注释。
        ...(this.subscribed !== null ? { subscribe: this.subscribed as never } : {}),
      }
      ws.send(JSON.stringify(hello))
    })

    ws.addEventListener('message', (e) => {
      // 此时尚未校验帧的形状：只声明分发所需的两处判据（`type` 与事件信封的
      // `seq`/`event`），识别出帧类型后各分支再使用协议中的完整类型。
      let msg: { type?: string; seq?: number; event?: unknown }
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }

      if (msg.type === 'hello.ok') {
        const ok = msg as HelloOkFrame
        // 握手成功后才重置退避计数：open 事件不代表服务端接受了该连接。
        this.attempt = 0
        // 事件流已更换（服务端重启过）或服务端放弃补发时，本地的 seq
        // 都不再是有效位置，统一对齐到服务端当前值。
        const previousStreamId = this.streamId
        const sameStream = ok.streamId === previousStreamId
        this.streamId = ok.streamId
        if (!sameStream || ok.resync) this.lastSeq = ok.currentSeq
        this.opts.onCapabilities(ok.capabilities)
        this.opts.onBusy(ok.busyConversations)
        this.opts.onState('ready')
        if (ok.resync) this.opts.onResync()
        // 首次握手没有之前的事件流，不得刷新；否则刷新后的新 client 会再次把首次连接
        // 判定为后端替换，形成无限刷新。只有已连接过一个事件流、现在取得另一个事件流时才通知。
        if (previousStreamId !== null && !sameStream) this.opts.onStreamChanged()
        return
      }
      if (msg.type === 'hello.err') {
        this.opts.onState('unauthorized', (msg as HelloErrFrame).message)
        this.terminalReported = true
        // 握手被拒是终态，不按 reason 分支。
        //
        // 服务端只返回 bad_token，重连多少次携带的仍是同一个令牌。
        //
        // 若出现可稍后恢复的原因（如连接数超限），在此处按 reason
        // 分支。现在不预留该分支：没有生产者的分支会被误认为生效的逻辑。
        this.closed = true
        return
      }
      if (msg.type === 'command.rejected') {
        this.opts.onRejected(msg as CommandRejectedFrame)
        return
      }
      if (typeof msg.seq === 'number' && msg.event) {
        const frame = msg as EventEnvelope<AgentEvent>
        /*
         * 已处理过的位置直接丢弃。投递必须幂等：断线补发的窗口与实时流可能重叠
         * （`bus.replayFrom` 按握手时刻的 `lastSeq` 计算缺口），补发的事件会与
         * 已收到的事件重复。重复投递不会报错，但会使正文每个 token 显示两次、
         * 同一轮出现两条读数条。
         *
         * 服务端 `seq` 从 1 开始（`bus.publish` 使用 `++this.seq`），因此初值 0 不会
         * 把第一帧误判为重复。
         */
        if (frame.seq <= this.lastSeq) return
        this.lastSeq = frame.seq
        this.opts.onEvent(frame)
      }
    })

    ws.addEventListener('close', () => {
      this.ws = null
      if (this.closed) {
        // 已报告过带原因的终态时，不再以泛化状态覆盖。
        if (!this.terminalReported) this.opts.onState('closed')
        return
      }
      this.scheduleReconnect()
    })

    // error 之后必然跟随 close，重连逻辑只挂在 close 上，避免退避计数推进两次。
    ws.addEventListener('error', () => {})
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.attempt++
    // 指数退避上限 15s，叠加 30% 抖动以错开同时重连的客户端。
    const backoff = Math.min(15_000, 400 * 2 ** Math.min(this.attempt, 6))
    const delay = backoff * (0.7 + Math.random() * 0.6)
    this.opts.onState('reconnecting', `${Math.round(delay / 1000)} 秒后重试`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /**
   * 发送一条指令。
   *
   * 连接不可用时必须有终态。写成 `if (OPEN) send()` 时，非 OPEN 状态下不抛错、
   * 不排队、不回执。切换模型、切换思考强度、中断、重试、发送消息都经由此方法，
   * 且 `setModel` 有意不做乐观更新（服务端广播后才更新显示）；两者叠加时，
   * 切换模型后界面没有变化，与「服务端尚未响应」无法区分，
   * 即 C1 第 2 款所指的静默 no-op。
   *
   * 通过已有的拒绝回执通道报告，而不是抛出异常：五个调用点都是同步 `void` 函数，
   * 各自 try/catch 会把同一处理重复五次。
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
      // 仍在自动重连时不提示重新打开应用：重连成功后直接重试即可。
      message: this.closed ? '连接已断开，请重新打开应用' : '连接已断开，正在重新连接',
      // 幂等键原样回传，与服务端回执的规则一致：接收方据此定位对应的操作，
      // 按回车时乐观写入的忙碌状态须依靠它才能撤销。
      ...('clientRequestId' in cmd ? { clientRequestId: cmd.clientRequestId } : {}),
    })
  }

  /**
   * 声明该连接接收哪些会话的事件。
   *
   * 空数组表示不接收任何会话，而不是接收全部。服务端按同一规则解释
   * （`Subscriber.conversations`）：未声明表示全部接收，空集表示明确退订。
   * 切换项目时必须区分二者：此时旧会话不应继续推送，而新会话尚未选定。
   */
  subscribe(conversationIds: string[]): void {
    this.subscribed = conversationIds
    // 未连通时只记录：下一次握手的 hello 帧携带它。不要改为经 `send` 报告 `not_ready`：
    // 服务重启后的一秒重连期间切换子会话页，会显示一条与实际状态不符的断线提示。
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.send({ type: 'subscribe', conversationIds: conversationIds as never })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  /** REST 请求。令牌经由 Authorization 头传递，不放入 query（避免写入访问日志）。 */
  async api<T>(path: string, init?: RequestInit): Promise<T> {
    // 仅在调用方未指定时才默认 JSON。若在之后无条件覆盖，
    // 二进制上传（附件）的 `image/png` 会被改写为 `application/json`，
    // 服务端据此归类，每张图片都会被识别为普通文件。
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

  /**
   * 取得原始 `Response`，不解析 JSON。
   *
   * 用于读取二进制内容（附件缩略图）。此处不判定 `res.ok`：调用方须按状态码
   * 分别处理（404 表示文件不存在，413 表示超出大小上限，两者在界面上都表现为无法显示），
   * 在此处抛错会使调用方无法取得状态码。
   */
  raw(path: string, init?: RequestInit): Promise<Response> {
    const given = new Headers(init?.headers ?? {})
    given.set('authorization', `Bearer ${this.endpoint.token}`)
    return fetch(`${this.endpoint.base}${withWorkspace(path)}`, { ...init, headers: given })
  }

  /**
   * 工作区文件的直链，用作 `<img>` / `<video>` / `<audio>` 的 `src`。
   *
   * 媒体元素自行发起请求，无法携带 Authorization 头，令牌只能放在查询串中（服务端对 `/api/`
   * 接受 query 令牌，与 WebSocket 握手相同；服务端不记录请求地址）。直链使视频可边播放边加载、
   * 可拖动进度，内存占用不随文件大小增长。
   * `version`（修改时间）写入地址：文件修改后地址随之变化，元素重新加载。
   */
  fileUrl(path: string, version?: number): string {
    const query = `/api/files/raw?path=${encodeURIComponent(path)}${version === undefined ? '' : `&v=${version}`}`
    return `${this.endpoint.base}${withWorkspace(query)}&token=${encodeURIComponent(this.endpoint.token)}`
  }
}
