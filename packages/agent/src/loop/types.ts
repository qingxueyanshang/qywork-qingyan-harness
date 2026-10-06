/**
 * `AgentLoop` 的依赖、端口与输入的类型定义。
 */

import type {
  ChatRequest,
  ContentBlock,
  LlmAdapter,
  TokenDensity,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import type {
  ActionDescriptor,
  AgentEvent,
  Attachment,
  ContextBreakdown,
  ContextOmitted,
  ProviderKind,
  ProviderRequestConfiguration,
  ProviderRequestContentKind,
  ProviderRequestDiagnostic,
  ProviderRequestPurpose,
  ResponseReasoning,
  RunId,
  RunUsage,
  ToolOutcomeWire,
} from '@qywork/core'
import type { CompactionOutcome, SummaryTrace } from '../compaction.ts'
import type { ToolContextBase, ToolRegistry } from '../registry.ts'

export interface LoopDeps {
  adapter: LlmAdapter
  /** 配置中的接口名，用于在逐请求记录中标明请求路由，不参与请求装配。 */
  providerName?: string
  registry: ToolRegistry
  /** 已拼接完成的三层冻结前缀。 */
  systemPrompt: string
  /**
   * 取出当前标记为「调整方向」的跟进消息。每个 step 边界调用一次，没有时返回空数组。
   *
   * 定义为端口而不直接读取队列：队列是服务端进程内的状态，loop 不依赖它，
   * 也不应依赖（接口在 `agent`、实现在上层，与 `SinkPort` 相同）。
   *
   * `undefined` 是合法值：成员会话与 CLI 没有该通道，不注入。
   */
  followUps?: () => Promise<FollowUpInput[]>
  /** 工具批次结束后、构造下一请求前更新扩展。 */
  beforeRequest?: () => Promise<void>
  /**
   * 除 `emit` 外的执行上下文。`emit` 不在此处：它携带的 stepId 只有 loop 能提供，
   * 理由见 `ToolContext.emit` 的注释。
   */
  makeToolContext(runId: RunId, emit: (e: AgentEvent) => void): ToolContextBase
  /** 每个 step 的持久化回调。事件发出前必须先落盘。 */
  persist: LoopPersistence
  /**
   * 上下文压缩。由 runtime 装配（只有 runtime 知道如何从账本读取历史、向何处写入 manifest）。
   *
   * 未提供时由构造函数补一个透传实现，调用点因此无需判空。可选性只服务测试夹具；
   * 若将其扩散到调用点，需要三处 `if (compaction)`，任何一处遗漏都会导致压缩静默不执行。
   */
  compaction?: CompactionPort
  /**
   * 流空闲上限（毫秒）。未传入时按 `effort` 从 `STREAM_IDLE_TIMEOUT_MS` 放宽。
   * 仅供测试在数百毫秒内验证该路径：回归测试不能等待三分钟。
   */
  streamIdleTimeoutMs?: number
  /**
   * 重发前的退避等待。未传入时按真实计时器等待，并随中止信号提前结束。
   * 仅供重发回归测试断言退避毫秒数，而无需实际等待一分钟。
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * 压缩端口。
 *
 * 定义为端口而不让 loop 直接操作账本：loop 的职责边界是装配上下文、调用模型、
 * 执行工具，一旦依赖 manifest 存于哪张表，此边界即失效。
 */
export interface CompactionPort {
  /**
   * 将完整的待发消息序列投影为实际发送的消息。未压缩时原样返回。
   * 每次构造请求都调用：压缩发生在两次请求之间，投影必须随之更新。
   */
  project(messages: WireMessage[]): WireMessage[]
  /**
   * 执行一次压缩并写入数据库。不抛出异常，失败以 outcome 表示。
   *
   * 信号必须逐层传递到写库之前：`untilAborted` 只让 loop 从等待中返回，
   * 压缩仍在后台执行，其结果须依靠同一信号在写库前丢弃。
   */
  run(input: CompactionRunInput): Promise<CompactionOutcome>
}

export interface CompactionRunInput {
  /** 中断信号，可省略：手动压缩不属于任何 run，没有 run 信号。 */
  signal?: AbortSignal
  /** 轮内压缩时的记账钩子：摘要请求按本轮的普通请求记录。手动压缩不提供。 */
  trace?: SummaryTrace
  /**
   * 自动触发允许只收纳、不摘要；手动触发表示用户明确要求生成压缩投影。
   * 两者使用同一个端口与同一份 manifest，只在边界选择与是否必须尝试摘要上不同。
   */
  trigger: 'automatic' | 'manual'
  /** 当前主模型 id；与压缩后的面板快照绑定，换模型后不得继续沿用。 */
  model: string
  /**
   * 模型是否已看到最后一个单元的内容。
   *
   * 执行工具之前与手动压缩时为 true：模型已对最后一批结果作出响应。发送前与容量拒绝后为 false：
   * 最后一批结果尚未发给模型。已看到且单独超过尾部保留量的单元在压缩时一并收纳；
   * 未看到的最后一个单元始终整段保留，不要收纳它：模型尚未读取。
   */
  latestUnitSeen: boolean
  /**
   * 当前占用读数，必须与触发判定使用同一口径：两处分别计算会产生两套数值。
   *
   * 自动触发且未超过软阈值时，端口只收纳（回收量足够大时）或跳过，不调用摘要器：
   * loop 据此决定是否发出压缩开始事件。
   */
  occupancy: number
  /**
   * 同一份请求的本地估算占用。
   *
   * `occupancy` 锚定之后采用 provider 真值，而收纳回收量只能本地估算：两个数值
   * 计量方式不同，直接相减即用一种计量的差额修改另一种计量的读数。此项给出两者
   * 在本份内容上的换算比，回收量按该比值折算后再相减。
   *
   * 没有锚点时它与 `occupancy` 相等，比值为 1，算式等同于直接相减。
   */
  estimatedOccupancy: number
  /** 模型窗口。软阈值与保留预算都从它推导，不另传现成的数字。 */
  contextWindow: number
  /**
   * 会话主模型的估算密度，与 `estimatedOccupancy` 使用的相同。
   *
   * 不使用 summarizer 的密度：摘要可以由另一个模型生成，但这些数值描述的是主模型
   * 看到的上下文，改用其他密度即用另一个 tokenizer 计量主模型的窗口。
   */
  density: TokenDensity
}

/**
 * 一条要注入当前 run 的跟进消息，正文已装配完成。
 *
 * 附件在上游解析完成后再传入：loop 不访问磁盘（与 `SinkPort` 的边界相同），
 * 传入路径即要求 loop 自行读取文件。
 */
export interface FollowUpInput {
  /** 队列条目 id，随 `message.injected` 返回给客户端，用于移除对应的卡片。 */
  id: string
  /** 原文。写入 step 的 `content` 列，也是事件中回传的内容。 */
  text: string
  /** 装配后的正文（附件已解析为内容块），写入 transcript。 */
  content: string | ContentBlock[]
  attachments?: Attachment[]
  /** 消息来源：子 agent 的回执、workflow 的回执；缺失表示用户本人。 */
  origin?: 'subagent' | 'workflow'
}

export interface LoopPersistence {
  nextSeq(runId: RunId): number
  /**
   * 将 run 内注入的用户消息写入一条 `kind='user'` 的 step，返回 stepId。
   * `notice` 标记装配层的执行事实（见 `RunState.notify`），使用同一条写入路径。
   *
   * 创建即为终态：它不是执行，没有中间状态。崩溃恢复只处理 `running` 行，
   * 因此这类行不需要、也不应有恢复分支。
   */
  landUserStep(
    runId: RunId,
    seq: number,
    input: {
      text: string
      attachments?: Attachment[]
      origin?: 'subagent' | 'workflow'
      notice?: true
    },
  ): string
  /**
   * `batchId` 是产生该段正文的请求 id，写入 `provider_batch_id`。
   * 工具行与同一次生成的思考行取相同的值：投影据此识别生成边界。
   */
  openTextStep(runId: RunId, seq: number, batchId: string): string
  /**
   * 思考正文的行，与文本行结构相同：内容到达时开启，逐段追加，共用 `appendText`。
   *
   * 单独设一种 step 而不附在工具行上：附在工具行上时，没有工具调用的轮次没有
   * 存放位置，纯文本轮的思考因此被直接丢弃，刷新页面后即不存在。
   *
   * DeepSeek 类兼容端点同样依赖它：带 tool_calls 的 assistant 消息必须原样
   * 回传 `reasoning_content`，否则后续轮次返回 400；历史从 steps 投影时缺少该部分
   * 必然返回 400。
   */
  openThinkingStep(
    runId: RunId,
    seq: number,
    batchId: string,
    reasoning?: ResponseReasoning,
  ): string
  /**
   * 轮内自动重发前，将失败尝试留下的思考 step 写为失败终态。
   *
   * 边界：只标记、不删除。这些 step 确实发生过，诊断账本必须保留。模型历史与普通
   * 会话投影都据此终态排除它们；不排除时会与重发产生的思考合并为一条。
   */
  failThinkingSteps(stepIds: string[]): void
  appendText(stepId: string, delta: string): void
  openToolStep(
    runId: RunId,
    seq: number,
    call: WireToolCall,
    batchId: string,
    callIndex: number,
    waveIndex: number,
    action: ActionDescriptor,
  ): string
  markExecuting(stepId: string): void
  settleTool(
    stepId: string,
    status: 'success' | 'failure',
    outcome: ToolOutcomeWire,
    args: Record<string, unknown>,
    action: ActionDescriptor,
    /**
     * 本次调用的执行时长，与 `tool.finished` 事件中的值相同：
     * 一处测量、两处使用，事件供运行期间的界面使用，写库供刷新之后的回放使用。
     */
    durationMs: number,
  ): void
  saveUsage(runId: RunId, usage: RunUsage): void
  /**
   * 为压缩写入一条 step。
   *
   * 这是 `'compaction'` 类型 step 的唯一生产者。缺少它时，`steps.kind` 的 CHECK、
   * `StepKind`、archive 渲染分支都成为没有生产者的链路（C1 第 1 款）：压缩条目只由
   * 实时事件创建，刷新后即消失，而它是解释上下文占用下降原因的唯一依据。
   */
  recordCompaction(
    runId: RunId,
    seq: number,
    payload: {
      /**
       * 终态的唯一记录方式，与 `CompactionEvent.phase` 同源。
       * 行上的 `status` 列由它导出，不要改为由调用方分别上报。
       */
      phase: 'done' | 'skipped' | 'failed'
      manifestRevision: number
      compactedMessages: number
      /** 仅用于 `phase='done'`：摘要边界已前移（true），或只收纳了工具正文（false）。 */
      summarized?: boolean
      reasonCode?: string
      message?: string
      trigger?: 'manual' | 'automatic' | 'overflow'
      occupancy?: number
      estimatedOccupancy?: number
      contextWindow?: number
    },
  ): void
  /**
   * 逐请求账。装配完成、发出之前写入一行，返回 id 供后续回填。
   *
   * 不能改为 run 上的三个标量（tokens / limit / percent）：每个 step 都会覆盖一次，
   * 一个 run 有 N 次请求而账本只保留最后一次的读数，无法追溯本轮上下文的增长过程。
   */
  openRequest(input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    purpose: ProviderRequestPurpose
    providerName?: string
    providerKind: ProviderKind
    model: string
    measuredInputTokens: number
    /** 发出时的运行中上下文读数（`RunState.meter`）。摘要请求不提供。 */
    occupancyTokens?: number
    configuration?: ProviderRequestConfiguration
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    requestBytes: number
    /** 本次请求的信封指纹。跨 run 复用锚点时据此判定上下文是否相同。 */
    cacheRouteFingerprint: string
  }): string
  /** 请求已实际发出。sent_at 只在此处设置。 */
  markRequestSent(requestId: string): void
  /**
   * 响应头到达。`at` 是传输层观察到的时刻，由 `response_started` 事件携带，
   * 不是本方法被调用的时刻。
   */
  markRequestHeaders?(requestId: string, at: number): void
  /** 可选仅为兼容测试夹具；生产装配必须提供。 */
  markRequestFirstEvent?(requestId: string): void
  /**
   * 收到一段非空思考、正文或新增工具参数。每一段都调用，首值与末值由写库端分别保留。
   *
   * `at` 是适配器解析该段时的观察时刻，由 provider 事件携带，不是本方法被调用的时刻。
   */
  markRequestContent?(
    requestId: string,
    at: number,
    kind?: ProviderRequestContentKind,
    visible?: boolean,
  ): void
  /**
   * 请求终态。`usage` 为 null 表示 provider 未回报，四个字段写入 null 而不是 0：
   * 中转站遗漏 usage 很常见，记为 0 会使上下文锚点误判为本次请求没有占用。
   */
  settleRequest(
    requestId: string,
    status: 'received' | 'uncertain' | 'rejected',
    usage: {
      inputTokens: number
      outputTokens: number
      cachedTokens: number | null
      cacheWriteTokens: number | null
    } | null,
    errorCode: string | null,
    /** provider 的原文。无法取得时为空串，不要编造：编造的值会使账本失真。 */
    finishReason?: string,
    /** provider 返回的错误正文。连接层失败或没有正文时为 null。 */
    errorMessage?: string | null,
  ): void
  /** 失败现场与重试裁决。可选只为兼容轻量测试夹具，生产装配必须提供。 */
  recordRequestDiagnostic?(requestId: string, diagnostic: ProviderRequestDiagnostic): void
}

export interface RunInput {
  runId: RunId
  history: WireMessage[]
  effort?: ChatRequest['effort']
  cacheKey?: string
  signal: AbortSignal
  /**
   * 上一次 provider 真值回执，从账本读取，决定本轮开头的读数是否沿用同一计量方式。
   *
   * 缺少它时，每个 run 的第一次请求只能报告本地估算（系统性偏低），第二次请求起才切换到
   * 真值：读数在每轮开头下降一次后恢复，而会话内容没有任何变化。
   *
   * `throughMessageId`：该回执覆盖到的最后一条消息。其后的历史消息未计入
   * 锚点，需要另行估算。
   */
  anchor?: {
    tokens: number
    throughMessageId: string | null
    /**
     * 产生该真值的请求所用的模型。
     *
     * 与本轮不同时整个锚点作废，无法修正：各厂商 tokenizer 对同一份内容的计数相差可达
     * 1.8 倍（`ai/tokens.ts` 的 `TokenDensity`），用 A 的真值判断 B 的窗口属于计量错误。
     */
    model: string
    /**
     * 该请求的信封占用（`core` 的 `envelopeHeadTokens`）。
     *
     * 信封变化时据此替换头部：`tokens − headTokens + 本轮头部`。缺少它时只能
     * 整体作废，作废后显示、压缩触发、`max_tokens` 钳位三处都改用本地估算。
     */
    headTokens: number
    /**
     * 产生该真值的请求的信封指纹（`envelopeHashOf`）。
     *
     * 与本轮不一致时只替换头部，不作废：信封之外的内容没有变化，这部分真值
     * 仍然有效。
     *
     * `null` 不视为信封变化。它表示该行未记录指纹（在指纹列加入之前创建），
     * 把未知视为已变化与视为未变化同样是没有依据的结论；
     * 与 `cachedTokens` 的处理一致：未回报不等于 0。新行一律带指纹，
     * 因此 null 只存在于存量行，此后的每一次请求都能进行指纹校验。
     */
    envelopeFingerprint: string | null
  }
  /**
   * 本轮 transcript 所属的用户消息。
   *
   * 缺少它时本 run 内新产生的执行记录没有归属，压缩投影无法定位它们，
   * 因此 run 内新增的内容无法被压缩，而占用增长的正是这部分内容。
   */
  userMessageId?: string
}
