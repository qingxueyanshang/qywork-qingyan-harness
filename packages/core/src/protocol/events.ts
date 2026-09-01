/**
 * 流式事件协议 —— 服务端 → 客户端的唯一实时通道。
 *
 * 设计约束：
 * 1. 桌面 WebView 和手机浏览器消费**同一份**事件流，没有第二套协议。
 * 2. 事件按 `seq` 全序。客户端断线重连时带上 `lastSeq`，服务端补发缺口——
 *    移动端在地铁里断网是常态，不能靠「重新拉一次全量」糊过去。
 * 3. delta 类事件只带增量，不带累积文本。累积由客户端做，省带宽（手机端关键）。
 * 4. 每个事件都能独立解释自己属于哪个 run / step，不依赖前序事件的隐含状态。
 */

import type { ConversationId, MessageId, RunId, StepId } from '../domain/ids.ts'
import type {
  Attachment,
  CompactionManifest,
  ContextBreakdown,
  ContextOmitted,
  FileChange,
  FollowUp,
  Goal,
  RunUsage,
  StopReason,
  TodoItem,
  ToolActionStatus,
  ToolOutcomeWire,
} from '../domain/model.ts'

export interface EventEnvelope<T extends AgentEvent = AgentEvent> {
  /** 本连接内全序单调递增，从 1 开始。 */
  seq: number
  /** 服务端发出时刻（epoch ms）。 */
  at: number
  /**
   * 这条事件属于哪个会话。缺省 = 工作区级事件（git 状态那类），人人可见。
   *
   * **必须在帧上，不能只在服务端内存里。** 服务端拿它做订阅过滤，但它同时必须随帧
   * 发出：不发的话客户端只能假定收到的帧都属于已订阅的会话。
   * 那个前提有三处不成立（空订阅集被当成全订阅、断线补发不过滤、
   * `subscribe` 指令的往返窗口），任何一处都表现为「切了会话，内容是上一条的」。
   *
   * 事件体自己带 `conversationId` 的只有两个（`conversation.updated`、`run.started`），
   * 而串台的主力是 `text.delta` / `tool.*` / `run.finished` 这些不带的——
   * 所以归属只能放在信封上，不是逐个事件补字段。
   */
  conversationId?: ConversationId
  event: T
}

export type AgentEvent =
  // ── 会话 ──
  | ConversationUpdatedEvent
  | ConversationBusyEvent
  // ── run 生命周期 ──
  | RunStartedEvent
  | RunRetryingEvent
  | RunFinishedEvent
  | RunErrorEvent
  // ── 模型输出 ──
  | TextDeltaEvent
  | ThinkingDeltaEvent
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
  | GitStateEvent
  // ── 多智能体 ──
  | TeamMemberEvent
  | TeamOutputEvent
  // ── 跟进消息 ──
  | QueueChangedEvent
  | MessageInjectedEvent

// ─────────────────────────────── 会话 ───────────────────────────────

/**
 * 会话属性变更：模型、标题、最近修改时间。
 *
 * 必须走事件总线广播，不能只回给发起方：手机和桌面可能同时开着同一个会话，
 * 一端切了模型另一端还显示旧的，下一轮的实际用量和计价就对不上界面。
 *
 * **没有「会话被删 / 被归档」的事件**：没有消费端，加了就是死链路（C1 第 1 款）。
 * 代价是另一端要刷新一次列表才看得到。
 */
export interface ConversationUpdatedEvent {
  type: 'conversation.updated'
  conversationId: ConversationId
  /** 接口名。与 `model` 一起发——两端显示的「当前用谁」是这一对，不是模型一个。 */
  provider: string
  model: string
  title: string
  /** 账本里的 `updated_at`，侧栏那一行显示的就是它。 */
  updatedAt: number
}

