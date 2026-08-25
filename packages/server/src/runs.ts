/**
 * Run 管理器。
 *
 * 两件事：并发控制与中断。
 *
 * **这里不问用户任何事。** 工具授权由 `Session.decide()` 就地裁决（规则 + 分类器），
 * 被拒的调用以 `tool.finished{status:'failure', errorKind:'permission_denied'}` 呈现。
 * 这个产品只有 `auto` / `full` 两档，没有「逐次询问」那一档。
 */

import type { ConversationId, RunId } from '@qywork/core'
import type { Store } from '@qywork/store'
import { listConversations } from '@qywork/store'
import type { EventBus } from './bus.ts'

export interface ActiveRun {
  runId: RunId
  conversationId: ConversationId
  controller: AbortController
  startedAt: number
}

/**
 * 待续起标记：这条会话正在自动循环里，下一轮该按这个目标的这个版本发起。
 *
 * **为什么挂在这里，而且**绝不落盘**。** 「循环开着」是**进程内**的事实，不是账本里的事实。落盘的
 * 话，一个失控之后崩掉的循环会在下次启动时自己复活——而没有人再点过「继续」。挂在 `RunManager`
 * 上恰好等价于「不持久化」：进程重启即空表，账本里那个 `active` 的目标就静静躺着，等用户明确点继续
 * （`goal.resume`）。
 *
 * **不挂 Session**：服务端每条消息新建一个 Session，它活不过这一条消息，
 * 挂上去的话循环最多跑一轮。
 *
 * `revision` 是这次续起的**预留**：真正发起之前要重读目标，对不上就丢弃这次
 * 排队且不增加轮数——中途被改过的目标不该按旧版本继续跑。
 */
export interface GoalArm {
  goalId: string
  revision: number
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>()
  /** 同一会话同时只允许一个 run —— 两个 run 并发改同一批文件必然互相踩。 */
  private readonly byConversation = new Map<string, RunId>()
  /** 已占位但还没拿到 runId 的会话。见 `reserve()`。 */
  private readonly reserved = new Set<string>()
  /** 每个会话最多一条待续起标记。见 `GoalArm`。 */
  private readonly armed = new Map<string, GoalArm>()

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  isBusy(conversationId: ConversationId): boolean {
    return this.byConversation.has(conversationId) || this.reserved.has(conversationId)
  }

  /** 此刻在跑的全部会话。握手快照读它，见 `HelloOkFrame.busyConversations`。 */
  busyConversations(): ConversationId[] {
    return [...new Set([...this.byConversation.keys(), ...this.reserved])] as ConversationId[]
  }

  /**
   * 把「这条会话在不在跑」播出去。**下面四个改点各调一次，别处不许发这条事件。**
   *
   * 两个约束：
   *
   * - **不带 `conversationId` 发**（第二个参数留空）：它是工作区级事件，
   *   所有客户端都要收到。带上就成了按订阅过滤，只有开着这条会话的那个客户端
   *   收得到——而要这条事件的正是没开着它的那些。
   * - **现算 `isBusy()`，不接受调用方传进来的值**：占位与登记是两个集合，
   *   `release()` 在 run 已经 register 之后也会被调到，传字面量必然报出
   *   一个此刻不成立的 false。
   */
  private announce(conversationId: ConversationId): void {
    this.bus.publish({
      type: 'conversation.busy',
      conversationId,
      busy: this.isBusy(conversationId),
    })
  }

  /**
   * 占住一个会话，**同步**完成检查与登记。
   *
   * **检查与登记必须在同一个同步块里**。拆成 `isBusy()` 检查加后面某处的
   * `register()`，中间隔着建 Session、读历史附件、等首个带 runId 的事件那几个
   * await——桌面端和手机端几乎同时发一条消息时，两次检查都读到 false，
   * 因此两个 AgentLoop 对着同一个工作区一起写文件。
   * JS 是单线程的，同步块里就是原子的。
   *
   * 返回 false = 已经有人在跑，调用方必须直接回绝。
   */
  reserve(conversationId: ConversationId): boolean {
    if (this.isBusy(conversationId)) return false
    this.reserved.add(conversationId)
    this.announce(conversationId)
    return true
  }

  /** 释放占位。run 已经 register 过就交给 unregister 收，这里只管没跑起来的那些。 */
  release(conversationId: ConversationId): void {
    this.reserved.delete(conversationId)
    this.announce(conversationId)
  }

  register(run: ActiveRun): void {
    this.active.set(run.runId, run)
    this.byConversation.set(run.conversationId, run.runId)
    this.reserved.delete(run.conversationId)
    this.announce(run.conversationId)
  }

  unregister(runId: RunId): void {
    const run = this.active.get(runId)
    if (run) this.byConversation.delete(run.conversationId)
    this.active.delete(runId)
    if (run) this.announce(run.conversationId)
  }

  /** 记下（或刷新）待续起标记。目标每变一次版本都要重记，见 `GoalArm`。 */
  arm(conversationId: ConversationId, arm: GoalArm): void {
    this.armed.set(conversationId, arm)
  }

  /**
   * 解除待续起标记。
   *
   * 用户发消息、目标进终态、这一轮被中断——三种情况都走这里。
   * **人类消息优先**就是这条：他一说话，排着的那次自动续起就作废。
   */
  disarm(conversationId: ConversationId): void {
    this.armed.delete(conversationId)
  }

  armedOf(conversationId: ConversationId): GoalArm | null {
    return this.armed.get(conversationId) ?? null
  }

  interrupt(runId: RunId): boolean {
    const run = this.active.get(runId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  interruptAll(): void {
    for (const run of this.active.values()) run.controller.abort()
  }

  listActive(): ActiveRun[] {
    return [...this.active.values()]
  }

  conversationsOf(workspaceId: string): ConversationId[] {
    return listConversations(this.store, workspaceId as never).map((c) => c.id)
  }
}
