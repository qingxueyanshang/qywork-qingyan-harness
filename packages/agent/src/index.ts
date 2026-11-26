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
  compactionRecordOf,
  condenseCutOf,
  condenseMessage,
  cutKey,
  projectManifest,
  type Summarizer,
  type SummaryTrace,
  stepStamp,
  summaryCutOf,
  summaryHeadroom,
  unitKey,
} from './compaction.ts'
// 投递额度：一次 provider 决策共用一份额度，超出时保存正文并续读
export {
  batchCapped,
  batchRemaining,
  boundExecutedOutcome,
  chargeBatchBudget,
  chargeImage,
  chargeVideo,
  continuationNote,
  decodeUtf8Boundary,
  deliveredTokens,
  deliveryCap,
  firstPageCap,
  foldsBeforeNextDecision,
  type HeadDelivery,
  headBytesWithin,
  landHead,
  openBatchBudget,
  outcomeTokens,
  recordBatchSpent,
  recordCappedSpent,
  tailRetain,
  tokensToBytes,
  tokensToMaxBytes,
} from './delivery.ts'
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
// 主循环：runtime/session/turn/drive.ts 是唯一装配方
// `softLimit` 另有一个包外消费者：面板显示的触发线必须与实际触发压缩的阈值同源
// `transientErrorCode` 同理：摘要请求与 art 卡片请求的重试与本轮内的重发使用同一份暂时故障分类
export { transientErrorCode } from './loop/attempt.ts'
export { AgentLoop } from './loop/index.ts'
// `breakdownOf` 另有一个包外消费者：runtime 的消息条目重建按同一分组规则逐条估算
// `assembleMessages` 与 `mediaCapabilitiesOf` 同理：两轮之间的压缩读数按下一轮请求的同一装配估算
// `materialize` 与 `videoDelivery`：runtime 的画布对话生成按会话的同一判定发送参考视频
export {
  assembleMessages,
  breakdownOf,
  type DeclaredText,
  envelopeResult,
  imagesOf,
  materialize,
  mediaCapabilitiesOf,
  omitImages,
  runDensity,
  softLimit,
  textsOf,
  toolResultContent,
  type VideoDelivery,
  videoDelivery,
  videoRangeCause,
  videosOf,
} from './loop/request.ts'
export { createSummaryTrace } from './loop/summary-trace.ts'
export type { CompactionPort, CompactionRunInput, LoopPersistence } from './loop/types.ts'
// 视频的时长与画面尺寸：tools 的读取、runtime 的附件与压缩估算、server 的画布尺寸共用同一读取函数；媒体播放时长见 `mediaDurationOfFile`
export { mediaDurationOfFile } from './media-duration.ts'
// 凭证文件的判定：命令裁决按命令全文、tools 的路径解析按真实路径调用同一个函数
export { CREDENTIAL_FILES, mentionsCredentialFile } from './paths/credentials.ts'
// 全局数据目录：tools 的三层作用域、runtime 的配置目录与本包的凭证、位置判定共用这一个定义
export { globalScopeRoot } from './paths/global-root.ts'
// 路径位置的判定：命令裁决与 tools 的路径解析共用；server 的画布按同一判据判定文件是否位于工作区内
export { isOutsideRelative, placePath } from './paths/place.ts'
// run_command 的拒绝清单：runtime 的 Session 在放行之前调用它裁决
export { decideCommand } from './policy.ts'
// 端口：键与集合供 tools 定义端口、装配方（runtime、server、cli）提供实现
export { DelegatePort, type SubagentSummary } from './ports/delegate.ts'
export { definePort, type PortEntry, type PortKey, Ports, provide } from './ports/key.ts'
export { TodoPort } from './ports/todos.ts'
// 冻结前缀的静态审计：系统提示词由 runtime 构造，审计在 runtime 的测试中执行
export { auditFrozenText } from './prefix-audit.ts'
// 工具注册表：tools 注册内置工具，mcp 与 plugins 在其后追加
export {
  compactionEpoch,
  deferredDefinition,
  markCompacted,
  type PermissionVerdict,
  resolveAction,
  type SinkPort,
  sanitizeToolName,
  type ToolContext,
  type ToolContextBase,
  type ToolOutcome,
  ToolRegistry,
  type ToolSpec,
} from './registry.ts'
// 同时在途的请求名额：主请求之外的摘要与 art 请求取得同一个名额
export {
  concurrencyRejected,
  type SendOutcome,
  sendLane,
  sendLimiter,
} from './send-limit.ts'
export { movieMetadataOfFile, videoMetaOf } from './video-meta.ts'
