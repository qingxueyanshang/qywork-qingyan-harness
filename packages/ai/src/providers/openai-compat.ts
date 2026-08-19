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
import { classifyProviderError, ProviderError } from '../errors.ts'
import { estimateRequest } from '../tokens.ts'
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

export class OpenAICompatAdapter implements LlmAdapter {
  readonly kind = 'openai_compatible' as const
  /**
   * effort 发不发，**由目录里那条模型的 `effortLevels` 决定**，不是由协议决定。
   *
   * **不要因为「兼容协议下字段名各家不一」就写成 `effort: false`。** 字段名确实
   * 不一，可它是**每个模型自己的属性**，目录里正好有（`thinking` 说用哪套字段、
   * `effortLevels` 说有哪几档）。一律不发的代价是 GPT-5.6 / Gemini / Grok / Kimi /
   * GLM 这些真有思考档位的模型全都调不了，而界面上还画着一个选了没反应的控件。
   *
   * `thinking` 仍然是 false：正文里的思考内容是从流里**读**出来的
   * （`reasoning_content`），我们从不主动声明它。
   *
   * 未收录的模型 `effortLevels` 是 `[]`，一个字节都不会多发——所以自建端点
   * 不会因为这个改动开始收到它不认识的字段。
   */
  get transmits(): { thinking: boolean; effort: boolean } {
    // effort 真正上线的判据是 `buildReasoning`：只有这两种 thinking 会带
    // `reasoning_effort`，其余（含未收录模型的 'none'）一个字节都不发。
    // 恒 true 会让 `qy probe` 的 effort 探针在这些模型上全部假通过。
    const sendsEffort =
      this.spec.thinking === 'deepseek_thinking' || this.spec.thinking === 'reasoning_effort'
    return { thinking: false, effort: sendsEffort }
  }
  readonly spec: ModelSpec
  private readonly client: OpenAI

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    this.client = new OpenAI({
      apiKey: profile.apiKey || 'unset',
      ...PROVIDER_HTTP,
      baseURL: normalizeBaseUrl(profile.baseUrl),
      ...(profile.headers ? { defaultHeaders: profile.headers } : {}),
    })
  }

  async measure(req: ChatRequest): Promise<number> {
    // 兼容端点普遍没有 count_tokens。给字符估算，并在事件里标 exact=false——
    // 面板必须能区分「实测」和「估算」，否则用户会拿估算值去对账单。
    return estimateRequest(req)
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

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
    const partial = new Map<number, { id: string; name: string; json: string }>()

    try {
      // 兼容端点的字段集参差不齐（reasoning_content、prompt_cache_hit_tokens 等
      // 都不在官方类型里），所以请求体和响应都在这个边界上断言，内部按 Record 处理。
      const stream = (await this.client.chat.completions.create(
        { ...body, stream: true, stream_options: { include_usage: true } } as never,
        req.signal ? { signal: req.signal } : {},
      )) as unknown as AsyncIterable<Record<string, any>>

      let chunks = 0
      for await (const chunk of stream) {
        chunks++
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
          }
          // 名字有时分片到达，补齐它；id 同理。
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          const argsDelta: string = tc.function?.arguments ?? ''
          if (argsDelta) slot.json += argsDelta
        }

        if (choice.finish_reason) {
          stopReason = normalizeFinishReason(choice.finish_reason)
        }
      }

      const calls = collectToolCalls(partial)
      if (calls.length) {
        // **`max_tokens` 不能被覆盖掉。** 输出正好在拼工具参数的中途撞上上限时，
        // 这里既有 calls 又有 'length'；无条件改成 tool_use 会把「被截断了」这件事
        // 抹掉，上层于是拿着半截 JSON 解析失败的参数照常执行工具，事后还看不出
        // 发生过截断。截断优先——它决定的是这一轮该不该继续，比「有没有工具调用」更靠前。
        if (stopReason !== 'max_tokens') stopReason = 'tool_use'
        yield { type: 'tool_calls', calls }
      }

      /*
       * **一个 chunk 都没有 = 这不是一次模型答复，必须报错。**
       *
       * 判据放在这里而不是上层：只有这里知道「SSE 流是空的」这个事实。
       * 出了这个函数，`usage` 和 `done` 是无条件 yield 的，上层数事件永远数不出 0。
       *
       * 实测形状：Base URL 少了 `/v1` 时中转站对错误路径回 **200 + 一个 HTML 首页**，
       * 解析器读不出任何 chunk 也不抛错，于是那一轮 0 token、0 步骤、`completed`
       * ——界面上是「消息发出去了，什么也没发生」，账本里也查不到原因。
       * `normalizeBaseUrl` 已经把这个成因消掉了，但别的成因（反代吞流、
       * 网关返回空 200）还在，而**静默是比任何一个具体成因都严重的问题**。
       */
      if (chunks === 0) {
        throw new ProviderError({
          code: 'provider_unavailable',
          message: '响应为 200 但不含任何 SSE 数据',
          retryable: false,
          provider: 'openai_compatible',
          detail: { model: req.model },
        })
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
      ...buildReasoning(this.spec, req.effort),
    }
  }
}

