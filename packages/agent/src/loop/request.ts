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

/** 与装配的请求一起落账；后续改模型设置不会改写这次申报。 */
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
 * 按思考档位放宽流空闲上限，结果填进 `ChatRequest.idleTimeoutMs` 交给传输层执行。
 *
 * 基准 180 秒是给常规档留的。高档位下首 token 之前模型要先想很久——`xhigh`/`max`
 * 在长 prompt 上实测能超过三分钟，而那时掐掉的是一次**完全正常**的请求。
 * 判错的代价（把慢请求掐死）比判漏（多挂一会儿）大得多，所以往宽了给。
 *
 * 这条与「不按模型名猜行为」不冲突：档位是**用户显式选的配置**，不是从名字推的。
 */
export function idleTimeoutFor(effort: ChatRequest['effort']): number {
  if (effort === 'max') return STREAM_IDLE_TIMEOUT_MS * 3
  if (effort === 'xhigh') return STREAM_IDLE_TIMEOUT_MS * 2
  return STREAM_IDLE_TIMEOUT_MS
}

/**
 * 触发线在窗口里的位置。**压缩链路唯一的阈值常数。**
 *
 * 留两成给「这一轮还要发生的事」：模型这一轮的输出、下一波工具结果、
 * 估算与真值之间的残差。取 0.8 是通用做法，与模型无关——每一档都是 80%。
 *
 * **不要把输出上限或投递预算再减一遍。** 那样阈值会随模型的 `maxOutputTokens`
 * 漂移（同为 1M 窗口的两个模型会得到 36.6% 与 62.2% 两条线），而请求合法性
 * 由申报钳位（`declaredMaxOutput`）保证，不由阈值保证。
 */
const TRIGGER_RATIO = 0.8

/**
 * 压缩的软阈值：占用超过它就在**发出之前**压一次。
 *
 * 具名导出是因为上下文面板要画同一条线——两处算出不同的数，用户看到的刻度
 * 就不是真正会触发的那个点。
 */
export function softLimit(spec: { contextWindow: number }): number {
  return Math.floor(spec.contextWindow * TRIGGER_RATIO)
}

/**
 * 申报余量。**这一处必须自己留，`softLimit` 罩不到它**——软阈值不在下面那个式子里。
 *
 * 占用是估算出来的，估算低估多少，申报就超出窗口多少。取占用的 5%：估算器标定在
 * 1.03–1.18 倍（`ai/tokens.ts` 的 `TokenDensity`），已标定的模型上这个余量用不到；
 * 它挡的是未标定模型走上界档仍然偏低的那一档。
 */
const OUTPUT_DECLARATION_MARGIN_RATIO = 0.05

/**
 * 这一轮申报多少输出上限。`null` = 不申报。
 *
 * 兼容协议按 `输入 + max_tokens ≤ 窗口` 校验，所以申报回答的是「这一轮还装得下
 * 多少输出」，不是「这个模型最多能输出多少」。**静态按规格上限申报**会让
 * 高占用请求被 provider 直接拒——1M 档上那是每次都挂着 384K 的申报。
 *
 * 规格上限是 `null`（未收录 = 没测过）时**整轮不申报**，不拿窗口余量顶上去：
 * 那个数在没测过的端点上一样是编的，发出去换来的是一个 400，而不申报换来的
 * 是端点自己的默认。
 *
 * **余量不能省。** `occupancy` 是估算值，它低估时这个式子申报的就是一个装不下的
 * 上限，换回来一个 400；而那个 400 若被容量分类认成撞窗，还会多一次无效的有损压缩去
 * 救一个申报错误。
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
 * 请求体指纹。用来在账本上认出「同一份内容发了两遍」。
 *
 * 非加密哈希是够的：它回答的是「这两行是不是同一次请求的重复」，
 * 不承担任何安全语义。用加密哈希只会让每次装配多花几毫秒。
 */
export function payloadSnapshotOf(req: ChatRequest): { hash: string; bytes: number } {
  // 这次序列化原本就用于指纹；在同一份字符串上读字节数，避免为测量再遍历一遍长历史。
  const serialized = JSON.stringify([req.system, req.messages, req.tools])
  return { hash: Bun.hash(serialized).toString(36), bytes: Buffer.byteLength(serialized) }
}

