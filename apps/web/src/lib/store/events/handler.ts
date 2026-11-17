/**
 * 事件处理表的条目类型。每种事件类型恰好一个条目，由 `connection.ts` 的 `applyEvent` 按条目的形状调用。
 */

import type { AgentEvent } from '@qywork/core'

export type EventType = AgentEvent['type']
export type EventOf<K extends EventType> = Extract<AgentEvent, { type: K }>

/** 不属于任何会话的事件：在归属判定之前处理，不 flush 缓冲。`seq` 为信封上的帧序号。 */
export interface ProcessEntry<E> {
  process(ev: E, seq: number): void
  flush?: never
  conversation?: never
  active?: never
}

/** 会话事件。`applyEvent` 判定归属并 flush 缓冲之后，先调用 `conversation`，再调用 `active`。 */
export interface ConversationEntry<E> {
  /**
   * 为 false 时折叠之前不 flush 缓冲。用于两类事件：增量事件（正文、思考、工具输出）经缓冲层输出，
   * 它们触发 flush 等于关闭对应的缓冲层；不写入 transcript 的事件触发 flush 会打断匀速呈现。
   *
   * 只标注确定无需 flush 的条目。遗漏标注一项时多 flush 一次（短暂停顿）；误标一项会使需要写入
   * transcript 的事件读取只输出了一部分的正文，造成顺序错乱。
   */
  readonly flush?: false
  /**
   * 折叠进归属会话（`cid`）的视图：会话内容与该会话的运行读数。当前会话与右侧的子会话页各自接收，
   * 父子页因此共用同一个运行条组件。
   *
   * 每个写入点都先读取 `s.views[cid]`，视图不存在时整条不写入：视图由 `openView` 建立，
   * 而切换会话、关闭子会话页都会立即撤销视图（`dropView`），撤销之后到达的帧已没有归属。
   */
  conversation?(ev: E, cid: string, seq: number): void
  /** 只有当前会话使用的外围状态：跟进队列、后台命令、待办、目标、上下文、本轮修改的文件与分支名。 */
  active?(ev: E): void
}

/**
 * 条目中的处理器只能以方法签名声明，不要改为函数类型的属性：`applyEvent` 以整个事件联合调用
 * 按类型取出的条目，依赖方法参数的双向检查才能通过类型检查。
 */
export type Entry<E> = ProcessEntry<E> | ConversationEntry<E>

export type EventHandlers = { readonly [K in EventType]: Entry<EventOf<K>> }

/**
 * 声明一个域的处理表。键从参数推断，每个处理器的事件参数按键取得对应的事件类型；
 * 返回值的类型只由事件类型名构成，导出时不需要另行标注。
 */
export function handlers<K extends EventType>(
  table: Pick<EventHandlers, K>,
): Pick<EventHandlers, K> {
  return table
}
