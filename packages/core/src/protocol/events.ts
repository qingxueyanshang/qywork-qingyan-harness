/**
 * 流式事件协议：服务端到客户端的唯一实时通道。
 *
 * 设计约束：
 * 1. 桌面 WebView 与手机浏览器消费同一份事件流，不存在第二套协议。
 * 2. 事件按 `seq` 全序。客户端断线重连时携带 `lastSeq`，服务端补发缺口；
 *    移动端网络中断是常态，不能依赖重新获取全量数据来恢复。
 * 3. delta 类事件只携带增量，不携带累积文本。累积由客户端完成，以节省带宽（对手机端尤为重要）。
 * 4. 每个事件都能独立表明所属的 run / step，不依赖前序事件的隐含状态。
 */

import type { ConversationId, MessageId, RunId, StepId } from '../domain/ids.ts'
import type {
  Attachment,
  CompactionManifest,
  ContextBreakdown,
  ContextOmitted,
  Conversation,
  FileChange,
  FollowUp,
  Goal,
  NodeState,
  RunUsage,
  StopReason,
  TodoItem,
  ToolActionStatus,
  ToolOutcomeWire,
} from '../domain/model.ts'
import type { BrowserCapability, DesktopCapability } from './transport.ts'

export interface EventEnvelope<T extends AgentEvent = AgentEvent> {
  /** 本连接内全序单调递增，从 1 开始。 */
  seq: number
  /** 服务端发出时刻（epoch ms）。 */
  at: number
  /**
   * 事件所属的会话。缺省表示工作区级事件（如 git 状态），对所有客户端可见。
   *
   * 该字段必须随帧发出，不能只保存在服务端内存中。服务端用它过滤订阅；帧上不携带时，
   * 客户端只能假定收到的帧都属于已订阅的会话，而该假定在三处不成立：空订阅集被视为
   * 订阅全部、断线补发不过滤、`subscribe` 指令的往返窗口。任一处都会导致切换会话后显示上一个会话的内容。
   *
   * 事件体自带 `conversationId` 的只有 `conversation.updated` 与 `run.started` 两个，
   * 而混入其他会话的主要是 `text.delta` / `tool.*` / `run.finished` 等不带该字段的事件，
   * 因此归属只能放在信封上，而不是逐个事件补充字段。
   */
  conversationId?: ConversationId
  event: T
}

export type AgentEvent =
  // ── 会话 ──
  | ConversationCreatedEvent
  | ConversationUpdatedEvent
  | ConversationBusyEvent
  // ── run 生命周期 ──
  | RunStartedEvent
  | RunRequestEvent
  | RunRetryingEvent
  | RunFinishedEvent
  | RunErrorEvent
  // ── 模型输出 ──
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolGeneratingEvent
  // ── 工具 ──
  | ToolStartedEvent
  | ToolDeltaEvent
  | ToolFinishedEvent
  // ── 状态面板 ──
  | UsageEvent
  | ContextEvent
  | TodosEvent
  | GoalEvent
  | CompactionEvent
  // ── 工作区实时性 ──
  | FileChangedEvent
  | CanvasRunEvent
  | GitStateEvent
  | BrowserStateEvent
  | DesktopStateEvent
  | DesktopTargetEvent
  // ── 多智能体 ──
  | TeamMemberEvent
  | TeamOutputEvent
  // ── 跟进消息 ──
  | QueueChangedEvent
  | MessageInjectedEvent

// ─────────────────────────────── 会话 ───────────────────────────────

/**
 * 服务端自行创建了一条会话。
 *
 * 工作区级事件：信封上不带 `conversationId`。若按会话过滤下发，只有已订阅该会话的客户端
 * 能收到，而本事件要解决的正是该会话尚未出现在列表中的问题。
 *
 * 负载是完整的 `Conversation`，客户端直接插入列表，无需重新请求列表。
 *
 * 只在定时任务认领新建会话时发出：用户点击「新对话」经由 HTTP，响应体中已包含该会话。
 */
export interface ConversationCreatedEvent {
  type: 'conversation.created'
  conversation: Conversation
}

