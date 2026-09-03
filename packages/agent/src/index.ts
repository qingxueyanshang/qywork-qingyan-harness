/**
 * `@qywork/agent` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * 包内互相引用与测试走相对路径，不受这份清单约束。
 */

// 分类器：runtime 装配 Session 时注入 AskFn 与缓存
// 压缩：runtime 的压缩端口与 server 的手动压缩入口共用同一份实现
// CompactionOutcome 没有被谁 import，但它出现在 runtime 的公开签名的推断类型里——
// 不导出会让那个类型无法命名（TS2742）。这类「隐式对外」同样是承诺。
export {
  type CompactionAction,
  type CompactionInput,
  type CompactionOutcome,
  compact,
  condenseCutOf,
  condenseMessage,
  cutKey,
  projectManifest,
  type Summarizer,
  stepStamp,
  summaryCutOf,
  unitKey,
} from './compaction.ts'
// 主循环：runtime/session.ts 是唯一装配方
// `softLimit` 另有一个包外消费者：面板画的触发线必须与真正会触发的那条同源
export {
  AgentLoop,
  type CompactionPort,
  type CompactionRunInput,
  envelopeResult,
  type LoopPersistence,
  STREAM_IDLE_TIMEOUT_MS,
  softLimit,
  toolResultContent,
} from './loop.ts'
// 静态规则：runtime 在分类器之前先问它
export { decideCommand } from './policy.ts'
// 工具注册表：tools 注册内置工具，mcp 与 plugins 在其后追加
export {
  chargeBatchBudget,
  type DelegatePort,
  deliveredTokens,
  deliveryBudget,
  type FileReadPort,
  type GoalPort,
  type HistoryPort,
  type McpConfigPort,
  type PermissionVerdict,
  type PluginPort,
  RESULT_BUDGET_RATIO,
  resetBatchBudget,
  type SinkPort,
  type SubagentSummary,
  sanitizeToolName,
  TOOL_CATEGORIES,
  type ToolCategory,
  type ToolContext,
  type ToolContextBase,
  type ToolOutcome,
  ToolRegistry,
  type ToolSpec,
} from './registry.ts'
