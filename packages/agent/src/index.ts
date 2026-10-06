/**
 * `@qywork/agent` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * 包内互相引用与测试使用相对路径，不受本清单约束。
 */

// 压缩：runtime 的压缩端口与 server 的手动压缩入口共用同一份实现
// CompactionOutcome 没有被任何模块 import，但它出现在 runtime 公开签名的推断类型中：
// 不导出会使该类型无法命名（TS2742）。这类隐式对外的类型同样是承诺。
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
// 投递额度：一次 provider 决策共用一份额度，超出时保存正文并续读
export {
  batchRemaining,
  boundExecutedOutcome,
  chargeBatchBudget,
  continuationNote,
  decodeUtf8Boundary,
  deliveredTokens,
  deliveryCap,
  type HeadDelivery,
  headBytesWithin,
  landHead,
  openBatchBudget,
  outcomeTokens,
  recordBatchSpent,
  tailRetain,
  tokensToBytes,
  tokensToMaxBytes,
} from './delivery.ts'
// 电脑控制端口：tools 据此实现桌面工具，server 的协调器实现该端口，由 runtime 注入
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
// 物理键表与输入规模上限：tools 的预检与 server 的输入执行器按同一份表裁决
export {
  charKeys,
  checkDuration,
  checkHeldKeys,
  checkKeyPhases,
  checkPath,
  INPUT_LIMITS,
  KEY_HINT,
  type KeyEventFields,
  type KeySpec,
  keyEvent,
  modifierBits,
} from './keys.ts'
// 主循环：runtime/session.ts 是唯一装配方
// `softLimit` 另有一个包外消费者：面板显示的触发线必须与实际触发压缩的阈值同源
// `MAX_RESENDS` 同理：历史接口的运行中快照必须报告同一个上限，另行定义一个数值即形成第二本账
export { MAX_RESENDS } from './loop/attempt.ts'
export { AgentLoop } from './loop/index.ts'
export {
  envelopeResult,
  imagesOf,
  omitImages,
  softLimit,
  toolResultContent,
  type VideoDelivery,
  videoDelivery,
  videosOf,
} from './loop/request.ts'
export { createSummaryTrace } from './loop/summary-trace.ts'
export type { CompactionPort, CompactionRunInput, LoopPersistence } from './loop/types.ts'
// run_command 的拒绝清单：runtime 的 Session 在放行之前调用它裁决
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
  type BrowserKeyPhase,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPathStep,
  type BrowserPoint,
  type BrowserPort,
  type BrowserRefusal,
  type BrowserSelectOption,
  type BrowserTabInfo,
  type BrowserWaitReceipt,
  type BrowserWaitResult,
  type BrowserWaitState,
  type CanvasPort,
  compactionEpoch,
  type DelegatePort,
  type FileReadPort,
  type FollowUpObservation,
  type GoalPort,
  type HistoryPort,
  type HistoryStep,
  type McpActivation,
  type McpConfigPort,
  type MediaCall,
  type MediaCallResult,
  type MediaPort,
  markCompacted,
  type OfficePort,
  type PermissionVerdict,
  type PluginPort,
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
