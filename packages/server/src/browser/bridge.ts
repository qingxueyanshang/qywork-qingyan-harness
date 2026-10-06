/**
 * 原生浏览器宿主连接的服务端一侧。
 *
 * 该连接由 Rust 宿主主动建立，只承载资源操作与生命周期事件；聊天指令不经由此处。
 * 服务端不发起连接，也不掌握宿主进程的位置。
 *
 * 三条边界：
 *
 * 1. 宿主身份由服务端判定，不依据客户端自报的 `origin`：只有本机回环连接
 *    且携带本次启动的宿主凭据时，才会升级到该路径。普通配对令牌无法注册宿主。
 * 2. 断线时所有待决调用失败，重连后由宿主的 `host.ready` 给出完整的存活页快照；
 *    不重放任何已发出的操作。
 * 3. 跨重连的结果一律丢弃：结果按 `requestId` 加 `connectionEpoch` 配对，
 *    不一致的迟到结果不得完成另一次调用。
 */

import type {
  BrowserCapability,
  BrowserEventFrame,
  BrowserOp,
  BrowserRequestFrame,
  BrowserResultFrame,
  BrowserTabSnapshot,
  HostReadyFrame,
  NativeBrowserUpFrame,
} from '@qywork/core'
import { BROWSER_EVENT_KINDS, log, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import type { SocketData } from '../deps.ts'
import { timingSafeEqual } from '../pairing.ts'

/** 一次操作的默认期限。宿主按它拒绝过期请求，服务端按它拒绝本地待决调用。 */
const DEFAULT_DEADLINE_MS = 20_000

/** 已连接的宿主。没有宿主时不发布浏览器控制能力。 */
export interface NativeBrowserHost {
  hostInstanceId: string
  connectionEpoch: number
  platform: string
  presentation: HostReadyFrame['presentation']
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
  /** `create` 与 `bind` 必须携带。缺少时宿主直接拒绝，不回退到任何默认工作区。 */
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
  /** 宿主已连接但报告没有可用浏览器。与 `#host` 互斥：一个非空时另一个必为空。 */
  #unavailable: BrowserCapability['unavailable'] | null = null
  #tabs = new Map<string, BrowserTabSnapshot>()
  #pending = new Map<string, Pending>()
  #nextRequest = 0
  #events = new Set<(frame: BrowserEventFrame) => void>()
  #hostChanges = new Set<(host: NativeBrowserHost | null) => void>()

  constructor(key: string) {
    this.#key = key
  }

  /**
   * 判定该请求能否升级为宿主连接。
   *
   * 回环地址是必要条件：局域网监听器复用同一个 handler，缺少该条件时手机端
   * 也能进入凭据比较。
   */
  accepts(req: Request, address: string | null): boolean {
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const presented = req.headers.get(NATIVE_HOST_KEY_HEADER)
    if (!presented) return false
    return timingSafeEqual(presented, this.#key)
  }

  /** 已连接的宿主。`null` 表示当前没有原生浏览器资源。 */
  host(): NativeBrowserHost | null {
    return this.#host
  }

  /** 宿主已连接但没有可用浏览器时的原因。宿主未连接或浏览器可用时为 `null`。 */
  unavailable(): BrowserCapability['unavailable'] | null {
    return this.#unavailable
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
   * 没有宿主、宿主中途断开、超过期限三种情况均在本地拒绝，不等待远端返回：
   * 远端可能已不存在。
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

  /** 宿主已连接。握手已在 `accepts` 中完成，此处只登记 socket。 */
  open(ws: ServerWebSocket<SocketData>): void {
    // 同一 profile 由原生侧的占用锁保证只有一个宿主；此处收到第二条连接时
    // 由新连接接管并关闭旧连接：应用重启时旧 socket 可能尚未被对端关闭。
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
    if (frame.type === 'host.unavailable') {
      this.#withdraw(frame.reason)
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
    // 快照中有页缺少工作区时按协议错误拒绝整条连接：接受它就需要为这些页虚构工作区，
    // 而服务端没有「当前工作区」状态。不注册宿主即不发布浏览器控制能力。
    const orphan = frame.tabs.find((tab) => !tab.workspaceId)
    if (orphan) {
      log.warn('browser', '宿主快照中有页缺少工作区，拒绝该连接', { tabId: orphan.tabId })
      return
    }
    // 重连按新纪元重建：先让上一纪元的待决调用失败，再登记快照。
    this.#failPending(new BrowserBridgeError('浏览器宿主已重连'))
    this.#unavailable = null
    this.#host = {
      hostInstanceId: frame.hostInstanceId,
      connectionEpoch: frame.connectionEpoch,
      platform: frame.platform,
      presentation: frame.presentation,
      runtimeVersion: frame.runtimeVersion,
      debugPort: frame.debugPort,
    }
    this.#tabs = new Map(frame.tabs.map((tab) => [tab.tabId, tab]))
    log.info('browser', '浏览器宿主已连接', {
      platform: frame.platform,
      presentation: frame.presentation,
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
    // 无法识别的事件种类既不修改快照也不向下转发：宿主与服务端版本不一致时，
    // 按导航事件推测处理会把错误的 URL 写入存活页快照。
    if (!BROWSER_EVENT_KINDS.includes(frame.kind)) {
      log.warn('browser', '无法识别的宿主事件', { kind: frame.kind })
      return
    }
    const tab = this.#tabs.get(frame.tabId)
    // 新页进入存活集合的唯一途径。AI 创建的页与用户新开的页经由同一路径：
    // 缺少后者时，模型在 `browser_tabs` 中看不到用户的页。
    if (frame.kind === 'opened') {
      // 没有工作区的新页不进入存活表：填入空字符串会使它不属于任何工作区
      // 却在所有工作区中可见。该页因此对服务端不存在，界面上的投影仍由宿主推送。
      if (!frame.workspaceId) {
        log.warn('browser', '新页缺少工作区，不进入存活表', { tabId: frame.tabId })
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
      // `control` 事件（bind 接管后）携带新归属。
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

  /**
   * 宿主报告没有可用浏览器：连接保留，上一份快照与待决调用作废，能力随之下线。
   * 浏览器重新启动后宿主在同一连接上再次发送 `host.ready`。
   */
  #withdraw(reason: NonNullable<BrowserCapability['unavailable']>): void {
    this.#failPending(new BrowserBridgeError('浏览器宿主没有可用的浏览器'))
    this.#host = null
    this.#unavailable = reason
    this.#tabs.clear()
    log.info('browser', '浏览器宿主没有可用的浏览器', { reason })
    for (const listener of [...this.#hostChanges]) listener(null)
  }

  #reset(): void {
    this.#failPending(new BrowserBridgeError('浏览器宿主已断开'))
    this.#host = null
    this.#unavailable = null
    this.#tabs.clear()
    for (const listener of [...this.#hostChanges]) listener(null)
  }
}
