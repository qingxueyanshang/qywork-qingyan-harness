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
export const DESKTOP_PROTOCOL_VERSION = 4

/**
 * 宿主接受的操作。**新增一个就要同时改宿主侧的分派**，宿主对认不出的 op 一律回
 * `not_dispatched`，不猜测意图。
 *
 * 改变状态的动作只有 `act` 一条，要执行什么写在 `DesktopRequestFrame.action` 里：
 * 每种动作各占一个 op 的话，定位、准入与动作后重读会各有一份拷贝。
 *
 * `cancel` 撤销的是**发起它的那个执行者名下尚未派发的请求**，目标写在帧的
 * `executorId` 上；已经进入 OS 调用的请求不会被它中止。
 */
const DESKTOP_OPS = [
  'list_windows',
  'read_tree',
  'act',
  'read_text',
  'wait',
  'capture_image',
  'cancel',
] as const
export type DesktopOp = (typeof DESKTOP_OPS)[number]

/**
 * 屏幕物理像素矩形。
 *
 * 原点是虚拟桌面原点：主显示器左上角为 `(0,0)`，它左侧或上方的显示器给出负坐标，
 * 因此四个数都是有符号的。控件包围盒与图像几何用同一套坐标。
 */
export interface DesktopRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 等待的后置条件。判定在宿主那一侧做，服务端只给条件与两个时限。
 *
 * `gone` 满足时观察里一个控件都没有，范围仍指着那个 `ref`——调用方据此只作废这一段引用。
 */
export type DesktopWaitUntil =
  /** 目标控件变成可用。 */
  | 'enabled'
  /** 目标控件的值变成给定的那一个。 */
  | 'value'
  /** 目标控件从树上消失。 */
  | 'gone'
  /** 窗口里出现一个满足 role / nameContains 的控件。 */
  | 'appears'
  /** 出现一个标题包含给定文字的顶层窗口，且不是目标窗口自己。 */
  | 'window'

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

/**
 * 宿主实现了的动作。
 *
 * 每一种绑定一个 UIA 控件模式：`invoke` 是 InvokePattern，`set_value` 是 ValuePattern，
 * `set_range_value` 是 RangeValuePattern，三个 selection 是 SelectionItemPattern，
 * `set_toggle` 是 TogglePattern，`expand` / `collapse` 是 ExpandCollapsePattern，
 * `scroll` 是 ScrollPattern，`scroll_into_view` 是 ScrollItemPattern，
 * `realize_item` 是 ItemContainerPattern 加 VirtualizedItemPattern，
 * `select_text` 是 TextPattern。
 */
export type DesktopActionKind =
  | 'invoke'
  | 'set_value'
  | 'set_range_value'
  | 'select'
  | 'add_to_selection'
  | 'remove_from_selection'
  | 'set_toggle'
  | 'expand'
  | 'collapse'
  | 'scroll'
  | 'scroll_into_view'
  | 'realize_item'
  | 'select_text'

/** 复选的目标态。动作按目标态表达，不是「切一次」。 */
export type DesktopToggleState = 'off' | 'on' | 'indeterminate'

export type DesktopScrollDirection = 'up' | 'down' | 'left' | 'right'
/** 一次滚动的步长。语义滚动只认「一行」与「一页」，没有像素量。 */
export type DesktopScrollStep = 'line' | 'page'

/**
 * 一次动作要执行什么，参数跟着动作走。
 *
 * 动作与参数分两处给的话，`set_value` 少了值也能拼成一条合法请求，缺的那一项要到
 * provider 调用那一刻才暴露。
 */
export type DesktopAction =
  | { kind: 'invoke' }
  /** 空串是清空，与不给这个参数不是一回事。 */
  | { kind: 'set_value'; value: string }
  /** 越界与只读一律拒绝，不夹到边界上。 */
  | { kind: 'set_range_value'; value: number }
  | { kind: 'select' }
  | { kind: 'add_to_selection' }
  | { kind: 'remove_from_selection' }
  | { kind: 'set_toggle'; state: DesktopToggleState }
  | { kind: 'expand' }
  | { kind: 'collapse' }
  | { kind: 'scroll'; direction: DesktopScrollDirection; step: DesktopScrollStep }
  | { kind: 'scroll_into_view' }
  /** 目标是容器：按名称找一项（未实例化的也找得到）并实例化它。 */
  | { kind: 'realize_item'; name: string }
  /** 按 UTF-16 码元的偏移设选区。 */
  | { kind: 'select_text'; start: number; length: number }

