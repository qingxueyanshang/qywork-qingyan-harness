/**
 * OpenAI Responses 协议适配器（/v1/responses）。
 *
 * 与 chat/completions 的差别不在路径，而在三处形状：
 *
 * 1. `input` 不是 `messages`。它是一组条目（item），每个条目有自己的 `type`：
 *    `message` / `function_call` / `function_call_output`。工具调用与工具结果
 *    是顶层条目，而不是 message 上的字段；按 chat 协议编写时最容易在此出错。
 * 2. 工具定义是扁平的。`{type:'function', name, description, parameters}`，
 *    没有 chat 协议的 `function: {...}` 包装层。
 * 3. 流式事件是带类型的 SSE，而不是 delta 拼接：`response.output_text.delta`、
 *    `response.function_call_arguments.delta` 等。
 *
 * 另有一处与形状无关但同样关键：`max_output_tokens` 同时限制思考与正文。
 * 按「不思考」的口径调小该值，回答会在中途被截断。
 *
 * 实现取舍：直接发送 HTTP 请求，不使用 SDK。SDK 的 Responses 类型随版本频繁变动，
 * 而此处处理的字段集本身须按 Record 断言（推理条目、各中转站的扩展字段）。
 * 引入一层类型后再全部断言为 never，等于承担了依赖却未获得类型收益。
 *
 * 推理内容：同一协议下的两种实现（2026-08 对 DeepSeek v4 flash 实测）。实现 Responses 协议的
 * 不只有 OpenAI，而各实现在推理部分的行为不同：
 *
 * | | OpenAI | DeepSeek |
 * |---|---|---|
 * | 流式事件 | `response.reasoning_summary_text.delta` | `response.reasoning_text.delta` |
 * | 输出条目 | `reasoning.summary[]` | `reasoning.content[].reasoning_text` |
 * | 是否须回传 | 不要求，多发送返回 400 | 要求，不回传返回 400 |
 *
 * 两处各有易错点，出错方式不同：
 *
 * - 只识别 `reasoning_summary_text` 的后果是静默的：流执行完毕、正文正常，
 *   但没有任何 `thinking_delta`。不报错，思考流因缺少对应事件而中断。
 *   因此两个事件名都转换为 `thinking_delta`：两种实现的思考内容都需要显示。
 * - 回传在两个方向上都会返回 400，方向相反：不要求回传的一侧多发送一个条目，
 *   得到 `Invalid 'input[N].content': array too long. Expected an array with
 *   maximum length 0`；要求回传的一侧少发送，得到 `The reasoning_text in the
 *   thinking mode must be passed back to the API`。
 *   两者都只在第二轮出现：第一轮没有可回传的历史，请求正常；模型调用工具并
 *   回传结果后即返回 400。任何单轮测试都无法发现，而 agent 的主循环均为多轮。
 *
 * 因此「是否须回传」不能从流中反推：摘要型端点同样会返回推理文本，反推必然产生假阳性。
 * 这是接收端的要求，由目录字段 `spec.reasoningEcho` 声明，`buildInput` 只查询不推测。
 *
 * 实测得到的回传规则（见 `buildInput`）：
 * - `reasoning` 条目必须排在其对应的 `function_call` 之前；插在
 *   `function_call` 与 `function_call_output` 之间会得到「未找到工具输出」。
 * - `id` 与 `summary` 可以省略。
 * - 文本为空串等同于未发送，同样返回 400，因此占位文本不能为空。
 * - 只有最后一轮工具调用会被检查；但每一轮都附带，不依赖该实现细节。
 */

