/**
 * `@qywork/store` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前五个模块走 `export *`，
 * 把六十个符号推到包外，其中十九个没有任何包外调用点。
 * 现在只导出真实有外部消费者的，逐个核过调用点。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 * 「以后可能有人要用」不是理由（见 CLAUDE.md B3）。
 */

// 正文库：超预算的工具输出落这里，模型用 read_resource 读回
export { ContentStore, contentPathFor } from './content.ts'
// 主账本句柄
export { Store } from './db.ts'
// 三层作用域里被单独关掉的记忆/技能条目
export { type ExtraKey, listDisabledExtras, setExtraEnabled } from './extras.ts'
// 读写：会话、消息、run、step、工作区
export {
  appendMessage,
  appendStep,
  appendTextToStep,
  archiveWorkspaceConversations,
  countConversations,
  createConversation,
  createRun,
  finishRun,
  getConversation,
  getRun,
  getWorkspace,
  listConversations,
  listMessages,
  listRecentConversations,
  listRuns,
  listSteps,
  listWorkspaces,
  markRunRunning,
  markRunSuperseded,
  markStepExecuting,
  recoverStaleRuns,
  referencedAttachmentPaths,
  removeWorkspace,
  setCompactionManifest,
  setConversationEffort,
  setConversationModel,
  settleToolStep,
  setWorkspacePinned,
  updateRunContext,
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
// 花费账本
export { type GroupBy, recordUsage, usageBy, usageTotals } from './usage.ts'
