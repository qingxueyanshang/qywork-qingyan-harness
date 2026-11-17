import { definePort } from '@qywork/agent'

export interface BrowserTabInfo {
  tabId: string
  url: string
  title: string
  /**
   * 该页是否归属本会话（即能否直接操作）。
   *
   * 归属本会话的页为 `true`：AI 在本会话中打开的页跨消息保持归属，可直接 observe/act。
   * 用户手动打开的页为 `false`，须在用户于聊天中指明后经 `bind` 归属本会话。其他会话的页
   * 不在此清单中。
   */
  controlled: boolean
}

/**
 * `select` 的一个选项。
 *
 * `disabled` 与 `selected` 仅在为真时出现，省略即为假。`disabled` 已合并 optgroup
 * 的禁用状态：optgroup 禁用时其下的选项均不可选。
 */
export interface BrowserSelectOption {
  /** 显示文本。存在 `label` 属性时取该属性，否则取选项正文。 */
  label: string
  value: string
  disabled?: boolean
  selected?: boolean
}

/**
 * 一页选项。观察的 `optionsFor` 模式返回该结构，不采集新观察。
 *
 * `items` 按当前 DOM 实时读取，选项增删之后须重新读取：两次读取的结果合并后不是同一时刻的快照。
 */
export interface BrowserOptionsPage {
  tabId: string
  ref: string
  items: BrowserSelectOption[]
  /** 该 select 当前的选项总数。 */
  total: number
  offset: number
  /** 存在后续选项时的下一个 `offset`；省略表示已读取到末尾。 */
  nextOffset?: number
}

/**
 * 一次观察中的一个元素。
 *
 * `ref` 在**同一 tab 的同一份文档**内固定：同一个节点在各次观察中是同一个编号，重新观察不更换编号。
 * 文档更换之后旧编号全部作废，且不会再发放给新文档中的元素。实现方在执行动作前复核节点仍处于连接状态且身份匹配。
 */
export interface BrowserElement {
  ref: string
  /** 可访问性角色，来自 AX 树。 */
  role: string
  /** 可访问名称。 */
  name: string
  tag: string
  /** 表单控件的 type 属性。 */
  inputType?: string
  value?: string
  checked?: boolean
  /** AX 的展开状态。省略表示该角色没有此属性，不表示已收起。 */
  expanded?: boolean
  /** AX 的选中状态，用于 tab、option 等角色；与 `checked` 是不同的属性。 */
  selected?: boolean
  disabled?: boolean
  /** `select` 的选项摘要，按当前 DOM 实时读取。省略表示未读取到，不表示没有选项。 */
  options?: BrowserSelectOption[]
  /** `select` 当前的选项总数。`options` 少于该数时用 `optionsFor` 继续读取。 */
  optionsTotal?: number
  /** 选项摘要未完整列出。 */
  optionsTruncated?: boolean
  /** 正文摘要，按上限截断，不是整段 HTML。 */
  text?: string
  /** `canvas` 当前的 CSS 像素尺寸，即指针动作 `point` 的取值范围。 */
  size?: { width: number; height: number }
  /** iframe 的帧编号；省略表示主文档。 */
  frame?: string
}

export interface BrowserObservation {
  tabId: string
  /** 页面当前的实际地址，不是请求时的地址。 */
  url: string
  title: string
  elements: BrowserElement[]
  /** 元素数超过上限而被截断。调用方须得知本页不是全部元素。 */
  truncated: boolean
  /**
   * 当前尚未采集到内容的跨站 iframe 的帧编号。
   *
   * 省略表示不存在此类帧。列出的帧在页面上存在，但本元素表中没有其元素；
   * 重新观察即可取得，不要据此推断该帧为空。
   */
  framesPending?: string[]
  /** 按需截图，仅在 `screenshot` 为真时产生。 */
  image?: { data: string; mime: string }
}

