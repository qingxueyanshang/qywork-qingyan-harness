/**
 * 原生浏览器宿主连接的线上契约。
 *
 * 该连接只承载浏览器资源操作：创建页面、关闭页面、绑定归属、按会话关闭页面、下载授权，
 * 以及宿主上报的导航 / 标题 / 关闭 / 下载事件。它不承载聊天指令，
 * 服务端也不把 `ClientCommand` 转发到此处。
 *
 * 类型与操作枚举只在此处定义：Rust 宿主与 server 两侧按同一组字段编解码，
 * 契约测试使用同一组 JSON 样例保持一致（`packages/server/src/browser/bridge.test.ts`）。
 */

/** 宿主连接的路径。Rust 侧据此发起协议升级，server 侧据此分派。 */
export const NATIVE_BROWSER_PATH = '/native/browser'

/**
 * 宿主接受的操作。新增操作时必须同时修改 Rust 侧的分派，
 * 宿主对无法识别的 op 一律返回 `ok:false`，不推测意图。
 *
 * 该数组是 `BrowserOp` 的唯一来源，不从包中导出：调用方受类型约束，
 * 再提供一份可在运行时遍历的清单，只会成为操作集合的第二处定义。
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

/** 宿主上报的事件种类。 */
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
 * 一个存活的标签页。
 *
 * `marker` 是宿主注入该页的不可写标记，CDP 侧据此将 tabId 对应到 targetId。
 * 两个 URL 相同的子视图在 CDP 目标清单中的 `url` 与 `title` 完全相同，只能据此区分。
 */
export interface BrowserTabSnapshot {
  tabId: string
  url: string
  title: string
  marker: string
  /**
   * 页面所属的工作区 id。创建页面时确定，此后不变：页面不在工作区之间移动。
   *
   * 用户页也有该字段：没有会话归属不等于没有工作区归属。界面据此决定页面是否显示在
   * 当前标签栏上，协调器据此决定模型能否看到该页面。缺席不是合法状态，
   * 不带该字段的页面一律拒收，不以空串填充。
   */
  workspaceId: string
  /**
   * 拥有该页面的会话 id；`null` 表示用户手动打开的页面（不属于任何 AI 会话）。
   *
   * 归属随会话生命周期，跨消息稳定：AI 在某会话中 `create` 的页面归属该会话，之后该会话的每一条
   * 消息都能直接操作，无需交接；删除会话时关闭其名下的页面，归档时不关闭。下载裁决也据此区分
   * （AI 的页面需要授权，用户页使用默认目录）。不要添加 `manual` 字段，否则同一事项会出现独立的第二份状态。
   */
  conversationId: string | null
}

/**
 * 页面的显示位置。`embedded` 表示嵌入主窗口的面板（Windows 的 WebView2 子视图）；
 * `window` 表示显示在浏览器自身的窗口中（macOS 与 Linux 启动的 Chrome / Edge / Chromium）。
 * 由宿主的引擎决定，同一个宿主进程内不变。
 */
export type BrowserPresentation = 'embedded' | 'window'

/**
 * 宿主注册帧。连接建立后宿主首先发送该帧，服务端据此接受连接。
 *
 * `connectionEpoch` 由宿主在每次连接时自增：跨重连的旧请求与旧结果据此作废。
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
   * 为宿主启动的 Chrome / Edge / Chromium，由其调试端点报告。
   */
  runtimeVersion: string
  /**
   * 回环 CDP 端口。Windows 上由宿主分配，第一个子视图创建后才开始监听；
   * macOS 与 Linux 上是浏览器进程自行选择的端口，进程重启后即变化。
   */
  debugPort: number
  tabs: BrowserTabSnapshot[]
}

/**
 * 宿主当前没有可用的浏览器。`not_found` 表示本机未找到 Chrome、Edge 或 Chromium；
 * `exited` 表示浏览器进程已退出，宿主正在重启或已停止重启。
 */
export type BrowserUnavailableReason = 'not_found' | 'exited'

