/**
 * `@qywork/ai` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前六个模块走 `export *`，
 * 把三十八个符号推到包外，其中十四个没有任何包外调用点。
 * 现在只导出真实有外部消费者的，逐个核过调用点。
 *
 * **三个 adapter 类刻意不导出。** 分派只发生一次（`buildAdapter` 按 `profile.kind`），
 * 之后调用方只见 `LlmAdapter` 接口——把具体类推出去就是在邀请下游
 * `instanceof` 或判 kind，而那正是 CLAUDE.md B1「里氏替换」点名要防的。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 */

// 容量拒绝：agent 的压缩循环按它决定要不要压
export type { CapacityRejection } from './capacity.ts'
// 模型目录与计价：装配、读数、探测三处都要
export {
  applySpecOverride,
  builtinCatalog,
  type CacheRouting,
  computeCost,
  effortIsTransmittable,
  lookupModel,
  type ModelSpec,
  type OffPeakDiscount,
  type ProviderKind,
  priceAt,
  type SpecOverride,
  type ThinkingMode,
  unknownModel,
  VENDORS,
} from './catalog.ts'
// 错误归类：agent 判可否重试，server 决定前端引导动作
export { classifyProviderError, ProviderError } from './errors.ts'
// 唯一的 adapter 构造入口
export { buildAdapter } from './factory.ts'
// 能力探测：cli 的 probe 子命令与设置页的「探测」按钮
export { describeProbe, type ProbeOutcome, probeModel, toCapabilities } from './probe.ts'
// 字符估算：agent 在没有 count_tokens 的端点上用它兜底
export {
  estimateContent,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  MEDIA_TOKENS,
} from './tokens.ts'
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
  WireMessage,
  WireToolCall,
} from './types.ts'
