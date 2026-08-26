/**
 * Run 管理器。
 *
 * 三件事：并发控制、中断，以及**进程内的会话意志**——待续起标记（`GoalArm`）
 * 与跟进消息队列（`FollowUp`）。后两者共用同一条学说：它们是「接下来该干什么」
 * 的意图，不是账本事实，因此一律不落盘，进程重启即空表。
 *
 * **这里不问用户任何事。** 工具授权由 `Session.decide()` 就地裁决（规则 + 分类器），
 * 被拒的调用以 `tool.finished{status:'failure', errorKind:'permission_denied'}` 呈现。
 * 这个产品只有 `auto` / `full` 两档，没有「逐次询问」那一档。
 */

import type { ConversationId, FollowUp, RunId } from '@qywork/core'
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
  /**
   * 排着的跟进消息，按会话分。**进程内，不落盘**，理由同 `GoalArm`。
   *
   * 代价说破：进程崩溃时排着还没跑的正文就没了，卡片随之消失。这与本仓
   * 「输入框里没发出去的草稿刷新即丢」同级，而且丢得见得到。
   * 换成落盘要多两条路径——删卡片变成删一行账、崩溃残留行的终态定义——
   * 而它们服务的仍是一个进程内的意图。
   */
  private readonly queues = new Map<string, FollowUp[]>()

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

  // ─────────────────────────── 跟进消息队列 ───────────────────────────

  /**
   * 把这条会话的队列播出去。**下面每一个改点各调一次，别处不许发这条事件。**
   *
   * 发的是整份快照而不是增量：客户端那边还有一份乐观加上去的本地卡，
   * 两份增量账在「服务端按 id 去重掉一条」这种时刻必然分叉。
   *
   * 带 `conversationId` 发（与 `conversation.busy` 相反）：卡片只出现在打开着的
   * 那条会话里，别的客户端收到没有用处。
   */
  private announceQueue(conversationId: ConversationId): void {
    this.bus.publish({ type: 'queue.changed', conversationId, queue: this.queueOf(conversationId) })
  }

  /** 这条会话排着的跟进消息。返回副本——调用方拿去发事件，不该能改到内部那份。 */
  queueOf(conversationId: ConversationId): FollowUp[] {
    return [...(this.queues.get(conversationId) ?? [])]
  }

  /**
   * 排进一条跟进消息。**按 id 幂等**——`id` 就是指令的 `clientRequestId`，
   * 重连补发同一条指令时不该排出两条。
   */
  enqueue(conversationId: ConversationId, item: FollowUp): void {
    const list = this.queues.get(conversationId) ?? []
    if (list.some((f) => f.id === item.id)) return
    list.push(item)
    this.queues.set(conversationId, list)
    this.announceQueue(conversationId)
  }

  /**
   * 把一条已经取走的消息塞回队首。
   *
   * **只给「取走之后没能发出去」用**（收尾火发到点时会话又忙了）。取走与
   * 「跳不跳目标续起」是同一个同步决定，所以取不能延后；发不出去就得放得回来，
   * 否则那条消息既没跑也不在队列里，卡片消失而什么都没发生。
   */
  enqueueFront(conversationId: ConversationId, item: FollowUp): void {
    const list = this.queues.get(conversationId) ?? []
    if (list.some((f) => f.id === item.id)) return
    this.setQueue(conversationId, [item, ...list])
  }

  /** 删掉一条。返回 false = 这条不在队列里（客户端点的时候它已经被消费了）。 */
  removeFollowUp(conversationId: ConversationId, id: string): boolean {
    const list = this.queues.get(conversationId)
    const next = (list ?? []).filter((f) => f.id !== id)
    if (!list || next.length === list.length) return false
    this.setQueue(conversationId, next)
    return true
  }

  /** 翻转某一条的去向。返回 false = 这条不在队列里。 */
  setSteer(conversationId: ConversationId, id: string, steer: boolean): boolean {
    const list = this.queues.get(conversationId)
    if (!list?.some((f) => f.id === id)) return false
    this.setQueue(
      conversationId,
      list.map((f) => (f.id === id ? { ...f, steer } : f)),
    )
    return true
  }

  /** 取走全部标了「调整方向」的条目，按入队序。run 内的 step 边界调它。 */
  takeSteered(conversationId: ConversationId): FollowUp[] {
    const list = this.queues.get(conversationId) ?? []
    const taken = list.filter((f) => f.steer)
    if (!taken.length) return []
    this.setQueue(
      conversationId,
      list.filter((f) => !f.steer),
    )
    return taken
  }

  /** 取走队首。run 收尾时调它，火发为下一轮。 */
  takeNext(conversationId: ConversationId): FollowUp | null {
    const list = this.queues.get(conversationId) ?? []
    const head = list[0]
    if (!head) return null
    this.setQueue(conversationId, list.slice(1))
    return head
  }

  /**
   * 把余下条目的去向全部复位成「加入队列」。
   *
   * **「调整方向」只对发出它时的那一轮成立。** 这一轮已经收尾了，没赶上边界的
   * 那些条目再没有可注入的地方；留着 `steer=true` 的话，下一轮一起跑就会把它们
   * 注入到一轮用户没有指向过的执行里。
   */
  resetSteer(conversationId: ConversationId): void {
    const list = this.queues.get(conversationId)
    if (!list?.some((f) => f.steer)) return
    this.setQueue(
      conversationId,
      list.map((f) => ({ ...f, steer: false })),
    )
  }

  /** 空队列不留空数组：`queueOf` 与「有没有排着的」两处判据因此只有一种写法。 */
  private setQueue(conversationId: ConversationId, next: FollowUp[]): void {
    if (next.length) this.queues.set(conversationId, next)
    else this.queues.delete(conversationId)
    this.announceQueue(conversationId)
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
