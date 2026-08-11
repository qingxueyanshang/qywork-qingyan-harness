/**
 * 核心领域模型。
 *
 * 移植口径（对应 Python 版 harness/models.py）：
 * - run  = 一次用户回合（一次 agent loop）
 * - step = loop 内可回放的 text / tool_action / artifact / progress / compaction
 * - 一次工具调用 = 一行 tool_action，原地从 running 更新到终态；没有 tool_call / tool_result 两行。
 * - thinking 只做实时状态，不落库回放。
 */

import type { ActionDescriptor } from '../protocol/events.ts'
import type {
  ArtifactId,
  ConversationId,
  MessageId,
  ResourceId,
  RunId,
  StepId,
  WorkspaceId,
} from './ids.ts'

// ─────────────────────────────── 会话 ───────────────────────────────

export interface Conversation {
  id: ConversationId
  /** 所属工作区（一个本地目录）。业务路径必须显式绑定，不做隐式全局回退。 */
  workspaceId: WorkspaceId
  title: string
  model: string
  /** 上下文压缩的唯一投影权威。有界 JSON，正文仍只存在 messages/steps 里。 */
  compactionManifest: CompactionManifest | null
  /** 用户显式重置缓存时递增；稳定路由键含该值，旧 provider 缓存自然隔离。 */
  cacheGeneration: number
  /** null=用户会话；'team'=Agent Team 子会话；'workflow'=编排产生的机器会话。 */
  source: 'team' | 'workflow' | null
  sourceRef: string | null
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: MessageId
  conversationId: ConversationId
  role: 'user' | 'assistant'
  content: string
  attachments: Attachment[]
  createdAt: number
}

export interface Attachment {
  type: 'image' | 'file' | 'selection'
  name: string
  mime: string
  size: number
  /** 工作区相对路径；外部粘贴的内容先落盘再引用，不把字节塞进消息。 */
  path: string
  /** 代码选区附件才有。 */
  range?: { startLine: number; endLine: number }
}

// ─────────────────────────────── Run ───────────────────────────────

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/**
 * 为什么停。废除「静默 done」——前端据此展示停止原因，用户不必追问「怎么暂停了」。
 */
export type StopReason =
  | 'completed'
  | 'max_steps'
  | 'user_interrupt'
  | 'permission_denied'
  /**
   * **输入**超出模型窗口。只有 provider 明确回容量拒绝（4xx + 原生容量码或强消息匹配）
   * 才能用这个值，判据见 `@qywork/ai` 的 `classifyCapacityRejection`。
   */
  | 'context_exhausted'
  /**
   * **输出**被 max_tokens 截断。答案不完整但已发生的部分是有效的。
   *
   * 与 `context_exhausted` 严格区分：一个是「说不下了」，一个是「听不下了」，
   * 用户的下一步动作完全不同（前者加大 max_tokens 或让模型分段，后者精简上下文）。
   * 曾经这两者被混成一个值，导致输出截断时提示用户去清理历史 —— 清了也没用。
   */
  | 'output_truncated'
  | 'provider_error'
  | 'internal_guard'
  | 'budget_exceeded'

export interface Run {
  id: RunId
  conversationId: ConversationId
  workspaceId: WorkspaceId
  userMessageId: MessageId | null
  /**
   * Run 创建时会话消息的高水位。执行锁在创建之后才获取；排队期间新增的消息
   * 不得穿越进本 run 的历史。
   */
  messageIdUpperBound: MessageId | null
  assistantMessageId: MessageId | null
  model: string
  /** 前端执行意图幂等键，(conversationId, clientRequestId) 唯一。 */
  clientRequestId: string
  status: RunStatus
  stopReason: StopReason | null

  usage: RunUsage
  stepCount: number

  errorMessage: string | null
  errorCode: string | null

  /** 本 run 自己的终态权威快照，不从会话级状态回填。 */
  executionState: ExecutionState | null

  contextTokens: number
  contextLimit: number
  contextPercent: number

  /** 重试链：本 run 是哪个失败 run 的重试；本 run 被哪个新 run 接替。 */
  retryOfRunId: RunId | null
  supersededBy: RunId | null

  createdAt: number
  finishedAt: number | null
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  /** 缓存读取命中。null 表示 provider 未回报，与真实 0 命中不是一回事。 */
  cachedTokens: number | null
  /** 缓存写入，与读取分离，便于与中转账单对账。 */
  cacheWriteTokens: number | null
  reasoningTokens: number
  /** 本币计价的累计花费，按 modelCatalog 定价算。 */
  costUsd: number
  /** 每轮一条，供命中率分桶与成本审计；不参与计费。 */
  turns: UsageTurn[]
}

export interface UsageTurn {
  turnIndex: number
  input: number
  output: number
  cached: number | null
  cacheWrite: number | null
  reasoning: number
  /** provider = 模型真回报；estimated = 本地估算兜底，二者不可混同。 */
  source: 'provider' | 'estimated'
  usageStatus: 'ok' | 'missing' | 'partial'
  costUsd: number
  at: number
}

