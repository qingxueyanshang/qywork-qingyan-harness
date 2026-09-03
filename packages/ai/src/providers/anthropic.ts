/**
 * Anthropic 原生适配器。
 *
 * 用官方 SDK（@anthropic-ai/sdk），不手搓 HTTP——SDK 负责 SSE 解析、鉴权头和 beta 头，
 * 手搓这些只会重复造轮子并且随协议演进腐烂。超时与重试**由这边指定**
 * （`PROVIDER_HTTP`），不用它的出厂值。
 *
 * 这一层的职责是把 ChatRequest 的通用形状翻译成 provider-native 形状，并且**在装配期
 * 就消灭会 400 的组合**——不是发出去挨一个错误再兜底：
 *
 * 1. 采样参数（temperature/top_p/top_k）在 Claude 5 系一律 400 → 不提供入口。
 * 2. `budget_tokens` 在 Opus 5 / Sonnet 5 / Fable 5 系 / Opus 4.7+ 一律 400 → 按 spec.thinking 分派。
 * 3. Fable 5 系思考恒开，连 `{type:'disabled'}` 都 400 → 直接省略 thinking 字段。
 * 4. Opus 5 关思考只允许到 effort=high，配 xhigh/max 会 400 → 装配期降档并记录。
 * 5. Opus 5 / Sonnet 5 **省略 thinking 也会思考**，而 max_tokens 同时封顶思考与正文
 *    → 按 thinksByDefault 抬高输出预算下限，否则回答会从中间被截断。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { EffortLevel } from '@qywork/core'
import { effortIsTransmittable, type ModelSpec } from '../catalog.ts'
import { classifyProviderError, namelessToolCall } from '../errors.ts'
import {
  estimateMessage,
  estimateRequest,
  estimateSchemas,
  estimateText,
  type TokenDensity,
} from '../tokens.ts'
import type {
  ChatRequest,
  LlmAdapter,
  ProviderEvent,
  ProviderProfile,
  ProviderStopReason,
  ProviderUsage,
  ToolSchema,
  WireMessage,
  WireToolCall,
} from '../types.ts'
import { imageData, outputCap, PROVIDER_HTTP } from '../types.ts'
import { mergeContextIntoUsers } from './context.ts'

/**
 * 思考开启时给输出留的最小预算。低于这个数，思考稍微长一点正文就没地方写了，
 * 表现为「回答说到一半没了」而不是一个明确的错误——最难排查的那类故障。
 */
const MIN_TOKENS_WHEN_THINKING = 16_000

/**
 * 谁都不申报时这条协议只能自己填的那个数。
 *
 * **这条协议的 `max_tokens` 是必填的**，所以「不申报」在这里没有对应写法——
 * 另两条协议整个不发这个字段，这条不行。取 64K 是 Anthropic 系当前的普遍上限；
 * 端点真实上限更低时换来的是一个带原话的 400，而不是静默截断。
 *
 * 只在未收录模型上用得到。知道确切上限就在模型库那一格填 `maxOutputTokens`。
 */
const UNDECLARED_MAX_TOKENS = 64_000

export class AnthropicAdapter implements LlmAdapter {
  readonly kind = 'anthropic_messages' as const
  get transmits(): { effort: boolean } {
    return { effort: effortIsTransmittable(this.spec) }
  }
  readonly spec: ModelSpec
  private readonly client: Anthropic

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    this.client = new Anthropic({
      // 空 key 也允许构造：BYOK 下用户可能还没配 key，此时 UI 仍要能起来。
      // 真正没 key 的错误在首次发请求时抛，由 classifyProviderError 归类成
      // no_api_key，前端据此引导去设置页。
      apiKey: profile.apiKey || 'unset',
      ...PROVIDER_HTTP,
      ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
      ...(profile.headers ? { defaultHeaders: profile.headers } : {}),
    })
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

