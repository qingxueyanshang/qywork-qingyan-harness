/**
 * 指令处理总表：由各域的处理表静态合并而成。新增指令类型时，在所属域的处理表中加一个键，
 * 不修改分派代码。
 */

import { controlCommands } from './control.ts'
import { conversationCommands } from './conversation.ts'
import { goalCommands } from './goals.ts'
import type { CommandHandlers } from './handler.ts'
import { messageCommands } from './messages.ts'

type Table = Partial<CommandHandlers>

/** 在多张表中重复出现的指令类型。 */
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
 * 合并各域的处理表。同一指令类型出现在两张表中时调用处不通过类型检查，报错中的 `repeated`
 * 给出重复的指令类型。
 */
function merge<const T extends readonly Table[]>(
  ...tables: T & ([Repeated<T>] extends [never] ? unknown : { repeated: Repeated<T> })
): Intersect<T[number]> {
  return Object.assign({}, ...tables)
}

/** 每种指令类型都必须有条目：缺少条目的指令类型出现在此处的类型错误中。 */
export const COMMAND_HANDLERS: CommandHandlers = merge(
  conversationCommands,
  messageCommands,
  goalCommands,
  controlCommands,
)
