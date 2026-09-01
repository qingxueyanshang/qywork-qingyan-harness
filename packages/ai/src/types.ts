/**
 * Provider 无关的请求/事件类型。
 *
 * AgentLoop 只认识这一层；换供应商不改 loop 一行代码。
 */

// `ContextGroup` 的真源在 `core/domain/model.ts`。这里只转出去给 `_group` 用——
// 分组口径必须与事件协议同一个类型，各写一份就是这次要清理的那个历史。
import type { ContextGroup, EffortLevel, ProviderKind } from '@qywork/core'
import type { ModelSpec, SpecOverride } from './catalog.ts'

// ─────────────────────────────── 配置 ───────────────────────────────

/**
 * 三个适配器构造 SDK 客户端时共用的传输参数。**一份，不许各写各的。**
 *
 * 两个 SDK 的出厂值都是 `timeout: 600_000` + `maxRetries: 2`，在网络断掉时
 * 表现为「界面挂着『正在执行』五分钟，然后才报网络不可达」（实测：一次
 * 381.9s 的 run，最后一次模型回包之后空等了 301s）。
 *
 * - `timeout` 只覆盖到**响应头到达为止**（两个 SDK 都在 fetch 的 finally 里
 *   `clearTimeout`），所以 60 秒不会掐断一次长生成——它只掐「连不上」。
 *   **不要因为「怕打断长回答」把它调大**，那是在给一个它管不到的场景让路。
 * - `maxRetries: 0`：连不上时 SDK 自己重试两次，用户看到的就是三倍的等待，
 *   而这里从来不做自动重试——重发由人决定。
 */
export const PROVIDER_HTTP = { timeout: 60_000, maxRetries: 0 } as const

/**
 * 具体接口路线的传输能力。模型有哪些档位由官方目录回答；这里仅回答当前端点
 * 是否透传相应控制面。undefined = 未校准，沿用协议/目录结论。
 */
export interface TransportCapabilities {
  effort?: boolean
}

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
  /** 当前「接口 × 模型」的传输校准，不写进全局模型目录。 */
  transport?: TransportCapabilities
}

// ─────────────────────────────── 请求 ───────────────────────────────

export interface ChatRequest {
  model: string
  /** 冻结前缀：跨 run 逐字节稳定。日期/技能/记忆一律不进这里。 */
  system: SystemBlock[]
  messages: WireMessage[]
  tools: ToolSchema[]
  /**
   * 这一次申报的输出上限。**`null` = 不申报，由端点用自己的默认。**
   *
   * 不是「这个模型最多能输出多少」——兼容协议按 `输入 + max_tokens ≤ 窗口` 校验，
   * 所以它回答的是「这一轮还装得下多少输出」（`agent` 的 `declaredMaxOutput`）。
   */
  maxOutputTokens: number | null
  effort?: EffortLevel
  /** 缓存路由亲和键；同一会话稳定。 */
  cacheKey?: string
  signal?: AbortSignal
}

/**
 * 这次请求实际申报的输出上限。`null` = 整个字段不发，由端点用自己的默认。
 *
 * **`null` 由调用方说了算，不由规格说了算。** 规格没测过（`spec` 为 `null`）
 * 而调用方给了具体数时，照发那个数——`qy probe` 的探针正是这一档，它靠
 * `maxOutputTokens: 16` 把每次探测压到几乎不要钱，按规格改判成不申报的话，
 * 每跑一次探针都会拿到一整篇回答。
 */
export function outputCap(requested: number | null, spec: number | null): number | null {
  if (requested === null) return null
  return spec === null ? requested : Math.min(requested, spec)
}

export interface SystemBlock {
  text: string
  /** true = 在这里放一个缓存断点。 */
  cacheBreakpoint?: boolean
}

