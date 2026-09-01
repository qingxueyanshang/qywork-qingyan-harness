/**
 * 上下文面板的投影。
 *
 * **为什么是「按会话现算」而不是「事件里带着」。** 事件只在 run 跑着的时候流。切一次会话、刷一次页
 * 面，面板就空了——而用户是在**回头看**的时候才想知道「上下文被谁占的」。所以真源是账本，面板是
 * 它的投影，任何时刻可查。
 *
 * **总数只有一把尺。** 最近一次已发送请求带 usage 时，`total` 就是 provider 真值；
 * 更新的请求尚未拿到 usage 时，从上一个真值输入起算，固定头部按逐字估算差替换，
 * 新增消息按同一份锚点的 `provider 输入 / 本地估算` 比值校准。
 * 这里刻意不做 `max(全量估算, provider真值)`——那两个数出自两把尺，锚点一失效
 * 显示值就会无理由跳回字符上界。
 *
 * 没有任何**当前路线与模型的**带 usage 请求时才退回本地测得值，并把 `source` 标成
 * `estimated`。锚点后还有增量时标 `calibrated`，只有最近请求本身有回执才标 `actual`。
 * **标签必须跟着数走**：用户要能一眼看出这个数能不能拿来做决定。
 *
 * **锚点必须与会话当前的接口、协议、模型同一条。** 各家 tokenizer 与中转 usage
 * 口径都可能不同，跨路线复用就是拿 A 的尺去判 B 的窗口，而它还挂着真值标签。
 *
 * **信封换了一份只换头部，两侧同一组判据。** 模型相同而冻结前缀或工具表变了时，
 * 消息侧一个字没变，锚点那一大段真值仍然成立——按 `envelopeHeadTokens` 把头部
 * 换成最近一次已发送请求那一份即可。这与 loop 那侧逐条对应（`agent/loop.ts` 里
 * `envelopeHashOf` 判、同一个 `envelopeHeadTokens` 量）：两处判据不同的话，
 * 同一条会话在运行中和回头看会给出两个数。
 */

import { softLimit } from '@qywork/agent'
import type {
  ContextBreakdown,
  ContextOmitted,
  ConversationId,
  ProviderRequest,
} from '@qywork/core'
import { emptyBreakdown, emptyOmitted, envelopeHeadTokens, reconcileBreakdown } from '@qywork/core'
import {
  getConversation,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  type Store,
} from '@qywork/store'

