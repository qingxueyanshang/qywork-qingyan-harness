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
  /** 配置里的接口名；用于逐请求路线证据，不参与请求组装。 */
  providerName?: string
  registry: ToolRegistry
  /** 三层冻结前缀，已拼好。 */
  systemPrompt: string
  /**
   * 取走此刻标了「调整方向」的跟进消息。**每个 step 边界调一次**，没有就回空数组。
   *
   * 端口而不是直接读队列：队列是服务端进程内的状态，loop 不认识它，
   * 也不该认识（接口在 `agent`、实现在上层，同 `SinkPort`）。
   *
   * `undefined` 是合法值——成员会话与 CLI 没有这条通道，不注入。
   */
  followUps?: () => Promise<FollowUpInput[]>
  /**
   * 除 `emit` 外的执行上下文。**`emit` 不在这里**——它要带的 stepId 只有 loop 有，
   * 理由写在 `ToolContext.emit` 上方。
   */
  makeToolContext(runId: RunId, emit: (e: AgentEvent) => void): ToolContextBase
  /** 每个 step 的持久化回调。事件发出前必须先落盘。 */
  persist: LoopPersistence
  /**
   * 上下文压缩。由 runtime 装配（它才知道怎么从账本取历史、往哪写 manifest）。
   *
   * 不给的话由构造函数补一个透传实现，**调用点因此不必判空**。这不是给缺失
   * 留后路：可缺性只服务测试夹具，而让它泄漏到每个调用点的代价是三处
   * `if (compaction)`，其中任何一处漏判都是一次静默的「压缩没发生」。
   */
  compaction?: CompactionPort
  /**
   * 流空闲上限（毫秒）。不传按 `effort` 从 `STREAM_IDLE_TIMEOUT_MS` 放宽。
   * 存在的理由只有一个：让测试在几百毫秒内验到这条路径。回归测试不能等三分钟。
   */
  streamIdleTimeoutMs?: number
  /**
   * 重发前的退避等待。不传按真实计时器等，并随中止信号提前结束。
   * 存在的理由只有一个：让重发回归断言退避毫秒数，而不必真的等满一分钟。
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * 压缩端口。
 *
 * 定义成端口而不是让 loop 直接操作账本：loop 的职责边界是「装配上下文 → 调模型 →
 * 执行工具」，一旦它开始依赖 manifest 存于哪张表，此边界即失效。
 */
export interface CompactionPort {
  /**
   * 把整串待发消息投影成实际要发的那份。未压缩时原样返回。
   * 每次构造请求都调用——压缩发生在两次请求之间，投影必须跟着变。
   */
  project(messages: WireMessage[]): WireMessage[]
  /**
   * 执行一次压缩并落库。**不抛异常**，失败以 outcome 表达。
   *
   * 信号必须逐层传到落库点前：`untilAborted` 只让 loop 从等待中返回，
   * 压缩仍在后台执行，其结果要靠同一个信号在落库前被丢弃。
   */
  run(input: CompactionRunInput): Promise<CompactionOutcome>
}

export interface CompactionRunInput {
  /** 中断信号。**可缺**：手动压缩不属于任何 run，没有 run 信号。 */
  signal?: AbortSignal
  /** 一轮之内压缩时的记账钩子：摘要请求按这一轮的普通请求记。手动压缩不给。 */
  trace?: SummaryTrace
  /**
   * 自动触发允许「只收纳、不摘要」；手动触发代表用户明确要求生成压缩投影。
   * 两者仍走同一个端口、同一份 manifest，只在选界和是否必须尝试摘要上有差别。
   */
  trigger: 'automatic' | 'manual'
  /** 当前主模型 id；与压缩后的面板快照绑定，换模型后不得继续沿用。 */
  model: string
  /** 当前占用读数。**必须与触发判定同一把尺**，两处各量一次就是两本账。 */
  occupancy: number
  /**
   * 同一份请求的**本地估算**占用。
   *
   * `occupancy` 锚定之后走的是 provider 真值，而收纳回收量只能本地估算——两个数
   * 出自两把尺，直接相减就是拿一把尺的差额去改另一把尺的读数。这一项给出两把尺
   * 在**这一份内容上**的换算比，回收量按它折算后再减。
   *
   * 没有锚点时它与 `occupancy` 相等，比值为 1，算式退化成相减本身。
   */
  estimatedOccupancy: number
  /** 模型窗口。软阈值与保留预算都从它推导，不另传现成的数字。 */
  contextWindow: number
  /**
   * 会话主模型那把估算尺，与 `estimatedOccupancy` 同一把。
   *
   * **不是 summarizer 的**：摘要可以由另一个模型生成，但这些量描述的是主模型
   * 看到的上下文，换尺就是拿另一个 tokenizer 去量别人的窗口。
   */
  density: TokenDensity
}

