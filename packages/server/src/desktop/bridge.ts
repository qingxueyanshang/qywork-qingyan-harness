/**
 * 桌面原生宿主连接的服务端一侧。
 *
 * 该连接由宿主主动建立，只承载桌面控件的观察与动作；聊天指令与浏览器资源操作
 * 均不经由此处。服务端不发起连接，也不知道宿主进程的位置。
 *
 * 四条边界：
 *
 * 1. **宿主身份由服务端判定**，不读取客户端自报的任何字段：只有本机回环连接、
 *    且携带本次启动的宿主凭据，才会被升级到该路径；宿主类型由 URL 路径决定。
 * 2. **断线时结束全部待决调用，按执行事实分类**：写入 socket 之前失败的记为
 *    `not_dispatched`，已写出的记为 `unknown`。**不重放**任何已发出的操作。
 * 3. **跨代际的结果一律丢弃**：结果按 `requestId` 加 `connectionEpoch` 加
 *    `hostId`/`hostEpoch` 四项配对，不一致的迟到结果不得完成另一次调用。
 * 4. **执行实例更换代际时重发 `host.ready`**：WS 未断开而 worker 被替换时，宿主以新的
 *    `hostEpoch` 重新发送注册帧，旧实例名下的待决调用按第 2 条结束。
 */

