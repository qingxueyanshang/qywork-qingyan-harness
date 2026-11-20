import { definePort } from '@qywork/agent'

/**
 * 新开会话的端口：在当前工作区新建一条用户会话，并把一条消息作为它的第一条用户消息发送。
 *
 * 会话表位于账本（`@qywork/store`），消息投递经由服务端的 `submitMessage`，工具不持有二者，实现由服务端注入。
 * 只提供给顶层会话：子 agent 与工作流成员的会话中不注册 `new_conversation`。
 *
 * 失败以异常表示，由工具转换为 failure 返回给模型。
 */
export interface ConversationPort {
  /**
   * 新建会话并发送 `message`，返回新会话的 id 与标题。新会话显示在会话列表中，与本会话没有父子关系，
   * 接口、模型与权限模式取本会话的当前值。
   */
  open(input: { title: string; message: string }): Promise<{ id: string; title: string }>
}

export const ConversationPort = definePort<ConversationPort>('conversations')
