/**
 * 工具注册表：唯一的工具执行入口。
 *
 * 三条不变量：
 *
 * 1. **确定性序列化。** schema 按名称排序输出：工具定义位于 prompt 最前部，
 *    任何顺序变化都会使整个前缀缓存失效。
 * 2. **fail-closed。** 未注册的工具名返回结构化失败（executed=false），
 *    不伪装成功，也不静默跳过。
 * 3. **重名即装配错误。** 同名注册直接抛出异常，不静默覆盖：覆盖会丢弃整个插件的工具。
 */

import type { MediaFile, MediaInput, TokenDensity, ToolSchema } from '@qywork/ai'
import type {
  ActionDescriptor,
  ActionKind,
  CanvasOp,
  CanvasRunResult,
  CanvasView,
  FileChange,
  GenerateOutput,
  Goal,
  GoalAction,
  GoalWriteResult,
  IntermediateResourceRef,
  MediaSpend,
  ResourceCoverage,
  RunId,
  Schedule,
  ScheduleDraft,
  ScheduleView,
  SubagentKind,
  SubagentTarget,
  TodoItem,
  ToolOutcomeWire,
  WorkflowCall,
  WorkflowTransition,
} from '@qywork/core'
import type { DesktopPort } from './desktop.ts'

// ─────────────────────────────── 执行上下文 ───────────────────────────────

/**
 * 生成端口：生成工具经由它调用生成模型。
 *
 * 选择模型、按目录校验参数、调用接口由实现方完成（runtime，只有它持有配置与凭证）；读取参考图、写入产物由工具完成，
 * 与 `read_file` / `write_file` 使用同一套路径边界。接口定义在此处的理由同 `SinkPort`。
 */
export interface MediaPort {
  generate(call: MediaCall, signal: AbortSignal): Promise<MediaCallResult>
}

export interface MediaCall {
  /** `art` 由对话模型写出 HTML 页面，其余类别由生成模型生成。 */
  type: GenerateOutput
  prompt: string
  /** 输入文件，各自带有用途。操作由用途推导（见实现方），不由大模型选择。 */
  inputs: MediaInput[]
  /** 大模型按参数表填写的原生字段，由实现方按目录校验。 */
  params: Record<string, unknown>
  /** 与 `model` 须同时提供或同时省略；均省略时使用该类别的默认模型。 */
  provider?: string
  model?: string
  /** 继续取回已提交的远端任务：只查询与下载，不再提交，不重复扣费。须同时提供 provider 与 model。 */
  resumeTaskId?: string
  /**
   * 取得远端任务号后立即回调，附带实际选中的接口与模型，由调用方落盘；
   * 此后即使停止、超时或进程退出，仍可取回结果。
   */
  onTask?: (task: { taskId: string; provider: string; model: string }) => void | Promise<void>
  /** 远端任务状态变化时回报一条状态文字。 */
  onStatus?: (status: string) => void
  /** 本次生成的花费，取得结果时回报一次；失败不计费，不回报。 */
  onSpend?: (spend: MediaSpend) => void
}

/**
 * 失败（无法选定模型、参数不合法、接口报错）时的 `message` 直接交给大模型，须写明修正方法。
 * `pendingTaskId`：远端任务仍存在（等待超时、查询或下载失败），可以继续取回；不带该字段的失败是终态。
 */
export type MediaCallResult =
  | { ok: true; provider: string; model: string; files: MediaFile[]; warning?: string }
  | { ok: false; message: string; pendingTaskId?: string }

/**
 * 中间资源落盘端口。
 *
 * 接口定义在此处而不是 tools 包：`ToolContext` 位于 agent 包，
 * 而 tools 依赖 agent，反向引用会形成环。实现由 runtime 装配时注入
 * （只有它同时持有内容库与账本）。
 *
 * `null` 是合法值：`qy exec` 等一次性执行不一定需要正文库。
 * 工具必须能在没有 sink 的情况下降级工作，不能假设它存在。
 */
export interface SinkPort {
  land(input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType?: string | null
    coverage?: ResourceCoverage
  }): { resourceId: string; contentHash: string }

  /** 按 resource id 读取正文区间，供 `read_resource` 分页。 */
  read(resourceId: string, start: number, length: number): Uint8Array | null

  stat(resourceId: string): { sizeBytes: number; mimeType: string | null } | null
}

/**
 * 内置浏览器端口：本机原生浏览器资源的窄接口。
 *
 * **为什么是端口。** 同 `SinkPort`：真实浏览器由桌面外壳持有，服务端经宿主连接
 * 操作它，而桌面外壳与宿主连接在依赖图上均**高于** tools。因此接口定义在此处，实现由装配方注入。
 *
 * **不注入即无此能力。** 没有原生宿主连接时装配方不注入，对应的工具也不注册：
 * 没有浏览器的浏览器工具没有降级形态。
 *
 * **控制权按页分配，归属于本次执行。** 每次执行只操作自己的页，同一条会话的父子与
 * 并行成员互不影响；访问同一页时后到的一方得到 `BrowserRefusal` 形状的明确失败，
 * 不排队。本轮结束时由装配方调用 `release`，未消费的下载授权随之作废，
 * 页面保留给用户接手。
 */
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
 * 一页选项。观察的 `optionsFor` 模式返回该结构，不产生新的观察编号。
 *
 * `observationId` 与 `ref` 指向读取时所用的旧观察。`items` 按当前 DOM 实时读取，
 * 选项增删之后须重新读取：两次读取的结果合并后不是同一时刻的快照。
 */