import type {
  DesktopAction,
  DesktopBlockingWindow,
  DesktopEventFrame,
  DesktopGrant,
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
import { log, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import type { SocketData } from '../deps.ts'
import { timingSafeEqual } from '../pairing.ts'

/** 一次操作的默认期限。宿主按它拒绝过期请求，服务端按它拒绝本地待决调用。 */
const DEFAULT_DEADLINE_MS = 20_000

/** 已连接的宿主。没有宿主时不发布电脑控制能力。 */
export interface NativeDesktopHost {
  hostId: string
  hostEpoch: number
  connectionEpoch: number
  platform: string
  workerReady: boolean
  authorized: boolean
  missing: DesktopGrant[]
}

/**
 * 一次调用的结果。
 *
 * `dispatch` 是执行事实，**任何失败都必须携带它**：将宿主断开概括为普通异常时，
 * 调用方无法区分「未执行」与「可能已执行」，而后者禁止重发。
 */
export interface DesktopCallResult {
  dispatch: DesktopResultFrame['dispatch']
  reason?: string
  observation?: DesktopObservation
  observationError?: string
  /** 动作调用尚未返回时目标进程当前的顶层窗口。见协议中的 `blocking`。 */
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
  /** 该帧是否已写入 socket。未写出的请求在结束时记为 `not_dispatched`。 */
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
   * `foreground` 每条请求实时读取一次，不保存快照：保存快照时，用户在运行中关闭前台接管
   * 要等到宿主更换代际才生效。
   */
  constructor(key: string, foreground: () => boolean) {
    this.#key = key
    this.#foreground = foreground
  }

  /**
   * 判定该请求能否升级为宿主连接。
   *
   * 回环地址是必要条件：局域网监听器复用同一份 handler，缺少该条件时手机端也能
   * 进入凭据比较。
   *
   * 凭据与浏览器宿主共用同一份：两条路径由同一个桌面外壳进程发起，同一次启动只有一个
   * 随机值。**区分宿主种类的是 URL 路径，不是客户端自报的字段**，因此共用凭据不会使
   * 一条连接进入另一类连接的帧处理。
   */
  accepts(req: Request, address: string | null): boolean {
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const presented = req.headers.get(NATIVE_HOST_KEY_HEADER)
    if (!presented) return false
    return timingSafeEqual(presented, this.#key)
  }

  /** 已连接的宿主。`null` 表示当前没有桌面控制能力。 */
  host(): NativeDesktopHost | null {
    return this.#host
  }

  /** 模型可见状态与请求帧共用当前配置。 */
  foregroundEnabled(): boolean {
    return this.#foreground()
  }

  onHostChange(listener: (host: NativeDesktopHost | null) => void): () => void {
    this.#hostChanges.add(listener)
    return () => this.#hostChanges.delete(listener)
  }

  /**
   * 发起一次桌面操作。
   *
   * 没有宿主、worker 未就绪、系统未授权，三种情况均在本地拒绝并记为 `not_dispatched`：
   * 不能等待远端返回，远端可能已不存在。写入 socket 之后才可能出现 `unknown`。
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
      foreground: this.foregroundEnabled(),
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
        // 超时的动作请求可能已在 OS 中执行完毕而回执尚未返回，因此按已派发记录。
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
      // 先登记再发送：回执可能在 send 返回之前到达，此时表中必须已有该条目。
      try {
        socket.send(JSON.stringify(frame))
        entry.sent = true
      } catch (err) {
        this.#pending.delete(requestId)
        clearTimeout(timer)
        reject(
          new DesktopBridgeError(
            `桌面操作 ${op} 未发出：${err instanceof Error ? err.message : String(err)}`,
            'not_dispatched',
          ),
        )
      }
    })
  }

  /** 宿主已连接。握手已在 `accepts` 中完成，此处只登记 socket。 */
  open(ws: ServerWebSocket<SocketData>): void {
    if (this.#socket && this.#socket !== ws) {
      this.#socket.close(1000, 'replaced')
      this.#reset()
    }
    this.#socket = ws
  }

  /** 宿主断开：待决调用按执行事实结束，能力随之撤销。 */
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
    // 重连或更换 worker 均按新代际重建：先结束上一代的待决调用，再登记新身份。
    this.#failPending('桌面宿主已重新注册')
    this.#host = {
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      connectionEpoch: frame.connectionEpoch,
      platform: frame.platform,
      workerReady: frame.workerReady,
      authorized: frame.authorized,
      missing: frame.missing,
    }
    log.info('desktop', '桌面宿主已连接', {
      platform: frame.platform,
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      connectionEpoch: frame.connectionEpoch,
      workerReady: frame.workerReady,
      authorized: frame.authorized,
      missing: frame.missing,
    })
    this.#announce()
  }

  /**
   * 认领一条结果。
   *
   * 四项身份全部一致才认领。只比较 `requestId` 时，重连或更换 worker 之后一条迟到的回执
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
      log.warn('desktop', '丢弃代际不一致的迟到回执', { requestId: frame.requestId })
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
   * 只接受当前执行实例发送的事件：旧实例的状态帧不能改变新实例的能力。更换实例经由重发
   * `host.ready` 完成，不从该事件推断。
   */
  #event(frame: DesktopEventFrame): void {
    const host = this.#host
    if (!host) return
    if (
      frame.connectionEpoch !== host.connectionEpoch ||
      frame.hostId !== host.hostId ||
      frame.hostEpoch !== host.hostEpoch
    ) {
      log.warn('desktop', '丢弃代际不一致的状态事件', { kind: frame.kind })
      return
    }
    if (frame.kind !== 'worker.state') {
      log.warn('desktop', '无法识别的宿主事件', { kind: frame.kind })
      return
    }
    if (
      host.workerReady === frame.workerReady &&
      host.authorized === frame.authorized &&
      host.missing.join() === frame.missing.join()
    ) {
      return
    }
    // worker 退出或授权被撤销时，在途调用不会再收到回执，按执行事实结束。
    if (!frame.workerReady || !frame.authorized) this.#failPending('桌面宿主已不可用')
    this.#host = {
      ...host,
      workerReady: frame.workerReady,
      authorized: frame.authorized,
      missing: frame.missing,
    }
    this.#announce()
  }

  /**
   * 结束某个执行者名下的待决调用。执行者释放时由协调器调用。
   *
   * 分类规则与断线时相同：**可证明未派发的才记为 `not_dispatched`**。
   */
  settleExecutor(executorId: string, reason: string): void {
    this.#failPending(reason, (pending) => pending.executorId === executorId)
  }

  /**
   * 结束待决调用。
   *
   * **可证明未派发的才记为 `not_dispatched`**：`sent` 为假表示该帧尚未写入 socket。
   * 其余一律记为 `unknown`：帧已发出，宿主是否收到、worker 是否执行均无法确定，
   * 记为未执行会使调用方重发一次可能已生效的动作。
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