import type { ReasoningEcho } from '@qywork/core'
import { effortIsTransmittable, type ModelSpec } from '../catalog.ts'
import { classifyProviderError, classifyStreamError, ProviderError } from '../errors.ts'
import { readSse, SSE_DONE, sseJson } from '../sse.ts'
import { estimateRequest } from '../tokens.ts'
import { newTrace, readTransport, traceFetch } from '../transport.ts'
import type {
  ChatRequest,
  LlmAdapter,
  ProviderEvent,
  ProviderProfile,
  ProviderStopReason,
  ProviderUsage,
  ToolSchema,
  WireMessage,
} from '../types.ts'
import { imageData, outputCap, PROVIDER_HEADERS, PROVIDER_HTTP } from '../types.ts'
import { mergeContextIntoUsers } from './context.ts'
import { normalizeBaseUrl, strictify } from './openai-compat.ts'
import { collectToolCalls } from './tool-calls.ts'

export class OpenAIResponsesAdapter implements LlmAdapter {
  readonly kind = 'openai_responses' as const
  // Responses 协议有原生的 reasoning 字段（含 effort），但是否发送按该模型的参数格式判定：
  // 判据只有 `effortIsTransmittable` 一处，与 `buildReasoning` 实际发送的字段同源。
  // 两处各自判定时，此处声明可以发送而另一处按参数格式省略，
  // 探针因此恒为通过，并将无依据的结论写回目录。
  get transmits(): { effort: boolean } {
    return { effort: effortIsTransmittable(this.spec) }
  }
  readonly spec: ModelSpec
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    // 与兼容协议使用同一归一规则：缺少 `/v1` 的地址在多数中转站上会返回 200 的网页，
    // 而该失败是静默的（0 事件、0 token、记为正常完成）。
    this.baseUrl = normalizeBaseUrl(profile.baseUrl)
    this.headers = {
      ...PROVIDER_HEADERS,
      'content-type': 'application/json',
      ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      ...(profile.headers ?? {}),
    }
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
    // provider 返回的原值，只记入账本，不参与判断。
    let rawFinish = ''
    /**
     * 是否已收到终态事件。不能以 `rawFinish` 是否为空串代替：
     * `rawStatusOf` 在 `response` 缺少 `status` 字段时返回空串，
     * 此时终态已到达，以空串为判据会将正常结束报告为截断。
     */
    let settled = false
    /** 按 output_index 累积的工具调用。参数分片到达。 */
    const partial = new Map<number, { id: string; name: string; json: string }>()
    const encryptedReasoning = new Map<number, Record<string, unknown>>()
    const keepReasoning = (idx: number, item: Record<string, unknown>) => {
      if (
        this.spec.reasoningEcho === 'encrypted_content' &&
        item.type === 'reasoning' &&
        typeof item.encrypted_content === 'string' &&
        item.encrypted_content
      )
        encryptedReasoning.set(idx, item)
    }

    /*
     * 连接超时：只作用到响应头到达为止，之后必须撤销。
     *
     * 直接使用 `AbortSignal.timeout()` 会将正文流一并中断：长时间生成超过该时长
     * 即会中途断开。因此单独设置定时器，`fetch` resolve 后立即清除。
     *
     * 用户点击停止经由 `req.signal` 传递，与该超时是两个独立信号，因此下方须分别识别：
     * 混淆时会将「连接失败」报告为「已取消」。
     */
    const connect = new AbortController()
    const timer = setTimeout(() => connect.abort(), PROVIDER_HTTP.timeout)
    const signal = req.signal ? AbortSignal.any([req.signal, connect.signal]) : connect.signal

