/**
 * OpenAI 兼容协议适配器（/v1/chat/completions）。
 *
 * 覆盖 DeepSeek、Grok(xAI)、Kimi、通义、各类中转站，以及 ollama / vLLM 等本地推理服务。
 * 用户自定义的 AI 接口主要使用本路径：多数第三方端点只实现该协议。
 *
 * 两个必须处理的兼容点均来自实测，不是防御性推测：
 *
 * 1. reasoning_content 必须原样回传。DeepSeek 思考模式下，带 tool_calls 的 assistant
 *    消息若不同时回传 reasoning_content，下一轮返回 400。这不是可选优化。
 * 2. 缓存依靠前缀自动命中，没有显式断点。这些端点普遍不支持 cache_control，命中完全
 *    依赖前缀逐字节稳定，因此工具排序与消息装配的确定性在此处比在 Anthropic 更关键。
 */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isDashScopeEndpoint } from '@qywork/core'
import OpenAI from 'openai'
import { effortIsTransmittable, type ModelSpec, reasoningReplay } from '../catalog.ts'
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
import { imageData, outputCap, PROVIDER_HEADERS, PROVIDER_HTTP, videoData } from '../types.ts'
import { mergeContextIntoUsers } from './context.ts'
import { collectToolCalls } from './tool-calls.ts'

export class OpenAICompatAdapter implements LlmAdapter {
  readonly kind = 'openai_chat_completions' as const
  /**
   * 是否发送 effort 由目录中该模型的 `effortLevels` 决定，而不是由协议决定。
   *
   * 不要因「兼容协议下字段名因厂商而异」而写成 `effort: false`。字段名虽然不统一，
   * 但它是每个模型自身的属性，目录中已有记录（`thinking` 指明使用哪套字段，
   * `effortLevels` 指明有哪些档位）。一律不发送会使 GPT-5.6 / Gemini / Grok / Kimi /
   * GLM 等具有思考档位的模型均无法调节，而界面上仍显示一个选择后无效的控件。
   *
   * `thinking` 仍为 false：正文中的思考内容是从流中读取的
   * （`reasoning_content`），客户端从不主动声明。
   *
   * 未收录模型的 `effortLevels` 为 `[]`，不会多发送任何字节，因此自建端点
   * 不会因此开始收到未知字段。
   */
  get transmits(): {
    effort: boolean
    video: boolean
    mediaPaths?: boolean
    mediaUploadAbove?: number
  } {
    // 判据只有 `effortIsTransmittable` 一处，与 `buildReasoning` 实际发送的字段同源。
    // 恒为 true 会使 `qy probe` 的 effort 探针在无法发送该字段的模型上全部误判为通过。
    return {
      effort: effortIsTransmittable(this.spec),
      video: true,
      ...(this.dashScopeMedia
        ? { mediaPaths: true, mediaUploadAbove: DASHSCOPE_CHAT_INLINE_BYTES }
        : {}),
    }
  }
  readonly spec: ModelSpec
  private readonly client: OpenAI
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly dashScopeMedia: boolean
  private readonly uploadedMedia = new Map<string, Promise<string>>()
  /**
   * OpenCode 端点拒绝不带 `x-opencode-session` 的请求（400），且 prompt cache 按该值隔离：
   * 同一会话必须发送同一个值，值变化后前缀缓存不命中。有 `cacheKey` 时发送会话 id；
   * 检测与压缩摘要等不带 `cacheKey` 的请求使用按适配器实例生成的值。其他端点为 null。
   */
  private readonly openCodeSession: string | null

