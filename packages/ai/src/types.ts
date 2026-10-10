/**
 * 与供应商无关的请求与事件类型。
 *
 * AgentLoop 只依赖这一层；更换供应商无需修改 loop。
 */

// `ContextGroup` 的真源在 `core/domain/model.ts`，此处只转导出供 `_group` 使用。
// 分组口径必须与事件协议使用同一个类型，各定义一份会使两处分组不一致。
import type {
  ContextGroup,
  EffortLevel,
  ProviderHedge,
  ProviderKind,
  ProviderRequestContentKind,
  ResponseReasoning,
  ThinkingMode,
  ToolCallCheck,
} from '@qywork/core'
import type { ModelSpec, SpecOverride } from './catalog.ts'

// ─────────────────────────────── 配置 ───────────────────────────────

/**
 * 三个适配器构造 SDK 客户端时共用的传输参数。只保留这一份，不得在各适配器中分别定义。
 *
 * - `timeout` 的计时截至**响应头到达**（两个 SDK 都在 fetch 的 finally 中 `clearTimeout`，
 *   `openai-responses` 手写的定时器同样如此）。响应头到达之前只有这一个期限：部分中转站在
 *   上游产出第一段内容后才返回响应头，实测 gemini-3.8-flash 处理「写整个游戏」的请求，响应头在 39.7 秒
 *   后到达，长上下文耗时更长。该阶段等待超过 `HEDGE_AFTER_MS` 时传输层补发一份请求，补发不中断原请求，
 *   不构成第二个期限。响应头到达之后由传输层按字节计时（`transport.ts` 的 `traceFetch`，
 *   上限取自 `ChatRequest.idleTimeoutMs`）。两段各有一个权威，任何一方都不得跨段计时。
 * - `maxRetries: 0`：连接失败时 SDK 默认自行重试两次，等待时间因此变为三倍。
 *   自动重发由 AgentLoop 的统一判据负责，适配器不得另设重试。
 * - `fetchOptions.timeout: false`：关闭 Bun 的 socket 空闲超时。该超时默认 300 秒
 *   （`BUN_CONFIG_HTTP_IDLE_TIMEOUT`），正文静默达到时限即以 `TimeoutError` 中止流，早于看门狗
 *   触发：实测（2026-09-07，Bun 1.3.14）静默 300.6 秒后流被中止，deepseek-v4-pro max 档一轮
 *   思考期间静默 320 秒即因此失败。两个 SDK 把它合并进每次 fetch 的 init，手写 fetch 的
 *   位置（`openai-responses.ts` 与生成接口的 `media/http.ts`）需要自行展开。标准 `RequestInit` 没有这个键，SDK 的 `fetchOptions` 又不接受
 *   body / headers / method / signal 四个键，因此类型声明为去掉这四个键的 `RequestInit`。
 */
export const PROVIDER_HTTP = {
  timeout: 600_000,
  maxRetries: 0,
  fetchOptions: { timeout: false } as Omit<
    RequestInit,
    'body' | 'headers' | 'method' | 'signal'
  > & { timeout: false },
} as const

/**
 * 每次请求都新建连接，不复用空闲的 keep-alive 连接。
 *
 * 中转站会关闭空闲连接：实测（2026-09-06，deepseek 与 gemini 两家中转）空闲 250 秒后
 * 复用旧连接的第一次请求立即返回 `ECONNRESET`，自动重发可能使用连接池中另一条同样已失效的连接，
 * 不返回任何字节，直到看门狗 180 秒到期，该轮以 provider_error 结束。
 * 派发任务由事件驱动，请求常在数分钟的等待之后发出（等待子 agent 回执、等待长时间运行的命令），
 * 因此必然遇到这种情况。代价是每次请求多一次 TLS 握手，远小于一次模型往返的耗时。
 *
 * 生成接口同样如此：2026-10-10 api.mumugofe.com 复用空闲约 100 秒的连接提交生成，241 毫秒即 `ECONNRESET`；
 * 复用空闲 60 秒的连接发出的查询 7 分钟无响应。
 *
 * 对话的三个适配器与生成请求的 `send`（`media/http.ts`）都必须带上该请求头，缺少任何一处，对应的请求仍会出现该故障。
 */
export const PROVIDER_HEADERS = { connection: 'close' } as const

/**
 * 当前接口接受的思考参数值与格式。undefined = 未校准，沿用协议与目录的结论。
 * 检测结果只作用于该接口，不修改全局模型的价格、窗口或其他能力。
 */
export interface TransportCapabilities {
  /** 原始工具参数和结果回传的检测记录，不改变模型能力或工具执行策略。 */
  toolCalls?: ToolCallCheck
  effort?: boolean
  effortLevels?: EffortLevel[]
  thinking?: ThinkingMode
}

