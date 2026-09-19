/**
 * 电脑操作端口 —— 本机桌面控件的窄接口。
 *
 * **为什么是端口。** 同 `SinkPort`：真实的原生宿主由桌面外壳持有，服务端经宿主连接
 * 操作它，而那两样在依赖图上都**高于** tools。所以接口在这里、实现由装配方注入。
 *
 * **不注入就没有这个能力。** 用户没启用、宿主没连上、worker 没就绪、系统没授权，
 * 四者任一不成立时装配方不注入，对应的工具也就不注册——没有宿主的桌面工具没有
 * 降级形态。
 *
 * **句柄不出这一层。** 端口交出去的 `windowId` 是不透明 id，OS 句柄的映射留在实现方；
 * 模型拿到的参数里不存在句柄。
 *
 * **每次执行一份端口。** 排队与撤销按执行者记，`release` 由装配方在这一轮收尾时调，
 * 撤销这个执行者名下尚未派发的请求；已经交给 OS 的动作不回滚。
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
 * `windowId` 只能来自 `windows()`：它绑定着窗口句柄、进程与进程启动时刻，
 * 三者任一变化即失效，调用方拿到失效 id 时要重新发现。
 */
export interface DesktopWindowInfo {
  windowId: string
  /** 应用名，取自可执行文件。 */
  app: string
  title: string
}

/**
 * 一次观察里的一个控件。
 *
 * `ref` 只在**同一次观察、同一窗口**内有效。重新观察、换 worker、宿主重连之后旧编号
 * 一律作废。`actions` 只列宿主真的能执行的动作，**不是控件声明支持的全部模式**：
 * 按它发请求才不会撞上一个没有实现的动作。
 *
 * `parentRef` 指向同一张表里的父控件，`depth` 是相对本次观察范围的层数。同名控件靠
 * 祖先路径分得开，路径由调用方顺着 `parentRef` 往上走出来。
 */
export interface DesktopElement {
  ref: string
  /** 父控件的 `ref`。本次观察范围的根没有父控件。 */
  parentRef?: string
  depth: number
  role: string
  name: string
  /** 应用给控件定的稳定标识。可能是空串，那时只能按 role 与 name 定位。 */
  automationId: string
  value?: string
  enabled: boolean
  /** 不在可视区内。不等于不可操作：语义动作不要求控件可见。 */
  offscreen: boolean
  /**
   * 这个控件此刻持有键盘焦点。
   *
   * 文字与按键去的是焦点所在的地方，所以键盘动作只列在这个控件上。前台接管关着时
   * 这一项一律缺席。
   */
  focused?: boolean
  /**
   * 控件的包围盒，屏幕物理像素，与图像几何同一套坐标。
   *
   * 有了它，树里读到的控件与图上看到的位置对得上。provider 不给包围盒的控件缺席——
   * **缺席不等于控件不存在**，也不等于它在屏幕外，后者由 `offscreen` 说。
   */
  rect?: DesktopRect
  actions: DesktopNodeAction[]
  /** RangeValuePattern 的数值区间。没有这个模式时缺席。 */
  range?: DesktopRangeState
  /** 复选的现态。 */
  toggle?: DesktopToggleState
  /** 展开折叠的现态。 */
  expand?: 'collapsed' | 'expanded' | 'partial' | 'leaf' | 'unknown'
  /** 这一项此刻选中没有。 */
  selected?: boolean
  /** 选择容器的多选与必选约束，以及当前选中项的名称。只有容器有。 */
  selection?: DesktopSelectionState
  /** 滚动位置百分比。滚动后重读按它核对。 */
  scroll?: DesktopScrollState
  /** 这个控件读得出文档文本与选区。 */
  text?: boolean
  /**
   * 这个控件没有稳定身份，只能按角色、名称与稳定标识核对。
   *
   * 界面重排之后这个引用不可靠，拿它发动作会被拒。缺席表示身份正常。
   */
  weakIdentity?: boolean
}

/**
 * 一张已经交给模型的图上的一个点。
 *
 * 换算与窗口几何代际的核对由实现方做：换算要用采集那一刻的几何，而那份几何在窗口
 * 移动之后就不成立了。
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
 * `truncated` 为真表示后面还有内容，不是文档到此为止。选区起点按 UTF-16 码元计，
 * 超过 `maxChars` 的起点按 `maxChars` 记。
 */
export interface DesktopText {
  text: string
  truncated: boolean
  selectionSupport: 'none' | 'single' | 'multiple'
  selection: DesktopTextSelection[]
}