/**
 * 会话属性变更：模型、标题、最近修改时间。
 *
 * 必须经事件总线广播，不能只返回给发起方：手机与桌面可能同时打开同一个会话，
 * 一端切换模型而另一端仍显示旧模型时，下一轮的实际用量与计价将与界面不一致。
 *
 * 不设「会话被删除 / 被归档」事件：该事件没有消费端，添加即成为未接通的链路（C1 第 1 款）。
 * 代价是另一端需刷新一次列表才能看到变化。
 */
export interface ConversationUpdatedEvent {
  type: 'conversation.updated'
  conversationId: ConversationId
  /** 接口名。与 `model` 一同发出：两端显示的当前模型由接口与模型共同确定，而不是仅由模型确定。 */
  provider: string
  model: string
  title: string
  /** 账本中的 `updated_at`，即侧栏中该会话行显示的时间。 */
  updatedAt: number
}

/**
 * 会话是否正在运行。
 *
 * 工作区级事件：信封上不带 `conversationId`，所有客户端都能收到。
 * run 生命周期的三个事件按订阅过滤，只有打开该会话的客户端能收到；而左栏需要为
 * 列表中的每个会话渲染状态，只能取得当前会话的 run 事件时，界面无法显示哪些会话正在运行。
 *
 * 本事件与 run 生命周期不构成两本账：两者都出自 `RunManager` 的占位 / 登记 / 注销，
 * 这是判定会话是否在运行的唯一裁决点。不要在别处补发本事件。
 */
export interface ConversationBusyEvent {
  type: 'conversation.busy'
  conversationId: ConversationId
  busy: boolean
}

// ─────────────────────────────── 跟进消息 ───────────────────────────────

/**
 * 会话中排队的跟进消息。内容是完整快照，不是增量。
 *
 * 使用增量（入队 / 出队 / 状态变更）时，客户端需自行维护一份与服务端一致的队列，
 * 同时客户端还有乐观添加的本地卡片；服务端对重复的 clientRequestId 去重时，两份账必然分叉。
 * 整体替换快照不存在该问题，且队列长度很小，无需节省这部分字节。
 *
 * 按会话过滤下发（与 `conversation.busy` 不同）：卡片只出现在当前打开的会话中。
 */
export interface QueueChangedEvent {
  type: 'queue.changed'
  conversationId: ConversationId
  queue: FollowUp[]
}

/**
 * 一条跟进消息已注入当前轮次。
 *
 * `stepId` 指向 `steps` 中 `kind='user'` 的行，必须携带，理由与
 * `ThinkingDeltaEvent.stepId` 相同：由客户端自行生成 id 时，实时插入的气泡
 * 与刷新后按 step 重建的气泡会成为两条记录。
 *
 * 客户端收到本事件时须同时移除队列中对应的卡片；队列的权威仍是 `queue.changed`，
 * 本事件只负责会话流中的这一条消息。
 */
export interface MessageInjectedEvent {
  type: 'message.injected'
  runId: RunId
  stepId: StepId
  /** 队列条目的 id，客户端据此移除对应的卡片。 */
  followUpId: string
  content: string
  attachments?: Attachment[]
  /**
   * 同 `Message.origin`：消息的投递者，缺席表示用户本人。
   *
   * 界面据此决定将该帧渲染为回执条目还是用户气泡。必须与落库一侧取值相同
   * （step 的 `payload.origin`），否则实时渲染为气泡、刷新后又变为回执条目。
   */
  origin?: 'subagent' | 'workflow'
}

// ─────────────────────────────── run 生命周期 ───────────────────────────────