  constructor(profile: ProviderProfile, spec: ModelSpec) {
    this.spec = spec
    this.apiKey = profile.apiKey || 'unset'
    this.baseUrl = normalizeBaseUrl(profile.baseUrl)
    this.dashScopeMedia = isDashScopeEndpoint(this.baseUrl)
    this.openCodeSession = isOpenCodeEndpoint(this.baseUrl) ? crypto.randomUUID() : null
    this.client = new OpenAI({
      apiKey: this.apiKey,
      ...PROVIDER_HTTP,
      baseURL: this.baseUrl,
      defaultHeaders: { ...PROVIDER_HEADERS, ...profile.headers },
    })
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    let prepared: ChatRequest
    let body: ReturnType<OpenAICompatAdapter['buildBody']>
    let mediaHeaders: Record<string, string>
    try {
      prepared = this.dashScopeMedia ? await this.prepareDashScopeMedia(req) : req
      body = this.buildBody(prepared)
      mediaHeaders = dashScopeMediaHeaders(this.dashScopeMedia, prepared)
    } catch (err) {
      // 本地读取与临时上传均发生在主模型请求之前；失败时不得先报告 request_prepared，
      // 否则上层会将尚未发出的模型请求标记为 sent。
      throw classifyProviderError('openai_chat_completions', err)
    }

    yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, this.spec.density) }

    const usage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      source: 'estimated',
    }
    const requestHeaders = {
      ...mediaHeaders,
      ...(req.cacheKey && this.spec.cacheRouting === 'x_grok_conv_id'
        ? { 'x-grok-conv-id': req.cacheKey }
        : {}),
      ...(this.openCodeSession
        ? { 'x-opencode-session': req.cacheKey ?? this.openCodeSession }
        : {}),
    }
    let stopReason: ProviderStopReason = 'end_turn'
    // provider 返回的原值，只记入账本，不参与判断。结束时仍为空串表示流被截断，见下方的检查。
    let rawFinish = ''
    const partial = new Map<number, { id: string; name: string; json: string }>()
    const splitter = createThinkingSplitter()
    const trace = newTrace()

    try {
      /*
       * 使用 SDK 构造请求、鉴权与重试策略，响应体由本地读取。
       *
       * `asResponse()` 返回原始 `Response`，SSE 由共用读取器解析。不要改回 SDK 的流迭代：
       * SDK 将 `[DONE]` 仅视为一个标记并继续等待 HTTP EOF，工具调用与用量须待对端关闭连接
       * 才交付，对端不关闭则持续等待。
       *
       * 兼容端点的字段集不统一（reasoning_content、prompt_cache_hit_tokens 等均不在
       * 官方类型中），因此请求体与响应在此边界处做类型断言，内部按 Record 处理。
       */
      const res = await this.client
        .withOptions({ fetch: traceFetch(trace, 'openai_chat_completions', req.idleTimeoutMs) })
        .chat.completions.create(
          { ...body, stream: true, stream_options: { include_usage: true } } as never,
          {
            ...(req.signal ? { signal: req.signal } : {}),
            ...(Object.keys(requestHeaders).length ? { headers: requestHeaders } : {}),
          },
        )
        .asResponse()

      if (!res.body) {
        throw new ProviderError({
          code: 'provider_unavailable',
          message: '响应没有 body',
          provider: 'openai_chat_completions',
          status: res.status,
        })
      }

      // `asResponse()` 返回时响应头已到达，正文 SSE 尚未开始。
      // 时刻取传输层观察到响应头的时刻，而非当前时刻。
      yield {
        type: 'response_started',
        headersAt: trace.headersAt!,
        ...(trace.hedge ? { hedge: trace.hedge } : {}),
      }

      let chunks = 0
      for await (const frame of readSse(res.body)) {
        // 收到终止标记即结束读取：读取器随即取消 body，不等待对端 FIN。
        if (frame.data === SSE_DONE) break
        const parsed = sseJson(frame.data)
        if (!parsed) continue
        // 本帧解析完成的时刻。带内容的事件统一使用该时刻，不由下游各自读取当前时刻。
        const at = Date.now()
        // 流内错误。SSE 已返回 200，错误只能出现在 chunk 中。
        const inlineError = parsed.error
        if (inlineError && typeof inlineError === 'object') {
          throw classifyStreamError(
            'openai_chat_completions',
            inlineError as Record<string, unknown>,
          )
        }
        const chunk = parsed as unknown as CompatChunk
        chunks++
        if (chunk.usage) applyUsage(usage, chunk.usage)

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta ?? {}

        // DeepSeek / Kimi 使用 reasoning_content，部分中转站使用 reasoning，两者均接收。
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'thinking_delta', delta: reasoning, at }
        }

        if (typeof delta.content === 'string' && delta.content) {
          const split = splitter.push(delta.content)
          if (split.thinking) yield { type: 'thinking_delta', delta: split.thinking, at }
          if (split.text) yield { type: 'text_delta', delta: split.text, at }
        }

        for (const tc of delta.tool_calls ?? []) {
          const idx: number = tc.index ?? 0
          let slot = partial.get(idx)
          if (!slot) {
            slot = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', json: '' }
            partial.set(idx, slot)
          }
          // 名字有时分片到达，须补齐；id 同理。
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          const argsDelta: string = tc.function?.arguments ?? ''
          if (argsDelta) {
            slot.json += argsDelta
            yield { type: 'tool_call_progress', at }
          }
        }

        if (choice.finish_reason) {
          rawFinish = String(choice.finish_reason)
          stopReason = normalizeFinishReason(choice.finish_reason)
        }
      }

      // 已累积但未遇到闭合标签的部分，原样作为正文输出。须在工具调用之前输出：
      // 该部分属于正文，顺序不能颠倒。
      const tail = splitter.flush()
      if (tail) yield { type: 'text_delta', delta: tail, at: Date.now() }

      const calls = collectToolCalls(partial, 'openai_chat_completions', req.model)
      if (calls.length) {
        // `max_tokens` 不得被覆盖。输出恰好在拼接工具参数的中途达到上限时，
        // 此处同时有 calls 与 'length'；无条件改为 tool_use 会丢失截断信号，
        // 上层因此以 JSON 解析失败的残缺参数照常执行工具，事后也无法看出
        // 发生过截断。截断优先：它决定该轮是否应继续，优先级高于「是否存在工具调用」。
        if (stopReason !== 'max_tokens') stopReason = 'tool_use'
        yield { type: 'tool_calls', calls, at: Date.now() }
      }

      /*
       * 没有任何 chunk 表示这不是一次模型答复，必须报错。
       *
       * 判据放在此处而不是上层：只有此处能确认「SSE 流为空」。
       * 离开本函数后，`usage` 与 `done` 会无条件 yield，上层统计事件数永远不为 0。
       *
       * 实测形状：Base URL 缺少 `/v1` 时，中转站对错误路径返回 200 与一个 HTML 首页，
       * 解析器读不出任何 chunk 且不抛错，该轮记为 0 token、0 步骤、`completed`，
       * 消息已发送而没有任何输出，账本中也无法查到原因。
       * `normalizeBaseUrl` 已消除该成因，但其他成因（反向代理丢弃流、
       * 网关返回空的 200）仍然存在，而静默失败比任何具体成因都严重。
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
       * 流已结束但从未收到 `finish_reason`，表示传输被截断，而非模型输出完毕。
       *
       * 判据是 `finish_reason` 而非 `[DONE]`：部分中转站不发送终止标记，以 `[DONE]` 为判据
       * 会将正常结束报告为断流。
       *
       * 协议要求最后一个 chunk 带 `finish_reason`，用量也在同一 chunk 中。
       * 两者同时缺失只有一个成因：连接在模型输出完毕之前中断。默认值 `end_turn`
       * 会将其记为正常完成，使思考中断的一轮被记为成功，
       * 账本上该轮为 0 token、无法对账，与 `chunks === 0` 属于同一类静默失败。
       *
       * 实测形状（2026-08-21，某中转端点）：带 tools 的长思考请求
       * 约一半次数在 reasoning 中途结束响应体，既没有 `finish_reason`
       * 也没有 `[DONE]`；同一请求的另一半次数正常结束。
       *
       * 记为传输失败而非 provider 拒绝：没有 HTTP 状态码，无法判断是否计费，
       * 因此已累积的 usage 随错误一并上报（见 `usage` 字段），账本行记为 `uncertain`
       * 但数值真实。该轮由 `agent/loop/attempt.ts` 自动重发（上限见 `MAX_RESENDS`）：正文未显示的
       * 原样重发，已显示的将正文作为上一条消息写入 transcript 后带当前上下文继续发送；额度用尽后
       * 用户得到一条说明「已收到多少、在何处断开」的错误，而不是一次虚假的成功。
       */
      if (!rawFinish) {
        throw new ProviderError({
          code: 'network_error',
          message: '流在 finish_reason 之前结束',
          provider: 'openai_chat_completions',
          detail: { model: req.model },
          // 用量 chunk 已到达而结束 chunk 未到达时附带真实值。`source` 仍为 `estimated`
          // 表示 provider 未回报任何用量，此时不附带，否则会将零作为真实值记入账本。
          ...(usage.source === 'provider' ? { usage } : {}),
        })
      }
    } catch (err) {
      throw classifyProviderError('openai_chat_completions', err, readTransport(trace))
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
      // 未收录的模型不申报上限，由端点使用自身的默认值；发送虚构的数值会导致静默截断。
      ...(cap === null ? {} : { max_tokens: cap }),
      ...(req.tools.length ? { tools: buildTools(req.tools, this.spec) } : {}),
      ...buildReasoning(this.spec, req.effort),
      /*
       * 缓存路由字段：此处只负责请求体中的 `prompt_cache_key`。
       *
       * 本仓库已有该字段（`ChatRequest.cacheKey`，即会话 id），`openai-responses`
       * 一直发送；deepseek 与各中转站均使用本路径。
       *
       * 不要将其视为解决缓存不命中的手段。2026-08-19 在某中转端点上做过配对交替
       * 实测（同一时间窗内逐轮交替发送有键与无键请求，
       * 各 12 轮）：无键 5/12 实际命中，有键 0/12；更换时间窗后结果相反。
       * 同一请求形状在相邻两分钟内给出 3008 / 192 / 字段缺失三种结果，
       * 该线路的缓存本身不确定，是否发送该键都无法改变。
       * 发送该键的理由只是「这是协议规定的做法，且在行为正常的端点上有效」，
       * 而不是「发送即命中」。
       *
       * 是否发送由目录中该模型的条目决定（`spec.cacheRouting`），而不是由协议决定，
       * 也不在此处固定。xAI 的 Chat Completions 明确使用 `x-grok-conv-id` 请求头，
       * 已在上方的请求选项分支发送；不得同时写入仅 Responses 使用的 body 字段。
       *
       * `qy probe` 有意不探测此项。探针只能发送少量请求观察命中情况，
       * 而上述实测说明：在不确定的线路上，少量请求给出的是随机结果。
       * 将探测到的「可用」写回目录，等于将一次偶然结果固化为结论：两次相同的小请求
       * 判定为 rolling，真实会话仍不命中。
       *
       * 未收录的模型取 `'none'`，不多发送任何字节：自建端点（ollama / vLLM）
       * 对未知字段的容忍度未经验证，而这些端点均属于未收录模型。
       */
      ...(req.cacheKey && this.spec.cacheRouting === 'prompt_cache_key'
        ? { prompt_cache_key: req.cacheKey }
        : {}),
    }
  }

  private async prepareDashScopeMedia(req: ChatRequest): Promise<ChatRequest> {
    return prepareDashScopeMedia(req, async (media) => {
      const key = `${req.model}\0${media.path}\0${media.size}\0${media.mtimeMs}`
      let uploaded = this.uploadedMedia.get(key)
      if (!uploaded) {
        uploaded = uploadDashScopeMedia({
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
          model: req.model,
          path: media.path,
          size: media.size,
          ...(req.signal ? { signal: req.signal } : {}),
        })
        this.uploadedMedia.set(key, uploaded)
        void uploaded.catch(() => this.uploadedMedia.delete(key))
      }
      return uploaded
    })
  }
}

