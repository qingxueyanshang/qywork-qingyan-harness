/**
 * 请求装配与工具结果形状的纯函数：占用阈值、输出申报、用量合并、请求指纹、分组明细、
 * 工具结果信封与媒体物化。
 */

import { statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type {
  ChatRequest,
  ContentBlock,
  LlmAdapter,
  ReasoningReplay,
  TokenDensity,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import {
  computeCost,
  diagnosticEndpoint,
  estimateJson,
  estimateMessage,
  estimateSchemas,
  estimateText,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import type { ContextBreakdown, ProviderRequestConfiguration, RunUsage } from '@qywork/core'
import { emptyBreakdown } from '@qywork/core'
import { IMAGES_OMITTED } from '../compaction.ts'
import type { ToolOutcome } from '../registry.ts'

/** 与装配的请求一同写入请求账；之后修改模型设置不会改写本次申报。 */
export function requestConfiguration(
  req: ChatRequest,
  adapter: LlmAdapter,
): ProviderRequestConfiguration {
  return {
    contextWindow: adapter.spec.contextWindow,
    endpoint: diagnosticEndpoint(adapter.endpoint),
    modelMaxOutputTokens: adapter.spec.maxOutputTokens,
    maxOutputTokens:
      req.maxOutputTokens === null
        ? null
        : Math.min(req.maxOutputTokens, adapter.spec.maxOutputTokens ?? req.maxOutputTokens),
    effort: req.effort ?? null,
    idleTimeoutMs: req.idleTimeoutMs,
    toolCount: req.tools.length,
    messageCount: req.messages.length,
  }
}

/**
 * 按思考档位放宽流空闲上限，结果写入 `ChatRequest.idleTimeoutMs`，由传输层执行。
 *
 * 基准 180 秒针对常规档位。高档位下模型在首个 token 之前的思考时间较长：`xhigh`/`max`
 * 在长 prompt 上实测超过三分钟，此时中断的是一次正常请求。
 * 误判的代价（中断慢请求）远大于漏判（多等待一段时间），因此取较宽的值。
 *
 * 本规则不违反「不按模型名推测行为」：档位是用户显式选择的配置，不是从模型名推测的。
 */
export function idleTimeoutFor(effort: ChatRequest['effort']): number {
  if (effort === 'max') return STREAM_IDLE_TIMEOUT_MS * 3
  if (effort === 'xhigh') return STREAM_IDLE_TIMEOUT_MS * 2
  return STREAM_IDLE_TIMEOUT_MS
}

/**
 * 压缩触发阈值占窗口的比例，是压缩链路唯一的阈值常数。
 *
 * 预留 20% 给本轮尚未发生的占用：模型本轮的输出、下一批工具结果、
 * 估算与真值之间的残差。0.8 是通用取值，与模型无关，所有档位均为 80%。
 *
 * 不要再从中减去输出上限或投递预算：阈值会随模型的 `maxOutputTokens` 变化
 * （同为 1M 窗口的两个模型会得到 36.6% 与 62.2% 两个阈值），而请求合法性
 * 由申报钳位（`declaredMaxOutput`）保证，不由阈值保证。
 */
const TRIGGER_RATIO = 0.8

/**
 * 压缩的软阈值：占用超过该值时，在发出请求之前执行一次压缩。
 *
 * 具名导出供上下文面板绘制同一条阈值线：两处计算结果不同时，界面上的刻度
 * 与实际触发点不一致。
 */
export function softLimit(spec: { contextWindow: number }): number {
  return Math.floor(spec.contextWindow * TRIGGER_RATIO)
}

/**
 * 申报余量。必须在此单独预留：软阈值 `softLimit` 不参与下方的申报算式。
 *
 * 占用是估算值，估算低估多少，申报就超出窗口多少。取占用的 5%：估算器标定在
 * 1.03–1.18 倍（`ai/tokens.ts` 的 `TokenDensity`），已标定的模型上不会用到该余量；
 * 它针对的是未标定模型采用上界密度后仍然偏低的情况。
 */
const OUTPUT_DECLARATION_MARGIN_RATIO = 0.05

/**
 * 本轮申报的输出上限。`null` 表示不申报。
 *
 * 兼容协议按 `输入 + max_tokens ≤ 窗口` 校验，因此申报值表示本轮窗口还能容纳
 * 多少输出，而不是模型最多能输出多少。按规格上限静态申报会使高占用请求被
 * provider 直接拒绝：1M 档位上每次请求都会申报 384K。
 *
 * 规格上限为 `null`（未收录，即未经实测）时整轮不申报，不用窗口余量代替：
 * 该数值在未实测的端点上同样没有依据，发出后得到 400；不申报则采用端点自身的
 * 默认值。
 *
 * 余量不能省略。`occupancy` 是估算值，低估时算式申报的上限超出窗口容量，
 * 请求返回 400；该 400 若被容量分类判定为超出窗口，还会触发一次无效的有损压缩
 * 来处理一个申报错误。
 *
 * `max(1, …)` 是除零保护，不是可调的余量。
 */
export function declaredMaxOutput(
  spec: { contextWindow: number; maxOutputTokens: number | null },
  occupancy: number,
): number | null {
  if (spec.maxOutputTokens === null) return null
  const margin = Math.ceil(occupancy * OUTPUT_DECLARATION_MARGIN_RATIO)
  return Math.min(spec.maxOutputTokens, Math.max(1, spec.contextWindow - occupancy - margin))
}

export function mergeUsage(
  acc: RunUsage,
  turn: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number
    source: 'provider' | 'estimated'
  },
  adapter: LlmAdapter,
  turnIndex: number,
): void {
  acc.inputTokens += turn.inputTokens
  acc.outputTokens += turn.outputTokens
  acc.reasoningTokens += turn.reasoningTokens
  // null + 数字仍应是数字；null + null 保持 null（未回报）。
  if (turn.cachedTokens !== null) acc.cachedTokens = (acc.cachedTokens ?? 0) + turn.cachedTokens
  if (turn.cacheWriteTokens !== null) {
    acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + turn.cacheWriteTokens
  }
  const turnCost = computeCost(adapter.spec, turn)
  acc.cost = Math.round((acc.cost + turnCost) * 1e6) / 1e6
  acc.turns.push({
    turnIndex,
    input: turn.inputTokens,
    output: turn.outputTokens,
    cached: turn.cachedTokens,
    cacheWrite: turn.cacheWriteTokens,
    reasoning: turn.reasoningTokens,
    source: turn.source,
    usageStatus: turn.source === 'provider' ? 'ok' : 'missing',
    costUsd: turnCost,
    at: Date.now(),
  })
}

/**
 * 请求体指纹，用于在账本上识别同一份内容的重复发送。
 *
 * 非加密哈希已足够：它只判定两行是否为同一请求的重复，不承担安全语义。
 * 加密哈希会使每次装配多耗费数毫秒。
 */
export function payloadSnapshotOf(req: ChatRequest): { hash: string; bytes: number } {
  // 该序列化结果用于计算指纹；在同一字符串上读取字节数，避免为测量再次遍历长历史。
  const serialized = JSON.stringify([req.system, req.messages, req.tools])
  return { hash: Bun.hash(serialized).toString(36), bytes: Buffer.byteLength(serialized) }
}

/**
 * 请求信封的指纹：模型 + 冻结前缀 + 工具表，不含消息。
 *
 * 锚点表示上一次 provider 真值所描述的上下文。两次请求之间用户可以安装或卸载 MCP、
 * 安装技能、经 `load_tool` 加载工具、更换模型；信封变化后，该真值描述的已不是本次请求的
 * 上下文，而它仍是显示、压缩触发、`max_tokens` 钳位三处共用的计量基准。
 *
 * `req.model` 必须包含在内。系统提示词与工具表都不随模型变化，因此
 * 只哈希这两项时，换模型得到的是同一个指纹，锚点仍然有效，而该真值是由另一个
 * tokenizer 计量的。各厂商的中文密度相差 1.8 倍（`ai/tokens.ts` 的 `TokenDensity`），
 * 用它判断新模型的窗口即采用了错误的计量口径，且不会有任何报错。
 *
 * 不要复用 `payloadSnapshotOf`：它包含 messages，每轮必然变化，不能作为信封指纹。
 * 也不要复用 `prefix-audit` 的 `hashFrozen`：它只覆盖到最后一个缓存断点，
 * 不含工具表，而工具表是信封中最常变化的部分。
 */
export function envelopeHashOf(req: Pick<ChatRequest, 'model' | 'system' | 'tools'>): string {
  return Bun.hash(JSON.stringify([req.model, req.system, req.tools])).toString(36)
}

/**
 * 前缀指纹链的一步：将前一条消息的指纹与本条消息实际发送的字段拼接后计算。
 *
 * 字段按固定顺序读取：运行中的 transcript 与跨 run 投影得到的同一条消息键序不同，
 * 直接序列化整个对象会得到两个指纹。缓存断点与下划线开头的内部标记不计入指纹：
 * 它们在每次请求间会变化，provider 不将其视为前缀改写。原生推理只取条目本身。
 */
function nextPrefix(prev: string, m: WireMessage): string {
  const wire = [
    m.role,
    m.content,
    m.toolCalls?.map((c) => [c.id, c.name, c.arguments]) ?? null,
    m.toolCallId ?? null,
    m.reasoningContent ?? null,
    m.responseReasoning?.items ?? null,
  ]
  return Bun.hash(`${prev}\u0000${JSON.stringify(wire)}`).toString(36)
}

/** 整份请求的前缀指纹：该请求产生的原生推理条目记录此值。 */
export function reasoningPrefix(req: ChatRequest): string {
  return req.messages.reduce(nextPrefix, envelopeHashOf(req))
}

/**
 * 装配阶段的推理裁剪：请求中只保留当前协议会发送、且产生时前缀未变的推理。
 *
 * 原生条目记录的前缀与本次请求在该消息之前的前缀不同或缺失时即剥离：换模型、换工具表、
 * 压缩与收纳、图片省略、提示增删都会改变前缀，provider 不会按原样使用这类条目。
 * 某一条消息变化后，其后每一条的指纹都随之不同，因此剥离的总是该消息之后的全部条目。
 *
 * 必须在此处裁剪，不能只在适配器中裁剪：本地估算按请求中携带的推理计数，
 * 两处不一致时估算会多出一整段不会发送的思考。
 */
export function replayReasoning(
  messages: readonly WireMessage[],
  replay: ReasoningReplay,
  envelope: string,
): WireMessage[] {
  let prefix = envelope
  return messages.map((m) => {
    let out = m
    if (out.responseReasoning && (!replay.opaque || out.responseReasoning.prefix !== prefix)) {
      const { responseReasoning: _dropped, ...rest } = out
      out = rest
    }
    const carriesText =
      !out.responseReasoning &&
      (replay.text === 'all' || (replay.text === 'tool_turns' && !!out.toolCalls?.length))
    if (out.reasoningContent && !carriesText) {
      const { reasoningContent: _dropped, ...rest } = out
      out = rest
    }
    prefix = nextPrefix(prefix, out)
    return out
  })
}

/**
 * 将工具结果消息拆分为执行记录与工具结果两部分。
 *
 * 一条 tool 消息包含 `{call_id, tool, status, executed, summary, result}`：
 * 前四个字段是本次调用的事实信封，后两个是它返回的正文。两者的处理方式完全
 * 不同：正文可以写入 sink、可以在压缩时替换为定位符，信封不能修改。合并为一个分组时，
 * 面板无法区分上下文是被工具输出占用还是被模型正文占用。
 *
 * 计算方法：将同一份记录去掉正文后再估算一次，两次之差即为正文。
 * tokenization 不可加，因此不能分别估算两段再相加。
 *
 * 两次估算必须使用同一种方式，即 `estimateMessage` 估算整条消息时的方式：tool 角色整条
 * 按 JSON 档估算（`ai/tokens.ts` 的 `estimateMessage`），因此信封也只能使用 `estimateJson`。
 * 方式不一致时信封估值偏高一倍、差额从正文中扣除：实测一个 327 次调用的会话中
 * 有 167 次被下方的 `Math.min` 截为 `body = 0`，面板显示该调用没有返回正文，
 * 而实际返回了一句 summary。
 */
function splitToolResult(
  content: string,
  total: number,
  density: TokenDensity,
): { envelope: number; body: number } {
  try {
    const record = JSON.parse(content) as Record<string, unknown>
    if (typeof record !== 'object' || record === null) return { envelope: total, body: 0 }
    const { summary: _s, result: _r, ...envelope } = record
    const envelopeTokens = Math.min(total, estimateJson(JSON.stringify(envelope), density))
    return { envelope: envelopeTokens, body: total - envelopeTokens }
  } catch {
    // 不符合约定形状（插件自定义结果等）时整条计为执行记录，不强行拆分。
    return { envelope: total, body: 0 }
  }
}

/**
 * 按分组分解上下文占用。分组定义只有一份：`core` 的 `ContextGroup`。
 *
 * 本函数只负责估算，不负责对账：各组之和等于总数由 `core` 的 `reconcileBreakdown`
 * 保证（固定类目保留实测值，差额归入消息类目）。不要在本函数中使各组之和凑齐总数。
 */
export function breakdownOf(req: ChatRequest, density: TokenDensity): ContextBreakdown {
  const out = emptyBreakdown()
  out.systemPrompt = req.system.reduce((n, b) => n + estimateText(b.text, density), 0)

  // 工具 schema 分为两组，判据是 `mcp__` 前缀：`mcp/register.ts` 保证 MCP 工具
  // 一律带该前缀，插件工具使用 `<插件id>__`，归入内置一侧。两组的含义不同：
  // MCP 分组增长来自用户安装的服务器，内置分组增长来自内置工具表。
  const mcp = req.tools.filter((t) => t.name.startsWith('mcp__'))
  const builtin = req.tools.filter((t) => !t.name.startsWith('mcp__'))
  if (mcp.length) out.mcpTools = estimateSchemas(mcp, density)
  if (builtin.length) out.systemTools = estimateSchemas(builtin, density)

  for (const m of req.messages) {
    // 按整条消息估算：正文 + tool call 参数 + 思考正文 + 协议开销。
    // 只估算 `m.content` 会遗漏 `write_file` 的整份文件正文，该正文位于参数中。
    const n = estimateMessage(m, density)
    // 没有 `_group` 的消息一律计入 historyMessages，不另设「其他」分组：
    // 无法对账的「其他」分组比归入错误分组更难解释。
    const group = m._group ?? 'historyMessages'
    if (m.role === 'tool') {
      // 带图片的工具结果是块数组：信封所在的文本块同样拆分为执行记录与工具结果原文，
      // 图片按固定值计入工具结果一侧。不取出文本块时整条会计入 `_group`，
      // 面板上执行记录与工具结果两项的数值随之不一致。
      const envelopeText =
        typeof m.content === 'string'
          ? m.content
          : (m.content.find((b) => b.type === 'text')?.text ?? '')
      const media = typeof m.content === 'string' ? 0 : n - estimateJson(envelopeText, density)
      const { envelope, body } = splitToolResult(envelopeText, n - media, density)
      out.executionRecords += envelope
      out.intermediateContent += body + media
      continue
    }
    out[group] += n
  }
  return out
}

/** 在活跃 run 中将工具执行结果构造为模型可见的信封。 */
export function toolOutcomeContent(
  call: WireToolCall,
  outcome: ToolOutcome,
): string | ContentBlock[] {
  const resources = (outcome.resources ?? []).map((r) => r.resourceId)
  const result = envelopeResult(outcome.data)
  return toolResultContent(
    JSON.stringify({
      call_id: call.id,
      tool: call.name,
      status: outcome.status,
      executed: outcome.executed,
      summary: outcome.message,
      // 定位符作为独立的键，正文被收纳后仍可调用 `read_resource`。
      ...(resources.length ? { resources } : {}),
      // 图像字节只放入图像块，其他结果保留在信封中。
      ...(result ? { result } : {}),
    }),
    outcome.data,
  )
}

/**
 * 工具结果的模型可见内容。
 *
 * 信封 JSON 不得改动：估算（`breakdownOf`）与收纳（`condenseMessage`）都依赖解析它。
 * 图片作为并列的内容块放在信封之后，不写入信封。
 *
 * 图像块使用已有的 base64，视频块只带路径，均不读取磁盘，因此本函数是同步的，
 * 投影侧（`runtime/transcript.ts` 的 `toolContent`）才能用同一形状重建历史：
 * 投影侧有一个同步调用方（压缩的单元装配），读取磁盘会使整条调用链变为 async。
 *
 * 两侧必须逐字同形。形状不同时，同一次调用在本轮与下一轮的内容不一致，
 * 模型会视为两次调用，且这种不一致不会产生任何报错。
 */
export function toolResultContent(
  envelope: string,
  data: Record<string, unknown> | undefined,
): string | ContentBlock[] {
  const images = imagesOf(data)
  const videos = videosOf(data)
  if (!images.length && !videos.length) return envelope
  return [
    { type: 'text', text: envelope },
    ...images.map(
      (i): ContentBlock => ({
        type: 'image',
        mimeType: i.mime,
        source: { kind: 'base64', data: i.data },
      }),
    ),
    ...videos.map(
      (v): ContentBlock => ({
        type: 'video',
        mimeType: v.mime,
        source: { kind: 'path', path: v.path },
      }),
    ),
  ]
}

/**
 * `outcome.data.videos` 中的视频：工作区内的绝对路径与 MIME 类型。
 *
 * 视频只记录路径、不记录字节：视频通常有数十至上百 MB，写入执行记录的代价过大；发出前由 `materialize`
 * 按模型能力读取字节或替换为文本说明。生成的视频写入磁盘时不覆盖已有文件，因此路径指向的始终是读取时的内容。
 */
export function videosOf(
  data: Record<string, unknown> | undefined,
): { path: string; mime: string }[] {
  const raw = data?.videos
  if (!Array.isArray(raw)) return []
  const out: { path: string; mime: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { path, mime } = item as { path?: unknown; mime?: unknown }
    if (typeof path === 'string' && path) {
      out.push({ path, mime: typeof mime === 'string' ? mime : 'video/mp4' })
    }
  }
  return out
}
/**
 * 请求中携带的媒体（工具结果与用户消息中的图像、视频块）的字节上限，以及超限后换出的目标值。
 *
 * 媒体保留在请求中前缀才不变：移出一次图片，`replayReasoning` 就会剥离其后的全部原生推理，
 * 模型既看不到图片，也失去看图时得出的判断，只能反复重新读取。全部常驻又会使长任务的请求体超过端点上限
 * （实测 98 张图、50 MB 被 413 拒绝），中转服务的响应头时间也随请求体增长（实测小于 1 MB 约 3–5 秒，
 * 3–6 MB 约 11–15 秒）。
 * 超限时整批换出至下限，不要改为每次只换出最早的一张：换出会改变前缀，逐张换出会使前缀每一步都变化。
 * 上限在 2–8 MB 之间实测识别质量无差别：越小换出越频繁，每次换出都使缓存重新计算一次；越大则长任务后段请求越慢。
 */
export const MEDIA_RETAIN_HIGH_BYTES = 5 * 1024 * 1024
export const MEDIA_RETAIN_LOW_BYTES = 2 * 1024 * 1024

/** 路径视频在本轮的发送方式：内联字节、上传后发送地址，或不直接发送、替换为指向 `read_file` 抽帧的说明。 */
export type VideoDelivery = 'inline' | 'upload' | 'frames'

/**
 * 路径视频的发送方式。换出预算（`mediaBytes`）、发送前物化（`materialize`）与 `read_file` 读取视频
 * 共用本函数，三处判定因此一致。
 *
 * 模型不接受原生视频时使用抽帧；适配器支持上传时大文件上传，请求中只带地址；不能上传且超过常驻上限的也使用
 * 抽帧：内联视频按字节计入常驻预算，超过上限的在下一步即被整批换出，模型只能看到一次，与图片只发送一次的情形相同。
 */
export function videoDelivery(
  size: number,
  caps: Pick<InputMediaCapabilities, 'video' | 'mediaUploadAbove'>,
): VideoDelivery {
  if (!caps.video) return 'frames'
  if (caps.mediaUploadAbove !== undefined && size > caps.mediaUploadAbove) return 'upload'
  return size > MEDIA_RETAIN_HIGH_BYTES ? 'frames' : 'inline'
}

/**
 * 一条消息中媒体块实际写入请求体的字节数。base64 按解码后的长度计；路径视频按 `videoDelivery`：
 * 内联的按文件大小计，上传后发送地址的与不直接发送的记 0。不发送的图片（模型不接受图片）记 0，无法读取的文件记 0。
 *
 * 不要改为一律按文件大小计：上传后发送地址的大视频会被计为数十 MB，在下一步即被换出，模型只能看到一次。
 */
export function mediaBytes(m: WireMessage, caps: InputMediaCapabilities): number {
  if (typeof m.content === 'string' || !m.content) return 0
  let total = 0
  for (const b of m.content) {
    if (b.type !== 'image' && b.type !== 'video') continue
    if (b.type === 'image' && caps.image === false) continue
    if (b.type === 'video' && !caps.video) continue
    if (b.source.kind === 'base64') total += Math.floor((b.source.data.length * 3) / 4)
    else if (b.source.kind === 'path') {
      let size = 0
      try {
        size = statSync(b.source.path).size
      } catch {
        // 文件已不存在：`materialize` 会将其替换为一行说明，不计媒体字节。
        continue
      }
      if (b.type === 'image' || videoDelivery(size, caps) === 'inline') total += size
    }
  }
  return total
}

/**
 * 计算本次请求中哪些消息的媒体替换为说明，返回下标集合，交给 `omitImages`。
 *
 * 按消息顺序累计媒体字节；累计超过上限时，从最早仍携带媒体的消息起整条换出，直到降至下限以下。
 * 最后一条 assistant 消息之后的媒体不换出：它们尚未随任何一次得到响应的请求发出。
 * 工具成功后的请求被拒绝、在新的 run 中继续执行时，这批图片仍在该区段内，因此无需另行记录送达凭证。
 *
 * 结果只依赖消息序列与本轮的媒体发送方式：同一历史、同一模型每次得到相同结果，追加消息只会增加换出、
 * 不会恢复已换出的媒体。换模型会改变发送方式，换出集合随之重新计算，前缀在该次请求中改变。
 */
export function evictedMedia(
  messages: readonly WireMessage[],
  caps: InputMediaCapabilities,
): Set<number> {
  let protectFrom = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      protectFrom = i + 1
      break
    }
  }
  const evicted = new Set<number>()
  const mounted: { index: number; bytes: number }[] = []
  let total = 0
  messages.forEach((m, index) => {
    const bytes = mediaBytes(m, caps)
    if (!bytes) return
    mounted.push({ index, bytes })
    total += bytes
    if (total <= MEDIA_RETAIN_HIGH_BYTES) return
    while (total > MEDIA_RETAIN_LOW_BYTES && mounted.length && mounted[0]!.index < protectFrom) {
      const out = mounted.shift()!
      evicted.add(out.index)
      total -= out.bytes
    }
  })
  return evicted
}

