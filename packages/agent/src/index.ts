/**
 * `@qywork/agent` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前六个模块走 `export *`，
 * 把五十个符号一并推到包外——其中三十多个从来没有包外调用点。
 * 后果不是「用了会坏」，是**看不出这个包对外承诺了什么**：改任何一个内部函数
 * 都得先全仓 grep 一遍才敢动。现在只导出真实有外部消费者的，逐个核过调用点。
 *
 * 包内互相引用照常走相对路径，测试也一样——它们不受这份清单约束。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 * 「以后可能有人要用」不是理由（见 CLAUDE.md B3）。
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
  type LoopPersistence,
  STREAM_IDLE_TIMEOUT_MS,
  softLimit,
} from './loop.ts'
// 静态规则：runtime 在分类器之前先问它
export { decideCommand } from './policy.ts'
// 工具注册表：tools 注册内置工具，mcp 与 plugins 在其后追加
export {
  chargeBatchBudget,
  deliveryBudget,
  type FileReadPort,
  type GoalPort,
  type HistoryPort,
  type PermissionVerdict,
  RESULT_BUDGET_RATIO,
  resetBatchBudget,
  type SinkPort,
  sanitizeToolName,
  TOOL_CATEGORIES,
  type ToolCategory,
  type ToolContext,
  type ToolOutcome,
  ToolRegistry,
  type ToolSpec,
} from './registry.ts'
