/**
 * Anthropic 原生适配器。
 *
 * 使用官方 SDK（@anthropic-ai/sdk）构造请求：鉴权头、beta 头与地址归一由 SDK 负责，
 * 自行实现会重复 SDK 的工作，且须随协议演进持续维护。超时与重试由本适配器指定
 * （`PROVIDER_HTTP`），不使用 SDK 的默认值。响应体由本地读取器解析（`../sse.ts`）：
 * 协议终态到达即交付并取消 body，不等待 HTTP EOF。
 *
 * 本层负责将 ChatRequest 的通用形状转换为 provider 原生形状，并在装配期排除
 * 会返回 400 的参数组合，而不是发送后收到错误再做回退处理：
 *
 * 1. 采样参数（temperature/top_p/top_k）在 Claude 5 系一律返回 400 → 不提供入口。
 * 2. `budget_tokens` 在 Opus 5 / Sonnet 5 / Fable 5 系 / Opus 4.7+ 一律返回 400 → 按 spec.thinking 分派。
 * 3. Fable 5 系思考恒开，连 `{type:'disabled'}` 也返回 400 → 省略 thinking 字段。
 * 4. Opus 5 关闭思考时 effort 最高只允许 high，搭配 xhigh/max 会返回 400 → 只发送目录声明的档位
 *    （`resolveEffort`），越界时省略字段。
 * 5. Opus 5 / Sonnet 5 省略 thinking 时仍会思考，而 max_tokens 同时限制思考与正文
 *    → 按 thinksByDefault 提高输出预算下限，否则回答会在中途被截断。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { EffortLevel } from '@qywork/core'
import {
  effortIsTransmittable,
  type ModelSpec,
  type ReasoningReplay,
  reasoningReplay,
} from '../catalog.ts'
import { classifyProviderError, classifyStreamError, ProviderError } from '../errors.ts'
import { readSse, sseJson } from '../sse.ts'
import {
  estimateMessage,
  estimateRequest,
  estimateSchemas,
  estimateText,
  type TokenDensity,
} from '../tokens.ts'
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
import { collectToolCalls } from './tool-calls.ts'

/**
 * 思考开启时为输出预留的最小预算。低于该值时，思考稍长即会耗尽正文的预算，
 * 回答在中途截断且没有明确的错误。
 */
const MIN_TOKENS_WHEN_THINKING = 16_000