export interface RunStartedEvent {
  type: 'run.started'
  runId: RunId
  conversationId: ConversationId
  model: string
  userMessageId: MessageId | null
  /**
   * 本轮回答的用户消息正文。服务端自行发起的轮次依靠它渲染用户气泡。
   *
   * 用户在界面上按回车时，气泡由客户端乐观插入；而目标自动继续、定时触发、
   * 跟进消息单独发起这三条路径没有客户端动作，正文只存在于服务端刚写入 `messages`
   * 表的行中。缺少该字段时，这几轮在界面上只有模型的回答而没有用户气泡，
   * 用户需刷新页面才能看到自己的消息，而账本中该消息一直存在。
   *
   * 客户端将正文与最后一条用户气泡比对：一致时把 id 替换为此处的真实值
   * （乐观插入使用本地 id），不一致时补充一条。
   *
   * `origin` 同 `Message.origin`：消息的投递者，缺席表示用户本人。界面据此决定将该帧
   * 渲染为回执条目还是用户气泡。必须与落库一侧取值相同（`messages.origin`），
   * 否则实时渲染为气泡、刷新后又变为回执条目。
   */
  userMessage: {
    content: string
    attachments?: Attachment[]
    origin?: 'subagent' | 'workflow'
  } | null
}

export interface RunFinishedEvent {
  type: 'run.finished'
  runId: RunId
  status: 'done' | 'failed' | 'interrupted'
  /** 始终非空：不存在未给出原因的结束。 */
  stopReason: StopReason
  /** 停止的具体依据。`no_progress` 时记录重复的内容；其余终态不带该字段。 */
  stopDetail?: string
  usage: RunUsage
  /**
   * 本 run 累计的文件变更汇总，供「N 个文件已更改 +x -y」一栏展示。
   *
   * 本事件不含步数与耗时，不要添加。步数在本事件上指循环轮次，而 `Run.stepCount` 指
   * steps 表中的行数，同名不同义；耗时由客户端按自身计时计算（从收到 `run.started`
   * 到收到本事件的间隔），因为用户关心的是等待时长。两个字段均无消费者。
   */
  fileChanges: FileChange[]
}

/**
 * 本轮出错。不保证存在对应的 `run.finished`。
 *
 * 以下四种情况在本轮开始之前即被拒绝：会话已有任务在运行、未找到会话的项目目录、
 * 三处均未取得模型、装配 adapter 时抛错（未配置 key、档案解析失败）。它们发生在
 * run 建立之前：`runId` 为空串，账本中也没有本轮的 run 行，因此不会再有 `run.finished`。
 *
 * 这几种情况的终态是 `conversation.busy: false`，由服务端释放会话占位时发出。
 * 客户端不要依据本事件清除「运行中」状态：忙闲的裁决点只有占位与登记一处，
 * 在此处增加判断即形成第二本账。唯一不附带忙闲事件的是「会话已有任务在运行」：
 * 占位属于另一轮，该会话此时确实仍在运行，清除状态是错误的。
 */
export interface RunErrorEvent {
  type: 'run.error'
  /** 本轮开始之前被拒绝时为空串：此时 run 尚不存在。 */
  runId: RunId
  /** 归类后的错误码，前端据此决定提示内容（如配置 key、充值、更换模型）。 */
  code: ErrorCode
  message: string
  detail?: Record<string, unknown>
}

/**
 * 本次 provider 请求所处的阶段。
 *
 * `sent` 表示已调用底层 fetch（不表示中转已接收），`headers` 表示响应头已到达而模型尚未输出。
 * 两个阶段各发一次，携带同一个 `requestId`，界面据此把「正在重连」依次替换为「正在请求」
 * 与「等待响应」。缺少本事件时，退避结束到首段内容之间没有任何事件，
 * 界面只能停留在上一阶段的状态文字上。
 *
 * `attempt` 是本次故障链内的重发序号（首发为 0），与 `run.retrying` 共用同一份预算；
 * 它不是 `provider_requests.retry_index`：该列按 turn 重新计数，跨自动继续的轮次会清零。
 */
export interface RunRequestEvent {
  type: 'run.request'
  runId: RunId
  /** `provider_requests` 中对应行的 id；刷新快照与实时事件据此对应到同一次请求。 */
  requestId: string
  phase: 'sent' | 'headers'
  attempt: number
  /** 重发上限。真源是 `agent` 的 `MAX_RESENDS`，界面不硬编码该值。 */
  max: number
  /**
   * 该阶段的观察时刻。`headers` 取传输层记录的响应头到达时刻，不取事件产生时刻；
   * 两者之差即首包等待的毫秒数。
   */
  at: number
}

