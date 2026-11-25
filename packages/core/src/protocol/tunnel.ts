/**
 * 远程隧道的帧格式：电脑端服务与云端隧道中心之间的一条 WebSocket，复用多条 HTTP 请求与 WebSocket 连接。
 *
 * 不变量：
 * - 流（`sid`）只由云端打开，电脑端只应答；`sid` 在一条隧道内唯一。
 * - 控制帧是 JSON 文本帧，经 `parseControl` 校验后才处理；数据帧是二进制帧：1 字节类型 + 4 字节 `sid`（大端）+ 负载。
 * - HTTP 请求体与响应体按流计窗口：发送端在窗口余量不足下一块时暂停读取数据源（`pumpBody`），接收端的消费方读取后以 `window` 帧归还
 *   （`TunnelInbound`）。接收端排队的字节超过窗口时视为对端违反协议，调用方关闭该流，因此每条流在任一端占用的内存不超过一个窗口。
 * - 窗口由接收端在握手中声明（`hello` 与 `welcome` 的 `window`、`connectionWindow`）：`window` 为每条流的窗口，
 *   `connectionWindow` 为整条隧道全部流在途字节之和的上限。未声明时流窗口为 `TUNNEL_WINDOW`、不限整条隧道。
 *   接收端只对声明了窗口的对端检查整条隧道的排队量（`TunnelBudget`）：不声明窗口的发送端不知道这一上限。
 * - 请求体与响应体经 `TunnelOutbound` 发送：各流轮流发出，整条隧道的在途字节不超过对端的 `connectionWindow`，
 *   并按往返时间的排队延迟收放（`rtt`）；控制帧与 WebSocket 消息不排队、直接写入连接，不等待请求体与响应体。
 * - WebSocket 消息不计窗口：消息是 `/stream` 的事件与指令，单条有界。
 * - 协议版本由云端裁决：`hello.protocol` 不在云端支持范围内时以 `TUNNEL_CLOSE.outdated` 关闭，电脑端不再重连。
 */

export const TUNNEL_PROTOCOL_VERSION = 2

/** 云端接口来源上的隧道入口。 */
export const TUNNEL_PATH = '/tunnel'

/** 对端未在握手中声明窗口时每条流的窗口（字节）。 */
export const TUNNEL_WINDOW = 1024 * 1024

/**
 * 本端声明的每条流的窗口（字节）。单条流的速度上限为窗口除以往返时间：往返 470 ms 时 1 MB 窗口实测 1.86 MB/s，
 * 4 MB 窗口 6.2–7.8 MB/s。
 */
export const TUNNEL_STREAM_WINDOW = 4 * 1024 * 1024

/** 本端声明的整条隧道的窗口（字节）：一条隧道在接收端排队的字节不超过它，与流数无关（流数上限 256）。 */
export const TUNNEL_CONNECTION_WINDOW = 16 * 1024 * 1024

/**
 * 单个数据帧的负载上限（字节）。在途上限按帧计算余量（`QUANTUM`）：帧越大，慢速线路上发出一帧所需的时间越长，
 * 排在其后的控制帧等待越久；1 MB/s 的上行上 16 KB 约 16 ms。接收端不检查帧的大小，不声明窗口的发送端发出的 64 KB 帧照常接收。
 */
export const TUNNEL_CHUNK = 16 * 1024

/** 电脑端发送 `ping` 的间隔；云端应答 `pong`。 */
export const TUNNEL_PING_MS = 25_000

/** 电脑端超过该时长未收到云端任何帧时，视为连接已断开并重连（休眠唤醒后 TCP 连接可能已失效而无关闭事件）。 */
export const TUNNEL_DEAD_MS = 60_000

/**
 * 隧道的 WebSocket 关闭码。`deviceRevoked` 与 `outdated` 是终态：电脑端分别删除本地的云端接口、提示更新应用，均不再重连；
 * `restarting` 立即重连；其余按退避重连。
 */
export const TUNNEL_CLOSE = {
  badHello: 4400,
  deviceRevoked: 4401,
  invalidKey: 4402,
  accountBanned: 4403,
  /** 同一设备建立了另一条隧道，旧连接被关闭。 */
  replaced: 4409,
  outdated: 4426,
  /** 云端进程即将停止（部署）。 */
  restarting: 4503,
} as const