/**
 * 各方均未申报上限时，本协议自行填入的默认值。
 *
 * 本协议的 `max_tokens` 为必填字段，无法像另两条协议那样省略该字段。
 * 取 64K 是 Anthropic 系当前的普遍上限；端点实际上限更低时，返回的是带原文的 400，而不是静默截断。
 *
 * 仅用于未收录模型。已知确切上限时，在模型库的对应字段填写 `maxOutputTokens`。
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
      // 允许以空 key 构造：BYOK 模式下用户可能尚未配置 key，此时界面仍须能够启动。
      // 缺少 key 的错误在首次发送请求时抛出，由 classifyProviderError 归类为
      // no_api_key，前端据此引导用户前往设置页。
      apiKey: profile.apiKey || 'unset',
      ...PROVIDER_HTTP,
      ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
      defaultHeaders: { ...PROVIDER_HEADERS, ...profile.headers },
    })
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body = this.buildBody(req)

    // 此数值是字符估算，不是实测：Anthropic 提供 count_tokens，但热路径不调用它，
    // 因为每轮会多一次往返，而上下文读数在首次回报之后即以 provider 的真实值为准。
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
    // provider 返回的原值，只记入账本，不参与判断。空串表示流在终态之前中断。
    let rawStop = ''
    let thinkingObserved = false
    let refusal: { category: string | null; explanation?: string } | undefined

    // 累积工具调用：参数按 input_json_delta 分片到达，须自行拼接为 JSON。
    const partial = new Map<number, { id: string; name: string; json: string }>()
    // 原生思考块（含签名）与全部块的先后顺序：回放要求原样、原位。
    const thinking = new Map<number, AnthropicBlock>()
    const order: { index: number; type: string; id?: string }[] = []
    /** 是否已收到 `message_stop`。未收到表示传输被截断，而非模型输出完毕。 */
    let settled = false

    const trace = newTrace()

    try {
      /*
       * 使用 SDK 构造请求、鉴权与 beta 头，响应体由本地读取。
       *
       * `asResponse()` 返回原始 `Response`，SSE 由共用读取器解析。不要改为
       * `messages.stream()` + `finalMessage()`：该方式须读到 HTTP EOF 才 resolve，
       * 对端发送 `message_stop` 后不关闭连接时，工具调用与用量将无法交付。
       */
      const res = await this.client
        .withOptions({ fetch: traceFetch(trace, 'anthropic_messages', req.idleTimeoutMs) })
        .messages.create(
          { ...body, stream: true } as never,
          req.signal ? { signal: req.signal } : {},
        )
        .asResponse()

      if (!res.body) {
        throw new ProviderError({
          code: 'provider_unavailable',
          message: '响应没有 body',
          provider: 'anthropic_messages',
          status: res.status,
        })
      }

      // `asResponse()` 返回时响应头已到达，早于 `message_start`。
      yield {
        type: 'response_started',
        headersAt: trace.headersAt!,
        ...(trace.hedge ? { hedge: trace.hedge } : {}),
      }

      for await (const frame of readSse(res.body)) {
        const parsed = sseJson(frame.data)
        if (!parsed) continue
        // 本帧解析完成的时刻。带内容的事件统一使用该时刻，不由下游各自读取当前时刻。
        const at = Date.now()
        // 事件名在 `event:` 行与 JSON 体的 `type` 中重复出现，中转站不一定两者都发送。
        const ev = parsed as unknown as AnthropicStreamEvent
        const type = typeof ev.type === 'string' && ev.type ? ev.type : (frame.event ?? '')
        switch (type) {
          case 'message_start': {
            const u = ev.message?.usage
            if (u) applyUsage(usage, u)
            break
          }
          case 'content_block_start': {
            const block = ev.content_block
            order.push({
              index: ev.index,
              type: block?.type ?? '',
              ...(block?.id ? { id: block.id } : {}),
            })
            if (block?.type === 'thinking') {
              thinkingObserved = true
              thinking.set(ev.index, {
                type: 'thinking',
                thinking: block.thinking ?? '',
                signature: block.signature ?? '',
              })
            } else if (block?.type === 'redacted_thinking') {
              thinkingObserved = true
              thinking.set(ev.index, { type: 'redacted_thinking', data: block.data ?? '' })
            }
            if (block?.type === 'tool_use') {
              // 缺失时按空串处理：名字为空由 `collectToolCalls` 的 `!slot.name` 分支统一报错，
              // 该分支是「工具调用没有名字」的唯一判定点，此处不再重复判定。
              partial.set(ev.index, { id: block.id ?? '', name: block.name ?? '', json: '' })
            }
            break
          }
          case 'content_block_delta': {
            const d = ev.delta
            if (d?.type === 'text_delta') {
              // 与 `input_json_delta` 相同：缺失时按空串处理，直接透传 undefined 会使
              // 字符串 `undefined` 进入正文。
              yield { type: 'text_delta', delta: d.text ?? '', at }
            } else if (d?.type === 'thinking_delta') {
              // display:'omitted'（默认）时此处为空串：思考仍会发生并计费，
              // 只是不回传内容。不要据此判定「模型未思考」。
              const block = thinking.get(ev.index)
              if (block && d.thinking) block.thinking = `${block.thinking ?? ''}${d.thinking}`
              if (d.thinking) yield { type: 'thinking_delta', delta: d.thinking, at }
            } else if (d?.type === 'signature_delta') {
              const block = thinking.get(ev.index)
              if (block && d.signature) block.signature = `${block.signature ?? ''}${d.signature}`
            } else if (d?.type === 'input_json_delta') {
              const slot = partial.get(ev.index)
              // 必须处理字段缺失：直接拼接会将字符串 `undefined` 写入 JSON，
              // 随后 `JSON.parse` 抛错，整次工具调用的参数将丢失。
              if (slot && d.partial_json) {
                slot.json += d.partial_json
                yield { type: 'tool_call_progress', at }
              }
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
            // stop_details 仅在 refusal 时非空，其余 stop_reason 下恒为 null；
            // 必须先检查 stop_reason 再读取 stop_details，顺序颠倒会漏判。
            if (raw === 'refusal' && ev.delta?.stop_details) {
              // 在 `exactOptionalPropertyTypes` 下，键不存在与键值为 undefined 含义不同，
              // 因此按值是否存在决定是否添加该键（与 `store` 的 `rowToWorkspace` 相同）。
              refusal = {
                category: ev.delta.stop_details.category ?? null,
                ...(ev.delta.stop_details.explanation === undefined
                  ? {}
                  : { explanation: ev.delta.stop_details.explanation }),
              }
            }
            break
          }
          case 'message_stop':
            // 收到终态即结束读取：读取器随即取消 body，不等待对端 FIN。
            settled = true
            break
          case 'error':
            throw classifyStreamError(
              'anthropic_messages',
              (parsed.error as Record<string, unknown>) ?? parsed,
            )
          default:
            break
        }
        if (settled) break
      }

      /*
       * 流已结束但未收到 `message_stop`，表示传输被截断，而非模型输出完毕。
       *
       * 默认值 `end_turn` 会将连接中断记为正常完成，使输出中断的一轮被记为成功，
       * 该轮读数无法对账。此处记为传输失败而非 provider 拒绝：没有 HTTP 状态码，
       * 无法判断是否计费，账本行因此记为 `uncertain`。
       */
      if (!settled) {
        throw new ProviderError({
          code: 'network_error',
          message: '流在 message_stop 之前结束',
          provider: 'anthropic_messages',
          detail: { model: req.model },
          // `message_start` 已回报输入用量时附带真实值。`source` 仍为 `estimated`
          // 表示 provider 未回报任何用量，此时不附带，否则会将零作为真实值记入账本。
          ...(usage.source === 'provider' ? { usage } : {}),
        })
      }

      const calls = collectToolCalls(partial, 'anthropic_messages', req.model)
      const items = nativeThinking(order, thinking)
      if (items.length) {
        yield {
          type: 'response_reasoning',
          reasoning: {
            items,
            // 未回报时按思考正文估算；签名中还包含加密的完整推理，因此该估算值只会偏低。
            tokens:
              usage.source === 'provider' && usage.reasoningTokens > 0
                ? usage.reasoningTokens
                : items.reduce(
                    (n, b) => n + estimateText(String(b.thinking ?? ''), this.spec.density),
                    0,
                  ),
          },
          at: Date.now(),
        }
      }
      if (calls.length) yield { type: 'tool_calls', calls, at: Date.now() }
    } catch (err) {
      throw classifyProviderError('anthropic_messages', err, readTransport(trace))
    }

    yield { type: 'usage', usage }
    yield {
      type: 'done',
      stopReason,
      rawStopReason: rawStop,
      ...(refusal ? { refusal } : {}),
      ...(thinkingObserved ? { thinkingObserved: true } : {}),
    }
  }

  // ───────────────────────── 装配 ─────────────────────────

  private buildBody(req: ChatRequest) {
    const thinking = this.resolveThinking()
    const effort = this.resolveEffort(req)

    return {
      model: req.model,
      max_tokens: this.resolveMaxTokens(req, thinking),
      system: buildSystem(req),
      // 断点的前缀长度从工具 schema 与系统提示词算起，二者排在消息之前。
      messages: buildMessages(
        req.messages,
        this.spec.density,
        this.spec.minCacheablePrefix,
        estimateSchemas(req.tools, this.spec.density) +
          req.system.reduce((n, b) => n + estimateText(b.text, this.spec.density), 0),
        reasoningReplay(this.spec),
      ),
      tools: buildTools(req.tools),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // 此处不发送 temperature / top_p / top_k：Claude 5 系收到即返回 400，
      // 风格引导应写入 system prompt。
    }
  }

  /**
   * 思考配置。返回 undefined 表示省略整个 thinking 字段：这是 Fable 5 系唯一
   * 合法的写法，对 Opus 5 / Sonnet 5 则等价于 adaptive（二者默认思考）。
   *
   * 只按 `spec.thinking` 分派：调用方不指定思考形态，强度经由 `output_config.effort`
   * 传递。不要改为从请求中读取形态：`budget_tokens` 旧形态在 Opus 5 /
   * Sonnet 5 上一律返回 400。
   */
  private resolveThinking() {
    // adaptive_only 以外的取值（always_on / budget_tokens / none）一律省略：
    // 思考恒开的模型收到任何显式配置都返回 400，本项目不请求旧形态。
    if (this.spec.thinking !== 'adaptive_only') return undefined
    return { type: 'adaptive' as const, display: 'summarized' as const }
  }

  /**
   * effort 档位只接受该模型明确支持的值。越界时省略字段，由模型使用默认值，
   * 不得为使请求通过而静默替用户换为另一档。
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
   * max_tokens 是思考与正文的合计上限，不只是正文的上限。Opus 5 / Sonnet 5 省略
   * thinking 时仍会思考，按「不思考」口径调小的 max_tokens 会使回答在中途截断，
   * 且不报错，只返回 stop_reason='max_tokens'。此处按 thinksByDefault 提高下限，
   * 避免此类静默截断。
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
 * 按名称排序：渲染顺序是 tools → system → messages，工具排在最前，
 * 工具数组的任何顺序变化都会使整个前缀缓存失效。在 Set 或对象迭代顺序不稳定的
 * 语言中，这是常见的静默失效原因。
 *
 * 不要在此处发送 `strict`。本协议的 strict 不要求全部属性列入 `required`，
 * 本仓库的 schema 已经符合要求，因此同时开启看似没有成本。实测（2026-08-20，
 * 经中转站调用 claude-opus-5）没有收益：发送与不发送各采样五次，参数均正确；
 * 但有代价：同一路径上一次返回了 schema 中不存在的键，另一次对不合格的
 * strict schema 返回 HTTP 500 而非 400。OpenAI 的两条协议发送该字段，因为在那里
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
 * ───────────────────────── 本协议的 wire 形状 ─────────────────────────
 *
 * 只声明本文件实际读取或写入的字段。协议提供的字段远多于此，未列出的字段本文件不依赖；
 * 因此这些接口同时是「更换中转站时，对端至少须提供的字段」清单。
 *
 * 定义放在本文件中，而不是提取为跨协议的 wire 模块：协议维度已有归属
 * （`ProviderKind` 的三个取值、一个适配器对应一个协议、模型库每条 spec 都带协议），
 * 另建登记表会形成第二处声明协议维度的位置。各协议由各自的适配器描述。
 */

