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
 *    依赖前缀逐字节稳定，所以工具排序和消息装配的确定性在这里比在 Anthropic 更关键。
 */

import OpenAI from 'openai'
import { effortIsTransmittable, type ModelSpec } from '../catalog.ts'
import { classifyProviderError, namelessToolCall, ProviderError } from '../errors.ts'
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
import { imageData, outputCap, PROVIDER_HTTP } from '../types.ts'
import { mergeContextIntoUsers } from './context.ts'

export class OpenAICompatAdapter implements LlmAdapter {
  readonly kind = 'openai_chat_completions' as const
  /**
   * effort 发不发，**由目录里那条模型的 `effortLevels` 决定**，不是由协议决定。
   *
   * **不要因为「兼容协议下字段名各家不一」就写成 `effort: false`。** 字段名确实
   * 不一，可它是**每个模型自己的属性**，目录里正好有（`thinking` 说用哪套字段、
   * `effortLevels` 说有哪几档）。一律不发的代价是 GPT-5.6 / Gemini / Grok / Kimi /
   * GLM 这些真有思考档位的模型全都调不了，而界面上还画着一个选了没反应的控件。
   *
   * `thinking` 仍然是 false：正文里的思考内容是从流里**读**出来的
   * （`reasoning_content`），客户端从不主动声明它。
   *
   * 未收录的模型 `effortLevels` 是 `[]`，一个字节都不会多发——所以自建端点
   * 不会因为这个改动开始收到它不认识的字段。
   */
  get transmits(): { effort: boolean } {
    // 判据只有 `effortIsTransmittable` 一份，与 `buildReasoning` 实际发的字段同源。
    // 恒 true 会让 `qy probe` 的 effort 探针在发不出该字段的模型上全部假通过。
    return { effort: effortIsTransmittable(this.spec) }
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

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

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
    // provider 的原话，只进账本不参与判断。收尾时还是空串 = 流被截断，见下面那条守卫。
    let rawFinish = ''
    const partial = new Map<number, { id: string; name: string; json: string }>()
    const splitter = createThinkingSplitter()

    try {
      // 兼容端点的字段集参差不齐（reasoning_content、prompt_cache_hit_tokens 等
      // 都不在官方类型里），所以请求体和响应都在这个边界上断言，内部按 Record 处理。
      const stream = (await this.client.chat.completions.create(
        { ...body, stream: true, stream_options: { include_usage: true } } as never,
        {
          ...(req.signal ? { signal: req.signal } : {}),
          ...(req.cacheKey && this.spec.cacheRouting === 'x_grok_conv_id'
            ? { headers: { 'x-grok-conv-id': req.cacheKey } }
            : {}),
        },
      )) as unknown as AsyncIterable<CompatChunk>

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
          const split = splitter.push(delta.content)
          if (split.thinking) yield { type: 'thinking_delta', delta: split.thinking }
          if (split.text) yield { type: 'text_delta', delta: split.text }
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
          rawFinish = String(choice.finish_reason)
          stopReason = normalizeFinishReason(choice.finish_reason)
        }
      }

      // 攒着没等到闭合标签的，原样当正文输出。放在工具调用之前：
      // 它是正文的一部分，顺序不能倒。
      const tail = splitter.flush()
      if (tail) yield { type: 'text_delta', delta: tail }