/** 用户消息的附件媒体被换出后替换成的说明。路径位于同一条消息的附件说明中。 */
export const ATTACHMENT_MEDIA_OMITTED =
  '（本条消息附带的图片或视频此前已随请求发送给你，现已从请求中移出；需要时按本条消息附件说明中的路径读取。）'

/**
 * 将一条消息的媒体替换为说明，用于 `evictedMedia` 选中的消息。
 *
 * - 工具结果：替换为只有信封的形态，信封中的 `images_omitted` 注明图片已发送过（`IMAGES_OMITTED`），
 *   与收纳产物同形（`compaction.ts` 的 `condenseToolResult`）。模型据此字段得知图片已不在请求中，
 *   缺少该字段时会认为图片仍然可见。`result` 保留，只移除媒体块。
 * - 用户消息：媒体块替换为一行 `ATTACHMENT_MEDIA_OMITTED`，正文不变。
 *
 * 输出必须逐字稳定，且无媒体时返回原引用：投影在每次构造请求时都会执行，输出不稳定会使缓存
 * 断点之前的字节每次都变化。
 */
export function omitImages(m: WireMessage): WireMessage {
  if (typeof m.content === 'string' || !m.content) return m
  if (!m.content.some((b) => b.type === 'image' || b.type === 'video')) return m
  if (m.role === 'user') {
    const rest = m.content.filter((b) => b.type !== 'image' && b.type !== 'video')
    return { ...m, content: [{ type: 'text', text: ATTACHMENT_MEDIA_OMITTED }, ...rest] }
  }
  if (m.role !== 'tool') return m
  const text = m.content.find((b) => b.type === 'text')
  if (!text || text.type !== 'text') return m
  let env: Record<string, unknown>
  try {
    env = JSON.parse(text.text) as Record<string, unknown>
  } catch {
    return m
  }
  return { ...m, content: JSON.stringify({ ...env, images_omitted: IMAGES_OMITTED }) }
}

