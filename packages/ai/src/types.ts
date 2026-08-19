/**
 * Provider 无关的请求/事件类型。
 *
 * AgentLoop 只认识这一层；换供应商不改 loop 一行代码。
 */

// `ContextGroup` 的真源在 `core/domain/model.ts`。这里只转出去给 `_group` 用——
// 分组口径必须与事件协议同一个类型，各写一份就是这次要清理的那个历史。
import type { ContextGroup, EffortLevel } from '@qywork/core'
import type { ModelSpec, ProviderKind, SpecOverride } from './catalog.ts'

// ─────────────────────────────── 配置 ───────────────────────────────

/**
 * 三个适配器构造 SDK 客户端时共用的传输参数。**一份，不许各写各的。**
 *
 * 两个 SDK 的出厂值都是 `timeout: 600_000` + `maxRetries: 2`，在网络断掉时
 * 表现为「界面挂着『正在执行』五分钟，然后才报网络不可达」（实测：一次
 * 381.9s 的 run，最后一次模型回包之后干等了 301s）。
 *
 * - `timeout` 只覆盖到**响应头到达为止**（两个 SDK 都在 fetch 的 finally 里
 *   `clearTimeout`），所以 60 秒不会掐断一次长生成——它只掐「连不上」。
 *   **不要因为「怕打断长回答」把它调大**，那是在给一个它管不到的场景让路。
 * - `maxRetries: 0`：连不上时 SDK 自己重试两次，用户看到的就是三倍的等待，
 *   而这里从来不做自动重试——重发由人决定。
 */
export const PROVIDER_HTTP = { timeout: 60_000, maxRetries: 0 } as const

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
  /** 额外请求头，给需要特殊鉴权的中转站用。 */
  headers?: Record<string, string>
  /**
   * 模型库里这一条（窗口、上限、单价、思考档位）。**唯一的覆盖层**：
   * 目录 seed 之上只有它，`buildAdapter` 不再接第二条覆盖通道。
   *
   * 落盘按「模型 id × 协议」两维索引（`runtime` 的 `QyConfig.catalog`），
   * 因为同一个模型换条协议能力就不同；这里拿到的已经是选中的那一条。
   */
  spec?: SpecOverride
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

/**
 * 思考请求。**没有「关掉思考」这一档。**
 *
 * 关不关得掉是逐模型不同的产品事实（Fable 5、Grok、Kimi 都关不掉），而这个项目
 * 从来不需要关它——需要的是「这个模型能不能思考」和「档位字段怎么发」两件事。
 * 留一个关不掉的开关只会长出「关了没生效」和「关了就 400」两种坏法。
 */
export type ThinkingRequest =
  | { mode: 'adaptive'; display?: 'summarized' | 'omitted' }
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
  /**
   * 可折单元的戳记，形如 `<runId>:<定宽 seq>`。**同一个执行波次的
   * assistant 消息与它的全部 tool 结果共用一个戳**——压缩按戳切界，
   * 共戳即同进同出，tool_call 与 tool_result 因此永远不会被切开。
   *
   * 与 `_messageId` 合起来才是完整位置：先比消息 id，同一条消息内再比戳。
   */
  _step?: string
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
   * **独立字段，不要往 `arguments` 里塞魔法键**：各 provider 各塞各的写法，
   * 而没有任何消费者认得它们，工具照样拿着垃圾参数执行。
   * 一个名字、一处判断，消费者在 `AgentLoop` 里。
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
  | { type: 'request_prepared'; measuredInputTokens: number }
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
}