      const calls = collectToolCalls(partial, req.model)
      if (calls.length) {
        // **`max_tokens` 不能被覆盖掉。** 输出正好在拼工具参数的中途撞上上限时，
        // 这里既有 calls 又有 'length'；无条件改成 tool_use 会把「被截断了」这件事
        // 抹掉，上层因此拿着半截 JSON 解析失败的参数照常执行工具，事后还看不出
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
       * 解析器读不出任何 chunk 也不抛错，因此那一轮 0 token、0 步骤、`completed`
       * ——界面上是「消息发出去了，什么也没发生」，账本里也查不到原因。
       * `normalizeBaseUrl` 已经把这个成因消掉了，但别的成因（反代吞流、
       * 网关返回空 200）还在，而**静默是比任何一个具体成因都严重的问题**。
       */
      if (chunks === 0) {
        throw new ProviderError({
          code: 'provider_unavailable',
          message: '响应为 200 但不含任何 SSE 数据',
          provider: 'openai_chat_completions',
          detail: { model: req.model },
        })
      }

      /*
       * **流结束了却一次都没给过 `finish_reason` = 传输被截断，不是「说完了」。**
       *
       * 协议要求最后一个 chunk 带 `finish_reason`，用量也在同一个 chunk 里。
       * 两者一起缺席只有一个成因：连接在模型说完之前断了。默认值 `end_turn`
       * 会把它记成正常完成——界面上是「思考写到一半就停、run 显示成功」，
       * 账本上那一轮是 0 token、无从对账，与 `chunks === 0` 是同一类静默。
       *
       * 实测形状（2026-08-21，某中转端点）：带 tools 的长思考请求
       * 约一半的次数在 reasoning 中途直接结束响应体，既没有 `finish_reason`
       * 也没有 `[DONE]`；同样的请求另一半次数能正常收尾。
       *
       * 记成传输失败而不是 provider 拒绝：没有 HTTP 状态码，是否计费无从判断——
       * 所以已经攒到的 usage 随错误一起带上去（见 `usage` 字段），账本行落 `uncertain`
       * 但数是实的。断在思考里的那一轮由 `loop.ts` 自动重发一次（判据是模型可见输出
       * 为零）；正文已经输出的不重发，用户拿到的是一条说得出「收了多少、断在哪」
       * 的错误，而不是一次假的成功。
       */
      if (!rawFinish) {
        throw new ProviderError({
          code: 'network_error',
          message: '流在 finish_reason 之前结束',
          provider: 'openai_chat_completions',
          detail: { model: req.model },
          // 用量那一格先到、收尾没到时把实数带上去。`source` 仍是 `estimated` 说明
          // 它一个字节都没回报过，那种时候不带——带了就是把零当成真值记进账本。
          ...(usage.source === 'provider' ? { usage } : {}),
        })
      }
    } catch (err) {
      throw classifyProviderError('openai_chat_completions', err)
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason, rawStopReason: rawFinish }
  }

  private buildBody(req: ChatRequest) {
    const systemText = req.system
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n')

    const messages: CompatOutMessage[] = []
    if (systemText) messages.push({ role: 'system', content: systemText })
    messages.push(...buildMessages(req.messages, this.spec))

    const cap = outputCap(req.maxOutputTokens, this.spec.maxOutputTokens)
    return {
      model: req.model,
      messages,
      // 未收录的模型不申报上限，让端点用自己的默认——编一个数出去的代价是静默截断。
      ...(cap === null ? {} : { max_tokens: cap }),
      ...(req.tools.length ? { tools: buildTools(req.tools, this.spec) } : {}),
      ...buildReasoning(this.spec, req.effort),
      /*
       * 缓存路由亲和键：这一格只负责请求体 `prompt_cache_key`。
       *
       * 这个字段本仓早就有（`ChatRequest.cacheKey`，会话 id），`openai-responses`
       * 一直在发——只有这条路径漏了，而 deepseek / 各家中转全走这条。
       *
       * **不要把它当成缓存不命中的解药。** 2026-08-19 在某中转端点上做过配对交替
       * 实测（同一时间窗里逐轮交替发有键/无键，
       * 各 12 轮）：无键 5/12 真命中，有键 0/12；换个时间窗再测又反过来。
       * 同一个请求形状在相邻两分钟里能给出 3008 / 192 / 字段缺失三种结果——
       * **那条路线的缓存本身不确定**，发不发这个键都盖不住。
       * 发它的理由只是「这是协议规定的做法，且在行为正常的端点上有意义」，
       * 不是「发了就命中」。
       *
       * **发不发由目录里那条模型说了算**（`spec.cacheRouting`），不是协议说了算，
       * 也不是这里写死。xAI 的 Chat Completions 明确使用 `x-grok-conv-id` 请求头，
       * 已在上面的请求选项分支发送；不能同时再塞一份 Responses 才用的 body 字段。
       *
       * **`qy probe` 不探这一项，这是有意的。** 探针只能发几次请求看命中——
       * 而上面那段实测正说明：不确定的路线上，几次请求给出的是随机结果。
       * 探出「可用」再写回目录，等于把一次偶然结果固化成结论：两次相同的小请求
       * 判出 rolling，真实会话仍然不命中。
       *
       * 未收录的模型是 `'none'`，一个字节都不多发：自建端点（ollama / vLLM）
       * 对未知字段的容忍度没验过，而它们全都落在未收录那一档。
       */
      ...(req.cacheKey && this.spec.cacheRouting === 'prompt_cache_key'
        ? { prompt_cache_key: req.cacheKey }
        : {}),
    }
  }
}

