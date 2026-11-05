/**
 * 远程隧道的帧格式：电脑端服务与云端隧道中心之间的一条 WebSocket，复用多条 HTTP 请求与 WebSocket 连接。
 *
 * 不变量：
 * - 流（`sid`）只由云端打开，电脑端只应答；`sid` 在一条隧道内唯一。
 * - 控制帧是 JSON 文本帧，经 `parseControl` 校验后才处理；数据帧是二进制帧：1 字节类型 + 4 字节 `sid`（大端）+ 负载。
 * - HTTP 请求体与响应体按流计窗口：发送端在窗口用完时暂停读取数据源（`pumpBody`），接收端的消费方读取后以 `window` 帧归还
 *   （`TunnelInbound`）。接收端排队的字节超过窗口时视为对端违反协议，调用方关闭该流，因此每条流在任一端占用的内存不超过一个窗口。
 * - WebSocket 消息不计窗口：消息是 `/stream` 的事件与指令，单条有界。
 * - 协议版本由云端裁决：`hello.protocol` 不在云端支持范围内时以 `TUNNEL_CLOSE.outdated` 关闭，电脑端不再重连。
 */

export const TUNNEL_PROTOCOL_VERSION = 2

/** 云端接口来源上的隧道入口。 */
export const TUNNEL_PATH = '/tunnel'

/** 每条流的窗口（字节）。 */
export const TUNNEL_WINDOW = 1024 * 1024

/** 单个数据帧的负载上限（字节）。 */
export const TUNNEL_CHUNK = 64 * 1024

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
  /** `version` 是电脑端的应用版本，云端按它提供设备页面的界面；缺省时云端不提供界面，打开设备返回 426。 */
  | { type: 'hello'; protocol: number; key: string; version?: string }
  | { type: 'welcome' }
  | { type: 'ping' }
  | { type: 'pong' }
  /** 请求体随后以数据帧发送，以 `end` 结束；没有请求体时紧接一个 `end`。 */
  | { type: 'http.open'; sid: number; method: string; path: string; headers: TunnelHeaders }
  | { type: 'http.head'; sid: number; status: number; headers: TunnelHeaders }
  | { type: 'ws.open'; sid: number; path: string; headers: TunnelHeaders }
  | { type: 'ws.accept'; sid: number }
  /** 发送端的数据已全部发出。 */
  | { type: 'end'; sid: number }
  /** 中止该流；对 WebSocket 流即关闭连接，`code` 与 `reason` 转交给另一端。 */
  | { type: 'close'; sid: number; code?: number; reason?: string }
  | { type: 'window'; sid: number; bytes: number }
  | { type: 'pair.request'; rid: string }
  | { type: 'pair.reply'; rid: string; token: string; deviceName: string }
  | { type: 'notify'; event: TunnelNotifyEvent; conversationId: string; title: string }

type FieldKind = 'string' | 'number' | 'headers' | 'string?' | 'number?'

/** 每种控制帧的字段与类型。`parseControl` 只按此表校验，新增帧类型时在此登记。 */
const FIELDS: { [T in TunnelControl['type']]: Record<string, FieldKind> } = {
  hello: { protocol: 'number', key: 'string', version: 'string?' },
  welcome: {},
  ping: {},
  pong: {},
  'http.open': { sid: 'number', method: 'string', path: 'string', headers: 'headers' },
  'http.head': { sid: 'number', status: 'number', headers: 'headers' },
  'ws.open': { sid: 'number', path: 'string', headers: 'headers' },
  'ws.accept': { sid: 'number' },
  end: { sid: 'number' },
  close: { sid: 'number', code: 'number?', reason: 'string?' },
  window: { sid: 'number', bytes: 'number' },
  'pair.request': { rid: 'string' },
  'pair.reply': { rid: 'string', token: 'string', deviceName: 'string' },
  notify: { event: 'string', conversationId: 'string', title: 'string' },
}

function fieldOk(value: unknown, kind: FieldKind): boolean {
  if (kind === 'string?') return value === undefined || typeof value === 'string'
  if (kind === 'number?') return value === undefined || Number.isInteger(value)
  if (kind === 'number') return Number.isInteger(value)
  if (kind === 'string') return typeof value === 'string'
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
 * 经隧道转发时去掉的请求头与响应头：逐跳头、`host`（由接收端的地址决定）、`content-length`（转发时以分块传输，长度由数据帧决定）
 * 与 WebSocket 握手头（接收端自己完成握手）。
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

/** 发送端的流窗口。一条流只有一个发送方（`pumpBody`），因此只保留一个等待者。 */
export class TunnelCredit {
  private available = TUNNEL_WINDOW
  private waiter: (() => void) | null = null
  private closed = false

  grant(bytes: number): void {
    this.available += bytes
    this.release()
  }

  /** 流已关闭：等待中的发送方立即返回。 */
  close(): void {
    this.closed = true
    this.release()
  }

  /** 等到窗口有余量后占用 `bytes`；流已关闭时返回 false。 */
  async take(bytes: number): Promise<boolean> {
    while (this.available <= 0 && !this.closed) {
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

export interface TunnelSender {
  data(frame: Uint8Array): void
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
        if (!(await credit.take(piece.length))) {
          await reader.cancel().catch(() => {})
          return false
        }
        send.data(encodeData(TUNNEL_DATA.body, sid, piece))
      }
    }
  }
  send.control({ type: 'end', sid })
  return true
}

/**
 * 接收端的流：数据帧经 `push` 进入，消费方从 `readable` 读取；读取的字节累计到窗口的四分之一时经 `consumed` 归还。
 * `readable` 不预读（highWaterMark 为 0），因此排队的字节只取决于发送端是否遵守窗口。
 */
export class TunnelInbound {
  readonly readable: ReadableStream<Uint8Array>
  private queue: Uint8Array[] = []
  private queued = 0
  private ungranted = 0
  private state: 'open' | 'ended' | 'failed' | 'cancelled' = 'open'
  private error: Error | null = null
  private wake: (() => void) | null = null

  constructor(consumed: (bytes: number) => void, cancelled: () => void) {
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
          this.queued -= chunk.length
          controller.enqueue(chunk)
          this.ungranted += chunk.length
          if (this.ungranted >= TUNNEL_WINDOW / 4) {
            consumed(this.ungranted)
            this.ungranted = 0
          }
        },
        cancel: () => {
          if (this.state !== 'open' && this.state !== 'ended') return
          this.state = 'cancelled'
          this.queue = []
          cancelled()
        },
      },
      { highWaterMark: 0 },
    )
  }

  /** 写入一块数据。排队的字节超过窗口时返回 false：对端未遵守窗口，调用方关闭该流。 */
  push(chunk: Uint8Array): boolean {
    if (this.state !== 'open') return true
    this.queued += chunk.length
    if (this.queued > TUNNEL_WINDOW) return false
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
    this.queue = []
    this.signal()
  }

  private signal(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
