/**
 * 原生浏览器宿主连接的服务端一侧。
 *
 * 这条连接由 Rust 宿主主动连上来，只承载资源操作与生命周期事件；聊天指令不经这里。
 * 服务端不发起连接，也不知道宿主进程在哪。
 *
 * 三条边界：
 *
 * 1. **宿主身份由服务端判定**，不看客户端自报的 `origin`：只有本机回环连接、
 *    且带着本次启动的宿主凭据，才会被升级到这条路径。普通配对令牌注册不了宿主。
 * 2. **断线即所有待决调用失败**，重连后由宿主的 `host.ready` 给出完整存活页快照；
 *    不重放任何已发出的操作。
 * 3. **跨重连的结果一律丢弃**：结果按 `requestId` 加 `connectionEpoch` 配对，
 *    对不上的迟到结果不得完成另一次调用。
 */

import type {
  BrowserEventFrame,
  BrowserOp,
  BrowserRequestFrame,
  BrowserResultFrame,
  BrowserTabSnapshot,
  HostReadyFrame,
  NativeBrowserUpFrame,
} from '@qywork/core'
import { BROWSER_EVENT_KINDS, log, NATIVE_BROWSER_KEY_HEADER } from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import type { SocketData } from '../deps.ts'
import { timingSafeEqual } from '../pairing.ts'

/** 一次操作的默认期限。宿主按它拒绝过期请求，服务端按它拒绝本地待决调用。 */
const DEFAULT_DEADLINE_MS = 20_000

/** 已连上的宿主。没有宿主时整条浏览器控制能力不发布。 */
export interface NativeBrowserHost {
  hostInstanceId: string
  connectionEpoch: number
  platform: string
  runtimeVersion: string
  debugPort: number
}

export class BrowserBridgeError extends Error {}

interface Pending {
  resolve: (data: BrowserResultFrame['data']) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  epoch: number
}

export interface BrowserRequestParams {
  tabId?: string
  /** `create` 与 `bind` 必带。宿主对缺席直接拒绝，不回落到任何默认工作区。 */
  workspaceId?: string
  conversationId?: string
  url?: string
  path?: string
  downloadId?: string
}

export class BrowserBridge {
  #key: string
  #socket: ServerWebSocket<SocketData> | null = null
  #host: NativeBrowserHost | null = null
  #tabs = new Map<string, BrowserTabSnapshot>()
  #pending = new Map<string, Pending>()
  #nextRequest = 0
  #events = new Set<(frame: BrowserEventFrame) => void>()
  #hostChanges = new Set<(host: NativeBrowserHost | null) => void>()

  constructor(key: string) {
    this.#key = key
  }

