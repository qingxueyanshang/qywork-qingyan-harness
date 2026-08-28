import type { ContentBlock, WireMessage } from '../types.ts'

export type ProviderWireMessage = Omit<WireMessage, 'role'> & {
  role: Exclude<WireMessage['role'], 'context'>
}

/**
 * 把 runtime 的内部上下文段并入它所归属的真实用户消息。
 *
 * `context` 不是任何 provider 的线上角色。三类协议共用这一处归一化，确保最终请求
 * 没有额外的 user/system 轮，也没有 `<system-reminder>` 包装。非法顺序直接报错，
 * 不能把上下文静默挂到另一条消息上。
 */
export function mergeContextIntoUsers(messages: readonly WireMessage[]): ProviderWireMessage[] {
  const out: ProviderWireMessage[] = []
  let pending: string[] = []

  for (const message of messages) {
    if (message.role === 'context') {
      if (typeof message.content !== 'string') {
        throw new Error('内部上下文只能是文本')
      }
      pending.push(message.content)
      continue
    }

    if (!pending.length) {
      out.push(message as ProviderWireMessage)
      continue
    }
    if (message.role !== 'user') {
      throw new Error('内部上下文后必须紧跟真实用户消息')
    }

    const prefix = pending.join('\n\n')
    const content: string | ContentBlock[] =
      typeof message.content === 'string'
        ? message.content
          ? `${prefix}\n\n${message.content}`
          : prefix
        : [{ type: 'text', text: prefix }, ...message.content]
    out.push({ ...message, content } as ProviderWireMessage)
    pending = []
  }

  if (pending.length) throw new Error('内部上下文缺少所属的用户消息')
  return out
}