/**
 * 把用户填的 Base URL 归一成带版本段的 OpenAI 兼容根。
 *
 * **这不是「兼容代码」，是消灭一个静默故障。** 实测形状：用户填
 * `https://中转站/`（少了 `/v1`），SDK 因此请求 `https://中转站/chat/completions`，
 * 而中转站对这种错误路径返回 **200 + 一个 HTML 首页**。SSE 解析器从 HTML 里
 * 解析不出任何事件、也不报错，因此那一轮 0 token、0 步骤、`completed`——
 * 界面上是「消息发出去了，什么也没发生」，账本里也查不到原因。
 *
 * 补 `/v1` 有一个反例：有些兼容端点用的是 `/v4` 等别的版本。版本段是用户明确
 * 提供的路由信息，不能覆盖，也不能再拼成 `/v4/v1`；只有路径末尾没有 `/v数字`
 * 时才补默认 `/v1`。中转站把 API 挂在无版本路径（`/api` 之类）时仍会补默认版本，
 * 失败是响亮的（404 / 401），不是这次这种静默——两种错的代价不对等。
 *
 * 空值走官方根：`openai_responses` 那侧也是同一个常量。
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const url = (raw ?? '').trim().replace(/\/+$/, '')
  if (!url) return 'https://api.openai.com/v1'
  return /\/v\d+$/i.test(url) ? url : `${url}/v1`
}

/**
 * 兼容协议下的思考控制字段。
 *
 * **「发不发」由 `effortIsTransmittable` 一处裁决**，这里只决定「用哪套字段」。
 * 两件事各判一遍的实测后果：`transmits` 说发得出去而这里按参数格式省掉，
 * 因此探针恒通过，把一个凭空的结论写回目录。
 *
 * 不认识的模型 `thinking` 是 `'none'`，被门禁挡在外面，一个字节都不会多发；
 * 自建端点和中转站不会因为这个函数收到没见过的键。
 *
 * DeepSeek 那支要**两个字段一起发**：只发 `reasoning_effort` 而不开 `thinking`，
 * 思考没打开，档位当然没有效果。
 */
function buildReasoning(spec: ModelSpec, effort: string | undefined) {
  const protocol =
    spec.chatReasoningProtocol === 'qwen_preserved'
      ? { preserve_thinking: true }
      : spec.chatReasoningProtocol === 'glm_preserved'
        ? { thinking: { type: 'enabled', clear_thinking: false } }
        : {}
  if (!effort || !effortIsTransmittable(spec)) return protocol
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
  if (!spec.effortLevels.includes(effort as never)) return protocol
  return spec.thinking === 'deepseek_thinking'
    ? { thinking: { type: 'enabled' }, reasoning_effort: effort }
    : { ...protocol, reasoning_effort: effort }
}

function buildTools(tools: ToolSchema[], spec: ModelSpec) {
  // 与 Anthropic 路径同样按名排序：兼容端点的隐式前缀缓存同样怕顺序抖动。
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => {
      const strict = t.strict && spec.chatToolSchema === 'openai_strict'
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: strict ? strictify(t.parameters) : t.parameters,
          ...(strict ? { strict: true } : {}),
        },
      }
    })
}

/**
 * 把本仓写的工具 schema 重排成 strict 形状。
 *
 * strict 让端点按 schema 约束采样，模型**生成不出**不合形状的参数。OpenAI 协议对它
 * 有两条硬要求：每个 object 都要 `additionalProperties: false`，且 `properties` 里
 * 每个键都要进 `required`；可选参数靠 `type` 里加 `null` 表达。
 *
 * **两条要少一条就等于没开。** 实测（2026-08-20，grok-4.6）：只加 `strict: true`
 * 而留着可选属性，端点不报错、静默降级成尽力而为，`offset` 照样回字符串 `"1.0"`；
 * 两条都做之后三次采样全是整数。所以这里不能只发标志位。
 *
 * 只对 `ToolSchema.strict` 为真的（本仓自己写的）用。第三方 schema 不转，理由在那个字段上。
 */
