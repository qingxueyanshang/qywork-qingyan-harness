/**
 * OpenAI Responses 协议适配器（/v1/responses）。
 *
 * 与 chat/completions 的差别不在「换个路径」，而在三处**形状**：
 *
 * 1. **`input` 不是 `messages`**。它是一串条目（item），每条有自己的 `type`：
 *    `message` / `function_call` / `function_call_output`。工具调用和工具结果
 *    是**顶层条目**，不是挂在 message 上的字段——这是最容易照搬 chat 协议搬错的地方。
 * 2. **工具定义扁平**。`{type:'function', name, description, parameters}`，
 *    没有 chat 协议那层 `function: {...}` 包装。
 * 3. **流式事件是有类型的 SSE**，不是 delta 拼接：`response.output_text.delta`、
 *    `response.function_call_arguments.delta` 等等。
 *
 * 还有一处不在形状上但同样致命：**`max_output_tokens` 同时封顶思考与正文**。
 * 按「不思考」的口径调小它，回答会从中间被截断。
 *
 * 实现取舍：**直接打 HTTP，不用 SDK**。SDK 的 Responses 类型随版本变动频繁，
 * 而这里要处理的字段集本来就得按 Record 断言（推理条目、各家中转站的扩展字段）。
 * 引一层类型再全部 as never，等于既付了依赖又没拿到类型收益。
 *
 * ## 推理内容的两套方言（2026-08 对 DeepSeek v4 flash 实测）
 *
 * 说 Responses 协议的**不止 OpenAI**，而它们在推理这一块**不是一套东西**：
 *
 * | | OpenAI | DeepSeek |
 * |---|---|---|
 * | 流式事件 | `response.reasoning_summary_text.delta` | `response.reasoning_text.delta` |
 * | 输出条目 | `reasoning.summary[]` | `reasoning.content[].reasoning_text` |
 * | 要不要回传 | 不要求 | **要求，不传就 400** |
 *
 * 这两条各有各的坑，**错法不一样**：
 *
 * - 只认 `reasoning_summary_text` 的后果是**静默的**——流跑完、正文正常、
 *   一个 `thinking_delta` 都没有。没有报错，只是思考过程凭空消失。
 * - 不回传的后果是**响亮的**——`The reasoning_text in the thinking mode must be
 *   passed back to the API`，400。而且它只在**第二轮**才发作：
 *   第一轮没有历史可回传，一路正常；模型一旦调了工具，把结果喂回去就炸。
 *   也就是说**任何单轮测试都测不出它**，而 agent 的主循环恰恰全是多轮。
 *
 * 实测出来的回传规则（见 `buildInput`）：
 * - `reasoning` 条目必须排在它对应的 `function_call` **之前**；插在
 *   `function_call` 和 `function_call_output` 中间会得到「找不到工具输出」。
 * - `id` 和 `summary` 可以省。
 * - **文本为空串等于没传**，照样 400。所以占位文本不能是空的。
 * - 只有**最后**一轮工具调用被检查；但我们每一轮都带上，不去赌它的实现细节。
 */

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
import { PROVIDER_HTTP } from '../types.ts'
import { normalizeBaseUrl } from './openai-compat.ts'

