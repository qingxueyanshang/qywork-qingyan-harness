/**
 * 电脑控制端口：本机桌面控件的窄接口。
 *
 * 采用端口的原因与 `SinkPort` 相同：原生宿主由桌面外壳持有，服务端经宿主连接操作它，
 * 两者在依赖图上都高于 tools。因此接口定义在此处，实现由装配方注入。
 *
 * 未注入即没有该能力。用户未启用、宿主未连接、worker 未就绪、系统未授权，
 * 任一情形下装配方都不注入，对应的工具也不注册：没有宿主时桌面工具没有降级形态。
 *
 * 句柄不离开本层。端口返回的 `windowId` 是不透明 id，与 OS 句柄的映射保留在实现方；
 * 模型取得的参数中不存在句柄。
 *
 * 每次执行使用一个端口实例。排队与撤销按执行者记录，`release` 由装配方在本轮结束时调用，
 * 撤销该执行者名下尚未派发的请求；已交给 OS 的动作不回滚。
 */

import type {
  DesktopAction,
  DesktopDispatch,
  DesktopImageGeometry,
  DesktopImageSource,
  DesktopNodeAction,
  DesktopRangeState,
  DesktopRect,
  DesktopScrollState,
  DesktopSelectionState,
  DesktopTextSelection,
  DesktopToggleState,
  DesktopWaitUntil,
} from '@qywork/core'

/**
 * 一个可操作的顶层窗口。
 *
 * `windowId` 只能来自 `windows()`：它绑定窗口句柄、进程与进程启动时刻，
 * 三者任一变化即失效，调用方遇到失效 id 时需重新发现窗口。
 */
export interface DesktopWindowInfo {
  windowId: string
  /** 应用名，取自可执行文件。 */
  app: string
  title: string
}

/**
 * 一次观察中的一个控件。
 *
 * `ref` 是本窗口内按控件身份分配的短编号：同一控件在之后的观察中编号不变，已发放的编号
 * 不再分配给其他身份。动作只接受本执行者对该窗口最近一次观察中的编号；更换 worker 或
 * 宿主重连后一律作废。`actions` 只列出宿主实际能执行的动作，不是控件声明支持的全部模式：
 * 按它发送请求才不会遇到未实现的动作。
 *
 * `parentRef` 指向同一张表中的父控件，`depth` 是相对本次观察范围的层数。同名控件通过
 * 祖先路径区分，路径由调用方沿 `parentRef` 向上追溯得到。
 */
export interface DesktopElement {
  ref: string
  /** 父控件的 `ref`。本次观察范围的根没有父控件。 */
  parentRef?: string
  /**
   * 该项是窗口元素本身，即整窗读取的第一项。缺省表示不是。
   *
   * 子树读取的根同样 `depth` 为 0、没有 `parentRef`，不能按这两个字段判定。
   */
  windowRoot?: boolean
  depth: number
  role: string
  name: string
  /** 应用为控件设定的稳定标识。可能是空串，此时只能按 role 与 name 定位。 */
  automationId: string
  /** ValuePattern 的值；没有 ValuePattern 而有 TextPattern 的控件（终端、控制台正文）为当前可见的文字。 */
  value?: string
  enabled: boolean
  /** 不在可视区内。不等于不可操作：语义动作不要求控件可见。 */
  offscreen: boolean
  /**
   * 该控件当前持有键盘焦点。
   *
   * 文字与按键发送到焦点所在位置，因此键盘动作只列在该控件上。前台接管关闭时
   * 该字段一律缺省。
   */
  focused?: boolean
  /**
   * 控件的包围盒，单位为屏幕物理像素，与图像几何使用同一坐标系。
   *
   * 据此可将控件树中的控件与图像中的位置对应。provider 不提供包围盒的控件缺省该字段：
   * 缺省不表示控件不存在，也不表示控件在屏幕外，后者由 `offscreen` 表示。
   */
  rect?: DesktopRect
  actions: DesktopNodeAction[]
  /** RangeValuePattern 的数值区间。没有该模式时缺省。 */
  range?: DesktopRangeState
  /** 复选的当前状态。 */
  toggle?: DesktopToggleState
  /** 展开折叠的当前状态。 */
  expand?: 'collapsed' | 'expanded' | 'partial' | 'leaf' | 'unknown'
  /** 该项当前是否被选中。 */
  selected?: boolean
  /** 选择容器的多选与必选约束，以及当前选中项的名称。只有容器具有该字段。 */
  selection?: DesktopSelectionState
  /** 滚动位置百分比。滚动后重新读取时据此核对。 */
  scroll?: DesktopScrollState
  /** 该控件可读取文档文本与选区。 */
  text?: boolean
  /**
   * 该控件没有稳定身份，只能按角色、名称与稳定标识核对。
   *
   * 界面重排后该引用不可靠，用它发送动作会被拒绝。缺省表示身份正常。
   */
  weakIdentity?: boolean
}

