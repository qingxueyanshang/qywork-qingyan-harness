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
 * 1. 采样参数（temperature/top_p/top_k）在 Claude 5 系一律 400 → 根本不提供入口。
 * 2. `budget_tokens` 在 Opus 5 / Sonnet 5 / Fable 5 / Opus 4.7+ 一律 400 → 按 spec.thinking 分派。
 * 3. Fable 5 思考恒开，连 `{type:'disabled'}` 都 400 → 直接省略 thinking 字段。
 * 4. Opus 5 关思考只允许到 effort=high，配 xhigh/max 会 400 → 装配期降档并记录。
 * 5. Opus 5 / Sonnet 5 **省略 thinking 也会思考**，而 max_tokens 同时封顶思考与正文
 *    → 按 thinksByDefault 抬高输出预算下限，否则回答会从中间被截断。
 */

import Anthropic from '@anthropic-ai/sdk'
import { EFFORT_ORDER, type EffortLevel } from '@qywork/core'
import type { ModelSpec } from '../catalog.ts'
import { classifyProviderError } from '../errors.ts'
import { estimateMessage, estimateRequest, estimateSchemas, estimateText } from '../tokens.ts'
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
import { PROVIDER_HTTP } from '../types.ts'

/**
 * 思考开启时给输出留的最小预算。低于这个数，思考稍微长一点正文就没地方写了，
 * 表现为「回答说到一半没了」而不是一个明确的错误——最难排查的那类故障。
 */
const MIN_TOKENS_WHEN_THINKING = 16_000

export class AnthropicAdapter implements LlmAdapter {
  readonly kind = 'anthropic' as const
  get transmits(): { thinking: boolean; effort: boolean } {
    // always_on / none 在 resolveThinking 里返回 undefined = 整个省略 thinking 字段。
    const thinking =
      this.spec.thinking === 'adaptive_only' || this.spec.thinking === 'budget_tokens'
    return { thinking, effort: this.spec.effortLevels.length > 0 }
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

  async measure(req: ChatRequest): Promise<number> {
    const body = this.buildBody(req)
    const res = await this.client.messages.countTokens({
      model: body.model,
      system: body.system,
      messages: body.messages,
      ...(body.tools.length ? { tools: body.tools } : {}),
    })
    return res.input_tokens
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

    // 逐字节稳定的前缀是缓存命中的前提，所以测量用的是**即将发送的同一个 body**，
    // 不是重新拼一遍的近似物。
    yield {
      type: 'request_prepared',
      measuredInputTokens: estimateRequest(req),
      exact: false,
    }

    const usage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'estimated',
    }
    let stopReason: ProviderStopReason = 'end_turn'
    let refusal: { category: string | null; explanation?: string } | undefined

    // 累积工具调用：SDK 把参数按 input_json_delta 分片流下来，要自己拼回 JSON。
    const partial = new Map<number, { id: string; name: string; json: string }>()

    try {
      const stream = this.client.messages.stream(
        body as unknown as Anthropic.MessageStreamParams,
        req.signal ? { signal: req.signal } : {},
      )

      for await (const ev of stream as AsyncIterable<Record<string, any>>) {
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message?.usage
            if (u) applyUsage(usage, u)
            break
          }
          case 'content_block_start': {
            const block = ev.content_block
            if (block?.type === 'tool_use') {
              partial.set(ev.index, { id: block.id, name: block.name, json: '' })
            }
            break
          }
          case 'content_block_delta': {
            const d = ev.delta
            if (d?.type === 'text_delta') {
              yield { type: 'text_delta', delta: d.text }
            } else if (d?.type === 'thinking_delta') {
              // display:'omitted'（默认）时这里是空串——思考照样发生、照样计费，
              // 只是不回传内容。不要据此判断「模型没思考」。
              if (d.thinking) yield { type: 'thinking_delta', delta: d.thinking }
            } else if (d?.type === 'input_json_delta') {
              const slot = partial.get(ev.index)
              if (slot) slot.json += d.partial_json
            }
            break
          }
          case 'message_delta': {
            if (ev.usage) applyUsage(usage, ev.usage)
            const raw = ev.delta?.stop_reason
            if (raw) stopReason = normalizeStopReason(raw)
            // stop_details 只在 refusal 时非空，其余 stop_reason 下恒为 null——
            // 必须先看 stop_reason 再读它，反过来会漏判。
            if (raw === 'refusal' && ev.delta?.stop_details) {
              refusal = {
                category: ev.delta.stop_details.category ?? null,
                explanation: ev.delta.stop_details.explanation,
              }
            }
            break
          }
          default:
            break
        }
      }

      const final = await (
        stream as { finalMessage(): Promise<Record<string, any>> }
      ).finalMessage()
      if (final.usage) applyUsage(usage, final.usage)
      if (final.stop_reason) stopReason = normalizeStopReason(final.stop_reason)
      if (final.stop_reason === 'refusal' && final.stop_details) {
        refusal = {
          category: final.stop_details.category ?? null,
          explanation: final.stop_details.explanation,
        }
      }