export class OpenAIResponsesAdapter implements LlmAdapter {
  readonly kind = 'openai_responses' as const
  // Responses 协议有原生的 reasoning 字段（含 effort），但**发不发按模型的方言算**：
  // 判据只有 `effortIsTransmittable` 一份，与 `buildReasoning` 实际发的字段同源。
  // 各写一份的代价实测付过：这里说「发得出去」而那边按方言省掉，
  // 于是探针恒通过，把凭空的结论写回目录。
  get transmits(): { effort: boolean } {
    return { effort: effortIsTransmittable(this.spec) }
  }
  readonly spec: ModelSpec
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    // 与兼容协议同一条归一：少了 `/v1` 的地址在多数中转站上会回一个 200 的网页，
    // 而那种失败是静默的（0 事件、0 token、当成正常完成）。
    this.baseUrl = normalizeBaseUrl(profile.baseUrl)
    this.headers = {
      'content-type': 'application/json',
      ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      ...(profile.headers ?? {}),
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

    yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req) }

    const usage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'estimated',
    }
    let stopReason: ProviderStopReason = 'end_turn'
    // provider 的原话，只进账本不参与判断。空串 = 流断在终态事件之前。
    let rawFinish = ''
    /** 按 output_index 累积的工具调用。参数是分片到达的。 */
    const partial = new Map<number, { id: string; name: string; json: string }>()

    /*
     * 连接超时：**只管到响应头到达为止**，之后必须撤掉。
     *
     * 直接 `AbortSignal.timeout()` 会把正文流一起掐了——一次长生成跑过这个数
     * 就断在半路。所以自己起一个定时器，`fetch` 一 resolve 就清掉，
     * 与两个官方 SDK 的做法一致（它们在 fetch 的 finally 里 clearTimeout）。
     *
     * 用户按停止走的是 `req.signal`，与这条超时是两回事，所以下面要分开认：
     * 混起来会把「连不上」报成「已取消」。
     */
    const connect = new AbortController()
    const timer = setTimeout(() => connect.abort(), PROVIDER_HTTP.timeout)
    const signal = req.signal ? AbortSignal.any([req.signal, connect.signal]) : connect.signal

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      })
    } catch (err) {
      if (connect.signal.aborted) {
        throw new ProviderError({
          code: 'network_error',
          message: `连接超时：${PROVIDER_HTTP.timeout / 1000} 秒内没有收到响应`,
          retryable: true,
          provider: 'openai_responses',
        })
      }
      throw classifyProviderError('openai_responses', err)
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // 错误体要读出来再分类：容量拒绝的判据全在响应正文里，
      // 只拿状态码分类会把「上下文超了」和「参数写错了」混成同一个 400。
      const text = await res.text().catch(() => '')
      throw classifyProviderError('openai_responses', asError(res.status, text))
    }
    if (!res.body) {
      throw new ProviderError({
        code: 'provider_unavailable',
        message: '响应没有 body',
        retryable: true,
        provider: 'openai_responses',
        status: res.status,
      })
    }

    try {
      for await (const event of readSse(res.body)) {
        const type = String(event.type ?? '')

        if (type === 'response.output_text.delta') {
          const delta = String(event.delta ?? '')
          if (delta) yield { type: 'text_delta', delta }
          continue
        }

        // 推理内容。**不是** output_text——把它当正文会让思考内容混进回答里。
        //
        // 两个事件名都要认：OpenAI 发 `reasoning_summary_text`（摘要），
        // DeepSeek 发 `reasoning_text`（原文）。只认前者的后果是静默丢失——
        // 流跑完、正文正常、思考过程一个字都没有，不报任何错。
        if (
          type === 'response.reasoning_text.delta' ||
          type === 'response.reasoning_summary_text.delta'
        ) {
          const delta = String(event.delta ?? '')
          if (delta) yield { type: 'thinking_delta', delta }
          continue
        }

        if (type === 'response.output_item.added') {
          const item = (event.item ?? {}) as Record<string, unknown>
          if (item.type === 'function_call') {
            const idx = Number(event.output_index ?? partial.size)
            const slot = {
              id: String(item.call_id ?? item.id ?? `call_${idx}`),
              name: String(item.name ?? ''),
              json: '',
            }
            partial.set(idx, slot)
          }
          continue
        }

        if (type === 'response.function_call_arguments.delta') {
          const idx = Number(event.output_index ?? 0)
          const slot = partial.get(idx)
          const argsDelta = String(event.delta ?? '')
          if (slot && argsDelta) slot.json += argsDelta
          continue
        }

        // 收尾事件带**完整**参数。以它为准而不是只靠拼分片：
        // 掉一片分片的表现是「参数少一个字段」——那比整条调用失败更难查，
        // 因为工具会拿着一份看起来合法的参数跑出一个错结果。
        if (type === 'response.function_call_arguments.done') {
          const idx = Number(event.output_index ?? 0)
          const slot = partial.get(idx)
          if (slot && typeof event.arguments === 'string') slot.json = event.arguments
          continue
        }

        if (type === 'response.output_item.done') {
          const item = (event.item ?? {}) as Record<string, unknown>
          if (item.type !== 'function_call') continue
          const idx = Number(event.output_index ?? 0)
          const name = String(item.name ?? '')
          const id = String(item.call_id ?? item.id ?? `call_${idx}`)
          const slot = partial.get(idx)
          if (slot) {
            if (typeof item.arguments === 'string' && item.arguments) slot.json = item.arguments
            if (!slot.name && name) slot.name = name
            continue
          }
          // 没见过 added 事件也要能收下这条调用——中转站漏发增量事件时，
          // 丢掉它等于模型调了工具而我们当作没调，然后模型下一轮重复调用。
          // 名字没来也照样建槽：能不能执行由 `collectToolCalls` 统一裁决，
          // 在这里 `continue` 掉的话它就从账本上彻底消失了。
          partial.set(idx, {
            id,
            name,
            json: typeof item.arguments === 'string' ? item.arguments : '',
          })
          continue
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
          const response = (event.response ?? {}) as Record<string, unknown>
          applyUsage(usage, response.usage as Record<string, unknown> | undefined)
          rawFinish = rawStatusOf(response)
          stopReason = normalizeStatus(response)
          continue
        }

        // 流内错误。SSE 已经 200 了，错误只能从事件里出——不认它的话
        // 表现是「流正常结束但什么都没有」。
        if (type === 'response.failed' || type === 'error') {
          const detail =
            ((event.response as Record<string, unknown>)?.error as Record<string, unknown>) ??
            (event.error as Record<string, unknown>) ??
            {}
          throw classifyProviderError(
            'openai_responses',
            asError(200, JSON.stringify(detail || event)),
          )
        }
      }
    } catch (err) {
      throw classifyProviderError('openai_responses', err)
    }

    const calls = collectToolCalls(partial, req.model)
    if (calls.length) {
      // 截断优先，别把 max_tokens 覆盖成 tool_use——理由同 openai-compat：
      // 参数拼到一半被截断时，抹掉截断信号 = 上层拿着残缺参数照常执行工具。
      if (stopReason !== 'max_tokens') stopReason = 'tool_use'
      yield { type: 'tool_calls', calls }
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason, rawStopReason: rawFinish }
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const instructions = req.system
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n')

    return {
      model: req.model,
      ...(instructions ? { instructions } : {}),
      input: buildInput(req.messages),
      // 同时封顶思考与正文。按「不思考」的口径调小它，回答会从中间截断。
      max_output_tokens: Math.min(req.maxOutputTokens, this.spec.maxOutputTokens),
      ...(req.tools.length ? { tools: buildTools(req.tools) } : {}),
      ...this.buildReasoning(req),
      // 亲和键发不发由目录里那条模型说了算，判据与 chat/completions 那支同一个
      // 字段——两条协议各写一套判定，就会出现「同一个模型换条协议就不发了」。
      ...(req.cacheKey && this.spec.cacheRouting === 'prompt_cache_key'
        ? { prompt_cache_key: req.cacheKey }
        : {}),
      store: false,
    }
  }

  /**
   * 推理配置。
   *
   * 与 Anthropic 一样，**关不掉的模型上必须整个省略这个字段**——
   * 传 `{effort:'none'}` 给一个恒开推理的模型会 400，而那种 400 的文案
   * 跟容量拒绝长得很像，之后就是一次毫无用处的压缩重发。
   *
   * ## 「不思考」必须是 `none`，不能是 `minimal`
   *
   * **不能把「不思考」映射成 `{effort:'minimal'}`。** 实测
   * （deepseek-v4-flash，`max_output_tokens=900`，各三次）：
   *
   * ```
   * effort=none      reasoning_tokens  0,   0,   0
   * effort=minimal   reasoning_tokens  900, 900, 900
   * ```
   *
   * `minimal` 不是「少想一点」，它跟 high 一样把整个输出预算烧在推理上，
   * 正文直接被截断。**用户要求不思考，拿到的是全额思考并且付钱**——
   * 而且因为没报错，这件事完全静默。
   */
  private buildReasoning(req: ChatRequest): Record<string, unknown> {
    if (this.spec.thinking === 'none') return {}
    // 带不带 effort 只由 `effortIsTransmittable` 裁决，不在这里另判一遍。
    const effort =
      req.effort && effortIsTransmittable(this.spec) && this.spec.effortLevels.includes(req.effort)
        ? req.effort
        : undefined
    return {
      reasoning: {
        ...(effort ? { effort } : {}),
        // 要拿到 thinking_delta 就必须显式要摘要；不要的话推理过程完全不可见，
        // 而用户看到的是「模型停了很久然后突然出结果」。
        summary: 'auto',
      },
    }
  }
}