/**
 * 宿主已连接但没有可用的浏览器。该帧代替 `host.ready` 作为首帧，也在浏览器进程退出时
 * 于同一连接上发出；浏览器重新启动后宿主再发送一次 `host.ready`。
 *
 * 收到该帧时，上一份快照与待决调用全部作废，能力按「没有宿主」发布，原因随能力一并交给界面。
 */
export interface HostUnavailableFrame {
  type: 'host.unavailable'
  reason: BrowserUnavailableReason
}

/**
 * 一次资源操作。
 *
 * `deadline` 是绝对毫秒时刻，宿主据此拒绝过期请求；
 * `conversationId` 是宿主核实归属的依据：`create` 的页面归属该会话、`bind` 将页面接管到该会话、
 * `download.arm` 要求该页面已归属该会话、`close.conversation` 关闭该会话名下的全部页面。
 * 页面内容与模型给出的 tabId 都不能改变归属。
 */
export interface BrowserRequestFrame {
  type: 'browser.request'
  requestId: string
  connectionEpoch: number
  deadline: number
  op: BrowserOp
  tabId?: string
  /**
   * 目标工作区，`create` 与 `bind` 必须携带且非空。
   *
   * 宿主按 op 校验，缺席时直接拒绝：回退到「当前工作区」需要宿主自行保存一份当前状态，
   * 而当前查看的是哪个工作区只有界面知道。`bind` 据此拒绝跨工作区接管。
   */
  workspaceId?: string
  conversationId?: string
  /** `create` 的目标地址。 */
  url?: string
  /** `download.arm` 的已裁决绝对路径。 */
  path?: string
  /**
   * 本次下载的身份，`download.arm` 与 `download.disarm` 必须携带。
   *
   * 服务端每次调用生成一个不复用的值，宿主将其绑定到授权上，并随终态事件原样回报。
   * 缺少该值时，同一页面上一次调用的迟到终态会结算本次调用：tabId 只能区分页面，无法区分新旧调用。
   */
  downloadId?: string
}

/** 操作结果。`data` 的字段按 op 取用，无法识别的 op 只会返回 `ok:false`。 */
export interface BrowserResultFrame {
  type: 'browser.result'
  requestId: string
  connectionEpoch: number
  ok: boolean
  data?: {
    tabId?: string
    /** `bind` 专有。`create` 不带该字段：创建页面不接管已有页面，识别页面的标记由 `opened` 事件给出。 */
    marker?: string
    url?: string
    title?: string
    removed?: boolean
  }
  error?: string
}

/**
 * 宿主事件。`seq` 单调递增，出现缺口时需重新获取快照，不重放有副作用的命令。
 *
 * `opened` 是新页面进入存活集合的唯一途径，用户自行打开的页面也经由该事件；
 * 否则服务端只识别 AI 创建的页面，模型在 `browser_tabs` 中看不到用户的页面。
 */
export interface BrowserEventFrame {
  type: 'browser.event'
  connectionEpoch: number
  seq: number
  kind: BrowserEventKind
  tabId: string
  url?: string
  title?: string
  /** `opened` 专有：该页面的注入标记，CDP 侧据此识别页面。 */
  marker?: string
  /**
   * `opened` 必须携带：页面所属的工作区。
   *
   * 新页面只经由该事件进入服务端存活表，缺少该字段时页面没有工作区归属；服务端按协议错误
   * 拒收，不推测当前工作区，也不填充空串。导航、标题与 `control` 事件不带该字段，工作区不变。
   */
  workspaceId?: string
  /** `opened` 的初始归属与 `control`（`bind` 之后）的新归属。`null` 表示用户页。 */
  conversationId?: string | null
  path?: string
  success?: boolean
  reason?: DownloadBlockReason
  suggestedName?: string
  /**
   * `download.finished` / `download.blocked` 专有：宿主已消费的授权的身份。
   *
   * 缺席表示本次下载未匹配任何授权（用户页的下载，或 AI 页面上未经授权的下载），
   * 此时该事件不得结算任何工具调用。
   */
  downloadId?: string
}

/** 宿主发往服务端的帧。 */
export type NativeBrowserUpFrame =
  | HostReadyFrame
  | HostUnavailableFrame
  | BrowserResultFrame
  | BrowserEventFrame