export type BrowserActionKind =
  | 'click'
  | 'dblclick'
  | 'rightclick'
  | 'hover'
  | 'fill'
  | 'type'
  | 'select'
  | 'scroll'
  | 'press'
  | 'drag'
  | 'dialog'

/** 元素上的一个点：相对元素矩形左上角的 CSS 像素偏移。 */
export interface BrowserPoint {
  x: number
  y: number
}

/** `press` 的一个阶段：该时段内保持按下的完整键集合。 */
export interface BrowserKeyPhase {
  /** 物理键码，按 `keys.ts` 的表解析。空数组表示全部松开。 */
  keys: string[]
  /** 该键集合的保持时长。缺省为 0：按下后立即进入下一阶段。 */
  durationMs?: number
}

/** `drag` 路径的一段：从上一个落点移动到本元素上的点。 */
export interface BrowserPathStep {
  ref: string
  /** 缺省取元素中心。 */
  point?: BrowserPoint
  /** 本段移动的时长。缺省为 0：只发送中点与终点两次移动。 */
  durationMs?: number
}

export interface BrowserActInput {
  tabId: string
  action: BrowserActionKind
  /** 元素引用。`scroll` 与 `press` 可省略，此时作用于文档；`drag` 时为起点。 */
  ref?: string
  /** 指针动作在 `ref` 上的落点。缺省取元素中心。 */
  point?: BrowserPoint
  /** `fill` / `type` 输入的文本，或 `select` 待选中选项的值与显示文本。 */
  text?: string
  /**
   * `press` 的按键计划。阶段之间按集合差发送：前一阶段包含而后一阶段不包含的键抬起，
   * 反之按下；最后一个阶段结束时全部抬起。按 `keys.ts` 的表与上限裁决。
   */
  phases?: BrowserKeyPhase[]
  /** 指针动作期间保持按下的键，例如 `ShiftLeft`。动作开始前按下、结束后抬起。 */
  keys?: string[]
  /** `click` / `rightclick` 从按下到抬起的保持时长。 */
  holdMs?: number
  /** `drag` 的路径，至少一段。 */
  path?: BrowserPathStep[]
  /** `scroll` 的横向滚动量，向右为正。 */
  deltaX?: number
  /** `scroll` 的滚动量，向下为正。 */
  deltaY?: number
  /** `dialog` 的选择：true 为确定，false 为取消。prompt 对话框的输入文字取自 `text`。 */
  accept?: boolean
  /** 动作之后的观察附带截图。动作未完成时同样附带。 */
  screenshot?: boolean
}

/**
 * 动作之后的后续观察。两种结果互斥：取得观察，或说明未取得的原因。
 *
 * 没有观察不代表动作未发出。调用方取得 `observationError` 时先观察确认，
 * 不要重复同一个动作。
 */
export type FollowUpObservation =
  | {
      observation: BrowserObservation
      /**
       * 快照的采集条件。
       *
       * `quiet`：动作之后发出的 XHR / fetch 请求均已结束、页面短暂静默后采集；
       * `deadline`：静默等待达到上限时仍有请求未结束或页面仍在变化，但仍在总预算内采集到有效快照。
       * 两者都只说明采集时的快照可用，**不表示网站业务已经完成**。`wait` 不带此字段。
       */
      settle?: 'quiet' | 'deadline'
    }
  | { observation: null; observationError: string }

/**
 * 输入动作的执行回执。
 *
 * `completed` 只表示命令序列已经确认，**不表示业务成功**：页面是否接受本次输入须以
 * 动作之后的观察为准。已确认前缀之后本地终止为 `partial`；有事件已发出但未收到确认为
 * `unknown`，该事件可能已在页面上生效，调用方先观察再决定，不重放。
 */
