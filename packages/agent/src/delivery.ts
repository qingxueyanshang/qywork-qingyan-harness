/**
 * 投递额度：一次 provider 决策内全部工具结果共用的额度，以及超出额度时的续读落盘。
 *
 * 额度 = 决策开始时软阈值以下的剩余空间，由 `loop/tool-wave.ts` 在执行第一批工具之前开账。
 * 软阈值以上的两成留给本轮输出、下一批结果与估算误差（`loop/request.ts` 的 `TRIGGER_RATIO`），
 * 此处不再另扣输出。
 *
 * 结果在执行时按额度定稿后落库，投影只读取已落库的 payload：额度随占用变化，但不改写历史字节。
 */

import { estimateJson, MEDIA_TOKENS, type TokenDensity } from '@qywork/ai'
import type { IntermediateResourceRef, ResourceCoverage, ResourceId } from '@qywork/core'
import type { SinkPort, ToolContext, ToolOutcome } from './registry.ts'

const SPENT_KEY = 'ctx.batchSpent'
const ROOM_KEY = 'ctx.batchRoom'

/**
 * 开账。每次 provider 决策调用一次，全部批次共用。返回传入的 `state`。
 *
 * 不要改为每批开账一次：一次决策分多批执行时，逐批重新开账会使总量超过决策开始时的余量。
 */
export function openBatchBudget<T extends Map<string, unknown>>(state: T, room: number): T {
  state.set(ROOM_KEY, Math.max(0, Math.floor(room)))
  state.set(SPENT_KEY, 0)
  return state
}

function account(state: Map<string, unknown>): { room: number; spent: number } {
  const room = state.get(ROOM_KEY)
  // 不设默认额度：工具只经 AgentLoop 执行，未开账说明调用方遗漏了开账，设默认值等于不限额放行。
  if (typeof room !== 'number') throw new Error('投递额度未开账')
  return { room, spent: (state.get(SPENT_KEY) as number | undefined) ?? 0 }
}

/** 本次决策的剩余额度（token）。单次投递的大小用 `deliveryCap` 确定，不要直接使用该值。 */
export function batchRemaining(ctx: Pick<ToolContext, 'state'>): number {
  const { room, spent } = account(ctx.state)
  return Math.max(0, room - spent)
}

/**
 * 自动压缩保留的尾部原文量（token）：窗口的 1/4。
 *
 * 压缩边界选择（`runtime/compaction.ts`）与单次投递上限（`deliveryCap`）共用该值，
 * 两处分别定义会导致不一致。不要设固定上限：该值决定压缩后保留的最近原文量，按窗口比例
 * 计算才能随窗口增大；上限设为 60K 时，1M 窗口压缩后只剩 6% 原文。
 */
export function tailRetain(contextWindow: number): number {
  return Math.floor(contextWindow / 4)
}

/**
 * 单次投递可用的额度上限（token）：为下一次决策留出半份尾部保留量；余额不足时单次不超过半份。
 *
 * 不要放宽到全部余额：填满余额的结果使占用达到软阈值，下一次发送前即越线，而此时该结果尚未
 * 被模型看到、不能收纳，只能调用模型写摘要。实测 1M 窗口读取约 3 倍窗口大小的文件：不留余量时
 * 11 次压缩中有 5 次是模型摘要。
 *
 * 也不要留满一份：执行工具之前的检查点在余量不足一份保留量时才压缩，留满一份时两者处于同一条线上，
 * 相差几十个 token 即决定下一次决策是否压缩，续读段大小交替变化。留半份时，下一次决策开始前
 * 必定先收纳上一段。
 */
export function deliveryCap(ctx: Pick<ToolContext, 'state' | 'contextWindow'>): number {
  const remaining = batchRemaining(ctx)
  const reserve = Math.floor(tailRetain(ctx.contextWindow) / 2)
  return Math.max(remaining - reserve, Math.min(remaining, reserve))
}

/**
 * 记录一笔已定稿的用量，不做准入判定。
 *
 * 用于已执行的工具：动作已经发生，结果不能改报失败。累计值允许超过额度，
 * 超过后余额按 0 报告，同一决策中后续的读取工具据此缩小投递量。
 */
