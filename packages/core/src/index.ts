/**
 * `@qywork/core` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * **事件与指令的成员类型刻意不逐个导出。** `AgentEvent` / `ClientCommand` 是可辨识
 * 联合，消费方按 `type` 收窄就拿得到成员形状；逐个导出等于把三十多个只在联合里
 * 出现过的名字推出去，而它们没有调用点。
 *
 * 不要再给 `domain/` 和 `protocol/` 各建一个 `index.ts`：它们只会被本文件引用，
 * 等于同一份清单维护两遍。
 */

// id 与构造器：账本、事件、协议三处都按它们对齐类型
export {
  type ConversationId,
  type GoalId,
  type MessageId,
  newBatchId,
  newConversationId,
  newGoalId,
  newMessageId,
  newProviderRequestId,
  newResourceId,
  newRunId,
  newStepId,
  newUsageId,
  newWorkspaceId,
  type ProviderRequestId,
  type ResourceId,
  type RunId,
  type StepId,
  type WorkspaceId,
} from './domain/ids.ts'

// 领域模型：落库形状与读数口径，几乎每个包都要
export {
  type Attachment,
  attachmentTypeOf,
  baseNameOf,
  CACHE_ROUTINGS,
  type CacheRouting,
  CONTEXT_GROUPS,
  type CompactionCut,
  type CompactionFacts,
  type CompactionManifest,
  type ContextBreakdown,
  type ContextGroup,
  type ContextOmitted,
  type Conversation,
  type Currency,
  deriveConversationTitle,
  EFFORT_ORDER,
  type EffortLevel,
  emptyBreakdown,
  emptyOmitted,
  envelopeHeadTokens,
  type FileChange,
  type FollowUp,
  formatCosts,
  formatMoney,
  type Goal,
  type GoalAction,
  type GoalStatus,
  type GoalWriteResult,
  type IntermediateResourceRef,
  isInlineImage,
  isInlineVideo,
  type Message,
  mimeOf,
  type NodePhase,
  type NodeState,
  type PermissionMode,
  PROVIDER_KINDS,
  type ProviderFailureCause,
  type ProviderKind,
  type ProviderRequest,
  type ProviderRequestDiagnostic,
  type ProviderRequestPurpose,
  type ProviderRequestStatus,
  type ProviderRetryDecision,
  REASONING_ECHOES,
  type ReasoningEcho,
  type ResourceCoverage,
  type ResourceStatus,
  type Run,
  type RunContextSegment,
  type RunInterruption,
  type RunStatus,
  type RunUsage,
  reconcileBreakdown,
  type Step,
  type StepKind,
  type StepPayload,
  type StopReason,
  THINKING_MODES,
  type ThinkingMode,
  type TodoItem,
  type ToolActionStatus,
  type ToolOutcomeWire,
  todoProgress,
  toPosixPath,
  type UsageBucket,
  type UsageKind,
  type UsageLedgerRow,
  type UsageTotals,
  type Workspace,
} from './domain/model.ts'

// workflow 的跨层序列化契约与纯投影：team/server/web 共用，不能各算一份。
export {
  checkpointOutput,
  DEFAULT_MAX_CONCURRENT,
  foldWorkflow,
  parseSubagentTarget,
  parseWorkflowCall,
  type RevisionClosureResult,
  revisionClosure,
  type SubagentKind,
  type SubagentSpec,
  type SubagentTarget,
  type SubagentTargetParse,
  targetLabel,
  type WorkflowAgentNode,
  type WorkflowAppliedReview,
  type WorkflowCall,
  type WorkflowCallRecord,
  type WorkflowCheckpointNode,
  type WorkflowFoldResult,
  type WorkflowNode,
  type WorkflowParseResult,
  type WorkflowPhase,
  type WorkflowProjection,
  type WorkflowReceipt,
  type WorkflowRevision,
  type WorkflowTransition,
  workflowGroupId,
  workflowTransitionOf,
} from './domain/workflow.ts'

// 服务端 → 客户端的事件
export type {
  ActionDescriptor,
  ActionKind,
  AgentEvent,
  ErrorCode,
  EventEnvelope,
  GitStateEvent,
} from './protocol/events.ts'
// 单次派活那张卡上那个子节点的 id：服务端发事件、前端画节点，两侧要用同一个值
export { SUBAGENT_NODE_ID } from './protocol/events.ts'
export type {
  ConversationHistoryPageResponse,
  ConversationRunsResponse,
  ConversationUsageResponse,
  UsageResponse,
} from './protocol/http.ts'

// 客户端 → 服务端的指令、握手与配对
export {
  type ClientCommand,
  type ClientOrigin,
  type CommandRejectedFrame,
  type CommandRejectReason,
  decodePairingUrl,
  type EnvDependency,
  encodePairingUrl,
  type HelloErrFrame,
  type HelloFrame,
  type HelloOkFrame,
  type PairingPayload,
  type ResumePosition,
  ROLE_COMMAND,
  type ServerCapabilities,
} from './protocol/transport.ts'
