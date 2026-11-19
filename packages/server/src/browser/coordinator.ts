/**
 * 浏览器控制协调器：应用进程级对象，由 `serve` 装配。
 *
 * 它只执行已绑定身份的操作，不规划任务，也不另行记录任务进度。
 *
 * 归属模型：标签页的归属键是会话 id，跨消息保持不变。AI 在某会话中 `create` 的页归该会话所有，
 * 此后该会话的每一条消息都能直接 observe/act：协调器在第一次操作时按会话归属自动附加
 * CDP 会话，无需交接。归属记录在原生宿主上（`Tab.conversation_id`），删除会话即关闭其名下的页。
 *
 * 四条边界：
 *
 * 1. **控制槽按执行者分配，互斥粒度为单页。** 每次执行各有独立的 CDP 连接、页会话表
 *    与观察表，同一会话的父子与并行成员各自操作自己的页；两个执行者访问同一页时，后到的
 *    一方收到明确失败，不排队、不抢占。
 *    本条不影响归属：C 的 run 释放后，C 的页仍归 C，供 C 的下一条消息继续使用。
 * 2. **只操作本工作区中本会话的页。** 先按工作区限定：其他工作区的页不列出，也无法附加，
 *    用户页同样只在本工作区中可见。在此基础上再判定会话归属：用户页须由用户在聊天中点名、模型
 *    `bind` 之后才归本会话。
 * 3. **宿主断开或重连时全部控制失效**：丢弃 CDP 连接与页会话；归属保留在宿主上，重连后继续使用。
 * 4. **页面读取的本机文件按浏览器工具提供的读取范围裁决**（端口的 `localFiles`）：受控期间逐个 file 请求
 *    裁决（`cdp.ts`），读取页面内容之前核对页面中已加载的文档与资源（`#assertLocalFiles`）。
 */

import { stat } from 'node:fs/promises'
import type { BrowserEventFrame } from '@qywork/core'
import { ART_POSTER_MS, log } from '@qywork/core'
import {
  BROWSER_DIALOG_NAMES,
  type BrowserActInput,
  type BrowserActivity,
  type BrowserActResult,
  type BrowserDownloadResult,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPort,
  type BrowserRefusal,
  type BrowserTabInfo,
  type BrowserWaitResult,
  type BrowserWaitState,
  type FollowUpObservation,
  type LocalFileCheck,
} from '@qywork/tools'
import { ART_HOST_PATH, ART_LIB_PATH, prepareArtForRender } from '../art.ts'
import { type BrowserBridge, BrowserBridgeError, type NativeBrowserHost } from './bridge.ts'
import {
  BrowserArgumentError,
  CdpClient,
  CdpDisconnectedError,
  CdpInitError,
  CdpTimeoutError,
  type JsDialog,
} from './cdp.ts'
import {
  actOnPage,
  BrowserStaleRefError,
  clickForDownload,
  newNumbering,
  type ObservationRecord,
  observePage,
  type PageHandle,
  type RefNumbering,
  readDocument,
  readSelectOptions,
  uploadToPage,
  waitOnPage,
} from './page.ts'
import { type ArtRenderResult, renderArtPage } from './render.ts'

/**
 * 浏览器控制的最低 Chromium 主版本。WebView2 Runtime 与 Chrome / Edge / Chromium 均按此版本判定。
 *
 * 该主版本接受 `Emulation.setFocusEmulationEnabled`，附加目标、跨站子会话、
 * 页面输入、截图、AX 树、`DOM.setFileInputFiles` 与逐下载钩子均已实测通过
 * （WebView2 152.0.4191.66）。低于该版本时不发布 AI 控制能力，手动浏览不受影响。
 */
export const MIN_CHROMIUM_MAJOR = 152

/**
 * 该页正被另一个执行者占用。
 *
 * 本次调用尚未向宿主或 CDP 发出任何帧，因此按 `BrowserRefusal` 声明 `executed:false`：
 * 调用方据此确认页面未被修改。已发出的动作即使随后失败，也不得使用该错误类型。
 */
export class BrowserBusyError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_busy' as const
  readonly executed = false as const
}
/** 该端口已释放。上一条消息的 Run 收尾之后再调用工具时抛出此错误，端口不再恢复控制。 */
export class BrowserReleasedError extends Error {}
/** 用户关闭了浏览器控制（`browserEnabled`）。判定先于任何帧，因此声明 `executed:false`。 */
export class BrowserUnavailableError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_unavailable' as const
  readonly executed = false as const
}
/**
 * 该 tabId 不在本次执行可见的清单中：跨工作区、跨会话、未接管的用户页与无法识别的 id
 * 均使用此错误。
 *
 * 判定在同步段完成，未发出任何帧，因此同样按 `BrowserRefusal` 声明 `executed:false`。
 */
export class BrowserNotOwnedError extends Error implements BrowserRefusal {
  readonly errorKind = 'invalid_argument' as const
  readonly executed = false as const
}

/**
 * 页面中已加载读取范围之外的本机文件，本次不读取页面内容。判定先于采集，因此声明 `executed:false`。
 *
 * 受控期间页面发出的 file 请求已由客户端按请求发出时的读取范围逐个裁决（`cdp.ts` 文件头第 5 条），这类文件
 * 来自拦截之外的加载：建页时的首次加载、两次执行之间、用户接管之前，或完全访问下加载之后切换为自动审批。
 * 重新加载即在拦截下加载，被拒绝的文件不再进入页面。
 */
export class BrowserLocalFileError extends Error implements BrowserRefusal {
  readonly errorKind = 'credential_path' as const
  readonly executed = false as const

  constructor(url: string, reason: string) {
    super(
      `页面中已加载读取范围之外的本机文件 ${url}，本次不读取页面内容。${reason}\n` +
        '用 browser_navigate 重新加载本页（reload）或打开其他地址后再读取：受控期间该文件的加载会被拒绝。',
    )
  }
}

/** 连接准备阶段失败，尚未进入页面业务动作。 */
class BrowserConnectionError extends Error implements BrowserRefusal {
  readonly errorKind = 'browser_disconnected' as const
  readonly executed = false as const

  constructor(cause: CdpDisconnectedError) {
    super(
      '浏览器控制连接准备失败，本次页面操作未执行。' +
        '请对原 tabId 调用 browser_observe 重连并取得新观察；无需新开标签或延长页面等待。' +
        `再次失败时停止重复调用并报告。原因：${cause.detail}`,
      { cause },
    )
  }
}

/** 浏览器工具从未设置本机文件裁决时的拒绝理由（`Lease.files`）。 */
const NO_FILE_SCOPE = '本次执行没有本机文件的读取范围'

/** `Page.getResourceTree` 的一层：帧的当前文档地址与它已加载的资源。 */
interface ResourceTreeNode {
  frame: { url: string }
  resources?: { url: string; failed?: boolean }[]
  childFrames?: ResourceTreeNode[]
}

/**
 * 动作或导航之后等待页面静默的总上限。
 *
 * 等待按加载进展计时（见 `#quietWait`），本上限只约束不断请求新地址的页面；到达上限时照常采集观察并标注
 * `deadline`，不是失败。之后的观察使用观察自己的期限，不从等待中扣除。
 */
const SETTLE_CEILING_MS = 30_000
/** 没有未结束的新地址请求时，距最近一次加载进展的等待上限。到时即采集，采集成功时按 `deadline` 如实标注。 */
const QUIET_IDLE_MS = 1_500
/**
 * 有未结束的新地址请求（导航时另含主文档仍在加载）时，距最近一次加载进展的等待上限。
 *
 * 取值依据：点击之后模型自选的等待时长 90% 不超过 5 秒。长连接与长轮询发出之后没有进展，按本上限结束等待。
 */
const NETWORK_IDLE_MS = 5_000
/** 不计为加载进展的请求类型：页面加载完之后它们仍持续传输。 */
const STREAMING_TYPES: ReadonlySet<string> = new Set(['Media', 'EventSource', 'WebSocket', 'Ping'])
/** 静默采样间隔。 */
const QUIET_SAMPLE_MS = 100
/** 探针命令的单条上限；剩余预算更短时取剩余预算。 */
const PROBE_TIMEOUT_MS = 2_000
/** 等待导航提交事件的上限。 */
const COMMIT_WAIT_MS = 3_000
/** 导航命令距该页最近一次协议事件的上限（`renewOnEvents`）：页面持续有网络与加载事件时导航命令不超时。 */
const NAVIGATE_TIMEOUT_MS = 30_000
/**
 * 一次释放的绝对清理预算：撤销授权、页内等待器清理、detach 与断开连接共用该预算。
 *
 * 若按页重新分配完整预算，控制多页的执行的收尾时间随页数线性增长，而释放发生在
 * 用户按下停止之后，这段时间内界面没有任何进展。
 */
