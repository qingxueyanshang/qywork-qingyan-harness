/**
 * 桌面原生宿主连接的服务端一侧。
 *
 * 这条连接由宿主主动连上来，只承载桌面控件的观察与动作；聊天指令与浏览器资源操作
 * 都不经这里。服务端不发起连接，也不知道宿主进程在哪。
 *
 * 四条边界：
 *
 * 1. **宿主身份由服务端判定**，不看客户端自报的任何字段：只有本机回环连接、
 *    且带着本次启动的宿主凭据，才会被升级到这条路径；是哪一种宿主由 URL 路径决定。
 * 2. **断线即所有待决调用收尾，按执行事实分类**：写进 socket 之前失败的记
 *    `not_dispatched`，已经写出去的记 `unknown`。**不重放**任何已发出的操作。
 * 3. **跨代际的结果一律丢弃**：结果按 `requestId` 加 `connectionEpoch` 加
 *    `hostId`/`hostEpoch` 四项配对，对不上的迟到结果不得完成另一次调用。
 * 4. **执行实例换代走重发 `host.ready`**：WS 不断而 worker 被换掉时，宿主用新的
 *    `hostEpoch` 再发一次注册帧，旧实例名下的待决调用按第 2 条收尾。
 */

import type {
  DesktopAction,
  DesktopBlockingWindow,
  DesktopEventFrame,
  DesktopHostReadyFrame,
  DesktopObservation,
  DesktopOp,
  DesktopRect,
  DesktopRequestFrame,
  DesktopResultFrame,
  DesktopTarget,
  DesktopWaitUntil,
  NativeDesktopUpFrame,
} from '@qywork/core'
import { DESKTOP_PROTOCOL_VERSION, log, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import type { SocketData } from '../deps.ts'
import { timingSafeEqual } from '../pairing.ts'

/** 一次操作的默认期限。宿主按它拒绝过期请求，服务端按它拒绝本地待决调用。 */
const DEFAULT_DEADLINE_MS = 20_000

/** 已连上的宿主。没有宿主时整条电脑操作能力不发布。 */
export interface NativeDesktopHost {
  hostId: string
  hostEpoch: number
  connectionEpoch: number
  platform: string
  workerReady: boolean
  authorized: boolean
}

/**
 * 一次调用的结果。
 *
 * `dispatch` 是执行事实，**任何失败都要带着它**：把「宿主断了」压成一个普通异常，
 * 调用方就分不出「没执行」和「可能已经执行」，而后者禁止重发。
 */
export interface DesktopCallResult {
  dispatch: DesktopResultFrame['dispatch']
  reason?: string
  observation?: DesktopObservation
  observationError?: string
  /** 动作调用尚未返回时目标进程此刻的顶层窗口。见协议里的 `blocking`。 */
  blocking?: DesktopBlockingWindow[]
}

export class DesktopBridgeError extends Error {
  readonly dispatch: DesktopResultFrame['dispatch']
  constructor(message: string, dispatch: DesktopResultFrame['dispatch']) {
    super(message)
    this.name = 'DesktopBridgeError'
    this.dispatch = dispatch
  }
}

interface Pending {
  resolve: (result: DesktopCallResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  executorId: string
  /** 这一帧有没有真的写进 socket。没写出去的那些收尾时记 `not_dispatched`。 */
  sent: boolean
}

export interface DesktopRequestParams {
  executorId: string
  actionId?: string
  target?: DesktopTarget
  ref?: string
  /** 指针动作的屏幕物理像素落点。与 `ref` 互斥。 */
  point?: { x: number; y: number }
  action?: DesktopAction
  maxChars?: number
  value?: string
  maxNodes?: number
  maxDepth?: number
  timeBudgetMs?: number
  root?: string
  role?: string
  nameContains?: string
  includeValue?: boolean
  includeState?: boolean
  until?: DesktopWaitUntil
  name?: string
  pollMs?: number
  timeoutMs?: number
  region?: DesktopRect
  expectGeneration?: string
  maxEdge?: number
  maxBytes?: number
}

export class DesktopBridge {
  #key: string
  #foreground: () => boolean
  #socket: ServerWebSocket<SocketData> | null = null
  #host: NativeDesktopHost | null = null
  #pending = new Map<string, Pending>()
  #nextRequest = 0
  #hostChanges = new Set<(host: NativeDesktopHost | null) => void>()

  /**
   * `foreground` 每条请求现读一次，不存快照：存一份的话，用户在运行中关掉前台接管
   * 要等宿主换代际才生效。
   */
  constructor(key: string, foreground: () => boolean) {
    this.#key = key
    this.#foreground = foreground
  }

  /**
   * 这条请求能不能升级成宿主连接。
   *
   * 回环地址是硬条件：局域网监听器复用同一份 handler，少了这一条，手机侧也能
   * 走到凭据比较那一步。
   *
   * 凭据与浏览器宿主是同一份：两条路径由同一个桌面外壳进程发起，同一次启动只有一个
   * 随机值。**区分宿主种类的是 URL 路径，不是客户端自报的字段**，所以共用凭据不会让
   * 一条连接串到另一条的帧处理上。
   */
  accepts(req: Request, address: string | null): boolean {
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const presented = req.headers.get(NATIVE_HOST_KEY_HEADER)
    if (!presented) return false
    return timingSafeEqual(presented, this.#key)
  }

  /** 已连上的宿主。`null` = 现在没有桌面控制能力。 */
  host(): NativeDesktopHost | null {
    return this.#host
  }

  onHostChange(listener: (host: NativeDesktopHost | null) => void): () => void {
    this.#hostChanges.add(listener)
    return () => this.#hostChanges.delete(listener)
  }

  /**
   * 发起一次桌面操作。
   *
   * 没有宿主、worker 没就绪、系统没授权，三种都在本地拒绝且记 `not_dispatched`——
   * 不能等远端返回，远端可能已经不在了。写 socket 之后才可能出现 `unknown`。
   */
  request(
    op: DesktopOp,
    params: DesktopRequestParams,
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<DesktopCallResult> {
    const socket = this.#socket
    const host = this.#host
    if (!socket || !host || !host.workerReady || !host.authorized) {
      return Promise.reject(new DesktopBridgeError('桌面宿主不可用', 'not_dispatched'))
    }
    this.#nextRequest += 1
    const requestId = `dr_${this.#nextRequest}`
    const frame: DesktopRequestFrame = {
      type: 'desktop.request',
      requestId,
      connectionEpoch: host.connectionEpoch,
      hostId: host.hostId,
      hostEpoch: host.hostEpoch,
      executorId: params.executorId,
      deadline: Date.now() + deadlineMs,
      foreground: this.#foreground(),
      op,
      ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
      ...(params.target !== undefined ? { target: params.target } : {}),
      ...(params.ref !== undefined ? { ref: params.ref } : {}),
      ...(params.point !== undefined ? { point: params.point } : {}),
      ...(params.action !== undefined ? { action: params.action } : {}),
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.maxNodes !== undefined ? { maxNodes: params.maxNodes } : {}),
      ...(params.maxDepth !== undefined ? { maxDepth: params.maxDepth } : {}),
      ...(params.timeBudgetMs !== undefined ? { timeBudgetMs: params.timeBudgetMs } : {}),
      ...(params.root !== undefined ? { root: params.root } : {}),
      ...(params.role !== undefined ? { role: params.role } : {}),
      ...(params.nameContains !== undefined ? { nameContains: params.nameContains } : {}),
      ...(params.includeValue !== undefined ? { includeValue: params.includeValue } : {}),
      ...(params.includeState !== undefined ? { includeState: params.includeState } : {}),
      ...(params.until !== undefined ? { until: params.until } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.pollMs !== undefined ? { pollMs: params.pollMs } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.region !== undefined ? { region: params.region } : {}),
      ...(params.expectGeneration !== undefined
        ? { expectGeneration: params.expectGeneration }
        : {}),
      ...(params.maxEdge !== undefined ? { maxEdge: params.maxEdge } : {}),
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    }
    return new Promise<DesktopCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId)
        this.#pending.delete(requestId)
        // 超时的动作请求可能已经在 OS 里执行完只是回执没回来，所以按已派发记。
        reject(
          new DesktopBridgeError(
            `桌面操作 ${op} 超时`,
            pending?.sent === true ? 'unknown' : 'not_dispatched',
          ),
        )
      }, deadlineMs)
      const entry: Pending = {
        resolve,
        reject,
        timer,
        connectionEpoch: host.connectionEpoch,
        hostId: host.hostId,
        hostEpoch: host.hostEpoch,
        executorId: params.executorId,
        sent: false,
      }
      this.#pending.set(requestId, entry)
      // 登记先于发送：回执可能在 send 返回之前就被派发进来，那时表里必须已经有它。
      try {
        socket.send(JSON.stringify(frame))
        entry.sent = true
      } catch (err) {
        this.#pending.delete(requestId)
        clearTimeout(timer)
        reject(
          new DesktopBridgeError(
            `桌面操作 ${op} 没有发出：${err instanceof Error ? err.message : String(err)}`,
            'not_dispatched',
          ),
        )
      }
    })
  }

  /** 宿主连接上来。握手在 `accepts` 里做完了，这里只登记 socket。 */
  open(ws: ServerWebSocket<SocketData>): void {
    if (this.#socket && this.#socket !== ws) {
      this.#socket.close(1000, 'replaced')
      this.#reset()
    }
    this.#socket = ws
  }

  /** 宿主断开：待决调用按执行事实收尾，能力随之下线。 */
  close(ws: ServerWebSocket<SocketData>): void {
    if (this.#socket !== ws) return
    this.#socket = null
    this.#reset()
  }

  message(ws: ServerWebSocket<SocketData>, raw: string): void {
    if (this.#socket !== ws) return
    let frame: NativeDesktopUpFrame
    try {
      frame = JSON.parse(raw) as NativeDesktopUpFrame
    } catch {
      log.warn('desktop', '宿主帧不是合法 JSON')
      return
    }
    if (frame.type === 'host.ready') {
      this.#ready(frame)
      return
    }
    if (frame.type === 'desktop.result') {
      this.#result(frame)
      return
    }
    if (frame.type === 'desktop.event') {
      this.#event(frame)
    }
  }

  #ready(frame: DesktopHostReadyFrame): void {
    // 协议版本不一致即整条能力不发布。接下它就要按一份读不准的帧去解释观察结果，
    // 而错误的观察会变成一次打在别的控件上的动作。
    if (frame.protocol !== DESKTOP_PROTOCOL_VERSION) {
      log.warn('desktop', '宿主协议版本不一致，这条连接不接受', {
        host: frame.protocol,
        server: DESKTOP_PROTOCOL_VERSION,
      })
      return
    }
    // 重连或换 worker 都按新代际重建：先让上一代的待决调用收尾，再登记新身份。
    this.#failPending('桌面宿主已换代')
    this.#host = {
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      connectionEpoch: frame.connectionEpoch,
      platform: frame.platform,
      workerReady: frame.workerReady,
      authorized: frame.authorized,
    }
    log.info('desktop', '桌面宿主已连接', {
      platform: frame.platform,
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      connectionEpoch: frame.connectionEpoch,
      workerReady: frame.workerReady,
      authorized: frame.authorized,
    })
    this.#announce()
  }

  /**
   * 认领一条结果。
   *
   * 四项身份全对上才认。只对 `requestId` 的话，重连或换 worker 之后一条迟到的回执
   * 会结算一次编号恰好相同的新调用。
   */
  #result(frame: DesktopResultFrame): void {
    const pending = this.#pending.get(frame.requestId)
    if (!pending) return
    if (
      pending.connectionEpoch !== frame.connectionEpoch ||
      pending.hostId !== frame.hostId ||
      pending.hostEpoch !== frame.hostEpoch
    ) {
      log.warn('desktop', '丢弃代际对不上的迟到回执', { requestId: frame.requestId })
      return
    }
    this.#pending.delete(frame.requestId)
    clearTimeout(pending.timer)
    pending.resolve({
      dispatch: frame.dispatch,
      ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      ...(frame.observation !== undefined ? { observation: frame.observation } : {}),
      ...(frame.observationError !== undefined ? { observationError: frame.observationError } : {}),
      ...(frame.blocking !== undefined ? { blocking: frame.blocking } : {}),
    })
  }

  /**
   * worker 就绪与系统授权的变化。
   *
   * 只认当前执行实例发来的：旧实例的状态帧改不了新实例的能力。换实例走重发
   * `host.ready`，不从这条事件里推。
   */
  #event(frame: DesktopEventFrame): void {
    const host = this.#host
    if (!host) return
    if (
      frame.connectionEpoch !== host.connectionEpoch ||
      frame.hostId !== host.hostId ||
      frame.hostEpoch !== host.hostEpoch
    ) {
      log.warn('desktop', '丢弃代际对不上的状态事件', { kind: frame.kind })
      return
    }
    if (frame.kind !== 'worker.state') {
      log.warn('desktop', '认不出的宿主事件', { kind: frame.kind })
      return
    }
    if (host.workerReady === frame.workerReady && host.authorized === frame.authorized) return
    // worker 退出或授权被撤销时，在途的那些调用已经没有人会回执，按已派发收尾。
    if (!frame.workerReady || !frame.authorized) this.#failPending('桌面宿主已不可用')
    this.#host = { ...host, workerReady: frame.workerReady, authorized: frame.authorized }
    this.#announce()
  }

  /**
   * 收掉一个执行者名下的待决调用。执行者释放时由协调器调。
   *
   * 分类与断线收尾同一条：**可证明未派发的才记 `not_dispatched`**。
   */
  settleExecutor(executorId: string, reason: string): void {
    this.#failPending(reason, (pending) => pending.executorId === executorId)
  }

  /**
   * 待决调用收尾。
   *
   * **可证明未派发的才记 `not_dispatched`**：`sent` 为假表示这一帧还没写进 socket。
   * 其余一律 `unknown`——帧已经出去了，宿主收没收到、worker 有没有执行无从确定，
   * 记成未执行会让调用方重发一次可能已经生效的动作。
   */
  #failPending(reason: string, match?: (pending: Pending) => boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      if (match && !match(pending)) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new DesktopBridgeError(reason, pending.sent ? 'unknown' : 'not_dispatched'))
    }
  }

  #reset(): void {
    this.#failPending('桌面宿主已断开')
    this.#host = null
    this.#announce()
  }

  #announce(): void {
    for (const listener of [...this.#hostChanges]) listener(this.#host)
  }
}