export function recordBatchSpent(
  ctx: Pick<ToolContext, 'state'>,
  tokens: number,
): { remaining: number } {
  const { room, spent } = account(ctx.state)
  const next = spent + tokens
  ctx.state.set(SPENT_KEY, next)
  return { remaining: Math.max(0, room - next) }
}

/**
 * 只读工具的准入：不超过 `deliveryCap` 时记账并放行，超过时不记账。`cap` 是当前单次投递的上限，
 * 无法整份投递的调用方据此确定部分投递的大小。
 *
 * 写入类工具不要使用它：副作用已经发生时报告「超出额度」等于告知模型操作未成功。
 */
export function chargeBatchBudget(
  ctx: Pick<ToolContext, 'state' | 'contextWindow'>,
  tokens: number,
): { ok: boolean; cap: number } {
  const cap = deliveryCap(ctx)
  if (tokens > cap) return { ok: false, cap }
  const { spent } = account(ctx.state)
  ctx.state.set(SPENT_KEY, spent + tokens)
  return { ok: true, cap: deliveryCap(ctx) }
}

/**
 * 一段将作为工具结果投递的正文的估算大小。准入判定与请求估算使用同一估算方法。
 *
 * 按 JSON 档位估算而不是散文档位：正文最终放在 `{call_id, tool, status, executed,
 * summary, result}` 中发出，而 `estimateMessage` 对 tool 角色整条按 JSON 档位估算
 * （`ai/tokens.ts`）。改用其他估算方法时，扣除的额度与实际进入窗口的量不一致，相差约两成。
 */
export function deliveredTokens(text: string, density: TokenDensity): number {
  return estimateJson(text, density)
}

/**
 * 一条结果放入信封后的占用：message 与 data 按写入 JSON 后的形式估算，计入换行等转义字符；
 * 每个图像与视频按一份 `MEDIA_TOKENS` 计，与请求侧的计算方法一致。
 *
 * 信封中 `call_id` / `tool` / `status` 等固定键约几十 token，不在此计算，由软阈值以上的预留空间覆盖。
 */
export function outcomeTokens(
  parts: { message: string; data?: Record<string, unknown> | undefined },
  density: TokenDensity,
): number {
  const data = parts.data ?? {}
  const images = Array.isArray(data.images) ? data.images.length : 0
  const videos = Array.isArray(data.videos) ? data.videos.length : 0
  const { images: _bytes, videos: _paths, ...rest } = data
  return (
    deliveredTokens(JSON.stringify({ summary: parts.message, result: rest }), density) +
    (images + videos) * MEDIA_TOKENS
  )
}

/**
 * 将 token 额度换算为字节数。
 *
 * 按每字节 token 数的上界反算：纯 ASCII 每字节 `1 / jsonCharsPerToken` 个 token；
 * 汉字在 UTF-8 中占三字节，常用字与其他汉字分别按各自档位计。取最大值，据此换算出的字节数
 * 对任何正文都不超出额度。该结果对常见文本偏保守；可以按实际内容计算的位置使用 `headBytesWithin`。
 */
export function tokensToBytes(tokens: number, density: TokenDensity): number {
  const perByte = Math.max(
    density.cjkTokensPerChar / 3,
    density.rareCjkTokensPerChar / 3,
    1 / density.jsonCharsPerToken,
  )
  return Math.max(0, Math.floor(tokens / perByte))
}

/**
 * `tokens` 最多对应的字节数：按每字节 token 数的下界反算，再加一个码点的余量。
 * 用于确定先截取多少正文再估算的上限：估算后不超出额度的部分必定在该字节数之内。
 */
export function tokensToMaxBytes(tokens: number, density: TokenDensity): number {
  const perByte = Math.min(
    density.cjkTokensPerChar / 3,
    density.rareCjkTokensPerChar / 3,
    1 / density.jsonCharsPerToken,
  )
  return Math.max(0, Math.ceil(tokens / perByte) + 4)
}

