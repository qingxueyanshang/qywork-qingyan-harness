/**
 * `@qywork/ai` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * **三个 adapter 类有意不导出。** 分派只发生一次（`buildAdapter` 按 `profile.kind`），
 * 之后调用方只使用 `LlmAdapter` 接口；导出具体类会导致下游使用 `instanceof`
 * 或判断 kind，这正是 B1「里氏替换」禁止的做法。
 */

// 四个词表（CacheRouting、ProviderKind、ReasoningEcho、ThinkingMode）的真源在 core 的「共享词表」段：
// 配置、协议、界面三方都使用它们，只有 L0 层能被三方共同引用。生成型号的三个数据形状的真源同样在 core：
// 配置中保存的云端规格引用它们。此处只做具名再导出，便于 ai 的使用方就近引用。
export type {
  CacheRouting,
  CloudModelSpec,
  MediaOperation,
  MediaParamSpec,
  ProviderKind,
  ReasoningEcho,
  ThinkingMode,
} from '@qywork/core'
// 容量拒绝：agent 的压缩循环据此决定是否压缩
export type { CapacityRejection } from './capacity.ts'
// 模型目录与计价：装配、读数、探测三处使用
export {
  applySpecOverride,
  applyTransportCapabilities,
  builtinCatalog,
  CHAT_REASONING_PROTOCOLS,
  type ChatReasoningProtocol,
  type CostUsage,
  computeCost,
  costTerms,
  effortIsTransmittable,
  type LongContextTier,
  lookupModel,
  type ModelSpec,
  type OffPeakDiscount,
  officialBaseUrl,
  type PriceTerms,
  priceAt,
  type ReasoningReplay,
  reasoningReplay,
  type SpecOverride,
  transmittableEffortLevels,
  unknownModel,
  VENDORS,
} from './catalog.ts'
// 错误归类：agent 据此判定能否重试，server 据此决定前端引导动作；云端网关按同一判定识别并改写流内错误事件
export {
  classifyProviderError,
  classifyStreamError,
  failureDiagnostics,
  httpStatusName,
  ProviderError,
  streamErrorAt,
  streamErrorOf,
  transportFailureKind,
} from './errors.ts'
// 唯一的 adapter 构造入口
export { buildAdapter } from './factory.ts'
export { readImages } from './media/adapters/openai-images.ts'
export {
  openAIVideosAdapter,
  type VideoRequestFormat,
  type VideoTaskContext,
} from './media/adapters/openai-videos.ts'
// 云端任务号的格式：本机生成，云端按同一格式校验
export { CLOUD_JOB_ID, newCloudJobId } from './media/adapters/qywork.ts'
// 生成模型：目录（设置页与生成工具共用）、参数校验、发送前的花费、唯一的生成适配器构造入口
export {
  cloudModelSpec,
  findMediaModel,
  lookupMediaModel,
  type MediaInputCount,
  type MediaModelSpec,
  type MediaPrice,
  mediaCatalog,
  mediaCost,
  mediaKindsOf,
  meterParamsFor,
  quoteMedia,
} from './media/catalog.ts'
// 内置协议之外的生成协议与渠道：使用方启动时登记；登记的适配器使用下方的请求、任务与结果步骤，与内置适配器同一套
export {
  type MediaAdapterFactory,
  type MediaChannel,
  type MediaProtocol,
  registerMediaChannel,
  registerMediaProtocol,
} from './media/extension.ts'
export {
  count,
  dataUri,
  defined,
  download,
  getJson,
  postJson,
  sendJson,
  sniffMime,
  uploadName,
} from './media/http.ts'
export { isImageResult, resolveImages } from './media/image-result.ts'
export { buildMediaAdapter } from './media/index.ts'
export { describeParam, operationLabel, validateMediaCall } from './media/params.ts'
export {
  afterSubmit,
  failureDetail,
  pendingTask,
  postTask,
  type TaskPhase,
  type TaskState,
  taskPhase,
  waitTask,
} from './media/task.ts'
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
export {
  MEDIA_UNITS,
  type MediaUnit,
  meterMedia,
  UNITS_BY_OUTPUT,
  type UnitMeter,
  type UnitPrice,
  unitAmount,
  unitProblem,
} from './media/units.ts'
// 能力探测：cli 的 probe 子命令与设置页的「检测」按钮
export {
  describeProbe,
  type ProbeOutcome,
  probeModel,
  toTransportCapabilities,
} from './probe.ts'
// 模型网关透传上游响应时读取用量：分帧与接口地址的补全规则须与适配器相同，否则网关与客户端对同一地址得出不同的请求路径
export { normalizeBaseUrl } from './providers/openai-compat.ts'
// 拉取模型：设置页的「拉取模型」按钮
export {
  type PullChannel,
  type PullContext,
  PullError,
  type PulledModel,
  type PullResult,
  type PullSpecOf,
  type PullTarget,
  pullModels,
  registerPullChannel,
} from './pull/index.ts'
export type { PulledPrice } from './pull/plaza.ts'
export {
  type ChatPrice,
  chatPriceOf,
  imagePriceOf,
  type NewApiPricingEntry,
  type PriceBasis,
  priceBasis,
  quotaAmount,
  videoPriceOf,
} from './pull/pricing.ts'
// 模型网关只转发适配器会发送的请求字段
export { REQUEST_FIELDS } from './request-fields.ts'
// 云端技能标记：云端签发、校验与替换，本机解析与回传
export {
  isSkillPackageId,
  issueSkillMarker,
  parseSkillMarker,
  SKILL_MARKER_PREFIX,
  SKILL_MARKER_VERSION,
  type SkillMarker,
  type SkillSegmentRef,
  verifySkillMarker,
} from './skill-marker/marker.ts'
// SSE 分帧：模型网关读取用量与原样转发字节时与适配器同一规则
export {
  readSse,
  SSE_DONE,
  type SseBlock,
  type SseFrame,
  SseSplitter,
  sseJson,
} from './sse.ts'
// 字符估算：agent 在没有 count_tokens 的端点上将其作为后备
export {
  ANY_VIDEO,
  DEFAULT_DENSITY,
  estimateContent,
  estimateImage,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  estimateVideo,
  type FrameRule,
  type ImageRule,
  imageSizeOfBase64,
  TEXT_FEATURES,
  type TextFeature,
  THUMBNAIL_EDGE,
  type TokenDensity,
  textFeatures,
  type VideoOutOfRange,
  type VideoRange,
  type VideoRule,
  videoOutOfRange,
} from './tokens.ts'
// 流空闲上限的基准：agent 按思考档位放宽该值，runtime 的摘要直接使用该值
export { CLOUD_REQUEST_ID_HEADER, HEDGE_AFTER_MS, STREAM_IDLE_TIMEOUT_MS } from './transport.ts'
// 协议无关的请求与事件形状
export type {
  ChatRequest,
  ContentBlock,
  ImageSource,
  LlmAdapter,
  ProviderEvent,
  ProviderProfile,
  ProviderUsage,
  SystemBlock,
  TextFeatureCounts,
  ToolSchema,
  TransportCapabilities,
  VideoMeta,
  WireMessage,
  WireToolCall,
} from './types.ts'

export { diagnosticEndpoint, PROVIDER_HTTP, providerContentKind } from './types.ts'