/**
 * 把用户填的 Base URL 归一成带 `/v1` 的 OpenAI 兼容根。
 *
 * **这不是「兼容代码」，是消灭一个静默故障。** 实测形状：用户填
 * `https://中转站/`（少了 `/v1`），SDK 于是请求 `https://中转站/chat/completions`，
 * 而中转站对这种错误路径返回 **200 + 一个 HTML 首页**。SSE 解析器从 HTML 里
 * 解析不出任何事件、也不报错，于是那一轮 0 token、0 步骤、`completed`——
 * 界面上是「消息发出去了，什么也没发生」，账本里也查不到原因。
 *
 * 补 `/v1` 有一个反例：中转站把 API 挂在别的路径下（`/api` 之类）。那种情况下
 * 用户填的就已经是完整根，而完整根**几乎总是以 `/v1` 结尾**（OpenAI 协议本身的
 * 版本段），所以判据取「结尾是不是 `/v1`」而不是「有没有路径」。落到反例上时
 * 失败是响亮的（404 / 401），不是这次这种静默——两种错的代价不对等。
 *
 * 空值走官方根：`openai_responses` 那侧也是同一个常量。
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const url = (raw ?? '').trim().replace(/\/+$/, '')
  if (!url) return 'https://api.openai.com/v1'
  return url.endsWith('/v1') ? url : `${url}/v1`
}

/**
 * 兼容协议下的思考控制字段。
 *
 * **判据是 `spec.thinking`（用哪套字段），不是 `spec.effortLevels`（有哪几档）。**
 *
 * 拿档位表当门禁很自然，但会把 `qy probe` 废掉：探测器的工作正是去试目录里
 * 还没写的档位，用档位表挡住它，它就只能确认已知的东西，永远发现不了新的。
 * 档位是否合法由**发起方**保证——界面只列这个模型声明的档位。
 *
 * 不认识的模型 `thinking` 是 `'none'`，落到最后一行返回 `{}`，
 * 一个字节都不会多发；自建端点和中转站不会因为这个函数收到没见过的键。
 *
 * DeepSeek 那支要**两个字段一起发**：只发 `reasoning_effort` 而不开 `thinking`，
 * 思考根本没打开，档位当然没有效果。
 */
function buildReasoning(spec: ModelSpec, effort: string | undefined) {
  if (!effort) return {}
  /*
   * **不在这个模型档位面里的档，一个字节都不发。**
   *
   * 另两条协议各有各的写法：`openai-responses` 是
   * `effortLevels.includes(req.effort) ? … : undefined`，`anthropic` 会降到最高可用档。
   * 这条别只判「有没有给」就把 `effort` 原样发出去。
   *
   * 档位选定值挂在「接口 × 模型」那一格，同一个模型换条协议档位面就变
   * （DeepSeek 走 chat/completions 是 high/max，走 Responses 一档都没有），
   * Agent Team 的角色还各带各的模型。越界值到这里必须被拦下，
   * 否则就是发给 provider 的一个 400，而错误信息里只有它的原话。
   *
   * 拦下而不是降档：本仓的目录没有「默认档」这个概念，替它挑一档是猜。
   * 不发 = 模型走自己的默认，这与「没选过」是同一个行为，可预期。
   */
  if (!spec.effortLevels.includes(effort as never)) return {}
  if (spec.thinking === 'deepseek_thinking') {
    return { thinking: { type: 'enabled' }, reasoning_effort: effort }
  }
  if (spec.thinking === 'reasoning_effort') return { reasoning_effort: effort }
  return {}
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
    let argsError: string | null = null
    if (slot.json.trim()) {
      try {
        args = JSON.parse(slot.json)
      } catch {
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