const RELEASE_BUDGET_MS = 5_000
/** 一次设计稿渲染（建页、加载引导页与页面、等待入场、截图）的总时限。 */
const RENDER_BUDGET_MS = 20_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 距截止时间的剩余毫秒数。 */
const leftMs = (deadline: number) => deadline - Date.now()
/** 探针命令的超时：取剩余预算与单条上限中的较小值。 */
const probeTimeout = (deadline: number) => Math.max(1, Math.min(PROBE_TIMEOUT_MS, leftMs(deadline)))

/**
 * 请求的地址键：方法、域名与路径。查询参数与片段不计入：轮询常以时间戳参数区分各次请求。
 * 没有地址或地址无法解析时返回 `null`，该请求不计为加载进展。
 */
function addressOf(request: unknown): string | null {
  const { url, method } = (request ?? {}) as { url?: unknown; method?: unknown }
  if (typeof url !== 'string' || !URL.canParse(url)) return null
  const parsed = new URL(url)
  return `${typeof method === 'string' ? method : 'GET'} ${parsed.origin}${parsed.pathname}`
}

/** 等待 `pending` 兑现，最长等待 `ms` 毫秒。兑现时清除定时器，不遗留未结束的计时。 */
function firstOf(pending: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms))
    void pending.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 一次动作或导航期间的框架事件。
 *
 * 在发送命令之前建立，结束时调用 `stop`：事件可能先于命令响应到达，判断「这段时间内是否发生
 * 导航」必须覆盖命令本身。`Page` 与 `Network` 域事件由页会话初始化时的 `Page.enable`、
 * `Network.enable` 发布，此处不另建事件源。
 */
interface NavWatch {
  /** 收到的导航事件条数。静默采样据其是否增长判断本次窗口内是否发生导航。 */
  events(): number
  /** 导航已开始但尚未收到结束事件。 */
  loading(): boolean
  /**
   * 订阅建立之后页会话发出、尚未结束的 XHR / fetch 请求数。
   *
   * 订阅之前发出的请求不在其中，其结束事件忽略。只统计这两类：图片、媒体与 EventSource 长连接
   * 会使每次动作都等到上限，文档导航已由帧事件覆盖。响应类型为 `text/event-stream` 的请求
   * 在响应头到达时移出，理由相同。
   */
  requests(): number
  /**
   * 订阅建立之后页会话发出的网络请求总数：各类型均计入（重定向按同一个请求计一次），另加 WebSocket 发送的帧。
   * 动作结果据此报告「是否发出了请求」，与只统计在途 XHR / fetch 的 `requests` 用途不同。
   */
  sent(): number
  /**
   * 加载进展的累计次数：本次订阅中首次出现的地址（`addressOf`）的请求发出、收到响应或数据、结束，以及订阅范围内
   * 框架的加载与导航事件。重复请求同一地址（定时刷新、轮询）与 `STREAMING_TYPES` 的请求不计入。
   */
  progress(): number
  /** 首次出现的地址中尚未结束的请求数，范围与 `progress` 相同。 */
  pending(): number
  /** 已收到导航提交的证据。 */
  committed(): boolean
  /** 导航提交时兑现；等待导航确认时使用它，不轮询。 */
  commit: Promise<void>
  stop(): void
}

/**
 * 一次执行的控制槽。每个 owner 至多一个，在宿主或 CDP 断开、释放或初始化失败时销毁。
 *
 * 它记录本次执行持有的 CDP 连接与已附加的页，不记录归属：归属由宿主
 * 按会话记录。`sessions` 与 `attaching` 合起来即本次执行占用的页，页级互斥只以它们为准。
 */
interface Control {
  owner: number
  /** 本次执行所属的会话（顶层会话）。归属判定与占页均以它为准。 */
  conversationId: string
  /** 创建控制槽时的宿主连接纪元。异步提交点据此核对宿主身份，使重连后的槽不被旧回调改写。 */
  epoch: number
  client: CdpClient | null
  /** 建立连接的在途 Promise。同一控制槽并发附加页时共用它，不为第二页另建连接。 */
  connecting: Promise<CdpClient> | null
  /** tabId → CDP 页会话 id。仅包含本次执行已附加的页，不表示归属。 */
  sessions: Map<string, string>
  /**
   * tabId → 占页的在途 Promise。同一控制槽对同一页的并发调用共用同一个 Promise。
   *
   * 登记即占用该页：从冲突检查到登记是同一个同步段，中间不得插入 await，否则两个
   * 执行者会同时通过检查，并各自向同一页发送输入。
   */
  attaching: Map<string, Promise<void>>
  /** tabId → 本次执行在该页当前文档上取得的定位信息。动作只接受其中的编号。 */
  records: Map<string, ObservationRecord>
  /** tabId → 本槽的动作期间截获、尚未提交文件的选择文件请求。文档更换或该页关闭时作废。 */
  choosers: Map<string, FileChooser>
  /** downloadId → tabId。本槽已登记、尚未被宿主裁决的下载授权，释放时按 id 撤销。 */
  arms: Map<string, string>
  /** 本槽在途的下载等待。释放时逐条终止，不等待各自的期限。 */
  waits: Set<(reason: string) => void>
  /** 本次释放的收尾过程。非 `null` 表示控制槽正在清理：其他执行者须等待清理结束，才能接手它占用的页。 */
  releasing: Promise<void> | null
  /** 本次执行的本机文件裁决，每次取用时读取端口最近一次设置的值（`Lease.files`）。 */
  localFiles: LocalFileCheck
}

/**
 * 一次执行持有的控制身份。端口闭包持有它，`released` 置位之后该端口不再取得控制。
 *
 * 已释放状态随端口保存，不记入协调器的集合：进程级的「已释放 owner」集合会随轮数持续增长。
 */
interface Lease {
  owner: number
  conversationId: string
  /** 本次执行所在的工作区。列页、建页与接管均限定在该工作区内，跨工作区的 tabId 一律拒绝。 */
  workspaceId: string
  released: boolean
  /**
   * 浏览器工具最近一次经 `localFiles` 设置的本机文件裁决，即最近一次调用的读取范围。`null` 表示从未设置，
   * 此时页面的 file 读取一律拒绝（内部渲染页即如此，它只加载 sidecar 的 http 地址）。
   */
  files: LocalFileCheck | null
}

/**
 * 只比较第一段主版本。不要改成逐段比较：后三段是 Chrome、Edge、WebView2 各自的构建号，
 * 彼此不可比较，同一主版本上较早的 Edge 构建会因 WebView2 的构建号而被拒绝。无法读取主版本时一律判为不达标。
 */
export function meetsRuntimeFloor(version: string, floor = MIN_CHROMIUM_MAJOR): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= floor
}

/** 动作期间截获的选择文件请求：页面中承载它的文件输入框，以及能否多选。 */
interface FileChooser {
  backendNodeId: number
  multiple: boolean
}

/**
 * 页面上有尚未处理的对话框。对话框打开期间页面脚本停止执行，读取与输入都不会返回，
 * 因此在发出任何命令之前拒绝，声明 `executed:false`。
 */
export class BrowserDialogOpenError extends Error implements BrowserRefusal {
  readonly errorKind = 'target_blocked' as const
  readonly executed = false as const

  constructor(dialog: JsDialog) {
    super(
      `页面上有尚未处理的${BROWSER_DIALOG_NAMES[dialog.type]}：「${dialog.message}」。处理之前页面无法读取或操作；` +
        `用 browser_act action=dialog 处理：accept=true 确定，accept=false 取消` +
        (dialog.type === 'prompt' ? '，输入的文字放在 text' : ''),
    )
  }
}

/** 页面上有未处理的对话框时拒绝本次操作。处理对话框的动作不经过此判定。 */
function assertNoDialog(page: PageHandle): void {
  const dialog = page.client.dialogOf(page.sessionId)
  if (dialog) throw new BrowserDialogOpenError(dialog)
}

