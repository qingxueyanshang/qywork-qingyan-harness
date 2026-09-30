/**
 * 投递额度：一次 provider 决策内全部工具结果共用的一份账，以及装不下时的续读落盘。
 *
 * 额度 = 决策开始时软阈值以下的剩余，由 `loop/tool-wave.ts` 在执行第一波之前开账。
 * 软阈值以上两成留给本轮输出、下一波结果与估算残差（`loop/request.ts` 的 `TRIGGER_RATIO`），
 * 这里不再另扣输出。
 *
 * 结果在执行时按额度定稿后落库，投影只读已落库的 payload：额度随占用变化，不改写历史字节。
 */

import { estimateJson, MEDIA_TOKENS, type TokenDensity } from '@qywork/ai'
import type { IntermediateResourceRef, ResourceCoverage, ResourceId } from '@qywork/core'
import type { SinkPort, ToolContext, ToolOutcome } from './registry.ts'

const SPENT_KEY = 'ctx.batchSpent'
const ROOM_KEY = 'ctx.batchRoom'

/**
 * 开账。一次 provider 决策调一次，全部波次共用。返回传入的 `state`。
 *
 * 不要改成每波开一次：一次决策拆成多波时，逐波重开会让总量越过决策开始时的余量。
 */
export function openBatchBudget<T extends Map<string, unknown>>(state: T, room: number): T {
  state.set(ROOM_KEY, Math.max(0, Math.floor(room)))
  state.set(SPENT_KEY, 0)
  return state
}

function account(state: Map<string, unknown>): { room: number; spent: number } {
  const room = state.get(ROOM_KEY)
  // 没有默认额度：工具只经 AgentLoop 执行，没开账是调用方漏了开账，给默认值等于无上限放行。
  if (typeof room !== 'number') throw new Error('投递额度未开账')
  return { room, spent: (state.get(SPENT_KEY) as number | undefined) ?? 0 }
}

/** 本次决策还剩多少额度（token）。单次投递用 `deliveryCap`，不要直接拿它定尺寸。 */
export function batchRemaining(ctx: Pick<ToolContext, 'state'>): number {
  const { room, spent } = account(ctx.state)
  return Math.max(0, room - spent)
}

/**
 * 自动压缩保留多少尾部原文（token）：窗口的 1/4。
 *
 * 压缩选界（`runtime/compaction.ts`）与单次投递上限（`deliveryCap`）共用它，两处各写一个数就对不上。
 * 不要加固定封顶：它决定压缩后还剩多少最近的原文，按窗口比例才随窗口变大；
 * 封在 60K 时 1M 窗口压缩后只剩 6% 原文。
 */
export function tailRetain(contextWindow: number): number {
  return Math.floor(contextWindow / 4)
}

/**
 * 一次投递最多用多少额度（token）：给下一次决策留出半份尾部保留量，或者整段不超过半份。
 *
 * 不要放宽到整份余额：一段填满余额的结果把占用推到软阈值，下一次发送前越线，而那时这段结果
 * 模型还没看过、不能收纳，只能调模型写摘要。实测 1M 窗口读约 3 倍窗口的文件：放满时 11 次压缩里
 * 5 次是模型摘要。
 *
 * 也不要留满一份：执行工具之前的检查点在余量不足一份保留量时才压缩，留满一份时两者在同一条线上，
 * 差几十个 token 决定下一次决策压不压，续读段一大一小交替。留半份时下一次决策开始前必然先收纳上一段。
 */
export function deliveryCap(ctx: Pick<ToolContext, 'state' | 'contextWindow'>): number {
  const remaining = batchRemaining(ctx)
  const reserve = Math.floor(tailRetain(ctx.contextWindow) / 2)
  return Math.max(remaining - reserve, Math.min(remaining, reserve))
}

