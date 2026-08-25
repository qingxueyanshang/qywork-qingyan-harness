/**
 * 上下文面板的投影。
 *
 * **为什么是「按会话现算」而不是「事件里带着」。** 事件只在 run 跑着的时候流。切一次会话、刷一次页
 * 面，面板就空了——而用户是在**回头看**的时候才想知道「上下文被谁占的」。所以真源是账本，面板是
 * 它的投影，任何时刻可查。
 *
 * **总数只有一把尺。** `total` 取**最近一次带 usage 回报的请求**的 provider 真值。
 * 这里刻意不做 `max(全量估算, provider真值)`——那两个数出自两把尺，
 * 锚点一失效显示值就从真值尺跌到估算尺，会话内容没变而数字掉三分之一，
 * 界面上没有任何一处能解释它。
 *
 * 没有任何带 usage 的请求时才退回本地测得值，并把 `source` 标成 `estimated`。
 * **标签必须跟着数走**：用户要能一眼看出这个数能不能拿来做决定。
 */

import { softLimit } from '@qywork/agent'
import type { ContextBreakdown, ContextOmitted, ConversationId } from '@qywork/core'
import { emptyBreakdown, emptyOmitted, reconcileBreakdown } from '@qywork/core'
import { latestAnchoredProviderRequest, latestSentProviderRequest, type Store } from '@qywork/store'

export interface ContextPanel {
  total: number
  limit: number
  /** 一位小数。1M 窗口下取整会把 2139 显示成 0%。 */
  percent: number
  source: 'actual' | 'estimated'
  /**
   * 越过它就会在下一次发送前压一次。
   *
   * **必须调 `softLimit` 而不是在这里照抄那个算式**：两处各写一遍，改了一处
   * 面板上的刻度就指向一个不会发生的位置，而不会有任何报错。
   */
  compactAt: number
  breakdown: ContextBreakdown
  omitted: ContextOmitted
  freeSpace: number
}

/**
 * provider 回报的上下文占用。
 *
 * 四项相加而不是只取 `inputTokens`：qywork 三个适配器已经把 `inputTokens`
 * 统一收敛成**排除缓存**的口径（见 `openai-compat.ts` 里那段注释），
 * 所以只取它会把命中缓存的那一大段漏掉——冻结前缀设计下第二轮起大头正是
 * cache_read，漏掉它会让 100k 的会话显示成不到 1%。
 *
 * 加上 output 是因为这一轮的输出会成为下一轮输入的一部分，
 * 面板回答的是「下一轮还剩多少空间」。
 */
function anchorTokens(r: {
  providerInputTokens: number | null
  providerOutputTokens: number | null
  providerCachedTokens: number | null
  providerCacheWriteTokens: number | null
}): number {
  return (
    (r.providerInputTokens ?? 0) +
    (r.providerCachedTokens ?? 0) +
    (r.providerCacheWriteTokens ?? 0) +
    (r.providerOutputTokens ?? 0)
  )
}

export function contextPanel(
  store: Store,
  conversationId: ConversationId,
  contextWindow: number,
): ContextPanel {
  const limit = Math.max(1, contextWindow)

  // 分组明细取最近一次**已发送**的请求：它描述的是模型当下看到的那份上下文。
  const sent = latestSentProviderRequest(store, conversationId)
  // 还没发过请求的会话是 **0 / 窗口**，不是「没有面板」。
  // 别回 `available: false`：前端据此整个不渲染，因此新开一条会话上下文那一格
  // 是空的，用户看到的是「这个功能没了」而不是「还没占」。
  // 窗口是模型的属性，不是请求的属性：一条请求都没发也知道它有多大。
  if (!sent) {
    return {
      total: 0,
      limit,
      percent: 0,
      source: 'estimated',
      compactAt: softLimit({ contextWindow: limit }),
      breakdown: emptyBreakdown(),
      omitted: emptyOmitted(),
      freeSpace: limit,
    }
  }

  // 锚点取最近一次**带 usage 回报**的请求，可能比上面那条更早。
  // 判据不同是刻意的：一次超时或漏 usage 的请求也是「已发送」，
  // 拿它当锚等于把锚点归零，而那正是数字莫名跳水的来源。
  const anchored = latestAnchoredProviderRequest(store, conversationId)

  const total = anchored ? anchorTokens(anchored) : sent.measuredInputTokens
  const source: ContextPanel['source'] = anchored ? 'actual' : 'estimated'

  return {
    total,
    limit,
    percent: Math.round((total / limit) * 1000) / 10,
    source,
    compactAt: softLimit({ contextWindow: limit }),
    breakdown: reconcileBreakdown(sent.sentCategories, total),
    omitted: sent.omittedCategories,
    freeSpace: Math.max(0, limit - total),
  }
}
