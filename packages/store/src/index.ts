/**
 * `@qywork/store` 的对外接口。此处列出的即对外承诺，未列出的均为内部实现。
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * 账本读写的每个函数完成一次完整的事实变更，不向上层暴露 SQL：账本的一致性规则
 * （step 原地更新、usage 累加口径、run 终态唯一）必须集中在本包中，分散到调用方后无法保证。
 */

// 正文库：超出预算的工具输出写入此处，模型用 read_resource 读取
export { ContentStore, contentPathFor } from './content.ts'
// 主账本句柄
export { type RunOwner, Store } from './db.ts'
// 目标与自动继续：runtime 经由端口提供给工具，server 在 run 结束处判定是否自动继续
export { createGoal, currentGoal, updateGoal } from './goals.ts'
// 按需加载的外部工具：runtime 在装配工具表时读取、在 load_tool 成功后写入
// 落盘 schema 版本。真源位于 migrations/index.ts，不设中心登记表（CLAUDE.md D2）
export { SCHEMA_VERSION } from './migrations/index.ts'
// 请求信封的明细：runtime 的请求持久化层随主请求写入，按指纹读取
export {
  type EnvelopeItem,
  requestEnvelopeItems,
  saveRequestEnvelope,
} from './monitor/envelopes.ts'
// 会话级逐请求序列与明细：server 的逐请求接口读取，含工具调用统计（`monitor/tool-usage.ts`）。
// 对账结果、压缩记录与按 id 读取请求另供 runtime 的消息条目重建使用
export {
  type CompactionRecord,
  compactionRecords,
  conversationRequestDetails,
  conversationRequests,
  requestBreakdown,
  requestWithPrevious,
} from './monitor/requests.ts'
// 读写：会话
export {
  archiveConversation,
  archiveWorkspaceConversations,
  countConversations,
  createConversation,
  deleteConversation,
  getConversation,
  listChildConversations,
  listConversations,
  listRecentConversations,
  permissionModeOf,
  setCompactionManifest,
  setConversationExternalSession,
  setConversationMode,
  setConversationModel,
  setConversationTitle,
} from './repos/conversations.ts'
// 会话读取文件时的内容哈希：写入前的新鲜度校验
export { fileReadHash, recordFileRead } from './repos/file-reads.ts'
// 读写：消息；以用户消息分页的历史页与变更页
export {
  appendMessage,
  listConversationChangesPage,
  listConversationHistoryPage,
  listMessages,
} from './repos/messages.ts'
// 逐请求账本
export {
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listProviderRequests,
  type ModelFinishRate,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestHedge,
  markProviderRequestSent,
  openProviderRequest,
  providerFinishRates,
  recordProviderRequestDiagnostic,
  settleProviderRequest,
} from './repos/provider-requests.ts'
// 读写：run
export {
  appendRunMedia,
  ConversationBusyError,
  createRun,
  finishRun,
  getRun,
  listRunContextSnapshots,
  listRuns,
  markRunRunning,
  type ProcessExitObservation,
  recoverStaleRuns,
  touchRun,
  updateRunUsage,
} from './repos/runs.ts'
// 读写：step
export {
  appendStep,
  appendStepFileChanges,
  appendTextToStep,
  conversationRejectsImages,
  conversationRejectsVideos,
  failThinkingSteps,
  interruptRunningNodes,
  listSteps,
  markImagesUndelivered,
  markStepExecuting,
  recordCompactionStep,
  setStepNodeState,
  settleRunningSteps,
  settleToolStep,
  stepInExecution,
} from './repos/steps.ts'
// 读写：工作区
export {
  getWorkspace,
  getWorkspaceByPath,
  listWorkspaces,
  mostRecentWorkspace,
  normalizeWorkspaceRoot,
  removeWorkspace,
  setWorkspacePinned,
  upsertWorkspace,
  workspaceOf,
} from './repos/workspaces.ts'
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
  listSchedules,
  nextScheduledAt,
  type ScheduleClaim,
  updateSchedule,
} from './schedules.ts'
// 待办：只读取，不另行写入；真源是父会话验收后提交的 write_todos tool step
export { latestTodos } from './todos.ts'
// 工具结果的图像：写入由 settleToolStep 完成，读取账本的各方经此还原字节
export { isStoredToolImage, loadToolImages, type StoredToolImage } from './tool-images.ts'
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