    // 这个数是字符估算，不是实测：Anthropic 有 count_tokens，但热路径不调它——
    // 每轮多一次往返，而上下文读数在第一次回报之后就锚在 provider 真值上了。
    yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, this.spec.density) }

    const usage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'estimated',
    }
    let stopReason: ProviderStopReason = 'end_turn'
    // provider 的原话，只进账本不参与判断。空串 = 流断在终态之前。
    let rawStop = ''
    let refusal: { category: string | null; explanation?: string } | undefined

    // 累积工具调用：SDK 把参数按 input_json_delta 分片流下来，要自己拼回 JSON。
    const partial = new Map<number, { id: string; name: string; json: string }>()

    try {
      const stream = this.client.messages.stream(
        body as unknown as Anthropic.MessageStreamParams,
        req.signal ? { signal: req.signal } : {},
      )

      for await (const ev of stream as AsyncIterable<AnthropicStreamEvent>) {
        switch (ev.type) {
          case 'message_start': {
            // Anthropic 的 message_start 是协议级流起点，早于首个内容块。
            yield { type: 'response_started' }
            const u = ev.message?.usage
            if (u) applyUsage(usage, u)
            break
          }
          case 'content_block_start': {
            const block = ev.content_block
            if (block?.type === 'tool_use') {
              // 缺席按空串收：名字为空由 `collectToolCalls` 的 `!slot.name` 那条统一报错，
              // 那是「工具调用没有名字」的唯一判定点，这里不再各判一次。
              partial.set(ev.index, { id: block.id ?? '', name: block.name ?? '', json: '' })
            }
            break
          }
          case 'content_block_delta': {
            const d = ev.delta
            if (d?.type === 'text_delta') {
              // 同 `input_json_delta`：缺席按空串收，直接透传 undefined 会让
              // 字符串 `undefined` 进到正文里。
              yield { type: 'text_delta', delta: d.text ?? '' }
            } else if (d?.type === 'thinking_delta') {
              // display:'omitted'（默认）时这里是空串——思考照样发生、照样计费，
              // 只是不回传内容。不要据此判断「模型没思考」。
              if (d.thinking) yield { type: 'thinking_delta', delta: d.thinking }
            } else if (d?.type === 'input_json_delta') {
              const slot = partial.get(ev.index)
              // **必须兜住缺席**：直接拼接会把字符串 `undefined` 接进 JSON，
              // 随后 `JSON.parse` 抛，整次工具调用的参数就没了。
              if (slot) slot.json += d.partial_json ?? ''
            }
            break
          }
          case 'message_delta': {
            if (ev.usage) applyUsage(usage, ev.usage)
            const raw = ev.delta?.stop_reason
            if (raw) {
              rawStop = String(raw)
              stopReason = normalizeStopReason(raw)
            }
            // stop_details 只在 refusal 时非空，其余 stop_reason 下恒为 null——
            // 必须先看 stop_reason 再读它，反过来会漏判。
            if (raw === 'refusal' && ev.delta?.stop_details) {
              // 键不存在与键为 undefined 在 `exactOptionalPropertyTypes` 下不是一回事，
              // 所以按有没有决定加不加这个键（同 `store` 的 `rowToWorkspace`）。
              refusal = {
                category: ev.delta.stop_details.category ?? null,
                ...(ev.delta.stop_details.explanation === undefined
                  ? {}
                  : { explanation: ev.delta.stop_details.explanation }),
              }
            }
            break
          }
          default:
            break
        }
      }

      const final = await (
        stream as { finalMessage(): Promise<AnthropicFinalMessage> }
      ).finalMessage()
      if (final.usage) applyUsage(usage, final.usage)
      if (final.stop_reason) {
        rawStop = String(final.stop_reason)
        stopReason = normalizeStopReason(final.stop_reason)
      }
      if (final.stop_reason === 'refusal' && final.stop_details) {
        refusal = {
          category: final.stop_details.category ?? null,
          ...(final.stop_details.explanation === undefined
            ? {}
            : { explanation: final.stop_details.explanation }),
        }
      }

      const calls = collectToolCalls(partial, req.model)
      if (calls.length) yield { type: 'tool_calls', calls }
    } catch (err) {
      throw classifyProviderError('anthropic_messages', err)
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason, rawStopReason: rawStop, ...(refusal ? { refusal } : {}) }
  }

  // ───────────────────────── 装配 ─────────────────────────

  private buildBody(req: ChatRequest) {
    const thinking = this.resolveThinking()
    const effort = this.resolveEffort(req)

    return {
      model: req.model,
      max_tokens: this.resolveMaxTokens(req, thinking),
      system: buildSystem(req),
      // 断点的前缀长度从工具 schema + 系统提示词算起——它们排在消息之前。
      messages: buildMessages(
        req.messages,
        this.spec.density,
        this.spec.minCacheablePrefix,
        estimateSchemas(req.tools, this.spec.density) +
          req.system.reduce((n, b) => n + estimateText(b.text, this.spec.density), 0),
      ),
      tools: buildTools(req.tools),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // 注意这里没有 temperature / top_p / top_k：Claude 5 系收到就 400，
      // 而「引导风格」的正确做法是写进 system prompt。
    }
  }

  /**
   * 思考配置。返回 undefined 表示**整个省略 thinking 字段**——这对 Fable 5 系是唯一
   * 合法写法，对 Opus 5 / Sonnet 5 则等价于 adaptive（它们默认就思考）。
   *
   * 只按 `spec.thinking` 分派：调用方不请求思考形态，强度由 `output_config.effort`
   * 走。**不要改成从请求里读形态**——`budget_tokens` 那套老形态在 Opus 5 /
   * Sonnet 5 上一律 400。
   */
  private resolveThinking() {
    // adaptive_only 之外（always_on / budget_tokens / none）一律省略：
    // 恒开的模型收到任何显式配置都 400，老形态本项目不请求。
    if (this.spec.thinking !== 'adaptive_only') return undefined
    return { type: 'adaptive' as const, display: 'summarized' as const }
  }

  /**
   * effort 档位只接受这条模型明确支持的值。越界时省略字段、交给模型默认，
   * 不能为了让请求通过而静默替用户换成另一档。
   */
  private resolveEffort(req: ChatRequest): EffortLevel | undefined {
    if (!this.spec.effortLevels.length) return undefined
    const effort = req.effort
    if (!effort) return undefined
    if (this.spec.effortLevels.includes(effort)) return effort
    return undefined
  }

  /**
   * 输出预算。
   *
   * max_tokens 是**思考 + 正文**的合计上限，不只是正文。Opus 5 / Sonnet 5 省略
   * thinking 也会思考，所以一个照着「不思考」口径调小的 max_tokens 会让回答从
   * 中间断掉，且没有任何报错——只有一个 stop_reason='max_tokens'。这里按
   * thinksByDefault 抬高下限来消灭这类静默截断。
   */
  private resolveMaxTokens(req: ChatRequest, thinking: { type: string } | undefined): number {
    const ceiling = this.spec.maxOutputTokens ?? UNDECLARED_MAX_TOKENS
    let want = outputCap(req.maxOutputTokens, this.spec.maxOutputTokens) ?? ceiling
    const willThink = thinking !== undefined || this.spec.thinksByDefault
    if (willThink) {
      want = Math.max(want, Math.min(MIN_TOKENS_WHEN_THINKING, ceiling))
    }
    return want
  }
}