export interface WireMessage {
  /** `context` 是内部装配角色，provider 适配器必须把它并入后续真实 user 后再上线。 */
  role: 'user' | 'assistant' | 'tool' | 'context'
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
   * 没有这个位置。装配层无条件标注，各适配器自己决定要不要落到线上——
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

/**
 * 图像块的字节从哪来。**判据是「这是一个引用，还是一次观察」。**
 *
 * 两档不是同一件事的两个阶段，是**两种来源**，会同时出现在一次请求里。
 * `materialize`（`agent/loop.ts`）只把 path 那档换成字节，base64 那档原样通过。
 */
export type MediaSource =
  /**
   * 用户拖 / 粘 / 选进来的附件。**引用他自己的文件，不复制**——那份文件归他所有，
   * 没有理由在别处再存一份。语义上是**活引用**：他改了那个文件，历史跟着变。
   */
  | { kind: 'path'; path: string }
  /**
   * 工具读到的图。字节在**观察的那一刻**就定格进执行记录了
   * （`tools/files.ts` 的 `read_file` 图片分支）。
   *
   * 为什么这条不用路径：模型改完页面会重新截图**覆盖同名文件**，那是「对比改前
   * 改后」这个工作流的自然动作。存路径的话记的是「去哪看」而不是「看到了什么」，
   * 覆盖之后历史里那一张就永远取不回来——而捕获只能发生在观察的那一刻。
   */
  | { kind: 'base64'; data: string }

export type ImageSource = MediaSource
export type VideoSource = MediaSource

/**
 * 消息正文里的一块。
 *
 * 普通文件不进内容块，装配层只把路径写进正文，由模型按需 `read_file`。
 * 图片和视频保留路径引用，请求发出前才读取字节。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; source: ImageSource }
  | { type: 'video'; mimeType: string; source: VideoSource }

/**
 * 取图像块的 base64。
 *
 * **走到这里还是 path 形态就是装配错误**——`materialize` 漏了，或者有人新加了一个
 * 绕过它的 `adapter.stream` 调用点。当场抛，不要发一个空 data 出去：
 * 那会变成 provider 那侧一句语焉不详的 400，而真正的原因在几十个调用栈之外。
 */
export function imageData(source: ImageSource): string {
  if (source.kind === 'base64') return source.data
  throw new Error(`图像块还是路径形态（${source.path}），materialize 没跑到`)
}

export function videoData(source: VideoSource): string {
  if (source.kind === 'base64') return source.data
  throw new Error(`视频块还是路径形态（${source.path}），materialize 没跑到`)
}

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
  /**
   * 这份 schema 是本仓写的，适配器可以按协议要求的 strict 形状重排它。
   *
   * 判据是**谁写的**，不是它长什么样。第三方 schema（MCP server、插件清单）恒为
   * false：改动一个第三方 schema，模型会按改过的形状传参，而 server 按它自己的
   * 形状校验，两边对不上。
   */
  strict?: boolean
  /** 声明但先不载入上下文，等 tool_addition 再浮出。 */
  deferLoading?: boolean
}

// ─────────────────────────────── 流式事件 ───────────────────────────────

export type ProviderEvent =
  | { type: 'request_prepared'; measuredInputTokens: number }
  /**
   * 远端响应已经建立，但还没有模型内容。
   *
   * 它把「上传/排队到响应头」与「响应建立后到首段思考或正文」分开；不携带正文，
   * 也不进入模型历史。各适配器必须在自己的协议边界上发一次。
   */
  | { type: 'response_started' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_calls'; calls: WireToolCall[] }
  | { type: 'usage'; usage: ProviderUsage }
  /**
   * `stopReason` 是归一化结论，`rawStopReason` 是 provider 的原话。
   *
   * **两个都要。** 归一化把 `stop` 与 `tool_calls` 压成同一批词，因此
   * 「模型说完了」和「模型要调工具但一条都没解析出来」在账本上分不出来。
   * 原话只进账本，不参与任何判断——参与判断就等于让每个端点的词表
   * 各自成为一条分支。
   */
  | {
      type: 'done'
      stopReason: ProviderStopReason
      rawStopReason: string
      refusal?: RefusalDetail
    }

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
   * 本适配器**实际会发送** effort 档位吗。
   *
   * 探测器靠它区分「端点接受了」和「客户端没发」：一个不发 effort 的链路上，
   * 探针每一发都会「通过」，而 `--save` 会把这份没有依据的结论覆盖回目录。
   *
   * **必须按 `spec` 算，不能是类级常量**，且判据只有 `effortIsTransmittable`
   * 一份——协议支持不等于这条模型的参数格式发得出去。
   */
  readonly transmits: { effort: boolean; video?: boolean }
  stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown>
}