export type TunnelHeaders = [string, string][]

export type TunnelNotifyEvent = 'run.finished' | 'run.error'

export type TunnelControl =
  /**
   * `remote`：本机是否开启远程访问。为 false 时云端不登记该设备的设备页面，隧道只用于推送。
   * 协议 2 的电脑端不带此字段，且只在开启远程访问时连接，云端按缺省为 true 判定。
   */
  | ({ type: 'hello'; protocol: number; key: string; remote?: boolean } & TunnelWindows)
  | ({ type: 'welcome' } & TunnelWindows)
  | { type: 'ping' }
  | { type: 'pong' }
  /** 请求体随后以数据帧发送，以 `end` 结束；没有请求体时紧接一个 `end`。 */
  | { type: 'http.open'; sid: number; method: string; path: string; headers: TunnelHeaders }
  | { type: 'http.head'; sid: number; status: number; headers: TunnelHeaders }
  | { type: 'ws.open'; sid: number; path: string; headers: TunnelHeaders }
  | { type: 'ws.accept'; sid: number }
  /** 发送端的数据已全部发出。 */
  | { type: 'end'; sid: number }
  /**
   * 中止该流；对 WebSocket 流即关闭连接，`code` 与 `reason` 转交给另一端。
   *
   * `peerCode`：云端在手机一侧观察到的原始关闭码，只供电脑端写入日志。`code` 须为可发送的关闭码，
   * 1001（页面离开）与 1006（未收到关闭帧即断开，网络中断或页面被系统冻结）都记为 1000，
   * 不另带此字段时电脑端无法区分断开的原因。未登记此字段的电脑端忽略它。
   */
  | { type: 'close'; sid: number; code?: number; reason?: string; peerCode?: number }
  | { type: 'window'; sid: number; bytes: number }
  | { type: 'pair.request'; rid: string }
  | { type: 'pair.reply'; rid: string; token: string; deviceName: string }
  | { type: 'notify'; event: TunnelNotifyEvent; conversationId: string; title: string }
  | { type: TunnelPush }

/**
 * 云端发给电脑端的推送帧，电脑端收到后重新读取对应的内容：
 * - `catalog.changed`：管理员改动了型号或上游接口，型号清单与价格已变（`/v1/catalog`）；
 * - `support.changed`：本账号的客服对话有新消息（客服回复，或本账号在另一台电脑上发送）；
 * - `announcements.changed`：公告已发布、修改、撤回或删除。
 * 只是通知，不带内容：内容仍以设备密钥或公开接口读取。未登记该帧类型的电脑端忽略它。
 */
export type TunnelPush = 'catalog.changed' | 'support.changed' | 'announcements.changed'

/** 接收端在握手中声明的窗口（字节）；协议 2 中这两个字段可以缺省。 */
export interface TunnelWindows {
  window?: number
  connectionWindow?: number
}

/**
 * 发送方按对端声明的窗口：每条流的窗口与整条隧道的上限。未声明或小于一帧（`TUNNEL_CHUNK`）时按未声明处理：
 * 流窗口为 `TUNNEL_WINDOW`，整条隧道不限。小于一帧的流窗口会使发送方永远等待。
 */
export function peerWindows(frame: TunnelWindows): { stream: number; connection: number } {
  const usable = (n: number | undefined) => n !== undefined && n >= TUNNEL_CHUNK
  return {
    stream: usable(frame.window) ? frame.window! : TUNNEL_WINDOW,
    connection: usable(frame.connectionWindow) ? frame.connectionWindow! : Number.POSITIVE_INFINITY,
  }
}

/** 本端在握手中声明的窗口。 */
export const OWN_WINDOWS: Required<TunnelWindows> = {
  window: TUNNEL_STREAM_WINDOW,
  connectionWindow: TUNNEL_CONNECTION_WINDOW,
}

/**
 * `path`：以 `/` 开头的字符串。电脑端把它直接拼接在 `http://127.0.0.1:<端口>` 之后，
 * 不以 `/` 开头时 `@127.0.0.1:<另一端口>/x` 会使前半部分成为用户信息，请求发往本机的另一个端口。
 */
