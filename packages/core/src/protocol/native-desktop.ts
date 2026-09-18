/**
 * 桌面原生宿主连接的线上契约。
 *
 * 这条连接只承载桌面控件的观察与动作；聊天指令不经它，浏览器资源操作也不经它
 * （那一条在 `native-browser.ts`，两条 socket 的 ready 快照与断线语义各自独立）。
 *
 * 三条身份，生命周期互不相同，不能合成一个数：
 *
 * - `hostId`：宿主进程每次启动产生的新身份。
 * - `connectionEpoch`：宿主每次建立这条 WS 时自增，跨重连的请求与结果按它作废。
 * - `hostEpoch`：宿主在同一 `hostId` 下每换一个 worker 进程就自增。WS 不断而 worker
 *   被换掉时只有它变，旧观察、旧 ref 与旧队列整体作废。
 *
 * **句柄只在这条连接上出现。** `DesktopWindow.handle` 是 OS 窗口句柄，服务端按它向宿主
 * 寻址，对模型只发放不透明 id。
 */

/** 宿主连接的路径。宿主按它发起升级，server 侧按它分派。 */
export const NATIVE_DESKTOP_PATH = '/native/desktop'

/**
 * 宿主与 worker 之间那份协议的版本。
 *
 * 服务端在 `host.ready` 里核对它：版本不一致即不注册宿主，不做字段级兼容。
 */
export const DESKTOP_PROTOCOL_VERSION = 1

/**
 * 宿主接受的操作。**新增一个就要同时改宿主侧的分派**，宿主对认不出的 op 一律回
 * `not_dispatched`，不猜测意图。
 *
 * `cancel` 撤销的是**发起它的那个执行者名下尚未派发的请求**，目标写在帧的
 * `executorId` 上；已经进入 OS 调用的请求不会被它中止。
 */
const DESKTOP_OPS = [
  'list_windows',
  'read_tree',
  'read_element',
  'set_value',
  'invoke',
  'cancel',
] as const
export type DesktopOp = (typeof DESKTOP_OPS)[number]

/**
 * 执行事实。只描述「这次请求要求的状态改变动作」有没有交到 OS 手里。
 *
 * 只读请求与 `cancel` 不改变状态，一律 `not_dispatched`：成功时带 `observation`，
 * 失败时带 `reason`。`submitted` 因此只有一个含义，不会被读取成功的回执稀释。
 */
export type DesktopDispatch =
  /** 可证明没有发出动作调用：准入拒绝、控件模式缺失、只读、目标已失效。 */
  | 'not_dispatched'
  /** 动作调用已被系统接受并返回成功。不代表业务已完成。 */
  | 'submitted'
  /** 调用已发出但结果无法确认，动作可能已经生效。不得改记为未执行。 */
  | 'unknown'

/** 控件此刻可用的动作。只列宿主真的实现了的那些。 */
export type DesktopNodeAction = 'set_value' | 'invoke'

/**
 * 一个顶层窗口。
 *
 * `handle` 与 `pid` 都会被 OS 复用，**单独作为长期身份不成立**：三项一起才认得出
 * 「还是不是刚才那一个」。`processStartedAt` 由宿主填，worker 只给得出句柄与 pid。
 */
export interface DesktopWindow {
  /** OS 窗口句柄。只在服务端与宿主之间传递。 */
  handle: number
  pid: number
  /** 进程启动时刻，Unix 纪元毫秒。 */
  processStartedAt: number
  /** 可执行文件的显示名，界面上「正在操作哪个应用」显示的就是它。 */
  app: string
  title: string
}

/**
 * 一次操作的目标窗口身份。
 *
 * 三项一起给，宿主在派发之前重新核对：只给句柄的话，目标窗口在观察与动作之间关闭、
 * 句柄被另一个窗口复用时，动作会落在那个窗口上而不报错。
 */
export interface DesktopTarget {
  window: number
  pid: number
  processStartedAt: number
}

/** 观察的完整性。截断原因逐条列出，调用方不能把「没采到」读成「没有」。 */
export interface DesktopCompleteness {
  complete: boolean
  truncatedBy: string[]
}

