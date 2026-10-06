/**
 * 事件总线。
 *
 * 手机端在移动网络下频繁断线，因此重连语义是本模块的首要设计目标：
 *
 * - 每个事件有全局单调 seq，客户端重连时上报 `lastSeq`，服务端补发缺口。
 * - 保留窗口是**环形缓冲**，不是无界数组：运行两小时的 run 可产生几十万条
 *   事件，无界保留会耗尽内存。**帧数与字节数两条上限缺一不可**：单帧大小无上限，
 *   只限制帧数无法限制内存。
 * - 缺口超出保留窗口时明确返回 `resync`，使客户端改为全量拉取，而不是静默缺少若干条
 *   事件，使界面停留在不完整的状态且没有任何提示。
 */

import type { AgentEvent, ConversationId, EventEnvelope, ResumePosition } from '@qywork/core'

/** 保留窗口。足以覆盖几分钟的断线；更长的断线应改为全量重新拉取。 */
const RETAIN = 5000

/**
 * 保留窗口的字节上限。
 *
 * 只限制帧数无法限制内存：一帧 `tool.delta` 带一整段命令输出，实测单帧约 109 KB，
 * 5000 帧即为几百 MB。32 MB 约合 300 帧最大 delta，仍足以覆盖几分钟的断线；
 * 超出部分按同一路径淘汰，客户端使用既有的 `resync`。
 *
 * 覆盖时长实测（每轮 12 秒的固定负载，直接读取环中最早帧与最新帧的时刻差）：每轮
 * `run_command` 输出 1.8 MB 时环由该字节上限约束，窗口 264 秒；每轮输出 8 KB 时
 * 先达到 `RETAIN` 的 5000 帧，窗口约 56 分钟。
 */
const RETAIN_BYTES = 32 * 1024 * 1024

export interface Subscriber {
  id: string
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
  /**
   * 订阅的会话。
   *
   * **`null` 与空集含义不同，不能用集合大小同时表示这两种语义。**
   * `null` 表示尚未声明，接收全部会话事件（首次连接时界面尚未确定要查看哪一条会话）；
   * 空 `Set` 表示明确声明不接收任何会话事件。
   *
   * **不要把空集当作全订阅**：前端切换项目时发送 `subscribe([])`，意图是退订；
   * 当作全订阅时，所有会话的事件都会发送到该客户端，
   * 而客户端会无条件将其写入当前 transcript。
   *
   * 两种状态都不影响工作区级事件（帧上没有 conversationId 的事件），它们对所有订阅者可见。
   */
  conversations: Set<ConversationId> | null
  send(frame: EventEnvelope): void
}

/**
 * 判断一帧对指定订阅者是否可见。
 *
 * **实时推送和断线补发必须使用同一个判据**，因此它是模块级函数而不是方法：
 * 补发路径上缺少这一步时，按会话隔离只在其中一条路径上成立。
 */
function visibleTo(sub: Subscriber, frame: EventEnvelope): boolean {
  if (!frame.conversationId) return true // 工作区级事件（git 状态等）对所有订阅者可见
  if (sub.conversations === null) return true // 尚未声明订阅
  return sub.conversations.has(frame.conversationId)
}

export class EventBus {
  /**
   * 该流的身份，进程内唯一。**seq 只在同一条流中有意义。**
   *
   * 缺少流身份时，`replayFrom` 只能比较大小：重启后的新总线 `seq=0`，
   * 客户端以上一代的 `lastSeq=800` 重连，`800 >= 0` 即被判定为「已是最新」，
   * 而它实际错过的是上一代服务的最后几条事件，包括该轮的终态。
   */
  readonly streamId: string = crypto.randomUUID()
  private seq = 0
  /**
   * 保留窗口。字节数与帧存放在一起，入环时计算一次：分为两个数组会导致两者不一致。
   */
  private readonly ring: { frame: EventEnvelope; bytes: number }[] = []
  private ringBytes = 0
  private readonly subscribers = new Map<string, Subscriber>()

  get currentSeq(): number {
    return this.seq
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.set(sub.id, sub)
    return () => this.subscribers.delete(sub.id)
  }

  setSubscription(id: string, conversations: ConversationId[]): void {
    const sub = this.subscribers.get(id)
    if (!sub) return
    sub.conversations = new Set(conversations)
  }

  /**
   * 归属**写入帧中**，不只存在于本次调用的参数中。
   *
   * **不要存入 `WeakMap<AgentEvent, ConversationId>`**：需要归属的两处
   * （断线补发、客户端）都无法访问该 map。归属随帧传递，三处使用的才是同一份事实。
   */
  publish(event: AgentEvent, conversationId?: ConversationId): EventEnvelope {
    const frame: EventEnvelope = {
      seq: ++this.seq,
      at: Date.now(),
      ...(conversationId ? { conversationId } : {}),
      event,
    }

    const bytes = JSON.stringify(frame).length
    this.ring.push({ frame, bytes })
    this.ringBytes += bytes
    // 最新一帧保留不淘汰：单帧超过整个预算时若清空环，每次重连都会触发 resync。
    while (this.ring.length > RETAIN || (this.ringBytes > RETAIN_BYTES && this.ring.length > 1)) {
      const dropped = this.ring.shift()
      if (!dropped) break
      this.ringBytes -= dropped.bytes
    }

    for (const sub of this.subscribers.values()) {
      if (!visibleTo(sub, frame)) continue
      try {
        sub.send(frame)
      } catch {
        // 单个客户端发送失败（socket 已关闭）不能影响其他订阅者。
        // 清理由 close 事件负责，此处不修改 map，避免遍历过程中修改结构。
      }
    }
    return frame
  }

  /**
   * 断线补发。
   *
   * **按订阅过滤。** 该路径不过滤时，环中保留 5000 帧，一次重连就会将窗口内
   * 所有会话的事件发送给该客户端，而它正打开其中一条会话：后果不是多出若干条事件，
   * 而是其他会话的内容混入当前会话，且没有任何异常迹象。
   *
   * 返回 null 表示缺口无法补发，客户端必须重新拉取全量。
   *
   * **能否补发只在此处裁决**，因此流身份也在此处判定，不在握手中判定：
   * 拆分为两处时，「落后多少」与「该落后是否属于本流」会成为两个
   * 可能分别被改错的判断。
   */
  replayFrom(from: ResumePosition, sub: Subscriber): EventEnvelope[] | null {
    // 不属于本流的位置 → 缺口无法计算，只能全量重新拉取。这不是保守处理，
    // 而是该数值在本流中确实没有含义：新流的 seq 从 0 重新计数。
    if (from.streamId !== this.streamId) return null
    if (from.lastSeq >= this.seq) return []
    const oldest = this.ring[0]
    // 环中最早的一条比客户端需要的下一条更新 → 中间的事件已被淘汰。
    if (!oldest || oldest.frame.seq > from.lastSeq + 1) return null
    return this.ring
      .filter((e) => e.frame.seq > from.lastSeq && visibleTo(sub, e.frame))
      .map((e) => e.frame)
  }

  subscriberCount(): number {
    return this.subscribers.size
  }
}