/** usage 的四个数值。每个都可能缺失，缺失与 0 含义不同（见 `applyUsage`）。 */
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** 思考 token 是 `output_tokens` 的一部分，此处单独列出。 */
  output_tokens_details?: { thinking_tokens?: number }
}

/**
 * 流事件。定义为带可选字段的接口而不是判别联合：读取时先 `switch (ev.type)`，
 * 再逐个以 `?.` 取值，联合类型在此处只会使每个分支都多一次断言。
 *
 * `index` 定义为必填：只有 `content_block_*` 两个分支读取它，而这两种事件必定携带该字段。
 */
interface AnthropicStreamEvent {
  type: string
  index: number
  message?: { usage?: AnthropicUsage }
  content_block?: {
    type?: string
    id?: string
    name?: string
    thinking?: string
    signature?: string
    data?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
    stop_details?: { category?: string | null; explanation?: string } | null
  }
  usage?: AnthropicUsage
}

/** 内容块。每个块只属于其中一种类型，因此字段均为可选。 */
export interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  /** `redacted_thinking` 的密文。 */
  data?: string
  /** 装配时可能缺失（`WireMessage.toolCallId` 可选），JSON 中的 undefined 等同于不带该键。 */
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
 * 发送的一条消息。
 *
 * `_toolBatch` 不是协议字段，而是「同一轮的多个工具结果须合并为同一条 user 消息」时使用的
 * 内部标记，发送前必须删除；保留会使其进入请求体，破坏缓存前缀。
 */
