/**
 * 新开会话：用户要求另开一条会话时，新建一条显示在会话列表中的会话，并把交代的任务作为第一条消息发送。
 *
 * 与 `subagent` 的区别：子 agent 是本会话中的实体，不显示在会话列表中，产出作为回执送回本会话；
 * 新开的会话是一条独立的用户会话，用户在其中直接查看与继续，产出不送回本会话。
 */

import type { ToolSpec } from '@qywork/agent'
import { ConversationPort } from './port.ts'

export const newConversationTool: ToolSpec = {
  name: 'new_conversation',
  description:
    '新建一条会话，显示在左侧会话列表中，并把 message 作为第一条消息发送到新会话，新会话随即开始执行。' +
    '用户要求新开、另开会话（新会话、新对话、分支会话）时使用。' +
    '新会话与本会话相互独立：它无法读取本会话的内容，背景与要求需写入 message；它的产出不送回本会话，由用户在新会话中查看与继续。' +
    '把任务交给他人执行、并需要在本会话收到结果时，使用 subagent。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '新会话的标题，概括它要做的事' },
      message: {
        type: 'string',
        description:
          '新会话的第一条消息。新会话无法读取本会话，背景、要求与相关文件路径需在此写完整。',
      },
    },
    required: ['title', 'message'],
    additionalProperties: false,
  },
  verb: '新建',
  category: 'collab',
  facet: '协作',
  summary: '新开一条会话',
  targetExtractor: (a) => (typeof a.title === 'string' ? a.title : null),
  // 新会话沿用本会话的权限模式，其中的每次操作照常裁决；新开会话不会获得本会话不具备的权限。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  requires: [ConversationPort],
  async fn(args, ctx) {
    const port = ctx.port(ConversationPort)
    if (!port) {
      // 正常情况下不会执行到此处：没有该端口时本工具不注册。
      return { status: 'failure' as const, message: '本次执行无法新开会话' }
    }
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    if (!message) return { status: 'failure' as const, message: '需写明发送到新会话的第一条消息' }
    try {
      const opened = await port.open({ title, message })
      return {
        status: 'success' as const,
        message: `已新开会话「${opened.title || '新对话'}」，第一条消息已发送，新会话开始执行`,
        data: { conversationId: opened.id, title: opened.title },
      }
    } catch (err) {
      return {
        status: 'failure' as const,
        message: `新开会话失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