export function strictify(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema }
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (props) {
    const required = new Set((schema.required as string[] | undefined) ?? [])
    const next: Record<string, Record<string, unknown>> = {}
    for (const [key, value] of Object.entries(props)) {
      const child = strictify(value)
      next[key] = required.has(key) ? child : nullable(child)
    }
    out.properties = next
    out.required = Object.keys(props)
    out.additionalProperties = false
  }
  const items = schema.items as Record<string, unknown> | undefined
  if (items) out.items = strictify(items)
  return out
}

/** 可选参数在 strict 下的表达方式：类型里加一个 `null`，不是从 `required` 里拿掉。 */
function nullable(node: Record<string, unknown>): Record<string, unknown> {
  const type = node.type
  if (typeof type !== 'string' || type === 'null') return node
  return { ...node, type: [type, 'null'] }
}

/*
 * ───────────────────────── 这个协议的 wire 形状 ─────────────────────────
 *
 * **只声明本文件真的读或真的写的字段。** 兼容端点的字段集参差不齐
 * （`reasoning_content`、`prompt_cache_hit_tokens` 等都不在官方类型里），
 * 所以这几个接口就是「本文件认得哪些字段名」的清单——接一家新中转站时改这里。
 *
 * 放在这个文件里而不是抽一个跨协议的 wire 模块：协议这条轴已经有归属
 * （`ProviderKind` 三个值、一个适配器一个协议、模型库每条 spec 带着它）。
 */

/**
 * usage。**各家字段名不统一，能给的都收**，收不到就保持未回报（见 `applyUsage`）。
 */
interface CompatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** DeepSeek 的写法。 */
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  /** OpenAI 的写法。 */
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** 流里的一个 chunk。字段全可选：一个 chunk 只会带其中一部分。 */
interface CompatChunk {
  usage?: CompatUsage
  choices?: {
    delta?: {
      content?: string
      /** DeepSeek / Kimi 用 `reasoning_content`，部分中转站用 `reasoning`。 */
      reasoning_content?: string
      reasoning?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
}

/** 发出去的一条消息。四个分支各带一部分字段，所以除 `role` 外全可选。 */
interface CompatOutMessage {
  role: string
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null
  tool_call_id?: string | undefined
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  reasoning_content?: string
}

function buildMessages(messages: WireMessage[], spec: ModelSpec): CompatOutMessage[] {
  return mergeContextIntoUsers(messages).map((m) => {
    if (m.role === 'tool') {
      /*
       * **工具结果里能放图。** 官方文档把 tool 消息的 content 写成
       * `Text content (string)`，而 2026-08 对 `deepseek-v4-flash-vision-exp`
       * 实测：发 `[{type:'text'},{type:'image_url'}]` 它答得出图里的数字与颜色，
       * 不带图的对照组答不出来。**这一格照实测填，不照文档填。**
       *
       * 不认得多模态的端点会自己拒，那是一条带原文的 400；而压成 `[image]`
       * 是静默丢弃——模型会把这次读图当成已完成，那比报错坏得多。
       */
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : toMultimodal(m.content),
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
        /*
         * 见文件头注释第 1 条：不回传这个字段，DeepSeek 思考模式下一轮直接 400。
         *
         * **这里无条件发，不查目录的 `reasoningEcho`——那一格只管 Responses 那条协议。**
         * 两侧的不对称有依据：那边多发的是一个**条目**，端点按 schema 直接拒
         * （`array too long. Expected an array with maximum length 0`）；这边多发的是
         * 一个**字段**，实测被忽略。改成查目录反而会制造回归：中转站把 DeepSeek 挂在
         * 自定义模型名下时目录认不出它，因此从「零配置能用」变成确定性 400。
         *
         * 边界：`reasoningContent` 是**会话历史**的属性，不是端点的。中途换过接口的话，
         * 这里发出去的可能是另一个端点录下的思考内容。
         */
        ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
      }
    }
    if (typeof m.content !== 'string') {
      return {
        role: m.role,
        content: toMultimodal(m.content),
        ...(m.role === 'assistant' &&
        m.reasoningContent &&
        spec.chatReasoningProtocol !== 'standard'
          ? { reasoning_content: m.reasoningContent }
          : {}),
      }
    }
    return {
      role: m.role,
      content: m.content,
      ...(m.role === 'assistant' && m.reasoningContent && spec.chatReasoningProtocol !== 'standard'
        ? { reasoning_content: m.reasoningContent }
        : {}),
    }
  })
}

function toMultimodal(content: Exclude<WireMessage['content'], string>) {
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    return {
      type: 'image_url',
      image_url: { url: `data:${b.mimeType};base64,${imageData(b.source)}` },
    }
  })
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