/**
 * 流中断后正在重发。
 *
 * 两种形式都发出本事件（判据在 `agent/loop/attempt.ts` 的尝试循环中）：正文未显示时，
 * 原样重发同一份字节；正文已显示时，将其作为上一条消息加入 transcript，携带当前上下文重发。
 * 界面据此将阶段字段显示为「等待重试，N 秒后」；否则界面显示的是失败请求遗留的
 * 部分思考与「正在思考…」，而模型此时没有任何输出。
 *
 * 不设配对的「重发结束」事件。下一次 `run.request` 即结束信号，
 * 再发一条事件等于在两处表达同一件事，两处必然漂移。
 */
export interface RunRetryingEvent {
  type: 'run.retrying'
  runId: RunId
  /** 失败请求在 `provider_requests` 中的行 id。 */
  requestId: string
  /** 重发序号，从 1 开始。 */
  attempt: number
  /** 重发上限。真源是 `agent` 的 `MAX_RESENDS`，界面不硬编码该值。 */
  max: number
  /** 本次等待时长。0 表示上游要求立即重发。 */
  backoffMs: number
  /** 等待开始的时刻。倒计时截止点为 `at + backoffMs`，客户端不使用本地当前时刻计算。 */
  at: number
  /**
   * 被本次重发取代的思考 step。
   *
   * 失败请求的部分输出仍保留在账本中供诊断，但不能继续显示在普通会话流中；否则新生成的内容
   * 紧随其后，看起来像思考被截断后重复。ID 由产生这些 step 的 AgentLoop 给出，
   * 前端不按「末尾几条」推测。
   *
   * 携带当前上下文重发时为空：该段思考随已显示的正文一起保留在 transcript 中。
   */
  failedThinkingStepIds: StepId[]
}

export type ErrorCode =
  | 'no_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'insufficient_quota'
  | 'context_overflow'
  | 'model_not_found'
  /**
   * 尚未配置任何模型：本轮显式指定、会话当前、配置默认三处均未取得模型。
   *
   * 与 `model_not_found` 区分：后者表示指定的模型在上游不存在，本码表示未配置任何模型，
   * 修复方式不同（前者修改模型名，后者在设置中选择接口与模型）。始终不可重发。
   */
  | 'no_model'
  /**
   * 上游明确拒绝了本次请求（4xx 参数错误、网关按字节数拒收）。
   *
   * 与 `provider_unavailable` 的区别在于同一份字节重发后是否可能得到不同结果：
   * 本码始终不会，因此不在 `agent` 的重发表中。
   */
  | 'invalid_request'
  | 'provider_unavailable'
  | 'network_error'
  | 'stream_idle_timeout'
  | 'tool_execution_failed'
  | 'workspace_unavailable'
  | 'internal_error'

// ─────────────────────────────── 模型输出 ───────────────────────────────

export interface TextDeltaEvent {
  type: 'text.delta'
  runId: RunId
  stepId: StepId
  /** 仅含增量。 */
  delta: string
  /** 该段内容到达本地的时刻，与写入 `provider_requests.last_content_at` 的值相同。 */
  at: number
}

/** 工具参数正在生成。它还不是可执行的调用，不创建工具步骤，也不写入模型历史。 */
export interface ToolGeneratingEvent {
  type: 'tool.generating'
  runId: RunId
  /** 该段内容到达本地的时刻，与写入 `provider_requests.last_content_at` 的值相同。 */
  at: number
}

/**
 * 思考增量。与 `text.delta` 结构相同，`stepId` 指向 `steps` 中 `kind='thinking'` 的行。
 *
 * `stepId` 不是可选字段。缺少它时客户端只能自行生成 id，实时条目的 id 与刷新后按 step
 * 重放得到的 id 永不相等，同一段思考在两条路径下成为两条记录。
 */
export interface ThinkingDeltaEvent {
  type: 'thinking.delta'
  runId: RunId
  stepId: StepId
  delta: string
  /** 部分 provider 只返回摘要级思考。 */
  redacted: boolean
  /** 该段内容到达本地的时刻，与写入 `provider_requests.last_content_at` 的值相同。 */
  at: number
}