type FieldKind = 'string' | 'number' | 'headers' | 'path' | 'string?' | 'number?' | 'boolean?'

/** 每种控制帧的字段与类型。`parseControl` 只按此表校验，新增帧类型时在此登记。 */
const FIELDS: { [T in TunnelControl['type']]: Record<string, FieldKind> } = {
  hello: {
    protocol: 'number',
    key: 'string',
    remote: 'boolean?',
    window: 'number?',
    connectionWindow: 'number?',
  },
  welcome: { window: 'number?', connectionWindow: 'number?' },
  ping: {},
  pong: {},
  'http.open': { sid: 'number', method: 'string', path: 'path', headers: 'headers' },
  'http.head': { sid: 'number', status: 'number', headers: 'headers' },
  'ws.open': { sid: 'number', path: 'path', headers: 'headers' },
  'ws.accept': { sid: 'number' },
  end: { sid: 'number' },
  close: { sid: 'number', code: 'number?', reason: 'string?', peerCode: 'number?' },
  window: { sid: 'number', bytes: 'number' },
  'pair.request': { rid: 'string' },
  'pair.reply': { rid: 'string', token: 'string', deviceName: 'string' },
  notify: { event: 'string', conversationId: 'string', title: 'string' },
  'catalog.changed': {},
  'support.changed': {},
  'announcements.changed': {},
}

function fieldOk(value: unknown, kind: FieldKind): boolean {
  if (kind === 'boolean?') return value === undefined || typeof value === 'boolean'
  if (kind === 'string?') return value === undefined || typeof value === 'string'
  if (kind === 'number?') return value === undefined || Number.isInteger(value)
  if (kind === 'number') return Number.isInteger(value)
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'path') return typeof value === 'string' && value.startsWith('/')
  return (
    Array.isArray(value) &&
    value.every(
      (h) =>
        Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string',
    )
  )
}

/** 解析一个控制帧；不是 JSON、类型未登记或字段类型不符时返回 null。 */
export function parseControl(raw: string): TunnelControl | null {
  let frame: unknown
  try {
    frame = JSON.parse(raw)
  } catch {
    return null
  }
  if (!frame || typeof frame !== 'object') return null
  const type = (frame as { type?: unknown }).type
  if (typeof type !== 'string' || !Object.hasOwn(FIELDS, type)) return null
  const fields = FIELDS[type as TunnelControl['type']]
  for (const [name, kind] of Object.entries(fields)) {
    if (!fieldOk((frame as Record<string, unknown>)[name], kind)) return null
  }
  return frame as TunnelControl
}

/** 数据帧的类型：HTTP 请求体或响应体的一块、WebSocket 的文本消息、WebSocket 的二进制消息。 */
export const TUNNEL_DATA = { body: 0, text: 1, binary: 2 } as const
export type TunnelDataKind = (typeof TUNNEL_DATA)[keyof typeof TUNNEL_DATA]

export function encodeData(kind: TunnelDataKind, sid: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length)
  frame[0] = kind
  new DataView(frame.buffer).setUint32(1, sid)
  frame.set(payload, 5)
  return frame
}

/** 解码数据帧；长度不足或类型未知时返回 null。负载与原帧共用内存。 */
export function decodeData(
  frame: Uint8Array,
): { kind: TunnelDataKind; sid: number; payload: Uint8Array } | null {
  if (frame.length < 5) return null
  const kind = frame[0]
  if (kind !== TUNNEL_DATA.body && kind !== TUNNEL_DATA.text && kind !== TUNNEL_DATA.binary) {
    return null
  }
  const sid = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
  return { kind, sid, payload: frame.subarray(5) }
}

/**
 * 经隧道转发时去除的请求头与响应头：逐跳头、`host`（由接收端的地址决定）、`content-length`（转发时以分块传输，长度由数据帧决定）
 * 与 WebSocket 握手头（接收端自行完成握手）。
 */
const NOT_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
  'content-length',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
])

export function tunnelHeaders(headers: Headers): TunnelHeaders {
  const out: TunnelHeaders = []
  headers.forEach((value, name) => {
    if (!NOT_FORWARDED.has(name.toLowerCase())) out.push([name, value])
  })
  return out
}