export interface BrowserExecution {
  state: 'completed' | 'partial' | 'unknown'
  /**
   * 已确认的单元数，即已完成的前缀。单元按动作定义：`press` 是阶段，`type` 是 Unicode
   * 码点，`drag` 是路径段，`dblclick` 是按下抬起轮数，`click` / `rightclick` 是按下与抬起。
   */
  confirmedUnits?: number
  /** 未完成时的停止原因。`completed` 时省略。 */
  reason?: string
  /**
   * 收尾时未能确认抬起的键码与鼠标键。非空时 `state` 必为 `unknown`：页面可能仍认为
   * 这些键处于按下状态，而已断开的连接既无法发送抬起事件，也无法确认抬起。
   */
  unreleased?: string[]
}

/** 底层动作回执。观察由协调器在动作之后补充。 */
export interface BrowserActReceipt {
  /** 动作实际作用的元素，供调用方核对命中目标。 */
  element?: string
  /** 命中点，仅坐标动作带有。 */
  point?: { x: number; y: number }
  /** 输入动作的执行结果。`click` / `rightclick` / `dblclick` / `press` / `drag` / `type` 必带，其余省略。 */
  execution?: BrowserExecution
  /** `fill` 写入后控件中的实际值。 */
  value?: string
  /** `fill` 写入的值与给定文本不一致：控件已按自身类型规范化，例如日期去除了秒。 */
  normalized?: boolean
}

/**
 * `wait` 等待的页面状态，按选择器命中的第一个元素判定。
 *
 * `visible`：有尺寸且样式上可见；`hidden`：未命中或命中元素不可见；`enabled`：可见且未禁用；
 * `text` / `value`：文本（空白归一）或控件值与 `expected` 完全相等。
 */
export type BrowserWaitState = 'attached' | 'visible' | 'hidden' | 'enabled' | 'text' | 'value'

/** 底层等待回执。 */
export interface BrowserWaitReceipt {
  /** 条件达成。 */
  met: boolean
  /** 条件未达成时的原因：`timeout`、`cancelled` 或 `gone`（文档已更换）。 */
  reason?: string
}

/**
 * 动作期间页面上发生的事。从动作开始前订阅，到动作之后的观察取得为止。
 *
 * 范围是顶层页会话：主文档与同进程帧。跨站 iframe 的请求与 DOM 变化在其子会话上，不在统计之内，
 * 因此页面含 iframe 时各项为零不能证明动作没有任何效果。
 */
export interface BrowserActivity {
  /** 主文档已更换（跳转、刷新）。动作之后未取得观察时省略：无法判定。 */
  navigated?: boolean
  /** 动作开始之后页面发出的网络请求数，各类型均计入，含 WebSocket 发送的帧。 */
  requests: number
  /** 动作开始之后 DOM 有变化。探针失效而无法判定时为 true。 */
  domChanged: boolean
  /** 本次动作期间页面打开、归属本会话的新标签页。 */
  opened?: BrowserTabInfo[]
  /** 本次动作期间被宿主拦截的下载（未经 `browser_download` 授权）。 */
  downloadsBlocked?: { reason: string; suggestedName?: string }[]
  /**
   * 动作使页面弹出 JavaScript 对话框。对话框打开期间页面脚本停止执行，动作结果不带观察，
   * 由调用方以 `dialog` 动作选择确定或取消。
   */
  dialog?: {
    type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
    message: string
    defaultPrompt?: string
  }
  /** 动作使页面要求选择文件。系统的选择窗口未打开，以不带 ref 的 `upload` 提交文件。 */
  fileChooser?: { multiple: boolean }
}

/** 对话框类型在结果中的名称。工具结果与协调器的拒绝说明共用，两处名称一致。 */
export const BROWSER_DIALOG_NAMES: Record<NonNullable<BrowserActivity['dialog']>['type'], string> =
  {
    alert: '提示框',
    confirm: '确认框',
    prompt: '输入框',
    beforeunload: '离开页面确认框',
  }

export type BrowserActResult = BrowserActReceipt &
  FollowUpObservation & { activity?: BrowserActivity }

export type BrowserWaitResult = BrowserWaitReceipt & FollowUpObservation

