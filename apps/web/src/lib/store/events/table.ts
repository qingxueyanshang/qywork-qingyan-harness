/**
 * 事件处理总表：由各域的处理表静态合并而成。新增事件类型时，在所属域的处理表中加一个键。
 */

import { globalEvents } from './global.ts'
import type { EventHandlers } from './handler.ts'
import { runEvents } from './run.ts'
import { sessionEvents } from './session.ts'
import { toolEvents } from './tools.ts'

type Table = Partial<EventHandlers>

/** 在多张表中重复出现的事件类型。 */
type Repeated<T, Seen = never> = T extends readonly [infer H, ...infer R]
  ? (keyof H & Seen) | Repeated<R, Seen | keyof H>
  : never

/** 联合类型各成员的交集。以各表类型的联合求得合并后的表的类型。 */
type Intersect<U> = (U extends unknown ? (table: U) => void : never) extends (
  table: infer I,
) => void
  ? I
  : never

/**
 * 合并各域的处理表。同一事件类型出现在两张表中时调用处不通过类型检查，报错中的 `repeated`
 * 给出重复的事件类型。
 */
function merge<const T extends readonly Table[]>(
  ...tables: T & ([Repeated<T>] extends [never] ? unknown : { repeated: Repeated<T> })
): Intersect<T[number]> {
  return Object.assign({}, ...tables)
}

/** 每种事件类型都必须有条目：缺少条目的事件类型出现在此处的类型错误中。 */
export const EVENT_HANDLERS: EventHandlers = merge(
  globalEvents,
  runEvents,
  toolEvents,
  sessionEvents,
)