/**
 * 将用户填写的 Base URL 归一为带版本段的 OpenAI 兼容根地址。
 *
 * 此处不是兼容代码，而是消除一个静默故障。实测形状：用户填写
 * `https://中转站/`（缺少 `/v1`），SDK 因此请求 `https://中转站/chat/completions`，
 * 而中转站对该错误路径返回 200 与 HTML 首页。SSE 解析器无法从 HTML 中
 * 解析出任何事件且不报错，该轮记为 0 token、0 步骤、`completed`，
 * 消息已发送而没有任何输出，账本中也无法查到原因。
 *
 * 补充 `/v1` 存在反例：部分兼容端点使用 `/v4` 等其他版本。版本段是用户明确
 * 提供的路由信息，不得覆盖，也不得拼接为 `/v4/v1`；仅在路径不含版本段
 * 时补充默认的 `/v1`。中转站将 API 部署在无版本路径（如 `/api`）时仍会补充默认版本，
 * 此时失败会明确报错（404 / 401），而非静默失败；两种错误的代价不对等。
 *
 * 空值使用官方根地址：`openai_responses` 一侧使用同一常量。
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const url = (raw ?? '').trim().replace(/\/+$/, '')
  if (!url) return 'https://api.openai.com/v1'
  return /\/v\d+(?:beta\d*)?(?:\/[^?#]*)?$/i.test(url) ? url : `${url}/v1`
}

/** Base64 编码使体积增加约三分之一，7 MB 的原文件编码后稳定低于百炼 10 MB 的 Data URL 上限。 */
export const DASHSCOPE_INLINE_SOURCE_BYTES = 7 * 1024 * 1024
/**
 * 对话中的本地视频超过该值时上传为 `oss://` 地址。
 *
 * 不要改用上方的 7 MB：那是端点可接受的内联上限，不是合适的阈值。内联的视频每次请求都完整重发，
 * 并按字节计入请求中的常驻媒体（`agent` 的 `MEDIA_RETAIN_HIGH_BYTES`），几段视频即会将其余图片挤出请求；
 * 上传为地址后请求中只保留一个地址，不占用该预算，视频得以一直保留在请求中。
 */
