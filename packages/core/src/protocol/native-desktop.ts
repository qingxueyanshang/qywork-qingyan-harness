/**
 * 桌面原生宿主连接的线上契约。
 *
 * 该连接只承载桌面控件的观察与动作；聊天指令与浏览器资源操作均不经由该连接
 * （后者在 `native-browser.ts`，两个 socket 的 ready 快照与断线语义各自独立）。
 *
 * 三种身份的生命周期互不相同，不能合并为一个值：
 *
 * - `hostId`：宿主进程每次启动时产生的新身份。
 * - `connectionEpoch`：宿主每次建立该 WS 连接时自增，跨重连的请求与结果据此作废。
 * - `hostEpoch`：宿主在同一 `hostId` 下每更换一个 worker 进程即自增。WS 未断开而 worker
 *   被更换时只有它变化，旧观察、旧 ref 与旧队列整体作废。
 *
 * 句柄只出现在该连接上。`DesktopWindow.handle` 是 OS 窗口句柄，服务端据此向宿主
 * 寻址，对模型只发放不透明 id。
 */

/** 宿主连接的路径。宿主据此发起协议升级，server 侧据此分派。 */
export const NATIVE_DESKTOP_PATH = '/native/desktop'

/**
 * 宿主接受的操作。新增操作时必须同时修改宿主侧的分派，宿主对无法识别的 op 一律返回
 * `not_dispatched`，不推测意图。
 *
 * 改变状态的操作只有 `act` 一个，具体动作写在 `DesktopRequestFrame.action` 中：
 * 若每种动作各占一个 op，定位、准入与动作后重读会各有一份副本。
 *
 * `cancel` 撤销的是发起它的执行者名下尚未派发的请求，目标写在帧的
 * `executorId` 上；已进入 OS 调用的请求不会被中止。
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
 * 原点是虚拟桌面原点：主显示器左上角为 `(0,0)`，位于其左侧或上方的显示器坐标为负值，
 * 因此四个数都是有符号数。控件包围盒与图像几何使用同一套坐标。
 */
export interface DesktopRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 等待的后置条件。判定在宿主一侧完成，服务端只提供条件与两个时限。
 *
 * `gone` 满足时观察中没有任何控件，范围仍指向该 `ref`：调用方据此只作废这一段引用。
 */
export type DesktopWaitUntil =
  /** 目标控件变为可用。 */
  | 'enabled'
  /** 目标控件的值变为给定值。 */
  | 'value'
  /** 目标控件从控件树中消失。 */
  | 'gone'
  /** 窗口中出现一个满足 role / nameContains 的控件。 */
  | 'appears'
  /** 出现一个标题包含给定文字的顶层窗口，且不是目标窗口本身。 */
  | 'window'

/**
 * 执行事实。只描述本次请求要求的状态改变动作是否已交给 OS。
 *
 * 只读请求与 `cancel` 不改变状态，一律为 `not_dispatched`：成功时带 `observation`，
 * 失败时带 `reason`。因此 `submitted` 只有一个含义，不会与读取成功的回执混淆。
 */
export type DesktopDispatch =
  /** 可证明没有发出动作调用：准入拒绝、控件模式缺失、只读、目标已失效。 */
  | 'not_dispatched'
  /** 动作调用已被系统接受并返回成功。不代表业务已完成。 */
  | 'submitted'
  /** 调用已发出但结果无法确认，动作可能已经生效。不得改记为未执行。 */
  | 'unknown'

