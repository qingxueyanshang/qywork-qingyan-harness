/**
 * 客户端指令的入口：鉴权、更新期间的拒绝与按指令类型分派。各类指令的处理器在 `commands/` 下，
 * 由 `commands/table.ts` 的 `COMMAND_HANDLERS` 按类型静态合并。
 *
 * 未实现的分支必须明确拒绝，不得静默 return：客户端发送后得不到任何反馈，
 * 在界面上与「服务端正在处理」无法区分。
 */

import type { ClientCommand } from '@qywork/core'
import type { CommandHandler } from './commands/handler.ts'
import { reject } from './commands/reject.ts'
import { COMMAND_HANDLERS } from './commands/table.ts'
import type { CommandDeps } from './deps.ts'

export { reject } from './commands/reject.ts'

export async function handleCommand(cmd: ClientCommand, deps: CommandDeps): Promise<void> {
  if (!deps.ws.data.authed) return
  if (deps.runs.updating && cmd.type !== 'subscribe' && cmd.type !== 'conversation.interrupt') {
    reject(
      deps.ws,
      cmd.type,
      'conflict',
      '应用正在更新，请稍后重试',
      'clientRequestId' in cmd ? cmd.clientRequestId : undefined,
    )
    return
  }

  // 只按自有属性取条目：类型来自网络，`constructor` 等原型上的键不得取到对象自带的成员。
  const type: unknown = (cmd as { type?: unknown }).type
  const handler =
    typeof type === 'string' && Object.hasOwn(COMMAND_HANDLERS, type)
      ? (COMMAND_HANDLERS as Readonly<Record<string, CommandHandler<ClientCommand>>>)[type]
      : undefined
  if (!handler) {
    // 协议中不存在的 type。来源是版本高于服务端的客户端或伪造流量，两种情况都必须回执；
    // 静默丢弃会使前者的功能时而生效时而无效，后者则完全得不到反馈。
    reject(deps.ws, String(type ?? '(missing)'), 'unknown_command', '服务端无法识别该指令')
    return
  }
  await handler.handle(cmd, deps)
}