/**
 * 动作的投递方式。
 *
 * 后台语义动作经控件模式发出，不置前台、不动指针、不设焦点。**前台原始输入尚未实现**，
 * 因此这个联合此刻只有一个成员；`delivery` 是数组而不是布尔，正是为了它落地时不必改形状。
 */
export type DesktopDelivery = 'background'

/**
 * 控件上的一个动作，连同它此刻能不能执行。
 *
 * `delivery` 为空表示此刻执行不了，原因在 `unavailable`（`read_only`、`leaf_node`、
 * `not_scrollable` 之类）。**模式缺失的动作不在这张表里**：列全十几个动作会把
 * 「这里能做什么」盖住。
 */
export interface DesktopNodeAction {
  action: DesktopActionKind
  delivery: DesktopDelivery[]
  unavailable?: string
}

/**
 * RangeValuePattern 读到的数值区间。动作前的越界判定按它做。
 *
 * 步长两格可能缺席：provider 对没有步长的控件给不出有限数。整份区间缺席表示
 * 连值与边界都读不出有限数，那时越界判定只能交给宿主。
 */
export interface DesktopRangeState {
  value: number
  min: number
  max: number
  smallChange?: number
  largeChange?: number
}

/** SelectionPattern 读到的容器约束。 */
export interface DesktopSelectionState {
  multiple: boolean
  required: boolean
}

/**
 * ScrollPattern 读到的滚动位置，百分比。
 *
 * 某个轴滚不动时那一格缺席。**缺席不等于 0**：0 是「在顶端」。
 */
export interface DesktopScrollState {
  horizontal?: number
  vertical?: number
}

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
 * 动作调用尚未返回时同次带回的一个顶层窗口。
 *
 * 身份三项与 `DesktopWindow` 完全相同：服务端按同一条路径登记不透明 id，不另造一套。
 */