/**
 * 宿主已实现的动作。
 *
 * 前十三种绑定一个 UIA 控件模式，经模式调用发出：`invoke` 是 InvokePattern，
 * `set_value` 是 ValuePattern，`set_range_value` 是 RangeValuePattern，
 * 三个 selection 是 SelectionItemPattern，`set_toggle` 是 TogglePattern，
 * `expand` / `collapse` 是 ExpandCollapsePattern，`scroll` 是 ScrollPattern，
 * `scroll_into_view` 是 ScrollItemPattern，`realize_item` 是 ItemContainerPattern 加
 * VirtualizedItemPattern，`select_text` 是 TextPattern。
 *
 * 其余动作由原始输入与窗口接口发出，只在前台操作配置启用时可用：
 * `click` / `hover` / `drag` / `wheel` 是指针事件，`type_text` / `press_key` 是键盘事件，
 * `activate` 是系统前台窗口接口，`set_window_state` / `close_window` 是 WindowPattern，
 * `move_window` / `resize_window` 是 TransformPattern。
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
  | 'click'
  | 'hover'
  | 'drag'
  | 'wheel'
  | 'type_text'
  | 'press_key'
  | 'activate'
  | 'set_window_state'
  | 'move_window'
  | 'resize_window'
  | 'close_window'

export type DesktopMouseButton = 'left' | 'right' | 'middle'

/**
 * 组合键中的修饰键。按下顺序即数组顺序，按逆序释放。
 *
 * `meta` 是 Windows 徽标键、macOS 的 Command、Linux 的 Super。
 */
export type DesktopModifier = 'ctrl' | 'alt' | 'shift' | 'meta'

/** 窗口的显示状态。 */
export type DesktopWindowState = 'normal' | 'minimized' | 'maximized'

/**
 * 一次拖拽的终点。
 *
 * 两种写法都不带图像坐标：图像坐标在服务端换算为屏幕坐标，宿主只接受屏幕像素与控件引用。
 */
export type DesktopDragTarget =
  /** 终点为另一个控件包围盒的中心。派发前重新定位该控件，读取派发时的包围盒。 */
  | { kind: 'ref'; ref: string }
  /** 相对起点的屏幕像素偏移，用于滑块与拖动排序。 */
  | { kind: 'offset'; dx: number; dy: number }

/** 复选框的目标状态。动作按目标状态表达，而不是切换一次。 */
export type DesktopToggleState = 'off' | 'on' | 'indeterminate'

export type DesktopScrollDirection = 'up' | 'down' | 'left' | 'right'
/** 一次滚动的步长。语义滚动只支持「一行」与「一页」，没有像素量。 */
export type DesktopScrollStep = 'line' | 'page'

/**
 * 一次动作的内容，参数随动作一并给出。
 *
 * 动作与参数分开给出时，缺少值的 `set_value` 也能组成一条合法请求，缺失项要到
 * provider 调用时才暴露。
 */
export type DesktopAction =
  | { kind: 'invoke' }
  /** 空串表示清空，与不提供该参数含义不同。 */
  | { kind: 'set_value'; value: string }
  /** 越界与只读一律拒绝，不钳制到边界。 */
  | { kind: 'set_range_value'; value: number }
  | { kind: 'select' }
  | { kind: 'add_to_selection' }
  | { kind: 'remove_from_selection' }
  | { kind: 'set_toggle'; state: DesktopToggleState }
  | { kind: 'expand' }
  | { kind: 'collapse' }
  | { kind: 'scroll'; direction: DesktopScrollDirection; step: DesktopScrollStep }
  | { kind: 'scroll_into_view' }
  /** 目标是容器：按名称查找一项（包括未实例化的项）并将其实例化。 */
  | { kind: 'realize_item'; name: string }
  /** 按 UTF-16 码元偏移设置选区。 */
  | { kind: 'select_text'; start: number; length: number }
  /** `count` 为 1 或 2，双击用 2 表示。 */
  | { kind: 'click'; button: DesktopMouseButton; count: number }
  | { kind: 'hover' }
  | { kind: 'drag'; to: DesktopDragTarget }
  /** `amount` 是滚动格数，一格为系统设定的行数。 */
  | { kind: 'wheel'; direction: DesktopScrollDirection; amount: number }
  | { kind: 'type_text'; text: string }
  | { kind: 'press_key'; key: string; modifiers: DesktopModifier[] }
  | { kind: 'activate' }
  | { kind: 'set_window_state'; state: DesktopWindowState }
  /** 屏幕物理像素。 */
  | { kind: 'move_window'; x: number; y: number }
  /** 屏幕物理像素。 */
  | { kind: 'resize_window'; width: number; height: number }
  /** 发送的是关闭请求，而不是强制结束进程。 */
  | { kind: 'close_window' }

