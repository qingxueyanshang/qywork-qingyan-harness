/**
 * Run 管理器。
 *
 * 三项职责：并发控制、中断，以及**进程内的会话意图**：自动继续标记（`GoalArm`）
 * 与跟进消息队列（`FollowUp`）。后两者遵循同一原则：它们是关于下一步操作
 * 的意图，不是账本事实，因此一律不写入磁盘，进程重启即清空。
 *
 * 并发控制只负责**本进程**：占位表缓存本进程正在运行的会话，用于在同步块中拦截
 * 本进程的第二次启动、将消息排入队列、广播忙态。同一会话是否被另一个进程（终端的 qy）
 * 占用，由账本的 `createRun` 在创建轮次的写事务中判定，被占用时抛出 `ConversationBusyError`。
 *
 * **此处不向用户询问。** 工具授权由 `Session.decide()` 就地裁决（`full` 全部放行，`auto` 下声明了
 * 命令行的调用经 `decideCommand` 的静态规则判定），
 * 被拒的调用以 `tool.finished{status:'failure', errorKind:'permission_denied'}` 呈现。
 * 本产品只有 `auto` / `full` 两种模式，没有逐次询问模式。
 */

import type { ConversationId, FollowUp, RunId } from '@qywork/core'
import type { Store } from '@qywork/store'
import { listConversations } from '@qywork/store'
import type { EventBus } from './bus.ts'

/** 忙态需要向运行表查询的两项。完整的运行表位于 `subagents.ts`，此处只需要这两项查询。 */
export interface SubagentInflight {
  has(conversationId: ConversationId): boolean
  conversations(): ConversationId[]
}

/**
 * 一个被占用的会话。中止句柄自占位时起持有，`runId` 在本轮写入 run 行之后补入，此前为 null。
 *
 * 中断、忙态与更新认领都只读这一项：句柄在占位时即已登记，准备阶段（写入 run 行之前）的停止同样生效。
 */
interface Occupancy {
  controller: AbortController
  runId: RunId | null
}

/**
 * 自动继续标记：该会话处于自动循环中，下一轮应按该目标的此版本发起。
 *
 * **保存在此处，且不写入磁盘。** 循环是否开启是**进程内**的事实，不是账本中的事实。写入磁盘
 * 时，一个失控后崩溃的循环会在下次启动时自动恢复，而用户并未再次点击「继续」。保存在 `RunManager`
 * 中即等价于不持久化：进程重启即清空，账本中 `active` 的目标保持不变，等待用户明确点击继续
 * （`goal.resume`）。
 *
 * **不关联 Session**：服务端每条消息新建一个 Session，其生命期不超过该条消息，
 * 关联到 Session 时循环最多执行一轮。
 *
 * `revision` 是本次自动继续的**预留版本**：实际发起之前重新读取目标，不一致时丢弃本次
 * 排队且不增加轮数：中途被修改的目标不应按旧版本继续执行。
 */
export interface GoalArm {
  goalId: string
  revision: number
}

export class RunManager {
  /** 同一会话同时只允许一项占用：两个 run 并发修改同一批文件必然相互冲突。见 `reserve()`。 */
  private readonly occupied = new Map<string, Occupancy>()
  private updateClaimed = false

  /** 基于现有忙态集合原子地占用退出时机；不设单独的任务计数。 */
  claimUpdate(): boolean {
    if (
      this.armed.size ||
      this.busyConversations().length ||
      [...this.queues.values()].some((q) => q.length)
    )
      return false
    this.updateClaimed = true
    return true
  }

  cancelUpdate(): void {
    this.updateClaimed = false
  }