  /**
   * 这条请求能不能升级成宿主连接。
   *
   * 回环地址是硬条件：局域网监听器复用同一份 handler，少了这一条，手机侧也能
   * 走到凭据比较那一步。
   */
  accepts(req: Request, address: string | null): boolean {
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const presented = req.headers.get(NATIVE_BROWSER_KEY_HEADER)
    if (!presented) return false
    return timingSafeEqual(presented, this.#key)
  }

  /** 已连上的宿主。`null` = 现在没有原生浏览器资源。 */
  host(): NativeBrowserHost | null {
    return this.#host
  }

  tabs(): BrowserTabSnapshot[] {
    return [...this.#tabs.values()]
  }

  tab(tabId: string): BrowserTabSnapshot | undefined {
    return this.#tabs.get(tabId)
  }

  onEvent(listener: (frame: BrowserEventFrame) => void): () => void {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  onHostChange(listener: (host: NativeBrowserHost | null) => void): () => void {
    this.#hostChanges.add(listener)
    return () => this.#hostChanges.delete(listener)
  }

  /**
   * 发起一次资源操作。
   *
   * 没有宿主、宿主中途断开、超过期限，三种情况都在本地拒绝——不能等远端返回，
   * 远端可能已经不在了。
   */
  request(
    op: BrowserOp,
    params: BrowserRequestParams = {},
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<BrowserResultFrame['data']> {
    const socket = this.#socket
    const host = this.#host
    if (!socket || !host) {
      return Promise.reject(new BrowserBridgeError('浏览器宿主未连接'))
    }
    this.#nextRequest += 1
    const requestId = `br_${this.#nextRequest}`
    const frame: BrowserRequestFrame = {
      type: 'browser.request',
      requestId,
      connectionEpoch: host.connectionEpoch,
      deadline: Date.now() + deadlineMs,
      op,
      ...(params.tabId !== undefined ? { tabId: params.tabId } : {}),
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
      ...(params.url !== undefined ? { url: params.url } : {}),
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.downloadId !== undefined ? { downloadId: params.downloadId } : {}),
    }
    return new Promise<BrowserResultFrame['data']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new BrowserBridgeError(`浏览器操作 ${op} 超时`))
      }, deadlineMs)
      this.#pending.set(requestId, { resolve, reject, timer, epoch: host.connectionEpoch })
      socket.send(JSON.stringify(frame))
    })
  }

  /** 宿主连接上来。握手在 `accepts` 里做完了，这里只登记 socket。 */
  open(ws: ServerWebSocket<SocketData>): void {
    // 同一份 profile 由原生侧的占用锁保证只有一个宿主；这里遇到第二条连接时
    // 让新的接管并关掉旧的——应用重启时旧 socket 可能还没被对端关闭。
    if (this.#socket && this.#socket !== ws) {
      this.#socket.close(1000, 'replaced')
      this.#reset()
    }
    this.#socket = ws
  }

  /** 宿主断开：待决调用全部失败，快照清空，能力随之下线。 */
  close(ws: ServerWebSocket<SocketData>): void {
    if (this.#socket !== ws) return
    this.#socket = null
    this.#reset()
  }

  message(ws: ServerWebSocket<SocketData>, raw: string): void {
    if (this.#socket !== ws) return
    let frame: NativeBrowserUpFrame
    try {
      frame = JSON.parse(raw) as NativeBrowserUpFrame
    } catch {
      log.warn('browser', '宿主帧不是合法 JSON')
      return
    }
    if (frame.type === 'host.ready') {
      this.#ready(frame)
      return
    }
    if (frame.type === 'browser.result') {
      this.#result(frame)
      return
    }
    if (frame.type === 'browser.event') {
      this.#event(frame)
    }
  }

  #ready(frame: HostReadyFrame): void {
    // 工作区缺席的快照按协议错误拒收整条连接：接下它就要给那些页编一个工作区，
    // 而服务端没有「当前工作区」这个状态。不注册宿主即整条浏览器控制能力不发布。
    const orphan = frame.tabs.find((tab) => !tab.workspaceId)
    if (orphan) {
      log.warn('browser', '宿主快照里有页没有工作区，这条连接不接受', { tabId: orphan.tabId })
      return
    }
    // 重连按新纪元重建：先让上一纪元的待决调用失败，再登记快照。
    this.#failPending(new BrowserBridgeError('浏览器宿主已重连'))
    this.#host = {
      hostInstanceId: frame.hostInstanceId,
      connectionEpoch: frame.connectionEpoch,
      platform: frame.platform,
      runtimeVersion: frame.runtimeVersion,
      debugPort: frame.debugPort,
    }
    this.#tabs = new Map(frame.tabs.map((tab) => [tab.tabId, tab]))
    log.info('browser', '浏览器宿主已连接', {
      platform: frame.platform,
      runtimeVersion: frame.runtimeVersion,
      epoch: frame.connectionEpoch,
      tabs: frame.tabs.length,
    })
    for (const listener of [...this.#hostChanges]) listener(this.#host)
  }

  #result(frame: BrowserResultFrame): void {
    const pending = this.#pending.get(frame.requestId)
    // 迟到结果：对应的待决调用已经被本地拒绝并删除，不得完成另一次调用。
    if (!pending) return
    if (pending.epoch !== frame.connectionEpoch) return
    this.#pending.delete(frame.requestId)
    clearTimeout(pending.timer)
    if (frame.ok) pending.resolve(frame.data)
    else pending.reject(new BrowserBridgeError(frame.error ?? '浏览器操作失败'))
  }

  #event(frame: BrowserEventFrame): void {
    if (frame.connectionEpoch !== this.#host?.connectionEpoch) return
    // 认不出的事件种类不改快照也不往下发：宿主与服务端版本不一致时，
    // 按「大概是导航」处理会把一份错的 URL 写进存活页快照。
    if (!BROWSER_EVENT_KINDS.includes(frame.kind)) {
      log.warn('browser', '认不出的宿主事件', { kind: frame.kind })
      return
    }
    const tab = this.#tabs.get(frame.tabId)
    // 新页进入存活集合的唯一途径。AI 建的和用户自己新开的走的是同一条——
    // 少了后者，模型在 `browser_tabs` 里看不见用户的那一页。
    if (frame.kind === 'opened') {
      // 没有工作区的新页不进存活表：填空串顶上会让它在每个工作区里都不归属、
      // 又处处可见。这一页因此对服务端不存在，界面那份投影仍由宿主推。
      if (!frame.workspaceId) {
        log.warn('browser', '新页没有带工作区，不进存活表', { tabId: frame.tabId })
        return
      }
      this.#tabs.set(frame.tabId, {
        tabId: frame.tabId,
        url: frame.url ?? '',
        title: frame.title ?? '',
        marker: frame.marker ?? '',
        workspaceId: frame.workspaceId,
        conversationId: frame.conversationId ?? null,
      })
    } else if (frame.kind === 'closed') this.#tabs.delete(frame.tabId)
    else if (tab) {
      if (frame.url !== undefined) tab.url = frame.url
      if (frame.title !== undefined) tab.title = frame.title
      // `control` 事件（bind 接管后）带新归属。
      if (frame.conversationId !== undefined) tab.conversationId = frame.conversationId
    }
    for (const listener of [...this.#events]) listener(frame)
  }

  #failPending(err: Error): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(err)
    }
  }

  #reset(): void {
    this.#failPending(new BrowserBridgeError('浏览器宿主已断开'))
    this.#host = null
    this.#tabs.clear()
    for (const listener of [...this.#hostChanges]) listener(null)
  }
}