/**
 * 动作的投递方式。
 *
 * `background` 经控件模式发出，不切换前台、不移动指针、不设置焦点。
 * `foreground` 经原始输入或前台窗口接口发出，会改变前台窗口或真实输入状态。
 * 前台操作配置关闭时，这些动作不在动作表中；配置缺省值由服务端决定。
 *
 * 后台失败不会自动升级为前台。两种投递方式各自是否可用由控件与模式决定，
 * 宿主不代替调用方换用另一种方式重试。
 */
export type DesktopDelivery = 'background' | 'foreground'

/**
 * 控件上的一个动作，以及它当前能否执行。
 *
 * `delivery` 为空表示当前无法执行，原因在 `unavailable` 中（如 `read_only`、`leaf_node`、
 * `not_scrollable`）。模式缺失的动作不列入该表：列出全部十几个动作会掩盖
 * 当前可执行的动作。
 */
export interface DesktopNodeAction {
  action: DesktopActionKind
  delivery: DesktopDelivery[]
  unavailable?: string
}

/**
 * RangeValuePattern 读取的数值区间。动作前的越界判定以此为依据。
 *
 * 两个步长字段可能缺席：provider 对没有步长的控件无法给出有限数值。整个区间缺席表示
 * 值与边界都无法读取为有限数值，此时越界判定只能交给宿主。
 */
export interface DesktopRangeState {
  value: number
  min: number
  max: number
  smallChange?: number
  largeChange?: number
}

/**
 * SelectionPattern 读取的容器约束与当前选中项。
 *
 * `selected` 是当前选中项的名称，没有选中项时缺席；`truncated` 为真表示列表不完整，
 * 需要读取容器中的项才能获得全部。收起的组合框在控件表中没有子控件，其选中项只能从此处读取。
 */
export interface DesktopSelectionState {
  multiple: boolean
  required: boolean
  selected?: string[]
  truncated?: boolean
}

/**
 * ScrollPattern 读取的滚动位置，单位为百分比。
 *
 * 某个方向无法滚动时，对应字段缺席。缺席不等于 0：0 表示位于顶端。
 */
export interface DesktopScrollState {
  horizontal?: number
  vertical?: number
}

/**
 * 一个顶层窗口。
 *
 * `handle` 与 `pid` 都会被 OS 复用，单独使用不能作为长期身份：三项组合才能判定
 * 是否仍是之前的同一个窗口。`processStartedAt` 由宿主填写，worker 只能给出句柄与 pid。
 */
export interface DesktopWindow {
  /** OS 窗口句柄。只在服务端与宿主之间传递。 */
  handle: number
  pid: number
  /** 进程启动时刻，Unix 纪元毫秒。 */
  processStartedAt: number
  /** 可执行文件的显示名，即界面上显示的当前操作的应用。 */
  app: string
  title: string
}

/**
 * 动作调用尚未返回时一并带回的顶层窗口。
 *
 * 身份三项与 `DesktopWindow` 完全相同：服务端按同一路径登记不透明 id，不另建一套。
 */
export interface DesktopBlockingWindow extends DesktopWindow {
  /** 动作调用之前该窗口不存在。模态对话框即以这种方式出现。 */
  appeared: boolean
}

/**
 * 一次操作的目标窗口身份。
 *
 * 三项一并给出，宿主在派发前重新核对：只给句柄时，若目标窗口在观察与动作之间关闭、
 * 句柄被另一个窗口复用，动作会作用于那个窗口且不报错。
 */
export interface DesktopTarget {
  window: number
  pid: number
  processStartedAt: number
}

