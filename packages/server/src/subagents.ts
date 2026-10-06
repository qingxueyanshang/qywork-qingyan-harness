/**
 * 运行中的子 agent，按会话记录。
 *
 * 服务级，与 `RunManager` 同级。任务派发通道每一轮新建一个（`run-control.ts` 装配 Session
 * 时），而子 agent 的生命周期跟随会话：若放在通道上，派发它的那一轮结束后此表即被销毁，
 * 停止按钮无法再停止它。
 *
 * 此处保存的是进程内的句柄，不是账本。节点状态与回执才是事实（`NodeState`、`messages.origin`）；
 * 此表只回答两个问题：该会话当前是否有子 agent 正在运行、停止时应 abort 哪些对象。
 */

import type { ConversationId, SubagentKind } from '@qywork/core'

export interface RunningSubagent {
  /** 子 agent 的名称，界面与回执文案使用同一个值。 */
  name: string
  kind: SubagentKind
  controller: AbortController
}

export class SubagentRegistry {
  /** 外层键是派发子 agent 的会话 id，内层键是子 agent 自身的会话 id。 */
  private readonly byConversation = new Map<ConversationId, Map<string, RunningSubagent>>()

  add(conversationId: ConversationId, subagentId: string, entry: RunningSubagent): void {
    const table = this.byConversation.get(conversationId) ?? new Map<string, RunningSubagent>()
    table.set(subagentId, entry)
    this.byConversation.set(conversationId, table)
  }

  /** 内层表为空时一并删除：`has` 与 `conversations` 因此只需一种判断方式。 */
  remove(conversationId: ConversationId, subagentId: string): void {
    const table = this.byConversation.get(conversationId)
    if (!table) return
    table.delete(subagentId)
    if (table.size === 0) this.byConversation.delete(conversationId)
  }

  has(conversationId: ConversationId): boolean {
    return this.byConversation.has(conversationId)
  }

  /** 该会话当前运行中的子 agent。 */
  listOf(
    conversationId: ConversationId,
  ): { subagentId: string; name: string; kind: SubagentKind }[] {
    return [...(this.byConversation.get(conversationId) ?? new Map())].map(
      ([subagentId, entry]) => ({
        subagentId,
        name: entry.name,
        kind: entry.kind,
      }),
    )
  }

  conversations(): ConversationId[] {
    return [...this.byConversation.keys()]
  }

  /**
   * 停止该会话全部运行中的子 agent。返回 false 表示没有运行中的子 agent。
   *
   * 条目不在此处删除，而在其完成回调中删除：节点在那时才写入终态。
   */
  interruptConversation(conversationId: ConversationId): boolean {
    const table = this.byConversation.get(conversationId)
    if (!table?.size) return false
    for (const entry of table.values()) {
      entry.controller.abort({ source: 'user', observedAt: Date.now() })
    }
    return true
  }

  /** 服务退出：停止全部子 agent。 */
  interruptAll(): void {
    const observedAt = Date.now()
    for (const table of this.byConversation.values()) {
      for (const entry of table.values()) {
        entry.controller.abort({ source: 'server_shutdown', observedAt })
      }
    }
  }
}
