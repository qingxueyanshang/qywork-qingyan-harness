/**
 * 事件总线。
 *
 * 手机端在电梯里、地铁上断线是常态，所以重连语义是这里的头等设计目标，不是补丁：
 *
 * - 每个事件有全局单调 seq，客户端重连时报上 `lastSeq`，服务端补发缺口。
 * - 保留窗口是**环形缓冲**，不是无界数组——一个跑了两小时的 run 能产生几十万条
 *   事件，无界保留会把内存吃光。
 * - 缺口超出保留窗口时明确回 `resync`，让客户端改走全量拉取，而不是悄悄少几条
 *   事件、让 UI 停在一个不完整的状态上还以为自己是对的。
 */

import type { AgentEvent, ConversationId, EventEnvelope, ResumePosition } from '@qywork/core'

/** 保留窗口。够覆盖几分钟的断线；再长就该走全量重拉了。 */
const RETAIN = 5000

export interface Subscriber {
  id: string
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
  /**
   * 订阅哪些会话。
   *
   * **`null` 和空集是两件事，不能让集合大小兼任这个语义位。**
   * `null` = 还没声明过，会话事件全收（首连时界面还不知道自己要看哪一条）；
   * 空 `Set` = 明确声明「一条会话事件都不要」。
   *
   * **别把空集当成全订阅**：前端切项目时发 `subscribe([])`，本意是退订，
   * 当成全订阅的话所有会话的事件会一起涌向这个客户端，
   * 而客户端无条件把它们写进当前 transcript。
   *
   * 两种状态都不影响工作区级事件（帧上没有 conversationId 的那些），它们人人可见。
   */
  conversations: Set<ConversationId> | null
  send(frame: EventEnvelope): void
}

/**
 * 这一帧对这个订阅者可见吗。
 *
 * **实时推送和断线补发必须走同一个判据**，所以它是模块级函数而不是方法：
 * 补发路径上少了这一步，按会话隔离就只在一半的路上成立。
 */
function visibleTo(sub: Subscriber, frame: EventEnvelope): boolean {
  if (!frame.conversationId) return true // 工作区级事件（git 状态等）人人可见
  if (sub.conversations === null) return true // 还没声明过订阅
  return sub.conversations.has(frame.conversationId)
}

export class EventBus {
  /**
   * 这条流的身份，进程内唯一。**seq 只在同一条流里有意义。**
   *
   * 没有它的时候，`replayFrom` 只能拿大小比：重启后的新总线 `seq=0`，
   * 客户端带着上一代的 `lastSeq=800` 过来，`800 >= 0` 就被判成「已是最新」。
   * 而它真正错过的是上一代服务最后那几条——包括那一轮的终态。
   */
  readonly streamId: string = crypto.randomUUID()
  private seq = 0
  private readonly ring: EventEnvelope[] = []
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
   * 归属**写进帧里**，不再只活在这次调用的参数上。
   *
   * **不要存进一个 `WeakMap<AgentEvent, ConversationId>`**：真正需要它的两处
   * （断线补发、客户端）都够不着那个 map。随帧走，三处才是同一份事实。
   */
  publish(event: AgentEvent, conversationId?: ConversationId): EventEnvelope {
    const frame: EventEnvelope = {
      seq: ++this.seq,
      at: Date.now(),
      ...(conversationId ? { conversationId } : {}),
      event,
    }

    this.ring.push(frame)
    if (this.ring.length > RETAIN) this.ring.shift()

    for (const sub of this.subscribers.values()) {
      if (!visibleTo(sub, frame)) continue
      try {
        sub.send(frame)
      } catch {
        // 单个客户端发送失败（socket 已关）不能影响其他订阅者。
        // 清理交给 close 事件，这里不动 map，避免遍历中改结构。
      }
    }
    return frame
  }

  /**
   * 断线补发。
   *
   * **按订阅过滤。** 这条路上没有过滤的话，环里留着 5000 帧，重连一次就把窗口内
   * 所有会话的事件灌给这个客户端，而它正开着其中某一条——那不是「多收了几条」，
   * 是内容串台，而且看起来完全合理。
   *
   * 返回 null 表示缺口补不上，客户端必须重新拉全量。
   *
   * **「补不补得上」只有这一处裁决**，所以流身份也在这里判、不在握手里判——
   * 拆成两处的话，「你落后了多少」和「你说的落后是不是我这条流上的事」
   * 就成了两个可以各自改坏的判断。
   */
  replayFrom(from: ResumePosition, sub: Subscriber): EventEnvelope[] | null {
    // 不是这条流上的坐标 → 缺口无从计算，只能全量重拉。这不是「保守起见」，
    // 是那个数字在这里确实没有含义：新流的 seq 从 0 重新数起。
    if (from.streamId !== this.streamId) return null
    if (from.lastSeq >= this.seq) return []
    const oldest = this.ring[0]
    // 环里最老的一条比客户端下一条需要的还新 → 中间那段已经被挤掉了。
    if (!oldest || oldest.seq > from.lastSeq + 1) return null
    return this.ring.filter((f) => f.seq > from.lastSeq && visibleTo(sub, f))
  }

  subscriberCount(): number {
    return this.subscribers.size
  }
}