/**
 * 在 `tokens` 额度内，正文开头最多可投递的字节数，结果位于码点边界上。
 *
 * 按写入 JSON 字符串后的实际估算值二分查找，不用 `tokensToBytes` 的上界换算：该换算对中文偏保守，
 * 实测会空出约四分之一的额度，多出的续读轮次都要重新支付一次前缀费用。
 * 二分范围限定在两档密度换算出的字节数之间，每次估算的量与额度处于同一量级。
 */
export function headBytesWithin(body: Uint8Array, tokens: number, density: TokenDensity): number {
  if (tokens <= 0) return 0
  const cost = (n: number) =>
    deliveredTokens(JSON.stringify(decodeUtf8Boundary(body.subarray(0, n), 'head')), density)
  let fit = Math.min(body.byteLength, tokensToBytes(tokens, density))
  let over = Math.min(body.byteLength, tokensToMaxBytes(tokens, density))
  if (cost(over) <= tokens) return over
  if (cost(fit) > tokens) fit = 0
  while (over - fit > 1) {
    const mid = (fit + over) >> 1
    if (cost(mid) <= tokens) fit = mid
    else over = mid
  }
  return fit
}

/**
 * 在 UTF-8 字符边界上解码。
 *
 * 从头部截取时丢弃末尾不完整的字符，从尾部截取时丢弃开头不完整的字符。
 * 用 `fatal: true` 逐字节回退比自行判断续字节更可靠：续字节的判定规则
 * 在四字节字符与代理对上容易出错。
 */
export function decodeUtf8Boundary(slice: Uint8Array, side: 'head' | 'tail'): string {
  const strict = new TextDecoder('utf-8', { fatal: true })
  // 最多回退 3 字节：UTF-8 单字符最长 4 字节。
  for (let back = 0; back <= 3 && back < slice.byteLength; back++) {
    const candidate =
      side === 'head' ? slice.subarray(0, slice.byteLength - back) : slice.subarray(back)
    try {
      return strict.decode(candidate)
    } catch {
      // 仍位于字符中间，再回退一个字节。
    }
  }
  // 四次均失败说明该段不是合法 UTF-8（二进制输出）。使用宽松解码，替换字符如实保留。
  return new TextDecoder('utf-8').decode(slice)
}

/** `landHead` 的结果。 */
export interface HeadDelivery {
  /** 投递给模型的头部。 */
  text: string
  /** 头部在正文中的结束字节位置。等于 `totalBytes` 表示已完整投递。 */
  nextOffset: number
  totalBytes: number
  /** 正文存入正文库后的引用；已完整投递或存储失败时为 `null`。 */
  resource: IntermediateResourceRef | null
  /** 没有 sink 或落盘失败时的原因；非空时头部之后的部分不可续读。 */
  unavailable: string | null
}

/**
 * 投递额度内可容纳的头部，完整正文存储一次，供 `read_resource` 从 `nextOffset` 续读。
 *
 * 用于原工具无法按范围续读的正文：历史条目、记忆、技能、MCP 与插件的结果、`read_file` 的单行。
 * 只取头部、不取首尾摘录：续读从头部结束处继续，首尾摘录会使尾部被投递两次。
 */
