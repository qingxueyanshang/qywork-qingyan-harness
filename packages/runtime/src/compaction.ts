/**
 * `CompactionPort` 的实际装配。
 *
 * loop 只知道「投影历史」和「跑一次压缩」两个动作；manifest 存在哪张表、
 * 待压缩的消息与动作怎么取，全在这一层。
 */

import type { CompactionPort, Summarizer } from '@qywork/agent'
import { compact, projectManifest } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import type { CompactionManifest, ConversationId, MessageId } from '@qywork/core'
import {
  getConversation,
  listMessages,
  listRuns,
  listSteps,
  type Store,
  setCompactionManifest,
} from '@qywork/store'

export interface CompactionDeps {
  store: Store
  conversationId: ConversationId
  /** run 创建时定格的消息高水位，压缩范围不得越过它。 */
  messageIdUpperBound: MessageId | null
  /** 摘要生成器。null = 只用本地确定性降级。 */
  summarize: Summarizer | null
}

export class RuntimeCompaction implements CompactionPort {
  /**
   * 内存里的当前 manifest。
   *
   * 读一次缓存住而不是每次投影都查库：投影在**每次构造请求**时都会调用，
   * 一轮几十次，每次一个 SQL 查询纯属浪费。压缩由本对象自己执行，所以它总是知道最新值。
   */
  private manifest: CompactionManifest | null

  constructor(private readonly deps: CompactionDeps) {
    this.manifest = getConversation(deps.store, deps.conversationId)?.compactionManifest ?? null
  }

  /**
   * 投影历史。
   *
   * 被压掉的那段换成「摘要 + 事实清单」两条消息，未压的部分原样保留。
   *
   * 判断边界用 `_messageId` 而不是数组下标：history 里除了会话消息还可能夹着
   * 尾区注记，按下标切会把它们一起切掉。
   */
  project(history: WireMessage[]): WireMessage[] {
    const m = this.manifest
    if (!m?.compactedThroughMessageId) return history

    const through = m.compactedThroughMessageId
    const kept = history.filter((msg) => {
      const id = (msg as { _messageId?: string })._messageId
      // 没有消息 id 的（尾区注记等）一律保留——它们不属于被压缩的会话历史。
      if (!id) return true
      return id > through
    })

    // 一条都没压掉说明 manifest 与当前历史对不上（换了会话、消息被删）。
    // 这时投影只会平白多两条消息，原样返回更安全。
    if (kept.length === history.length) return history

    return [
      ...projectManifest(m).map((p) => ({
        role: p.role,
        content: p.content,
        _group: 'summary' as const,
      })),
      ...kept,
    ]
  }

  async run() {
    const { store, conversationId, messageIdUpperBound } = this.deps

    const all = listMessages(store, conversationId, messageIdUpperBound)
    // 末尾两条不压：最近一次问答是模型当前正在处理的东西，压掉它等于让模型
    // 忘记自己刚被问了什么。压缩要削的是**远期**历史。
    const target = all.slice(0, Math.max(0, all.length - 2))
    const through = this.manifest?.compactedThroughMessageId
    const fresh = through ? target.filter((m) => m.id > through) : target

    const outcome = await compact(
      {
        messages: fresh.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          hasAttachments: m.attachments.length > 0,
        })),
        actions: this.collectActions(fresh),
        previous: this.manifest,
      },
      this.deps.summarize,
    )

    if (outcome.status === 'compacted') {
      // 先落库再更新内存：反过来的话中途崩溃会留下「内存说压过了、库里没有」的状态，
      // 下次启动投影就丢了，而模型会突然又看到全部历史。
      setCompactionManifest(store, conversationId, outcome.manifest)
      this.manifest = outcome.manifest
    }
    return outcome
  }

  /**
   * 收集待压缩范围内的工具动作。
   *
   * 只取已终结的 step：还在 running 的动作结果未知，把「未知」写进事实包
   * 会让模型以为它已经完成了。
   */
  private collectActions(messages: { id: MessageId }[]): {
    stepId: string
    tool: string
    status: string
    target: string | null
    summary: string
    errorCode?: string | null
  }[] {
    if (messages.length === 0) return []
    const lastId = messages[messages.length - 1]!.id
    const out: ReturnType<RuntimeCompaction['collectActions']> = []

    for (const run of listRuns(this.deps.store, this.deps.conversationId)) {
      // 只要高水位在压缩范围内的 run。
      if (run.userMessageId && run.userMessageId > lastId) continue
      for (const step of listSteps(this.deps.store, run.id)) {
        if (step.kind !== 'tool_action') continue
        if (step.status === 'running') continue
        const payload = step.payload as {
          action?: { target?: string | null }
          outcome?: { message?: string; errorKind?: string }
        } | null
        out.push({
          stepId: `${run.id}:${step.id}`,
          tool: step.toolName ?? 'unknown',
          status: step.status,
          target: payload?.action?.target ?? null,
          summary: payload?.outcome?.message ?? '',
          errorCode: payload?.outcome?.errorKind ?? null,
        })
      }
    }
    return out
  }
}
