/**
 * `@qywork/core` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前四个模块走 `export *`，
 * 把九十来个符号一并推到包外；看不出这个包对外承诺了什么，改任何一个内部类型
 * 都得先全仓 grep 一遍才敢动。现在只列真实有包外消费者的（逐个核过调用点）。
 *
 * **事件与指令的成员类型刻意不逐个导出。** `AgentEvent` / `ClientCommand` 是
 * 可辨识联合，消费方按 `type` 收窄就能拿到成员形状，不需要 import 成员名——
 * 逐个导出等于把三十多个只在联合里出现过的名字推出去，而它们没有任何调用点。
 * 真有人要单独引某个成员时再加那一行。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 * 「以后可能有人要用」不是理由（见 CLAUDE.md B3）。
 *
 * 不要再给 `domain/` 和 `protocol/` 各建一个 `index.ts`：它们只会被本文件引用，
 * 等于同一份清单要维护两遍。
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
  CONTEXT_GROUPS,
  type CompactionFacts,
  type CompactionManifest,
  type ContextBreakdown,
  type ContextGroup,
  type ContextOmitted,
  type Conversation,
  type Currency,
  EFFORT_ORDER,
  type EffortLevel,
  emptyBreakdown,
  emptyOmitted,
  type FileChange,
  formatCosts,
  formatMoney,
  type Goal,
  type GoalAction,
  type GoalStatus,
  type GoalWriteResult,
  type IntermediateResourceRef,
  type Message,
  type PermissionMode,
  type ProviderRequest,
  type ProviderRequestStatus,
  type ResourceCoverage,
  type ResourceStatus,
  type Run,
  type RunUsage,
  type Step,
  type StopReason,
  type TodoItem,
  type ToolActionStatus,
  type ToolOutcomeWire,
  todoProgress,
  type Workspace,
} from './domain/model.ts'

// 服务端 → 客户端的事件
export type {
  ActionDescriptor,
  ActionKind,
  AgentEvent,
  ErrorCode,
  EventEnvelope,
  GitStateEvent,
  PermissionScope,
} from './protocol/events.ts'

// 客户端 → 服务端的指令、握手与配对
export {
  type ClientCommand,
  type ClientOrigin,
  type CommandRejectedFrame,
  type CommandRejectReason,
  decodePairingUrl,
  type EnvDependency,
  encodePairingUrl,
  type HelloFrame,
  type HelloOkFrame,
  type PairingPayload,
  type ResumePosition,
  type ServerCapabilities,
} from './protocol/transport.ts'