/**
 * 这条会话在不在跑。
 *
 * **工作区级事件：信封上不带 `conversationId`，所有客户端都收得到。**
 * run 生命周期那三条按订阅过滤，只有开着这条会话的客户端收得到；而左栏要为
 * 列表里**每一条**画状态，取不到别人的 run 事件就只能给当前那条画，
 * 因此「哪条在跑」这个问题在界面上无解。
 *
 * 与 run 生命周期不是两本账：两者都出自 `RunManager` 的占位 / 登记 / 注销，
 * 那是「这条会话在不在跑」唯一的裁决点。**不要在别处补发这条事件。**
 */
export interface ConversationBusyEvent {
  type: 'conversation.busy'
  conversationId: ConversationId
  busy: boolean
}

// ─────────────────────────────── 跟进消息 ───────────────────────────────

/**
 * 这条会话排着哪些跟进消息。**整份快照，不是增量。**
 *
 * 增量（进一条 / 出一条 / 翻一次档）要客户端自己维护一份能对得上的队列，
 * 而它同时还有乐观加的本地卡——两份账在「服务端去重掉一条重复的 clientRequestId」
 * 这种时刻必然分叉。快照整体替换没有这个问题，队列长度也不值得省这点字节。
 *
 * 按会话过滤下发（与 `conversation.busy` 不同）：卡片只出现在打开着的那条会话里。
 */
export interface QueueChangedEvent {
  type: 'queue.changed'
  conversationId: ConversationId
  queue: FollowUp[]
}

/**
 * 一条跟进消息刚被注入当前这一轮。
 *
 * `stepId` 指向 `steps` 里那条 `kind='user'` 的行——**必须带**，理由与
 * `ThinkingDeltaEvent.stepId` 相同：客户端自己造 id 的话，实时插进去的那条气泡
 * 与刷新后按 step 重建出来的是两条。
 *
 * 收到它的客户端同时要把队列里那张卡摘掉；队列的权威仍是 `queue.changed`，
 * 这条只负责会话流里那一格。
 */
export interface MessageInjectedEvent {
  type: 'message.injected'
  runId: RunId
  stepId: StepId
  /** 队列条目的 id，客户端据此摘掉对应的卡。 */
  followUpId: string
  content: string
  attachments?: Attachment[]
}

// ─────────────────────────────── run 生命周期 ───────────────────────────────

export interface RunStartedEvent {
  type: 'run.started'
  runId: RunId
  conversationId: ConversationId
  model: string
  userMessageId: MessageId | null
  /**
   * 这一轮回答的那条用户消息正文。**服务端自己发起的轮次靠它才画得出气泡。**
   *
   * 用户在界面上按回车时，那条气泡是客户端乐观插进去的；而目标续起、定时触发、
   * 跟进消息火发这三条路没有客户端动作，正文只存在于服务端刚写进 `messages`
   * 表的那一行。少了它，那几轮在界面上是「模型自己开口说了一段」，
   * 用户要刷新一次页面才看得到自己那句话——而账本里它一直在。
   *
   * 客户端按正文与最后一条用户气泡比对：对得上就把 id 换成这里的真值
   * （乐观插入用的是本地 id），对不上就补一条。
   */
  userMessage: { content: string; attachments?: Attachment[] } | null
}

export interface RunFinishedEvent {
  type: 'run.finished'
  runId: RunId
  status: 'done' | 'failed' | 'interrupted'
  /** 永远非空——不存在「静默完成」。 */
  stopReason: StopReason
  usage: RunUsage
  /**
   * 本 run 累计的文件变更汇总，供「N 个文件已更改 +x -y」条展示。
   *
   * **这里没有步数与耗时。** 步数在这个事件上是「循环轮次」，而 `Run.stepCount` 是
   * 「steps 表里的行数」，同名不同义；耗时客户端按自己那块表算（收到 `run.started`
   * 到收到这条的间隔），因为用户问的是等待时长。两个都没有消费者，所以删掉——
   * 协议里留着一个没人读、还和别处同名不同义的字段，比没有更坏。
   */
  fileChanges: FileChange[]
}

