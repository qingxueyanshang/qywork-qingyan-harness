/**
 * 隧道客户端：以设备密钥连接云端 `/tunnel`，把设备页面的 HTTP 请求与 WebSocket 转发给本机的远程监听器。
 *
 * 不变量：
 * - 本模块不做鉴权：请求原样交给远程监听器，令牌由本机服务校验（`Pairing.verify`）。云端只能经 `pair.request` 取得当前令牌。
 * - `deviceRevoked` 与 `outdated` 是终态，不再重连；前者交由调用方删除本地的云端接口。
 *   `replaced` 也不再重连：同一份配置的另一个进程已经连接，两者交替重连会互相断开。
 * - 连接断开时中止全部流：进行中的本机请求被取消，本机 WebSocket 被关闭。
 */

import {
  decodeData,
  encodeData,
  parseControl,
  pumpBody,
  sendableCloseCode,
  TUNNEL_CLOSE,
  TUNNEL_DATA,
  TUNNEL_DEAD_MS,
  TUNNEL_PATH,
  TUNNEL_PING_MS,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelControl,
  TunnelCredit,
  TunnelInbound,
  type TunnelNotifyEvent,
  type TunnelSender,
  tunnelHeaders,
} from '@qywork/core'

export type TunnelStatus =
  | { state: 'connecting' }
  | { state: 'online'; deviceUrl: string }
  | { state: 'offline'; message: string }
  | { state: 'outdated' }
  | { state: 'revoked' }

export interface TunnelClientOptions {
  /** 云端接口来源，例如 `https://api.example.com`。 */
  apiOrigin: string
  key: string
  /** 远程监听器的端口。 */
  localPort: number
  /** 当前进程的配对令牌与设备名，应答 `pair.request`。 */
  pairing: () => { token: string; deviceName: string }
  onStatus: (status: TunnelStatus) => void
  /** 第 n 次重连前的等待时长（毫秒）。测试中缩短。 */
  backoffMs?: (attempt: number) => number
}

interface HttpStream {
  kind: 'http'
  inbound: TunnelInbound
  credit: TunnelCredit
  abort: AbortController
}

interface WsStream {
  kind: 'ws'
  local: WebSocket
}

const OFFLINE_MESSAGE: Record<number, string> = {
  [TUNNEL_CLOSE.invalidKey]: '设备密钥无效',
  [TUNNEL_CLOSE.accountBanned]: '账号已被停用',
  [TUNNEL_CLOSE.replaced]: '本设备已在另一个进程中连接',
}

/** 退避：1 秒起每次加倍，上限 30 秒，另加至多 1 秒的随机量，使云端重启后各设备错开重连。 */
function defaultBackoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 1000
}

export class TunnelClient {
  private ws: WebSocket | null = null
  private streams = new Map<number, HttpStream | WsStream>()
  private stopped = false
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private current: TunnelStatus = { state: 'connecting' }
  private readonly backoff: (attempt: number) => number
  private readonly sender: TunnelSender = {
    data: (frame) => this.ws?.send(frame),
    control: (frame) => this.send(frame),
  }

  constructor(private readonly opts: TunnelClientOptions) {
    this.backoff = opts.backoffMs ?? defaultBackoff
  }