/**
 * `outcome.data.images` 中的图片。
 *
 * 类型是数组而不是单张：MCP 工具一次调用可返回多张图片，只取第一张会丢弃其余图片且没有提示。
 * `read_file` 读取一个文件时返回单元素数组。
 */
export function imagesOf(
  data: Record<string, unknown> | undefined,
): { data: string; mime: string }[] {
  const raw = data?.images
  if (!Array.isArray(raw)) return []
  const out: { data: string; mime: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { data: bytes, mime } = item as { data?: unknown; mime?: unknown }
    if (typeof bytes === 'string' && bytes) {
      out.push({ data: bytes, mime: typeof mime === 'string' ? mime : 'image/png' })
    }
  }
  return out
}

/**
 * 写入信封的 `result`。
 *
 * 必须移除图像字节：信封是一段 JSON 文本，保留 `images` 会使同一份
 * base64 在请求体中出现两次，一次在图像块中，一次在信封文本中；后者对模型
 * 没有用处（模型无法解读 base64 文本），只会按 token 计费。
 */
export function envelopeResult(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || !('images' in data || 'videos' in data)) return data
  const { images: _bytes, videos: _paths, ...rest } = data
  return Object.keys(rest).length ? rest : undefined
}

/**
 * 本轮请求的媒体发送能力：模型是否接受图片与原生视频，适配器是否接受本地路径、能否将大文件上传后
 * 以地址发送。由 `AgentLoop` 按当前适配器计算一次，换出预算与发送前物化使用同一份结果。
 */