/**
 * 已交给模型的图像上的一个点。
 *
 * 坐标换算与窗口几何代际的核对由实现方完成：换算须使用采集时的几何，而该几何在窗口
 * 移动后不再成立。
 */
export interface DesktopImagePoint {
  imageRef: string
  /** 图像坐标，不是屏幕坐标。 */
  x: number
  y: number
}

/**
 * 一次文本读取。
 *
 * `truncated` 为真表示其后仍有内容，文档并未结束。选区起点按 UTF-16 码元计，
 * 超过 `maxChars` 的起点按 `maxChars` 记录。
 */
export interface DesktopText {
  /** 读取的窗口。界面据此显示目标，不显示窗口编号。 */
  app: string
  title: string
  text: string
  truncated: boolean
  selectionSupport: 'none' | 'single' | 'multiple'
  selection: DesktopTextSelection[]
}

/**
 * 交给模型的图像。
 *
 * `geometry.imageWidth` / `imageHeight` 即 `data` 中图像的像素尺寸：采集端按调用方给定的
 * 长边上限缩放后再编码，几何在采集端定稿，上层不再进行第二次缩放。
 *
 * `imageRef` 是不透明引用，绑定目标窗口身份、三项代际、几何与采集时刻。按图像定位的请求
 * 原样带回它；窗口移动、缩放、更换显示器、DPI 变化或宿主更新代际后，它一律失效。
 */
export interface DesktopImage {
  /** 采集的窗口。界面据此显示目标，不显示窗口编号。 */
  app: string
  title: string
  imageRef: string
  /** base64 编码的图像字节。 */
  data: string
  mime: string
  geometry: DesktopImageGeometry
  source: DesktopImageSource
  capturedAt: number
}

/**
 * 一次窗口观察。
 *
 * 控件表是展平的前序序列，层级由每个控件的 `parentRef` 与 `depth` 表示。表中是本次
 * 读取范围内遍历到的全部控件：按角色或文字筛选只作用于交给模型的视图，不缩小该表。
 *
 * 截断与范围分两个字段表示：`truncated` 为真表示被上限截断，`filteredBy` 列出读取范围与
 * 字段选择。调用方不能把「未采集到」理解为「没有」，也不能把「不在读取范围内」理解为「不存在」。
 *
 * `windowEnabled` 为假表示该窗口当前被模态窗口阻挡，其控件均无法操作。
 *
 * `windowCovered` 为真表示该窗口当前在屏幕上完全不可见（最小化，或被上层窗口完全遮挡）。
 * 浏览器对载入后尚未显示过的页面不提供网页内容，此时控件表只有外框，`truncated` 仍为假：
 * 不能把缺失的内容理解为不存在。
 */
export interface DesktopSnapshot {
  windowId: string
  app: string
  title: string
  /** 观察编号。动作必须携带它；重新观察即更换编号，旧编号作废。 */
  observationId: string
  capturedAt: number
  /** 读取范围的根，即表中第一项的 `ref`。缺省表示整窗。 */
  scope?: string
  elements: DesktopElement[]
  truncated: boolean
  truncatedBy: string[]
  filteredBy: string[]
  /** 已遍历的控件数。上限约束的是该数，不是 `elements` 的长度。 */
  visited: number
  windowEnabled: boolean
  windowCovered: boolean
}