/**
 * 观察的完整性。
 *
 * 截断与范围是两个概念，分两个字段记录。`truncatedBy` 表示遍历被上限截断，`filteredBy`
 * 表示读取范围与字段选择（子树根、不取值、不取状态）。调用方不能把未采集到的内容理解为
 * 不存在，也不能把读取范围之外的内容理解为不存在。
 */
export interface DesktopCompleteness {
  complete: boolean
  truncatedBy: string[]
  filteredBy: string[]
  /** 遍历过的控件数。三个上限限制的是该数值，而不是返回的条数。 */
  visited: number
}

/**
 * 控件表中的一个控件。
 *
 * `ref` 是不透明引用，只在产生它的那一次观察内有效；动作请求原样带回，宿主据此
 * 重新定位控件。
 *
 * 层级关系保留在展平的表中：`parentRef` 指向同一份表中的父控件，`depth` 是相对本次读取范围的
 * 层数。本次范围的根没有父控件，`parentRef` 缺席。
 */
export interface DesktopNode {
  ref: string
  parentRef?: string
  depth: number
  role: string
  name: string
  automationId: string
  /** ValuePattern 的值；没有 ValuePattern 而有 TextPattern 的控件（终端、控制台正文）为当前可见的文字。 */
  value?: string
  enabled: boolean
  offscreen: boolean
  /**
   * 该控件当前持有键盘焦点。
   *
   * 文字与按键输入发往焦点所在位置，因此键盘动作只列在该控件上。前台接管关闭时
   * 该字段一律缺席：此时它不在采集端的读取范围内。
   */
  focused?: boolean
  /**
   * 控件的包围盒，与图像几何使用同一套坐标。
   *
   * provider 不提供包围盒的控件缺席该字段。缺席不等于控件不存在，也不等于控件在屏幕外：
   * 后者由 `offscreen` 表示。
   */
  rect?: DesktopRect
  actions: DesktopNodeAction[]
  /** RangeValuePattern 的数值区间。没有该模式时缺席。 */
  range?: DesktopRangeState
  /** TogglePattern 的当前状态。 */
  toggle?: DesktopToggleState
  /** ExpandCollapsePattern 的当前状态。 */
  expand?: 'collapsed' | 'expanded' | 'partial' | 'leaf' | 'unknown'
  /** SelectionItemPattern 的当前状态。 */
  selected?: boolean
  /** SelectionPattern 读取的容器约束与当前选中项。仅选择容器有该字段。 */
  selection?: DesktopSelectionState
  /** ScrollPattern 的滚动位置。滚动后重读时据此核对。 */
  scroll?: DesktopScrollState
  /** 该控件有 TextPattern，可以读取文档文本与选区。 */
  text?: boolean
  /**
   * 该控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对。
   *
   * 三项均不变而控件已被替换时无法识别，界面重排后该引用不可靠。缺席表示身份正常。
   */
  weakIdentity?: boolean
}

/** 一段选区。`start` 是其在文档中的起点，按 UTF-16 码元计。 */
export interface DesktopTextSelection {
  start: number
  text: string
  truncated: boolean
}

/**
 * 一次文本读取的全部内容。
 *
 * `truncated` 为真表示后面还有内容，而不是文档已结束。
 */
export interface DesktopTextBody {
  window: number
  capturedAt: number
  /** 读取的控件。 */
  scope: string
  text: string
  truncated: boolean
  /** 该控件支持的选区类型。`none` 时设置选区的动作会被拒绝。 */
  selectionSupport: 'none' | 'single' | 'multiple'
  selection: DesktopTextSelection[]
}

/**
 * 一次控件读取的全部内容。`tree` 与 `wait` 两种观察共用该结构。
 *
 * `scope` 是本次读取覆盖的范围：给出 ref 时只读取该子树（该控件即表中第一项），缺席时
 * 读取整个窗口。节点是该范围内遍历到的全部节点，不按角色或文字筛选。
 *
 * `windowEnabled` 为假表示目标窗口当前被模态窗口阻挡。`windowCovered` 为真表示该窗口当前在屏幕上
 * 完全不可见（最小化，或被上层窗口完全遮挡）：浏览器对载入后尚未显示过的页面不提供网页内容，
 * 此时控件表只有外框，且不计为截断。
 */