/**
 * 一张交给模型的图。
 *
 * `geometry.imageWidth` / `imageHeight` 就是 `data` 里那张图的像素数——采集端按调用方
 * 给的长边上限缩好才编码，**几何在采集端定稿**，上层不再缩第二次。
 *
 * `imageRef` 不透明，绑定目标窗口身份、三条代际、几何与采集时刻。按图定位的请求原样
 * 带回它；窗口移动、缩放、换显示器、DPI 变化或宿主换代之后它一律失效。
 */
export interface DesktopImage {
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
 * 控件表是展平的前序序列，层级由每个控件的 `parentRef` 与 `depth` 表达。
 *
 * **截断与筛选分两格**：`truncated` 为真表示被上限截断了，`filteredBy` 列出施加过的
 * 筛选条件。调用方不能把「没采到」读成「没有」，也不能把「被筛掉」读成「不存在」。
 *
 * `windowEnabled` 为假表示这个窗口此刻被模态窗口挡着，它的控件一个都动不了。
 */
export interface DesktopSnapshot {
  windowId: string
  app: string
  title: string
  /** 观察编号。动作必须带上它；重新观察即换号，旧号作废。 */
  observationId: string
  capturedAt: number
  elements: DesktopElement[]
  truncated: boolean
  truncatedBy: string[]
  filteredBy: string[]
  /** 遍历过的控件数。上限限的是它，不是 `elements` 的长度。 */
  visited: number
  windowEnabled: boolean
}

/**
 * 动作或等待之后的重读，是一份带新编号的完整观察。
 *
 * 目标控件所在的子树重读之后并进上一份观察：子树里的旧编号作废，子树外的仍然成立。
 * 调用方拿到它就能接着发下一个动作，不必再单独观察一次。
 *
 * **重读缺席不代表动作没发出去。** 调用方拿到 `observationError` 时先重新观察确认，
 * 不要重复同一个动作。
 */
export type DesktopFollowUp =
  | { observation: DesktopSnapshot }
  | { observation: null; observationError: string }

/**
 * 动作调用尚未返回时同次带回的一个顶层窗口。
 *
 * `windowId` 走的是 `windows()` 那一条登记路径，拿到就能直接 `observe`。
 */
export interface DesktopBlockingWindowInfo extends DesktopWindowInfo {
  /** 动作调用之前这个窗口不存在。 */
  appeared: boolean
}

/** 一次动作的执行回执。`dispatch` 是执行事实，与重读结果分列。 */
export interface DesktopActReceipt {
  dispatch: DesktopDispatch
  /** 这一次动作的身份。回执不明时调用方据它说得出「是哪一次」。 */
  actionId: string
  /** 拒绝原因码，或动作调用返回的失败原文。 */
  reason?: string
  /**
   * 动作调用尚未返回，因此**没有重读目标窗口**——那一刻目标应用的 UI 线程还卡在这次
   * 调用里，任何读取都会等到超时。这是目标进程此刻的顶层窗口，`appeared` 为真的那些是
   * 这次动作之后冒出来的（模态对话框走的就是这一支）。
   *
   * 缺席表示调用已经返回，重读结果照常在 `observation` 里。
   */
  blocking?: DesktopBlockingWindowInfo[]
}

export type DesktopActResult = DesktopActReceipt & DesktopFollowUp

export interface DesktopWaitReceipt {
  found: boolean
  /** 没等到时的原因：`timeout` 或 `cancelled`。 */
  reason?: string
}

export type DesktopWaitResult = DesktopWaitReceipt & DesktopFollowUp

/**
 * 等待的后置条件。
 *
 * `value` 要求同时给出目标值；`enabled` / `value` / `gone` 要求给出 `ref`；
 * `appears` 按 role 与 name 文字找控件；`window` 按标题文字找新窗口。
 */
export type DesktopWaitCondition = DesktopWaitUntil

/**
 * 执行前拒绝：判定落在本地，本次操作**没有向宿主发出任何帧**，桌面没被动过。
 *
 * 只有这一种形状允许回 `executed:false`。已发出的动作、超时与断连一律按已执行回执，
 * 把它们也标成未执行会让调用方重发一次可能已经生效的操作。
 */
export interface DesktopRefusal {
  errorKind: 'desktop_unavailable' | 'invalid_argument'
  executed: false
}

export interface DesktopPort {
  /** 此刻可操作的顶层窗口。每次调用重新发现，旧的 `windowId` 不因此失效。 */
  windows(): Promise<DesktopWindowInfo[]>
  /**
   * 读一个窗口的控件树，返回展平后的控件表与新的观察编号。
   *
   * 这条路径不采图：结构化观察的采集端截图计数为零。
   */
  observe(input: {
    windowId: string
    maxNodes?: number
    maxDepth?: number
    /** 只读这个 ref 底下的子树。要求它属于本执行者对该窗口的上一份观察。 */
    root?: string
    /** 只留这个角色的控件。 */
    role?: string
    /** 只留名称、稳定标识或值包含这段文字的控件，不分大小写。 */
    query?: string
    /** 取不取控件当前值。缺席按取。 */
    includeValue?: boolean
    /**
     * 取不取控件模式的状态细节：数值区间、复选现态、展开现态、选中状态、容器约束、
     * 滚动位置。缺席按取。
     *
     * **可用动作表不受它影响**：动作按控件有没有对应模式判，那一项一直取。
     */
    includeState?: boolean
  }): Promise<DesktopSnapshot>
  /**
   * 取回一次观察记录的控件表。**`null` = 这次观察已经失效**，调用方要重新观察。
   *
   * 动作前的唯一匹配与前置条件检查按它做：判定要用产生 `ref` 的那一份快照，
   * 现读一份新的会让「模型看到的」与「判定依据的」不是同一个时刻。
   */
  elements(windowId: string, observationId: string): DesktopElement[] | null
  /**
   * 采一张目标窗口的图。**这是这个端口上唯一会采集图像的入口**，`observe` 不采。
   *
   * 三种取景，按参数分：不给 `region` 与 `imageRef` 是整窗；只给 `region` 是窗口内的
   * 一块屏幕物理像素矩形；给 `imageRef` 加 `imageRect` 是把上一张图里的那一块放大重采，
   * 换算与代际核对由实现方做。
   *
   * `maxEdge` 由调用方给：采集端按它缩图，几何随之定稿，上层不再缩第二次。
   */
  captureImage(input: {
    windowId: string
    maxEdge: number
    region?: DesktopRect
    /** 上一张图的引用。给了就必须给 `imageRect`。 */
    imageRef?: string
    /** 上一张图里的一块矩形，图像坐标。 */
    imageRect?: DesktopRect
  }): Promise<DesktopImage>
  /**
   * 在一个控件或一个屏幕位置上执行一个动作。
   *
   * 全部动作走同一个入口：每种各开一个方法的话，占用、目标核对与动作后重读会在每个
   * 方法里各写一遍。动作可能弹出模态窗口，那时整份观察作废。
   *
   * 目标三种给法，前两种**只能给一个**：`ref` 指一个控件，派发前重新定位并读那一刻的
   * 包围盒；`at` 指上一张图里的一个点，只有指针动作接受它；两样都不给时目标是窗口
   * 本身，只有键盘输入能这样发。
   */
  act(input: {
    windowId: string
    observationId: string
    /** 控件目标。键盘输入之外的动作都必须给它或 `at`。 */
    ref?: string
    /** 图像点目标。只有指针动作接受。 */
    at?: DesktopImagePoint
    action: DesktopAction
  }): Promise<DesktopActResult>
  /**
   * 读一个控件的文档文本与选区。只读，不改变状态，也不设焦点。
   *
   * 它不换观察编号：读文本不动控件表。
   */
  readText(input: {
    windowId: string
    observationId: string
    ref: string
    maxChars: number
  }): Promise<DesktopText>
  /**
   * 等一个后置条件成立。有界超时，判定在宿主那一侧做。
   *
   * 它不派发任何动作，因此没有 `dispatch`：等不到就是等不到。等待期间本次执行仍然占着
   * 桌面——`ref` 是在观察里产生、在动作里消费的，中间放别人进来这个 `ref` 就不再成立；
   * 但 `release` 随时生效，等待会在一个轮询间隔内以 `cancelled` 收尾。
   */
  wait(input: {
    windowId: string
    observationId: string
    until: DesktopWaitCondition
    /** `enabled` / `value` / `gone` 的目标控件。 */
    ref?: string
    /** `until=value` 要等到的值。 */
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
   * **释放之后这个端口就报废了**：后续任何操作都失败，不会重新取得控制。
   * 尚未派发的请求随之撤销；已经交给 OS 的动作不回滚。
   */
  release(): Promise<void>
}