/**
 * 请求信封的指纹：模型 + 冻结前缀 + 工具表，**不含消息**。
 *
 * 锚点的语义是「上一次真值描述的那个上下文」。两次请求之间用户可以装卸 MCP、
 * 装技能、`load_tool` 装工具、换模型——信封换了，那个真值描述的就不是这一次
 * 的上下文了，而它仍然是三处共用的那把尺（显示、压缩触发、`max_tokens` 钳位）。
 *
 * **`req.model` 必须在里面。** 系统提示词不随模型变、工具表也不随模型变，所以
 * 只哈希这两项时换模型得到的是同一个指纹，锚点存活——而那个真值是另一个
 * tokenizer 量出来的。中文密度各家差 1.8 倍（`ai/tokens.ts` 的 `TokenDensity`），
 * 拿它去判新模型的窗口就是量错了尺，而且不会有任何报错。
 *
 * **不要复用 `payloadSnapshotOf`**：它含 messages，每轮必变，当不了信封。
 * 也不要复用 `prefix-audit` 的 `hashFrozen`：它只覆盖到最后一个缓存断点，
 * 不含工具表，而工具表正是最常变的那一半。
 */
export function envelopeHashOf(req: Pick<ChatRequest, 'model' | 'system' | 'tools'>): string {
  return Bun.hash(JSON.stringify([req.model, req.system, req.tools])).toString(36)
}

/**
 * 前缀指纹链的一步：前一位的指纹接上这条消息会上线的字段。
 *
 * 字段按固定顺序取：活的 transcript 与跨 run 投影出来的同一条消息键序不同，
 * 直接序列化整个对象会得到两个指纹。缓存断点与下划线开头的内部标记不进指纹，
 * 它们逐次请求会变，provider 不把它们算作前缀改写。原生推理只取条目本身。
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

/** 整份请求的前缀指纹：由它产生的原生推理条目记下这个值。 */
export function reasoningPrefix(req: ChatRequest): string {
  return req.messages.reduce(nextPrefix, envelopeHashOf(req))
}

/**
 * 装配点的推理裁剪：请求里只留这条协议会发、且产生时前缀未变的推理。
 *
 * 原生条目记下的前缀与本次请求在这条消息之前的前缀不同或缺席即剥离——换模型、换工具表、
 * 压缩与收纳、图片省略、提示增删都会改前缀，provider 对这样的条目不按原样使用。
 * 某一位变了，其后每一位的指纹都随之不同，所以剥离的总是那一位之后的全部条目。
 *
 * 必须在这里裁而不是只在适配器里裁：本地估算按请求里挂着的推理计数，
 * 两处不一致时估算会多出一整段不上线的思考。
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
 * 工具结果消息的**执行记录 / 工具结果**二分。
 *
 * 一条 tool 消息里装的是 `{call_id, tool, status, executed, summary, result}`：
 * 前四个是这次调用的**事实信封**，后两个是它**带回来的正文**。两者的处置完全
 * 不同——正文可以落 sink、可以在压缩时换成定位符，信封不能动。合成一个桶，
 * 面板就答不了「上下文是被工具输出占用的，还是被模型正文占用的」。
 *
 * 量法：把同一份记录**去掉正文再量一次**，两次之差就是正文。
 * tokenization 不可加，所以不能分别量两段再相加。
 *
 * **两次必须同尺，而且是 `estimateMessage` 量整条时用的那一把。** tool 角色整条走
 * JSON 档（`ai/tokens.ts` 的 `estimateMessage`），所以信封也只能走 `estimateJson`。
 * 尺不同的代价实测过：信封虚高一倍、差额从正文里扣，一条 327 次调用的会话里
 * 167 条被下面的 `Math.min` 夹成 `body = 0`，面板上读作「这次调用没带回任何正文」，
 * 而它带回了一句 summary。
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
    // 不是约定的那份形状（插件自定义结果等）——整条算执行记录，不硬拆。
    return { envelope: total, body: 0 }
  }
}

/**
 * 上下文占用按组分解。桶的口径只有一份：`core` 的 `ContextGroup`。
 *
 * 这里只负责量，不负责对账——各组之和与总数的恒等由 `core` 的 `reconcileBreakdown`
 * 保证（固定类目保实测值，差额归到消息类目）。不要在这个函数里追求「加起来正好」。
 */
