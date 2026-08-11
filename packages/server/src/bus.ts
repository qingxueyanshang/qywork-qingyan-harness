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

import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'

/** 保留窗口。够覆盖几分钟的断线；再长就该走全量重拉了。 */
const RETAIN = 5000

export interface Subscriber {
  id: string
  origin: 'desktop' | 'mobile' | 'cli' | 'external'
  /** 只订阅这些会话；空集合=全订阅。省手机流量。 */
  conversations: Set<ConversationId>
  send(frame: EventEnvelope): void
}

export class EventBus {
  private seq = 0
  private readonly ring: EventEnvelope[] = []
  private readonly subscribers = new Map<string, Subscriber>()
  /** 事件 → 所属会话，用于按订阅过滤。 */
  private readonly conversationOf = new WeakMap<AgentEvent, ConversationId>()

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

  publish(event: AgentEvent, conversationId?: ConversationId): EventEnvelope {
    const frame: EventEnvelope = { seq: ++this.seq, at: Date.now(), event }
    if (conversationId) this.conversationOf.set(event, conversationId)

    this.ring.push(frame)
    if (this.ring.length > RETAIN) this.ring.shift()

    for (const sub of this.subscribers.values()) {
      if (!this.visibleTo(sub, conversationId)) continue
      try {
        sub.send(frame)
      } catch {
        // 单个客户端发送失败（socket 已关）不能影响其他订阅者。
        // 清理交给 close 事件，这里不动 map，避免遍历中改结构。
      }
    }
    return frame
  }

  private visibleTo(sub: Subscriber, conversationId?: ConversationId): boolean {
    if (sub.conversations.size === 0) return true
    if (!conversationId) return true // 全局事件（git 状态等）人人可见
    return sub.conversations.has(conversationId)
  }

  /**
   * 断线补发。
   * 返回 null 表示缺口已超出保留窗口，客户端必须重新拉全量。
   */
  replayFrom(lastSeq: number): EventEnvelope[] | null {
    if (lastSeq >= this.seq) return []
    const oldest = this.ring[0]
    // 环里最老的一条比客户端下一条需要的还新 → 中间那段已经被挤掉了。
    if (!oldest || oldest.seq > lastSeq + 1) return null
    return this.ring.filter((f) => f.seq > lastSeq)
  }

  subscriberCount(): number {
    return this.subscribers.size
  }
}