// ───────────────────────── 正文里的思考标签 ─────────────────────────

const THINKING_OPEN = '<thinking>'
const THINKING_CLOSE = '</thinking>'

/**
 * 正文通道开头那个 `<thinking>…</thinking>` 块改判给思考通道。
 *
 * 这是中转站发推理内容的第三种形式。前两种是字段名（`reasoning_content` / `reasoning`），
 * 这一种把推理摘要塞进 `content` 再自己加上标签——实测 gpt-5.6-terra 经 OpenAI
 * 协议中转，一个 run 的 12 次调用里 3 次这样发，其余走 `reasoning_content`。
 * 通道归属的权威是适配器，所以在这里认；让它混进回答再由下游擦，擦的是症状。
 *
 * **只认这一种形状：本次调用正文的第 0 个字符起、成对闭合、只认一次。**
 * 不要放宽。放宽就会吞掉模型正当输出的这个字面量（例如它在讨论这段代码），
 * 而那是静默的内容丢失。
 *
 * **一个字节都不删也不丢。** 认出来的整块送思考通道；形状对不上的原样送正文；
 * 流在闭合之前就结束，攒着的连同开标签一起原样当正文输出。
 * 所以判错的最坏结果是显示在错的区，不会是内容消失。
 *
 * 代价：块内内容攒到闭合标签才输出，那一段不是逐字出现的。这种块实测是一行摘要，
 * 而流空闲看门狗的下限是 180 秒（`agent/loop.ts` 的 `STREAM_IDLE_TIMEOUT_MS`），够不着。
 */
export function createThinkingSplitter(): {
  push(delta: string): { thinking: string; text: string }
  flush(): string
} {
  let phase: 'head' | 'inside' | 'body' = 'head'
  let held = ''
  return {
    push(delta) {
      if (phase === 'body') return { thinking: '', text: delta }
      held += delta
      if (phase === 'head') {
        // 还看不出来是不是这个开头，继续攒。攒的上界是开标签本身的长度。
        if (THINKING_OPEN.startsWith(held)) return { thinking: '', text: '' }
        if (!held.startsWith(THINKING_OPEN)) {
          const text = held
          held = ''
          phase = 'body'
          return { thinking: '', text }
        }
        phase = 'inside'
      }
      const at = held.indexOf(THINKING_CLOSE)
      if (at < 0) return { thinking: '', text: '' }
      const thinking = held.slice(THINKING_OPEN.length, at)
      const text = held.slice(at + THINKING_CLOSE.length)
      held = ''
      phase = 'body'
      return { thinking, text }
    },
    flush() {
      const out = held
      held = ''
      phase = 'body'
      return out
    },
  }
}

/**
 * usage 归一。
 *
 * **口径陷阱**：OpenAI 兼容协议的 `prompt_tokens` 是**含**缓存命中的总量
 * （DeepSeek 实测 `prompt_tokens = cache_hit + cache_miss`），而 Anthropic 的
 * `input_tokens` 是**不含**缓存的余量。两边都直接累加的话，兼容侧会把命中的
 * token 按全价再算一遍——缓存命中率越高，账单偏差越大。
 *
 * 这里统一收敛到 Anthropic 的「排他」口径：inputTokens 只装未命中部分。
 */
function applyUsage(acc: ProviderUsage, u: CompatUsage) {
  if (typeof u.completion_tokens === 'number') acc.outputTokens = u.completion_tokens

  // 各家字段名不统一：DeepSeek 是 prompt_cache_hit_tokens，OpenAI 是
  // prompt_tokens_details.cached_tokens。都认，认不出就保持 null（未回报）。
  const details = u.prompt_tokens_details
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
  const outDetails = u.completion_tokens_details
  if (outDetails && typeof outDetails.reasoning_tokens === 'number') {
    acc.reasoningTokens = outDetails.reasoning_tokens
  }
  acc.source = 'provider'
}

function collectToolCalls(
  partial: Map<number, { id: string; name: string; json: string }>,
  model: string,
): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const [, slot] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) throw namelessToolCall('openai_chat_completions', model)
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
