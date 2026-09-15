/**
 * 在跑的子 agent，按会话记。
 *
 * **服务级，与 `RunManager` 同级。** 派活通道每一轮新建一个（`run-control.ts` 装 Session
 * 时），而子 agent 的生命期跟着会话：挂在通道上的话，派发它的那一轮结束后，此表即被销毁，
 * 停止按钮再也停不到它。
 *
 * **这里是进程内的句柄，不是账。** 格状态与回执才是事实（`NodeState`、`messages.origin`）；
 * 这张表只回答两件事：该会话当前是否有子 agent 正在运行、停止时要 abort 谁。
 */

import type { ConversationId, SubagentKind } from '@qywork/core'

export interface RunningSubagent {
  /** 子 agent 的名字，界面与回执文案用同一个。 */
  name: string
  kind: SubagentKind
  controller: AbortController
}

export class SubagentRegistry {
  /** 外层键是派它的那条会话，内层键是子 agent 自己的会话 id。 */
  private readonly byConversation = new Map<ConversationId, Map<string, RunningSubagent>>()

  add(conversationId: ConversationId, subagentId: string, entry: RunningSubagent): void {
    const table = this.byConversation.get(conversationId) ?? new Map<string, RunningSubagent>()
    table.set(subagentId, entry)
    this.byConversation.set(conversationId, table)
  }

  /** 空表不留空 Map：`has` 与 `conversations` 因此只有一种写法。 */
  remove(conversationId: ConversationId, subagentId: string): void {
    const table = this.byConversation.get(conversationId)
    if (!table) return
    table.delete(subagentId)
    if (table.size === 0) this.byConversation.delete(conversationId)
  }

  has(conversationId: ConversationId): boolean {
    return this.byConversation.has(conversationId)
  }

  /** 这条会话此刻在跑的子 agent。 */
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
   * 停掉这条会话全部在跑的子 agent。返回 false = 一个都没有。
   *
   * **条目不在这里删**：删在它自己的完成回调里，那时格才落终态。
   */
  interruptConversation(conversationId: ConversationId): boolean {
    const table = this.byConversation.get(conversationId)
    if (!table?.size) return false
    for (const entry of table.values()) {
      entry.controller.abort({ source: 'user', observedAt: Date.now() })
    }
    return true
  }

  /** 服务退出：全停。 */
  interruptAll(): void {
    const observedAt = Date.now()
    for (const table of this.byConversation.values()) {
      for (const entry of table.values()) {
        entry.controller.abort({ source: 'server_shutdown', observedAt })
      }
    }
  }
}
