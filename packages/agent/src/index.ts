/**
 * `@qywork/agent` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * 包内互相引用与测试走相对路径，不受这份清单约束。
 */

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
  type SummaryTrace,
  stepStamp,
  summaryCutOf,
  unitKey,
} from './compaction.ts'
// 电脑控制端口：tools 按它写桌面工具，server 的协调器实现它，runtime 注入
export type {
  DesktopActReceipt,
  DesktopActResult,
  DesktopBlockingWindowInfo,
  DesktopElement,
  DesktopFollowUp,
  DesktopImage,
  DesktopImagePoint,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  DesktopText,
  DesktopWaitCondition,
  DesktopWaitReceipt,
  DesktopWaitResult,
  DesktopWindowInfo,
} from './desktop.ts'
// 按键词表：tools 的 press 预检与 server 的 CDP 客户端按同一份表裁决
export {
  KEY_HINT,
  type KeySpec,
  type KeyStroke,
  keySpec,
  keyStroke,
  MODIFIER_KEYS,
  type ModifierName,
  modifierBits,
  PRESS_KEYS,
} from './keys.ts'
// 主循环：runtime/session.ts 是唯一装配方
// `softLimit` 另有一个包外消费者：面板画的触发线必须与真正会触发的那条同源
// `MAX_RESENDS` 同理：历史接口的运行中快照要报同一个上限，另写一个数就是第二本账
export { MAX_RESENDS } from './loop/attempt.ts'
export { AgentLoop } from './loop/index.ts'
export {
  envelopeResult,
  imagesOf,
  omitImages,
  softLimit,
  toolResultContent,
} from './loop/request.ts'
export type { CompactionPort, CompactionRunInput, LoopPersistence } from './loop/types.ts'
// run_command 的拒绝清单：runtime 的 Session 在放行之前问它
export { decideCommand } from './policy.ts'
// 工具注册表：tools 注册内置工具，mcp 与 plugins 在其后追加
export {
  type BrowserActInput,
  type BrowserActionKind,
  type BrowserActReceipt,
  type BrowserActResult,
  type BrowserDownloadResult,
  type BrowserElement,
  type BrowserExecution,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPort,
  type BrowserRefusal,
  type BrowserSelectOption,
  type BrowserTabInfo,
  type BrowserWaitReceipt,
  type BrowserWaitResult,
  chargeBatchBudget,
  compactionEpoch,
  type DelegatePort,
  deliveredTokens,
  deliveryBudget,
  type FileReadPort,
  type FollowUpObservation,
  type GoalPort,
  type HistoryPort,
  type HistoryStep,
  type McpConfigPort,
  markCompacted,
  type PermissionVerdict,
  type PluginPort,
  RESULT_BUDGET_RATIO,
  recordBatchSpent,
  resetBatchBudget,
  type SchedulePort,
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