  get updating(): boolean {
    return this.updateClaimed
  }
  /** 每个会话最多一条自动继续标记。见 `GoalArm`。 */
  private readonly armed = new Map<string, GoalArm>()
  /**
   * 排队中的跟进消息，按会话划分。**仅存在于进程内，不写入磁盘**，理由同 `GoalArm`。
   *
   * 代价明确：进程崩溃时，队列中尚未执行的正文将丢失，卡片随之消失。这与本仓库中
   * 输入框未发送的草稿在刷新后丢失属于同一级别，且丢失对用户可见。
   * 改为写入磁盘需要增加两条路径（删除卡片变为删除一行记录、定义崩溃残留行的终态），
   * 而它们服务的仍是进程内的意图。
   */
  private readonly queues = new Map<string, FollowUp[]>()

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    /**
     * 运行中的子 agent（`subagents.ts`）。忙态包含它，**启动轮次的检查不包含**：
     * 子 agent 运行时不应阻止该会话启动新一轮。
     */
    private readonly subagents: SubagentInflight,
  ) {}

  /**
   * 该会话是否被占用：有一轮正在运行（含已占位但尚未取得 runId 的），或正在手动压缩。
   *
   * **启动轮次的检查只依据它。** 子 agent 运行时仍可发送消息、启动下一轮，这正是
   * 回执的路径：空闲时立即启动一轮。若以 `isBusy` 作为检查条件，回执与用户的消息
   * 都会排入一个无人消费的队列。
   */
  hasRun(conversationId: ConversationId): boolean {
    return this.occupied.has(conversationId)
  }

  /**
   * 该会话当前运行中轮次的 id。已占位但尚未取得 runId 时为 null。
   *
   * **只有它能确定当前运行的轮次。** 账本中的 `runs.status` 在服务进程崩溃
   * 之后可能仍为 `running`，据此取值会将早已结束的 run 当作运行中。
   */
  currentRunId(conversationId: ConversationId): RunId | null {
    return this.occupied.get(conversationId)?.runId ?? null
  }

  /**
   * 该会话当前是否在执行：有 run，或有已派发但未返回的子 agent。
   *
   * **界面与停止按钮依据它。** 只依据 run 时，只有子 agent 在运行的会话在界面上
   * 显示为空闲，停止按钮不显示，用户无法停止这些子 agent。
   */
  isBusy(conversationId: ConversationId): boolean {
    return this.hasRun(conversationId) || this.subagents.has(conversationId)
  }

  /** 当前忙碌的全部会话。握手快照读取它，见 `HelloOkFrame.busyConversations`。 */
  busyConversations(): ConversationId[] {
    return [
      ...new Set([...this.occupied.keys(), ...this.subagents.conversations()]),
    ] as ConversationId[]
  }

  /**
   * 广播该会话的忙闲状态。**忙态的每个变更点各调用一次，其他位置不得发布该事件。**
   * 变更点为本类中的两处（占位、释放）以及任务派发通道的两处
   * （子 agent 派发、子 agent 结束）。
   *
   * 两个约束：
   *
   * - **发布时不带 `conversationId`**（第二个参数留空）：它是工作区级事件，
   *   所有客户端都必须收到。带上即按订阅过滤，只有打开该会话的客户端
   *   能收到，而需要该事件的正是未打开该会话的客户端。
   * - **实时计算 `isBusy()`，不接受调用方传入的值**：释放占位之后该会话仍可能因
   *   子 agent 而忙碌，释放处传入字面量 false 会报告一个当前不成立的状态。
   */
  announce(conversationId: ConversationId): void {
    this.bus.publish({
      type: 'conversation.busy',
      conversationId,
      busy: this.isBusy(conversationId),
    })
    this.wake(conversationId)
  }

  /** 等待该会话的忙态或队列变化的调用方。见 `changed`。 */
  private readonly watchers = new Map<string, Set<() => void>>()

  /**
   * 等到该会话的忙态或跟进消息队列下一次变化（`announce` / `announceQueue`），返回 true；`timeoutMs` 到期返回 false；
   * `signal` 中止时以中止原因拒绝。只报告发生了变化，变化后的状态由调用方重新读取。
   */
  changed(
    conversationId: ConversationId,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const watchers = this.watchers.get(conversationId) ?? new Set()
      this.watchers.set(conversationId, watchers)
      const settle = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        watchers.delete(wake)
        if (!watchers.size) this.watchers.delete(conversationId)
      }
      const wake = () => {
        settle()
        resolve(true)
      }
      const abort = () => {
        settle()
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        settle()
        resolve(false)
      }, timeoutMs)
      watchers.add(wake)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  private wake(conversationId: ConversationId): void {
    for (const wake of [...(this.watchers.get(conversationId) ?? [])]) wake()
  }

  /**
   * 占用一个会话，**同步**完成检查与登记，`controller` 是这次占用的中止句柄。
   *
   * **检查与登记必须位于同一个同步块中**。拆分为 `isBusy()` 检查与之后某处的
   * 登记时，二者之间隔着创建 Session、读取历史附件、等待首个带 runId 的事件等多个
   * await：桌面端与手机端几乎同时发送消息时，两次检查都读到 false，
   * 两个 AgentLoop 因此同时写入同一个工作区。
   * JS 是单线程的，同步块内的操作是原子的。
   *
   * 句柄必须在此处一并登记：只登记占位、待取得 runId 后才登记句柄时，准备阶段的停止指令没有
   * 可中止的对象，该轮在准备结束后照常开始。
   *
   * 返回 false 表示已有任务在运行，调用方必须直接拒绝。
   */
  reserve(conversationId: ConversationId, controller: AbortController): boolean {
    if (this.updateClaimed || this.hasRun(conversationId)) return false
    this.occupied.set(conversationId, { controller, runId: null })
    this.announce(conversationId)
    return true
  }

  /** 释放占用。占用方在结束时调用且只调用一次：不释放时之后的每条消息都以「已有任务在执行」被拒绝。 */
  release(conversationId: ConversationId): void {
    this.occupied.delete(conversationId)
    this.announce(conversationId)
  }

  /**
   * 补入本轮的 runId；本轮结束而占用方仍持有占位时（派发方等待重新派发）置回 null，
   * 否则 `currentRunId` 在等待期间报告一个已结束的轮次。调用前须已由 `reserve` 占用该会话；
   * 忙态不变，因此不广播。
   */
  register(conversationId: ConversationId, runId: RunId | null): void {
    this.occupied.get(conversationId)!.runId = runId
  }

  /** 记录（或刷新）自动继续标记。目标每次变更版本都要重新记录，见 `GoalArm`。 */
  arm(conversationId: ConversationId, arm: GoalArm): void {
    this.armed.set(conversationId, arm)
  }

  /**
   * 解除自动继续标记。
   *
   * 用户发送消息、目标进入终态、本轮被中断，三种情况均调用此处。
   * **用户消息优先**由此实现：用户发送消息后，排队中的自动继续即作废。
   */
  disarm(conversationId: ConversationId): void {
    this.armed.delete(conversationId)
  }

  armedOf(conversationId: ConversationId): GoalArm | null {
    return this.armed.get(conversationId) ?? null
  }

  // ─────────────────────────── 跟进消息队列 ───────────────────────────

  /**
   * 广播该会话的队列。**下方每个变更点各调用一次，其他位置不得发布该事件。**
   *
   * 发布完整快照而不是增量：客户端另有一份乐观添加的本地卡片，
   * 服务端按 id 去重一条时，两份增量记录必然不一致。
   *
   * 发布时带 `conversationId`（与 `conversation.busy` 相反）：卡片只出现在已打开的
   * 该会话中，其他客户端收到后没有用途。
   */
  private announceQueue(conversationId: ConversationId): void {
    this.bus.publish(
      { type: 'queue.changed', conversationId, queue: this.queueOf(conversationId) },
      conversationId,
    )
    this.wake(conversationId)
  }

  /** 该会话排队中的跟进消息。返回副本：调用方用它发送事件，不应修改内部数据。 */
  queueOf(conversationId: ConversationId): FollowUp[] {
    return [...(this.queues.get(conversationId) ?? [])]
  }

  /**
   * 排入一条跟进消息。**按 id 幂等**：`id` 即指令的 `clientRequestId`，
   * 重连后补发同一条指令时不应排入两条。
   */
  enqueue(conversationId: ConversationId, item: FollowUp): void {
    const list = this.queues.get(conversationId) ?? []
    if (list.some((f) => f.id === item.id)) return
    list.push(item)
    this.queues.set(conversationId, list)
    this.announceQueue(conversationId)
  }

  /**
   * 将一条已取出的消息放回队首。
   *
   * **仅用于取出后未能发送的情况**（结束阶段发起时会话再次变为忙碌）。取出与
   * 是否跳过目标自动继续是同一个同步决定，因此取出不能延后；无法发送时必须放回，
   * 否则该消息既未执行也不在队列中，卡片消失而没有任何执行。
   */
  enqueueFront(conversationId: ConversationId, item: FollowUp): void {
    const list = this.queues.get(conversationId) ?? []
    if (list.some((f) => f.id === item.id)) return
    this.setQueue(conversationId, [item, ...list])
  }

  /** 删除一条。返回 false 表示该条不在队列中（客户端点击时它已被消费）。 */
  removeFollowUp(conversationId: ConversationId, id: string): boolean {
    const list = this.queues.get(conversationId)
    const next = (list ?? []).filter((f) => f.id !== id)
    if (!list || next.length === list.length) return false
    this.setQueue(conversationId, next)
    return true
  }

  /** 切换某一条的去向。返回 false 表示该条不在队列中。 */
  setSteer(conversationId: ConversationId, id: string, steer: boolean): boolean {
    const list = this.queues.get(conversationId)
    if (!list?.some((f) => f.id === id)) return false
    this.setQueue(
      conversationId,
      list.map((f) => (f.id === id ? { ...f, steer } : f)),
    )
    return true
  }

  /** 取出全部标记为「调整方向」的条目，按入队顺序。由 run 内的 step 边界调用。 */
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

  /** 取出队首。run 结束时调用，取出的条目用于发起下一轮。 */
  takeNext(conversationId: ConversationId): FollowUp | null {
    const list = this.queues.get(conversationId) ?? []
    const head = list[0]
    if (!head) return null
    this.setQueue(conversationId, list.slice(1))
    return head
  }

  /**
   * 将剩余**用户**条目的去向重置为「加入队列」。
   *
   * **「调整方向」只对发出时的轮次有效。** 该轮已结束，未赶上 step 边界的
   * 条目已无处注入；保留 `steer=true` 时，下一轮开始执行时会将它们
   * 注入到用户并未指定的轮次中。
   *
   * **带 `origin` 的回执不重置**：其语义是在下一次机会交给模型，
   * 不指向特定轮次。重置后，父轮非正常结束时它要等下一轮执行完毕才单独启动一轮，
   * 比用户的后续消息晚一整轮到达模型。
   */
  resetSteer(conversationId: ConversationId): void {
    const list = this.queues.get(conversationId)
    if (!list?.some((f) => f.steer && !f.origin)) return
    this.setQueue(
      conversationId,
      list.map((f) => (f.origin ? f : { ...f, steer: false })),
    )
  }

  /** 空队列不保留空数组：`queueOf` 与「是否存在排队项」两处判据因此只有一种写法。 */
  private setQueue(conversationId: ConversationId, next: FollowUp[]): void {
    if (next.length) this.queues.set(conversationId, next)
    else this.queues.delete(conversationId)
    this.announceQueue(conversationId)
  }

  /**
   * 中断占用该会话的执行：运行中的轮次、准备阶段尚未写入 run 行的轮次，或手动压缩。
   * 返回 false 表示该会话没有被占用。
   */
  interruptConversation(conversationId: ConversationId): boolean {
    const entry = this.occupied.get(conversationId)
    if (!entry) return false
    entry.controller.abort({ source: 'user', observedAt: Date.now() })
    return true
  }

  interruptAll(): void {
    const observedAt = Date.now()
    for (const entry of this.occupied.values()) {
      entry.controller.abort({ source: 'server_shutdown', observedAt })
    }
  }

  conversationsOf(workspaceId: string): ConversationId[] {
    return listConversations(this.store, workspaceId as never).map((c) => c.id)
  }
}