/** WebSocket 关闭码中可由应用发送的部分（1000 与 3000–4999）；其余（如 1006）转交时记为 1000。 */
export function sendableCloseCode(code: number | undefined): number {
  return code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000
}

/** 发送端的流窗口，初值为对端声明的流窗口。一条流只有一个发送方（`pumpBody`），因此只保留一个等待者。 */
export class TunnelCredit {
  private available: number
  private waiter: (() => void) | null = null
  private closed = false

  constructor(window: number = TUNNEL_WINDOW) {
    this.available = window
  }

  grant(bytes: number): void {
    this.available += bytes
    this.release()
  }

  /** 流已关闭：等待中的发送方立即返回。 */
  close(): void {
    this.closed = true
    this.release()
  }

  /**
   * 等待窗口余量不小于 `bytes`（不超过 `TUNNEL_CHUNK`）后占用；流已关闭时返回 false。
   * 不要改为「余量大于 0 即占用」：数据源的块不按 `TUNNEL_CHUNK` 对齐时，在途字节会超出窗口，
   * 接收端读取较慢时排队超过窗口，按违反协议关闭该流。
   */
  async take(bytes: number): Promise<boolean> {
    while (this.available < bytes && !this.closed) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
    if (this.closed) return false
    this.available -= bytes
    return true
  }

  private release(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }
}

/**
 * 请求体与响应体的发送方。`data` 返回 false 或兑现为 false 时该流已被丢弃，发送方停止读取数据源。
 * 测试与直接写入连接的调用方可以同步返回。
 */
export interface TunnelSender {
  data(frame: Uint8Array): unknown
  control(frame: TunnelControl): void
}

/**
 * 把数据源按窗口分块发出，读完后发送 `end`。流在发送途中被关闭时返回 false（不发送 `end`，并取消数据源）。
 * 读取数据源出错时抛出，由调用方发送 `close`。
 */
export async function pumpBody(
  source: ReadableStream<Uint8Array> | null,
  sid: number,
  credit: TunnelCredit,
  send: TunnelSender,
): Promise<boolean> {
  if (source) {
    const reader = source.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let at = 0; at < value.length; at += TUNNEL_CHUNK) {
        const piece = value.subarray(at, at + TUNNEL_CHUNK)
        if (
          !(await credit.take(piece.length)) ||
          (await send.data(encodeData(TUNNEL_DATA.body, sid, piece))) === false
        ) {
          await reader.cancel().catch(() => {})
          return false
        }
      }
    }
  }
  send.control({ type: 'end', sid })
  return true
}

/**
 * 接收端一条隧道全部流的排队量（字节）。`limit` 为本端声明的 `connectionWindow`；对端未声明窗口时为无穷大，
 * 不检查：它不知道这一上限。
 */
export class TunnelBudget {
  queued = 0
  constructor(readonly limit: number = Number.POSITIVE_INFINITY) {}
}

/**
 * 接收端的流：数据帧经 `push` 进入，消费方从 `readable` 读取；读取的字节累计到 `GRANT_STEP` 与窗口四分之一中的较小者，
 * 或读取后排队为空时，经 `consumed` 归还。
 * `readable` 不预读（highWaterMark 为 0），因此排队的字节只取决于发送端是否遵守窗口。`window` 为本端声明的流窗口，
 * `budget` 为所在隧道的排队量。
 */
export class TunnelInbound {
  readonly readable: ReadableStream<Uint8Array>
  private queue: Uint8Array[] = []
  private queued = 0
  private ungranted = 0
  private state: 'open' | 'ended' | 'failed' | 'cancelled' = 'open'
  private error: Error | null = null
  private wake: (() => void) | null = null