  get status(): TunnelStatus {
    return this.current
  }

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close(1000)
    this.dropAll()
  }

  /** 上送一条通知；未连接时不发送。 */
  notify(event: TunnelNotifyEvent, conversationId: string, title: string): void {
    if (this.current.state === 'online') this.send({ type: 'notify', event, conversationId, title })
  }

  private setStatus(status: TunnelStatus): void {
    this.current = status
    this.opts.onStatus(status)
  }

  private send(frame: TunnelControl): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private connect(): void {
    if (this.stopped) return
    const url = `${this.opts.apiOrigin.replace(/^http/, 'ws')}${TUNNEL_PATH}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    let lastFrame = Date.now()
    const heartbeat = setInterval(() => {
      // 休眠唤醒或网络切换后，失效的 TCP 连接可能没有关闭事件。
      if (Date.now() - lastFrame > TUNNEL_DEAD_MS) ws.terminate()
      else this.send({ type: 'ping' })
    }, TUNNEL_PING_MS)
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: 'hello', protocol: TUNNEL_PROTOCOL_VERSION, key: this.opts.key }),
      )
    }
    ws.onmessage = (e) => {
      lastFrame = Date.now()
      if (typeof e.data === 'string') this.control(e.data)
      else this.data(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = (e) => {
      clearInterval(heartbeat)
      if (this.ws !== ws) return
      this.ws = null
      this.dropAll()
      this.closed(e.code)
    }
  }

  private closed(code: number): void {
    if (this.stopped) return
    if (code === TUNNEL_CLOSE.deviceRevoked) {
      this.stopped = true
      this.setStatus({ state: 'revoked' })
      return
    }
    if (code === TUNNEL_CLOSE.outdated) {
      this.stopped = true
      this.setStatus({ state: 'outdated' })
      return
    }
    this.setStatus({ state: 'offline', message: OFFLINE_MESSAGE[code] ?? '无法连接云端服务' })
    if (code === TUNNEL_CLOSE.replaced) {
      this.stopped = true
      return
    }
    const delay =
      code === TUNNEL_CLOSE.restarting ? Math.random() * 1000 : this.backoff(this.attempt)
    this.attempt = code === TUNNEL_CLOSE.restarting ? 0 : this.attempt + 1
    this.retry = setTimeout(() => this.connect(), delay)
  }

  private control(raw: string): void {
    const frame = parseControl(raw)
    if (!frame) return
    switch (frame.type) {
      case 'welcome':
        this.attempt = 0
        this.setStatus({ state: 'online', deviceUrl: frame.deviceUrl })
        return
      case 'pair.request':
        this.send({ type: 'pair.reply', rid: frame.rid, ...this.opts.pairing() })
        return
      case 'http.open':
        this.openHttp(frame)
        return
      case 'ws.open':
        this.openWs(frame)
        return
      case 'window': {
        const stream = this.streams.get(frame.sid)
        if (stream?.kind === 'http') stream.credit.grant(frame.bytes)
        return
      }
      case 'end': {
        const stream = this.streams.get(frame.sid)
        if (stream?.kind === 'http') stream.inbound.end()
        return
      }
      case 'close':
        this.drop(frame.sid, frame.code, frame.reason)
        return
      default:
        return
    }
  }

  private data(raw: Uint8Array): void {
    const frame = decodeData(raw)
    if (!frame) return
    const stream = this.streams.get(frame.sid)
    if (!stream) return
    if (stream.kind === 'http') {
      if (frame.kind !== TUNNEL_DATA.body || !stream.inbound.push(frame.payload)) {
        this.drop(frame.sid)
        this.send({ type: 'close', sid: frame.sid })
      }
      return
    }
    if (frame.kind === TUNNEL_DATA.text) stream.local.send(new TextDecoder().decode(frame.payload))
    else if (frame.kind === TUNNEL_DATA.binary) stream.local.send(frame.payload)
  }

  private openHttp(open: TunnelControl & { type: 'http.open' }): void {
    const { sid } = open
    const abort = new AbortController()
    const credit = new TunnelCredit()
    const inbound = new TunnelInbound(
      (bytes) => this.send({ type: 'window', sid, bytes }),
      () => {},
    )
    this.streams.set(sid, { kind: 'http', inbound, credit, abort })
    const hasBody = open.method !== 'GET' && open.method !== 'HEAD'
    const init: RequestInit & { decompress: boolean; duplex?: 'half' } = {
      method: open.method,
      headers: open.headers,
      signal: abort.signal,
      redirect: 'manual',
      // 响应字节原样转交：解压后仍带 `content-encoding` 时，手机会再解压一次。
      decompress: false,
      ...(hasBody ? { body: inbound.readable, duplex: 'half' } : {}),
    }
    void fetch(`http://127.0.0.1:${this.opts.localPort}${open.path}`, init)
      .then(async (res) => {
        if (this.streams.get(sid)?.kind !== 'http') {
          await res.body?.cancel()
          return
        }
        this.send({
          type: 'http.head',
          sid,
          status: res.status,
          headers: tunnelHeaders(res.headers),
        })
        if (await pumpBody(res.body, sid, credit, this.sender)) this.streams.delete(sid)
      })
      .catch(() => {
        if (!this.streams.has(sid)) return
        this.drop(sid)
        this.send({ type: 'close', sid })
      })
  }

  private openWs(open: TunnelControl & { type: 'ws.open' }): void {
    const { sid } = open
    const local = new WebSocket(`ws://127.0.0.1:${this.opts.localPort}${open.path}`, {
      headers: Object.fromEntries(open.headers),
    })
    local.binaryType = 'arraybuffer'
    this.streams.set(sid, { kind: 'ws', local })
    local.onopen = () => this.send({ type: 'ws.accept', sid })
    local.onmessage = (e) => {
      if (!this.ws) return
      if (typeof e.data === 'string') {
        this.ws.send(encodeData(TUNNEL_DATA.text, sid, new TextEncoder().encode(e.data)))
      } else {
        this.ws.send(encodeData(TUNNEL_DATA.binary, sid, new Uint8Array(e.data as ArrayBuffer)))
      }
    }
    local.onclose = (e) => {
      if (this.streams.get(sid)?.kind !== 'ws') return
      this.streams.delete(sid)
      this.send({ type: 'close', sid, code: sendableCloseCode(e.code), reason: e.reason })
    }
  }

  /** 中止一条流。对 WebSocket 流，`code` 与 `reason` 转交给本机连接。 */
  private drop(sid: number, code?: number, reason?: string): void {
    const stream = this.streams.get(sid)
    if (!stream) return
    this.streams.delete(sid)
    if (stream.kind === 'http') {
      stream.abort.abort()
      stream.credit.close()
      stream.inbound.fail(new Error('流已关闭'))
    } else {
      stream.local.close(sendableCloseCode(code), reason)
    }
  }

  private dropAll(): void {
    for (const sid of [...this.streams.keys()]) this.drop(sid, 1001, '隧道已断开')
  }
}