export interface ProviderProfile {
  kind: ProviderKind
  /**
   * 仅当 baseUrl 指向本机回环地址时允许为空（本地模型服务无需鉴权）。
   * 其余情况下 `buildAdapter` 直接抛出 `no_api_key`，不发出必然返回 401 的请求。
   */
  apiKey: string
  /** 自定义端点；留空时按模型库中的厂商和当前协议使用官方端点。 */
  baseUrl?: string
  model: string
  /** 额外请求头，供需要特殊鉴权的中转站使用。 */
  headers?: Record<string, string>
  /**
   * 模型库中的对应条目（窗口、上限、单价、思考档位）。这是**唯一的覆盖层**：
   * 目录 seed 之上只有它，`buildAdapter` 不接受第二条覆盖通道。
   *
   * 落盘按「模型 id × 协议」两维索引（`runtime` 的 `QyConfig.catalog`），
   * 因为同一个模型在不同协议上能力不同；此处取得的已是选中的条目。
   */
  spec?: SpecOverride
  /** 当前「接口 × 模型」的传输校准，不写进全局模型目录。 */
  transport?: TransportCapabilities
}

// ─────────────────────────────── 请求 ───────────────────────────────

export interface ChatRequest {
  model: string
  /** 冻结前缀：跨 run 逐字节稳定。日期、技能、记忆一律不放入此处。 */
  system: SystemBlock[]
  messages: WireMessage[]
  tools: ToolSchema[]
  /**
   * 本次申报的输出上限。**`null` = 不申报，由端点使用其默认值。**
   *
   * 它不表示「该模型最多能输出多少」：兼容协议按 `输入 + max_tokens ≤ 窗口` 校验，
   * 因此它表示「本轮还能容纳多少输出」（`agent` 的 `declaredMaxOutput`）。
   */
  maxOutputTokens: number | null
  effort?: EffortLevel
  /**
   * 响应头到达之后允许的最长字节空闲时间，由 `traceFetch` 执行。
   *
   * 适配器只负责把它传给传输层，不自行判定超时：同一段时间存在两个计时器会形成两本账。
   */
  idleTimeoutMs: number
  /** 缓存路由字段的值；同一会话内保持不变。 */
  cacheKey?: string
  signal?: AbortSignal
}

/**
 * 本次请求实际申报的输出上限。`null` = 不发送该字段，由端点使用其默认值。
 *
 * **`null` 由调用方决定，不由规格决定。** 规格未经测定（`spec` 为 `null`）
 * 而调用方给出具体数值时，照常发送该数值：`qy probe` 的探针属于这种情况，它以
 * `maxOutputTokens: 16` 把每次探测的费用压到接近零；若按规格改为不申报，
 * 每次运行探针都会收到完整的回答。
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
  /** `context` 是内部装配角色，provider 适配器必须把它并入其后的真实 user 消息后再发送。 */
  role: 'user' | 'assistant' | 'tool' | 'context'
  content: string | ContentBlock[]
  /** assistant 轮携带的工具调用。 */
  toolCalls?: WireToolCall[]
  /** role='tool' 时对应的调用 id。 */
  toolCallId?: string
  /**
   * 思考正文。哪些协议、哪些轮次发送它由 `reasoningReplay`（`catalog.ts`）裁决；
   * DeepSeek 等兼容供应商在思考模式下要求带 tool_calls 的轮次回传思考正文，否则后续轮次返回 400。
   */
  reasoningContent?: string
  /**
   * 不可展示的原生推理条目。装配点只保留前缀未变的条目（`agent/loop/request.ts` 的
   * `replayReasoning`），适配器收到后原样回放；存在该字段时不再发送思考正文。
   */
  responseReasoning?: ResponseReasoning
  /**
   * 缓存断点：**从请求开头到这条消息为止**的字节由 provider 缓存。
   *
   * 这是**协议差异，不是行为分支**：Anthropic 需要显式标注
   * （`cache_control`），而兼容协议的前缀缓存由服务端自动完成，请求体中
   * 没有对应字段。装配层无条件标注，由各适配器决定是否发送，
   * 与 `reasoningContent`、`transmits` 的处理方式相同。
   *
   * 标注位置由「这一段是否跨请求逐字节稳定」决定，见 `agent/loop/index.ts` 的装配。
   */
  cacheBreakpoint?: boolean
  /** 仅用于内部记账，不发送给 provider。 */
  _group?: ContextGroup
  _messageId?: string
  /**
   * 可折叠单元的标记，形如 `<runId>:<定宽 seq>`。**同一执行批次的
   * assistant 消息与它的全部 tool 结果共用一个标记**：压缩按标记划分边界，
   * 同一标记的消息同时保留或同时移除，因此 tool_call 与 tool_result 不会被拆开。
   *
   * 与 `_messageId` 共同构成完整位置：先比较消息 id，同一条消息内再比较标记。
   */
  _step?: string
  /**
   * 产生这条消息的请求 id。**仅用于内部记账，不发送给 provider。**
   *
   * 只有带 `toolCalls` 的 assistant 消息及其 tool 结果带有该字段：裁剪工具图片时需要识别
   * 最近一批待继续的工具调用，再用该值在请求账中查询它是否确实已发送。
   * 纯文本消息、用户消息与投影摘要不带该字段。
   */
  _batch?: string
}