    const trace = newTrace()
    let res: Response
    try {
      res = await traceFetch(
        trace,
        'openai_responses',
        req.idleTimeoutMs,
      )(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal,
        // 关闭运行时的 socket 空闲超时，理由见 PROVIDER_HTTP。SDK 适配器由 SDK 合并该选项，此处自行调用 fetch，须手动展开。
        ...PROVIDER_HTTP.fetchOptions,
      })
    } catch (err) {
      if (connect.signal.aborted) {
        throw classifyProviderError(
          'openai_responses',
          new ProviderError({
            code: 'network_error',
            // 只给出失败分类；实际静默时长与重发次数由 AgentLoop 统一补充。
            message: '连接超时',
            provider: 'openai_responses',
            timedOut: true,
          }),
          readTransport(trace),
        )
      }
      throw classifyProviderError('openai_responses', err, readTransport(trace))
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // 须读取错误体后再分类：容量拒绝的判据均在响应正文中，
      // 只按状态码分类会将「上下文超限」与「参数错误」混为同一种 400。
      const text = await res.text().catch(() => '')
      throw classifyProviderError(
        'openai_responses',
        asError(res.status, text, res.headers),
        readTransport(trace),
      )
    }
    if (!res.body) {
      throw new ProviderError({
        code: 'provider_unavailable',
        message: '响应没有 body',
        provider: 'openai_responses',
        status: res.status,
      })
    }

    // fetch 在响应头到达时 resolve，此时正文 SSE 尚未开始。将该时刻记入账本，
    // 才能区分「请求上传或中转排队」与「provider 接收请求后的预填充或思考」。
    yield {
      type: 'response_started',
      headersAt: trace.headersAt!,
      ...(trace.hedge ? { hedge: trace.hedge } : {}),
    }

    try {
      for await (const frame of readSse(res.body)) {
        // Responses 协议不发送 `[DONE]`；中转站补发时也不视为终态，终态以 response.completed 与 response.incomplete 为准。
        if (frame.data === SSE_DONE) continue
        const event = sseJson(frame.data)
        if (!event) continue
        // 本帧解析完成的时刻。带内容的事件统一使用该时刻，不由下游各自读取当前时刻。
        const at = Date.now()
        const type = String(event.type ?? '')

        if (type === 'response.output_text.delta') {
          const delta = String(event.delta ?? '')
          if (delta) yield { type: 'text_delta', delta, at }
          continue
        }

        // 推理内容，而非 output_text：将其视为正文会使思考内容混入回答。
        //
        // 两个事件名均须识别：OpenAI 发送 `reasoning_summary_text`（摘要），
        // DeepSeek 发送 `reasoning_text`（原文）。只识别前者会导致静默丢失：
        // 流执行完毕、正文正常，但思考过程完全缺失，且不报任何错误。
        if (
          type === 'response.reasoning_text.delta' ||
          type === 'response.reasoning_summary_text.delta'
        ) {
          const delta = String(event.delta ?? '')
          if (delta) yield { type: 'thinking_delta', delta, at }
          continue
        }

        if (type === 'response.output_item.added') {
          const item = (event.item ?? {}) as Record<string, unknown>
          if (item.type === 'function_call') {
            const idx = Number(event.output_index ?? partial.size)
            const slot = {
              id: String(item.call_id ?? item.id ?? `call_${idx}`),
              name: String(item.name ?? ''),
              json: typeof item.arguments === 'string' ? item.arguments : '',
            }
            partial.set(idx, slot)
          }
          continue
        }

        if (type === 'response.function_call_arguments.delta') {
          const idx = Number(event.output_index ?? 0)
          const slot = partial.get(idx)
          const argsDelta = String(event.delta ?? '')
          if (slot && argsDelta) {
            slot.json += argsDelta
            yield { type: 'tool_call_progress', at }
          }
          continue
        }

        // 结束事件携带完整参数，以其为准，而不只依赖分片拼接：
        // 丢失一个分片会导致参数缺少字段，比整条调用失败更难排查，
        // 因为工具会以看似合法的参数执行并产生错误结果。
        if (type === 'response.function_call_arguments.done') {
          const idx = Number(event.output_index ?? 0)
          const slot = partial.get(idx)
          if (slot && typeof event.arguments === 'string') slot.json = event.arguments
          continue
        }

        if (type === 'response.output_item.done') {
          const item = (event.item ?? {}) as Record<string, unknown>
          keepReasoning(Number(event.output_index ?? 0), item)
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
          // 未收到 added 事件时同样接收该调用：中转站漏发增量事件时，
          // 丢弃该调用等于模型调用了工具而本地视为未调用，模型下一轮会重复调用。
          // 名称未到达时同样建立槽位：能否执行由 `collectToolCalls` 统一裁决，
          // 在此处 `continue` 会使该调用从账本中完全消失。
          partial.set(idx, {
            id,
            name,
            json: typeof item.arguments === 'string' ? item.arguments : '',
          })
          continue
        }

        if (type === 'response.completed' || type === 'response.incomplete') {
          const response = (event.response ?? {}) as Record<string, unknown>
          // 完整 output 是本轮最终快照，替换增量记录，避免参数缺失或重复调用。
          if (Array.isArray(response.output)) {
            partial.clear()
            encryptedReasoning.clear()
            for (const [idx, item] of response.output.entries()) {
              if (!item || typeof item !== 'object') continue
              keepReasoning(idx, item)
              if (item?.type !== 'function_call') continue
              partial.set(idx, {
                id: String(item.call_id ?? item.id ?? `call_${idx}`),
                name: String(item.name ?? ''),
                json: typeof item.arguments === 'string' ? item.arguments : '',
              })
            }
          }
          applyUsage(usage, response.usage as Record<string, unknown> | undefined)
          rawFinish = rawStatusOf(response)
          stopReason = normalizeStatus(response)
          settled = true
          // 收到终态即结束读取：读取器随即取消 body，工具调用与用量无需等待 HTTP EOF 即可交付。
          break
        }

        // 流内错误。SSE 已返回 200，错误只能出现在事件中；不识别该事件时，
        // 流正常结束但没有任何内容。
        if (type === 'response.failed' || type === 'error') {
          // 顶层 `error` 事件本身即为错误对象，因此回退到 `event` 而不是空对象：
          // 空对象会将 provider 原文替换为 `{}`。
          const detail =
            ((event.response as Record<string, unknown>)?.error as Record<string, unknown>) ??
            (event.error as Record<string, unknown>) ??
            event
          throw classifyStreamError('openai_responses', detail)
        }
      }

      /*
       * 流已结束但未收到终态事件，表示传输被截断，而非模型输出完毕。
       *
       * 与 `openai-compat` 中的检查相同：默认值 `end_turn` 会将连接中断
       * 记为正常完成，使输出中断的一轮被记为成功，
       * 用量也停留在估算值，该轮读数无法对账。
       *
       * 记为传输失败而非 provider 拒绝：没有 HTTP 状态码，无法判断是否计费，
       * 账本行因此记为 `uncertain`。已接收量由 `agent/loop/attempt.ts` 的
       * 现场读数补充，因此此处不再区分「没有任何事件」与「中途断开」两种描述。
       */
      if (!settled) {
        throw new ProviderError({
          code: 'network_error',
          message: '流在终态事件之前结束',
          provider: 'openai_responses',
          // 用量已到达而终态未到达时附带真实值。`source` 仍为 `estimated`
          // 表示 provider 未回报任何用量，此时不附带，否则会将零作为真实值记入账本。
          ...(usage.source === 'provider' ? { usage } : {}),
        })
      }
    } catch (err) {
      throw classifyProviderError('openai_responses', err, readTransport(trace))
    }

    const calls = collectToolCalls(partial, 'openai_responses', req.model)
    if (encryptedReasoning.size) {
      yield {
        type: 'response_reasoning',
        reasoning: {
          items: [...encryptedReasoning].sort(([a], [b]) => a - b).map(([, item]) => item),
          tokens: usage.reasoningTokens,
        },
        at: Date.now(),
      }
    }
    if (calls.length) {
      // 截断优先，不要将 max_tokens 覆盖为 tool_use，理由与 openai-compat 相同：
      // 参数拼接中途被截断时，丢失截断信号会使上层以残缺参数照常执行工具。
      if (stopReason !== 'max_tokens') stopReason = 'tool_use'
      yield { type: 'tool_calls', calls, at: Date.now() }
    }

    yield { type: 'usage', usage }
    yield { type: 'done', stopReason, rawStopReason: rawFinish }
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const instructions = req.system
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n\n')

    const cap = outputCap(req.maxOutputTokens, this.spec.maxOutputTokens)
    return {
      model: req.model,
      ...(instructions ? { instructions } : {}),
      input: buildInput(req.messages, this.spec.reasoningEcho),
      // 同时限制思考与正文。按「不思考」的口径调小该值，回答会在中途截断。
      // 未收录的模型不申报，由端点使用自身的默认值。
      ...(cap === null ? {} : { max_output_tokens: cap }),
      ...(req.tools.length ? { tools: buildTools(req.tools, this.spec.chatToolSchema) } : {}),
      ...this.buildReasoning(req),
      // 是否发送 `prompt_cache_key` 由目录中该模型的条目决定，判据与 chat/completions 分支为同一
      // 字段；两条协议各自判定会导致同一模型更换协议后不再发送。
      ...(req.cacheKey && this.spec.cacheRouting === 'prompt_cache_key'
        ? { prompt_cache_key: req.cacheKey }
        : {}),
      store: false,
    }
  }

  /**
   * 推理配置。
   *
   * 与 Anthropic 相同，无法关闭推理的模型必须省略整个字段：
   * 向推理恒开的模型发送 `{effort:'none'}` 会返回 400，而该 400 的文案
   * 与容量拒绝相似，随后会触发一次无效的压缩重发。
   *
   * 协议层的 `none` 与 `minimal` 含义不同。本产品不提供「关闭思考」档位：
   * 用户未选择时省略整个 `effort`，由模型使用默认值；不得为提速在后台发送
   * `none`，也不得以 `minimal` 代替关闭意图。
   */
  private buildReasoning(req: ChatRequest): Record<string, unknown> {
    if (this.spec.thinking === 'none') return {}
    // 是否携带 effort 只由 `effortIsTransmittable` 裁决，此处不重复判定。
    const effort =
      req.effort && effortIsTransmittable(this.spec) && this.spec.effortLevels.includes(req.effort)
        ? req.effort
        : undefined
    return {
      reasoning: {
        ...(effort ? { effort } : {}),
        // 原文型协议直接返回 reasoning_text；只有摘要型协议需要显式请求摘要。
        // MiniMax 的 reasoning 只声明 effort，不得同时发送 OpenAI 的摘要字段。
        ...(this.spec.reasoningEcho === 'reasoning_text' ||
        this.spec.reasoningEcho === 'reasoning_text_object'
          ? {}
          : { summary: 'auto' }),
      },
    }
  }
}

