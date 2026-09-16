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
 * 宿主凭据所在的请求头。
 *
 * 不放查询串：URL 会进访问日志与错误信息，而这个值等同于「可以注册宿主」。
 */
export const NATIVE_BROWSER_KEY_HEADER = 'x-qywork-browser-key'

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
   * 拥有它的会话 id；`null` = 用户手动开的页（不归任何 AI 会话）。
   *
   * 归属跟着会话生命周期，跨消息稳定：AI 在某会话里 `create` 的页归它，之后该会话的每一条
   * 消息都能直接操作，不需要交接；会话删除/归档即关它名下的页。下载裁决也按它分岔
   * （归 AI 的页要授权，用户页走默认目录）。不要再加一个 `manual` 字段，这将是同一事项的独立第二份状态。
   */
  conversationId: string | null
}

/**
 * 宿主注册帧。连接建立后宿主先发这一帧，服务端据此接受这条连接。
 *
 * `connectionEpoch` 由宿主每次连接自增：跨重连的旧请求与旧结果按它作废。
 */
export interface HostReadyFrame {
  type: 'host.ready'
  hostInstanceId: string
  connectionEpoch: number
  platform: string
  /** WebView2 Runtime 完整版本，由原生 API 取得，不由插件自报。 */
  runtimeVersion: string
  /** 宿主分配的回环 CDP 端口。只有子视图建起来之后那个端口才开始监听。 */
  debugPort: number
  tabs: BrowserTabSnapshot[]
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
export type NativeBrowserUpFrame = HostReadyFrame | BrowserResultFrame | BrowserEventFrame