/**
 * 动作或等待之后的重新读取，是一份带新编号的完整观察。
 *
 * 按上一次观察的读取范围整份重新读取，并整份替换上一次观察。调用方取得它后即可发送下一个
 * 动作，无需再单独观察一次。
 *
 * 缺少重新读取的结果不代表动作未发出。调用方取得 `observationError` 时先重新观察确认，
 * 不要重复已派发的动作。`not_dispatched` 只说明请求的动作未派发，窗口准备过程仍可能改变
 * 界面；旧观察是否有效以端口的 `elements` 查询为准，有新观察时使用新编号。
 */
export type DesktopFollowUp =
  | { observation: DesktopSnapshot }
  | { observation: null; observationError: string }

/**
 * 动作调用尚未返回时一并返回的顶层窗口。
 *
 * `windowId` 经由 `windows()` 的同一登记路径产生，取得后可直接 `observe`。
 */
export interface DesktopBlockingWindowInfo extends DesktopWindowInfo {
  /** 动作调用之前该窗口不存在。 */
  appeared: boolean
}

/** 一次动作的执行回执。`dispatch` 是执行事实，与重新读取的结果分列。 */
export interface DesktopActReceipt {
  dispatch: DesktopDispatch
  /** 本次动作的标识。回执状态不明时调用方据此指明是哪一次动作。 */
  actionId: string
  /** 拒绝原因码，或动作调用返回的失败原文。 */
  reason?: string
  /**
   * 动作调用尚未返回，因此未重新读取目标窗口：此时目标应用的 UI 线程仍阻塞于该调用，
   * 任何读取都会等待至超时。该字段是目标进程当前的顶层窗口，`appeared` 为真的窗口是
   * 本次动作之后出现的（模态对话框属于此情形）。
   *
   * 缺省表示调用已返回，重新读取的结果照常位于 `observation` 中。
   */
  blocking?: DesktopBlockingWindowInfo[]
}

export type DesktopActResult = DesktopActReceipt & DesktopFollowUp

export interface DesktopWaitReceipt {
  found: boolean
  /** 条件未满足时的原因：`timeout` 或 `cancelled`。 */
  reason?: string
}

export type DesktopWaitResult = DesktopWaitReceipt & DesktopFollowUp

/**
 * 等待的后置条件。
 *
 * `value` 要求同时给出目标值；`enabled` / `value` / `gone` 要求给出 `ref`；
 * `appears` 按 role 与 name 文字查找控件；`window` 按标题文字查找新窗口。
 */
export type DesktopWaitCondition = DesktopWaitUntil

/**
 * 执行前拒绝：判定在本地完成，本次操作未向宿主发送任何帧，桌面未被操作。
 *
 * 只有这一种形式允许返回 `executed:false`。已发出的动作、超时与断连一律按已执行返回，
 * 将它们标为未执行会使调用方重发一次可能已经生效的操作。
 */
export interface DesktopRefusal {
  errorKind: 'desktop_unavailable' | 'invalid_argument'
  executed: false
}