export interface BrowserDownloadResult {
  /** 落盘的绝对路径。被拦截时省略。 */
  path?: string
  bytes?: number
  /** 宿主拦截本次下载的原因，原样取自 `download.blocked`。 */
  blocked?: string
  /** 网站建议的文件名。被拦截时用于指明被拦截的文件。 */
  suggestedName?: string
}

/**
 * 页面操作执行前拒绝：页级准入失败，或控制连接准备失败，尚未发出页面业务动作。
 * 已发出的动作遇到断连或超时不得声明 `executed:false`，应保留结果不明的回执。
 * `browser_disconnected` 需先对原页重新观察；`browser_busy` 需等待持有者释放；
 * `invalid_argument` 需修正参数；`browser_unavailable` 表示用户已关闭浏览器控制，重试无效；
 * `credential_path` 表示页面中已加载读取范围之外的本机文件（`localFiles`），重新加载或离开该页之后才能读取。
 * `stale_ref` 表示观察或元素编号已不指向原节点；`target_blocked` 表示目标此刻无法接收事件（被遮挡、尺寸为 0、
 * 不在可视区）。两者都需要重新观察。
 */
export interface BrowserRefusal {
  errorKind:
    | 'browser_busy'
    | 'invalid_argument'
    | 'browser_disconnected'
    | 'browser_unavailable'
    | 'credential_path'
    | 'stale_ref'
    | 'target_blocked'
  executed: false
}

/**
 * 页面经 file 协议读取一个本机文件之前的裁决。参数是 file URL；放行返回 `null`，拒绝返回理由。
 * 结论与文件工具读取同一路径相同：由浏览器工具按本次调用的读取范围构造（`browser.ts` 的 `localFileCheck`）。
 */
export type LocalFileCheck = (url: string) => Promise<string | null>

/**
 * 内置浏览器端口：本机原生浏览器资源的窄接口。
 *
 * **为什么是端口。** 真实浏览器由桌面外壳持有，服务端经宿主连接操作它，而桌面外壳与宿主连接
 * 在依赖图上均**高于** tools。因此接口定义在 tools，实现由装配方注入。
 *
 * **不注入即无此能力。** 没有原生宿主连接时装配方不注入，浏览器工具在 `requires` 中声明本端口，
 * 因此也不注册：没有浏览器的浏览器工具没有降级形态。
 *
 * **控制权按页分配，归属于本次执行。** 每次执行只操作自己的页，同一条会话的父子与
 * 并行成员互不影响；访问同一页时后到的一方得到 `BrowserRefusal` 形状的明确失败，
 * 不排队。本轮结束时由装配方调用 `release`，未消费的下载授权随之作废，
 * 页面保留给用户接手。
 */