// ───────────────────────── 形状翻译 ─────────────────────────

function buildSystem(req: ChatRequest) {
  return req.system
    .filter((b) => b.text.trim())
    .map((b) => ({
      type: 'text' as const,
      text: b.text,
      ...(b.cacheBreakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))
}

/**
 * 工具 schema 序列化。
 *
 * **按名字排序**：渲染顺序是 tools → system → messages，工具排在最前面，
 * 所以工具数组的任何顺序抖动都会让整个前缀缓存失效。Set/对象迭代顺序不稳定的
 * 语言里这是最经典的静默失效源。
 *
 * **不要在这里发 `strict`。** 这套协议的 strict 不要求全部属性进 `required`，
 * 本仓的 schema 直接合格，所以「一并开上」看着零成本。实测（2026-08-20，
 * 经中转调 claude-opus-5）收益是零：发与不发各五次采样，参数都正确；
 * 而代价不是零——同一条路上一次回了 schema 里没有的键，另一次对不合格的
 * strict schema 回 HTTP 500 而不是 400。OpenAI 那两条协议发它，因为那里
 * 实测有收益（见 `openai-compat.ts` 的 `strictify`）。
 */
function buildTools(tools: ToolSchema[]) {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
      ...(t.deferLoading ? { defer_loading: true } : {}),
    }))
}