/**
 * 控件树上的一个节点。
 *
 * `ref` 是不透明引用，只在产生它的那一次观察内有效；动作请求原样带回，宿主按它
 * 重新定位控件。
 */
export interface DesktopNode {
  ref: string
  role: string
  name: string
  automationId: string
  value?: string
  enabled: boolean
  offscreen: boolean
  actions: DesktopNodeAction[]
  children: DesktopNode[]
}

/**
 * 一次观察。
 *
 * 只有这三种进得了服务端：宿主与 worker 之间的握手、取消登记与连接绑定回执止于宿主，
 * 服务端不认那几种。
 */
export type DesktopObservation =
  | { kind: 'windows'; capturedAt: number; windows: DesktopWindow[] }
  | {
      kind: 'tree'
      window: number
      capturedAt: number
      completeness: DesktopCompleteness
      nodeCount: number
      root: DesktopNode
    }
  | { kind: 'element'; window: number; capturedAt: number; element: DesktopNode }

/**
 * 宿主注册帧。连接建立后宿主先发这一帧，服务端据此接受这条连接。
 *
 * 同一条连接上可以再发：worker 被换掉时宿主用新的 `hostEpoch` 重发一次，服务端据此
 * 作废旧执行实例名下的一切。`connectionEpoch` 由宿主每次连接自增。
 */
export interface DesktopHostReadyFrame {
  type: 'host.ready'
  hostId: string
  hostEpoch: number
  connectionEpoch: number
  /** worker 实际握手到的协议版本，由宿主从 worker 读回，不是它自己填的常量。 */
  protocol: number
  platform: string
  /** worker 进程已握手就绪。 */
  workerReady: boolean
  /** 操作系统已授予桌面控制所需的权限。 */
  authorized: boolean
}

/**
 * 一次桌面操作。
 *
 * `deadline` 是绝对毫秒时刻：请求在队列里等待的时间要计入预算，写成相对毫秒的话，
 * 排在一次长调用后面的请求会拿着已经用完的预算被派发。
 *
 * 身份四项（`hostId` / `hostEpoch` / `connectionEpoch` / `executorId`）每条都带：
 * 前三项是宿主与 worker 的准入判据，`executorId` 是排队与撤销的归属。
 */
export interface DesktopRequestFrame {
  type: 'desktop.request'
  requestId: string
  /**
   * 动作身份。只有 `set_value` / `invoke` 带它。
   *
   * 与 `requestId` 分列：回执丢失后重新观察确认时，调用方要能说出「是哪一次动作」，
   * 而重试产生的是新的 `requestId`。
   */
  actionId?: string
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  executorId: string
  deadline: number
  op: DesktopOp
  /** 目标窗口身份。`list_windows` 与 `cancel` 不带。 */
  target?: DesktopTarget
  /** 目标控件引用，取自同一次观察。 */
  ref?: string
  /** `set_value` 要写入的值。空串是清空，与缺席不是一回事。 */
  value?: string
  maxNodes?: number
  maxDepth?: number
  timeBudgetMs?: number
}

/**
 * 操作结果。
 *
 * `dispatch` 是执行事实，`observation` 是动作之后重读到的状态，两者分列：重读失败时
 * `observationError` 单独成立，`dispatch` 保持原值，不得改记为未执行。
 */
export interface DesktopResultFrame {
  type: 'desktop.result'
  requestId: string
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  dispatch: DesktopDispatch
  /** 拒绝原因码，或动作调用返回的失败原文。 */
  reason?: string
  observation?: DesktopObservation
  observationError?: string
}

/**
 * 宿主主动推的状态变化。
 *
 * 只有 worker 就绪与系统授权两件事：它们在同一个执行实例内会变（用户授权、worker 退出），
 * 而换执行实例走的是重发 `host.ready`。
 */
export interface DesktopEventFrame {
  type: 'desktop.event'
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  kind: 'worker.state'
  workerReady: boolean
  authorized: boolean
}

/** 宿主发往服务端的帧。 */
export type NativeDesktopUpFrame = DesktopHostReadyFrame | DesktopResultFrame | DesktopEventFrame
