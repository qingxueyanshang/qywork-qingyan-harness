/**
 * 上下文面板的投影。
 *
 * ## 为什么是「按会话现算」而不是「事件里带着」
 *
 * 事件只在 run 跑着的时候流。切一次会话、刷一次页面，面板就空了——
 * 而用户恰恰是在**回头看**的时候才想知道「上下文被谁占的」。
 * 所以真源是账本，面板是它的投影，任何时刻可查。
 *
 * ## 总数只有一把尺
 *
 * `total` 取**最近一次带 usage 回报的请求**的 provider 真值。
 * 这里刻意不做 `max(全量估算, provider真值)`——那两个数出自两把尺，
 * 锚点一失效显示值就从真值尺跌到估算尺，会话内容没变而数字掉三分之一，
 * 界面上没有任何东西能解释它。
 *
 * 没有任何带 usage 的请求时才退回本地测得值，并把 `source` 标成 `estimated`。
 * **标签必须跟着数走**：用户要能一眼看出这个数能不能拿来做决定。
 */

import type { ContextBreakdown, ContextOmitted, ConversationId } from '@qywork/core'
import { emptyBreakdown, emptyOmitted } from '@qywork/core'
import { latestAnchoredProviderRequest, latestSentProviderRequest, type Store } from '@qywork/store'

export interface ContextPanel {
  total: number
  limit: number
  /** 一位小数。1M 窗口下取整会把 2139 显示成 0%。 */
  percent: number
  source: 'actual' | 'estimated'
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

/**
 * 会随对话增长的那三个桶。差额只往这里归。
 *
 * 其余桶（系统提示词、工具 schema、记忆、技能、工作区）在装配时是**逐字可数**的，
 * 估算误差极小；把差额摊到它们头上等于把最准的数改错。
 *
 * 坑：不要改成「按占比缩放全部类目」。那要求全部类目出自同一把尺、误差均匀，
 * 而这里是估算，误差集中在会变的那几个桶上。
 */
const VARIABLE: readonly (keyof ContextBreakdown)[] = [
  'historyMessages',
  'executionRecords',
  'intermediateContent',
]

/**
 * 让分组之和恒等于总数。
 *
 * ## 为什么必须对账
 *
 * `total` 是 provider 真值，`breakdown` 是本地估算，两者天然不等。差额里还
 * 结构性地含着**上一轮的输出 token**——它不属于任何一个桶，但它确实占着窗口，
 * 下一轮就是历史的一部分。
 *
 * 不对账的话，面板上「各行加起来」和「标题上那个数」对不上。这里曾经用一句
 * 「各组之和略小于总数：总数含请求体本身的结构开销」糊过去——那句话是**错的**，
 * 差额里有真实内容（tool call 参数、思考正文），不只是 JSON 骨架。
 *
 * ## 吸收法，不是缩放法
 *
 * 固定类目保实测值，差额归到**误差实际所在的桶**。
 * 三个可变桶按各自占比分摊；全为零（新会话还没跑过工具）
 * 时整块给 `historyMessages`。
 */
function reconcile(breakdown: ContextBreakdown, total: number): ContextBreakdown {
  const out = { ...breakdown }
  const sum = Object.values(out).reduce((n, v) => n + v, 0)
  const diff = total - sum
  if (diff === 0) return out

  const variableSum = VARIABLE.reduce((n, k) => n + out[k], 0)
  if (variableSum <= 0) {
    out.historyMessages = Math.max(0, out.historyMessages + diff)
    return out
  }

  // 按占比摊，余数给最大的那个桶——保证和精确等于 total，不留一两个 token 的尾巴。
  let assigned = 0
  const shares = VARIABLE.map((k) => {
    const share = Math.trunc((out[k] / variableSum) * diff)
    assigned += share
    return { key: k, share }
  })
  const biggest = VARIABLE.reduce((a, b) => (out[a] >= out[b] ? a : b))
  for (const { key, share } of shares) out[key] = Math.max(0, out[key] + share)
  out[biggest] = Math.max(0, out[biggest] + (diff - assigned))
  return out
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
  // 这里曾经回 `available: false`，前端据此整个不渲染——于是新开一条会话，
  // 上下文那一格是空的，用户看到的是「这个功能没了」而不是「还没占」。
  // 窗口是模型的属性，不是请求的属性：一条请求都没发也知道它有多大。
  if (!sent) {
    return {
      total: 0,
      limit,
      percent: 0,
      source: 'estimated',
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
    breakdown: reconcile(sent.sentCategories, total),
    omitted: sent.omittedCategories,
    freeSpace: Math.max(0, limit - total),
  }
}