export interface InputMediaCapabilities {
  image: boolean | null
  video: boolean
  mediaPaths?: boolean
  /** 本地路径媒体超过该字节数时由适配器上传，请求中只带地址；缺失表示一律内联。 */
  mediaUploadAbove?: number
}

/**
 * 将 path 形态的图片和视频块转换为临时 base64，交给适配器。
 *
 * 只生成副本，不得修改原对象。原地修改会同时造成两个错误：
 *
 * - 重试循环中 `req = { ...req, signal }` 是浅拷贝，复用同一个 `messages` 数组，
 *   而 `payloadHash` 在每次尝试发出之前已写入账本。原地修改后，第二次尝试会对同一份
 *   内容算出不同的哈希，而该字段的用途是识别同一份内容的重复发送。
 * - `req.messages` 的元素与 `transcript` 是同一批对象，原地修改会使 base64 在
 *   整个 run 期间常驻内存。
 *
 * path 形态只剩视频（用户附件与工具读取的视频）。图片进入消息时已经是字节：工具图片保存在执行记录中，
 * 附件图片由 `runtime` 的 `withAttachments` 编码。
 *
 * 图片按模型能力裁决；视频还要求当前适配器实现原生视频传输，发送方式按 `videoDelivery`。
 *
 * 文件不存在或能力不支持时替换为文本说明，不使整轮静默丢失媒体。视频只在一种情况下按大小拦截：
 * 适配器不能上传、视频又超过请求中常驻媒体的上限时，内联后下一步即被换出，因此替换为指向
 * `read_file` 抽帧的说明。其余大小上限由实际 Provider 协议裁决。
 */
