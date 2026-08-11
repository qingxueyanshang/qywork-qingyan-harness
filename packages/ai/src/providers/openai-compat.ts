/**
 * OpenAI 兼容协议适配器（/v1/chat/completions）。
 *
 * 覆盖 DeepSeek、Grok(xAI)、Kimi、通义、各类中转站、以及 ollama / vLLM 等本地推理服务。
 * 需求 11 要求「自定义绑定 AI 接口」，这条路径是主力——大部分第三方端点都只实现这个协议。
 *
 * 两个必须照顾的兼容点，都是实测踩出来的，不是防御性猜测：
 *
 * 1. **reasoning_content 必须原样回传**。DeepSeek 思考模式下，带 tool_calls 的 assistant
 *    消息如果不把 reasoning_content 一起送回去，下一轮直接 400。这不是可选优化。
 * 2. **缓存靠前缀自动命中，没有显式断点**。这些端点普遍没有 cache_control，命中完全
 *    依赖前缀逐字节稳定，所以工具排序和消息装配的确定性在这里比在 Anthropic 更要命。
 */

import OpenAI from 'openai'
import type { ModelSpec } from '../catalog.ts'
import { classifyProviderError } from '../errors.ts'
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

export class OpenAICompatAdapter implements LlmAdapter {
  readonly kind = 'openai_compatible' as const
  // OpenAI 兼容协议下 thinking / effort 的字段名各家不一（有的叫 reasoning_effort，
  // 有的用模型名区分，有的干脆没有），本适配器**不发**这两个字段。
  // 如实声明，探测器才不会把「没发」当成「被接受」。
  readonly transmits = { thinking: false, effort: false }
  readonly spec: ModelSpec
  private readonly client: OpenAI

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    this.client = new OpenAI({
      apiKey: profile.apiKey || 'unset',
      ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
      ...(profile.headers ? { defaultHeaders: profile.headers } : {}),
    })
  }

  async measure(req: ChatRequest): Promise<number> {
    // 兼容端点普遍没有 count_tokens。给字符估算，并在事件里标 exact=false——
    // 面板必须能区分「实测」和「估算」，否则用户会拿估算值去对账单。
    return estimateTokens(this.buildBody(req))
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

    yield {
      type: 'request_prepared',
      measuredInputTokens: estimateTokens(body),
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
    const partial = new Map<number, { id: string; name: string; json: string }>()

    try {
      // 兼容端点的字段集参差不齐（reasoning_content、prompt_cache_hit_tokens 等
      // 都不在官方类型里），所以请求体和响应都在这个边界上断言，内部按 Record 处理。
      const stream = (await this.client.chat.completions.create(
        { ...body, stream: true, stream_options: { include_usage: true } } as never,
        req.signal ? { signal: req.signal } : {},
      )) as unknown as AsyncIterable<Record<string, any>>

      for await (const chunk of stream) {
        if (chunk.usage) applyUsage(usage, chunk.usage)

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta ?? {}

        // DeepSeek / Kimi 用 reasoning_content，部分中转站用 reasoning。都收。
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'thinking_delta', delta: reasoning }
        }

        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', delta: delta.content }
        }

        for (const tc of delta.tool_calls ?? []) {
          const idx: number = tc.index ?? 0
          let slot = partial.get(idx)
          if (!slot) {
            slot = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', json: '' }
            partial.set(idx, slot)
            if (slot.name) {
              yield { type: 'tool_call_start', index: idx, id: slot.id, name: slot.name }
            }
          }
          // 名字有时分片到达，补齐它；id 同理。
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          const argsDelta: string = tc.function?.arguments ?? ''
          if (argsDelta) {
            slot.json += argsDelta
            yield { type: 'tool_call_delta', index: idx, argsDelta }
          }
        }

        if (choice.finish_reason) {
          stopReason = normalizeFinishReason(choice.finish_reason)
        }
      }

      const calls = collectToolCalls(partial)
      if (calls.length) {
        stopReason = 'tool_use'
        yield { type: 'tool_calls', calls }
      }
    } catch (err) {
      throw classifyProviderError('openai_compatible', err)
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason }
  }

  private buildBody(req: ChatRequest) {
    const systemText = req.system
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n')

    const messages: Record<string, any>[] = []
    if (systemText) messages.push({ role: 'system', content: systemText })
    messages.push(...buildMessages(req.messages))

    return {
      model: req.model,
      messages,
      max_tokens: Math.min(req.maxOutputTokens, this.spec.maxOutputTokens),
      ...(req.tools.length ? { tools: buildTools(req.tools) } : {}),
    }
  }
}

