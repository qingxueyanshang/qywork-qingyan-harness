/**
 * 上下文面板的投影。
 *
 * 面板按会话即时计算，而不是由事件携带：事件只在 run 运行期间推送，切换会话或刷新页
 * 面后面板即为空，而用户通常在事后查看上下文的占用构成。因此真源是账本，面板是
 * 账本的投影，任何时刻都可查询。
 *
 * 总数只使用一种计量口径，即运行中读数的口径。最近一次已发送请求带 usage 时，`total` 即
 * provider 真值（输入 + 输出）；尚未取得 usage 时读取该请求发出时记录的运行中读数
 * （`occupancyTokens`，即 `RunState.meter`：锚点真值加其后的本地增量，信封变化时只修正头部）。
 * 不要在此处另行推算：两处算式不同时，同一会话在运行中与事后查看会得到两个数值。
 * 也不要使用 `max(全量估算, provider真值)`：两个数出自不同的计量口径，锚点失效时
 * 显示值会跳回字符数上界。
 *
 * 没有当前路线与模型下带 usage 的请求时标为 `estimated`，此时运行中读数即本地估算。
 * 锚点后还有增量时标为 `projected`，只有最近请求本身有回执时才标为 `actual`。
 * 标签必须与读数一致：用户须能直接判断该读数可否作为决策依据。
 *
 * 锚点的接口、协议、模型必须与会话当前的一致。各家 tokenizer 与中转站的 usage
 * 口径都可能不同，跨路线复用即用 A 的计量口径判断 B 的窗口，且仍带有真值标签。
 * 运行中读数为空（摘要请求、迁移前旧行）或该请求不在当前路线上时，退回本地测得值。
 */

import { softLimit } from '@qywork/agent'
import type {
  ContextBreakdown,
  ContextOmitted,
  ConversationId,
  ProviderRequest,
} from '@qywork/core'
import { emptyBreakdown, emptyOmitted, reconcileBreakdown } from '@qywork/core'
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
  source: 'actual' | 'projected' | 'estimated'
  /**
   * 最近一次已发送请求的**本地估算**占用。
   *
   * 与 `total` 是同一份内容的两种计量口径。压缩用它把估算口径的回收量折算到 `total`
   * 的口径上（`CompactionRunInput.estimatedOccupancy`）。`source` 为 `estimated`
   * 时两者相等；`projected` 时则是最近真值加上锚点后的本地增量。
   *
   * 不进入界面：界面只显示 `total`，同时显示两个数值时用户无法判断以哪个为准。
   */
  measured: number
  /**
   * 超过该值时在下一次发送前执行压缩。
   *
   * 必须调用 `softLimit`，不要在此处复制其算式：两处各写一份时，只修改一处会使
   * 面板上的刻度指向不会触发压缩的位置，且不会报错。
   */
  compactAt: number
  breakdown: ContextBreakdown
  omitted: ContextOmitted
  freeSpace: number
}

/**
 * provider 回报的上下文占用。
 *
 * 四项相加而不是只取 `inputTokens`：qywork 的三个适配器已将 `inputTokens`
 * 统一为排除缓存的口径（见 `openai-compat.ts` 中的相关注释），
 * 只取它会遗漏命中缓存的部分；冻结前缀设计下第二轮起的主要部分正是
 * cache_read，遗漏后 100k 的会话会显示为不到 1%。
 *
 * 加上 output 是因为这一轮的输出会成为下一轮输入的一部分，
 * 面板反映的是下一轮的剩余空间。
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
  /**
   * 会话当前的模型。窗口与 id 必须出自同一份 spec：分子按 id 判定锚点、
   * 分母按窗口计算百分比，两者出自不同的 spec 时分子与分母不一致。
   */
  model: {
    id: string
    contextWindow: number
    /** 真值锚点必须与当前接口路线完全一致。 */
    providerName: string
    providerKind: Exclude<ProviderRequest['providerKind'], null>
  },
): ContextPanel {
  const limit = Math.max(1, model.contextWindow)

  // 分组明细取最近一次已发送的请求：它描述的是模型当前看到的上下文。
  const sent = latestSentProviderRequest(store, conversationId)
  const compacted = getConversation(store, conversationId)?.compactionManifest?.contextAfter
  /*
   * 手动压缩后没有紧随其后的 provider 请求，逐请求账仍是压缩前的数值。
   * manifest 上的派生快照只在它仍基于当前最后一次请求且模型未更换时生效；
   * 发出新请求后 request id 改变，下方逻辑自动回到逐请求账，客户端无需另存状态。
   */
  const currentCompaction =
    compacted &&
    compacted.model === model.id &&
    compacted.basedOnProviderRequestId === (sent?.id ?? null)
      ? compacted
      : null
  // 尚未发送请求的会话返回 0 / 窗口，而不是没有面板。
  // 不要返回 `available: false`：前端据此完全不渲染，新会话的上下文字段
  // 为空，看起来是功能缺失而不是尚未占用。
  // 窗口是模型的属性，不是请求的属性：未发送任何请求时也能确定窗口大小。
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
      // 压缩后的请求尚未发送给 provider 校准，该数值只能标为估算。
      source: 'estimated',
      measured: currentCompaction.measured,
      compactAt: softLimit({ contextWindow: limit }),
      breakdown: reconcileBreakdown(sent.sentCategories, total),
      omitted: sent.omittedCategories,
      freeSpace: Math.max(0, limit - total),
    }
  }

  // 锚点取最近一次带 usage 回报的请求，可能早于上方取得的请求。
  // 两者判据必须不同：超时或缺失 usage 的请求也属于已发送，
  // 以它作为锚点等于把锚点归零，会导致读数异常骤降。
  const latest = latestAnchoredProviderRequest(store, conversationId)
  const onRoute = (r: ProviderRequest) =>
    r.model === model.id &&
    r.providerName === model.providerName &&
    r.providerKind === model.providerKind
  /*
   * 更换模型后没有锚点，不向前查找同模型的回执：更早的回执描述的是更短的
   * 上下文，是另一份内容的真值，其误差比估算更难察觉。此时退回估算口径，如实标为
   * `estimated`，下一轮回执到达后重新锚定。
   */
  const anchored = latest && onRoute(latest) ? latest : null

  const live = onRoute(sent) ? sent.occupancyTokens : null
  const { total, source } =
    anchored?.id === sent.id
      ? { total: anchorTokens(anchored), source: 'actual' as const }
      : live !== null
        ? { total: live, source: anchored ? ('projected' as const) : ('estimated' as const) }
        : { total: sent.measuredInputTokens, source: 'estimated' as const }

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
