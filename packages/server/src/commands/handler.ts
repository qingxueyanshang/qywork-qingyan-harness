/** 指令处理表的条目类型。每种指令类型恰好一个条目，由 `commands.ts` 的 `handleCommand` 按类型调用。 */

import type { ClientCommand } from '@qywork/core'
import type { CommandDeps } from '../deps.ts'

export type CommandType = ClientCommand['type']
export type CommandOf<K extends CommandType> = Extract<ClientCommand, { type: K }>

/**
 * 处理器只能以方法签名声明，不要改为函数类型的属性：`handleCommand` 以整个指令联合调用
 * 按类型取出的条目，依赖方法参数的双向检查才能通过类型检查。
 */
export interface CommandHandler<C> {
  handle(cmd: C, deps: CommandDeps): Promise<void> | void
}

export type CommandHandlers = { readonly [K in CommandType]: CommandHandler<CommandOf<K>> }

/**
 * 声明一个域的处理表。键从参数推断，每个处理器的指令参数按键取得对应的指令类型；
 * 返回值的类型只由指令类型名构成，导出时不需要另行标注。
 */
export function handlers<K extends CommandType>(
  table: Pick<CommandHandlers, K>,
): Pick<CommandHandlers, K> {
  return table
}