export interface RunErrorEvent {
  type: 'run.error'
  runId: RunId
  /** 归类后的错误码，前端据此决定提示（如去配 key、去充值、换模型）。 */
  code: ErrorCode
  message: string
  detail?: Record<string, unknown>
}

/**
 * 断流后正在原样重发。
 *
 * 只在**模型可见输出为零**时发得出来（判据在 `agent/loop.ts` 的尝试循环），
 * 所以它恒等于「刚才那次没有产出，同一份字节再发一次」。界面拿它把阶段那一格
 * 改口成「正在重连 N / M」——不这么说的话，界面上是失败那次留下的半截思考
 * 配一句「正在思考…」，而模型此刻一个字都没在写。
 *
 * **没有配对的「重发结束」事件。** 新那次的第一条输出就是结束信号，
 * 再发一条等于同一件事两处各说一遍，且两处必然漂移。
 */
export interface RunRetryingEvent {
  type: 'run.retrying'
  runId: RunId
  /** 第几次重发，从 1 起。 */
  attempt: number
  /** 上限。真源是 `agent` 的 `MAX_RESENDS`，界面不自己写死这个数。 */
  max: number
}

export type ErrorCode =
  | 'no_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'insufficient_quota'
  | 'context_overflow'
  | 'model_not_found'
  /**
   * 上游明确拒绝了这一份请求（4xx 参数错误、网关按字节数拒收）。
   *
   * 与 `provider_unavailable` 的区别是**同一份字节再发一次会不会有别的结果**：
   * 这个码恒定不会，所以它不在 `agent` 的重发表里。
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
  /** 只有增量。 */
  delta: string
}

/**
 * 思考增量。与 `text.delta` 同构，`stepId` 指向 `steps` 里那条 `kind='thinking'` 的行。
 *
 * **这个字段不是可选的。** 没有它客户端只能自己造 id，因此实时条目的 id
 * 与刷新后按 step 重放出来的 id 永不相等，同一段思考在两条路径下成了两条记录。
 */
export interface ThinkingDeltaEvent {
  type: 'thinking.delta'
  runId: RunId
  stepId: StepId
  delta: string
  /** 部分 provider 只给摘要级思考。 */
  redacted: boolean
}

/** 一段完整 assistant 文本已落库，客户端可以用它替换本地累积的 delta。 */
// ─────────────────────────────── 工具 ───────────────────────────────

export interface ToolStartedEvent {
  type: 'tool.started'
  runId: RunId
  stepId: StepId
  toolCallId: string
  toolName: string
  /** 同一 provider 响应的调用共享。 */
  batchId: string
  callIndex: number
  /** 同 index = 同一次水平并行波次。 */
  waveIndex: number
  args: Record<string, unknown>
  /**
   * 动作语义，前端据此选图标与措辞；后端不下发 UI 文案。
   *
   * **必填。** 名字不在注册表里的调用根本走不到这里——`loop.ts` 在编排波次之前
   * 就把它们整段挡掉了（那不是工具，是 provider 违反了下发的工具表）。
   * 所以每一条 `tool.started` 背后都有一个真实的 `ToolSpec`，动作永远解析得出来。
   */
  action: ActionDescriptor
}

export interface ActionDescriptor {
  kind: ActionKind
  /** 被操作对象的类别名，如 'file' / 'command' / 'branch'。 */
  objectLabel: string
  /** 可稳定归属的单一目标，如文件路径。没有则 null。 */
  target: string | null
}