      const calls = collectToolCalls(partial)
      if (calls.length) yield { type: 'tool_calls', calls }
    } catch (err) {
      throw classifyProviderError('anthropic', err)
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason, ...(refusal ? { refusal } : {}) }
  }

  // ───────────────────────── 装配 ─────────────────────────

  private buildBody(req: ChatRequest) {
    const thinking = this.resolveThinking(req)
    const effort = this.resolveEffort(req, thinking)

    return {
      model: req.model,
      max_tokens: this.resolveMaxTokens(req, thinking),
      system: buildSystem(req),
      // 断点的前缀长度从工具 schema + 系统提示词算起——它们排在消息之前。
      messages: buildMessages(
        req.messages,
        this.spec.minCacheablePrefix,
        estimateSchemas(req.tools) + req.system.reduce((n, b) => n + estimateText(b.text), 0),
        this.spec.midConversationSystem,
      ),
      tools: buildTools(req.tools),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // 注意这里没有 temperature / top_p / top_k：Claude 5 系收到就 400，
      // 而「引导风格」的正确做法是写进 system prompt。
    }
  }

  /**
   * 思考配置。返回 undefined 表示**整个省略 thinking 字段**——这对 Fable 5 是唯一
   * 合法写法，对 Opus 5 / Sonnet 5 则等价于 adaptive（它们默认就思考）。
   */
  private resolveThinking(req: ChatRequest) {
    const want = req.thinking
    switch (this.spec.thinking) {
      case 'always_on':
        // 恒开：任何显式配置都 400，省略即可。
        return undefined
      case 'adaptive_only': {
        if (want?.mode === 'disabled') {
          // 允不允许关、关到哪一档，由 spec 说了算。
          if (this.spec.disableThinkingMaxEffort === null) return undefined
          return { type: 'disabled' as const }
        }
        return {
          type: 'adaptive' as const,
          display: want?.mode === 'adaptive' ? (want.display ?? 'summarized') : 'summarized',
        }
      }
      case 'budget_tokens': {
        if (!want || want.mode === 'disabled') return undefined
        if (want.mode === 'budget') {
          return { type: 'enabled' as const, budget_tokens: want.budgetTokens }
        }
        // 老模型收不到 adaptive，退回一个合理预算（必须小于 max_tokens）。
        return { type: 'enabled' as const, budget_tokens: 8_192 }
      }
      default:
        return undefined
    }
  }

  /**
   * effort 档位。关键约束：思考被显式关闭时，effort 不能超过 spec 允许的上限
   * （Opus 5 是 high），否则 400。这里静默降档而不是报错——用户的意图是
   * 「快一点」，为此拒绝整个请求没有意义。
   */
  private resolveEffort(
    req: ChatRequest,
    thinking: { type: string } | undefined,
  ): EffortLevel | undefined {
    if (!this.spec.effortLevels.length) return undefined
    let effort = req.effort
    if (!effort) return undefined
    if (!this.spec.effortLevels.includes(effort)) {
      effort = this.spec.effortLevels[this.spec.effortLevels.length - 1]!
    }
    if (thinking?.type === 'disabled' && this.spec.disableThinkingMaxEffort) {
      const cap = this.spec.disableThinkingMaxEffort
      if (EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(cap)) {
        effort = cap
      }
    }
    return effort
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
    const ceiling = this.spec.maxOutputTokens
    let want = Math.min(req.maxOutputTokens, ceiling)
    const willThink =
      thinking?.type !== 'disabled' && (thinking !== undefined || this.spec.thinksByDefault)
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

/**
 * 消息形状翻译，顺带落缓存断点。
 *
 * `minPrefix` 是这条模型能缓存的最短前缀（逐模型不同：512 / 1024 / 2048 / 4096）。
 * 短于它打断点不会报错，**只是不生效**——但仍然会记一次缓存写入，
 * 于是账面上多一笔、实际一点没省。所以在这里判掉，不把无效断点发上线。
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
  minPrefix = 0,
  prefixTokens = 0,
  /** 这条模型收不收会话中间的 `role:'system'`。见 `ModelSpec.midConversationSystem`。 */
  midSystem = false,
): Anthropic.MessageParam[] {
  const out: Record<string, any>[] = []
  // 断点落在哪几条输出上。工具结果会被合并进同一条 user 消息，
  // 所以输入下标和输出下标不是一一对应的——只能边走边记。
  const marks: number[] = []
  let running = prefixTokens
  for (const m of messages) {
    running += estimateMessage(m)
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
      const content: Record<string, any>[] = []
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

    /*
     * **会话中间的 `role:'system'` 是分模型的能力，不是通用角色。**
     *
     * loop 的尾区注记（日期、工作区、技能与记忆索引、待加载的外部工具）是故意压在
     * 历史之后的 system 消息——挪进顶层 `system` 就等于挪进冻结前缀，装一个插件、
     * 改一条记忆就把整段缓存打掉，而那正是按需加载要治的病。所以这个位置是对的。
     *
     * 但**只有一部分模型收它**（Opus 4.8/5 这一档，无需 beta 头）。其余的一律回
     * 400 `role 'system' is not supported on this model`——不是「格式错了」，
     * 是这条会话在那个模型上整个发不出去。所以不支持的落地成 user 轮里的
     * `<system-reminder>`：位置不变、缓存前缀不变，只是换了个承载角色。
     *
     * **两条路都自成一条消息，绝不并进前一条。** 前一条通常就是历史的末尾，
     * 而缓存断点之二正落在那儿——并进去的话 `cache_control` 会挂到追加的注记上，
     * 而注记跨轮必变，于是那个断点每轮失配，等于没打。
     */
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : ''
      if (!text.trim()) continue
      out.push(
        midSystem
          ? { role: 'system', content: text }
          : {
              role: 'user',
              content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
            },
      )
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
        source: { type: 'base64', media_type: b.mimeType, data: b.data },
      }
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: b.mimeType, data: b.data },
      ...(b.title ? { title: b.title } : {}),
    }
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
function applyUsage(acc: ProviderUsage, u: Record<string, any>) {
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
): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const [, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
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