export interface DesktopPort {
  /** 当前配置是否允许前台操作；每次从请求使用的同一配置读取，不缓存。 */
  foregroundEnabled(): boolean
  /** 当前可操作的顶层窗口。每次调用重新发现，旧的 `windowId` 不因此失效。 */
  windows(): Promise<DesktopWindowInfo[]>
  /**
   * 读取一个窗口的控件树，返回展平后的控件表与新的观察编号。
   *
   * 该路径不采集图像：结构化观察在采集端的截图计数为零。
   */
  observe(input: {
    windowId: string
    maxNodes?: number
    maxDepth?: number
    /**
     * 只读取该 ref 之下的子树。要求它属于本执行者对该窗口的上一次观察。
     *
     * 它成为本次观察的读取范围：之后的动作与等待按它整份重新读取，直到下一次观察替换它。
     */
    root?: string
    /** 是否读取控件当前值。缺省时读取。 */
    includeValue?: boolean
    /**
     * 是否读取控件模式的状态细节：数值区间、复选状态、展开状态、选中状态、容器约束、
     * 滚动位置。缺省时读取。
     *
     * 可用动作表不受它影响：动作按控件是否具备对应模式判定，该项始终读取。
     */
    includeState?: boolean
  }): Promise<DesktopSnapshot>
  /**
   * 取回一次观察记录的控件表。`null` 表示该次观察已失效，调用方需重新观察。
   *
   * 动作前的唯一匹配与前置条件检查依据该表：判定须使用产生 `ref` 的那份快照，
   * 重新读取会使模型看到的内容与判定依据不属于同一时刻。
   */
  elements(windowId: string, observationId: string): DesktopElement[] | null
  /**
   * 采集目标窗口的图像。这是该端口上唯一采集图像的入口，`observe` 不采集图像。
   *
   * 按参数分为三种取景：不提供 `region` 与 `imageRef` 时为整窗；只提供 `region` 时为窗口内
   * 一块屏幕物理像素矩形；提供 `imageRef` 与 `imageRect` 时将上一张图像中的该区域放大重新采集，
   * 坐标换算与代际核对由实现方完成。
   *
   * `maxEdge` 由调用方提供：采集端据此缩放，几何随之定稿，上层不再进行第二次缩放。
   */
  captureImage(input: {
    windowId: string
    maxEdge: number
    region?: DesktopRect
    /** 上一张图像的引用。提供时必须同时提供 `imageRect`。 */
    imageRef?: string
    /** 上一张图像中的一块矩形，使用图像坐标。 */
    imageRect?: DesktopRect
  }): Promise<DesktopImage>
  /**
   * 在一个控件或屏幕位置上执行一个动作。
   *
   * 全部动作使用同一入口：每种动作各设一个方法时，占用、目标核对与动作后重新读取会在
   * 每个方法中各写一遍。动作可能弹出模态窗口，此时整份观察作废。
   *
   * 目标有三种指定方式，前两种只能提供一个：`ref` 指定一个控件，派发前重新定位并读取派发时的
   * 包围盒；`at` 指定上一张图像中的一个点，只有指针动作接受；两者都不提供时目标为窗口本身，
   * 只有键盘输入可以这样发送。
   */
  act(input: {
    windowId: string
    observationId: string
    /** 控件目标。键盘输入以外的动作必须提供它或 `at`。 */
    ref?: string
    /** 图像点目标。只有指针动作接受。 */
    at?: DesktopImagePoint
    action: DesktopAction
  }): Promise<DesktopActResult>
  /**
   * 读取一个控件的文档文本与选区。只读，不改变状态，也不设置焦点。
   *
   * 不更换观察编号：读取文本不改变控件表。
   */
  readText(input: {
    windowId: string
    observationId: string
    ref: string
    maxChars: number
  }): Promise<DesktopText>
  /**
   * 等待一个后置条件成立。超时有上限，判定在宿主侧完成。
   *
   * 不派发任何动作，因此没有 `dispatch`：条件未满足时只返回未满足。等待期间本次执行仍占用
   * 桌面：`ref` 在观察中产生、在动作中使用，中途允许其他执行者操作会使该 `ref` 失效；
   * 但 `release` 随时生效，等待会在一个轮询间隔内以 `cancelled` 结束。
   */
  wait(input: {
    windowId: string
    observationId: string
    until: DesktopWaitCondition
    /** `enabled` / `value` / `gone` 的目标控件。 */
    ref?: string
    /** `until=value` 等待的目标值。 */
    value?: string
    /** `until=appears` 的角色筛选。 */
    role?: string
    /** `until=appears` 要出现的控件文字。 */
    query?: string
    /** `until=window` 要出现的窗口标题文字。 */
    title?: string
    timeoutMs: number
  }): Promise<DesktopWaitResult>
  /**
   * 释放本次执行的全部占用。可重复调用。
   *
   * 释放后该端口不再可用：后续任何操作都失败，不会重新取得控制。
   * 尚未派发的请求随之撤销；已交给 OS 的动作不回滚。
   */
  release(): Promise<void>
}