export interface ContextPanel {
  total: number
  limit: number
  /** 一位小数。1M 窗口下取整会把 2139 显示成 0%。 */
  percent: number
  source: 'actual' | 'calibrated' | 'estimated'
  /**
   * 最近一次已发送请求的**本地估算**占用。
   *
   * 与 `total` 是同一份内容的两把尺。压缩要拿它把估算尺的回收量折算到 `total`
   * 那把尺上（`CompactionRunInput.estimatedOccupancy`）。`source` 为 `estimated`
   * 时两者相等；`calibrated` 时则是最近真值加上已换尺的增量。
   *
   * **不进界面**：界面只显示 `total`，两个数一起摆出来没有人能判断该信哪个。
   */
  measured: number
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

/** provider 对这一次请求实际计入窗口的输入，不含本轮输出。 */
function anchorInputTokens(r: {
  providerInputTokens: number | null
  providerCachedTokens: number | null
  providerCacheWriteTokens: number | null
}): number {
  return (
    (r.providerInputTokens ?? 0) + (r.providerCachedTokens ?? 0) + (r.providerCacheWriteTokens ?? 0)
  )
}

/** 同一份输入上的真值 / 本地估算；没有可用分母时不编系数。 */
function anchorScale(r: ProviderRequest): number {
  const actual = anchorInputTokens(r)
  return r.measuredInputTokens > 0 && actual > 0 ? actual / r.measuredInputTokens : 1
}

/**
 * 锚点的真值推进到**最近一次已发送请求**。
 *
 * 当前请求就是锚点时直接返回完整回执。更新的请求尚未回 usage 时分两段推进：
 * 信封头部逐字可数，按两次估算的差值换；消息侧按锚点请求的真值比校准后再加。
 * 整条退回裸估算尺的代价实测是 54.5% 读作 80.0%。
 *
 * 指纹相同时不换头部，`null`（没记过指纹的存量行）同样不换：同一份信封下两份
 * 头部估算相等，换一遍只会把两次估算之间的口径差引进来。
 *
 * 边界：两份头部都是估算，所以差额带的是系数误差，不是零误差。
 */
function anchoredTotal(anchored: ProviderRequest, sent: ProviderRequest): number {
  if (anchored.id === sent.id) return anchorTokens(anchored)

  const changed =
    anchored.cacheRouteFingerprint !== null &&
    anchored.cacheRouteFingerprint !== sent.cacheRouteFingerprint
  const headDelta = changed
    ? envelopeHeadTokens(sent.sentCategories) - envelopeHeadTokens(anchored.sentCategories)
    : 0
  /*
   * 头部逐字可数，仍按原估算差换；其余增量才按同一请求的真值比校准。
   * `sent - anchored - headDelta` 包含锚点回复进入下一轮后的模型可见部分，
   * 所以基底必须是不含锚点输出的 provider 输入，不能从 `anchorTokens` 起算后再重复加。
   */
  const variableDelta = sent.measuredInputTokens - anchored.measuredInputTokens - headDelta
  return Math.max(
    0,
    anchorInputTokens(anchored) + headDelta + Math.round(variableDelta * anchorScale(anchored)),
  )
}

export function contextPanel(
  store: Store,
  conversationId: ConversationId,
  /**
   * 会话当前的模型。**窗口与 id 必须出自同一份 spec**——分子按 id 认锚点、
   * 分母按窗口算百分比，两个数出自两份 spec 就是分子分母各说各话。
   */
  model: {
    id: string
    contextWindow: number
    /** 有值时把真值校准限制在同一条接口路线上；旧行没有路线证据时仍可作锚。 */
    providerName?: string
    providerKind?: ProviderRequest['providerKind']
  },
): ContextPanel {
  const limit = Math.max(1, model.contextWindow)

  // 分组明细取最近一次**已发送**的请求：它描述的是模型当下看到的那份上下文。
  const sent = latestSentProviderRequest(store, conversationId)
  const compacted = getConversation(store, conversationId)?.compactionManifest?.contextAfter
  /*
   * 手动压缩后没有紧随其后的 provider 请求，逐请求账自然还是压缩前的数字。
   * manifest 上的派生快照只在它仍基于「当前最后一次请求」且模型没换时生效；
   * 一旦发出新请求，request id 改变，下面自动回到逐请求账，不需要客户端另存状态。
   */
  const currentCompaction =
    compacted &&
    compacted.model === model.id &&
    compacted.basedOnProviderRequestId === (sent?.id ?? null)
      ? compacted
      : null
  // 还没发过请求的会话是 **0 / 窗口**，不是「没有面板」。
  // 别回 `available: false`：前端据此整个不渲染，因此新开一条会话上下文那一格
  // 是空的，用户看到的是「这个功能没了」而不是「还没占」。
  // 窗口是模型的属性，不是请求的属性：一条请求都没发也知道它有多大。
  if (!sent) {
    const total = currentCompaction?.total ?? 0
    return {
      total,
      limit,
      percent: Math.round((total / limit) * 1000) / 10,
      source: 'estimated',
      measured: currentCompaction?.measured ?? 0,
      compactAt: softLimit({ contextWindow: limit }),
      breakdown: reconcileBreakdown(emptyBreakdown(), total),
      omitted: emptyOmitted(),
      freeSpace: Math.max(0, limit - total),
    }
  }

  if (currentCompaction) {
    const total = currentCompaction.total
    return {
      total,
      limit,
      percent: Math.round((total / limit) * 1000) / 10,
      // 压缩后的请求还没发给 provider 验尺，这个数只能诚实标成估算。
      source: 'estimated',
      measured: currentCompaction.measured,
      compactAt: softLimit({ contextWindow: limit }),
      breakdown: reconcileBreakdown(sent.sentCategories, total),
      omitted: sent.omittedCategories,
      freeSpace: Math.max(0, limit - total),
    }
  }

  // 锚点取最近一次**带 usage 回报**的请求，可能比上面那条更早。
  // 判据不同是刻意的：一次超时或漏 usage 的请求也是「已发送」，
  // 拿它当锚等于把锚点归零，而那正是数字莫名跳水的来源。
  const latest = latestAnchoredProviderRequest(store, conversationId)
  /*
   * 换过模型就没有锚点了，**不往前找同模型的那一条**：更早那条描述的是更短的
   * 上下文，它是「另一份内容的真值」，比估算错得更隐蔽。退回估算尺、如实标
   * `estimated`，下一轮回执一到即重锚。
   */
  const anchored =
    latest &&
    latest.model === model.id &&
    (latest.providerName === null ||
      model.providerName === undefined ||
      latest.providerName === model.providerName) &&
    (latest.providerKind === null ||
      model.providerKind === undefined ||
      latest.providerKind === model.providerKind)
      ? latest
      : null

  const total = anchored ? anchoredTotal(anchored, sent) : sent.measuredInputTokens
  const source: ContextPanel['source'] = anchored
    ? anchored.id === sent.id
      ? 'actual'
      : 'calibrated'
    : 'estimated'

  return {
    total,
    limit,
    percent: Math.round((total / limit) * 1000) / 10,
    source,
    measured: sent.measuredInputTokens,
    compactAt: softLimit({ contextWindow: limit }),
    breakdown: reconcileBreakdown(sent.sentCategories, total),
    omitted: sent.omittedCategories,
    freeSpace: Math.max(0, limit - total),
  }
}