export const DASHSCOPE_CHAT_INLINE_BYTES = 2 * 1024 * 1024
/** 百炼临时文件服务的官方硬上限；模型或凭证仍可返回更小的动态上限。 */
const DASHSCOPE_TEMP_FILE_MAX_BYTES = 1024 * 1024 * 1024

export async function prepareDashScopeMedia(
  req: ChatRequest,
  upload: (media: { path: string; size: number; mtimeMs: number }) => Promise<string>,
): Promise<ChatRequest> {
  const messages = await Promise.all(
    req.messages.map(async (message) => {
      if (typeof message.content === 'string') return message
      const content = await Promise.all(
        message.content.map(async (block) => {
          if (block.type === 'text' || block.source.kind !== 'path') return block
          const info = await stat(block.source.path)
          if (info.size <= DASHSCOPE_CHAT_INLINE_BYTES) {
            const data = Buffer.from(await Bun.file(block.source.path).arrayBuffer()).toString(
              'base64',
            )
            return { ...block, source: { kind: 'base64' as const, data } }
          }
          const url = await upload({
            path: block.source.path,
            size: info.size,
            mtimeMs: info.mtimeMs,
          })
          return { ...block, source: { kind: 'url' as const, url } }
        }),
      )
      return { ...message, content }
    }),
  )
  return { ...req, messages }
}