/**
 * 记一笔已经定稿的用量，不作准入裁决。
 *
 * 给已执行的工具用：动作已经发生，结果不能改报失败。累计值允许越过额度，
 * 越过之后余额按 0 报，同一决策里后续的读取工具据此收缩。
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
 * 只读工具的准入：不超过 `deliveryCap` 就记账并放行，超过不记账。`cap` 是此刻单次投递的上限，
 * 装不下整份的调用方按它定部分投递的尺寸。
 *
 * 写入类工具不要用它：副作用已经发生时报「装不下」等于告诉模型没做成。
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
 * 一段将要作为工具结果投递的正文有多大。**闸门与请求共用这一把尺。**
 *
 * 按 JSON 档量而不是散文档：它最终躺在 `{call_id, tool, status, executed,
 * summary, result}` 里发出去，而 `estimateMessage` 对 tool 角色整条走 JSON 档
 * （`ai/tokens.ts`）。换一把尺的话，扣的账和装进窗口的是两个数，差约两成。
 */
export function deliveredTokens(text: string, density: TokenDensity): number {
  return estimateJson(text, density)
}

/**
 * 一条结果进信封后的占用：message 与 data 按落进 JSON 的形状量，换行等转义字符计入；
 * 图像与视频按 `MEDIA_TOKENS` 一份计，与请求那侧同口径。
 *
 * 信封里 `call_id` / `tool` / `status` 等固定键约几十 token，不在这里算，由软阈值以上的预留覆盖。
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
 * token 额度折成字节数。
 *
 * 按每字节 token 数的**上界**反算：纯 ASCII 每字节 `1 / jsonCharsPerToken` 个 token；
 * 汉字在 UTF-8 里三字节，常用字与其余汉字各按自己那一档计。取最大者，
 * 按它折出来的字节数对任何正文都不超额度。它对常用文本偏保守，能按真实内容量的地方用 `headBytesWithin`。
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
 * `tokens` 最多对应多少字节：按每字节 token 数的**下界**反算，再加一个码点的余量。
 * 用来给「先取多少正文再量」定上限，量完不超额度的那一段必然在这个字节数之内。
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
 * 正文开头在 `tokens` 额度内最多能投递多少字节，落在码点边界上。
 *
 * 按落进 JSON 字符串后的真实估算二分，不用 `tokensToBytes` 的上界折算：那个折算对中文偏保守，
 * 实测会空出约四分之一的额度，多出的续读轮次都要重付一遍前缀。
 * 二分范围夹在两档密度折出的字节数之间，每次估算的量与额度同级。
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
 * 从头切时丢弃末尾不完整的字符，从尾切时丢弃开头不完整的字符。
 * 用 `fatal: true` 逐步回退比自己数续字节位更可靠：续字节的判定规则
 * 在四字节字符和代理对上容易写错。
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
      // 还在字符中间，再退一格。
    }
  }
  // 四次都失败说明这段不是合法 UTF-8（二进制输出）。宽松解码，替换符如实出现。
  return new TextDecoder('utf-8').decode(slice)
}

/** `landHead` 的结果。 */
export interface HeadDelivery {
  /** 投递给模型的头部。 */
  text: string
  /** 头部在正文里结束的字节位置。等于 `totalBytes` 表示整份已投递。 */
  nextOffset: number
  totalBytes: number
  /** 正文存进正文库后的引用；整份已投递或没存成时为 `null`。 */
  resource: IntermediateResourceRef | null
  /** 没有 sink 或落盘失败的原因；非空时头部之外的部分不可续读。 */
  unavailable: string | null
}

/**
 * 投递装得下的头部，完整正文存一次，供 `read_resource` 从 `nextOffset` 续读。
 *
 * 用于原工具不能按范围续读的正文：历史条目、记忆、技能、MCP 与插件的结果、`read_file` 的单行。
 * 只取头部、不取头尾：续读从头部结束处接着读，头尾摘录会让尾部被投递两次。
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

/** 头部之后的一句续读说明。与 `landHead` 的结果一一对应，调用方拼在头部后面。 */
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
 * 结果不能改报失败，所以不做准入。超出余额时先把结构化 data 整份存进正文库，
 * 仍装不下再把正文存进去、只投递头部；回执保留 status / executed / errorKind 与资源地址，
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