export function breakdownOf(req: ChatRequest, density: TokenDensity): ContextBreakdown {
  const out = emptyBreakdown()
  out.systemPrompt = req.system.reduce((n, b) => n + estimateText(b.text, density), 0)

  // 工具 schema 分两桶。判据是 `mcp__` 前缀——`mcp/register.ts` 保证 MCP 工具
  // 一律带它，插件工具走 `<插件id>__` 归内置一侧。这两类的处置完全不同：
  // MCP 涨了是用户装的服务器在涨，内置涨了是内置工具表在涨。
  const mcp = req.tools.filter((t) => t.name.startsWith('mcp__'))
  const builtin = req.tools.filter((t) => !t.name.startsWith('mcp__'))
  if (mcp.length) out.mcpTools = estimateSchemas(mcp, density)
  if (builtin.length) out.systemTools = estimateSchemas(builtin, density)

  for (const m of req.messages) {
    // 整条量：正文 + tool call 参数 + 思考正文 + 协议开销。
    // 只量 `m.content` 会把 `write_file` 的整份文件正文漏掉——它在参数里。
    const n = estimateMessage(m, density)
    // 没有 `_group` 的一律归 historyMessages，不单开「其他」桶——
    // 一个永远对不上账的「其他」比归错桶更难解释。
    const group = m._group ?? 'historyMessages'
    if (m.role === 'tool') {
      // 带图的工具结果是块数组：信封那一块照旧拆成「执行记录 / 工具结果原文」，
      // 图片按固定值计进工具结果一侧。不取出文本块的话整条会落进 `_group`，
      // 面板上那两格从此对不上。
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

/** 活跃 run 中工具执行结果到模型可见信封的构造点。 */
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
      // 定位符单独成键，收纳正文后仍能调用 `read_resource`。
      ...(resources.length ? { resources } : {}),
      // 图像字节只进图像块，其他结果留在信封。
      ...(result ? { result } : {}),
    }),
    outcome.data,
  )
}

/**
 * 工具结果的模型可见内容。
 *
 * **信封那段 JSON 一个字不改**——量账（`breakdownOf`）与收纳（`condenseMessage`）
 * 都靠解析它认路。图片作为**并列的一块**挂在它旁边，不塞进信封里。
 *
 * 图像块给的是**路径不是字节**，所以这个函数是同步的，投影那侧
 * （`runtime/transcript.ts` 的 `toolContent`）才能用同一份形状重建历史——
 * 那边有一个同步调用方（压缩的单元装配），读盘会把整条链拖成 async。
 *
 * **两侧必须逐字同形。** 不同形的话，同一次调用在本轮和下一轮长得不一样，
 * 模型会当成两件事，而这种不一致不会有任何报错。
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
 * `outcome.data.videos` 里那几段：工作区里的绝对路径与类型。
 *
 * 视频给路径不给字节：动辄几十上百 MB，定格进执行记录代价过大；发出前由 `materialize` 按模型能力
 * 读字节或换成说明。视频文件由生成落盘时不覆盖，路径指向的就是读取那一刻的内容。
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
 * 请求里挂着的媒体（工具结果与用户消息里的图像、视频块）的字节上限，以及超限后换出到的目标。
 *
 * 媒体留在请求里前缀才不变：摘一次图，`replayReasoning` 就剥掉其后全部原生推理，模型看不到图，
 * 看图时得出的判断也随之丢失，只能反复取回。全部常驻又会让长任务的请求体涨过端点上限（实测 98 张图、50 MB
 * 被 413 拒绝），中转的响应头时间也随请求体增长（实测小于 1 MB 约 3–5 秒，3–6 MB 约 11–15 秒）。
 * 超限时整批换出到下限，不要改成每次只换最早的一张：换出改前缀，逐张换会让前缀每一步都变。
 */
export const MEDIA_RETAIN_HIGH_BYTES = 4 * 1024 * 1024
export const MEDIA_RETAIN_LOW_BYTES = 2 * 1024 * 1024

/** 一条消息里媒体块的字节数：base64 按解码后的长度，路径按文件大小，读不到记 0。 */
export function mediaBytes(m: WireMessage): number {
  if (typeof m.content === 'string' || !m.content) return 0
  let total = 0
  for (const b of m.content) {
    if (b.type !== 'image' && b.type !== 'video') continue
    if (b.source.kind === 'base64') total += Math.floor((b.source.data.length * 3) / 4)
    else if (b.source.kind === 'path') {
      try {
        total += statSync(b.source.path).size
      } catch {
        // 文件已不在：`materialize` 会把它换成一行说明，不占媒体字节。
      }
    }
  }
  return total
}