export interface DesktopBlockingWindow extends DesktopWindow {
  /** 动作调用之前这个窗口不存在。模态对话框就是这样冒出来的。 */
  appeared: boolean
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

/**
 * 观察的完整性。
 *
 * **截断与筛选是两件事，分两格记。** `truncatedBy` 说的是上限截断了遍历，`filteredBy`
 * 说的是哪些条件把遍历过的控件挡在了结果外面。调用方不能把「没采到」读成「没有」，
 * 也不能把「被筛掉」读成「不存在」。
 */
export interface DesktopCompleteness {
  complete: boolean
  truncatedBy: string[]
  filteredBy: string[]
  /** 遍历过的控件数。三个上限限的是它，不是返回的条数。 */
  visited: number
}

/**
 * 控件表里的一个控件。
 *
 * `ref` 是不透明引用，只在产生它的那一次观察内有效；动作请求原样带回，宿主按它
 * 重新定位控件。
 *
 * 层级留在展平表上：`parentRef` 指向同一份表里的父控件，`depth` 是相对本次读取范围的
 * 层数。本次范围的根没有父控件，`parentRef` 缺席。
 */
export interface DesktopNode {
  ref: string
  parentRef?: string
  depth: number
  role: string
  name: string
  automationId: string
  value?: string
  enabled: boolean
  offscreen: boolean
  /**
   * 控件的包围盒，与图像几何同一套坐标。
   *
   * provider 不给包围盒的控件缺席。**缺席不等于控件不存在**，也不等于它在屏幕外——
   * 后者由 `offscreen` 说。
   */
  rect?: DesktopRect
  actions: DesktopNodeAction[]
  /** RangeValuePattern 的数值区间。没有这个模式时缺席。 */
  range?: DesktopRangeState
  /** TogglePattern 的现态。 */
  toggle?: DesktopToggleState
  /** ExpandCollapsePattern 的现态。 */
  expand?: 'collapsed' | 'expanded' | 'partial' | 'leaf' | 'unknown'
  /** SelectionItemPattern 的现态。 */
  selected?: boolean
  /** SelectionPattern 读到的容器约束。只有选择容器有。 */
  selection?: DesktopSelectionState
  /** ScrollPattern 的滚动位置。滚动后重读按它核对。 */
  scroll?: DesktopScrollState
  /** 这个控件有 TextPattern，可以读文档文本与选区。 */
  text?: boolean
  /**
   * 这个控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对。
   *
   * 三项都不变而控件被换掉时核不出来，界面重排之后这个引用不可靠。缺席表示身份正常。
   */
  weakIdentity?: boolean
}

/** 一段选区。`start` 是它在文档里的起点，按 UTF-16 码元计。 */
export interface DesktopTextSelection {
  start: number
  text: string
  truncated: boolean
}

/**
 * 一次文本读取的全部内容。
 *
 * `truncated` 为真表示后面还有内容，不是文档到此为止。
 */
export interface DesktopTextBody {
  window: number
  capturedAt: number
  /** 读的是哪个控件。 */
  scope: string
  text: string
  truncated: boolean
  /** 这个控件支持哪种选区。`none` 时设选区的动作会被拒。 */
  selectionSupport: 'none' | 'single' | 'multiple'
  selection: DesktopTextSelection[]
}

/**
 * 一次控件读取的全部内容。`tree` 与 `wait` 两种观察共用它。
 *
 * `scope` 是本次读取覆盖的范围：给出 ref 时只读了那棵子树，缺席时读的是整窗。
 * **调用方按它决定作废哪一段引用**——缺席时整份旧观察作废，给出 ref 时只有那一段子树
 * 作废，无关区域的旧引用仍然成立。
 *
 * `windowEnabled` 为假表示目标窗口此刻被模态窗口挡着。
 */
export interface DesktopTreeBody {
  window: number
  capturedAt: number
  scope?: string
  windowEnabled: boolean
  completeness: DesktopCompleteness
  nodeCount: number
  nodes: DesktopNode[]
}

/**
 * 一张交给模型的图绑定的几何。
 *
 * **`imageWidth` / `imageHeight` 是模型实际看到的像素数**，采集端缩放之后的那一个；
 * `screen` 是这张图覆盖的屏幕物理像素矩形。两者的商就是换算比例，调用方不要另取 `dpi`
 * 去算——`dpi` 是窗口所在显示器的缩放读数（96 = 100%），只用来说明这张图是在哪一档
 * 缩放下采的。
 *
 * `generation` 是窗口矩形与显示器的代际：窗口移动、缩放、换显示器或 DPI 变化之后它就
 * 不同，按图定位的请求在派发前据此被拒。
 */
export interface DesktopImageGeometry {
  imageWidth: number
  imageHeight: number
  screen: DesktopRect
  dpi: number
  generation: string
}

/** 图像采集的方式。 */
export type DesktopImageSource =
  /** Windows Graphics Capture。按窗口采，窗口被遮挡也采得到它自己的内容。 */
  | 'wgc'
  /**
   * `PrintWindow`。退路，依赖目标应用响应 `WM_PRINT`。
   *
   * 画不全的部分在图上是黑的，调用方据此判断这张图能不能当依据。
   */
  | 'print_window'

/** 一次图像采集的结果。 */
export interface DesktopImageBody {
  window: number
  capturedAt: number
  source: DesktopImageSource
  geometry: DesktopImageGeometry
  mime: string
  /** base64 编码的图像字节。 */
  bytes: string
}

/**
 * 一次观察。
 *
 * 只有这四种进得了服务端：宿主与 worker 之间的握手、取消登记与连接绑定回执止于宿主，
 * 服务端不认那几种。
 */
export type DesktopObservation =
  | { kind: 'windows'; capturedAt: number; windows: DesktopWindow[] }
  | ({ kind: 'tree' } & DesktopTreeBody)
  /** 一次等待的结果：有没有等到，加上返回那一刻读到的状态。 */
  | ({ kind: 'wait'; found: boolean; reason?: string } & DesktopTreeBody)
  | ({ kind: 'image' } & DesktopImageBody)
  | ({ kind: 'text' } & DesktopTextBody)

/**
 * 图像坐标 → 屏幕物理坐标。
 *
 * 换算按像素中心走：图像像素 `(x, y)` 覆盖屏幕上的一小块，取它中心落在的那个屏幕像素。
 * 缩图之后一个图像像素对应多个屏幕像素，误差上界是缩放比的一半。
 *
 * **这是图像坐标换算的唯一实现**，采集端只产出几何、不做换算。
 */
export function imagePointToScreen(
  geometry: DesktopImageGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  const { imageWidth, imageHeight, screen } = geometry
  return {
    x: screen.x + Math.round(((x + 0.5) * screen.width) / imageWidth - 0.5),
    y: screen.y + Math.round(((y + 0.5) * screen.height) / imageHeight - 0.5),
  }
}

/**
 * 屏幕物理坐标 → 图像坐标。
 *
 * **不在这张图覆盖的范围里时返回 `null`**，不夹到边上：夹出来的坐标看着合法，
 * 而它指的不是调用方要的那个位置。
 */
export function screenPointToImage(
  geometry: DesktopImageGeometry,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const { imageWidth, imageHeight, screen } = geometry
  if (
    x < screen.x ||
    y < screen.y ||
    x >= screen.x + screen.width ||
    y >= screen.y + screen.height
  ) {
    return null
  }
  return {
    x: Math.min(imageWidth - 1, Math.floor(((x - screen.x) * imageWidth) / screen.width)),
    y: Math.min(imageHeight - 1, Math.floor(((y - screen.y) * imageHeight) / screen.height)),
  }
}

/**
 * 图像矩形 → 屏幕物理矩形。
 *
 * 按边换算而不是按像素中心：矩形要的是覆盖范围，两条边各自取所在的屏幕位置。
 * 与这张图**没有交集**时返回 `null`，宽高至少为 1。
 */
export function imageRectToScreen(
  geometry: DesktopImageGeometry,
  rect: DesktopRect,
): DesktopRect | null {
  const { imageWidth, imageHeight, screen } = geometry
  const left = Math.max(0, Math.min(imageWidth, rect.x))
  const top = Math.max(0, Math.min(imageHeight, rect.y))
  const right = Math.max(left, Math.min(imageWidth, rect.x + rect.width))
  const bottom = Math.max(top, Math.min(imageHeight, rect.y + rect.height))
  if (right <= left || bottom <= top) return null
  const x = screen.x + Math.round((left * screen.width) / imageWidth)
  const y = screen.y + Math.round((top * screen.height) / imageHeight)
  return {
    x,
    y,
    width: Math.max(1, screen.x + Math.round((right * screen.width) / imageWidth) - x),
    height: Math.max(1, screen.y + Math.round((bottom * screen.height) / imageHeight) - y),
  }
}

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
  /**
   * 协议版本。`workerReady` 为真时是宿主从 worker 的握手回执里读回的那一个，为假时是
   * 宿主要求的那一个。宿主在 worker 报出不同版本时不发布就绪，因此这一格与
   * `workerReady` 一起看才完整。
   */
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
   * 动作身份。只有 `act` 带它。
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
  /** `act` 要执行的动作。参数跟着动作走。 */
  action?: DesktopAction
  /** `read_text` 要回多少个 UTF-16 码元。超出即截断并标记。 */
  maxChars?: number
  /** `wait` 的 `until=value` 要等到的值。空串是清空，与缺席不是一回事。 */
  value?: string
  maxNodes?: number
  maxDepth?: number
  timeBudgetMs?: number
  /** 只读这个 ref 底下的子树。缺席表示整窗。 */
  root?: string
  /** 只留这个角色的控件。 */
  role?: string
  /** 只留名称、稳定标识或值包含这段文字的控件，不分大小写。 */
  nameContains?: string
  /** 取不取控件当前值。缺席按取。 */
  includeValue?: boolean
  /** 取不取控件模式的状态细节。缺席按取；为假时可用动作表不受影响。 */
  includeState?: boolean
  /** `wait` 的后置条件。 */
  until?: DesktopWaitUntil
  /** `wait` 的 `until=window` 要等的标题子串。 */
  name?: string
  /** `wait` 两次判定之间至少隔多久。 */
  pollMs?: number
  /** `wait` 最多等多久。`deadline` 是硬上界，宿主取先到的那个。 */
  timeoutMs?: number
  /** `capture_image` 要采的屏幕物理像素矩形。缺席表示整窗。 */
  region?: DesktopRect
  /**
   * `capture_image` 要求窗口几何代际仍是这一个。
   *
   * 按上一张图的区域重采时必须带：窗口在两次采集之间移动过的话，那个矩形指的已经
   * 不是同一块界面。宿主在派发前核对，对不上即拒绝。
   */
  expectGeneration?: string
  /**
   * `capture_image` 交给模型的图像长边上限。
   *
   * **采集端按它缩图，几何因此在采集端就定稿。** 上限由调用方给，采集端不自带默认值：
   * 两处各有一个默认值时，几何记的尺寸与模型看到的尺寸会分叉。
   */
  maxEdge?: number
  /** `capture_image` 编码之后的字节上限。超过即拒绝，不把一帧塞进宿主连接。 */
  maxBytes?: number
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
  /**
   * 动作调用尚未返回时目标进程此刻的顶层窗口。
   *
   * 只在 `observationError` 是 `target_blocked` 那一支出现：那时目标应用的 UI 线程还卡在
   * 这次调用里，对目标窗口的任何读取都会等到超时，所以没有重读。调用方据此决定下一步
   * 观察哪个窗口。
   */
  blocking?: DesktopBlockingWindow[]
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