/**
 * 图像块字节的来源。**判据是「这是一个引用，还是一次观察」。**
 *
 * path 与 base64 是进入适配器前的两种来源。url 只存在于单次 Provider 请求的副本中，
 * 用于必须先上传媒体再引用的协议，不进入会话历史。
 */
export type MediaSource =
  /**
   * 用户拖入、粘贴或选择的附件。**引用用户自己的文件，不复制**：该文件归用户所有，
   * 无需另存一份。语义上是**实时引用**：用户修改该文件后，历史中的内容随之变化。
   */
  | { kind: 'path'; path: string }
  /**
   * 工具读取的图片。字节在**观察时**即固定写入执行记录
   * （`tools/files.ts` 的 `read_file` 图片分支）。
   *
   * 不使用路径的原因：模型修改页面后会重新截图并**覆盖同名文件**，这是对比修改前后的
   * 常规操作。保存路径记录的是「在哪里查看」而不是「看到了什么」，
   * 文件被覆盖后历史中的那张图将无法取回，而捕获只能在观察时进行。
   */
  | { kind: 'base64'; data: string }
  | { kind: 'url'; url: string }

export type ImageSource = MediaSource
export type VideoSource = MediaSource

/**
 * 消息正文中的一个内容块。
 *
 * 普通文件不放入内容块，装配层只把路径写入正文，由模型按需调用 `read_file`。
 * 图片和视频保留路径引用，请求发出前才读取字节。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; source: ImageSource }
  | { type: 'video'; mimeType: string; source: VideoSource }

/**
 * 取得图像块的 base64。
 *
 * **执行到此处时仍为 path 形态即属装配错误**：遗漏了 `materialize`，或新增了
 * 绕过它的 `adapter.stream` 调用点。此处直接抛出，不要发送空的 data：
 * 否则 provider 只返回一个含义不明的 400，而真正的原因位于调用栈中很远的位置。
 */
export function imageData(source: ImageSource): string {
  if (source.kind === 'base64') return source.data
  throw new Error(`图像块不是 base64 形态（${source.kind}），当前适配器无法发送`)
}

export function videoData(source: VideoSource): string {
  if (source.kind === 'base64') return source.data
  throw new Error(`视频块不是 base64 形态（${source.kind}），当前适配器无法发送`)
}

export interface WireToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /**
   * 参数 JSON 解析失败时的**原文**。
   *
   * **使用独立字段，不要在 `arguments` 中放入特殊键**：各 provider 的写法各不相同，
   * 且没有任何消费者识别这些键，工具仍会以无效参数执行。
   * 只设一个字段、一处判断，消费者在 `AgentLoop` 中。
   */
  argumentsError?: string
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema 对象。序列化结果必须确定（键排序），否则前缀缓存无法命中。 */
  parameters: Record<string, unknown>
  /**
   * 该 schema 由本仓库编写，适配器可以按协议要求的 strict 形状重排它。
   *
   * 判据是**编写者**，不是 schema 的形状。第三方 schema（MCP server、插件清单）恒为
   * false：改动第三方 schema 后，模型按改动后的形状传参，而 server 按其原有
   * 形状校验，两者不一致。
   */
  strict?: boolean
  /** 已声明但暂不载入上下文，待 tool_addition 时再载入。 */
  deferLoading?: boolean
}

// ─────────────────────────────── 流式事件 ───────────────────────────────