/**
 * 一次工具调用对用户表达的**唯一动作语义**。七个，就这七个。
 *
 * `run` 与 `call` 的分界是**本机执行还是跨进程/跨网络调用**：`run_command` 直接在
 * 用户这台机器上执行，是 `run`；MCP server 与插件贡献的工具是外部进程提供的能力，
 * 一律是 `call`——它们能做什么不由本机决定，界面上也不该说成「运行」。
 *
 * 这条轴**只表达「做了什么动作」，不表达「属于哪个领域」**。别把
 * `search / fetch / plan / delegate` 这类值加回来——它们全是领域不是动作
 * （搜索是查询的一种、fetch 是读、plan 是创建或编辑、delegate 是运行），
 * 混进来的直接后果是 `plan` + 对象「计划」拼出「规划计划」这种动宾同义反复。
 * 领域该走另一条轴（工具分类）。
 *
 * **没有「未知 / 其他」这一档，也不需要有。** 动作由工具在注册期声明，注册表是
 * 唯一权威；名字不在表里的调用在 `loop.ts` 里就被挡在执行链之外，永远不会
 * 变成一条 step——所以这条轴上不存在「不知道是什么动作」的行。
 *
 * **这些值会落盘**（`steps.payload.action.kind`），所以改这个联合类型不是改一个
 * 类型别名：删掉、改名，或把某一类工具改归到别的值，同一次改动里必须带一条数据迁移
 * （样例 `store/schema.ts` 的迁移 16）。不转的表现不是报错，是回放历史会话时
 * 卡片标题查不到动词，界面上直接露出 `undefined`。
 */
export type ActionKind = 'query' | 'read' | 'write' | 'edit' | 'delete' | 'run' | 'call'

/** 长工具的中途输出（shell stdout、下载进度、子 agent 的流）。 */
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
  limit: number
  /** 保留一位小数。1M 窗口下取整会把 2139 显示成 0%，那一位是有信息量的。 */
  percent: number
  /**
   * 这个总数是**实测**、由最近真值校准，还是纯本地估算。
   *
   * 必须显式说出来。`actual` 是当前请求回执，`calibrated` 是最近真值加已换尺增量，
   * `estimated` 才是纯字符上界。**不要退回 `max(全量估算, provider 真值)`**：
   * 两个数出自两把尺，锚点一失效显示值会无理由跳回字符上界。
   */
  source: 'actual' | 'calibrated' | 'estimated'
  /**
   * 越过它就会在下一次发送前压一次。
   *
   * 读数条上画这一刻度，是为了让「什么时候会压」可见——没有它，用户只能从
   * 「压缩卡突然出现」倒推触发点在哪。
   */
  compactAt: number
  /** 分组占用，供上下文面板画堆叠条。 */
  breakdown: ContextBreakdown
  /** 没有发给模型的那部分原文。 */
  omitted: ContextOmitted
}

export interface TodosEvent {
  type: 'todos'
  runId: RunId
  todos: TodoItem[]
}

/**
 * 目标变更。**两个生产者，都必须发**：模型调三个目标工具时由端口发
 * （`runtime/session.ts`），服务端自动续起时由 `run-control.ts` 发。
 *
 * **不带 runId。** 目标是会话级的，改它的动作有一半发生在任何 run 之外
 * （续起前把轮次 +1、用户在界面上点继续），塞一个空 runId 进来只会让
 * 消费方会把它归到某一轮上。归属会话由信封上的 `conversationId` 表达。
 */
export interface GoalEvent {
  type: 'goal'
  goal: Goal
}

/**
 * 一次压缩的结果。
 *
 * **四个 phase 不能合并成三个。** `skipped`（没什么可压）与 `failed`（压缩坏了）
 * 对用户是两件事：前者不需要任何动作，后者意味着上下文还是满的、下一轮很可能
 * 直接报错。合并之后界面只能一律显示成失败。
 *
 * 被中断的压缩**不发事件**：它什么都没落库，而 run 随即以 `user_interrupt` 收尾。
 */
export interface CompactionEvent {
  type: 'compaction'
  runId: RunId
  phase: 'started' | 'done' | 'skipped' | 'failed'
  manifest?: CompactionManifest
  /** `phase='done'` 专有：摘要线跟着前移了（true），还是只收纳了工具正文（false）。 */
  summarized?: boolean
  reasonCode?: string
}