/**
 * 这次请求里哪些消息的媒体换成说明，返回下标集合，交给 `omitImages`。
 *
 * 按消息顺序累计媒体字节；累计超过上限时，从最早仍挂着的那条起整条换出，直到降到下限以下。
 * 最后一条 assistant 消息之后的媒体不换出：它们还没随任何一次得到回应的请求发出去过。
 * 工具成功后那次请求被拒、换一个 run 续跑时，那批图仍在这一段里，所以不需要另记送达凭证。
 *
 * 只依赖消息序列：同一历史每次得到同一结果，追加消息只会多换出、不会让已换出的回来。
 */
export function evictedMedia(messages: readonly WireMessage[]): Set<number> {
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
    const bytes = mediaBytes(m)
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

/** 用户消息的附件媒体被换出后留下的一行。路径在同一条消息的附件说明里。 */
export const ATTACHMENT_MEDIA_OMITTED =
  '（这条消息附带的图片或视频此前已随请求发送给你，现已从请求中移出；需要时按本条消息附件说明里的路径读取。）'

/**
 * 把一条消息的媒体换成说明，交给 `evictedMedia` 选中的消息用。
 *
 * - 工具结果：换成只有信封的形态，信封里的 `images_omitted` 写明已发送过（`IMAGES_OMITTED`），
 *   与收纳产物同形（`compaction.ts` 的 `condenseToolResult`）。模型据这一位知道图不在场，
 *   缺了它会把图当成仍然可见。`result` 保留，只有媒体块被摘掉。
 * - 用户消息：媒体块换成 `ATTACHMENT_MEDIA_OMITTED` 一行，正文不动。
 *
 * **必须逐字稳定且无媒体时返回原引用**：投影每次构造请求都跑一遍，产物抖动会让缓存
 * 断点之前的字节每次都变。
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
 * `outcome.data.images` 里那几张。
 *
 * **是数组不是单张**：MCP 工具一次调用能带回好几张图，取第一张就是把其余的静默丢掉。
 * `read_file` 读一个文件，给一个一元数组。
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
 * 进信封的那一份 `result`。
 *
 * **必须把图像字节摘掉**：信封是一段 JSON 文本，`images` 留在里面会让同一份
 * base64 在请求体里出现两次——一次在图像块里、一次在信封的文本里，而后者对模型
 * 毫无用处（它读不懂一串 base64），只是照价计费。
 */
export function envelopeResult(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || !('images' in data || 'videos' in data)) return data
  const { images: _bytes, videos: _paths, ...rest } = data
  return Object.keys(rest).length ? rest : undefined
}

export interface InputMediaCapabilities {
  image: boolean | null
  video: boolean
  mediaPaths?: boolean
}

/**
 * 把 path 形态的图片和视频块换成临时 base64，交给适配器。
 *
 * **产副本，绝不回写。** 原地改会同时坏两件事：
 *
 * - 重试循环里 `req = { ...req, signal }` 是浅拷贝、**复用同一个 `messages` 数组**，
 *   而 `payloadHash` 在每次尝试发出**之前**就落了账。原地改之后第二次尝试会对同一份
 *   内容算出不同的哈希，而那个字段的职责是「认出同一份内容发了两遍」。
 * - `req.messages` 的元素与 `transcript` 是同一批对象，原地改等于把 base64 留在
 *   内存里常驻整个 run。
 *
 * path 形态只剩视频（用户附件与工具读到的视频）。图片进入消息时已经是字节：工具图定格在执行记录里，
 * 附件图由 `runtime` 的 `withAttachments` 编码。
 *
 * 图片按模型能力裁决；视频还要求当前适配器实现原生视频传输。
 *
 * 文件不存在或能力不支持时换成文本说明，不让整轮静默丢失媒体。媒体大小由实际
 * Provider 协议裁决；这里使用统一阈值会把支持大文件的端点提前截断。
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
   * 模型不收图片：换成文本注记，不发图像块。
   *
   * 判据只认 `false`——`null` 是「厂商规格页没写」，照常发（约定写在
   * `ModelSpec.vision` 上）。少了这一支，带图的会话切到纯文本模型之后每一轮都被
   * 端点以 400 拒绝，而手动删图救不回历史里已有的那些。
   */
  if (b.type === 'image' && capabilities.image === false) {
    return note('当前模型不接受图片输入，这一张没有发出去')
  }
  if (b.type === 'video' && !capabilities.video) {
    return note('当前模型或接口不接受原生视频输入，这一段没有发出去')
  }

  if (b.source.kind !== 'path') return b
  const { path } = b.source

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return note('已不存在')
  if (capabilities.mediaPaths) return b
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return note('读取失败')
  return {
    ...b,
    source: { kind: 'base64', data: bytes.toString('base64') },
  }
}