export interface DesktopTreeBody {
  window: number
  capturedAt: number
  scope?: string
  windowEnabled: boolean
  windowCovered: boolean
  completeness: DesktopCompleteness
  nodeCount: number
  nodes: DesktopNode[]
}

/**
 * 交给模型的图像所绑定的几何。
 *
 * `imageWidth` / `imageHeight` 是模型实际看到的像素数，即采集端缩放后的尺寸；
 * `screen` 是该图像覆盖的屏幕物理像素矩形。两者之比即换算比例，调用方不要另用 `dpi`
 * 计算：`dpi` 是窗口所在显示器的缩放读数（96 = 100%），只用于说明图像是在哪一档
 * 缩放下采集的。
 *
 * `generation` 是窗口矩形与显示器的代际：窗口移动、缩放、更换显示器或 DPI 变化后该值
 * 即不同，按图定位的请求在派发前据此被拒绝。
 *
 * 来源为 `portal_screen_cast` 时没有屏幕坐标：Wayland 不向客户端提供全局坐标，`screen` 是该流
 * 自身的逻辑坐标，原点为窗口左上角。按图定位的落点按同一换算交给 worker，只对该窗口有效。
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
  /** Windows Graphics Capture。按窗口采集，窗口被遮挡时也能采集到其自身内容。 */
  | 'wgc'
  /**
   * `PrintWindow`。后备方式，依赖目标应用响应 `WM_PRINT`。
   *
   * 未能渲染的部分在图像上为黑色，调用方据此判断该图像能否作为依据。
   */
  | 'print_window'
  /** X11 的 Composite 扩展。按窗口采集，窗口被遮挡或部分位于屏幕外时也能采集到其自身内容。 */
  | 'x11_composite'
  /** macOS 的 ScreenCaptureKit，按窗口采集，窗口被遮挡时也能采集到其自身内容。需要 macOS 14 及以上。 */
  | 'screencapturekit'
  /**
   * xdg-desktop-portal 的 ScreenCast，按窗口共享。用于 Wayland 会话中的原生 Wayland 窗口，用户在
   * 系统授权框中共享后才能采集；几何见 `DesktopImageGeometry`。
   */
  | 'portal_screen_cast'

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
 * 只有以下五种观察会到达服务端：宿主与 worker 之间的握手、取消登记与连接绑定回执止于宿主，
 * 服务端不处理这几种。
 */
export type DesktopObservation =
  | { kind: 'windows'; capturedAt: number; windows: DesktopWindow[] }
  | ({ kind: 'tree' } & DesktopTreeBody)
  /** 一次等待的结果：是否等到目标条件，以及返回时读取到的状态。 */
  | ({ kind: 'wait'; found: boolean; reason?: string } & DesktopTreeBody)
  | ({ kind: 'image' } & DesktopImageBody)
  | ({ kind: 'text' } & DesktopTextBody)