// ─────────────────────────────── 工作区实时性 ───────────────────────────────

/**
 * 文件变更广播。实时预览的核心：agent 一改文件，桌面和手机同时看到。
 * 由工具的文件变更结果产出，按路径去重。
 */
export interface FileChangedEvent {
  type: 'file.changed'
  changes: FileChange[]
  /** 归属的 run；外部编辑器改的文件为 null。 */
  runId: RunId | null
}

export interface GitStateEvent {
  type: 'git.state'
  /**
   * 这份状态属于哪个项目。
   *
   * **不能省。** git 状态是工作区级事件，走全局广播（`bus.visibleTo` 对没有会话的
   * 事件一律放行）。同时开着多个项目时，不带这个字段的话 B 项目的分支和改动数
   * 会盖在正在看 A 的界面上——而那个数字看起来完全合理，没人会怀疑它是别人的。
   */
  workspaceId: string
  /**
   * 当前分支名。**只有这一个字段。**
   *
   * 不要再加改动数、暂存数、领先落后：它们没有消费者——界面上唯一在问 git 的
   * 是输入框上方那颗分支牌。「这条会话改了哪些文件」由 step 账本的 `fileChanges` 回答，
   * 不走这条事件。
   */
  branch: string
}

// ─────────────────────────────── 多智能体 ───────────────────────────────

/**
 * 单次派活那张卡上唯一那个子节点的 id。
 *
 * 一次 `subagent` 调用就是一张只有一个节点的图，与编排共用下面这条通道，
 * 而通道按 `memberId` 认领节点，所以两侧要用同一个值。
 *
 * 它不进界面：界面上那一格显示的是执行者的名字。
 */
export const SUBAGENT_NODE_ID = 'child'

/** Agent Team 的成员状态。父会话据此画协作视图。 */
export interface TeamMemberEvent {
  type: 'team.member'
  runId: RunId
  memberId: string
  roleName: string
  /** 该成员背后的执行器：内置 loop 或外部 CLI。 */
  backend: 'builtin' | 'codex' | 'claude' | 'grok' | 'custom'
  phase: 'spawned' | 'working' | 'done' | 'failed'
  summary?: string
  childConversationId?: ConversationId
  /**
   * 这一轮编排挂在哪张工具卡上（`workflow` 那次调用的 step id）。
   *
   * 图卡按它认领进度：不带的话事件到了前端也无处可落——一条会话里可能有好几张图卡。
   */
  stepId?: string
}

/**
 * 外部 CLI 节点的中途输出。
 *
 * **只有外部 CLI 有这条**：内置子 agent 的过程留在它自己那条子会话里，点开节点就能看，
 * 而外部 CLI 是本机另一个进程，跑完之前它写了什么，不发出来就一个字都看不到。
 *
 * 与 `tool.delta` 分开是因为多了一维：一张图里可以有好几个 CLI 节点同时在跑，
 * 混进同一个 `stepId` 的缓冲就再也分不出哪一段是谁的。
 *
 * **不落库**，与 `team.member` 同一条口径：流式期间看这条，刷新之后看落库的
 * 逐节点终态（`NodeResult.output`）。
 */
export interface TeamOutputEvent {
  type: 'team.output'
  runId: RunId
  /** 哪一张图卡。与 `team.member` 同理，不带的话前端无处可落。 */
  stepId?: string
  /** 哪个节点。 */
  memberId: string
  /**
   * 两条流合成一条。**不分 stdout / stderr**：观察一个进程执行时它们本来就是交织的，
   * 而分开要么多一份状态，要么多一个没人读的字段。执行失败的诊断另有出口——
   * 节点终态里的 `error` 带着 stderr 的尾巴。
   */
  delta: string
}