export interface BrowserOptionsPage {
  tabId: string
  observationId: string
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
 * `ref` 仅在**同一次观察、同一 tab、同一帧、同一份文档**内有效。导航、重连、
 * 重新观察之后旧编号全部作废，实现方在执行动作前复核节点仍处于连接状态且身份匹配。
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
  /** 观察编号。动作必须携带该编号；重新观察即更换编号，旧编号作废。 */
  observationId: string
  elements: BrowserElement[]
  /** 元素数超过上限而被截断。调用方须知道本页不是全部元素。 */
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
  observationId: string
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
       * `quiet`：短暂静默后采集；`deadline`：静默等待达到阶段上限，但仍在总预算内采集到有效快照。
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
  /** `fill` 写入的值与给定文本不一致：控件已按自身类型规范化，例如日期去掉了秒。 */
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

export type BrowserActResult = BrowserActReceipt & FollowUpObservation

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
 * `invalid_argument` 需修正参数；`browser_unavailable` 表示用户已关闭浏览器控制，重试无效。
 */
export interface BrowserRefusal {
  errorKind: 'browser_busy' | 'invalid_argument' | 'browser_disconnected' | 'browser_unavailable'
  executed: false
}

/**
 * 画布端口：Agent 读取、修改、运行画布，由服务端画布服务执行。与界面使用同一个实例，
 * 因此画布的写入次序与运行中卡片的状态只有一份。接口定义在此处，实现由 server 注入（同 `BrowserPort`）；
 * 没有服务端的会话（CLI）不注入，画布工具不注册。
 *
 * 失败以抛出 `Error` 表示，`message` 原样交给大模型。
 */
export interface CanvasPort {
  /** 工作区中的画布文件，以工作区相对路径表示。 */
  list(): Promise<string[]>
  read(path: string): Promise<CanvasView>
  edit(path: string, ops: CanvasOp[]): Promise<{ view: CanvasView; refs: Record<string, string> }>
  /** 运行一张生成卡并等待结束。花费记入 `media`：Agent 传入本轮的 `ctx.media`，花费计入本轮。 */
  run(path: string, nodeId: string, media: MediaPort, signal: AbortSignal): Promise<CanvasRunResult>
  /** 取回仍在远端的某一版视频。省略 `version` 时取当前版本或最新的待取回版本。 */
  retrieve(
    path: string,
    nodeId: string,
    version: string | undefined,
    media: MediaPort,
    signal: AbortSignal,
  ): Promise<CanvasRunResult>
}

/**
 * Office 工具的执行程序：Python 解释器与 worker 入口的位置，以及本机各格式的办公软件能力。
 *
 * 宿主在进程启动时探测一次并缓存，按轮注入；工具据此启动 worker，不自行查找解释器。
 * `apps` 中某个格式不可用时，该格式仍可读取与制作，仅重算、目录回填与渲染报告不可用。
 */
export interface OfficePort {
  /** Python 解释器的绝对路径。 */
  python: string
  /** worker 入口 `worker.py` 的绝对路径。 */
  worker: string
  apps: Record<'docx' | 'xlsx' | 'pptx', { available: boolean; reason: string }>
  /** 开关当前是否开启。每次调用前实时判定：运行中关闭后，后续调用被拒绝，已开始的调用正常结束。 */
  enabled(): boolean
}

export interface BrowserPort {
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
   * 导航被拒（`errorText`）时抛出错误，不以旧页快照冒充跳转成功。
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
     * 读取一个 `select` 的选项：按该旧观察中的 `ref` 定位，实时读取。
     *
     * 不采集新观察、不分配编号、不移动页面；引用失效时要求重新观察。与 `frame` /
     * `screenshot` / `offset` 互斥：本模式返回选项页，不返回元素表。
     */
    optionsFor?: { observationId: string; ref: string; offset?: number }
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
    observationId: string
    ref: string
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
    observationId: string
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

/**
 * 派发端口：将一项任务交给一个子 agent（角色）或本机已安装的外部 agent CLI。
 *
 * **为什么是端口。** 同 `SinkPort`：运行子会话需要 `Session` 与账本，二者在依赖图上均**高于**
 * tools，工具直接引用即构成反向边。因此接口定义在此处，实现由装配方注入。
 *
 * **不注入时没有此工具。** 与 `sink` 的「缺失时降级」不同：无法派发的派发工具没有任何降级形态，
 * 因此装配方不注入时**不注册该工具**（B5：没有数据源就不做入口），
 * 而不是注册一个必然返回失败的工具。
 *
 * **子 agent 不得再派发任务。** 装配方只为顶层会话注入该端口。成员会话无法取得它，因此不会递归：
 * 递归派发没有终止条件，一次失控即会耗尽整台机器的进程资源。
 *
 * **派出即返回，完成以事件通知。** 端口上没有等待、没有汇合，也没有「本轮结束即停止子 agent」：
 * 子 agent 的生命周期跟随会话，回执由实现方作为一条消息投递回该会话。
 */
export interface SubagentSummary {
  id: string
  kind: SubagentKind
  name: string
  provider: string
  model: string
  /** 按其在卡片上最后一次出现时的状态判定：working = running，failed / interrupted = failed，其余为 idle。 */
  status: 'running' | 'idle' | 'failed'
  /**
   * 再次派发时是否延续上一轮。角色与临时子 agent 恒为 true；外部 CLI 须已返回会话号
   * 且该 CLI 支持续接，否则再次派发等同于新建会话，不保留上一轮的上下文。
   */
  resumable: boolean
}

export interface DelegatePort {
  /** 当前项目可派发的目标：角色库中的角色，以及本机识别到的外部 CLI。 */
  targets(): Promise<{
    roles: { id: string; name: string; description: string; provider?: string; model?: string }[]
    clis: { id: string; vendor: string; connected: boolean }[]
  }>
  /** 本会话已有的子 agent。 */
  subagents(): Promise<SubagentSummary[]>
  /**
   * 把模型名解析为配置中真实存在的「接口 × 模型」。
   *
   * 创建角色与实际派发任务必须使用同一套校验：前者若只接收一段自由文本，错误名称会先被
   * 写入 team.json，再在每次派发任务时重复请求 provider 并失败。失败时返回可用列表，使调用方
   * 在产生子会话与外部请求之前纠正。
   */
  resolveModel(
    name: string,
    provider?: string,
  ): { provider: string; model: string } | { error: string }
  /**
   * 派出一个子 agent，**立即返回**。目标是新建（按种类）还是已有（按 id）由 `target` 决定；
   * 无法派发时通过返回值报告，不抛出异常：模型须按原因改用其他做法。
   *
   * **产出不经由此方法返回。** 子 agent 完成之后，实现方将回执作为一条消息投入该会话
   * （忙碌时在下一个 step 边界注入，空闲时立即开始新一轮），调用方无需等待，也无法等待。
   *
   * `stepId` 是本次调用所属卡片的 id，实现方据此广播进度；`nodeId` 是图中的节点，
   * 只派发一项任务时省略，实现方使用单节点的固定 id。
   */
  /**
   * 本会话当前正在运行的子 agent。仅报告事实，不等待它们：循环在 end_turn 时读取该列表，
   * 清单未完成而任务由这些子 agent 执行时，本轮正常结束。
   */
  inflight(): { name: string }[]
  dispatch(input: {
    target: SubagentTarget
    task: string
    /** 仅在新建时生效：仅当用户指定了模型时提供。 */
    provider?: string
    model?: string
    runId: string
    stepId?: string
    nodeId?: string
  }): Promise<{
    ok: boolean
    /** 无法派发的原因：目标不存在、外部 CLI 未安装、模型指定不合法。 */
    error?: string
    /** 派发对象。记录未能建立时省略。 */
    subagentId?: string
    name?: string
    /** 派发对象的子 agent 种类。文案据此选择称呼；记录未能建立时省略。 */
    kind?: SubagentKind
    /** 本次派发是否新建了该子 agent。 */
    created?: boolean
    /** 本次派发中模型应知道的事实，例如续接时未能接续会话、角色已不存在。原样交回模型。 */
    note?: string
  }>
  /**
   * 推进整张图：一次说明拆分为哪些任务、由谁执行、任务之间的依赖关系。
   *
   * **调度由实现方完成**：依赖就绪后启动、并发上限均由实现方的推进器按图计算。
   * 规则与 `dispatch` 相同：派发当前就绪的节点后即返回，节点执行完毕的回执、
   * 到达检查点的回执均作为消息送到该会话。
   *
   * `stepId` 是本次工具调用的卡片 id，实现方据此广播进度，前端据此认领对应的图卡。
   */
  runGraph(input: { call: WorkflowCall; runId: string; stepId: string }): Promise<{
    ok: boolean
    error?: string
    transition?: WorkflowTransition
    /** 本次推进之后整张图是否已全部处于终态且全部批准。 */
    completed?: boolean
  }>
}

/**
 * 插件安装端口：将工作区中已编写完成的插件目录安装到本机的插件目录。
 *
 * **为什么是端口。** 清单校验位于插件包，而插件包与 tools **同层**（依赖图中均为第 3 层），同层之间不得互相依赖。
 * 因此工具只声明形状，由装配方在更高层实现。
 *
 * **不询问用户。** 本产品只有两种权限模式（`auto` / `full`），没有「逐次询问」档位。
 * 安装插件与其他工具相同，执行即视为同意；校验由**清单校验**承担：形状不合法时立即拒绝，
 * 不落盘。
 *
 * **为什么分两步。** `inspect` 只返回摘要，供模型判断该目录是否为待安装的目录；
 * 安装之前实现方会**再读取一次**：两步之间模型还会执行其他步骤，目录可能已经变化。
 */
export interface PluginPort {
  /** 只检查不安装：返回目录中的清单内容。不合法时返回 `error`，不抛出异常。 */
  inspect(dir: string): Promise<{
    ok: boolean
    error?: string
    id?: string
    name?: string
    version?: string
    tools?: string[]
    permissions?: string[]
    /** 本机已安装同 id 的插件，本次安装为覆盖。 */
    replacing?: boolean
  }>
  /** 安装。`replace` 为假且已存在同 id 的插件时直接拒绝，不静默覆盖。 */
  install(dir: string, opts: { replace: boolean }): Promise<{ ok: boolean; error?: string }>
}

/**
 * MCP 配置写入端口。
 *
 * 配置解析器位于 mcp 包，作用域路径位于 tools 包，两者同层，不能互相依赖。工具只声明动作，runtime 同时依赖
 * 二者并实现该端口。未注入端口时不注册对应工具，避免出现必然失败的入口。
 */
export interface McpActivation {
  connected: boolean
  toolNames: string[]
  failures: { server: string; reason: string }[]
  inactive: string[]
  effectiveScopes?: Record<string, 'builtin' | 'project' | 'global'>
}

export interface McpConfigPort {
  writeServer(input: { name: string; configJson: string; scope: 'project' | 'global' }): Promise<{
    ok: boolean
    error?: string
    path?: string
    replaced?: boolean
    saved?: boolean
    activation?: McpActivation
  }>
  moveServer(input: {
    name: string
    fromScope: 'project' | 'global'
    toScope: 'project' | 'global'
  }): Promise<{
    ok: boolean
    error?: string
    fromPath?: string
    toPath?: string
    saved?: boolean
    activation?: McpActivation
  }>
}

/**
 * 定时任务端口。
 *
 * **为什么是端口。** 理由同 `GoalPort`：任务表位于账本（`@qywork/store`），而工具不持有账本
 * 句柄；写入哪一份账本、归属哪个工作区，由装配方决定。接口定义在此处，实现由 runtime 注入。
 *
 * **按当前工作区限定范围。** 任务表全机只有一份，方法不带工作区参数：带有该参数即允许模型列出
 * 甚至删除其他项目创建的任务，而模型从未见过那些任务。
 *
 * 可选：直接构造 `ToolContext` 的测试夹具无法注入。三个工具必须能降级，明确报告「本次执行没有
 * 定时任务表」，不得声称已记录。
 */
export interface SchedulePort {
  /** 当前工作区的全部任务，带上次执行的 Run 终态投影。 */
  list(): ScheduleView[]
  /** 新建一条任务。校验由调用方预先完成，此处只负责落盘。 */
  create(draft: ScheduleDraft): Schedule
  /** 删除一条任务；不存在或不属于当前工作区时返回 null。 */
  remove(id: string): Schedule | null
}

/**
 * 会话读取文件时该文件的内容记录。写入前的新鲜度校验依赖它。
 *
 * **为什么必须是 port，不能放入 `state`。** `state` 是 **run 内的临时状态**（投递额度、计划快照均在其
 * 中，前者每次决策时重新建立），而读取记录的生命周期应为**整条会话**：模型上一轮读取、本轮直接修改是正常
 * 用法，记录绑定在 run 上意味着每轮首次修改文件必然先以「未读取过」失败一次。服务端**每条消息新建
 * 一个 Session**，进程中没有可绑定的会话级生命周期，因此生命周期由装配方管理（runtime 使用账本按会话
 * 存储），此处只约定形状。
 *
 * 可选：未注入时工具退化为 run 内记录，不能假设它存在。
 */
export interface FileReadPort {
  /** 读取过时返回读取时的内容哈希，否则返回 null。 */
  seen(path: string): string | null
  /** 记录刚读取（或刚写入）的内容哈希。 */
  mark(path: string, hash: string): void
}

/**
 * 目标端口：设定一个目标后逐轮推进直至完成。
 *
 * **为什么是端口。** 理由同 `SinkPort`：目标写入**账本**（`@qywork/store`），而 tools 在依赖图
 * 上**低于** store，工具直接引用它即构成反向边。因此接口定义在此处（agent），实现由 runtime 注入：
 * runtime 同时持有账本与事件通道。
 *
 * **不要改用 `ctx.resources`。** 该 Map 只在 `runtime/session.ts` 中以
 * `new Map()` 创建，全仓没有任何键被注入；使用它会使这条链路没有生产者。
 *
 * **写入结果是返回值，不是异常。** 三种拒绝（revision 过期、状态不允许、缺少理由）都须**原样交给模型**：
 * 模型须知道具体是哪一种才能调整做法。异常会被注册表归并为一句「工具执行出错」。
 *
 * **变更事件由实现方发送。** 写入成功后 `goal` 事件由端口实现负责广播，不由工具再调用 `emitXxx`：
 * 目标变更与写入账本是同一件事，拆成两步会导致只完成其中一步。
 * （待办通道不同：待办不写入账本，工具是其唯一的真源。）
 *
 * `undefined` 是合法值：`qy exec` 等一次性执行没有会话，因此没有目标。
 * 工具必须能降级，明确报告「这里没有目标账本」，不得声称已记录。
 */
/**
 * 待办端口：**只读**，因为待办不存在独立的第二份状态。
 *
 * 事实均记录在 tool steps 中：`write_todos` 写入整表，`subagent` 在自己的 step 上留下
 * 待验收回执；只有前者改变清单状态。`read()` 从同一账本读取；增加
 * `write()` 会使同一份清单存于两处，两本账终将不一致。
 *
 * 该端口存在的唯一理由：**「这是第一份清单，还是修改已有清单」是会话级事实**，
 * 而 `ctx.state` 是 run 级的（一条消息对应一个 run，Map 每次新建），从中无法查到
 * 上一轮的清单，动作词因此只能恒为「创建」或恒为「修改」。
 *
 * 可选：`qy exec` 等一次性执行没有会话，因此无法读取上一份清单。工具必须能降级，
 * 见 `write_todos` 的 `actionKind`：无法读取时称「创建」，会把一次修订描述得比实际范围小；
 * 反之称「修改」会在没有清单时声称修改了一份不存在的清单。
 */
export interface TodoPort {
  /** 从 tool steps 读取清单；指定 runId 时按本轮提交或父任务回执的接续关系取清单。 */
  read(runId?: RunId): TodoItem[] | null
}

export interface GoalPort {
  /** 当前会话的目标；未设定时为 null。 */
  read(): Goal | null
  /**
   * **没有 `create`。** 设定目标是用户的操作（`/goal`），不经由工具。
   *
   * `action` 只能取 `complete` / `blocked` 两个值；账本层还接受
   * `edit` / `pause` / `resume`，但这三个动作的生产者位于服务端与用户一侧。
   */
  update(input: {
    goalId: string
    revision: number
    action: GoalAction
    blockedReason?: string
  }): GoalWriteResult
}

const COMPACTION_EPOCH_KEY = 'ctx.compactionEpoch'

/**
 * 本 run 中已生效的压缩次数。
 *
 * 压缩将上下文末尾保留区之前的工具正文替换为信封。工具先前投递、之后仍要引用的结果，仅当其记录的
 * 次数与当前次数相等时，才仍逐字保留在模型的上下文中。
 */
export function compactionEpoch(state: Map<string, unknown>): number {
  return (state.get(COMPACTION_EPOCH_KEY) as number | undefined) ?? 0
}

/** 记录一次已生效的压缩。由 loop 在压缩生效之后调用。 */
export function markCompacted(state: Map<string, unknown>): void {
  state.set(COMPACTION_EPOCH_KEY, compactionEpoch(state) + 1)
}

/**
 * 已折叠会话历史的读取通道。
 *
 * **为什么必须存在。** 压缩是投影而不是删除：manifest 只描述发送请求时如何折叠，`messages` /
 * `steps` 不改动任何字节。但折叠之后模型只持有摘要，**缺少此通道时，没有任何工具能按摘要中的 `[message:…]` /
 * `[action:…]` 标记取回原文**，数据保留在库中却没有消费者。有此通道，压缩的语义才是「将内容从常
 * 驻上下文移到按需读取」，而不是「丢弃」。
 *
 * 与 `SinkPort` 的分工：`SinkPort` 读取**工具产出的正文**（落盘的 `rs_xxx`），
 * 本端口读取**会话历史本身**（消息与执行记录）。两者不重叠，也不互为后备。
 *
 * `undefined` 是合法值。工具已注册而端口未接入时如实报告「无法读取历史」，**不要退化为
 * 「未找到」**：后者会使模型认为 id 写错，进而花费多轮推测一个无法取得的 id。
 */
/**
 * 一条执行记录的取回形态。
 *
 * `images` 与 `outcome` 分开：图像字节经由图像块传递，不序列化到 outcome 文本中。
 * 一张截图的 base64 可达数 MB，作为文本返回给模型既无法被理解，又会占满投递预算。
 */
export interface HistoryStep {
  tool: string
  status: string
  args: string
  outcome: string
  images?: { data: string; mime: string }[]
  /** 读取时交付的视频：以路径引用，见 `loop/request.ts` 的 `videosOf`。 */
  videos?: { path: string; mime: string }[]
}

export interface HistoryPort {
  /**
   * 按消息 id 取回原文。不存在时返回 null。
   *
   * **须同时识别两种 id**：`messages` 表的行 id，以及 run 内注入的用户消息的
   * `<runId>:<stepId>`；后者不在 `messages` 表中（它是一条 `kind='user'` 的 step）。
   * 摘要中两者均输出为 `[message:…]`，模型无法区分，也无需区分。
   */
  message(id: string): { role: 'user' | 'assistant'; content: string } | null
  /**
   * 按执行记录 id 取回原文。
   *
   * id 使用摘要中的 `<runId>:<stepId>` 复合形式：单独的 step id 在跨 run 的
   * 会话中不唯一，而摘要正文引用的是跨 run 的早期记录。
   */
  step(id: string): HistoryStep | null
  /**
   * 按工具调用 id 取回该次调用的执行记录。
   *
   * 收纳段将工具结果的正文替换为信封，信封中保留 `call_id`，**它即为取回地址**。
   * 已落盘的结果经由 `resources` + `read_resource` 读取，未落盘的中小结果只能经由此方法取回：
   * 缺少此方法时，收纳等同于删除。
   *
   * 因此不向信封添加新键：信封每增加一个字段，所有历史请求的字节都会变化，
   * 前缀缓存全部失配。
   */
  byCallId(callId: string): HistoryStep | null
  /**
   * 在本会话的全部历史中搜索子串，返回命中项及其定位符。
   *
   * 理由与 `read_resource` 的 `query` 相同：已知查找目标时，
   * 搜索比让模型推测 id 更快，开销也更小。
   */
  search(query: string, limit: number): { id: string; kind: 'message' | 'step'; line: string }[]
  /**
   * 本会话派发的某个子 agent 的历史，以相同的方法按该子 agent 的会话读取。
   * 不属于本会话的 id 返回 null：子 agent 的历史只对创建它的会话可见。
   */
  forSubagent(id: string): HistoryPort | null
}

export interface ToolContext {
  workspaceRoot: string
  conversationId: string
  runId: string
  model: string
  /**
   * 本轮所用模型的上下文窗口。观察视图的单份尺寸据此计算。
   *
   * 所有上限都**在执行时应用**：投递额度（`delivery.ts`，loop 在每次决策时重新建立）与视图尺寸在工具执行
   * 时确定，结果截断后写入 step。投影只读取已落库的 payload，不重新计算上限，
   * 因此更换模型只影响之后的读取，历史不改动任何字节。
   *
   * 若在投影时按当前模型重新计算上限，同一条 step 的字节会随模型变化，
   * 每更换一次模型整段历史都会失配、缓存全部失效，投影也不再是纯函数。
   */
  contextWindow: number
  /**
   * 本轮所用模型的 token 密度。投递预算的扣减使用它，与请求一侧采用同一计量标准。
   *
   * 理由同 `contextWindow`：上限按执行时的模型计算，结果按算出的上限截断后落库，
   * 投影只读取已落库的 payload。两侧计量标准不同时，同一份结果在投递检查处与在请求中
   * 是两个不同的数值，而预算扣减的是前者，进入窗口的是后者。
   */
  density: TokenDensity
  /**
   * 本轮所用模型是否接受图片。三态，约定见 `ai` 的 `ModelSpec.vision`：
   * `null` = 没有出处，按放行处理；只有 `false` 时拦截。
   *
   * 理由同 `contextWindow` / `density`：在**执行时**按当前模型判定。
   * 工具据此决定是否读取图片字节；不判定时，一张图片会完成缩放、
   * 扣减投递预算，再在装配请求时被替换为一句提示，本次执行因此无效。
   */
  vision: boolean | null
  /**
   * 本轮所用模型与接口是否接受原生视频：需模型具备该能力（`ModelSpec.video`）且适配器实现了视频传输。
   * 与 `vision` 相同，在执行时判定；`read_file` 据此决定读取视频时交付还是直接拒绝。省略即不接受。
   */
  video?: boolean
  /**
   * 适配器将本地视频上传为地址的字节阈值（`transmits.mediaUploadAbove`），省略表示一律内联。
   * `read_file` 与 `videoDelivery` 据此共同判断一段视频按原生视频发送还是抽帧，与发送时使用同一判据。
   */
  videoUploadAbove?: number
  /** 环境注入的只读资源；插件按名称读取所需资源，核心不为业务字段扩展此类型。 */
  resources: Map<string, unknown>
  /** 插件的 run 内可变状态。 */
  state: Map<string, unknown>
  signal: AbortSignal
  /** 中间资源落盘。null = 本次执行没有正文库，工具须降级为纯截断。 */
  sink: SinkPort | null
  /**
   * 会话级的文件读取记录。见 `FileReadPort`。
   *
   * 可选而不是必填可空（`sink` 属于后者）：未接入时工具退化为 run 内记录，
   * 这是**更严格**的一侧（每轮要求重新读取一次），漏接不会放宽任何边界。
   */
  reads?: FileReadPort
  /**
   * 会话级的目标与自动继续。见 `GoalPort`。
   *
   * 可选而不是必填可空：未接入时目标工具明确报告「本次执行没有目标账本」，
   * 这是**更严格**的一侧（循环无法启动），漏接不会使任何循环自行启动。
   */
  goals?: GoalPort
  /**
   * 会话级的当前待办投影。见 `TodoPort`。
   *
   * 只读：`write_todos` 据此判定动作词，Agent Loop 据此判断一次正常 end_turn 后
   * 是否仍有未完成项。未接入时工具一律报告「创建」，循环沿用普通问答的结束语义；
   * 两侧都不会无依据地生成清单。
   */
  todos?: TodoPort
  /**
   * 已折叠历史的读取通道。见 `HistoryPort`。
   *
   * 装配方持有账本时应接入；未接入时工具如实报告，不伪装为「未找到」。
   */
  history?: HistoryPort
  /**
   * 派发通道。见 `DelegatePort`。
   *
   * 未接入时 `subagent` 工具不注册，因此工具实现中可以断言它存在。
   */
  delegate?: DelegatePort
  /**
   * 插件安装通道。见 `PluginPort`。
   *
   * 未接入时 `install_plugin` 不注册，理由同 `delegate`：
   * 无法安装插件的安装工具没有任何降级形态。
   */
  plugins?: PluginPort
  /** MCP 配置通道；未接入时 `write_mcp_server` / `move_mcp_server` 不注册。 */
  mcpConfig?: McpConfigPort
  /** 当前会话已绑定的技能包来源，精确到附件路径。 */
  skillSourcePaths?: () => string[]
  /**
   * 生成通道。见 `MediaPort`。
   *
   * 未配置任何生成模型时不接入，生成工具不注册：没有模型的生成工具没有任何降级形态。
   */
  media?: MediaPort
  /**
   * 画布通道。见 `CanvasPort`。
   *
   * 没有服务端时不接入，`canvas` 工具不注册。
   */
  canvas?: CanvasPort
  /**
   * 内置浏览器通道。见 `BrowserPort`。
   *
   * 未接入时浏览器工具不注册，理由同 `delegate`：没有浏览器的浏览器工具
   * 没有任何降级形态。
   */
  browser?: BrowserPort
  /**
   * 电脑控制通道。见 `DesktopPort`。
   *
   * 未接入时桌面工具不注册，理由同 `browser`：没有原生宿主的桌面工具
   * 没有任何降级形态。
   */
  desktop?: DesktopPort
  /**
   * Office 文档执行程序。见 `OfficePort`。
   *
   * 没有可用的 Python 与文档库，或用户关闭了「Office 文档」时不接入，Office 工具不注册。
   */
  office?: OfficePort
  /**
   * 定时任务通道。见 `SchedulePort`。
   *
   * 可选而不是必填可空：未接入时三个工具明确报告「没有定时任务表」，这是**更严格**的一侧
   * （无法创建任务），漏接不会使任何任务被静默丢弃。
   */
  schedules?: SchedulePort
  /**
   * 长时间运行工具的中间输出回传通道（shell stdout、下载进度）。
   *
   * **只能由 loop 按 step 绑定**：该通道产出的 `tool.delta` 须携带 stepId 才能识别
   * 所属卡片，而 stepId 在 loop 创建 step 时才产生。装配方（runtime）
   * 无法构造该字段，也不得自行构造空值替代：前端按 stepId 查找卡片，
   * 未找到时整条通道被静默丢弃。因此装配方提供的是 `ToolContextBase`，
   * emit 由 loop 在每次调用前补充。
   */
  emit(channel: 'stdout' | 'stderr' | 'progress', delta: string): void
  /**
   * 本次工具调用的 step id。**理由同 `emit`，由 loop 补充**：它在创建 step 时
   * 才产生，装配方无法构造。
   *
   * 用途是让工具向服务端告知进度事件所属的卡片：`workflow` 的图卡依靠它认领
   * `team.member`。不要将它作为本次调用的身份四处传递：卡片之外没有第二个消费者。
   *
   * 可选而不是必填：直接构造 `ToolContext` 的位置（测试夹具）不应被迫编造 id。
   * 使用它的工具必须自行判空并**如实报错**：无法关联卡片的进度事件到达前端后同样会被静默丢弃，
   * 声称已派发远比直接报告「无法获取卡片 id」有害。
   */
  stepId?: string
  /**
   * 待办变更广播。可选：装配方未接入时没有待办面板，工具仍能正常记录。
   *
   * 独立为一条通道而不复用 emit：emit 是**增量文本**语义（stdout 分段到达），
   * 待办是**整表快照**语义，合用一条通道时前端无法区分应追加还是应替换。
   */
  emitTodos?(todos: TodoItem[]): void
  /**
   * 请求授权。被拒绝时工具必须直接放弃，不得绕行。
   *
   * 入参是工具名与参数：裁决按工具区分（`run_command` 与插件工具的执行目标形状相同，
   * 裁决路径完全不同）。拒绝必须带理由，见 `PermissionVerdict`。
   */
  requestPermission(call: {
    toolName: string
    args: Record<string, unknown>
  }): Promise<PermissionVerdict>
  /**
   * 已知凭证：交给子进程之前须剥离的值。
   *
   * `values` 是 key 明文。启动子进程的工具（目前只有 `run_command`）**必须**
   * 用它过滤环境变量与输出。
   *
   * 此处有意写成结构类型而不是 `import type { SecretSet } from '@qywork/tools'`：
   * tools 依赖 agent，反向 import 会形成环。不值得为一个单字段对象引入循环依赖。
   *
   * 可选是为了使现有测试装配无需全部修改；**但工具侧不能因其缺失而跳过脱敏**，
   * 缺失时按空集合处理（含义是「没有已知凭证」，而不是「无需剥离」）。
   */
  secrets?: { values: string[] }
  /** 显式放行的环境变量名。只豁免「名称形似凭证」这一判据，不豁免值命中。 */
  envAllowList?: string[]
  /**
   * 工作区之外**额外**可读写的绝对路径。来自配置的 `additionalDirectories`。
   *
   * 它主动放宽安全边界，因此有三条硬性要求，缺少任何一条都会使其退化为静默无效的选项：
   *
   * 1. **必须同时传给三层**：路径解析、`policy.ts` 的拒绝清单、沙箱 bind 清单。
   *    只接入一层时配置不生效，且三层各自的错误信息完全不同。
   * 2. **只接受绝对路径**，且已经过 `normalizeAdditionalDirectories` 校验。
   * 3. **它是 `auto` 的机制。** `full` 下完全不设路径边界，是否配置此清单结果相同，
   *    不要写成「`full` 不豁免它」：那与 `unrestrictedPaths` 的语义相反。
   */
  additionalDirectories?: string[]
  /**
   * 只读根目录：已安装技能各自的目录（绝对路径），由装配方按本轮扫描结果提供。
   *
   * 技能附带的参考文档、模板与示例代码位于这些目录中，读取类工具与 Office 工具的输入可以读取，
   * 任何写入仍按工作区与额外目录判定。shell 一侧的只读命令同样能读取这些目录，两侧范围一致。
   */
  readOnlyRoots?: string[]
  /**
   * 「完全访问」模式：完全不设路径边界。
   *
   * **它不是 `additionalDirectories` 的替代**：后者在受限模式下额外开放若干
   * 目录，前者表示该模式不设边界。两者同时存在时以前者为准，因为
   * `full` 的定义就是不裁决。
   *
   * 它与权限检查是同一模式的两个方面：`session.ts` 的 `decide` 在 `full` 下直接
   * 返回 allowed，`run_command` 已全部放行。路径层若不随之放开，结果不是更安全，
   * 而是 `read_file` 被拒、`run_command` 却能读取同一文件。
   *
   * **它不影响内核沙箱层。** `shell.ts` 组装 `SandboxPolicy` 时不读取此字段，
   * 因此在具备 bubblewrap / seatbelt 的平台上，`full` 下 shell 子进程仍受写入边界约束。
   */
  unrestrictedPaths?: boolean
  /**
   * 禁止 shell 命令访问网络。来自配置的 `sandboxNetwork: "deny"`。
   *
   * **只有内核沙箱能实现此限制**：没有沙箱的平台上传入此字段也不生效，
   * 因此配置体检会在此类机器上明确报告其未生效，而不是显示为已断网。
   */
  denyNetwork?: boolean
}

/**
 * 装配方能够提供的部分：除 `emit` 与 `stepId` 之外的全部字段。
 *
 * 拆分的原因是这两个字段的来源与其余字段不同：其余字段在 run 开始时即已确定，
 * 而 stepId 在每次工具调用时才产生（`emit` 须携带它，`workflow` 也用它关联图卡）。
 * 装配方无法取得这两个字段，因此它们不出现在此类型中，由 loop 在调用前补齐。
 */
export type ToolContextBase = Omit<ToolContext, 'emit' | 'stepId'>

/**
 * 授权裁决。
 *
 * 拒绝**必须**带理由。这是两种模式设计的直接结果：`auto` 下没有弹窗，
 * 拒绝信息只能经由工具结果交给模型，而模型只有取得理由才能改用其他做法
 * （「无法写入工作区外的路径」→ 改为写入工作区内）。
 */
export type PermissionVerdict = { allowed: true } | { allowed: false; reason: string }

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>

/** 工具执行结果。这是规范事实，必须原样抵达账本、事件流和 provider transcript。 */
export interface ToolOutcome {
  status: 'success' | 'failure'
  /** 是否实际执行。权限拒绝 / 注册表未命中 = false。 */
  executed?: boolean
  message: string
  data?: Record<string, unknown>
  /** 明确的用户界面展示意图；缺省结果只进入模型上下文与账本。 */
  presentation?: { images?: 'inline' }
  fileChanges?: FileChange[]
  /** 本次调用落盘的中间资源。必须原样写入账本：压缩层据此判断正文是否仍然存在。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

// ─────────────────────────────── 工具声明 ───────────────────────────────

/**
 * 工具能力大类。**没有「其他」。**
 *
 * 这是与动作轴（`ActionKind`）、权限轴（`PermissionEffect`）**正交**的第三条轴：
 * 动作轴描述「做了什么」，权限轴描述「有什么副作用」，本轴描述「属于哪个领域」。
 * 三轴分离使动作轴无需承担领域划分：没有本轴时，`search` / `fetch` /
 * `plan` / `delegate` 等词会进入动作轴。
 *
 * 分类共三层：`category`（大类）+ `facet`（类内功能方向）+ `summary`（一句话用途），
 * 注册期必填，缺少任何一项即注册失败。
 *
 * `mcp` 与 `plugins` 各自是一个领域：MCP server 提供的工具一律归入 `mcp`，插件提供的工具
 * 一律归入 `plugins`，因为它们的类目由第三方决定；内置工具中只有管理 MCP 配置的归入 `mcp`、
 * 安装插件的归入 `plugins`。两者不是后备类目：内置工具漏标时注册直接失败，不会归入其中。
 *
 * 枚举顺序即界面呈现顺序。
 */
export type ToolCategory =
  | 'files'
  | 'code'
  | 'web'
  | 'browser'
  | 'desktop'
  | 'office'
  | 'media'
  | 'memory'
  | 'skills'
  | 'planning'
  | 'goal'
  | 'session'
  | 'schedule'
  | 'mcp'
  | 'plugins'

/**
 * 全部类目，**顺序即界面顺序**。
 *
 * 无法从类型派生：TypeScript 的联合类型在运行时不存在，注册期校验需要一份运行时取值。
 * 两处必须同步修改，因此紧邻放置在类型定义之后。
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  'files',
  'code',
  'web',
  'browser',
  'desktop',
  'office',
  'media',
  'memory',
  'skills',
  'planning',
  'goal',
  'session',
  'schedule',
  'mcp',
  'plugins',
]

/** 权限副作用轴。注册时必填：没有默认值，未填写即注册失败。 */
export type PermissionEffect =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network'
  /**
   * 操作内置浏览器中已受控的页面。
   *
   * 单独列出而不并入 `network`：这些页面带有用户的登录态，副作用发生在网站上，
   * 与无登录态的网络请求不属于同一类操作。
   */
  | 'browser'
  /**
   * 操作本机上其他应用的窗口与控件。
   *
   * 单独列出而不并入 `execute`：`execute` 表示启动新进程，本项改变的是已运行
   * 应用的状态，边界由宿主的目标身份与系统授权裁决，不经过命令行规则。
   */
  | 'desktop'
  /** 纯内部控制（如 todo 记录），不受权限检查约束。 */
  | 'internal_control'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * `parameters` 是否由本仓库编写。默认为是：**第三方 schema 必须显式填写 `false`**。
   *
   * 适配器据此决定是否将其重排为协议要求的 strict 形状（`ToolSchema.strict`）。
   * 判据是编写来源而不是形状：第三方 schema 即使形状恰好合格，
   * 也不应改写后发送。
   */
  strict?: boolean
  /**
   * 动作语义。多动作门面从**显式参数**解析，禁止按工具名或结果文案推测。
   *
   * 第二个参数是可选的 `ctx`，但**不要以 `ctx.state` 作为判据**：它是 run 级的
   * （一条消息对应一个 run，Map 每次新建），无法查到跨轮的事实，而权限预检路径
   * 无法取得 ctx。仅凭 args 无法得出结果时，说明该动作应为常量。
   */
  actionKind: ActionKind | ((args: Record<string, unknown>, ctx?: ToolContextBase) => ActionKind)
  objectLabel: string | ((args: Record<string, unknown>) => string)
  /** 从参数提取稳定目标（通常是文件路径），供进度判定与并行冲突检测使用。 */
  targetExtractor?: (args: Record<string, unknown>) => string | null
  permissionEffect: PermissionEffect | ((args: Record<string, unknown>) => PermissionEffect)
  /**
   * 并行默认关闭。只有工具显式 opt-in **且**本次具体参数通过 parallelSafe，
   * 才可能与同批次的其他调用放入同一执行波次。
   */
  parallelSafe?: boolean | ((args: Record<string, unknown>) => boolean)
  /** 本次调用涉及的资源键，用于同一波次内的冲突检测（同一文件不能并行写入）。 */
  resourceKeys?: (args: Record<string, unknown>) => string[]
  /**
   * 能力大类。注册时必填：漏标即注册失败，不提供默认值。
   *
   * 提供默认值（例如默认 `session`）会使新增工具静默归入
   * 无关的类目，而分类表看起来仍然完整。校验放在注册期，不放在读取时。
   */
  category: ToolCategory
  /**
   * 类内的功能方向（第二层）。使用受控短语，同一类中复用同一组词，
   * 例如「文件与草稿」下为「读写」「检索」「管理」，不使用自由描述。
   */
  facet: string
  /** 一句话用途，面向用户（工具清单中的用途列）。不面向模型：面向模型的是 `description`。 */
  summary: string
  fn: ToolFn
}

export function resolveAction(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx?: ToolContextBase,
): ActionDescriptor {
  const kind = typeof spec.actionKind === 'function' ? spec.actionKind(args, ctx) : spec.actionKind
  const label = typeof spec.objectLabel === 'function' ? spec.objectLabel(args) : spec.objectLabel
  return {
    kind,
    objectLabel: label,
    target: spec.targetExtractor ? spec.targetExtractor(args) : null,
  }
}

/**
 * 权限效果**只取工具自身声明的值，不从动作轴推导**。
 *
 * 两条轴正交（见 `ToolCategory` 的注释）：动作轴描述「做了什么」，权限轴描述「有什么副作用」。
 * 以 `kind === 'delete'` 反推权限会把一条轴耦合到另一条轴上：同一个工具的权限会随
 * 参数在两条规则之间切换，而声明值反而不起作用。需要经过 delete 权限检查的工具，
 * 在 `permissionEffect` 中直接写 `delete`（门面工具写成按参数返回的函数）。
 */
export function resolvePermissionEffect(
  spec: ToolSpec,
  args: Record<string, unknown>,
): PermissionEffect {
  return typeof spec.permissionEffect === 'function'
    ? spec.permissionEffect(args)
    : spec.permissionEffect
}

export function isParallelSafe(spec: ToolSpec, args: Record<string, unknown>): boolean {
  if (spec.parallelSafe === undefined) return false
  return typeof spec.parallelSafe === 'function' ? spec.parallelSafe(args) : spec.parallelSafe
}

// ─────────────────────────────── 注册表 ───────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()
  private schemaCache: ToolSchema[] | null = null

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`[qywork] 工具重复注册，拒绝静默覆盖：${spec.name}`)
    }
    validate(spec)
    this.tools.set(spec.name, spec)
    this.schemaCache = null
  }

  /** 校验整批替换内容后一次性提交，不得覆盖不属于本批的工具。 */
  replaceOwned(owned: ReadonlySet<string>, specs: readonly ToolSpec[]): void {
    const next = new Map(this.tools)
    for (const name of owned) next.delete(name)
    for (const spec of specs) {
      if (next.has(spec.name)) throw new Error(`工具名冲突：${spec.name}`)
      validate(spec)
      next.set(spec.name, spec)
    }
    this.tools.clear()
    for (const [name, spec] of next) this.tools.set(name, spec)
    this.schemaCache = null
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name)
  }

  list(): ToolSpec[] {
    return [...this.tools.values()]
  }

  /**
   * 生成发给模型的 schema 数组，按名称排序。结果缓存至工具集变化：
   * 每轮重新排序与构建不仅浪费，还会使下游按对象身份建立的 token 缓存失效。
   */
  schemas(): ToolSchema[] {
    if (this.schemaCache) return this.schemaCache
    this.schemaCache = [...this.tools.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict !== false,
      }))
    return this.schemaCache
  }

  /** 唯一执行入口。任何路径都不得绕过此处直接调用 spec.fn。 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutcomeWire> {
    const spec = this.tools.get(name)
    if (!spec) {
      return {
        status: 'failure',
        executed: false,
        message: `未注册调用：${name}`,
        errorKind: 'unregistered_tool_call',
      }
    }

    // required 与发给模型的 schema 同源，缺参时不进入权限解析或工具执行。
    const required = spec.parameters.required
    const missing = Array.isArray(required)
      ? required.filter((key): key is string => typeof key === 'string' && args[key] === undefined)
      : []
    if (missing.length) {
      return {
        status: 'failure',
        executed: false,
        message: `工具 ${name} 缺少必填参数：${missing.join('、')}。请按工具定义传入 JSON 参数。`,
        errorKind: 'invalid_tool_arguments',
      }
    }

    const effect = resolvePermissionEffect(spec, args)
    if (effect !== 'internal_control') {
      const verdict = await ctx.requestPermission({ toolName: name, args })
      if (!verdict.allowed) {
        // executed=false 是必需的：被拒的调用没有产生任何副作用，
        // 后续的崩溃恢复与重试逻辑依赖这一事实。
        //
        // 理由须原样交给模型。`auto` 模式下这是模型能取得的唯一信号：
        // 只返回「已拒绝」时模型只能原样重试，而重试必然再次被拒。
        return {
          status: 'failure',
          executed: false,
          message: verdict.reason,
          errorKind: 'permission_denied',
        }
      }
    }

    try {
      const out = await spec.fn(args, ctx)
      return {
        status: out.status,
        executed: out.executed ?? true,
        message: out.message,
        ...(out.data ? { data: out.data } : {}),
        ...(out.presentation ? { presentation: out.presentation } : {}),
        ...(out.fileChanges ? { fileChanges: out.fileChanges } : {}),
        ...(out.resources?.length ? { resources: out.resources } : {}),
        ...(out.errorKind ? { errorKind: out.errorKind } : {}),
      }
    } catch (err) {
      /*
       * **自带 `errorKind` 的异常是判定，不是崩溃。**
       *
       * 路径越界等边界拒绝同样以 throw 表达（每个文件工具各写一遍 try/catch 即
       * B4 所述的特判堆叠），但包装为「执行出错」后，模型会将其视为偶发故障，
       * 进而重试或寻找绕行路径，例如越界被拒后改用 `run_command` 读取且不告知用户。
       * 因此这类异常原样返回：消息即判定本身，`executed: false`（未执行任何操作）。
       */
      if (err instanceof Error) {
        const declared = (err as Error & { errorKind?: unknown }).errorKind
        if (typeof declared === 'string' && declared) {
          return { status: 'failure', executed: false, message: err.message, errorKind: declared }
        }
      }
      // 真实异常不得导致整轮 run 失败：转为结构化失败交给模型，由模型决定重试或改用其他做法。
      return {
        status: 'failure',
        executed: true,
        message: `工具 ${name} 执行出错: ${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'tool_exception',
      }
    }
  }
}

/**
 * provider 对工具名的硬性约束。
 *
 * OpenAI 兼容协议的错误原文：`Invalid 'tools[0].function.name': string does not match
 * pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'`。
 * Anthropic 的限制相同。
 *
 * 必须在**注册期**拦截，不能延迟到发送请求时：id 为 `demo.lines` 的插件
 * （反向域名风格，清单文档推荐的写法）会生成工具名 `demo.lines__count`，
 * 此后**每一轮 run 都被 400 拒绝**，错误信息只指出「tools[0].function.name 无效」
 * 而不指明插件，整个会话因此无法使用。
 *
 * 在注册期抛出异常，装配方可以立即定位出问题的插件。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * 将任意标识符转换为 provider 可接受的工具名。
 *
 * 供插件与 MCP 等**名称来自第三方**的提供方使用。转换是确定性的，
 * 但不保证无冲突（`a.b` 与 `a_b` 会冲突），因此调用方必须自行查重并报告：
 * 静默覆盖会丢弃整个插件的工具。
 */
export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function validate(spec: ToolSpec): void {
  if (!spec.name.trim()) throw new Error('[qywork] 工具缺少 name')
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `[qywork] 工具名 ${spec.name} 含 provider 不接受的字符（只允许字母、数字、下划线、短横线，最长 64）`,
    )
  }
  if (!spec.description.trim()) {
    // 描述是模型判断何时调用的唯一依据，描述为空时该工具无法被正确使用。
    throw new Error(`[qywork] 工具 ${spec.name} 缺少 description`)
  }
  if (!spec.permissionEffect) {
    throw new Error(`[qywork] 工具 ${spec.name} 未声明 permissionEffect`)
  }
  // 三条轴同等处理：漏标即装配错误，立即抛出。提供默认值时新工具会静默归入
  // 无关的类目，而分类表看起来仍然完整，此类错误无法被发现。
  if (!TOOL_CATEGORIES.includes(spec.category)) {
    throw new Error(
      `[qywork] 工具 ${spec.name} 的 category 无法识别：${String(spec.category)}` +
        `（可用：${TOOL_CATEGORIES.join('、')}）`,
    )
  }
  if (!spec.facet?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 facet`)
  if (!spec.summary?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 summary`)
}