function buildTools(tools: ToolSchema[]) {
  // 与 Anthropic 路径同样按名排序：兼容端点的隐式前缀缓存同样怕顺序抖动。
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
}

function buildMessages(messages: WireMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : flatten(m.content),
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content || null : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
        // 见文件头注释第 1 条：不回传这个字段，DeepSeek 思考模式下一轮直接 400。
        ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
      }
    }
    if (typeof m.content !== 'string') {
      return { role: m.role, content: toMultimodal(m.content) }
    }
    return { role: m.role, content: m.content }
  })
}

function toMultimodal(content: Exclude<WireMessage['content'], string>) {
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } }
    }
    // 兼容协议没有 document block，降级成文本说明而不是静默丢弃。
    return { type: 'text', text: `[附件 ${b.title ?? b.mimeType}]` }
  })
}

function flatten(content: Exclude<WireMessage['content'], string>): string {
  return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

function normalizeFinishReason(raw: string): ProviderStopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

/**
 * usage 归一。
 *
 * **口径陷阱**：OpenAI 兼容协议的 `prompt_tokens` 是**含**缓存命中的总量
 * （DeepSeek 实测 `prompt_tokens = cache_hit + cache_miss`），而 Anthropic 的
 * `input_tokens` 是**不含**缓存的余量。两边都直接累加的话，兼容侧会把命中的
 * token 按全价再算一遍——缓存命中率越高，账单错得越离谱。
 *
 * 这里统一收敛到 Anthropic 的「排他」口径：inputTokens 只装未命中部分。
 */
function applyUsage(acc: ProviderUsage, u: Record<string, any>) {
  if (typeof u.completion_tokens === 'number') acc.outputTokens = u.completion_tokens

  // 各家字段名不统一：DeepSeek 是 prompt_cache_hit_tokens，OpenAI 是
  // prompt_tokens_details.cached_tokens。都认，认不出就保持 null（未回报）。
  const details = u.prompt_tokens_details as Record<string, any> | undefined
  let cached: number | null = null
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    cached = u.prompt_cache_hit_tokens
  } else if (details && typeof details.cached_tokens === 'number') {
    cached = details.cached_tokens
  }
  if (cached !== null) acc.cachedTokens = cached

  if (typeof u.prompt_cache_miss_tokens === 'number') {
    // 供应商直接给了未命中量，最可靠。
    acc.inputTokens = u.prompt_cache_miss_tokens
  } else if (typeof u.prompt_tokens === 'number') {
    // 只有总量时自己减。没回报缓存量就按全部未命中处理。
    acc.inputTokens = Math.max(0, u.prompt_tokens - (cached ?? 0))
  }
  const outDetails = u.completion_tokens_details as Record<string, any> | undefined
  if (outDetails && typeof outDetails.reasoning_tokens === 'number') {
    acc.reasoningTokens = outDetails.reasoning_tokens
  }
  acc.source = 'provider'
}

function collectToolCalls(
  partial: Map<number, { id: string; name: string; json: string }>,
): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const [, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) continue
    let args: Record<string, unknown> = {}
    if (slot.json.trim()) {
      try {
        args = JSON.parse(slot.json)
      } catch {
        args = { __malformed_arguments: slot.json }
      }
    }
    calls.push({ id: slot.id, name: slot.name, arguments: args })
  }
  return calls
}

function estimateTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body).length / 3.5)
}