// ───────────────────────── 请求装配 ─────────────────────────

/**
 * 思考内容丢失时的占位。
 *
 * **不能是空串**：DeepSeek 对空 `reasoning_text` 的处理与「没传」完全一样，
 * 照样 400。同时它必须读起来就是一句交代，不能编一段像模像样的思考——
 * 那等于往模型的历史里塞它没想过的东西。
 */
const LOST_REASONING = '(上一轮的思考内容未能保留)'

function reasoningItem(text: string): Record<string, unknown> {
  return { type: 'reasoning', content: [{ type: 'reasoning_text', text }] }
}

/**
 * `input` 是条目序列，不是消息序列。
 *
 * 工具调用与工具结果是**顶层条目**（`function_call` / `function_call_output`），
 * 不是挂在 assistant message 上的字段。照搬 chat 协议的写法会得到一个
 * 结构合法但语义错误的请求：模型看不到自己调过什么。
 *
 * 带工具调用的 assistant 轮还要**回传思考内容**，见文件头。
 */
export function buildInput(messages: WireMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []

  /**
   * 这个端点说不说「要回传 reasoning_text」这套方言。
   *
   * 判据是**证据**不是猜测：这批消息里只要有一条真的带着思考内容，
   * 就说明我们确实从这个端点收到过 `reasoning_text`，那它多半也要求回传。
   * 于是那些**缺**思考内容的轮次（压缩投影时掉了、从旧记录里读出来的）
   * 才补占位条目。
   *
   * 反过来，一条思考内容都没有的端点（OpenAI 自家在不给摘要时就是这样）
   * 一个 reasoning 条目都不会多出来——不拿一个只在 DeepSeek 上验过的行为，
   * 去改一条没验过的路径。
   */
  const speaksReasoningText = messages.some((m) => Boolean(m.reasoningContent?.trim()))

  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: typeof m.content === 'string' ? m.content : flatten(m.content),
      })
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const text = typeof m.content === 'string' ? m.content : ''
      // reasoning 必须排在 function_call **之前**。放到 call 与 output 中间，
      // 会被判成「找不到工具输出」——错误信息指向的地方跟真正的原因无关。
      const reasoning = m.reasoningContent?.trim()
      if (reasoning) items.push(reasoningItem(reasoning))
      else if (speaksReasoningText) items.push(reasoningItem(LOST_REASONING))
      if (text) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      for (const c of m.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.arguments),
        })
      }
      continue
    }

    // 输入侧文本用 input_text，输出侧用 output_text。写反了会被拒，
    // 而错误信息只说「content 无效」，不说是哪一条。
    const role = m.role === 'system' ? 'system' : m.role
    const isAssistant = role === 'assistant'
    if (typeof m.content === 'string') {
      items.push({
        type: 'message',
        role,
        content: [{ type: isAssistant ? 'output_text' : 'input_text', text: m.content }],
      })
      continue
    }
    items.push({ type: 'message', role, content: toResponsesContent(m.content) })
  }

  return items
}