/**
 * 图像坐标 → 屏幕物理坐标。
 *
 * 按像素中心换算：图像像素 `(x, y)` 覆盖屏幕上的一小块区域，取其中心所在的屏幕像素。
 * 缩放后一个图像像素对应多个屏幕像素，误差上界为缩放比的一半。
 *
 * 这是图像坐标换算的唯一实现，采集端只产出几何，不做换算。
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
 * 不在该图像覆盖范围内时返回 `null`，不钳制到边界：钳制得到的坐标看似合法，
 * 但指向的并不是调用方要求的位置。
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
 * 按边换算而不是按像素中心换算：矩形需要的是覆盖范围，两条边各自取所在的屏幕位置。
 * 与该图像没有交集时返回 `null`，宽高至少为 1。
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
 * 宿主注册帧。连接建立后宿主首先发送该帧，服务端据此接受连接。
 *
 * 同一连接上可以再次发送：worker 被更换时宿主以新的 `hostEpoch` 重发一次，服务端据此
 * 作废旧执行实例名下的全部状态。`connectionEpoch` 由宿主在每次连接时自增。
 *
 * 该链路不设手写的协议版本。不要为该帧添加 `protocol` 字段供服务端比对：该值
 * 只在有人记得同步修改时才成立，不一致即拒绝整个连接，电脑控制的全部工具都不会注册。服务端、
 * 宿主外壳与 worker 三端出自同一次构建：开发环境中三者位于同一棵源码树，`build.rs` 在编译外壳的
 * 同一次构建中编译 worker；发行版中三者在同一次打包中产出。链路上不存在可独立升级的一端。
 *
 * 重新引入版本比对的前提是出现这样一端，届时比对的应是构建产出的标识。
 */
export interface DesktopHostReadyFrame {
  type: 'host.ready'
  hostId: string
  hostEpoch: number
  connectionEpoch: number
  platform: string
  /** worker 进程已握手就绪。 */
  workerReady: boolean
  /** 操作系统已授予读取与动作所需的权限。由 worker 报告，worker 未就绪时为 `false`。 */
  authorized: boolean
  /** 操作系统未满足的前提。`authorized` 为真时也可能非空，worker 未就绪时为空。 */
  missing: DesktopGrant[]
}

/**
 * 电脑控制需要操作系统满足的一项前提，每一项只由一个平台报告。
 *
 * - `accessibility`：macOS 辅助功能授权。缺少时读取与动作一律不可用。
 * - `screen_recording`：macOS 屏幕录制授权。只影响图像采集，`authorized` 不依据它。
 * - `accessibility_bus`：Linux 会话中的无障碍总线。缺少时读取与动作一律不可用。
 */
export type DesktopGrant = 'accessibility' | 'screen_recording' | 'accessibility_bus'

/**
 * 一次桌面操作。
 *
 * `deadline` 是绝对毫秒时刻：请求在队列中等待的时间要计入预算；若写成相对毫秒，
 * 排在一次长时间调用之后的请求会带着已耗尽的预算被派发。
 *
 * 身份四项（`hostId` / `hostEpoch` / `connectionEpoch` / `executorId`）每条请求都携带：
 * 前三项是宿主与 worker 的准入依据，`executorId` 是排队与撤销的归属。
 */
