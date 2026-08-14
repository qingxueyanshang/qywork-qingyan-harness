/**
 * Provider 无关的请求/事件类型。
 *
 * AgentLoop 只认识这一层；换供应商不改 loop 一行代码。
 */

// `ContextGroup` 的真源在 `core/domain/model.ts`。这里只转出去给 `_group` 用——
// 分组口径必须与事件协议同一个类型，各写一份就是这次要清理的那个历史。
import type { ContextGroup, EffortLevel } from '@qywork/core'
import type { ModelSpec, ProviderKind } from './catalog.ts'

// ─────────────────────────────── 配置 ───────────────────────────────

export interface ProviderProfile {
  kind: ProviderKind
  /**
   * 只有 baseUrl 指向本机回环时才允许为空（本地模型服务不需要鉴权）。
   * 其余情况下 `buildAdapter` 直接抛 `no_api_key`——不发请求去等 401。
   */
  apiKey: string
  /** 自定义端点（中转站、自建网关、ollama）。 */
  baseUrl?: string
  model: string
  maxOutputTokens?: number
  /** 额外请求头，给需要特殊鉴权的中转站用。 */
  headers?: Record<string, string>
  /**
   * 实测出来的能力覆盖（`qy probe` 写入）。
   *
   * 只覆盖**探得出来的**几项。上下文窗口和计价探不出来，所以这里没有它们——
   * 写一个猜的值进去，会把「未知计价」变成一个看起来确定的错数字。
   */
  capabilities?: {
    thinking?: ModelSpec['thinking']
    effortLevels?: ModelSpec['effortLevels']
    thinksByDefault?: boolean
  }
}

// ─────────────────────────────── 请求 ───────────────────────────────

export interface ChatRequest {
  model: string
  /** 冻结前缀：跨 run 逐字节稳定。日期/技能/记忆一律不进这里。 */
  system: SystemBlock[]
  messages: WireMessage[]
  tools: ToolSchema[]
  maxOutputTokens: number
  effort?: EffortLevel
  thinking?: ThinkingRequest
  /** 缓存路由亲和键；同一会话稳定。 */
  cacheKey?: string
  signal?: AbortSignal
}

export interface SystemBlock {
  text: string
  /** true = 在这里放一个缓存断点。 */
  cacheBreakpoint?: boolean
}

export type ThinkingRequest =
  | { mode: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { mode: 'disabled' }
  | { mode: 'budget'; budgetTokens: number }

export interface WireMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
  /** assistant 轮携带的工具调用。 */
  toolCalls?: WireToolCall[]
  /** role='tool' 时对应的调用 id。 */
  toolCallId?: string
  /**
   * DeepSeek 等 OpenAI 兼容供应商在思考模式下要求带 tool_calls 的 assistant 消息
   * 原样回传 reasoning_content，否则后续轮次 400。Anthropic 路径不需要。
   */
  reasoningContent?: string
  /**
   * 缓存断点：**从请求开头到这条消息为止**的字节被 provider 缓存。
   *
   * 这是**协议差异，不是行为分支**：Anthropic 要显式划线
   * （`cache_control`），而兼容协议的前缀缓存由服务端自动做、请求体里
   * 根本没有这个位置。装配层无条件标注，各适配器自己决定要不要落到线上——
   * 与 `reasoningContent`、`transmits` 是同一个形状。
   *
   * 标在哪由「这一段跨请求是不是逐字节稳定」决定，见 `agent/loop.ts` 的装配。
   */
  cacheBreakpoint?: boolean
  /** 内部记账用，绝不上线。 */
  _group?: ContextGroup
  _messageId?: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'document'; mimeType: string; data: string; title?: string }

export interface WireToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /**
   * 参数 JSON 没解析出来时的**原文**。
   *
   * 曾经三个 provider 各自往 `arguments` 里塞一个魔法键（`__malformed_arguments`
   * 与 `_malformed` 两套写法），而**没有任何消费者认得它们**——注释里写的
   * 「上层会把它记成一次失败的工具调用」那个上层不存在，工具照样拿着垃圾参数执行。
   * 改成独立字段：一个名字、一处判断，消费者在 `AgentLoop` 里。
   */
  argumentsError?: string
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object。序列化必须确定性（键排序），否则前缀缓存永远不命中。 */
  parameters: Record<string, unknown>
  /** 声明但先不载入上下文，等 tool_addition 再浮出。 */
  deferLoading?: boolean
}

// ─────────────────────────────── 流式事件 ───────────────────────────────

export type ProviderEvent =
  | { type: 'request_prepared'; measuredInputTokens: number; exact: boolean }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_calls'; calls: WireToolCall[] }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done'; stopReason: ProviderStopReason; refusal?: RefusalDetail }

export type ProviderStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal'

export interface RefusalDetail {
  /** 开放集合：cyber / bio / reasoning_extraction / frontier_llm / null。 */
  category: string | null
  explanation?: string
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  /** null = provider 未回报，与真实 0 命中不是一回事，绝不混同。 */
  cachedTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number
  /** 是模型真回报还是本地估算。 */
  source: 'provider' | 'estimated'
}

// ─────────────────────────────── 适配器 ───────────────────────────────

export interface LlmAdapter {
  readonly kind: ProviderKind
  readonly spec: ModelSpec
  /**
   * 本适配器**实际会发送**哪些可选轴。
   *
   * 探测器靠它区分「端点接受了」和「我们压根没发」。没有这个声明的话，
   * 一个根本不传 thinking 的协议会让每一个探针都「通过」，
   * 于是探测报告说「支持思考」——而那是把没验过的说成验过了。
   *
   * **必须按 `spec` 算，不能是类级常量。** 协议支持不等于这条模型会发：
   * 未收录的模型 `thinking='none'`、`effortLevels=[]`，三个适配器在装配期就把
   * 这两个字段整个省掉，请求里一个字节都没有——此时若声明成 true，
   * 每个探针都会「通过」，`--save` 再把这份凭空的结论覆盖回目录。
   */
  readonly transmits: { thinking: boolean; effort: boolean }
  stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown>
  /** 不开网络请求，测量 provider-native prompt 的 token 数。 */
  measure(req: ChatRequest): Promise<number>
}