export interface AnthropicOutMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
  _toolBatch?: boolean
}

/**
 * 消息形状转换，同时设置缓存断点。
 *
 * `minPrefix` 是该模型可缓存的最短前缀（因模型而异：512 / 1024 / 2048 / 4096）。
 * 前缀短于该值时设置断点不会报错，但断点不生效，仍会记一次缓存写入，
 * 账面上多出一笔费用而没有节省。因此在此处过滤，不发送无效断点。
 *
 * `prefixTokens` 是消息之前部分（工具 schema 与系统提示词）的 token 量，
 * 断点的前缀长度从该值算起。
 *
 * 返回值在末尾整体断言为 SDK 类型：形状按 role 动态分支拼接（尤其是
 * tool_result 须跨消息合并），逐条满足 SDK 的判别联合会使代码难以阅读。
 * 断言只在这一个出口，形状正确性由下方的分支逻辑保证。
 */
function buildMessages(
  messages: WireMessage[],
  density: TokenDensity,
  minPrefix: number,
  prefixTokens: number,
  replay: ReasoningReplay,
): Anthropic.MessageParam[] {
  const out: AnthropicOutMessage[] = []
  // 设置断点的输出消息下标。工具结果会被合并为同一条 user 消息，
  // 输入下标与输出下标不是一一对应，因此只能在遍历时记录。
  const marks: number[] = []
  let running = prefixTokens
  for (const m of mergeContextIntoUsers(messages)) {
    running += estimateMessage(m, density)
    if (m.role === 'tool') {
      // Anthropic 的工具结果是 user 轮中的 tool_result block。
      // 同一轮的多个结果必须合并为一条 user 消息；拆成多条会使模型
      // 倾向于不再并行调用工具。
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

    if (m.role === 'assistant') {
      const content = assistantBlocks(m, replay)
      // 没有思考块也没有工具调用的纯文本轮保持字符串形态，已有会话的请求字节不变。
      const plain = content.every((b) => b.type === 'text') && !m.toolCalls?.length
      out.push({
        role: 'assistant',
        content: plain && typeof m.content === 'string' ? m.content : content,
      })
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
    // `cache_control` 只能设置在内容块上，字符串正文须先转换为块。
    if (typeof entry.content === 'string') {
      entry.content = [{ type: 'text', text: entry.content }]
    }
    // 思考块不接受 `cache_control`，断点设置在最后一个非思考块上。
    const last = entry.content.findLast(
      (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
    )
    if (last) last.cache_control = { type: 'ephemeral' as const }
  }
  // 清除仅用于合并的内部标记，避免其进入请求体并破坏缓存前缀。
  for (const m of out) delete m._toolBatch
  return out as unknown as Anthropic.MessageParam[]
}

/**
 * assistant 消息的内容块。
 *
 * 有原生思考块时按采集时记录的位置插回：本仓库将正文合并为一段、排在全部工具调用之前，
 * 因此锚定正文的块排在正文前，锚定某个工具调用的块排在该 `tool_use` 前，
 * 原本位于末尾的块排在最后。签名对轮内位置敏感，不要改为统一排在最前。
 *
 * 锚定的工具调用已不在消息中（`max_tokens` 截断后整批丢弃）时，该块排在末尾照常回放，
 * 其后的思考块全部不回放：签名绑定块之前的内容，去掉该调用只改变其后各块的前缀，
 * 从末尾去掉的块不影响前面的块。不要改为将该块一并丢弃：续写时模型会失去截断前的全部思考。
 *
 * 边界：同一次响应中正文被思考块分隔为两段时，两段合并后无法恢复原顺序。
 */
function assistantBlocks(m: WireMessage, replay: ReasoningReplay): AnthropicBlock[] {
  const text: AnthropicBlock[] =
    typeof m.content === 'string'
      ? m.content
        ? [{ type: 'text', text: m.content }]
        : []
      : toBlocks(m.content)
  const calls: AnthropicBlock[] = (m.toolCalls ?? []).map((c) => ({
    type: 'tool_use',
    id: c.id,
    name: c.name,
    input: c.arguments,
  }))
  const native = replay.opaque ? (m.responseReasoning?.items ?? []) : []
  if (!native.length) {
    const thought: AnthropicBlock[] =
      replay.text !== 'none' && m.reasoningContent
        ? [{ type: 'thinking', thinking: m.reasoningContent }]
        : []
    return [...thought, ...text, ...calls]
  }
  const block = ({ beforeText: _t, beforeToolUse: _u, ...rest }: Record<string, unknown>) =>
    rest as unknown as AnthropicBlock
  const present = new Set((m.toolCalls ?? []).map((c) => c.id))
  const orphan = native.findIndex(
    (b) => typeof b.beforeToolUse === 'string' && !present.has(b.beforeToolUse),
  )
  const kept = orphan < 0 ? native : native.slice(0, orphan + 1)
  const out = kept.filter((b) => b.beforeText === true).map(block)
  out.push(...text)
  for (const call of calls) {
    out.push(...kept.filter((b) => b.beforeToolUse === call.id).map(block), call)
  }
  out.push(
    ...kept
      .filter(
        (b) =>
          b.beforeText !== true &&
          (b.beforeToolUse === undefined || !present.has(b.beforeToolUse as string)),
      )
      .map(block),
  )
  return out
}

/**
 * 一次响应中可回放的原生思考块，按出现顺序排列，各自以紧随其后的非思考块作为位置锚
 * （正文记为 `beforeText`，工具调用记为 `beforeToolUse`，位于末尾的块不记录）。
 * 签名不完整的思考块不收录：provider 不接受无签名的块。
 */
function nativeThinking(
  order: readonly { index: number; type: string; id?: string }[],
  blocks: ReadonlyMap<number, AnthropicBlock>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  order.forEach((entry, i) => {
    const block = blocks.get(entry.index)
    if (!block || (block.type === 'thinking' && !block.signature)) return
    const next = order
      .slice(i + 1)
      .find((o) => o.type !== 'thinking' && o.type !== 'redacted_thinking')
    out.push({
      ...block,
      ...(next?.type === 'text' ? { beforeText: true } : {}),
      ...(next?.type === 'tool_use' && next.id ? { beforeToolUse: next.id } : {}),
    })
  })
  return out
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
 * `cachedTokens` 以 null 表示「provider 未回报」，与真实的 0 命中严格区分。
 * 两者混为 0 会使「缓存从未生效」与「缓存生效但未命中」无法区分，误导缓存问题的排查。
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
  if (typeof u.output_tokens_details?.thinking_tokens === 'number') {
    acc.reasoningTokens = u.output_tokens_details.thinking_tokens
  }
  acc.source = 'provider'
}