// ───────────────────────── 请求装配 ─────────────────────────

/**
 * 思考内容丢失时的占位。
 *
 * 不能是空串：DeepSeek 对空 `reasoning_text` 的处理与「未传」完全相同，
 * 同样返回 400。同时占位文本必须是一句说明，不得虚构看似真实的思考：
 * 那等于向模型的历史中写入其未生成过的内容。
 */
const LOST_REASONING = '(上一轮的思考内容未能保留)'

function reasoningItem(text: string, echo: ReasoningEcho): Record<string, unknown> {
  const content = { type: 'reasoning_text', text }
  return { type: 'reasoning', content: echo === 'reasoning_text_object' ? content : [content] }
}

/**
 * `input` 是条目序列，不是消息序列。
 *
 * 工具调用与工具结果是顶层条目（`function_call` / `function_call_output`），
 * 不是 assistant message 上的字段。按 chat 协议的写法会得到
 * 结构合法但语义错误的请求：模型无法看到自己调用过的工具。
 *
 * 带工具调用的 assistant 轮是否回传思考内容由 `echo` 决定，见文件头。
 * 密文条目只按消息上是否存在判定：前缀已变化的消息（含更换模型）已由装配点剥离，此处不再判定。
 */
export function buildInput(
  messages: WireMessage[],
  echo: ReasoningEcho,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  const echoesReasoning = echo === 'reasoning_text' || echo === 'reasoning_text_object'

  for (const m of mergeContextIntoUsers(messages)) {
    if (m.role === 'assistant' && echo === 'encrypted_content' && m.responseReasoning) {
      items.push(...m.responseReasoning.items)
    }
    if (m.role === 'tool') {
      /*
       * 工具结果可以包含图片。按文档，`function_call_output` 的结果「可以是纯
       * 字符串或 `input_text` / `input_image` 内容块列表」，视觉模型按真实图片
       * 处理，其他模型替换为占位文本；降级由服务端完成，客户端无条件发送。
       * 2026-08 实测确认：`deepseek-v4-flash-vision-exp` 能正确回答图中的数字与颜色。
       */
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: typeof m.content === 'string' ? m.content : toResponsesContent(m.content),
      })
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const text = typeof m.content === 'string' ? m.content : ''
      // reasoning 必须排在 function_call 之前。插在 function_call 与 function_call_output 之间时，
      // 端点报告「未找到工具输出」，错误信息指向的位置与实际原因无关。
      const reasoning = m.reasoningContent?.trim()
      if (echoesReasoning) items.push(reasoningItem(reasoning || LOST_REASONING, echo))
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

    // 输入侧文本使用 input_text，输出侧使用 output_text。两者写反时请求被拒绝，
    // 而错误信息只报告「content 无效」，不指明是哪一个条目。
    const role = m.role
    const isAssistant = role === 'assistant'
    if (isAssistant && echoesReasoning && m.reasoningContent) {
      items.push(reasoningItem(m.reasoningContent, echo))
    }
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
      return { type: 'input_image', image_url: `data:${b.mimeType};base64,${imageData(b.source)}` }
    }
    throw new Error('Responses 适配器不支持视频内容块')
  })
}