/** 一段完整 assistant 文本已落库，客户端可以用它替换本地累积的 delta。 */
// ─────────────────────────────── 工具 ───────────────────────────────

export interface ToolStartedEvent {
  type: 'tool.started'
  runId: RunId
  stepId: StepId
  toolCallId: string
  toolName: string
  /** 同一 provider 响应中的调用共用该值。 */
  batchId: string
  callIndex: number
  /** index 相同表示属于同一批并行执行的调用。 */
  waveIndex: number
  args: Record<string, unknown>
  /**
   * 动作语义，前端据此选择图标与措辞；后端不下发 UI 文案。
   *
   * 必填。名称不在注册表中的调用不会进入此处：`agent/loop/tool-wave.ts` 在编排批次之前
   * 已将其全部拦截（这类调用不是工具，而是 provider 违反了下发的工具表）。
   * 因此每条 `tool.started` 都对应一个真实的 `ToolSpec`，动作总能解析得出。
   */
  action: ActionDescriptor
}

export interface ActionDescriptor {
  kind: ActionKind
  /** 被操作对象的类别名，如 'file' / 'command' / 'branch'。 */
  objectLabel: string
  /** 可稳定归属的单一目标，如文件路径。没有时为 null。 */
  target: string | null
}

/**
 * 一次工具调用面向用户表达的唯一动作语义，共七个取值。
 *
 * `run` 与 `call` 的分界是本机执行还是跨进程 / 跨网络调用：`run_command` 直接在
 * 用户本机执行，属于 `run`；MCP server 与插件提供的工具是外部进程提供的能力，
 * 一律属于 `call`：其行为不由本机决定，界面上也不应称为「运行」。
 *
 * 该维度只表达执行了什么动作，不表达所属领域。不要加入 `search / fetch / plan / delegate`
 * 等取值：它们都是领域而非动作（搜索属于查询，fetch 属于读取，plan 属于创建或编辑，
 * delegate 属于运行）；加入后 `plan` 与对象「计划」会组合出「规划计划」这类动宾同义重复。
 * 领域由另一个维度（工具分类）表达。
 *
 * 不设「未知 / 其他」取值。动作由工具在注册时声明，注册表是唯一权威；
 * 名称不在表中的调用在 `agent/loop/tool-wave.ts` 中即被拦截在执行链之外，不会成为 step，
 * 因此该维度上不存在动作未知的行。
 *
 * 这些值会写入磁盘（`steps.payload.action.kind`），因此修改该联合类型不只是修改类型别名：
 * 删除、改名，或把某类工具改归到其他取值时，必须在同一次改动中附带数据迁移
 * （示例为 `store/schema.ts` 的迁移 16）。缺少迁移时不会报错，而是回放历史会话时
 * 卡片标题无法取得动词，界面直接显示 `undefined`。
 */
export type ActionKind = 'query' | 'read' | 'write' | 'edit' | 'delete' | 'run' | 'call'

/** 长时间运行工具的中间输出（shell stdout、下载进度、子 agent 的输出流）。 */
export interface ToolDeltaEvent {
  type: 'tool.delta'
  runId: RunId
  stepId: StepId
  channel: 'stdout' | 'stderr' | 'progress'
  delta: string
}

export interface ToolFinishedEvent {
  type: 'tool.finished'
  runId: RunId
  stepId: StepId
  toolCallId: string
  status: ToolActionStatus
  outcome: ToolOutcomeWire
  durationMs: number
}

// ─────────────────────────────── 状态面板 ───────────────────────────────

export interface UsageEvent {
  type: 'usage'
  runId: RunId
  usage: RunUsage
}

