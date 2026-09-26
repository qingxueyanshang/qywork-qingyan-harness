/**
 * 原生浏览器宿主连接的线上契约。
 *
 * 这条连接只承载浏览器资源操作：建页、关页、绑定归属、按会话关页、下载授权，
 * 以及宿主投影回来的导航 / 标题 / 关闭 / 下载事件。它不承载聊天指令，
 * 服务端也不把 `ClientCommand` 转发到这里。
 *
 * 类型与操作枚举只有这一处定义：Rust 宿主与 server 两侧按同一组字段编解码，
 * 契约测试用同一组 JSON 样例对齐（`packages/server/src/browser/bridge.test.ts`）。
 */

/** 宿主连接的路径。Rust 侧按它发起升级，server 侧按它分派。 */
export const NATIVE_BROWSER_PATH = '/native/browser'

/**
 * 宿主接受的操作。**新增一个就要同时改 Rust 侧的分派**，
 * 宿主对认不出的 op 一律回 `ok:false`，不猜测意图。
 *
 * 这份数组是 `BrowserOp` 的唯一来源，不从包外导出：调用方按类型受约束，
 * 多一份可运行时遍历的清单只会成为第二处「有哪些操作」的说法。
 */
const BROWSER_OPS = [
  'create',
  'close',
  'bind',
  'close.conversation',
  'download.arm',
  'download.disarm',
] as const
export type BrowserOp = (typeof BROWSER_OPS)[number]

/** 宿主投影回来的事件种类。 */
export const BROWSER_EVENT_KINDS = [
  'opened',
  'navigated',
  'title',
  'closed',
  'control',
  'download.blocked',
  'download.finished',
] as const
export type BrowserEventKind = (typeof BROWSER_EVENT_KINDS)[number]

/** 下载被钩子拒绝的原因。 */
export type DownloadBlockReason = 'unauthorized' | 'expired' | 'exists'

/**
 * 一个存活标签页。
 *
 * `marker` 是宿主注入进该页的不可写标记，CDP 侧按它把 tabId 落到 targetId 上。
 * 两个同 URL 的子视图在 CDP 的目标清单里 `url` 与 `title` 完全相同，只能按它区分。
 */
export interface BrowserTabSnapshot {
  tabId: string
  url: string
  title: string
  marker: string
  /**
   * 这一页所属的工作区 id。建页时定，此后不改——页面不在工作区之间移动。
   *
   * 用户页也有它：没有会话归属不等于没有工作区归属，界面按它决定这一页在不在
   * 当前页签条上，协调器按它决定模型看不看得见这一页。缺席不是合法状态，
   * 收到没有它的页一律拒收，不填空串顶上。
   */
  workspaceId: string
  /**
   * 拥有它的会话 id；`null` = 用户手动开的页（不归任何 AI 会话）。
   *
   * 归属跟着会话生命周期，跨消息稳定：AI 在某会话里 `create` 的页归它，之后该会话的每一条
   * 消息都能直接操作，不需要交接；会话删除即关它名下的页，归档不关。下载裁决也按它分岔
   * （归 AI 的页要授权，用户页走默认目录）。不要再加一个 `manual` 字段，这将是同一事项的独立第二份状态。
   */
  conversationId: string | null
}

/**
 * 页显示在哪里。`embedded` = 嵌在主窗口的面板里（Windows 的 WebView2 子视图）；
 * `window` = 在浏览器自己的窗口里（macOS 与 Linux 拉起的 Chrome / Edge / Chromium）。
 * 由宿主的引擎决定，同一个宿主进程里不变。
 */
export type BrowserPresentation = 'embedded' | 'window'

/**
 * 宿主注册帧。连接建立后宿主先发这一帧，服务端据此接受这条连接。
 *
 * `connectionEpoch` 由宿主每次连接自增：跨重连的旧请求与旧结果按它作废。
 */
export interface HostReadyFrame {
  type: 'host.ready'
  hostInstanceId: string
  connectionEpoch: number
  /** 宿主所在的操作系统：`windows` / `macos` / `linux`。 */
  platform: string
  presentation: BrowserPresentation
  /**
   * 浏览器运行时完整版本：Windows 为 WebView2 Runtime，由原生 API 取得；macOS 与 Linux
   * 为宿主拉起的 Chrome / Edge / Chromium，由它的调试端点报出。
   */
  runtimeVersion: string
  /**
   * 回环 CDP 端口。Windows 上由宿主分配，第一个子视图建起来之后才开始监听；
   * macOS 与 Linux 上是浏览器进程自己挑的端口，进程换代即换。
   */
  debugPort: number
  tabs: BrowserTabSnapshot[]
}

