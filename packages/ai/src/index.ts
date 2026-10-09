/**
 * `@qywork/ai` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * **三个 adapter 类有意不导出。** 分派只发生一次（`buildAdapter` 按 `profile.kind`），
 * 之后调用方只使用 `LlmAdapter` 接口；导出具体类会导致下游使用 `instanceof`
 * 或判断 kind，这正是 B1「里氏替换」禁止的做法。
 */

// 这四个词表的真源在 core 的「共享词表」段：配置、协议、界面三方都使用它们，
// 只有 L0 层能被三方共同引用。此处只做具名再导出，便于 ai 的使用方就近引用。
export type { CacheRouting, ProviderKind, ReasoningEcho, ThinkingMode } from '@qywork/core'
// 容量拒绝：agent 的压缩循环据此决定是否压缩
export type { CapacityRejection } from './capacity.ts'
// 模型目录与计价：装配、读数、探测三处使用
export {
  applySpecOverride,
  applyTransportCapabilities,
  builtinCatalog,
  CHAT_REASONING_PROTOCOLS,
  type ChatReasoningProtocol,
  computeCost,
  effortIsTransmittable,
  lookupModel,
  type ModelSpec,
  type OffPeakDiscount,
  officialBaseUrl,
  priceAt,
  type ReasoningReplay,
  reasoningReplay,
  type SpecOverride,
  unknownModel,
  VENDORS,
} from './catalog.ts'
// 错误归类：agent 据此判定能否重试，server 据此决定前端引导动作
export {
  classifyProviderError,
  failureDiagnostics,
  ProviderError,
  providerErrorMessage,
} from './errors.ts'
// 唯一的 adapter 构造入口
export { buildAdapter } from './factory.ts'
// 生成模型：目录（设置页与生成工具共用）、参数校验、发送前的花费、唯一的生成适配器构造入口
export {
  findMediaModel,
  lookupMediaModel,
  type MediaInputCount,
  type MediaModelSpec,
  type MediaOperation,
  type MediaParamSpec,
  type MediaPrice,
  mediaCatalog,
  mediaCost,
  mediaKindsOf,
  quoteMedia,
} from './media/catalog.ts'
export { isImageResult } from './media/image-result.ts'
export { buildMediaAdapter } from './media/index.ts'
export { describeParam, operationLabel, validateMediaCall } from './media/params.ts'
export { type TaskPhase, taskPhase } from './media/task.ts'
export {
  type MediaAdapter,
  type MediaCancel,
  MediaError,
  type MediaFile,
  type MediaImageResult,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from './media/types.ts'
// 能力探测：cli 的 probe 子命令与设置页的「检测」按钮
export {
  describeProbe,
  type ProbeOutcome,
  probeModel,
  toTransportCapabilities,
} from './probe.ts'
// 字符估算：agent 在没有 count_tokens 的端点上将其作为后备
export {
  DEFAULT_DENSITY,
  estimateContent,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  MEDIA_TOKENS,
  type TokenDensity,
  videoBlocksOf,
} from './tokens.ts'
// 流空闲上限的基准：agent 按思考档位放宽该值，runtime 的摘要直接使用该值
export { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'
// 协议无关的请求与事件形状
export type {
  ChatRequest,
  ContentBlock,
  LlmAdapter,
  ProviderEvent,
  ProviderProfile,
  ProviderUsage,
  SystemBlock,
  ToolSchema,
  TransportCapabilities,
  WireMessage,
  WireToolCall,
} from './types.ts'

export { diagnosticEndpoint, providerContentKind } from './types.ts'