function toResponsesContent(content: Exclude<WireMessage['content'], string>) {
  return content.map((b) => {
    if (b.type === 'text') return { type: 'input_text', text: b.text }
    if (b.type === 'image') {
      return { type: 'input_image', image_url: `data:${b.mimeType};base64,${b.data}` }
    }
    return {
      type: 'input_file',
      filename: b.title ?? 'file',
      file_data: `data:${b.mimeType};base64,${b.data}`,
    }
  })
}

/** 工具定义是**扁平**的，没有 chat 协议那层 `function: {...}` 包装。 */
export function buildTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
}

// ───────────────────────── 响应解析 ─────────────────────────

/**
 * 读 SSE。
 *
 * 只认 `data:` 行，事件类型从 JSON 体里的 `type` 取——Responses 的 `event:` 行
 * 与体内的 `type` 是重复的，而中转站不一定两个都发。以体为准更稳。
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, any>, void, unknown> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        yield JSON.parse(payload)
      } catch {
        // 半行或非 JSON 的心跳。忽略而不是报协议错误——
        // 一个心跳把整轮 run 打断，代价完全不成比例。
      }
    }
  }
}

export function applyUsage(acc: ProviderUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return
  const input = Number(raw.input_tokens ?? 0)
  const details = raw.input_tokens_details as Record<string, unknown> | undefined
  const cached = details?.cached_tokens
  const outDetails = raw.output_tokens_details as Record<string, unknown> | undefined

  // Responses 的 input_tokens **含**缓存命中，与 Anthropic 的排他口径相反。
  // 统一收敛到排他口径：不减的话缓存命中越多，账单错得越离谱。
  acc.cachedTokens = typeof cached === 'number' ? cached : null
  acc.inputTokens = Math.max(0, input - (acc.cachedTokens ?? 0))
  acc.outputTokens = Number(raw.output_tokens ?? 0)
  acc.reasoningTokens = Number(outDetails?.reasoning_tokens ?? 0)
  acc.source = 'provider'
}

/**
 * provider 的原话：`status` 加上不完整时的具体原因。
 *
 * Responses 协议的终态分两层——`status` 说完没完，`incomplete_details.reason`
 * 说为什么没完。只记一层的话，`incomplete` 这个词说不出是撞了输出上限还是被过滤。
 */