export interface DesktopRequestFrame {
  type: 'desktop.request'
  requestId: string
  /**
   * 动作身份，仅 `act` 携带。
   *
   * 与 `requestId` 分开：回执丢失后重新观察确认时，调用方需要能指明是哪一次动作，
   * 而重试会产生新的 `requestId`。
   */
  actionId?: string
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  executorId: string
  deadline: number
  /**
   * 用户是否启用了前台接管。
   *
   * 每条请求都携带，宿主与 worker 都不缓存：若缓存一份，用户在运行中关闭前台接管后，
   * 要等宿主更换代际才生效。前台动作的准入判定只依据该字段。
   */
  foreground: boolean
  op: DesktopOp
  /** 目标窗口身份。`list_windows` 与 `cancel` 不携带。 */
  target?: DesktopTarget
  /**
   * 目标控件引用，取自同一次观察。
   *
   * `act` 的目标有三种写法：`ref`、`point`、两者都不提供。第三种仅键盘输入
   * （`type_text` / `press_key`）可用，此时目标是窗口本身：键盘输入发往系统焦点
   * 所在位置，自绘界面无法给出持有焦点的控件。其余动作两者都不提供时拒绝。
   */
  ref?: string
  /**
   * 指针动作在屏幕物理像素上的落点，与 `ref` 互斥。
   *
   * 由服务端从图像坐标换算得到，因此必须与 `expectGeneration` 一同给出：窗口在采集图像与派发
   * 之间移动过时，该坐标指向的已不是同一块界面。
   */
  point?: { x: number; y: number }
  /** `act` 要执行的动作。参数随动作一并给出。 */
  action?: DesktopAction
  /** `read_text` 返回的 UTF-16 码元数上限。超出即截断并标记。 */
  maxChars?: number
  /** `wait` 的 `until=value` 要等待的值。空串表示清空，与缺席含义不同。 */
  value?: string
  maxNodes?: number
  maxDepth?: number
  timeBudgetMs?: number
  /**
   * 读取范围的根：`read_tree` 只读取该 ref 下的子树，`act` 与 `wait` 结束时据此完整
   * 重读。缺席表示整个窗口。
   */
  root?: string
  /** `wait` 的 `until=appears` 要等待出现的控件角色。 */
  role?: string
  /** `wait` 的 `until=appears` 要等待出现的控件文字：名称、稳定标识或值包含该文字即可，不区分大小写。 */
  nameContains?: string
  /** 是否读取控件当前值。缺席时读取。 */
  includeValue?: boolean
  /** 是否读取控件模式的状态细节。缺席时读取；为假时可用动作表不受影响。 */
  includeState?: boolean
  /** `wait` 的后置条件。 */
  until?: DesktopWaitUntil
  /** `wait` 的 `until=window` 要等待的标题子串。 */
  name?: string
  /** `wait` 两次判定之间的最小间隔。 */
  pollMs?: number
  /** `wait` 的最长等待时间。`deadline` 是硬上界，宿主取先到者。 */
  timeoutMs?: number
  /** `capture_image` 要采集的屏幕物理像素矩形。缺席表示整个窗口。 */
  region?: DesktopRect
  /**
   * 要求窗口几何代际仍为该值。
   *
   * 按上一张图像的区域重新采集、或按图像上的坐标操作时必须携带：窗口在采集图像与派发之间
   * 移动过时，该矩形或坐标指向的已不是同一块界面。宿主在派发前核对，不一致即拒绝。
   */
  expectGeneration?: string
  /**
   * `capture_image` 交给模型的图像长边上限。
   *
   * 采集端据此缩放图像，因此几何在采集端即确定。上限由调用方提供，采集端不自带默认值：
   * 两处各有一个默认值时，几何记录的尺寸与模型看到的尺寸会不一致。
   */
  maxEdge?: number
  /** `capture_image` 编码后的字节上限。超过即拒绝，不将超限的帧写入宿主连接。 */
  maxBytes?: number
}

/**
 * 操作结果。
 *
 * `dispatch` 是执行事实，`observation` 是动作之后重读得到的状态，两者分开记录：重读失败时
 * `observationError` 单独成立，`dispatch` 保持原值，不得改记为未执行。
 * 请求的动作未派发时，窗口准备过程仍可能改变界面；带回新观察时替换旧观察，重读失败时作废旧观察。
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
   * 动作调用尚未返回时目标进程当前的顶层窗口。
   *
   * 只在 `observationError` 为 `target_blocked` 时出现：此时目标应用的 UI 线程仍阻塞在
   * 本次调用中，对目标窗口的任何读取都会等待至超时，因此不重读。调用方据此决定下一步
   * 观察哪个窗口。
   */
  blocking?: DesktopBlockingWindow[]
}

/**
 * 宿主主动推送的状态变化。
 *
 * 只有 worker 就绪与系统授权两项：它们在同一个执行实例内会变化（用户授权、worker 退出），
 * 而更换执行实例通过重发 `host.ready` 表达。
 */
export interface DesktopEventFrame {
  type: 'desktop.event'
  connectionEpoch: number
  hostId: string
  hostEpoch: number
  kind: 'worker.state'
  workerReady: boolean
  authorized: boolean
  missing: DesktopGrant[]
}

/** 宿主发往服务端的帧。 */
export type NativeDesktopUpFrame = DesktopHostReadyFrame | DesktopResultFrame | DesktopEventFrame