/*
 * ───────────────────────── 这个协议的 wire 形状 ─────────────────────────
 *
 * **只声明本文件真的读或真的写的字段。** 协议本身给的比这多得多，没列进来的就是
 * 本文件不依赖的——所以这几个接口同时也是「换一家中转站时，对端至少要提供什么」的清单。
 *
 * 放在这个文件里而不是抽一个跨协议的 wire 模块：协议这条轴已经有归属
 * （`ProviderKind` 三个值、一个适配器一个协议、模型库每条 spec 带着它），
 * 再起一个登记表就是第二处声明协议轴的地方。谁的协议谁自己描述。
 */

/** usage 的四个数。**各自可能缺席，缺席与 0 不是一回事**（见 `applyUsage`）。 */
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 流事件。写成一个带可选字段的接口而不是判别联合：读的时候本来就是
 * `switch (ev.type)` 之后逐个 `?.` 取，联合类型在这里只会把每个分支都变成一次断言。
 *
 * `index` 按必填给：只有 `content_block_*` 两个分支读它，而那两种事件一定带。
 */
interface AnthropicStreamEvent {
  type: string
  index: number
  message?: { usage?: AnthropicUsage }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
    stop_details?: { category?: string | null; explanation?: string } | null
  }
  usage?: AnthropicUsage
}

/** 收尾时问 SDK 要的那份完整消息。`stop_details` 只在 refusal 下非空。 */
interface AnthropicFinalMessage {
  usage?: AnthropicUsage
  stop_reason?: string | null
  stop_details?: { category?: string | null; explanation?: string } | null
}

/** 内容块。一个块只会长成其中一种，字段因此全是可选的。 */
export interface AnthropicBlock {
  type: string
  text?: string
  /** 装配时可能还没有（`WireMessage.toolCallId` 可缺），JSON 里的 undefined 等同不带这个键。 */
  tool_use_id?: string | undefined
  content?: string | AnthropicBlock[]
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: { type: string; media_type: string; data: string }
  title?: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * 发出去的一条消息。
 *
 * `_toolBatch` 不是协议字段，是「同一轮的多个工具结果要并进同一条 user 消息」时的
 * 自用标记，发出去之前一定删掉——留着会进请求体，破坏缓存前缀。
 */
export interface AnthropicOutMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
  _toolBatch?: boolean
}

/**
 * 消息形状翻译，同时落缓存断点。
 *
 * `minPrefix` 是这条模型能缓存的最短前缀（逐模型不同：512 / 1024 / 2048 / 4096）。
 * 短于它打断点不会报错，**只是不生效**——但仍然会记一次缓存写入，
 * 因此账面上多一笔、实际一点没省。所以在这里判掉，不把无效断点发上线。
 *
 * `prefixTokens` 是消息之前那一段（工具 schema + 系统提示词）的量，
 * 断点的前缀长度要从它算起。
 *
 * 返回值在末尾整体断言成 SDK 类型：形状是按 role 动态分支拼出来的（尤其
 * tool_result 要跨消息合并），逐条满足 SDK 的判别联合会让代码难以读懂。
 * 断言只在这一个出口，形状正确性由下面的分支逻辑保证。
 */