/** 工具定义是扁平结构，没有 chat 协议的 `function: {...}` 包装层。 */
export function buildTools(
  tools: ToolSchema[],
  schema: ModelSpec['chatToolSchema'] = 'openai_strict',
): Record<string, unknown>[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.strict && schema === 'openai_strict' ? strictify(t.parameters) : t.parameters,
      ...(t.strict && schema === 'openai_strict' ? { strict: true } : {}),
    }))
}

// ───────────────────────── 响应解析 ─────────────────────────

export function applyUsage(acc: ProviderUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return
  const input = Number(raw.input_tokens ?? 0)
  const details = raw.input_tokens_details as Record<string, unknown> | undefined
  const cached = details?.cached_tokens
  const written = details?.cache_write_tokens
  const outDetails = raw.output_tokens_details as Record<string, unknown> | undefined

  /*
   * Responses 的 `input_tokens` 是合计值：缓存命中、缓存写入与其余输入之和，
   * 与 Anthropic 的排他口径相反。必须同时减去命中与写入两项才得到排他口径；只减去命中时，
   * 写入部分同时计入 inputTokens 与 cacheWriteTokens，按 1.0x 与 1.25x
   * 重复计费。
   */
  acc.cachedTokens = typeof cached === 'number' ? cached : null
  acc.cacheWriteTokens = typeof written === 'number' ? written : null
  acc.inputTokens = Math.max(0, input - (acc.cachedTokens ?? 0) - (acc.cacheWriteTokens ?? 0))
  acc.outputTokens = Number(raw.output_tokens ?? 0)
  acc.reasoningTokens = Number(outDetails?.reasoning_tokens ?? 0)
  acc.source = 'provider'
}

/**
 * provider 返回的原始状态：`status`，以及不完整时的具体原因。
 *
 * Responses 协议的终态分两层：`status` 表示是否完成，`incomplete_details.reason`
 * 表示未完成的原因。只记录 `status` 时，`incomplete` 无法区分达到输出上限与内容被过滤。
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

function asError(
  status: number,
  body: string,
  headers?: Headers,
): Error & { status: number; headers?: Headers; error?: Record<string, unknown> } {
  let message = body
  let detail: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const nested = parsed.error
    detail =
      typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : parsed
    message = String(detail.message ?? body)
  } catch {
    // 非 JSON 错误体（如网关返回的 HTML 页面）原样作为错误信息。
  }
  return Object.assign(new Error(message || `HTTP ${status}`), {
    status,
    ...(headers ? { headers } : {}),
    ...(detail ? { error: detail } : {}),
  })
}
