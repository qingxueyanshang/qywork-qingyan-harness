/**
 * `@qywork/store` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 */

// 正文库：超预算的工具输出落这里，模型用 read_resource 读回
export { ContentStore, contentPathFor } from './content.ts'
// 主账本句柄
export { Store } from './db.ts'
// 三层作用域里被单独关掉的记忆/技能条目
export { type ExtraKey, listDisabledExtras, setExtraEnabled } from './extras.ts'
// 目标与自动续起：runtime 用端口交给工具，server 在 run 收尾处判续起
export { createGoal, currentGoal, updateGoal } from './goals.ts'
// 按需加载的外部工具：runtime 在装配工具表时读回、在 load_tool 成功后写入
export { listLoadedTools, recordLoadedTools } from './loaded-tools.ts'
// 读写：会话、消息、run、step、工作区
export {
  appendMessage,
  appendStep,
  appendTextToStep,
  archiveConversation,
  archiveWorkspaceConversations,
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
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listConversations,
  listMessages,
  listProviderRequests,
  listRecentConversations,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  listWorkspaces,
  type ModelFinishRate,
  markProviderRequestSent,
  markRunRunning,
  markStepExecuting,
  mostRecentWorkspace,
  openProviderRequest,
  providerFinishRates,
  recordFileRead,
  recoverStaleRuns,
  removeWorkspace,
  setCompactionManifest,
  setConversationModel,
  setConversationTitle,
  settleProviderRequest,
  settleRunningSteps,
  settleToolStep,
  setWorkspacePinned,
  touchRun,
  updateRunUsage,
  upsertWorkspace,
  workspaceOf,
} from './repos.ts'
// 中间资源：runtime 的 sink 落盘与回读
export {
  getResource,
  listResourcesForRun,
  referencedContentHashes,
  registerResource,
} from './resources.ts'
// 落盘 schema 版本。**真源就在 schema.ts，不设中心登记表**（CLAUDE.md D2）
export { SCHEMA_VERSION } from './schema.ts'
// 待办：只读回，不写入——真源是 `write_todos` 那条 step 的 args
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