/**
 * 宿主此刻没有可用的浏览器。`not_found` = 本机找不到 Chrome、Edge 或 Chromium；
 * `exited` = 浏览器进程已退出，宿主正在重启它或已停止重启。
 */
export type BrowserUnavailableReason = 'not_found' | 'exited'

/**
 * 宿主连着但没有可用的浏览器。它顶替 `host.ready` 作为首帧，也在浏览器进程退出时
 * 于同一条连接上发出；浏览器重新起来后宿主再发一次 `host.ready`。
 *
 * 收到它即上一份快照与待决调用全部作废，能力按「没有宿主」发布，原因随能力给到界面。
 */
export interface HostUnavailableFrame {
  type: 'host.unavailable'
  reason: BrowserUnavailableReason
}

/**
 * 一次资源操作。
 *
 * `deadline` 是绝对毫秒时刻，宿主按它拒绝过期请求；
 * `conversationId` 是宿主核实归属的判据——`create` 归它、`bind` 接管到它、
 * `download.arm` 要求这一页已归它、`close.conversation` 关它名下的全部页。
 * 页面内容与模型给出的 tabId 都不能改归属。
 */
export interface BrowserRequestFrame {
  type: 'browser.request'
  requestId: string
  connectionEpoch: number
  deadline: number
  op: BrowserOp
  tabId?: string
  /**
   * 目标工作区，`create` 与 `bind` 必带且非空。
   *
   * 宿主按 op 校验，缺席直接拒绝：回落到「当前工作区」需要宿主自己存一份当前状态，
   * 而当前在看哪个工作区只有界面知道。`bind` 用它拒绝跨工作区接管。
   */
  workspaceId?: string
  conversationId?: string
  /** `create` 的目标地址。 */
  url?: string
  /** `download.arm` 的已裁决绝对路径。 */
  path?: string
  /**
   * 这一次下载的身份，`download.arm` 与 `download.disarm` 必带。
   *
   * 服务端每次调用生成一个不复用的值，宿主把它绑在授权上并随终态事件原样回报。
   * 少了它，同一页上一次调用的迟到终态会结算这一次——按 tabId 只分得开页，分不开新旧调用。
   */
  downloadId?: string
}

/** 操作结果。`data` 的字段按 op 取用，认不出的 op 只会回 `ok:false`。 */
export interface BrowserResultFrame {
  type: 'browser.result'
  requestId: string
  connectionEpoch: number
  ok: boolean
  data?: {
    tabId?: string
    /** `bind` 专有。`create` 不带它：建页不占页，认页的标记由 `opened` 事件给出。 */
    marker?: string
    url?: string
    title?: string
    removed?: boolean
  }
  error?: string
}

/**
 * 宿主事件。`seq` 单调递增，缺口意味着要重新拉快照，不重放有副作用的命令。
 *
 * `opened` 是新页进入存活集合的唯一途径——**用户自己新开的页也走它**，
 * 否则服务端只认得 AI 建的那些，模型在 `browser_tabs` 里看不见用户的页。
 */
export interface BrowserEventFrame {
  type: 'browser.event'
  connectionEpoch: number
  seq: number
  kind: BrowserEventKind
  tabId: string
  url?: string
  title?: string
  /** `opened` 专有：这一页的注入标记，CDP 侧按它认页。 */
  marker?: string
  /**
   * `opened` 必带：这一页所属的工作区。
   *
   * 新页只经这条事件进入服务端存活表，缺了它那一页没有工作区归属；服务端按协议错误
   * 拒收，不猜当前工作区也不填空串。导航、标题与 `control` 事件不带它，工作区不改。
   */
  workspaceId?: string
  /** `opened` 的初始归属与 `control`（`bind` 后）的新归属。`null` = 用户页。 */
  conversationId?: string | null
  path?: string
  success?: boolean
  reason?: DownloadBlockReason
  suggestedName?: string
  /**
   * `download.finished` / `download.blocked` 专有：宿主消费掉的那份授权的身份。
   *
   * 缺席即这次下载没有命中任何授权（用户页的下载，或 AI 页上未经授权的下载），
   * **它不得结算任何工具调用**。
   */
  downloadId?: string
}

/** 宿主发往服务端的帧。 */
export type NativeBrowserUpFrame =
  | HostReadyFrame
  | HostUnavailableFrame
  | BrowserResultFrame
  | BrowserEventFrame
