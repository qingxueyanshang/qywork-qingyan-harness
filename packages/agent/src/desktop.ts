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

import type { DesktopDispatch, DesktopNodeAction } from '@qywork/core'

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
 */
export interface DesktopElement {
  ref: string
  role: string
  name: string
  /** 应用给控件定的稳定标识。可能是空串，那时只能按 role 与 name 定位。 */
  automationId: string
  value?: string
  enabled: boolean
  /** 不在可视区内。不等于不可操作：语义动作不要求控件可见。 */
  offscreen: boolean
  actions: DesktopNodeAction[]
}

/**
 * 一次窗口观察。
 *
 * 控件表是展平的：树形层级不进这一层，定位按 role / name / automationId 做。
 * `truncated` 为真时这一份不是全部，`truncatedBy` 说明是被哪一条上限截断的——
 * 调用方不能把「没采到」读成「没有」。
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
}

/**
 * 动作之后的重读。两种结果互斥：读到控件，或说明为什么没读到。
 *
 * **重读缺席不代表动作没发出去。** 调用方拿到 `observationError` 时先重新观察确认，
 * 不要重复同一个动作。
 */
export type DesktopFollowUp =
  | { element: DesktopElement }
  | { element: null; observationError: string }

/** 一次动作的执行回执。`dispatch` 是执行事实，与重读结果分列。 */
export interface DesktopActReceipt {
  dispatch: DesktopDispatch
  /** 这一次动作的身份。回执不明时调用方据它说得出「是哪一次」。 */
  actionId: string
  /** 拒绝原因码，或动作调用返回的失败原文。 */
  reason?: string
}

export type DesktopActResult = DesktopActReceipt & DesktopFollowUp

export interface DesktopWaitReceipt {
  found: boolean
  /** 没等到时的原因：`timeout` 或 `cancelled`。 */
  reason?: string
}

export type DesktopWaitResult = DesktopWaitReceipt & DesktopFollowUp

/** 等待的后置条件。`value` 要求同时给出目标值。 */
export type DesktopWaitCondition = 'enabled' | 'value'

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
  }): Promise<DesktopSnapshot>
  /**
   * 取回一次观察记录的控件表。**`null` = 这次观察已经失效**，调用方要重新观察。
   *
   * 动作前的唯一匹配与前置条件检查按它做：判定要用产生 `ref` 的那一份快照，
   * 现读一份新的会让「模型看到的」与「判定依据的」不是同一个时刻。
   */
  elements(windowId: string, observationId: string): DesktopElement[] | null
  /** 给控件写值。空串是清空，与不给这个参数不是一回事。 */
  setValue(input: {
    windowId: string
    observationId: string
    ref: string
    value: string
  }): Promise<DesktopActResult>
  /** 调用控件的默认动作（按钮、菜单项）。可能弹出模态窗口，之后要重新观察。 */
  invoke(input: { windowId: string; observationId: string; ref: string }): Promise<DesktopActResult>
  /**
   * 等一个控件满足后置条件。有界超时，按固定间隔重读同一个 `ref`。
   *
   * 它不派发任何动作，因此没有 `dispatch`：等不到就是等不到。
   */
  wait(input: {
    windowId: string
    observationId: string
    ref: string
    until: DesktopWaitCondition
    value?: string
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