function buildMessages(
  messages: WireMessage[],
  density: TokenDensity,
  minPrefix = 0,
  prefixTokens = 0,
): Anthropic.MessageParam[] {
  const out: AnthropicOutMessage[] = []
  // 断点落在哪几条输出上。工具结果会被合并进同一条 user 消息，
  // 所以输入下标和输出下标不是一一对应的——只能边走边记。
  const marks: number[] = []
  let running = prefixTokens
  for (const m of mergeContextIntoUsers(messages)) {
    running += estimateMessage(m, density)
    if (m.role === 'tool') {
      // Anthropic 的工具结果是 user 轮里的 tool_result block。
      // 同一轮的多个结果必须合并进**一条** user 消息——拆成多条会训练模型
      // 不再并行调用工具。
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : toBlocks(m.content),
      }
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && last._toolBatch) {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block], _toolBatch: true })
      }
      if (m.cacheBreakpoint && running >= minPrefix) marks.push(out.length - 1)
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: AnthropicBlock[] = []
      if (typeof m.content === 'string' && m.content) {
        content.push({ type: 'text', text: m.content })
      }
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })
      }
      out.push({ role: 'assistant', content })
      if (m.cacheBreakpoint && running >= minPrefix) marks.push(out.length - 1)
      continue
    }

    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : toBlocks(m.content),
    })
    if (m.cacheBreakpoint && running >= minPrefix) marks.push(out.length - 1)
  }
  for (const at of marks) {
    const entry = out[at]
    if (!entry) continue
    // `cache_control` 只能挂在内容块上，字符串正文得先摊成块。
    if (typeof entry.content === 'string') {
      entry.content = [{ type: 'text', text: entry.content }]
    }
    const last = entry.content[entry.content.length - 1]
    if (last) last.cache_control = { type: 'ephemeral' as const }
  }
  // 清掉只用于合并的内部标记，避免它进入请求体破坏缓存前缀。
  for (const m of out) delete m._toolBatch
  return out as unknown as Anthropic.MessageParam[]
}

function toBlocks(content: Exclude<WireMessage['content'], string>) {
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: b.mimeType, data: imageData(b.source) },
      }
    }
    throw new Error('Anthropic 适配器不支持视频内容块')
  })
}

// ───────────────────────── 结果归一 ─────────────────────────

function normalizeStopReason(raw: string): ProviderStopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
      return raw
    default:
      return 'end_turn'
  }
}

/**
 * usage 累加。
 *
 * `cachedTokens` 用 null 表示「provider 没回报」，与真实的 0 命中严格区分——
 * 把两者混成 0 会让「缓存从来没生效」这个故障看起来像「缓存生效了但没命中」，
 * 是排查缓存问题时最误导人的一步。
 */
function applyUsage(acc: ProviderUsage, u: AnthropicUsage) {
  if (typeof u.input_tokens === 'number') acc.inputTokens = u.input_tokens
  if (typeof u.output_tokens === 'number') acc.outputTokens = u.output_tokens
  if (typeof u.cache_read_input_tokens === 'number') {
    acc.cachedTokens = u.cache_read_input_tokens
  }
  if (typeof u.cache_creation_input_tokens === 'number') {
    acc.cacheWriteTokens = u.cache_creation_input_tokens
  }
  acc.source = 'provider'
}

function collectToolCalls(
  partial: Map<number, { id: string; name: string; json: string }>,
  model: string,
): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const [, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) throw namelessToolCall('anthropic_messages', model)
    let args: Record<string, unknown> = {}
    let argsError: string | null = null
    if (slot.json.trim()) {
      try {
        args = JSON.parse(slot.json)
      } catch {
        // 参数 JSON 分片没拼完整（流被中断）。标出来交给 loop 记成一次失败的工具调用，
        // 而不是让整轮崩掉、也不是塞个魔法键假装参数还在。
        argsError = slot.json
      }
    }
    calls.push({
      id: slot.id,
      name: slot.name,
      arguments: args,
      ...(argsError === null ? {} : { argumentsError: argsError }),
    })
  }
  return calls
}
