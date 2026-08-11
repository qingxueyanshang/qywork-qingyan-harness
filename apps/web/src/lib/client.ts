/**
 * 与 `qy serve` 的连接层。
 *
 * 桌面 WebView 和手机浏览器用的是**同一份**代码。区别只有两处：
 * - 令牌来源：桌面从注入的全局变量拿，手机从二维码带来的 URL fragment 拿。
 * - `origin` 字段：仅用于审计和「谁批准了权限」的跨端提示，不影响能力。
 *
 * 重连是这里的主要复杂度。手机在地铁里断网是常态，所以：
 * - 指数退避 + 抖动，避免服务端刚恢复就被一堆客户端同时打爆。
 * - 重连时带 `lastSeq`，服务端补发缺口；补不上就置 `resync`，
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
import { decodePairingUrl, PROTOCOL_VERSION } from '@qywork/core'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'unauthorized' | 'closed'

export interface ClientOptions {
  onEvent(event: AgentEvent, seq: number): void
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

export class QyClient {
  private ws: WebSocket | null = null
  private lastSeq = 0
  private attempt = 0
  private closed = false
  private readonly endpoint = resolveEndpoint()
  private subscribed: string[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: ClientOptions) {}

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
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      const hello: HelloFrame = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.endpoint.token,
        origin: this.endpoint.origin,
        ...(this.lastSeq > 0 ? { lastSeq: this.lastSeq } : {}),
        ...(this.subscribed.length ? { subscribe: this.subscribed as never } : {}),
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
        this.opts.onCapabilities(msg.capabilities)
        this.opts.onState('ready')
        if (msg.resync) {
          this.lastSeq = msg.currentSeq
          this.opts.onResync()
        }
        return
      }
      if (msg.type === 'hello.err') {
        this.opts.onState('unauthorized', msg.message)
        this.closed = msg.reason === 'bad_token'
        return
      }
      if (msg.type === 'command.rejected') {
        this.opts.onRejected(msg as CommandRejectedFrame)
        return
      }
      if (typeof msg.seq === 'number' && msg.event) {
        const frame = msg as EventEnvelope<AgentEvent>
        this.lastSeq = Math.max(this.lastSeq, frame.seq)
        this.opts.onEvent(frame.event, frame.seq)
      }
    })

    ws.addEventListener('close', () => {
      this.ws = null
      if (this.closed) {
        this.opts.onState('closed')
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

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

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
    const res = await fetch(`${this.endpoint.base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${this.endpoint.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${res.status} ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    return (await res.json()) as T
  }
}