export function isOpenCodeEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'opencode.ai'
  } catch {
    return false
  }
}

export function dashScopeMediaHeaders(enabled: boolean, req: ChatRequest): Record<string, string> {
  const hasUri = req.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          block.type !== 'text' &&
          block.source.kind === 'url' &&
          block.source.url.startsWith('oss://'),
      ),
  )
  return enabled && hasUri ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}
}

interface DashScopeUploadPolicy {
  policy: string
  signature: string
  upload_dir: string
  upload_host: string
  max_file_size_mb?: string | number
  oss_access_key_id: string
  x_oss_object_acl: string
  x_oss_forbid_overwrite: string
}

/** 保留部署路径前缀，仅去除百炼兼容接口或 API 版本后缀。 */
export function dashScopeBaseUrl(baseUrl?: string): string {
  const url = new URL(baseUrl?.trim() || 'https://dashscope.aliyuncs.com')
  const prefix = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:compatible-mode(?:\/v1)?|api\/v1|v1)$/, '')
  return `${url.origin}${prefix}`
}

export async function uploadDashScopeMedia(input: {
  apiKey: string
  baseUrl: string
  model: string
  path: string
  size: number
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<string> {
  if (input.size > DASHSCOPE_TEMP_FILE_MAX_BYTES) {
    throw new Error('媒体超过百炼临时文件协议的 1 GB 上限')
  }
  const send = input.fetcher ?? fetch
  const policyUrl = new URL(`${dashScopeBaseUrl(input.baseUrl)}/api/v1/uploads`)
  policyUrl.searchParams.set('action', 'getPolicy')
  policyUrl.searchParams.set('model', input.model)
  const policyResponse = await send(policyUrl, {
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!policyResponse.ok) throw await providerHttpError(policyResponse)
  const payload = (await policyResponse.json()) as { data?: Partial<DashScopeUploadPolicy> }
  const policy = payload.data
  if (!policy) throw new Error('百炼上传凭证响应缺少 data')
  const required = [
    'policy',
    'signature',
    'upload_dir',
    'upload_host',
    'oss_access_key_id',
    'x_oss_object_acl',
    'x_oss_forbid_overwrite',
  ] as const
  for (const field of required) {
    if (typeof policy[field] !== 'string' || !policy[field]) {
      throw new Error(`百炼上传凭证响应缺少 ${field}`)
    }
  }
  const ready = policy as DashScopeUploadPolicy
  const maxFileSizeMb = Number(ready.max_file_size_mb)
  if (
    Number.isFinite(maxFileSizeMb) &&
    maxFileSizeMb > 0 &&
    input.size > maxFileSizeMb * 1024 * 1024
  ) {
    throw new Error(`媒体超过百炼上传凭证允许的 ${maxFileSizeMb} MB`)
  }

  const uploadUrl = new URL(ready.upload_host)
  if (uploadUrl.protocol !== 'https:' || !uploadUrl.hostname.endsWith('.aliyuncs.com')) {
    throw new Error('百炼上传凭证返回了无效的 OSS 地址')
  }
  const key = `${ready.upload_dir}/${crypto.randomUUID().slice(0, 8)}-${basename(input.path)}`
  const form = new FormData()
  form.set('OSSAccessKeyId', ready.oss_access_key_id)
  form.set('Signature', ready.signature)
  form.set('policy', ready.policy)
  form.set('x-oss-object-acl', ready.x_oss_object_acl)
  form.set('x-oss-forbid-overwrite', ready.x_oss_forbid_overwrite)
  form.set('key', key)
  form.set('success_action_status', '200')
  form.set('file', Bun.file(input.path), basename(input.path))
  const uploadResponse = await send(uploadUrl, {
    method: 'POST',
    body: form,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!uploadResponse.ok) throw await providerHttpError(uploadResponse)
  return `oss://${key}`
}

async function providerHttpError(response: Response): Promise<Error> {
  const message = (await response.text().catch(() => '')).trim()
  return Object.assign(new Error(message || `HTTP ${response.status}`), {
    status: response.status,
    headers: response.headers,
  })
}

/**
 * 兼容协议下的思考控制字段。
 *
 * 是否发送由 `effortIsTransmittable` 一处裁决，此处只决定使用哪套字段。
 * 两处各自判定的实测后果：`transmits` 声明可以发送而此处按参数格式省略，
 * 探针因此恒为通过，将无依据的结论写回目录。
 *
 * 未知模型的 `thinking` 为 `'none'`，由上述检查排除，不会多发送任何字节；
 * 自建端点与中转站不会因本函数收到未知的键。
 *
 * DeepSeek 分支须同时发送两个字段：只发送 `reasoning_effort` 而不开启 `thinking` 时，
 * 思考未启动，档位不生效。
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
   * 不在该模型可用档位中的档位，不发送任何字节。
   *
   * 另两种协议的写法：`openai-responses` 为
   * `effortLevels.includes(req.effort) ? … : undefined`，`anthropic` 同样省略越界档位。
   * 本协议不要只判断「是否指定」就将 `effort` 原样发送。
   *
   * 档位选定值记录在「接口 × 模型」对应的配置中，同一模型更换协议后可用档位即变化
   * （不同协议的目录条目各自声明可用档位），
   * Agent Team 的各角色还各自使用不同的模型。越界值必须在此处拦截，
   * 否则 provider 会返回 400，而错误信息中只有 provider 的原文。
   *
   * 拦截而不降档：本仓库的目录没有「默认档位」的概念，代为选择档位属于推测。
   * 不发送时模型使用自身的默认值，与「未选择」的行为相同，结果可预期。
   */
  if (!spec.effortLevels.includes(effort as never)) return protocol
  return spec.thinking === 'deepseek_thinking'
    ? { thinking: { type: 'enabled' }, reasoning_effort: effort }
    : { ...protocol, reasoning_effort: effort }
}

function buildTools(tools: ToolSchema[], spec: ModelSpec) {
  // 与 Anthropic 路径相同，按名称排序：兼容端点的隐式前缀缓存同样受顺序变化影响。
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
 * 将本仓库编写的工具 schema 重排为 strict 形状。
 *
 * strict 使端点按 schema 约束采样，模型无法生成不符合形状的参数。OpenAI 协议对 strict
 * 有两条硬性要求：每个 object 都须设置 `additionalProperties: false`，且 `properties` 中
 * 每个键都须列入 `required`；可选参数通过在 `type` 中加入 `null` 表达。
 *
 * 缺少其中任一条即等于未开启。实测（2026-08-20，grok-4.6）：只添加 `strict: true`
 * 而保留可选属性时，端点不报错，静默降级为尽力而为，`offset` 仍返回字符串 `"1.0"`；
 * 两条均满足后三次采样均为整数。因此此处不能只发送标志位。
 *
 * 只用于 `ToolSchema.strict` 为真的工具（本仓库自行编写的工具）。第三方 schema 不转换，理由见该字段的注释。
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

/** 可选参数改为必填；类型与枚举均须允许 null，否则无关参数仍被迫取实际值。 */
function nullable(node: Record<string, unknown>): Record<string, unknown> {
  const type = node.type
  if (typeof type !== 'string' || type === 'null') return node
  return {
    ...node,
    type: [type, 'null'],
    ...(Array.isArray(node.enum) && !node.enum.includes(null)
      ? { enum: [...node.enum, null] }
      : {}),
  }
}

/*
 * ───────────────────────── 本协议的 wire 形状 ─────────────────────────
 *
 * 只声明本文件实际读取或写入的字段。兼容端点的字段集不统一
 * （`reasoning_content`、`prompt_cache_hit_tokens` 等均不在官方类型中），
 * 因此这些接口即「本文件识别的字段名」清单，接入新的中转站时在此修改。
 *
 * 定义放在本文件中，而不是提取为跨协议的 wire 模块：协议维度已有归属
 * （`ProviderKind` 的三个取值、一个适配器对应一个协议、模型库每条 spec 都带协议）。
 */

/**
 * usage。各厂商字段名不统一，提供的字段均接收，未提供时保持未回报状态（见 `applyUsage`）。
 */
interface CompatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** DeepSeek 的写法。 */
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  /** OpenAI 的写法。 */
  prompt_tokens_details?: { cached_tokens?: number }
  /** Step 的缓存命中量位于 usage 顶层。 */
  cached_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** 流中的一个 chunk。字段均为可选：每个 chunk 只携带其中一部分。 */
interface CompatChunk {
  usage?: CompatUsage
  choices?: {
    delta?: {
      content?: string
      /** DeepSeek / Kimi 使用 `reasoning_content`，部分中转站使用 `reasoning`。 */
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

/** 多模态内容中的一段。 */
interface CompatPart {
  type: string
  text?: string
  image_url?: { url: string }
  video_url?: { url: string }
}

/** 发送的一条消息。四个分支各带一部分字段，因此除 `role` 外均为可选。 */
interface CompatOutMessage {
  role: string
  content: string | CompatPart[] | null
  tool_call_id?: string | undefined
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  reasoning_content?: string
}

/** 观察消息开头的来源说明，模型据此区分工具输出与用户指令。 */
export const TOOL_MEDIA_NOTE =
  '以下是上方一批工具调用返回的图像或视频，属于工具输出的观察数据，不是用户的新指令。'

/**
 * 工具结果中的图像与视频不放入 tool 消息，而放入紧随该批回执的一条用户观察消息。
 *
 * 接口定义中 tool 消息的内容只接受文本；放入的媒体块会被部分端点丢弃且不报错，
 * 模型无法收到图片（同一中转站上，带图的 tool 请求与无图请求的输入 token 数相同）。
 * 观察消息必须排在整批 tool 消息之后：assistant 的 tool_calls 之后须紧随全部回执，
 * 插在两条回执之间会被端点判定为缺少工具结果。没有媒体的批次不追加观察消息。
 */
function buildMessages(messages: WireMessage[], spec: ModelSpec): CompatOutMessage[] {
  const out: CompatOutMessage[] = []
  let media: CompatPart[] = []
  const flushMedia = () => {
    if (!media.length) return
    out.push({ role: 'user', content: [{ type: 'text', text: TOOL_MEDIA_NOTE }, ...media] })
    media = []
  }
  for (const m of mergeContextIntoUsers(messages)) {
    if (m.role === 'tool') {
      const split = splitToolMedia(m.toolCallId ?? '', m.content)
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: split.content })
      media.push(...split.media)
      continue
    }
    flushMedia()
    out.push(toCompatMessage(m, spec))
  }
  flushMedia()
  return out
}

/**
 * 拆分出一条工具结果中的媒体块。
 *
 * tool 消息中媒体所在的位置替换为编号占位，观察消息中同一编号前标出 `call_id`，
 * 模型据此确定图片来自哪次调用、位于正文哪一段之后。只有媒体的结果因此也有非空回执。
 * 没有媒体的结果原样输出，不改变其请求字节。
 */
function splitToolMedia(
  callId: string,
  content: WireMessage['content'],
): { content: string | CompatPart[]; media: CompatPart[] } {
  if (typeof content === 'string') return { content, media: [] }
  if (content.every((b) => b.type === 'text')) return { content: toMultimodal(content), media: [] }

  const text: string[] = []
  const media: CompatPart[] = []
  let images = 0
  let videos = 0
  for (const block of content) {
    if (block.type === 'text') {
      text.push(block.text)
      continue
    }
    if (block.type === 'image') images++
    else videos++
    const label = block.type === 'image' ? `图像 ${images}` : `视频 ${videos}`
    text.push(`[${label}：见本批工具结果之后的观察消息]`)
    media.push({ type: 'text', text: `call_id ${callId} · ${label}` }, toPart(block))
  }
  return { content: text.join('\n'), media }
}

function toCompatMessage(
  m: ReturnType<typeof mergeContextIntoUsers>[number],
  spec: ModelSpec,
): CompatOutMessage {
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
       * 见文件头注释第 1 条：不回传该字段时，DeepSeek 思考模式的下一轮返回 400。
       *
       * 此处无条件发送，不查询目录的 `reasoningEcho`：该字段只用于 Responses 协议。
       * 两侧的不对称有依据：Responses 多发送的是一个条目，端点按 schema 直接拒绝
       * （`array too long. Expected an array with maximum length 0`）；本协议多发送的是
       * 一个字段，实测被忽略。改为查询目录反而会造成回归：中转站以自定义模型名提供
       * DeepSeek 时目录无法识别，结果从「无需配置即可使用」变为必然返回 400。
       *
       * 边界：`reasoningContent` 是会话历史的属性，而不是端点的属性。会话中途更换过接口时，
       * 此处发送的可能是另一个端点记录的思考内容。
       */
      ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
    }
  }
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : toMultimodal(m.content),
    ...(m.role === 'assistant' && m.reasoningContent && reasoningReplay(spec).text === 'all'
      ? { reasoning_content: m.reasoningContent }
      : {}),
  }
}

function toMultimodal(content: Exclude<WireMessage['content'], string>): CompatPart[] {
  return content.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : toPart(b)))
}