function rawStatusOf(response: Record<string, unknown>): string {
  const status = typeof response.status === 'string' ? response.status : ''
  const incomplete = response.incomplete_details as Record<string, unknown> | undefined
  const reason = typeof incomplete?.reason === 'string' ? incomplete.reason : ''
  return reason ? `${status}:${reason}` : status
}

function normalizeStatus(response: Record<string, unknown>): ProviderStopReason {
  const incomplete = response.incomplete_details as Record<string, unknown> | undefined
  if (incomplete?.reason === 'max_output_tokens') return 'max_tokens'
  if (incomplete?.reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function collectToolCalls(
  partial: Map<number, { id: string; name: string; json: string }>,
  model: string,
): WireToolCall[] {
  return [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => {
      if (!slot.name) throw namelessToolCall('openai_responses', model)
      // 参数解析失败**不能吞**：交一个空对象上去，模型会以为工具收到了它给的参数。
      const parsed = parseArgs(slot.json)
      return {
        id: slot.id,
        name: slot.name,
        arguments: parsed.args,
        ...(parsed.error === null ? {} : { argumentsError: parsed.error }),
      }
    })
}

function parseArgs(json: string): { args: Record<string, unknown>; error: string | null } {
  if (!json.trim()) return { args: {}, error: null }
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null
      ? { args: parsed, error: null }
      : { args: {}, error: json }
  } catch {
    // 保留原文交给上层去拒绝，比静默变成 {} 强：后者会让模型
    // 以为参数被接受了，然后对着一个完全不同的结果继续往下走。
    return { args: {}, error: json }
  }
}

function flatten(content: Exclude<WireMessage['content'], string>): string {
  return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

function asError(status: number, body: string): Error & { status: number } {
  let message = body
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error?.message ?? parsed?.message ?? body
  } catch {
    // 非 JSON 错误体（网关的 HTML 页面之类）原样带上。
  }
  return Object.assign(new Error(message || `HTTP ${status}`), { status })
}