export interface ExecutionState {
  turnIndex: number
  lastToolBatchId: string | null
  todos: TodoItem[]
  /** 已消费的执行波次数，崩溃恢复用。 */
  waveIndex: number
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ─────────────────────────────── Step ───────────────────────────────

export type StepKind = 'text' | 'tool_action' | 'artifact' | 'progress' | 'compaction'

export type ToolActionStatus = 'running' | 'success' | 'failure' | 'deferred' | 'skipped'

export interface Step {
  id: StepId
  runId: RunId
  seq: number
  kind: StepKind

  toolName: string | null
  toolCallId: string | null
  /** 同一 provider 响应的所有调用共享；保留「一个 assistant 轮 N 个调用」的原貌。 */
  providerBatchId: string | null
  callIndex: number | null
  /**
   * 一个 provider batch 内的后端执行边界。同 index 属于一次水平波次；
   * 不同 index 有先后。未进入波次规划的 deferred/skipped 保持 null。
   */
  executionWaveIndex: number | null
  /**
   * 副作用工具的持久歧义边界：进入执行器前立即提交。
   * 崩溃恢复必须把「有时间戳的 running 行」当作「可能已执行」。
   */
  executionStartedAt: number | null

  content: string | null
  payload: StepPayload | null
  status: ToolActionStatus | 'done'
  artifactId: ArtifactId | null
  createdAt: number
}

/**
 * `action` 随 step 一起落库，而不是让前端按工具名回猜。
 *
 * 动作语义由后端的 ToolSpec 解析（多动作门面会按参数分派），前端猜不出来——
 * 早期版本没存，刷新后所有历史工具卡都显示成「读取」，包括写入和执行命令。
 */
export type StepPayload =
  | { kind: 'tool_call'; args: Record<string, unknown>; action?: ActionDescriptor }
  | {
      kind: 'tool_result'
      args: Record<string, unknown>
      outcome: ToolOutcomeWire
      action?: ActionDescriptor
    }
  | { kind: 'progress'; label: string; detail?: string }
  | { kind: 'compaction'; manifestRevision: number; compactedMessages: number }

/** 工具执行的规范结果，必须原样抵达 step 账本、事件流和 provider transcript。 */
export interface ToolOutcomeWire {
  status: 'success' | 'failure'
  /** 是否真的执行了。权限拒绝 / 未知工具 = false，绝不伪装成功。 */
  executed: boolean
  message: string
  data?: Record<string, unknown>
  /** 文件类工具产出的变更摘要，供实时预览与 diff 面板消费。 */
  fileChanges?: FileChange[]
  /** 本次调用落盘的中间资源引用。只含定位事实，不携带正文。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

// ─────────────────────────── 中间资源 ───────────────────────────

export type ResourceStatus = 'complete' | 'partial' | 'failed'

/**
 * 覆盖事实：投递给模型的那一段，相对于完整正文处于什么位置、占多少。
 *
 * 这几个数字**必须随结果一起交给模型**。只给一段截断正文而不说
 * 「这是 2.3 MB 里的 8 KB」，模型会把它当成全部，然后基于不完整的信息下结论——
 * 比不给它更糟，因为它不知道自己不知道。
 */
export interface ResourceCoverage {
  deliveredBytes?: number
  totalBytes?: number
  truncated?: boolean
  /** 产生它的查询/命令/URL，供模型判断这段内容的语义。 */
  query?: string
  [k: string]: unknown
}

/** 执行记录里的落地正文引用；只含定位事实，正文在内容库里按哈希寻址。 */
export interface IntermediateResourceRef {
  resourceId: ResourceId
  status: ResourceStatus
  contentHash: string | null
  sizeBytes: number
  mimeType: string | null
  coverage: ResourceCoverage
}

export interface FileChange {
  path: string
  changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  renamedFrom?: string
}

// ─────────────────────────────── 产物 ───────────────────────────────

export interface Artifact {
  id: ArtifactId
  conversationId: ConversationId
  runId: RunId | null
  type: 'code' | 'html' | 'markdown' | 'diagram' | 'image' | 'document'
  title: string
  content: string
  version: number
  metadata: Record<string, unknown>
  createdAt: number
}

// ─────────────────────────────── 上下文压缩 ───────────────────────────────

export interface CompactionManifest {
  revision: number
  /** 该 id 及之前的消息已被摘要替代。 */
  compactedThroughMessageId: MessageId | null
  /** 已压缩的 run → 已压缩到的 step seq。 */
  compactedRunSteps: Record<string, number>
  summary: string
  /** 摘要保留的精确事实包（文件路径、决定、未完成项），不是自由文本。 */
  facts: CompactionFacts
  createdAt: number
}

export interface CompactionFacts {
  filesTouched: string[]
  decisions: string[]
  openItems: string[]
  userConstraints: string[]
}

// ─────────────────────────────── 工作区 ───────────────────────────────

export interface Workspace {
  id: WorkspaceId
  name: string
  rootPath: string
  /** 上次打开时间，用于「最近」列表排序。 */
  lastOpenedAt: number
  createdAt: number
}