export function landHead(
  sink: SinkPort | null,
  input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType: string | null
    budgetBytes: number
    query?: string
  },
): HeadDelivery {
  const totalBytes = input.body.byteLength
  const text = decodeUtf8Boundary(
    input.body.subarray(0, Math.min(Math.max(0, input.budgetBytes), totalBytes)),
    'head',
  )
  const nextOffset = new TextEncoder().encode(text).byteLength
  if (nextOffset >= totalBytes) {
    return { text, nextOffset: totalBytes, totalBytes, resource: null, unavailable: null }
  }
  const coverage: ResourceCoverage = {
    deliveredBytes: nextOffset,
    totalBytes,
    truncated: true,
    ...(input.query ? { query: input.query } : {}),
  }
  if (!sink) return { text, nextOffset, totalBytes, resource: null, unavailable: '没有正文库' }
  try {
    const landed = sink.land({
      toolName: input.toolName,
      sourceType: input.sourceType,
      body: input.body,
      mimeType: input.mimeType,
      coverage,
    })
    return {
      text,
      nextOffset,
      totalBytes,
      resource: {
        resourceId: landed.resourceId as ResourceId,
        status: 'complete',
        contentHash: landed.contentHash,
        sizeBytes: totalBytes,
        mimeType: input.mimeType,
        coverage,
      },
      unavailable: null,
    }
  } catch (err) {
    return {
      text,
      nextOffset,
      totalBytes,
      resource: null,
      unavailable: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 头部之后的续读说明。与 `landHead` 的结果一一对应，调用方将其拼接在头部之后。 */
export function continuationNote(head: HeadDelivery): string {
  if (head.nextOffset >= head.totalBytes) return ''
  const rest = head.totalBytes - head.nextOffset
  if (head.resource) {
    return (
      `\n\n[超出上下文剩余空间，已投递 ${head.nextOffset} / ${head.totalBytes} 字节。` +
      `完整内容已保存为 ${head.resource.resourceId}，用 read_resource 从 offset=${head.nextOffset} 续读。]`
    )
  }
  return `\n\n[超出上下文剩余空间，其余 ${rest} 字节未投递，且无法保存：${head.unavailable}。]`
}

/**
 * 已执行的第三方工具（MCP、插件）的结果按余额定稿。
 *
 * 结果不能改报失败，因此不做准入判定。超出余额时先把结构化 data 整份存入正文库，
 * 仍超出时再存入正文、只投递头部；返回结果保留 status / executed / errorKind 与资源地址，
 * 保持合法 JSON。最后按实际投递量记账。
 *
 * 不要按字符串截断 data：截断后的 JSON 不再合法，结构字段也会缺失。
 */
export function boundExecutedOutcome(
  ctx: Pick<ToolContext, 'state' | 'sink' | 'density' | 'contextWindow'>,
  outcome: ToolOutcome,
  source: { toolName: string; sourceType: string },
): ToolOutcome {
  const remaining = deliveryCap(ctx)
  if (outcomeTokens(outcome, ctx.density) <= remaining) {
    recordBatchSpent(ctx, outcomeTokens(outcome, ctx.density))
    return outcome
  }

  const resources = [...(outcome.resources ?? [])]
  let message = outcome.message
  let data = outcome.data
  const { images, ...rest } = data ?? {}
  if (Object.keys(rest).length) {
    const body = new TextEncoder().encode(JSON.stringify(rest))
    const stored = landHead(ctx.sink, {
      toolName: source.toolName,
      sourceType: `${source.sourceType}:data`,
      body,
      mimeType: 'application/json',
      budgetBytes: 0,
    })
    if (stored.resource) resources.push(stored.resource)
    message +=
      stored.resource !== null
        ? `\n\n[结构化结果共 ${body.byteLength} 字节，已保存为 ${stored.resource.resourceId}，用 read_resource 读取。]`
        : `\n\n[结构化结果共 ${body.byteLength} 字节，超出上下文剩余空间且无法保存：${stored.unavailable}。]`
    data = images === undefined ? undefined : { images }
  }

  const fixed = outcomeTokens({ message: '', ...(data ? { data } : {}) }, ctx.density)
  if (outcomeTokens({ message, ...(data ? { data } : {}) }, ctx.density) > remaining) {
    const body = new TextEncoder().encode(message)
    const head = landHead(ctx.sink, {
      toolName: source.toolName,
      sourceType: source.sourceType,
      body,
      mimeType: 'text/plain',
      budgetBytes: headBytesWithin(body, remaining - fixed, ctx.density),
    })
    if (head.resource) resources.push(head.resource)
    message = head.text + continuationNote(head)
  }

  const bounded: ToolOutcome = {
    ...outcome,
    message,
    ...(resources.length ? { resources } : {}),
  }
  if (data) bounded.data = data
  else delete bounded.data
  recordBatchSpent(ctx, outcomeTokens(bounded, ctx.density))
  return bounded
}