export interface BrowserPort {
  /**
   * 设置本次执行中页面读取本机文件（file 协议）的裁决。浏览器工具在每次调用其他方法之前，按本次调用的
   * 读取范围设置一次；未设置时一律拒绝。
   *
   * 裁决作用于两处，结论相同：
   * - 已控制的页发出的每个 file 请求（顶层导航、框架导航与子资源），拒绝的请求以「拒绝访问」失败；
   * - 每次读取页面内容（观察、等待）之前页面中已加载的文档与资源。页面在受控之前（建页时的首次加载、
   *   两次执行之间、用户接管之前）加载的内容未经裁决，其中有拒绝的文件时本次读取被拒绝
   *   （`credential_path`），重新加载该页即按裁决加载。
   */
  localFiles(check: LocalFileCheck): void
  /** 宿主当前在本工作区中的存活页，包括用户手动打开的页。其他工作区的页不在其中。 */
  tabs(): Promise<BrowserTabInfo[]>
  /**
   * 新建一页。**建页不取得控制权**：该页归属本会话，首次 observe 或 act 时才占用它，
   * 在此之前其他执行者可以先行占用。不切换系统焦点，也不将任何窗口置前。
   */
  open(url: string): Promise<BrowserTabInfo>
  /**
   * 将一页接管到本会话。
   *
   * 归属由宿主判定：用户手动打开的页 → 归属本会话（模型仅在用户于聊天中指明后执行）；
   * 已归属本会话 → 幂等；已归属其他会话 → 失败，不抢占。**本会话自行打开的页无需
   * `bind`**：后续 observe/act 按归属直接占用。接管的同时占用该页。
   */
  bind(tabId: string): Promise<BrowserTabInfo>
  /** 关闭一页。只释放该页的资源，profile 与其他页不受影响。 */
  close(tabId: string): Promise<void>
  /**
   * 地址栏级导航。`goto` 必须带 url，其余三种不带。
   *
   * 返回导航之后的观察，不另外返回 tab/url/title：观察中的实际地址是唯一真源。
   * 导航被拒（`errorText`）时抛出错误，不以旧页快照报告跳转成功。
   */
  navigate(input: {
    tabId: string
    action: 'goto' | 'back' | 'forward' | 'reload'
    url?: string
  }): Promise<FollowUpObservation>
  /**
   * 观察一页：实际地址、标题、元素与按需截图；提供 `optionsFor` 时改为读取一页选项。
   *
   * 两种返回互斥，按是否提供 `optionsFor` 区分。
   */
  observe(input: {
    tabId: string
    /** 只观察指定的 iframe。缺省时覆盖主文档及其全部子帧。 */
    frame?: string
    screenshot?: boolean
    /** 起始元素序号，配合 `truncated` 翻页。 */
    offset?: number
    /** 只返回名称、正文或值包含该文字的元素，不区分大小写。翻页与 `truncated` 按筛选后的元素表计算。 */
    query?: string
    /**
     * 读取一个 `select` 的选项：按 `ref` 定位，实时读取。
     *
     * 不采集新观察、不分配编号、不移动页面；引用失效时要求重新观察。与 `frame` /
     * `screenshot` / `offset` 互斥：本模式返回选项页，不返回元素表。
     */
    optionsFor?: { ref: string; offset?: number }
  }): Promise<BrowserObservation | BrowserOptionsPage>
  /** 在已观察的元素上执行一次有限动作，并返回动作之后的观察。 */
  act(input: BrowserActInput): Promise<BrowserActResult>
  /**
   * 等待主文档中某个 CSS 选择器达到指定状态。超时有限，取消时一并清理页内等待器。
   *
   * 等待结束后直接采集一次观察，不再额外进行静默等待，因此结果不带 `settle`。
   */
  wait(input: {
    tabId: string
    selector: string
    state: BrowserWaitState
    /** `text` / `value` 等待的目标值，其余状态省略。 */
    expected?: string
    timeoutMs: number
  }): Promise<BrowserWaitResult>
  /**
   * 将本机文件交给一个文件输入元素。
   *
   * `paths` 必须是**已经过路径裁决**的绝对路径：此处只调用浏览器接口，不做工作区判断。
   */
  upload(input: {
    tabId: string
    /** 文件输入框的编号。缺省时提交给本页待处理的选择文件请求（`BrowserActivity.fileChooser`）。 */
    ref?: string
    paths: string[]
  }): Promise<{ files: string[] }>
  /**
   * 点击一个元素触发下载，并等待文件写入指定路径。
   *
   * `absolutePath` 必须是**已经过路径裁决**的绝对路径：实现方据此向宿主登记一次性
   * 授权，不做工作区判断。目标已存在时宿主拒绝覆盖，结果中带回拦截原因。
   */
  download(input: {
    tabId: string
    ref: string
    absolutePath: string
    timeoutMs: number
  }): Promise<BrowserDownloadResult>
  /**
   * 释放本次执行的全部控制权。可重复调用。
   *
   * **释放之后该端口即失效**：后续任何操作均失败，不会重新取得控制权。
   * 用户接管后，旧 Run 再调用工具得到明确失败，页面交由用户操作。
   */
  release(): Promise<void>
}

export const BrowserPort = definePort<BrowserPort>('browser')