/**
 * 一条要注入当前 run 的跟进消息，正文已经装配好。
 *
 * **附件在上游解析完再进来**：loop 不碰磁盘（同 `SinkPort` 那条边界），
 * 把路径交给它等于让它自己去读文件。
 */
export interface FollowUpInput {
  /** 队列条目 id，随 `message.injected` 回给客户端，用来摘掉那张卡。 */
  id: string
  /** 原文。落 step 的 `content` 列，也是事件里回传的那一份。 */
  text: string
  /** 装配后的正文（附件已解析成内容块），进 transcript。 */
  content: string | ContentBlock[]
  attachments?: Attachment[]
  /** 谁投进来的：子 agent 的回执、workflow 的回执，缺席 = 用户本人。 */
  origin?: 'subagent' | 'workflow'
}

export interface LoopPersistence {
  nextSeq(runId: RunId): number
  /**
   * run 内注入的那句用户消息，落一条 `kind='user'` 的 step，返回 stepId。
   *
   * **开即终态**：它不是执行，没有中间态可等。崩溃恢复只碰 `running` 行，
   * 因此这种行不需要、也不该有恢复分支。
   */
  landUserStep(
    runId: RunId,
    seq: number,
    input: { text: string; attachments?: Attachment[]; origin?: 'subagent' | 'workflow' },
  ): string
  /**
   * `batchId` 是产生这段正文的那次请求的 id，落进 `provider_batch_id`。
   * 工具行与同一次生成的思考行取同一个值——投影靠它认出生成边界。
   */
  openTextStep(runId: RunId, seq: number, batchId: string): string
  /**
   * 思考正文的行。**与文本行同构**：流到就开，逐段追加，`appendText` 共用。
   *
   * 单开一种 step 而不是挂在工具行上：挂上去的推论是「这一轮没有工具调用就没有
   * 地方放」，因此纯文本轮的思考直接丢弃——刷新一次页面它就不存在了。
   *
   * 它同时是 DeepSeek 类兼容端点的必需品：带 tool_calls 的 assistant 消息要原样
   * 回传 `reasoning_content`，否则后续轮次 400；历史从 steps 投影回去时缺这一段
   * 就是必然的 400。
   */
  openThinkingStep(
    runId: RunId,
    seq: number,
    batchId: string,
    reasoning?: ResponseReasoning,
  ): string
  /**
   * 轮内自动重发前，把失败那次留下的思考 step 落成失败终态。
   *
   * 边界：只标不删——那些 step 真实发生过，诊断账本必须保留。模型历史与普通
   * 会话投影都据这个终态排除；不排除就会与重发那次的思考拼成一条。
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
     * 这次调用跑了多久。**与 `tool.finished` 事件里那个数是同一个**——
     * 一处量、两处用：事件给运行期的界面，落库给刷新之后的回放。
     */
    durationMs: number,
  ): void
  saveUsage(runId: RunId, usage: RunUsage): void
  /**
   * 压缩落一条 step。
   *
   * **这是 `'compaction'` 这种 step 的唯一生产者。** 少了它，`steps.kind` 的 CHECK、
   * `StepKind`、archive 渲染分支就都是没有生产者的死链路（C1 第 1 款）：压缩条只由
   * 活事件创建，刷新即消失，而它是解释「上下文为什么降了」的唯一线索。
   */
  recordCompaction(
    runId: RunId,
    seq: number,
    payload: {
      /**
       * 终态的**唯一**记法，与 `CompactionEvent.phase` 同源。
       * 行上的 `status` 列由它导出，不要反过来让调用方各报一次。
       */
      phase: 'done' | 'skipped' | 'failed'
      manifestRevision: number
      compactedMessages: number
      /** `phase='done'` 专有：摘要线跟着前移了（true），还是只收纳了工具正文（false）。 */
      summarized?: boolean
      reasonCode?: string
    },
  ): void
  /**
   * 逐请求账。**装配完成、发出之前**记一行，返回 id 供后续回填。
   *
   * **不能写成挂在 run 上的三个标量**（tokens / limit / percent）：那样每个 step
   * 覆盖一次，一个 run 有 N 次请求而账只剩最后一次的读数，
   * 「这一轮上下文怎么长起来的」在账本里不存在。
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
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    requestBytes: number
    /** 本次请求的信封指纹。跨 run 复用锚点时靠它判「还是同一份上下文吗」。 */
    cacheRouteFingerprint: string
  }): string
  /** 请求真的发出去了。sent_at 只在这里置。 */
  markRequestSent(requestId: string): void
  /**
   * 响应头到达。`at` 是传输层观察到的时刻，由 `response_started` 事件带上来，
   * **不是本方法被调用的时刻**。
   */
  markRequestHeaders?(requestId: string, at: number): void
  /**
   * 本次输入实际完整携带了哪一批工具图片。`batchId` 是产出那批调用的请求 id。
   *
   * **只在图片块逐张确认还在请求体里之后调用**：能力过滤或压缩把图换成文字之后
   * 仍然调，等于替模型声明它看过一张没发出去的图。
   */
  markRequestInputImages?(requestId: string, batchId: string): void
  /**
   * 这批工具图片有没有被一次已接收的主请求真的送到过模型。
   *
   * 读的是同一份请求账（`markRequestInputImages` 写的那一列），所以放在这个 port 上：
   * 它要按轮重新回答——同一批图在本轮还没送达、下一轮就送达了，`RunInput` 里的
   * 一个值答不了。没有记录一律 false，无记录不等于模型看过。
   */
  inputImagesConsumed?(batchId: string): boolean
  /** 可选是为了旧测试夹具；生产装配必须提供。 */
  markRequestFirstEvent?(requestId: string): void
  /**
   * 收到一段非空思考、正文或新增工具参数。**每一段都调**，首值与末值由落库端分别保留。
   *
   * `at` 是适配器解析该段时的观察时刻，由 provider 事件带上来，不是本方法被调用的时刻。
   */
  markRequestContent?(
    requestId: string,
    at: number,
    kind?: ProviderRequestContentKind,
    visible?: boolean,
  ): void
  /**
   * 请求终态。`usage` 为 null = provider 没回报，**四个字段落 null 不落 0**——
   * 中转站漏 usage 是常态，记成 0 会让上下文锚点误判成「这次什么都没占」。
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
    /** provider 的原话。拿不到就空串——编一个是给账本注水。 */
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
   * 上一次 provider 真值回执，从账本取。**决定这一轮开头显示的是不是同一把尺。**
   *
   * 没有它，每个 run 的第一次请求只能报本地估算（系统性偏低），第二次请求起才切到
   * 真值：读数在每轮开头掉一次再弹回，而会话内容一个字没变。
   *
   * `throughMessageId`：这个回执覆盖到哪条消息为止。它之后的历史消息是
   * 锚点没算过的，要另外估。
   */
  anchor?: {
    tokens: number
    throughMessageId: string | null
    /**
     * 产生这个真值的那次请求用的模型。
     *
     * **与本轮不同就整条作废，没有修正可言**：各家 tokenizer 对同一份内容差到
     * 1.8 倍（`ai/tokens.ts` 的 `TokenDensity`），拿 A 的真值配 B 的窗口是量错了尺。
     */
    model: string
    /**
     * 那次请求的信封占用（`core` 的 `envelopeHeadTokens`）。
     *
     * 信封换一份时按它换头部：`tokens − headTokens + 本轮头部`。没有它就只能
     * 整条作废，而作废等于让裸估算尺接管显示、压缩触发、`max_tokens` 钳位三处。
     */
    headTokens: number
    /**
     * 产生这个真值的那次请求的信封指纹（`envelopeHashOf`）。
     *
     * 与本轮不一致时只换头部，不作废——信封之外的内容一个字没变，那一大段真值
     * 仍然成立。
     *
     * **`null` 不算「变了」。** 它是「这一行没记过指纹」（本次迁移之前建的），
     * 而把「不知道」当成「变了」和当成「没变」一样是编出来的确定性——
     * 同 `cachedTokens` 的立场：未回报不等于 0。新行一律带指纹，
     * 所以 null 只存在于存量行，保护对此后的每一次请求都成立。
     */
    envelopeFingerprint: string | null
  }
  /**
   * 本轮 transcript 归属的用户消息。
   *
   * 不带它的话本 run 内新产生的执行记录没有归属，压缩投影认不出它们的位置，
   * 因此 run 内涨起来的那部分永远压不掉——而涨的正是那部分。
   */
  userMessageId?: string
}