function toPart(b: Exclude<Exclude<WireMessage['content'], string>[number], { type: 'text' }>) {
  if (b.type === 'image') {
    return {
      type: 'image_url',
      image_url: {
        url:
          b.source.kind === 'url'
            ? b.source.url
            : `data:${b.mimeType};base64,${imageData(b.source)}`,
      },
    }
  }
  return {
    type: 'video_url',
    video_url: {
      url:
        b.source.kind === 'url' ? b.source.url : `data:${b.mimeType};base64,${videoData(b.source)}`,
    },
  }
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

// ───────────────────────── 正文中的思考标签 ─────────────────────────

const THINKING_OPEN = '<thinking>'
const THINKING_CLOSE = '</thinking>'

/**
 * 将正文通道开头的 `<thinking>…</thinking>` 块改判到思考通道。
 *
 * 这是中转站发送推理内容的第三种形式。前两种是字段名（`reasoning_content` / `reasoning`），
 * 此形式将推理摘要放入 `content` 并自行添加标签：实测 gpt-5.6-terra 经 OpenAI
 * 协议中转，一个 run 的 12 次调用中有 3 次如此发送，其余使用 `reasoning_content`。
 * 通道归属的权威是适配器，因此在此处识别；混入回答后再由下游清除，只是处理症状。
 *
 * 只识别一种形状：从本次调用正文的第 0 个字符开始、成对闭合、只识别一次。
 * 不要放宽。放宽会将模型正当输出的该字面量（例如模型在讨论这段代码）从正文中移除，
 * 造成静默的内容丢失。
 *
 * 不删除也不丢弃任何字节。识别出的整块送往思考通道；形状不匹配的原样送往正文；
 * 流在闭合之前结束时，已累积的部分连同起始标签一起原样作为正文输出。
 * 因此误判的最坏结果是显示在错误的区域，而不是内容丢失。
 *
 * 代价：块内内容累积到闭合标签后才输出，该段不是逐字显示。实测此类块为一行摘要，
 * 而流空闲上限的基准是 180 秒（`transport.ts` 的 `STREAM_IDLE_TIMEOUT_MS`），不会触及。
 * 此外空闲计时在传输层按字节计算，正文在本地累积不影响计时。
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
        // 尚不能判定是否为该起始标签，继续累积；累积上界为起始标签本身的长度。
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
 * 口径差异：OpenAI 兼容协议的 `prompt_tokens` 是包含缓存命中的总量
 * （DeepSeek 实测 `prompt_tokens = cache_hit + cache_miss`），而 Anthropic 的
 * `input_tokens` 是不含缓存的剩余量。两者都直接累加时，兼容协议一侧会将命中的
 * token 按全价重复计算，缓存命中率越高，账单偏差越大。
 *
 * 此处统一采用 Anthropic 的「排他」口径：inputTokens 只包含未命中部分。
 */
function applyUsage(acc: ProviderUsage, u: CompatUsage) {
  if (typeof u.completion_tokens === 'number') acc.outputTokens = u.completion_tokens

  // 各厂商字段名不统一：DeepSeek 是 prompt_cache_hit_tokens，OpenAI 是
  // prompt_tokens_details.cached_tokens，Step 是根级 cached_tokens；未回报保持 null。
  const details = u.prompt_tokens_details
  let cached: number | null = null
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    cached = u.prompt_cache_hit_tokens
  } else if (details && typeof details.cached_tokens === 'number') {
    cached = details.cached_tokens
  } else if (typeof u.cached_tokens === 'number') {
    cached = u.cached_tokens
  }
  if (cached !== null) acc.cachedTokens = cached

  if (typeof u.prompt_cache_miss_tokens === 'number') {
    // 供应商直接提供了未命中量，最为可靠。
    acc.inputTokens = u.prompt_cache_miss_tokens
  } else if (typeof u.prompt_tokens === 'number') {
    // 只有总量时自行相减。未回报缓存量时按全部未命中处理。
    acc.inputTokens = Math.max(0, u.prompt_tokens - (cached ?? 0))
  }
  const outDetails = u.completion_tokens_details
  if (outDetails && typeof outDetails.reasoning_tokens === 'number') {
    acc.reasoningTokens = outDetails.reasoning_tokens
  }
  acc.source = 'provider'
}