export class BrowserCoordinator {
  #bridge: BrowserBridge
  #enabled: () => boolean
  /** sidecar 的地址（`http://127.0.0.1:端口`）：内部渲染页加载 Art 引导页与库文件。 */
  #sidecar: () => string
  /** owner → 控制槽。每次执行一个，彼此独立；访问同一页时才互斥。 */
  #controls = new Map<number, Control>()
  /**
   * tabId → 该页的元素编号表。按页保存、跨执行保留：同一份文档内同一个节点在每次执行中都是同一个编号。
   * 定位信息不在其中（含每次执行各自连接的会话编号），见 `Control.records`。
   */
  #numbering = new Map<string, RefNumbering>()
  #nextOwner = 0
  #nextDownload = 0
  /** 内部渲染页（`renderArt`）。不列入模型的页清单。 */
  #rendering = new Set<string>()
  #offHostChange: () => void
  #offClosed: () => void
  /** 见 `NETWORK_IDLE_MS`。只有回归测试传入其他值，以免按真实时间等待 5 秒。 */
  #networkIdleMs: number
  /** 见 `SETTLE_CEILING_MS`。只有回归测试传入其他值。 */
  #settleCeilingMs: number

  constructor(
    bridge: BrowserBridge,
    enabled: () => boolean,
    sidecar: () => string,
    settle: { networkIdleMs?: number; ceilingMs?: number } = {},
  ) {
    this.#bridge = bridge
    this.#enabled = enabled
    this.#sidecar = sidecar
    this.#networkIdleMs = settle.networkIdleMs ?? NETWORK_IDLE_MS
    this.#settleCeilingMs = settle.ceilingMs ?? SETTLE_CEILING_MS
    // 断开与重连均使全部控制失效：重连后的调试端点已更换，旧连接上的页会话已不存在。
    this.#offHostChange = bridge.onHostChange(() => this.#dropAll())
    // 宿主侧关闭的页（用户关闭、按会话关闭）须从持有它的控制槽中移除会话，
    // 否则取消时的清理命令会对不存在的 CDP 会话逐条报错。
    this.#offClosed = bridge.onEvent((frame) => {
      if (frame.kind === 'closed') this.#forget(frame.tabId)
    })
  }

  /**
   * AI 控制能力是否可用。
   *
   * 用户关闭了浏览器控制、宿主未连接，或宿主报告的运行时版本低于下限时，均不发布：
   * 不在握手中固定写入 true，也不提供点击后必然报错的入口。
   * 开关只限制 AI 控制：握手中的浏览器能力取自宿主状态，用户手动浏览不受影响。
   */
  available(): boolean {
    return this.#enabled() && this.#host() !== null
  }

  /**
   * 订阅宿主事件：导航、标题、关闭、归属变化、下载被拦截与下载完成。
   *
   * 下载的终态只来自此处：`download.arm` 的回执只表示授权登记成功，
   * 文件是否已写入磁盘须在 `download.finished` 之后核对。
   */
  onEvent(listener: (frame: BrowserEventFrame) => void): () => void {
    return this.#bridge.onEvent(listener)
  }

  /**
   * 关闭一条会话名下的全部 AI 页。仅在删除会话时调用，不遗留无归属的页；归档不关闭页。
   *
   * 先使该会话全部执行者的控制槽完成收尾，再发送一次 `close.conversation`：顺序颠倒时，
   * 清理命令会发往已不存在的页会话并逐条报错。归属记录在宿主上，因此只发送一条，
   * 由宿主按会话筛选并关闭页。
   */
  async closeConversation(conversationId: string): Promise<void> {
    const mine = [...this.#controls.values()].filter((c) => c.conversationId === conversationId)
    await Promise.all(mine.map((control) => this.#teardown(control)))
    await this.#bridge.request('close.conversation', { conversationId }).catch((err) => {
      log.info(
        'browser',
        `按会话关闭页的请求未送达：${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  /**
   * 为一次执行创建端口。
   *
   * 端口本身不占用控制槽，第一次操作时才占用。`conversationId` 是该 Run 的归属，
   * 传入的均为顶层会话（成员会话记为派发它的会话）；`workspaceId` 是该会话所在的
   * 工作区，装配方无法查到时不应创建端口，此处不接受空值。
   */
  portFor(conversationId: string, workspaceId: string): BrowserPort {
    this.#nextOwner += 1
    const lease: Lease = {
      owner: this.#nextOwner,
      conversationId,
      workspaceId,
      released: false,
      files: null,
    }
    return {
      localFiles: (check) => {
        lease.files = check
      },
      tabs: async () => this.#tabs(lease),
      open: (url) => this.#open(lease, url),
      bind: (tabId) => this.#bind(lease, tabId),
      close: (tabId) => this.#close(lease, tabId),
      navigate: (input) => this.#navigate(lease, input),
      observe: (input) => this.#observe(lease, input),
      act: (input) => this.#act(lease, input),
      wait: (input) => this.#wait(lease, input),
      upload: (input) => this.#upload(lease, input),
      download: (input) => this.#download(lease, input),
      release: () => this.#release(lease),
    }
  }

  /**
   * 按设计稿页面的显示尺寸渲染并截图（`render.ts`），供画布核对设计稿版面。
   *
   * 使用一页 hidden 页：宿主不把它列入界面的页签条，面板中显示的页不受影响；渲染结束即关闭，
   * 也不列入模型的页清单。该页归发起的会话所有，占用规则与该会话的其他页相同。
   * `pagePath` 为页面文件的绝对路径，页面中按相对路径引用的工作区图片据此内嵌。
   */
  async renderArt(
    conversationId: string,
    workspaceId: string,
    input: { html: string; pagePath: string; workspaceRoot: string; width: number; height: number },
  ): Promise<ArtRenderResult> {
    this.#nextOwner += 1
    const lease: Lease = {
      owner: this.#nextOwner,
      conversationId,
      workspaceId,
      released: false,
      files: null,
    }
    let tabId: string | undefined
    try {
      await this.#acquire(lease)
      const base = this.#sidecar()
      const html = await prepareArtForRender(
        input.html,
        input.pagePath,
        input.workspaceRoot,
        `${base}${ART_LIB_PATH}`,
      )
      const data = await this.#bridge.request('create', {
        url: 'about:blank',
        workspaceId,
        conversationId,
        hidden: true,
      })
      tabId = data?.tabId
      if (!tabId) throw new BrowserBridgeError('宿主未返回 tabId')
      this.#rendering.add(tabId)
      const { page } = await this.#pageOf(lease, tabId)
      return await renderArtPage(page, {
        hostUrl: `${base}${ART_HOST_PATH}`,
        html,
        width: input.width,
        height: input.height,
        settleMs: ART_POSTER_MS,
        deadline: Date.now() + RENDER_BUDGET_MS,
      })
    } finally {
      if (tabId) {
        await this.#close(lease, tabId).catch((err: unknown) => {
          log.warn('browser', `渲染页关闭失败：${err instanceof Error ? err.message : String(err)}`)
        })
        this.#rendering.delete(tabId)
      }
      await this.#release(lease)
    }
  }

  stop(): void {
    this.#offHostChange()
    this.#offClosed()
    this.#dropAll()
  }

  /** 版本达标的宿主。版本不达标与未连接在此统一视为「没有可用宿主」。 */
  #host(): NativeBrowserHost | null {
    const host = this.#bridge.host()
    return host && meetsRuntimeFloor(host.runtimeVersion) ? host : null
  }

  /**
   * 存活页清单：本工作区中本会话的页与用户手动打开的页。
   * 其他工作区与其他会话的页均不列出，也不提供它们的 tabId。
   *
   * `controlled` 表示该页归本会话（可直接操作）。用户页为 `controlled:false`，
   * 须由用户在聊天中点名、`bind` 之后才归本会话。
   */
  async #tabs(lease: Lease): Promise<BrowserTabInfo[]> {
    return this.#bridge
      .tabs()
      .filter(
        (tab) =>
          tab.workspaceId === lease.workspaceId &&
          (tab.conversationId === lease.conversationId || tab.conversationId === null) &&
          !this.#rendering.has(tab.tabId),
      )
      .map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        controlled: tab.conversationId === lease.conversationId,
      }))
  }

  /**
   * 释放本次执行。
   *
   * 释放之后该端口永久失效（`lease.released`），但归属保留在宿主上：会话的页仍归该会话，
   * 下一条消息使用新端口继续操作。重复调用加入同一次收尾，不在收尾完成之前返回。
   */
  async #release(lease: Lease): Promise<void> {
    lease.released = true
    const control = this.#controls.get(lease.owner)
    if (!control) return
    await this.#teardown(control)
  }

  /**
   * 收尾一个控制槽：关闭业务入口 → 终止本槽的下载等待 → 撤销未使用的授权 → 取消客户端 → 断开连接。
   *
   * 控制槽在整个清理期间仍保留在表中，因此其他执行者不会附加到正在清理的页；清理结束后
   * 按对象相等删除，使重连后创建的新槽不被本次收尾删除。全程共用一个截止时间。
   */
  #teardown(control: Control): Promise<void> {
    if (control.releasing) return control.releasing
    const deadline = Date.now() + RELEASE_BUDGET_MS
    const client = control.client
    // `cancel` 的同步部分即关闭业务发送入口，因此本句必须位于 await 之前：在异步段中才关闭时，
    // 排队中的动作仍会发送到网站。
    const cancelling = client ? client.cancel('执行结束', deadline) : null
    for (const abort of [...control.waits]) abort('浏览器控制已释放，本次下载未确认终态')
    control.waits.clear()
    // 收尾主体放入微任务：若同步执行，`releasing` 尚未赋值，`#alive` 会将清理中的槽判定为有效。
    const done = Promise.resolve()
      .then(async () => {
        await this.#revokeArms(control, deadline)
        if (cancelling) {
          await cancelling.catch((err: unknown) => {
            log.warn(
              'browser',
              `收尾时取消客户端失败：${err instanceof Error ? err.message : String(err)}`,
            )
          })
        }
        client?.close()
      })
      .finally(() => {
        if (this.#controls.get(control.owner) === control) this.#controls.delete(control.owner)
      })
    control.releasing = done
    return done
  }

  /** 宿主断开、重连或服务退出：全部控制槽执行收尾。其他会话的页面与归属均保留在宿主上。 */
  #dropAll(): void {
    for (const control of [...this.#controls.values()]) {
      void this.#teardown(control).catch(() => {})
    }
  }

  /**
   * 判断该控制槽当前是否有效。
   *
   * 三项须同时满足：它仍是本次执行当前的槽、未在清理、宿主连接纪元未变。
   * 每个异步提交点都必须经过此检查：建立连接、占页与观察的响应都可能在释放或重连之后到达。
   *
   * 页是否仍被占用不以此判定：清理中的槽仍会对其附加的页发送收尾命令，这些页须等收尾
   * 结束才交给其他执行者，判据是 `#holderOf`。
   */
  #alive(control: Control): boolean {
    return (
      this.#controls.get(control.owner) === control &&
      control.releasing === null &&
      this.#host()?.connectionEpoch === control.epoch
    )
  }

  /**
   * 取得本次执行的控制槽，不存在时创建。
   *
   * 本 owner 的槽正在清理时，等待清理结束后再创建新槽：宿主断开与初始化失败会在端口不知情的
   * 情况下销毁控制槽。该等待针对本槽自身的收尾，有上限（`RELEASE_BUDGET_MS`），不是全局队列。
   *
   * 开关在此处逐次判定：建页、接管与全部页面操作均经过此处，运行中关闭后下一次操作即被拒绝。
   */
  async #acquire(lease: Lease): Promise<Control> {
    if (!this.#enabled()) throw new BrowserUnavailableError('浏览器控制已关闭')
    for (;;) {
      if (lease.released) throw new BrowserReleasedError('本次执行的浏览器控制已经结束')
      const existing = this.#controls.get(lease.owner)
      if (!existing) break
      if (existing.releasing) {
        await existing.releasing
        continue
      }
      return existing
    }
    const host = this.#host()
    if (!host) throw new BrowserBridgeError('浏览器宿主不可用')
    const control: Control = {
      owner: lease.owner,
      conversationId: lease.conversationId,
      epoch: host.connectionEpoch,
      client: null,
      connecting: null,
      sessions: new Map(),
      attaching: new Map(),
      records: new Map(),
      choosers: new Map(),
      arms: new Map(),
      waits: new Set(),
      releasing: null,
      localFiles: (url) => (lease.files ? lease.files(url) : Promise.resolve(NO_FILE_SCOPE)),
    }
    this.#controls.set(lease.owner, control)
    return control
  }

  /**
   * 读取页面内容之前，核对页面中已加载的文档与资源（含各层同进程帧）都在读取范围之内。
   *
   * 受控期间的 file 请求已逐个裁决，此处处理的是拦截之外加载的内容，见 `BrowserLocalFileError`。
   * 加载失败的资源不计入：其中没有文件内容。跨站帧不在资源树中，它们不能加载 file 地址。
   */
  async #assertLocalFiles(control: Control, page: PageHandle): Promise<void> {
    // 使用命令的缺省上限，不要改用探针上限：刚跳转、仍在加载的页面上该命令常需数秒才返回。
    const { frameTree } = await page.client.send<{ frameTree?: ResourceTreeNode }>(
      'Page.getResourceTree',
      {},
      { sessionId: page.sessionId },
    )
    if (!frameTree) throw new BrowserBridgeError('页面的资源清单读取失败，本次不读取页面内容')
    const urls = new Set<string>()
    const walk = (node: ResourceTreeNode): void => {
      urls.add(node.frame.url)
      for (const resource of node.resources ?? []) {
        if (resource.failed !== true) urls.add(resource.url)
      }
      for (const child of node.childFrames ?? []) walk(child)
    }
    walk(frameTree)
    for (const url of urls) {
      if (!/^file:/i.test(url)) continue
      const reason = await control
        .localFiles(url)
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
      if (reason !== null) throw new BrowserLocalFileError(url, reason)
    }
  }

  /** 从持有该页的控制槽中移除它的会话与观察。宿主的关闭页事件与本地 close 均调用此方法。 */
  #forget(tabId: string): void {
    this.#numbering.delete(tabId)
    for (const control of this.#controls.values()) {
      const sessionId = control.sessions.get(tabId)
      if (sessionId === undefined) continue
      control.sessions.delete(tabId)
      control.client?.forgetSession(sessionId)
      this.#dropObservations(control, tabId)
    }
  }

  /** 丢弃本次执行在一页上的定位信息。范围仅限该页；编号表不清除，文档更换时由观察清空。 */
  #dropObservations(control: Control, tabId: string): void {
    control.records.delete(tabId)
    control.choosers.delete(tabId)
  }

  #numberingOf(tabId: string): RefNumbering {
    let numbering = this.#numbering.get(tabId)
    if (!numbering) {
      numbering = newNumbering()
      this.#numbering.set(tabId, numbering)
    }
    return numbering
  }

  /**
   * 新建一页。建页不占用该页：只由宿主将该页记到本会话名下，控制权在第一次 observe
   * 或 act 时按页级互斥取得。
   *
   * 因此 `opened` 事件先于 create 响应到达时，也不会出现两个入口分别附加该页；本次执行释放之后
   * 响应才到达时，该页仍如实返回：它已在宿主的存活表中，归属也已确定。
   */
  async #open(lease: Lease, url: string): Promise<BrowserTabInfo> {
    await this.#acquire(lease)
    const data = await this.#bridge.request('create', {
      url,
      workspaceId: lease.workspaceId,
      conversationId: lease.conversationId,
    })
    const tabId = data?.tabId
    if (!tabId) throw new BrowserBridgeError('宿主未返回 tabId')
    return { tabId, url: data?.url ?? url, title: data?.title ?? '', controlled: true }
  }

  /**
   * 将一页接管到本会话，并占用该页。
   *
   * 归属由宿主判定：用户页 → 归本会话；已归本会话 → 幂等；已归另一条会话 → 拒绝。
   * `bind` 仅在用户点名其自行打开的页时使用；本会话打开的页由后续操作直接占用，
   * 无需显式 bind。
   *
   * 返回的地址与标题取自宿主快照：接管成功时快照已带有新归属，不另行读取 bind 响应。
   */
  async #bind(lease: Lease, tabId: string): Promise<BrowserTabInfo> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'bind')
    const snap = this.#bridge.tab(tabId)
    return { tabId, url: snap?.url ?? '', title: snap?.title ?? '', controlled: true }
  }

  /**
   * 取得该页的 CDP 句柄。占用控制槽、核对归属、占页三步均在此完成。
   *
   * 归属跨消息保持不变：本会话上一条消息创建的页仍归本会话，此步按宿主快照核对归属后
   * 直接占页，因此下一条消息可直接 observe/act，无需交接。
   */
  async #pageOf(lease: Lease, tabId: string): Promise<{ control: Control; page: PageHandle }> {
    const control = await this.#acquire(lease)
    await this.#hold(lease, control, tabId, 'page')
    const client = control.client
    const sessionId = control.sessions.get(tabId)
    if (!client || !sessionId) throw new BrowserBridgeError(`标签页 ${tabId} 没有可用的会话`)
    return { control, page: { client, sessionId, tabId } }
  }

  /** 当前占用该页的另一个控制槽。清理中的槽同样视为占用：它仍会对该页发送收尾命令。 */
  #holderOf(self: Control, tabId: string): Control | null {
    for (const control of this.#controls.values()) {
      if (control === self) continue
      if (control.sessions.has(tabId) || control.attaching.has(tabId)) return control
    }
    return null
  }

  /**
   * 本次执行在该页上的定位信息。本次执行尚未观察该页时（编号来自上一条消息）先采集一次：
   * 只读取页面，不改变页面。编号由按页保存的编号表决定，采集之后同一个节点仍是原编号；
   * 文档已经更换时编号表随之清空，原编号按失效拒绝。
   */
  async #recordOf(control: Control, page: PageHandle): Promise<ObservationRecord> {
    const known = control.records.get(page.tabId)
    if (known) return known
    await this.#observeInto(control, page, {})
    const record = control.records.get(page.tabId)
    if (!record) throw new BrowserStaleRefError('未能取得本页的元素编号，请重新观察')
    return record
  }

  /**
   * 地址栏级导航，返回导航之后的观察。
   *
   * 导航是否发生按本次的 CDP 事件与 `Page.navigate` 的回执判定，不按「令牌未变即为
   * 同一文档」推断：令牌未变也可能是导航尚未提交。
   */
  async #navigate(
    lease: Lease,
    input: { tabId: string; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string },
  ): Promise<FollowUpObservation> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    assertNoDialog(page)
    // 更换文档即更换观察：旧编号指向的节点已不存在。只清除该页的观察：其他标签页不受本次导航影响。
    this.#dropObservations(control, input.tabId)
    const { client, sessionId } = page
    // 基线在此时读取。观察表中最后一份是另一时刻、可能属于另一页的值，用作基线会导致误判。
    const baseline = await readDocument(page)
    const tree = await client.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      { sessionId },
    )
    const watch = this.#watchNav(page, tree.frameTree.frame.id)
    try {
      if (input.action === 'goto') {
        const sent = await client.send<{ errorText?: string }>(
          'Page.navigate',
          { url: input.url ?? '' },
          { sessionId, timeoutMs: NAVIGATE_TIMEOUT_MS, renewOnEvents: true },
        )
        // errorText 表示本次导航失败，页面仍停留在原处。不得继续采集旧页快照并视为跳转成功。
        if (sent.errorText) throw new BrowserBridgeError(`导航失败：${sent.errorText}`)
      } else if (input.action === 'reload') {
        await client.send(
          'Page.reload',
          {},
          { sessionId, timeoutMs: NAVIGATE_TIMEOUT_MS, renewOnEvents: true },
        )
      } else {
        const history = await client.send<{
          currentIndex: number
          entries: { id: number }[]
        }>('Page.getNavigationHistory', {}, { sessionId })
        const step = input.action === 'back' ? -1 : 1
        const entry = history.entries[history.currentIndex + step]
        if (!entry)
          throw new BrowserBridgeError(`没有可${input.action === 'back' ? '后退' : '前进'}的历史`)
        await client.send(
          'Page.navigateToHistoryEntry',
          { entryId: entry.id },
          { sessionId, timeoutMs: NAVIGATE_TIMEOUT_MS, renewOnEvents: true },
        )
      }
      const committed = await this.#awaitCommit(page, watch, baseline)
      const { settle } = await this.#quietWait(page, watch, { whileLoading: true })
      // 未确认提交时不报告 quiet：此时的静默可能属于尚未被替换的旧文档。
      return await this.#followUp(control, page, committed ? settle : 'deadline')
    } finally {
      watch.stop()
    }
  }

  /**
   * 观察一页，或读取一个 `select` 的一页选项。
   *
   * `optionsFor` 按原观察实时读取：不采集新快照、不发放新编号、不移动页面，因此也不记入
   * 观察表：原观察仍在表中，再登记一个编号会使同一份定位信息存在两份记录。
   */
  async #observe(
    lease: Lease,
    input: {
      tabId: string
      frame?: string
      screenshot?: boolean
      offset?: number
      query?: string
      optionsFor?: { ref: string; offset?: number }
    },
  ): Promise<BrowserObservation | BrowserOptionsPage> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    assertNoDialog(page)
    if (input.optionsFor) {
      await this.#assertLocalFiles(control, page)
      return readSelectOptions(
        page,
        await this.#recordOf(control, page),
        input.optionsFor.ref,
        input.optionsFor.offset ?? 0,
      )
    }
    return this.#observeInto(control, page, {
      ...(input.frame !== undefined ? { frame: input.frame } : {}),
      ...(input.screenshot !== undefined ? { screenshot: input.screenshot } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    })
  }

  /**
   * 采集一次观察并登记编号。公开的 observe 与三处自动观察共用此方法。
   *
   * 登记前再次核对控制槽：采集期间控制可能已释放、因宿主断开而失效，或经重连更换为新槽，
   * 此时结果不记入表中，也不从旧记录中取一个编号代替。
   */
  async #observeInto(
    control: Control,
    page: PageHandle,
    opts: {
      frame?: string
      screenshot?: boolean
      offset?: number
      query?: string
    },
  ): Promise<BrowserObservation> {
    await this.#assertLocalFiles(control, page)
    const { observation, record } = await observePage(page, opts, this.#numberingOf(page.tabId))
    if (!this.#alive(control)) {
      throw new BrowserReleasedError('本次执行的浏览器控制已经结束，本次观察不登记')
    }
    // 同一文档内合并：翻页、查询与按帧观察各自取得一部分编号，此前取得的编号仍然可用。
    const known = control.records.get(page.tabId)
    if (known && known.docToken === record.docToken) {
      for (const [ref, entry] of record.refs) known.refs.set(ref, entry)
    } else {
      control.records.set(page.tabId, record)
    }
    return observation
  }

  /**
   * 动作之后的后续观察。
   *
   * 未取得观察时返回 `observationError` 而不是抛出异常：动作已经发出，抛出异常会使
   * 调用方无法区分「未执行操作」与「操作后未取得观察」，从而重复提交。取消之后不再发起新的观察。
   * 观察使用观察自己的期限：不要改为与之前的等待共用一份预算，等待耗时较长时观察只剩数秒，跳转后的页面因此读取失败。
   */
  async #followUp(
    control: Control,
    page: PageHandle,
    settle?: 'quiet' | 'deadline',
    screenshot?: boolean,
  ): Promise<FollowUpObservation> {
    if (!page.client.connected) {
      return {
        observation: null,
        observationError: new CdpDisconnectedError('动作之后未取得观察').message,
      }
    }
    if (page.client.cancelled) {
      return { observation: null, observationError: '已取消，动作之后未再观察' }
    }
    try {
      const observation = await this.#observeInto(control, page, screenshot ? { screenshot } : {})
      return settle === undefined ? { observation } : { observation, settle }
    } catch (err) {
      return {
        observation: null,
        observationError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  #watchNav(page: PageHandle, frameId?: string): NavWatch {
    let events = 0
    let inflight = 0
    let committed = false
    // 重定向沿用同一个 requestId，按集合去重。
    const requests = new Set<string>()
    const issued = new Set<string>()
    let frames = 0
    let progress = 0
    // 本次订阅中出现过的地址，以及其中首次出现、尚未结束的请求。
    const addresses = new Set<string>()
    const fresh = new Set<string>()
    let settle: () => void = () => {}
    const commit = new Promise<void>((resolve) => {
      settle = resolve
    })
    const mine = (id: unknown) => frameId === undefined || id === frameId
    const off = page.client.onSessionEvent(page.sessionId, (event) => {
      const params = event.params
      const frame = params.frame as { id?: string } | undefined
      const requestId = String(params.requestId)
      if (event.method === 'Network.requestWillBeSent') {
        issued.add(requestId)
        if (params.type === 'XHR' || params.type === 'Fetch') requests.add(requestId)
        // 重定向沿用同一个 requestId 而地址更换，新地址同样计为进展。
        const address = addressOf(params.request)
        if (
          address !== null &&
          !STREAMING_TYPES.has(String(params.type)) &&
          !addresses.has(address)
        ) {
          addresses.add(address)
          fresh.add(requestId)
          progress += 1
        }
        return
      }
      if (event.method === 'Network.webSocketFrameSent') {
        frames += 1
        return
      }
      if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
        requests.delete(requestId)
        if (fresh.delete(requestId)) progress += 1
        return
      }
      if (event.method === 'Network.dataReceived') {
        if (fresh.has(requestId)) progress += 1
        return
      }
      if (event.method === 'Network.responseReceived') {
        if (fresh.has(requestId)) progress += 1
        // 以 fetch 读取的事件流不产生结束事件，响应头到达即不再等待。
        const mime = (params.response as { mimeType?: string } | undefined)?.mimeType
        if (mime === 'text/event-stream') {
          requests.delete(requestId)
          fresh.delete(requestId)
        }
        return
      }
      if (event.method === 'Page.frameStartedLoading' && mine(params.frameId)) {
        events += 1
        inflight += 1
        progress += 1
        return
      }
      if (event.method === 'Page.frameStoppedLoading' && mine(params.frameId)) {
        events += 1
        inflight = Math.max(0, inflight - 1)
      } else if (event.method === 'Page.frameNavigated' && mine(frame?.id)) {
        events += 1
      } else if (event.method === 'Page.navigatedWithinDocument' && mine(params.frameId)) {
        events += 1
      } else {
        return
      }
      progress += 1
      committed = true
      settle()
    })
    return {
      events: () => events,
      loading: () => inflight > 0,
      requests: () => requests.size,
      sent: () => issued.size + frames,
      progress: () => progress,
      pending: () => fresh.size,
      committed: () => committed,
      commit,
      stop: off,
    }
  }

  /**
   * 等待导航提交。
   *
   * 收到事件即视为提交。上限内未收到任何事件时，读取一次文档并与基线比较：文档或地址已更换同样视为
   * 提交。两者均未变化时返回 false：此时不得声称静默，本次导航可能仍未提交。
   */
  async #awaitCommit(
    page: PageHandle,
    watch: NavWatch,
    baseline: { token: string; url: string },
  ): Promise<boolean> {
    if (watch.committed()) return true
    if (await firstOf(watch.commit, COMMIT_WAIT_MS)) return true
    const head = await readDocument(page, PROBE_TIMEOUT_MS).catch(() => null)
    return head !== null && (head.token !== baseline.token || head.url !== baseline.url)
  }

  /**
   * 动作或导航之后等待页面静默，按加载进展计时。
   *
   * 连续两次采样 `readyState` 均为 complete、DOM 变更计数不变，且订阅建立之后发出的
   * XHR / fetch 请求均已结束，才视为静默；期间收到导航事件即重新计数，正在加载的旧文档
   * 不得提前通过。静默只表示此刻可以采集快照：尚未发出的延迟请求无法预知，
   * 静默不表示网站业务已经完成。
   *
   * 等待自最近一次加载进展（`NavWatch.progress` 增长或 `readyState` 变化）起计时：有未结束的新地址请求时
   * 至多 `#networkIdleMs`，没有时至多 `QUIET_IDLE_MS`，到时以 `deadline` 结束。不要改回自动作完成起算的固定上限：
   * 持续加载的页面会在加载到一半时被采集。不要把 DOM 变化或重复地址的请求计为进展：动画与定时刷新会使每次等待
   * 都到达上限。不断请求新地址的页面以 `#settleCeilingMs` 为上限。跨站 iframe 的请求在子会话上，不计入。
   *
   * 探针读数缺少字段时按未静默处理：将缺失视为 complete 会使仍在加载的页面通过。
   *
   * `probe` 是调用方在动作之前登记的探针，此处负责清理；缺省时在此登记。`mutations` 是该探针的
   * 最后一次读数，即动作开始以来的 DOM 变更数；探针随旧文档失效或从未读取到读数时为 `null`。
   * `whileLoading` 只用于地址栏导航（订阅只看主框架）：主文档仍在加载时与未结束的新地址请求一样按
   * `#networkIdleMs` 计时。动作的订阅包含全部框架，持续加载的广告框架会使每次动作都按较长的时长等待，因此不使用。
   */
  async #quietWait(
    page: PageHandle,
    watch: NavWatch,
    opts: { probe?: number | null; whileLoading?: boolean } = {},
  ): Promise<{ settle: 'quiet' | 'deadline'; mutations: number | null }> {
    const { client, sessionId } = page
    let probe = opts.probe ?? null
    let mutations: number | null = null
    // 只有动作之前登记的探针从动作开始计数；此处新登记的探针缺少动作初期的变化，读数不作为变更数。
    let fresh = probe !== null
    if (client.cancelled) {
      if (probe !== null) await client.disposeWaiter(sessionId, probe).catch(() => {})
      return { settle: 'deadline', mutations }
    }
    const ceiling = Date.now() + this.#settleCeilingMs
    let progressAt = Date.now()
    let progress = watch.progress()
    let ready: string | null = null
    const until = () => {
      const loading = opts.whileLoading === true && (watch.loading() || ready !== 'complete')
      const idle = watch.pending() > 0 || loading ? this.#networkIdleMs : QUIET_IDLE_MS
      return Math.min(ceiling, progressAt + idle)
    }
    // 页面忙于加载或跳转时，采样命令在探针上限内不返回：这次采样按未静默处理，继续等待。不要改为结束整个等待：
    // 点击后跳转期间读取旧文档会超时，结束等待将在新页面加载完之前采集观察。断开与取消照常结束等待。
    const sample = <T>(pending: Promise<T>): Promise<T | null> =>
      pending.catch((err: unknown) => {
        if (err instanceof CdpTimeoutError) return null
        throw err
      })
    try {
      let previous: { ready: string; mutations: number } | null = null
      let seen = watch.events()
      while (leftMs(until()) > 0) {
        await sleep(Math.min(QUIET_SAMPLE_MS, leftMs(until())))
        probe ??= await sample(client.startProbe(sessionId, probeTimeout(ceiling)))
        const read =
          probe === null
            ? null
            : await sample(client.readProbe(sessionId, probe, probeTimeout(ceiling)))
        if (fresh && typeof read?.mutations === 'number') mutations = read.mutations
        const advanced = typeof read?.ready === 'string' && ready !== null && read.ready !== ready
        if (watch.progress() !== progress || advanced) {
          progress = watch.progress()
          progressAt = Date.now()
        }
        if (typeof read?.ready === 'string') ready = read.ready
        const moved = watch.events() !== seen
        seen = watch.events()
        if (read === null || moved || watch.loading() || watch.requests() > 0) {
          previous = null
          continue
        }
        if (read.gone === true) {
          // 探针随旧文档一同销毁，下一次采样时重建。只读等待器可以重建，动作一律不重发。重建的探针不从动作开始计数。
          previous = null
          fresh = false
          mutations = null
          probe = null
          continue
        }
        if (typeof read.ready !== 'string' || typeof read.mutations !== 'number') {
          log.warn('browser', '静默探针读数不完整，本次按未静默处理')
          previous = null
          continue
        }
        if (
          previous?.ready === 'complete' &&
          read.ready === 'complete' &&
          previous.mutations === read.mutations
        ) {
          return { settle: 'quiet', mutations }
        }
        previous = { ready: read.ready, mutations: read.mutations }
      }
    } catch (err) {
      log.warn('browser', `已跳过静默等待：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (probe !== null) await client.disposeWaiter(sessionId, probe).catch(() => {})
    }
    // 记录到达上限的次数：只有不断请求新地址的页面到达该上限，据此核对它的代价。
    if (leftMs(ceiling) <= 0) {
      log.info('browser', `动作之后的等待达到 ${this.#settleCeilingMs} ms 上限，页面仍在请求新地址`)
    }
    return { settle: 'deadline', mutations }
  }

  /**
   * 执行一次动作，返回回执、动作之后的观察与动作期间页面上发生的事（`BrowserActivity`）。
   *
   * 订阅与探针都在动作之前建立：点击触发的导航、请求、DOM 变化与新开页可能在动作响应之前发生。
   * 动作在发出前被拒绝时，探针随之清理，不留在页面中。
   *
   * 动作使页面弹出对话框时立即返回：对话框打开期间页面脚本停止执行，输入事件在对话框关闭之后才返回，
   * 页内读取同样不返回。此时不等待动作的回包，也不读取页面，结果带对话框的类型与文字，由调用方以 `dialog` 动作处理。
   *
   * 选择文件窗口只在动作期间拦截：用户在同一页上手动上传时系统窗口照常打开。
   */
  async #act(lease: Lease, input: BrowserActInput): Promise<BrowserActResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    if (input.action === 'dialog') return this.#answerDialog(control, page, input)
    assertNoDialog(page)
    const record = await this.#recordOf(control, page)
    const { client, sessionId } = page
    const watch = this.#watchNav(page)
    const opened: BrowserTabInfo[] = []
    const blocked: { reason: string; suggestedName?: string }[] = []
    const offEvents = this.#bridge.onEvent((frame) => {
      if (frame.kind === 'opened' && frame.conversationId === control.conversationId) {
        opened.push({
          tabId: frame.tabId,
          url: frame.url ?? '',
          title: frame.title ?? '',
          controlled: true,
        })
      }
      // 带 downloadId 的是 `browser_download` 登记的下载，由该工具自行结算。
      if (
        frame.kind === 'download.blocked' &&
        frame.tabId === page.tabId &&
        frame.downloadId === undefined
      ) {
        blocked.push({
          reason: frame.reason ?? '',
          ...(frame.suggestedName ? { suggestedName: frame.suggestedName } : {}),
        })
      }
    })
    const chosen: FileChooser[] = []
    let showDialog: (dialog: JsDialog) => void = () => {}
    const dialogShown = new Promise<JsDialog>((resolve) => {
      showDialog = resolve
    })
    const offPage = client.onSessionEvent(sessionId, (event) => {
      if (event.method === 'Page.fileChooserOpened') {
        const node = Number(event.params.backendNodeId)
        if (Number.isFinite(node)) {
          chosen.push({ backendNodeId: node, multiple: event.params.mode === 'selectMultiple' })
        }
      }
      if (event.method === 'Page.javascriptDialogOpening') {
        const dialog = client.dialogOf(sessionId)
        if (dialog) showDialog(dialog)
      }
    })
    const intercepting = await client
      .send(
        'Page.setInterceptFileChooserDialog',
        { enabled: true },
        { sessionId, timeoutMs: PROBE_TIMEOUT_MS },
      )
      .then(
        () => true,
        () => false,
      )
    const probe = await client.startProbe(sessionId, PROBE_TIMEOUT_MS).catch(() => null)
    const facts = (): Omit<BrowserActivity, 'domChanged'> => {
      const chooser = chosen.at(-1)
      return {
        requests: watch.sent(),
        ...(opened.length ? { opened } : {}),
        ...(blocked.length ? { downloadsBlocked: blocked } : {}),
        ...(chooser ? { fileChooser: { multiple: chooser.multiple } } : {}),
      }
    }
    try {
      const acting = actOnPage(page, record, input)
      let first: { receipt: Awaited<typeof acting> } | { dialog: JsDialog }
      try {
        first = await Promise.race([
          acting.then((receipt) => ({ receipt })),
          dialogShown.then((dialog) => ({ dialog })),
        ])
      } catch (err) {
        if (probe !== null) await client.disposeWaiter(sessionId, probe).catch(() => {})
        throw err
      }
      if ('dialog' in first) {
        // 输入事件在对话框关闭之后才返回，其结果不再使用；探针在页面恢复之后随本槽的收尾清理。
        acting.catch(() => {})
        return {
          observation: null,
          observationError: '页面弹出对话框，处理之前无法读取页面',
          activity: { ...facts(), domChanged: true, dialog: first.dialog },
        }
      }
      const quiet = await this.#quietWait(page, watch, { probe })
      const follow = await this.#followUp(control, page, quiet.settle, input.screenshot)
      const after = follow.observation ? control.records.get(page.tabId) : undefined
      const chooser = chosen.at(-1)
      if (chooser) control.choosers.set(page.tabId, chooser)
      return {
        ...first.receipt,
        ...follow,
        activity: {
          ...(after ? { navigated: after.docToken !== record.docToken } : {}),
          ...facts(),
          domChanged: quiet.mutations === null || quiet.mutations > 0,
        },
      }
    } finally {
      offPage()
      offEvents()
      watch.stop()
      // 不等待回包：对话框打开期间该命令可能要到页面恢复之后才应答。
      if (intercepting) {
        void client
          .send('Page.setInterceptFileChooserDialog', { enabled: false }, { sessionId })
          .catch(() => {})
      }
    }
  }

  /**
   * 处理页面上的对话框：确定或取消，prompt 附带 `text`。之后与其他动作相同，等待静默并取得观察。
   * 页面上没有对话框时按参数错误拒绝，不发送任何命令。
   */
  async #answerDialog(
    control: Control,
    page: PageHandle,
    input: BrowserActInput,
  ): Promise<BrowserActResult> {
    const dialog = page.client.dialogOf(page.sessionId)
    if (!dialog) throw new BrowserArgumentError('页面上没有待处理的对话框')
    const before = control.records.get(page.tabId)?.docToken
    const watch = this.#watchNav(page)
    try {
      await page.client.handleDialog(
        page.sessionId,
        input.accept === true,
        dialog.type === 'prompt' ? input.text : undefined,
      )
      const quiet = await this.#quietWait(page, watch)
      const follow = await this.#followUp(control, page, quiet.settle, input.screenshot)
      const after = follow.observation ? control.records.get(page.tabId) : undefined
      return {
        element: BROWSER_DIALOG_NAMES[dialog.type],
        execution: { state: 'completed', confirmedUnits: 1 },
        ...follow,
        activity: {
          ...(after && before !== undefined ? { navigated: after.docToken !== before } : {}),
          requests: watch.sent(),
          // 探针在对话框关闭之后才登记，读数不包含关闭之初的变化，按有变化报告。
          domChanged: true,
        },
      }
    } finally {
      watch.stop()
    }
  }

  async #wait(
    lease: Lease,
    input: {
      tabId: string
      selector: string
      state: BrowserWaitState
      expected?: string
      timeoutMs: number
    },
  ): Promise<BrowserWaitResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    assertNoDialog(page)
    await this.#assertLocalFiles(control, page)
    const receipt = await waitOnPage(
      page,
      {
        selector: input.selector,
        state: input.state,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
      },
      input.timeoutMs,
    )
    // 等待结束后直接采集观察：选择器已是调用方给出的就绪判据，不再附加静默等待。
    return { ...receipt, ...(await this.#followUp(control, page)) }
  }

  /**
   * 将文件交给文件输入框。不带 ref 时交给本页动作期间截获的选择文件请求：页面常把真正的输入框隐藏，
   * 只显示一个样式按钮，隐藏的输入框不在元素表中，没有编号。
   */
  async #upload(
    lease: Lease,
    input: { tabId: string; ref?: string; paths: string[] },
  ): Promise<{ files: string[] }> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    assertNoDialog(page)
    if (input.ref !== undefined) {
      return uploadToPage(page, await this.#recordOf(control, page), input.ref, input.paths)
    }
    const chooser = control.choosers.get(page.tabId)
    if (!chooser) {
      throw new BrowserArgumentError(
        '缺少 ref：本页没有待处理的选择文件请求，请提供文件输入框的编号',
      )
    }
    if (!chooser.multiple && input.paths.length > 1) {
      throw new BrowserArgumentError('该选择文件请求只接受一个文件')
    }
    await page.client.send(
      'DOM.setFileInputFiles',
      { files: input.paths, backendNodeId: chooser.backendNodeId },
      { sessionId: page.sessionId },
    )
    control.choosers.delete(page.tabId)
    return { files: input.paths }
  }

  /**
   * 执行一次下载：先登记本次下载身份的授权，再用 Input 事件点击元素触发下载，然后等待该身份的终态。
   *
   * 顺序不得颠倒。授权是按 `downloadId` 与绝对路径登记的一次性凭据，先触发再授权时钩子
   * 无法取得授权，本次下载即被取消。终态按 `downloadId` 认领：按 tabId 认领时，同一页上
   * 前一次调用迟到的 finished 会被计入本次下载。取得终态之后还须核对磁盘：事件只表示宿主已完成写入，
   * 文件是否存在及其大小须另行核对。
   */
  async #download(
    lease: Lease,
    input: {
      tabId: string
      ref: string
      absolutePath: string
      timeoutMs: number
    },
  ): Promise<BrowserDownloadResult> {
    const { control, page } = await this.#pageOf(lease, input.tabId)
    assertNoDialog(page)
    const record = await this.#recordOf(control, page)
    this.#nextDownload += 1
    const downloadId = `dl_${this.#nextDownload}`

    type Outcome = { frame: BrowserEventFrame } | { cancelled: string } | { expired: true }
    let settle: ((out: Outcome) => void) | null = null
    const outcome = new Promise<Outcome>((resolve) => {
      settle = resolve
    })
    const off = this.#bridge.onEvent((frame) => {
      if (frame.downloadId !== downloadId) return
      if (frame.kind === 'download.finished' || frame.kind === 'download.blocked') {
        settle?.({ frame })
      }
    })
    const release: { reason: string | null } = { reason: null }
    const abort = (reason: string) => {
      release.reason = reason
      settle?.({ cancelled: reason })
    }
    control.waits.add(abort)
    const timer = setTimeout(() => settle?.({ expired: true }), input.timeoutMs)

    try {
      await this.#arm(control, input.tabId, input.absolutePath, input.timeoutMs, downloadId)
      try {
        await clickForDownload(page, record, input.ref)
      } catch (err) {
        // 释放先关闭发送入口、再同步终结等待，点击中途被拒绝的发送是释放的结果：按释放报告。
        // 点击是否已到达页面、下载的终态都无法确认，与等待终态期间释放的结论相同。
        if (release.reason !== null) throw new BrowserReleasedError(release.reason)
        throw err
      }
      const out = await outcome
      if ('cancelled' in out) throw new BrowserReleasedError(out.cancelled)
      if ('expired' in out) throw new BrowserBridgeError('下载未在期限内返回结果，授权已撤销')
      const frame = out.frame
      // 终态到达表示授权已被宿主裁决，收尾时无需再次撤销。
      control.arms.delete(downloadId)
      if (frame.kind === 'download.blocked') {
        return {
          ...(frame.reason ? { blocked: frame.reason } : { blocked: 'blocked' }),
          ...(frame.suggestedName ? { suggestedName: frame.suggestedName } : {}),
        }
      }
      // 成功须有宿主给出的实际保存路径。缺少路径的终态不得以请求路径补充为成功。
      if (frame.success === false || !frame.path) return { blocked: 'failed' }
      const info = await stat(frame.path).catch(() => null)
      if (!info) throw new BrowserBridgeError(`宿主报告下载完成，但 ${frame.path} 不在磁盘上`)
      return { path: frame.path, bytes: info.size }
    } finally {
      off()
      clearTimeout(timer)
      control.waits.delete(abort)
      if (control.arms.has(downloadId)) {
        await this.#revokeArm(control, downloadId, Date.now() + RELEASE_BUDGET_MS).catch(() => {})
      }
    }
  }

  /**
   * 取得本槽的 CDP 连接，不存在时建立。
   *
   * 建立连接的在途 Promise 保存在控制槽上：同一控制槽的两页并发附加时共用一次握手，不各自建立连接。
   * 连接建立时若本槽已失效，立即关闭该连接且不登记：保留它会形成一条无人收尾的连接。
   */
  async #clientOf(control: Control): Promise<CdpClient> {
    if (control.client) return control.client
    if (!control.connecting) {
      const host = this.#host()
      if (!host) throw new BrowserBridgeError('浏览器宿主未连接')
      control.connecting = CdpClient.connect(host.debugPort, control.localFiles)
        .then((client) => {
          if (!this.#alive(control)) {
            client.close()
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该连接不登记')
          }
          control.client = client
          client.onDisconnect(() => {
            if (control.client === client) void this.#teardown(control).catch(() => {})
          })
          if (!client.connected) throw new CdpDisconnectedError('CDP 连接已断开')
          return client
        })
        .finally(() => {
          control.connecting = null
        })
    }
    return control.connecting
  }

  /**
   * 占用一页并建立其 CDP 会话。`bind` 与全部页面操作共用此入口。
   *
   * 准入、冲突检查与登记在同一个同步段中完成，主体推迟到登记之后的微任务：若先发送 bind、
   * 先建立连接或先 await，两个执行者会同时通过检查，并各自向同一页发送输入。
   * 持有者有效时一律返回 busy；持有者正在清理时等待其收尾结束（有上限）后重新检查，不返回 busy。
   *
   * 页会话初始化被拒绝（焦点仿真不可用）时撤销整个控制槽：在焦点判定不成立的
   * 会话上继续操作，输入会发送到不可见的位置。
   */
  async #hold(lease: Lease, control: Control, tabId: string, mode: 'bind' | 'page'): Promise<void> {
    let marker = ''
    for (;;) {
      if (control.sessions.has(tabId)) return
      const inflight = control.attaching.get(tabId)
      if (inflight) return inflight
      if (!this.#alive(control)) {
        throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该页不附加')
      }
      const snap = this.#bridge.tab(tabId)
      if (!snap) throw new BrowserNotOwnedError(`无法识别的标签页 ${tabId}`)
      if (snap.workspaceId !== lease.workspaceId) {
        throw new BrowserNotOwnedError(`标签页 ${tabId} 不在本工作区`)
      }
      // bind 用于用户点名其自行打开的页，因此额外接受无归属的页；页面操作只接受本会话的页。
      const mine = snap.conversationId === lease.conversationId
      if (!mine && !(mode === 'bind' && snap.conversationId === null)) {
        throw new BrowserNotOwnedError(
          mode === 'bind'
            ? `标签页 ${tabId} 属于另一条会话，无法接管`
            : `标签页 ${tabId} 不归本会话`,
        )
      }
      const holder = this.#holderOf(control, tabId)
      if (!holder) {
        marker = snap.marker
        break
      }
      if (!holder.releasing) throw new BrowserBusyError(`标签页 ${tabId} 正被另一个任务操作`)
      await holder.releasing
    }
    const task = Promise.resolve()
      .then(async () => {
        if (mode === 'bind') {
          const data = await this.#bridge.request('bind', {
            tabId,
            workspaceId: lease.workspaceId,
            conversationId: lease.conversationId,
          })
          if (!data?.marker) throw new BrowserBridgeError('宿主未返回标记')
          marker = data.marker
        }
        try {
          const client = await this.#clientOf(control)
          const { sessionId } = await client.attachByMarker(marker)
          const detach = () =>
            client
              .send(
                'Target.detachFromTarget',
                { sessionId },
                { teardown: 'detach', timeoutMs: 3_000 },
              )
              .catch(() => {})
          // 宿主已关闭的页不再登记：迟到的附加会使不存在的页重新可操作。
          if (!this.#bridge.tab(tabId)) {
            await detach()
            throw new BrowserBridgeError(`标签页 ${tabId} 已经关闭`)
          }
          if (!this.#alive(control)) {
            await detach()
            throw new BrowserReleasedError('本次执行的浏览器控制已经结束，该页不登记')
          }
          control.sessions.set(tabId, sessionId)
        } catch (err) {
          if (err instanceof CdpInitError) await this.#teardown(control)
          if (err instanceof CdpDisconnectedError) {
            await this.#teardown(control)
            throw new BrowserConnectionError(err)
          }
          throw err
        }
      })
      .finally(() => {
        // 控制槽已开始收尾时，占用保持到收尾结束：清理命令仍会发往该页，此时释放占用会使
        // 接手者的等待器与旧连接的清理交错执行。
        if (control.releasing && !control.sessions.has(tabId)) {
          void control.releasing.finally(() => control.attaching.delete(tabId))
          return
        }
        control.attaching.delete(tabId)
      })
    control.attaching.set(tabId, task)
    return task
  }

  async #close(lease: Lease, tabId: string): Promise<void> {
    // 归属与页级占用均经由 pageOf 判定：其他执行者持有该页时 close 同样返回 busy，不绕过互斥。
    await this.#pageOf(lease, tabId)
    await this.#bridge.request('close', { tabId })
    this.#forget(tabId)
  }

  /**
   * 登记一次授权：先将身份记入本槽，再发送请求。
   *
   * 必须先登记：arm 响应迟到或超时时，宿主可能已经登记该授权，没有本地身份则无法撤销。
   */
  async #arm(
    control: Control,
    tabId: string,
    absolutePath: string,
    deadlineMs: number,
    downloadId: string,
  ): Promise<void> {
    control.arms.set(downloadId, tabId)
    await this.#bridge.request(
      'download.arm',
      { tabId, path: absolutePath, conversationId: control.conversationId, downloadId },
      deadlineMs,
    )
  }

  /** 撤销本槽的一份授权。经由 bridge 直接发送，不经 `pageOf`：释放之后 `pageOf` 不再提供控制。 */
  async #revokeArm(control: Control, downloadId: string, deadline: number): Promise<boolean> {
    const tabId = control.arms.get(downloadId)
    if (tabId === undefined) return false
    control.arms.delete(downloadId)
    const data = await this.#bridge.request(
      'download.disarm',
      { tabId, downloadId },
      Math.max(1, leftMs(deadline)),
    )
    return data?.removed === true
  }

  /**
   * 撤销本槽尚未被裁决的全部授权。
   *
   * 宿主更换过连接时只清除本地记录：上一纪元的授权已随断开在宿主侧清空，再发送撤销会成为
   * 另一条连接上的无主请求。失败时只记录一行日志，断开路径本身也会清除授权。
   */
  async #revokeArms(control: Control, deadline: number): Promise<void> {
    if (this.#bridge.host()?.connectionEpoch !== control.epoch) {
      control.arms.clear()
      return
    }
    for (const downloadId of [...control.arms.keys()]) {
      await this.#revokeArm(control, downloadId, deadline).catch((err: unknown) => {
        log.info(
          'browser',
          `撤销下载授权未送达：${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }
  }
}
