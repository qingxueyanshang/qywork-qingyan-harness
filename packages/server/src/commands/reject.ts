/** 指令的拒绝回执，以及发起轮次的指令共用的子会话检查。 */

import type { CommandRejectedFrame, CommandRejectReason, ConversationId } from '@qywork/core'
import { getConversation } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { CommandDeps, SocketData } from '../deps.ts'

/**
 * 子会话只由创建它的图管理：经指令发起轮次会绕过 workflow 的回执与续接，图的投影无法得知该轮次；
 * 该轮次按顶层会话装配（`startRun`），子会话因此取得派发能力。界面没有这些入口，配对端使用同一组指令，
 * 因此边界在指令处检查。发起轮次的指令（`message.send`、`goal.set`、`goal.resume`、空闲时的
 * `followup.steer`）都经过本函数。返回 true 时已发送拒绝回执。
 */
export function rejectChildConversation(
  deps: CommandDeps,
  command: string,
  conversationId: ConversationId,
  clientRequestId?: string,
): boolean {
  if (!getConversation(deps.store, conversationId)?.source) return false
  reject(deps.ws, command, 'conflict', '子会话只能由父会话的 workflow 续发', clientRequestId)
  return true
}

/** 指令回执只发送给发起方：其他客户端未发送该指令，无需收到回执。 */
export function reject(
  ws: ServerWebSocket<SocketData>,
  command: string,
  reason: CommandRejectReason,
  message: string,
  clientRequestId?: string,
): void {
  const frame: CommandRejectedFrame = {
    type: 'command.rejected',
    command,
    reason,
    message,
    ...(clientRequestId ? { clientRequestId } : {}),
  }
  ws.send(JSON.stringify(frame))
}