export async function materialize(
  req: ChatRequest,
  capabilities: InputMediaCapabilities,
): Promise<ChatRequest> {
  if (!req.messages.some((m) => typeof m.content !== 'string')) return req
  const messages = await Promise.all(
    req.messages.map(async (m) => {
      if (typeof m.content === 'string') return m
      const blocks = await Promise.all(m.content.map((b) => loadBlock(b, capabilities)))
      return { ...m, content: blocks }
    }),
  )
  return { ...req, messages }
}

async function loadBlock(
  b: ContentBlock,
  capabilities: InputMediaCapabilities,
): Promise<ContentBlock> {
  if (b.type === 'text') return b
  const label = b.type === 'image' ? '图片' : '视频'
  const where = b.source.kind === 'path' ? `${label} ${b.source.path}` : label
  const note = (why: string): ContentBlock => ({ type: 'text', text: `［${where}：${why}］` })

  /*
   * 模型不接受图片：替换为文本说明，不发送图像块。
   *
   * 判据只认 `false`：`null` 表示厂商规格页未注明，照常发送（约定见
   * `ModelSpec.vision`）。缺少该分支时，带图片的会话切换到纯文本模型后每一轮都被
   * 端点以 400 拒绝，且手动删除图片无法修复历史中已有的图片。
   */
  if (b.type === 'image' && capabilities.image === false) {
    return note('当前模型不接受图片输入，此图片未发送')
  }
  /*
   * 模型不接受原生视频：接受图片且有路径时，说明中指向 `read_file`，它按时间抽帧并返回图片。
   * 用户附件的视频同样经由此分支，不另建抽帧实现：附件与工具读取的视频由同一个入口转换为帧。
   */
  if (b.type === 'video' && !capabilities.video) {
    const next =
      b.source.kind === 'path' && capabilities.image !== false
        ? '；需要画面时用 read_file 读取此路径，将按时间抽取若干帧'
        : ''
    return note(`当前模型或接口不接受原生视频输入，此视频未发送${next}`)
  }

  if (b.source.kind !== 'path') return b
  const { path } = b.source

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return note('已不存在')
  if (b.type === 'video' && videoDelivery(info.size, capabilities) === 'frames') {
    const mb = (info.size / 1024 / 1024).toFixed(1)
    const next =
      capabilities.image !== false ? '；需要画面时用 read_file 读取此路径，将按时间抽取若干帧' : ''
    return note(
      `此视频 ${mb} MB，超出请求中常驻媒体的上限，且当前接口不支持上传，未直接发送${next}`,
    )
  }
  if (capabilities.mediaPaths) return b
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return note('读取失败')
  return {
    ...b,
    source: { kind: 'base64', data: bytes.toString('base64') },
  }
}
