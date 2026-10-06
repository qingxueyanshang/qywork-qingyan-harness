/**
 * `@qywork/store` 的对外接口。此处列出的即对外承诺，未列出的均为内部实现。
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 */

// 正文库：超出预算的工具输出写入此处，模型用 read_resource 读取
export { ContentStore, contentPathFor } from './content.ts'
// 主账本句柄
export { type RunOwner, Store } from './db.ts'
// 目标与自动继续：runtime 经由端口交给工具，server 在 run 结束处判定是否自动继续
export { createGoal, currentGoal, updateGoal } from './goals.ts'
// 按需加载的外部工具：runtime 在装配工具表时读取、在 load_tool 成功后写入
export { listLoadedTools, recordLoadedTools } from './loaded-tools.ts'
// 读写：会话、消息、run、step、工作区
export {
  appendMessage,
  appendStep,
  appendTextToStep,
  archiveConversation,
  archiveWorkspaceConversations,
  ConversationBusyError,
  countConversations,
  createConversation,
  createRun,
  deleteConversation,
  failThinkingSteps,
  fileReadHash,
  finishRun,
  getConversation,
  getRun,
  getWorkspace,
  getWorkspaceByPath,
  interruptRunningNodes,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listChildConversations,
  listConversationChangesPage,
  listConversationHistoryPage,
  listConversations,
  listMessages,
  listProviderRequests,
  listRecentConversations,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  listWorkspaces,
  type ModelFinishRate,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestSent,
  markRunRunning,
  markStepExecuting,
  mostRecentWorkspace,
  openProviderRequest,
  type ProcessExitObservation,
  providerFinishRates,
  recordFileRead,
  recordProviderRequestDiagnostic,
  recoverStaleRuns,
  removeWorkspace,
  setCompactionManifest,
  setConversationExternalSession,
  setConversationModel,
  setConversationTitle,
  setStepNodeState,
  settleProviderRequest,
  settleRunningSteps,
  settleToolStep,
  setWorkspacePinned,
  touchRun,
  updateRunMedia,
  updateRunUsage,
  upsertWorkspace,
  workspaceOf,
} from './repos.ts'
// 中间资源：runtime 的 sink 写入与读取
export {
  getResource,
  listResourcesForRun,
  referencedContentHashes,
  registerResource,
} from './resources.ts'
// 定时任务：调度 tick 的认领事务、HTTP 接口与模型工具端口共用同一份仓储
export {
  claimDueSchedules,
  claimScheduleNow,
  createSchedule,
  deleteSchedule,
  insertSchedules,
  listSchedules,
  type ScheduleClaim,
  updateSchedule,
} from './schedules.ts'
// 落盘 schema 版本。真源位于 schema.ts，不设中心登记表（CLAUDE.md D2）
export { SCHEMA_VERSION } from './schema.ts'
// 待办：只读取，不另行写入；真源是父会话验收后提交的 write_todos tool step
export { latestTodos } from './todos.ts'
// 花费账本
export {
  type GroupBy,
  recordUsage,
  summaryOutputPercentile,
  usageBy,
  usageEntries,
  usageTotals,
} from './usage.ts'
export { latestSubagentPhases, listWorkflowRecords, workflowIdsOf } from './workflow.ts'