  constructor(
    consumed: (bytes: number) => void,
    cancelled: () => void,
    private readonly window: number = TUNNEL_WINDOW,
    private readonly budget: TunnelBudget = new TunnelBudget(),
  ) {
    this.readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (this.queue.length === 0 && this.state === 'open') {
            await new Promise<void>((resolve) => {
              this.wake = resolve
            })
          }
          if (this.state === 'failed') {
            controller.error(this.error)
            return
          }
          const chunk = this.queue.shift()
          if (!chunk) {
            controller.close()
            return
          }
          this.dequeue(chunk.length)
          controller.enqueue(chunk)
          this.ungranted += chunk.length
          // 排队读空时立即归还：发送调度的在途上限由全部流共享，各流在途都不足一个归还粒度时，只按粒度归还会使全部流停止。
          if (this.queue.length === 0 || this.ungranted >= Math.min(GRANT_STEP, this.window / 4)) {
            consumed(this.ungranted)
            this.ungranted = 0
          }
        },
        cancel: () => {
          if (this.state !== 'open' && this.state !== 'ended') return
          this.state = 'cancelled'
          this.discard()
          cancelled()
        },
      },
      { highWaterMark: 0 },
    )
  }

  /**
   * 写入一块数据。本流排队的字节超过流窗口，或隧道的排队量超过整条隧道的窗口时返回 false：对端未遵守窗口，
   * 调用方关闭该流。
   */
  push(chunk: Uint8Array): boolean {
    if (this.state !== 'open') return true
    this.queued += chunk.length
    this.budget.queued += chunk.length
    if (this.queued > this.window || this.budget.queued > this.budget.limit) return false
    // 负载与接收到的整帧共用内存，复制后再排队，使整帧可以释放。
    this.queue.push(chunk.slice())
    this.signal()
    return true
  }

  /** 对端已发出全部数据；排队的数据读完后结束。 */
  end(): void {
    if (this.state !== 'open') return
    this.state = 'ended'
    this.signal()
  }

  /** 流被中止：丢弃排队的数据，读取方收到错误。 */
  fail(error: Error): void {
    if (this.state !== 'open' && this.state !== 'ended') return
    this.state = 'failed'
    this.error = error
    this.discard()
    this.signal()
  }

  private dequeue(bytes: number): void {
    this.queued -= bytes
    this.budget.queued -= bytes
  }

  /** 丢弃排队的数据，归还隧道的排队量（含 `push` 判定超出时已计入、未排队的一块）。 */
  private discard(): void {
    this.budget.queued -= this.queued
    this.queued = 0
    this.queue = []
  }

  private signal(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/**
 * 接收端归还窗口的粒度（字节）：读取量累计到它与流窗口四分之一中的较小者即归还。发送调度按归还量估计送达速率，
 * 归还过粗时额度一次回来过多，发送方一次发出的数据在瓶颈处排队；128 KB 时每 2 帧归还一次。
 */
const GRANT_STEP = 128 * 1024

/** 在途上限的下限（字节），也是还没有速率估计时的初值。 */
const MIN_LIMIT = 128 * 1024

/**
 * 在途上限为「送达速率 × 最小往返」的倍数。送达速率仍在上升时（`STARTUP_GAIN`）每个往返可加倍；连续 3 个往返的增幅不足 25%
 * 后取 `PACING_GAIN`：余量使速率可按每个往返 25% 上升，排队延迟约为最小往返的四分之一。
 */
const STARTUP_GAIN = 2
const PACING_GAIN = 1.25

/**
 * 在途上限另加的余量（字节）：「速率 × 最小往返」不含发出一帧与归还的时间，只按它计算时线路填不满，送达速率随之下降，
 * 上限再按下降的速率缩小（电脑上行 1 MB/s 时降到 0.55 MB/s）。
 */
const QUANTUM = 2 * TUNNEL_CHUNK

/** 一条流开头的这些字节（字节）不受在途上限限制：接口应答与小文件通常在此之内，不排在大文件之后。 */
const SMALL_BYTES = 64 * 1024

/**
 * 最小往返的取值范围（毫秒）：取最近这段时间的样本中的最小值，线路变化后随之更新。请求体与响应体在途时的样本都含排队时间，
 * 最小值来自空闲时的探测（电脑端连接建立时与空闲时每 10 秒一次）。
 */
const BASE_RTT_SPAN_MS = 300_000

/** 送达速率取最近这段时间（毫秒）的最大值：应用暂时没有数据可发时，速率样本偏低，不据此降低上限。 */
const RATE_SPAN_MS = 10_000

/** 写入连接的一帧：控制帧为 JSON 文本，数据帧为二进制。 */
export interface TunnelLink {
  send(frame: string | Uint8Array): void
}

/**
 * 一条隧道的发送调度。控制帧（`control`）与 WebSocket 消息（`message`）直接写入连接；请求体与响应体（`data`）
 * 按流排队、各流轮流发出，整条隧道的在途字节（已发出、未被对端以 `window` 帧归还）不超过在途上限。
 *
 * - 在途上限不超过对端声明的 `connectionWindow`。`paced` 时上限为「送达速率 × 最小往返 × 倍数」（倍数见 `STARTUP_GAIN`、
 *   `PACING_GAIN`；送达速率按归还量估计，取最近 `RATE_SPAN_MS` 的最大值；最小往返取最近 `BASE_RTT_SPAN_MS` 的最小样本），
 *   下限 128 KB；不 `paced` 时上限即对端窗口。在途数据只比路径上能容纳的多出四分之一，排在其后的控制帧与聊天事件只多等待约
 *   四分之一个往返。只在对端声明了窗口时 `paced`：不声明窗口的接收端每读取 256 KB 才归还，共享的在途上限会使各流都无法取得归还。
 * - 每条流开头 `SMALL_BYTES` 内的数据不受在途上限限制、优先发出：接口应答与小文件不排在大文件之后。
 *   不要改为按连接的发送缓冲（`bufferedAmount`）判断：排队发生在路由器与内核缓冲中，用户态缓冲为空时排队仍然存在
 *   （电脑上行 1 MB/s、两条下载时普通请求往返由 204 ms 增至 1.6–1.9 s）。
 * - 流结束或被丢弃时（`finish`）归还该流全部在途字节：接收端按 `GRANT_STEP` 归还，流末尾的不足部分不会归还。
 */
export class TunnelOutbound implements TunnelSender {
  private readonly queues = new Map<
    number,
    { frame: Uint8Array; done: (sent: boolean) => void }[]
  >()
  /** 有排队数据的流，按轮转顺序。 */
  private order: number[] = []
  private inflight = 0
  private readonly perStream = new Map<number, number>()
  private limit: number
  /** 往返样本（毫秒），取其中的最小值。 */
  private readonly rtts: { at: number; ms: number }[] = []
  /** 累计归还的字节与时刻，按时间顺序；估计送达速率。 */
  private acks: { at: number; total: number }[] = []
  private acknowledged = 0
  /** 送达速率样本（字节每毫秒）。 */
  private readonly rates: { at: number; rate: number }[] = []
  /** 送达速率是否已不再上升（见 `STARTUP_GAIN`），以及判定所用的上一个速率与时刻、连续未上升的次数。 */
  private full = false
  private plateau = { at: 0, rate: 0, rounds: 0 }
  /** 每条流已发出的字节，判定是否仍在 `SMALL_BYTES` 之内。 */
  private readonly sent = new Map<number, number>()

  constructor(
    private readonly link: TunnelLink,
    /** 对端声明的整条隧道的窗口；未声明时为无穷大。 */
    private readonly ceiling: number,
    /** 是否按送达速率与往返样本控制在途上限。 */
    private readonly paced: boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.limit = paced ? Math.min(MIN_LIMIT, ceiling) : ceiling
  }

  /** 当前在途字节与在途上限，供日志与测试读取。 */
  get state(): { inflight: number; limit: number } {
    return { inflight: this.inflight, limit: this.limit }
  }

  /** 是否有在途或排队的请求体与响应体：调用方据此决定是否发送往返探测。 */
  get busy(): boolean {
    return this.inflight > 0 || this.order.length > 0
  }

  control(frame: TunnelControl): void {
    this.link.send(JSON.stringify(frame))
  }

  message(frame: Uint8Array): void {
    this.link.send(frame)
  }

  data(frame: Uint8Array): Promise<boolean> {
    const sid = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
    return new Promise((done) => {
      let queue = this.queues.get(sid)
      if (!queue) {
        queue = []
        this.queues.set(sid, queue)
        this.order.push(sid)
      }
      queue.push({ frame, done })
      this.flush()
    })
  }

  /** 对端以 `window` 帧归还了 `sid` 的 `bytes` 字节。 */
  acked(sid: number, bytes: number): void {
    const held = this.perStream.get(sid)
    if (held === undefined) return
    const back = Math.min(held, bytes)
    this.perStream.set(sid, held - back)
    this.inflight -= back
    if (this.paced && back > 0) this.delivered(back)
    this.flush()
  }

  /** 流已结束或被丢弃：归还在途字节，排队的数据不再发送（其发送方收到 false）。 */
  finish(sid: number): void {
    this.inflight -= this.perStream.get(sid) ?? 0
    this.perStream.delete(sid)
    this.sent.delete(sid)
    const queue = this.queues.get(sid)
    if (queue) {
      this.queues.delete(sid)
      this.order = this.order.filter((s) => s !== sid)
      for (const item of queue) item.done(false)
    }
    this.flush()
  }

  /** 连接已断开：全部排队的数据不再发送。 */
  close(): void {
    for (const sid of [...this.queues.keys()]) this.finish(sid)
    this.perStream.clear()
    this.inflight = 0
  }

  /** 一次往返的耗时（毫秒）。 */
  rtt(ms: number): void {
    const at = this.now()
    this.rtts.push({ at, ms })
    while (this.rtts.length > 1 && at - this.rtts[0]!.at > BASE_RTT_SPAN_MS) this.rtts.shift()
    this.pace()
  }

  /** 记录一次归还，按不短于最小往返（至少 100 ms）的区间估计送达速率。 */
  private delivered(bytes: number): void {
    const at = this.now()
    this.acknowledged += bytes
    this.acks.push({ at, total: this.acknowledged })
    const span = Math.max(100, this.baseRtt() ?? 0)
    const keep = this.acks.findIndex((a) => at - a.at <= 4 * span)
    if (keep > 0) this.acks = this.acks.slice(keep)
    // 区间起点：距今不短于 span 的最近一次归还。
    let from: { at: number; total: number } | null = null
    for (const a of this.acks) if (at - a.at >= span) from = a
    if (from && at > from.at) {
      this.rates.push({ at, rate: (this.acknowledged - from.total) / (at - from.at) })
      while (this.rates.length > 1 && at - this.rates[0]!.at > RATE_SPAN_MS) this.rates.shift()
    }
    this.pace()
  }

  private baseRtt(): number | null {
    return this.rtts.length > 0 ? Math.min(...this.rtts.map((r) => r.ms)) : null
  }

  private pace(): void {
    if (!this.paced) return
    const base = this.baseRtt()
    if (base === null || this.rates.length === 0) return
    const rate = Math.max(...this.rates.map((r) => r.rate))
    // 每个最小往返判定一次速率是否仍在上升。
    const at = this.now()
    if (!this.full && at - this.plateau.at >= base) {
      if (rate >= this.plateau.rate * 1.25) this.plateau = { at, rate, rounds: 0 }
      else this.plateau = { at, rate: this.plateau.rate, rounds: this.plateau.rounds + 1 }
      if (this.plateau.rounds >= 3) this.full = true
    }
    const gain = this.full ? PACING_GAIN : STARTUP_GAIN
    this.limit = Math.min(this.ceiling, Math.max(MIN_LIMIT, rate * base * gain + QUANTUM))
  }

  private flush(): void {
    for (;;) {
      // 开头 `SMALL_BYTES` 内的流优先，且不受在途上限限制。
      const small = this.order.find((sid) => (this.sent.get(sid) ?? 0) < SMALL_BYTES)
      const sid = small ?? this.order[0]
      if (sid === undefined) return
      const queue = this.queues.get(sid)!
      const item = queue[0]!
      const bytes = item.frame.length - 5
      // 没有在途数据时至少发出一帧：上限小于一帧时不会停止。
      if (small === undefined && this.inflight > 0 && this.inflight + bytes > this.limit) return
      queue.shift()
      this.order = this.order.filter((s) => s !== sid)
      if (queue.length > 0) this.order.push(sid)
      else this.queues.delete(sid)
      this.inflight += bytes
      this.perStream.set(sid, (this.perStream.get(sid) ?? 0) + bytes)
      this.sent.set(sid, (this.sent.get(sid) ?? 0) + bytes)
      this.link.send(item.frame)
      item.done(true)
    }
  }
}