export interface ContextEvent {
  type: 'context'
  runId: RunId
  tokens: number
  /**
   * 本次请求中未计入 `tokens` 的视频段数：视频的占用只有接口返回的真实值可信，本地估算不包含视频。
   * 缺席即 0。界面据此将读数显示为「未知」。
   */
  unmeasuredVideos?: number
  limit: number
  /** 保留一位小数。1M 窗口下取整会把 2139 显示为 0%，因此小数位不能省略。 */
  percent: number
  /**
   * 该总数是实测值、由最近真实值向前投影的值，还是纯本地估算。
   *
   * 必须显式标明。`actual` 是当前请求回执中的值，`projected` 是最近真实值加本地增量，
   * `estimated` 是纯字符上界。不要改用 `max(全量估算, provider 真值)`：
   * 两个数的计量方式不同，锚点失效时显示值会无故跳回字符上界。
   */
  source: 'actual' | 'projected' | 'estimated'
  /**
   * 超过该值时，下一次发送前会执行一次压缩。
   *
   * 读数条上渲染该刻度，使压缩的触发点可见；缺少刻度时，用户只能根据压缩卡的出现
   * 反推触发点。
   */
  compactAt: number
  /** 分组占用，供上下文面板渲染堆叠条。 */
  breakdown: ContextBreakdown
  /** 未发送给模型的原文部分。 */
  omitted: ContextOmitted
}

export interface TodosEvent {
  type: 'todos'
  runId: RunId
  todos: TodoItem[]
}

/**
 * 目标变更。有两个生产者，都必须发出：模型调用三个目标工具时由端口发出
 * （`runtime/session.ts`），服务端自动继续时由 `run-control.ts` 发出。
 *
 * 不带 runId。目标是会话级的，修改它的动作有一半发生在任何 run 之外
 * （自动继续前将轮次加 1、用户在界面上点击继续），写入空 runId 只会使
 * 消费方将其归到某一轮上。所属会话由信封上的 `conversationId` 表达。
 */
export interface GoalEvent {
  type: 'goal'
  goal: Goal
}

/**
 * 一次压缩的结果。
 *
 * 四个 phase 不能合并为三个。`skipped`（没有可压缩的内容）与 `failed`（压缩失败）
 * 对用户含义不同：前者无需任何操作，后者表示上下文仍然已满、下一轮很可能
 * 直接报错。合并后界面只能一律显示为失败。
 *
 * 被中断的压缩不发出事件：它没有写入任何内容，且 run 随即以 `user_interrupt` 收尾。
 */
export interface CompactionEvent {
  type: 'compaction'
  runId: RunId
  phase: 'started' | 'done' | 'skipped' | 'failed'
  manifest?: CompactionManifest
  /** `phase='done'` 专有：摘要线随之前移（true），或只收纳了工具正文（false）。 */
  summarized?: boolean
  reasonCode?: string
}

// ─────────────────────────────── 工作区实时性 ───────────────────────────────

/**
 * 文件变更广播，是实时预览的基础：agent 修改文件后，桌面与手机同时可见。
 * 有可靠明细时按路径去重；执行类工具只能确定文件快照可能已改变时，`changes` 为空，
 * 消费方仍须使文件视图失效，但不能据此编造增删统计。
 */
export interface FileChangedEvent {
  type: 'file.changed'
  changes: FileChange[]
  /** 所属的 run；外部编辑器修改的文件为 null。 */
  runId: RunId | null
}

/**
 * 画布上一张生成卡的运行状态。工作区级事件，信封上不带 `conversationId`。
 *
 * 与 `file.changed` 分开发送：后者表示磁盘内容已变化，本事件表示生成卡的状态。生成图像失败时
 * 不写入任何文件，只有 `file.changed` 时界面收不到失败，卡片会一直停留在生成中。
 */
export interface CanvasRunEvent {
  type: 'canvas.run'
  /** 画布所在的项目。同时打开多个项目时据此丢弃其他项目的事件，与 `git.state` 相同。 */
  workspaceId: string
  /** 画布文件的工作区相对路径（正斜杠）。 */
  path: string
  nodeId: string
  state: 'running' | 'done' | 'failed'
  /** `failed` 时的错误原文。 */
  message?: string
}