export type ProviderEvent =
  | { type: 'request_prepared'; measuredInputTokens: number }
  /**
   * 远端响应已建立，但尚无模型内容。
   *
   * 它把「上传、排队至响应头到达」与「响应建立后至首段思考或正文」两段分开；不携带正文，
   * 也不进入模型历史。各适配器必须在各自的协议边界上发出一次。
   *
   * `headersAt` 取 `TransportTrace.headersAt`，即 `fetch` 返回响应头的时刻。
   * **不要改为事件产生时的当前时刻**：该事件在 SDK 解析完首批字节之后才能发出，
   * 两者相差的毫秒数正是这一列要度量的首包等待时间。
   *
   * `hedge` 取 `TransportTrace.hedge`：响应头之前补发过第二份请求时存在。
   */
  | { type: 'response_started'; headersAt: number; hedge?: ProviderHedge }
  /*
   * 带内容的五个事件都携带 `at`：该段内容**到达本地并解析完成**的时刻。
   *
   * 取解析时刻而不是消费时刻：调用方处理该段之前可能先落库、先渲染，
   * 这几毫秒属于「距最后一段内容已过多久」要度量的范围。
   * 空 delta、心跳、响应头与用量不带该字段，也不推进任何内容时刻。
   */
  | { type: 'thinking_delta'; delta: string; at: number }
  /** 一次响应的原生推理条目，流接收完毕后交付一次。 */
  | { type: 'response_reasoning'; reasoning: ResponseReasoning; at: number }
  | { type: 'text_delta'; delta: string; at: number }
  /** 收到非空工具参数片段；只报告生成进度，完整调用仍由 tool_calls 交付。 */
  | { type: 'tool_call_progress'; at: number }
  | { type: 'tool_calls'; calls: WireToolCall[]; at: number }
  | { type: 'usage'; usage: ProviderUsage }
  /**
   * `stopReason` 是归一化结论，`rawStopReason` 是 provider 返回的原始值。
   *
   * **两者都需要。** 归一化把 `stop` 与 `tool_calls` 映射到同一组值，因此
   * 「模型已完成回答」与「模型要调用工具但未解析出任何调用」在账本上无法区分。
   * 原始值只写入账本，不参与任何判断：参与判断会使每个端点的取值
   * 各自成为一条分支。
   */
  | {
      type: 'done'
      stopReason: ProviderStopReason
      rawStopReason: string
      refusal?: RefusalDetail
      /** 响应包含思考块；内容可以由供应商隐藏。 */
      thinkingObserved?: true
    }

/** 思考文本、原始思考条目和供应商用量均可提供正向证据。 */
export function hasThinkingEvidence(event: ProviderEvent): boolean {
  return (
    (event.type === 'thinking_delta' && event.delta.length > 0) ||
    (event.type === 'response_reasoning' && event.reasoning.items.length > 0) ||
    (event.type === 'usage' &&
      event.usage.source === 'provider' &&
      event.usage.reasoningTokens > 0) ||
    (event.type === 'done' && event.thinkingObserved === true)
  )
}

/** 主请求和摘要使用同一套内容判据；空 delta 与空调用列表不是模型新输出。 */
export function providerContentKind(event: ProviderEvent): ProviderRequestContentKind | null {
  switch (event.type) {
    case 'text_delta':
      return event.delta.length ? 'text' : null
    case 'thinking_delta':
      return event.delta.length ? 'thinking' : null
    case 'tool_call_progress':
      return 'tool_arguments'
    case 'tool_calls':
      return event.calls.length ? 'tool_arguments' : null
    case 'response_reasoning':
      return event.reasoning.items.length ? 'other' : null
    default:
      return null
  }
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
  /** null = provider 未回报，与实际命中 0 不同，不得混同。 */
  cachedTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number
  /** 用量来自 provider 回报还是本地估算。 */
  source: 'provider' | 'estimated'
}

// ─────────────────────────────── 适配器 ───────────────────────────────

export interface LlmAdapter {
  /** 工厂解析后的实际端点，仅供诊断；持久化时必须去掉认证段与查询串。 */
  readonly endpoint?: string
  readonly kind: ProviderKind
  readonly spec: ModelSpec
  /**
   * 本适配器是否**实际发送** effort 档位。
   *
   * 探测器据此区分「端点接受了该参数」与「客户端未发送」：在不发送 effort 的链路上，
   * 每次探测都会显示通过，而 `--save` 会把这份没有依据的结论写回目录。
   *
   * **必须按 `spec` 计算，不能是类级常量**，且判据只有 `effortIsTransmittable`
   * 一份：协议支持不等于该模型的参数格式能够发送。
   */
  readonly transmits: {
    effort: boolean
    video?: boolean
    /** 本地路径由适配器内联或上传；Agent 不预先读取整份媒体。 */
    mediaPaths?: boolean
    /** 本地路径媒体超过该字节数时先上传并改用地址，请求中只带地址；缺省表示一律内联。 */
    mediaUploadAbove?: number
  }
  stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown>
}

/** 只保留端点位置；URL 的认证段和查询串不属于诊断参数。 */
export function diagnosticEndpoint(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[invalid URL omitted]'
  }
}
