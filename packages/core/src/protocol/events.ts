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
  CompactionManifest,
  FileChange,
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
   * **必须在帧上，不能只在服务端内存里。** 这个字段本来是有的——服务端一直拿着它
   * 做订阅过滤——但它从不随帧发出，于是客户端只能盲信「我收到的都是我订阅的」。
   * 那个前提有三处不成立（空订阅集被当成全订阅、断线补发根本不过滤、
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
  // ── run 生命周期 ──
  | RunStartedEvent
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
  | CompactionEvent
  // ── 工作区实时性 ──
  | FileChangedEvent
  | GitStateEvent
  // ── 权限 ──
  | PermissionRequestEvent
  | PermissionResolvedEvent
  // ── 多智能体 ──
  | TeamMemberEvent

// ─────────────────────────────── 会话 ───────────────────────────────

/**
 * 会话属性变更（目前只有模型和标题）。
 *
 * 必须走事件总线广播，不能只回给发起方：手机和桌面可能同时开着同一个会话，
 * 一端切了模型另一端还显示旧的，下一轮的实际用量和计价就对不上界面。
 */
export interface ConversationUpdatedEvent {
  type: 'conversation.updated'
  conversationId: ConversationId
  model: string
  title: string
}

// ─────────────────────────────── run 生命周期 ───────────────────────────────

export interface RunStartedEvent {
  type: 'run.started'
  runId: RunId
  conversationId: ConversationId
  model: string
  userMessageId: MessageId | null
  /** 显式重试时指向被重试的 run。 */
  retryOfRunId: RunId | null
}

export interface RunFinishedEvent {
  type: 'run.finished'
  runId: RunId
  status: 'done' | 'failed' | 'interrupted'
  /** 永远非空——不存在「静默完成」。 */
  stopReason: StopReason
  usage: RunUsage
  stepCount: number
  durationMs: number
  /** 本 run 累计的文件变更汇总，供「N 个文件已更改 +x -y」条展示。 */
  fileChanges: FileChange[]
}

export interface RunErrorEvent {
  type: 'run.error'
  runId: RunId
  /** 归类后的错误码，前端据此决定提示（如去配 key、去充值、换模型）。 */
  code: ErrorCode
  message: string
  /** true = 用户可以直接重试；false = 需要先改配置。 */
  retryable: boolean
  detail?: Record<string, unknown>
}

export type ErrorCode =
  | 'no_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'insufficient_quota'
  | 'context_overflow'
  | 'model_not_found'
  | 'provider_unavailable'
  | 'network_error'
  | 'stream_idle_timeout'
  | 'tool_execution_failed'
  | 'permission_denied'
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

/** 思考内容只做实时展示，不落库回放——与 Python 版口径一致。 */
export interface ThinkingDeltaEvent {
  type: 'thinking.delta'
  runId: RunId
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
  /** 动作语义，前端据此选图标与措辞；后端不下发 UI 文案。 */
  action: ActionDescriptor
}

export interface ActionDescriptor {
  kind: ActionKind
  /** 被操作对象的类别名，如 'file' / 'command' / 'branch'。 */
  objectLabel: string
  /** 可稳定归属的单一目标，如文件路径。没有则 null。 */
  target: string | null
}

export type ActionKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'delete'
  | 'execute'
  | 'search'
  | 'fetch'
  | 'plan'
  | 'delegate'

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
  percent: number
  /** 分组占用，供上下文面板画堆叠条。 */
  breakdown: ContextBreakdown
}

export interface ContextBreakdown {
  systemPrompt: number
  toolSchemas: number
  skills: number
  historyMessages: number
  executionRecords: number
  summary: number
  workspaceState: number
}

export interface TodosEvent {
  type: 'todos'
  runId: RunId
  todos: TodoItem[]
}

export interface CompactionEvent {
  type: 'compaction'
  runId: RunId
  phase: 'started' | 'done' | 'failed'
  manifest?: CompactionManifest
  reasonCode?: string
}

// ─────────────────────────────── 工作区实时性 ───────────────────────────────

/**
 * 文件变更广播。实时预览的核心：agent 一改文件，桌面和手机同时看到。
 * 由文件监听（Tauri notify）与工具产出两路汇入，按路径去重。
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
  branch: string
  /** 上游分支，detached HEAD 时为 null。 */
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  /** 冲突文件数，>0 时 UI 要挡住继续执行。 */
  conflicted: number
}

// ─────────────────────────────── 权限 ───────────────────────────────

/**
 * 需要用户拍板才能继续。桌面和手机都能应答，谁先答谁生效。
 *
 * **唯一生产者是 Agent Team 的人工门禁**（`rules.humanGates`）。普通工具授权
 * 在两模式设计下由运行时就地裁决，不发这个事件——被拒的调用以
 * `tool.finished{status:'failure'}` 呈现。
 */
export interface PermissionRequestEvent {
  type: 'permission.request'
  runId: RunId
  requestId: string
  toolName: string
  action: ActionDescriptor
  /** 给用户看的具体内容：要跑的命令、要写的 diff。 */
  preview: string
  /** 可授予的范围粒度。 */
  scopes: PermissionScope[]
  expiresAt: number
}

export interface PermissionScope {
  id: string
  label: string
  /**
   * once=仅这次；run=本轮；session=本会话。
   *
   * 曾经还有一个 `always`（「一直允许」），**它的标签在说谎**：授权记在
   * `RunManager` 的内存 Map 里，进程一重启就没了，实际效果和 `session`
   * 完全一样。要做真正的持久授权得写进配置，那是另一件事。
   */
  duration: 'once' | 'run' | 'session'
}

export interface PermissionResolvedEvent {
  type: 'permission.resolved'
  runId: RunId
  requestId: string
  granted: boolean
  scopeId: string | null
  /** 谁答的，用于「手机上批准了」这种跨端提示。 */
  resolvedBy: 'desktop' | 'mobile' | 'policy' | 'timeout'
}

// ─────────────────────────────── 多智能体 ───────────────────────────────

/** Agent Team 的成员状态。父会话据此画协作视图。 */
export interface TeamMemberEvent {
  type: 'team.member'
  runId: RunId
  memberId: string
  roleName: string
  /** 该成员背后的执行器：内置 loop 或外部 CLI。 */
  backend: 'builtin' | 'codex' | 'claude' | 'grok' | 'custom'
  phase: 'spawned' | 'working' | 'blocked' | 'done' | 'failed'
  summary?: string
  childConversationId?: ConversationId
}