export interface GitStateEvent {
  type: 'git.state'
  /**
   * 该状态所属的项目。
   *
   * 不能省略。git 状态是工作区级事件，经全局广播（`bus.visibleTo` 对不属于任何会话的
   * 事件一律放行）。同时打开多个项目时，若不带该字段，B 项目的分支会显示在
   * 正在查看 A 项目的界面上，且该值看起来完全合理，难以察觉。
   */
  workspaceId: string
  /**
   * 当前分支名，是本事件唯一的状态字段。
   *
   * 不要添加改动数、暂存数、领先 / 落后数：它们没有消费者。界面上唯一使用 git 状态的
   * 是输入框上方的分支标签。会话修改了哪些文件由 step 账本的 `fileChanges` 回答，
   * 不经由本事件。
   */
  branch: string
}

/**
 * 内置浏览器能力已变化。进程级事件，信封上不带 `conversationId`。
 *
 * 握手只报告一次，而原生宿主在应用启动后才建立连接：只有握手中的能力时，
 * 界面要等到下一次重连才能显示浏览器入口。本事件与握手中的 `capabilities.browser`
 * 是同一份投影，客户端原地替换。
 */
export interface BrowserStateEvent {
  type: 'browser.state'
  browser: BrowserCapability
}

/**
 * 电脑控制能力已变化。进程级事件，信封上不带 `conversationId`。
 *
 * 理由与 `browser.state` 相同：桌面宿主在应用启动后才建立连接，授权与 worker 状态
 * 之后还会变化。本事件与握手中的 `capabilities.desktop` 是同一份投影。
 */
export interface DesktopStateEvent {
  type: 'desktop.state'
  desktop: DesktopCapability
}

/**
 * 桌面占用的完整快照。物理桌面只有一个，因此全局广播；目标归属于持有桌面的
 * 执行者所在的会话，界面不能把其他会话的操作显示在当前会话名下。
 *
 * `null` 表示没有任何执行者持有桌面目标。执行者释放、宿主断开、能力下线时都要将其重置为
 * `null`：保留过期的应用名会使界面持续显示正在操作一个早已结束的目标。
 */
export interface DesktopTargetEvent {
  type: 'desktop.target'
  target: {
    conversationId: string
    app: string
    /** 本次占用已使用过前台接管；后台读取不会撤销该标记，释放时随目标一并清空。 */
    foreground: boolean
  } | null
}

// ─────────────────────────────── 多智能体 ───────────────────────────────

/**
 * 单次派发任务卡上唯一子节点的 id。
 *
 * 一次 `subagent` 调用即一张只有一个节点的图，与编排共用下方的事件通道，
 * 而该通道按节点 id 定位卡片中的节点，因此两侧必须使用同一个值。
 *
 * 该 id 不显示在界面上：界面上该节点显示的是执行者名称。
 */
export const SUBAGENT_NODE_ID = 'child'

/**
 * 派发任务卡上一个节点的状态已变化。与写入 step payload `nodes` 的是同一份 `NodeState`：
 * 流式期间读取本事件，刷新后读取落库的数据，两者结构相同。
 */
export interface TeamMemberEvent {
  type: 'team.member'
  runId: RunId
  /** 所属卡片：该次派发调用的 step id。一条会话中可能有多张图卡。 */
  stepId: string
  nodeId: string
  state: NodeState
}

/**
 * 外部 CLI 节点的中间输出。
 *
 * 仅外部 CLI 节点发出本事件：内置子 agent 的过程保留在其子会话中，打开节点即可查看；
 * 外部 CLI 是本机的另一个进程，执行完毕前的输出若不发出，界面无从查看。
 *
 * 与 `tool.delta` 分开，是因为多了一个维度：一张图中可以有多个 CLI 节点同时运行，
 * 混入同一个 `stepId` 的缓冲后无法区分各段输出所属的节点。
 *
 * 不落库：流式期间读取本事件，刷新后读取落库的逐节点产出。
 */
export interface TeamOutputEvent {
  type: 'team.output'
  runId: RunId
  /** 所属的图卡。 */
  stepId: string
  /** 所属的节点。 */
  nodeId: string
  /**
   * stdout 与 stderr 合并为一条流，不作区分：观察进程执行时二者本身即交错输出，
   * 分开需要多一份状态或一个无人读取的字段。执行失败的诊断另有来源：
   * 节点终态中的 `error` 包含 stderr 的末尾部分。
   */
  delta: string
}
