/**
 * 核心领域模型。
 *
 * 移植口径（对应 Python 版 harness/models.py）：
 * - run  = 一次用户回合（一次 agent loop）
 * - step = loop 内可回放的 text / tool_action / compaction
 * - 一次工具调用 = 一行 tool_action，原地从 running 更新到终态；没有 tool_call / tool_result 两行。
 * - thinking 只做实时状态，不落库回放。
 */

import type { ActionDescriptor } from '../protocol/events.ts'
import type { ConversationId, MessageId, ResourceId, RunId, StepId, WorkspaceId } from './ids.ts'

// ──────────────────────────── 共享词表 ────────────────────────────
//
// 配置、协议、界面三方都要说的那几个词。放在 core 是因为**只有它三方都够得着**：
// `ai` 在 L1、`runtime` 在 L5，而界面只依赖 core，写在任何一个更高层都会逼出
// 第二份拷贝。这两个词表原来正是这么散成六份和五份的。

/**
 * 思考强度档位，**弱到强有序**。
 *
 * 派生方向是「数组 → 类型」而不是反过来：类型只能在编译期存在，
 * 而 `qy probe` 要逐档试、适配器要按序比大小（`indexOf`），两处都需要
 * 一个能在运行期枚举的东西。反过来写就必然再抄一份数组出来。
 *
 * 注意：**「档位全集」和「某个模型支持哪些档」是两件事。**
 * `catalog.ts` 里各家 spec 的 `effortLevels` 是照实测填的事实声明，
 * 不能改成引用这个数组——那等于替新加的档位替所有厂商作保。
 */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_ORDER)[number]

/**
 * 权限模式。**只有两种**：`auto` 由硬边界 + 静态规则 + 分类器裁决，
 * `full` 全放行（`full` 仍保留三条硬边界）。
 *
 * 真源是服务端的 config.json，握手把它带给客户端；客户端只显示与请求修改，
 * 不自己存一份。
 */
export type PermissionMode = 'auto' | 'full'

// ─────────────────────────────── 会话 ───────────────────────────────

export interface Conversation {
  id: ConversationId
  /** 所属工作区（一个本地目录）。业务路径必须显式绑定，不做隐式全局回退。 */
  workspaceId: WorkspaceId
  title: string
  model: string
  /** 上下文压缩的唯一投影权威。有界 JSON，正文仍只存在 messages/steps 里。 */
  compactionManifest: CompactionManifest | null
  /** 用户显式重置缓存时递增；稳定路由键含该值，旧 provider 缓存自然隔离。 */
  cacheGeneration: number
  /**
   * null=用户会话，会出现在会话列表里；`'workflow'`=编排产生的机器会话，不出现。
   *
   * **只有这两个值，因为它只回答一个问题**：这条会话要不要进列表。
   *
   * 名字刻意取执行层的说法而不是 `'team'`：**Agent Team 是配置项**
   * （`.qy/team.json` 里的角色与编排图），不是底层执行概念。领域模型按配置功能
   * 命名，等于把「今天恰好只有这一种编排」写死进了数据形状——明天多一种编排，
   * 要么再加一个并列的值（两个值回答同一个问题），要么让新东西顶着 `team` 的名字跑。
   *
   * 「是哪一次编排、哪个角色」由 `sourceRef` 带，那才是该区分的地方。
   */
  source: 'workflow' | null
  sourceRef: string | null
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: MessageId
  conversationId: ConversationId
  role: 'user' | 'assistant'
  content: string
  attachments: Attachment[]
  createdAt: number
}

export interface Attachment {
  type: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** 工作区相对路径；外部粘贴的内容先落盘再引用，不把字节塞进消息。 */
  path: string
}

// ─────────────────────────────── Run ───────────────────────────────

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/**
 * 为什么停。废除「静默 done」——前端据此展示停止原因，用户不必追问「怎么暂停了」。
 */
export type StopReason =
  | 'completed'
  | 'max_steps'
  /**
   * 原地打转：同样的调用、同样的结果、没有任何副作用，连着两个周期。
   *
   * 与 `max_steps` 严格区分——那是「步数不够」，这是「多给一百步也一样」。
   * 判据见 `@qywork/agent` 的 `repeatsNoProgress`。
   */
  | 'no_progress'
  | 'user_interrupt'
  | 'permission_denied'
  /**
   * **输入**超出模型窗口。只有 provider 明确回容量拒绝（4xx + 原生容量码或强消息匹配）
   * 才能用这个值，判据见 `@qywork/ai` 的 `classifyCapacityRejection`。
   */
  | 'context_exhausted'
  /**
   * **输出**被 max_tokens 截断。答案不完整但已发生的部分是有效的。
   *
   * 与 `context_exhausted` 严格区分：一个是「说不下了」，一个是「听不下了」，
   * 用户的下一步动作完全不同（前者加大 max_tokens 或让模型分段，后者精简上下文）。
   * 曾经这两者被混成一个值，导致输出截断时提示用户去清理历史 —— 清了也没用。
   */
  | 'output_truncated'
  | 'provider_error'
  | 'internal_guard'
  | 'budget_exceeded'

export interface Run {
  id: RunId
  conversationId: ConversationId
  workspaceId: WorkspaceId
  userMessageId: MessageId | null
  /**
   * Run 创建时会话消息的高水位。执行锁在创建之后才获取；排队期间新增的消息
   * 不得穿越进本 run 的历史。
   */
  messageIdUpperBound: MessageId | null
  assistantMessageId: MessageId | null
  model: string
  /** 前端执行意图幂等键，(conversationId, clientRequestId) 唯一。 */
  clientRequestId: string
  status: RunStatus
  stopReason: StopReason | null

  usage: RunUsage
  stepCount: number

  errorMessage: string | null
  errorCode: string | null

  contextTokens: number
  contextLimit: number
  contextPercent: number

  /** 重试链：本 run 是哪个失败 run 的重试；本 run 被哪个新 run 接替。 */
  retryOfRunId: RunId | null
  supersededBy: RunId | null

  createdAt: number
  finishedAt: number | null
}

/**
 * 计价币种。
 *
 * **放在 core 而不是 ai 包里**，因为账本（store）、界面（web）和目录（ai）
 * 三边都要认它。各自定义一遍的下场这个仓库已经吃过一次（IGNORED_DIRS 抄了三份、
 * 漂成 13/12/11 条）。
 *
 * 只有实际出现在目录里的两种。加第三种时**同时**要看 `usage_ledger` 里
 * 已有的行——那些行的币种是历史事实，不能追认成别的。
 */
export type Currency = 'USD' | 'CNY'

export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', CNY: '¥' }

/**
 * 金额显示。**命令行和界面共用这一份**——两边各写一个必然漂移成
 * 「`qy usage` 说 $0.0001、面板说 $0.00」，而那种不一致没人会当成 bug 报出来。
 *
 * 小额必须看得见：真花了钱却显示 `$0.0000`，读起来就是「免费」。
 * 所以低于四位小数能表示的下限时显示 `<$0.0001` 而不是一串零——
 * 「小到显示不出来」和「没有」是两回事。
 */
export function formatMoney(amount: number, currency: Currency = 'USD'): string {
  const s = CURRENCY_SYMBOL[currency] ?? '$'
  if (amount === 0) return `${s}0.00`
  if (amount < 0.0001) return `<${s}0.0001`
  if (amount < 0.01) return `${s}${amount.toFixed(4)}`
  return `${s}${amount.toFixed(2)}`
}

/**
 * 多币种金额。**分开列，不合计**——把 ¥100 和 $20 加起来的那个数字没有意义。
 *
 * 空对象显示成零：那表示这段区间确实没花钱，不是「不知道」。
 */
export function formatCosts(cost: Record<string, number>): string {
  const parts = Object.entries(cost)
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cur, v]) => formatMoney(v, cur as Currency))
  return parts.length ? parts.join(' + ') : formatMoney(0)
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  /** 缓存读取命中。null 表示 provider 未回报，与真实 0 命中不是一回事。 */
  cachedTokens: number | null
  /** 缓存写入，与读取分离，便于与中转账单对账。 */
  cacheWriteTokens: number | null
  reasoningTokens: number
  /**
   * 累计花费，**单位是下面那个 `currency`，不是恒定美元**。
   *
   * 原来这个字段叫 `costUsd`。阿里 / 月之暗面 / 智谱三家官网按人民币标价，
   * 把 ¥6 装进一个叫 usd 的字段，差的是七倍，而且界面上完全看不出来
   * ——它只是一个数字。改名连同落盘的列名一起（迁移 7），
   * 留一个名字说谎的字段比改名危险。
   */
  cost: number
  /** 上面那个数字的币种。**不做汇率换算**：换算出来的是一个我们编的数字。 */
  currency: Currency
  /** 每轮一条，供命中率分桶与成本审计；不参与计费。 */
  turns: UsageTurn[]
}

export interface UsageTurn {
  turnIndex: number
  input: number
  output: number
  cached: number | null
  cacheWrite: number | null
  reasoning: number
  /** provider = 模型真回报；estimated = 本地估算兜底，二者不可混同。 */
  source: 'provider' | 'estimated'
  usageStatus: 'ok' | 'missing' | 'partial'
  costUsd: number
  at: number
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ─────────────────────────────── Step ───────────────────────────────

export type StepKind = 'text' | 'tool_action' | 'compaction'

export type ToolActionStatus = 'running' | 'success' | 'failure'

export interface Step {
  id: StepId
  runId: RunId
  seq: number
  kind: StepKind

  toolName: string | null
  toolCallId: string | null
  /** 同一 provider 响应的所有调用共享；保留「一个 assistant 轮 N 个调用」的原貌。 */
  providerBatchId: string | null
  callIndex: number | null
  /**
   * 一个 provider batch 内的后端执行边界。同 index 属于一次水平波次；
   * 不同 index 有先后；没进入波次规划的保持 null。
   */
  executionWaveIndex: number | null
  /**
   * 副作用工具的持久歧义边界：进入执行器前立即提交。
   * 崩溃恢复必须把「有时间戳的 running 行」当作「可能已执行」。
   */
  executionStartedAt: number | null

  content: string | null
  payload: StepPayload | null
  status: ToolActionStatus | 'done'
  createdAt: number
}

/**
 * `action` 随 step 一起落库，而不是让前端按工具名回猜。
 *
 * 动作语义由后端的 ToolSpec 解析（多动作门面会按参数分派），前端猜不出来——
 * 早期版本没存，刷新后所有历史工具卡都显示成「读取」，包括写入和执行命令。
 */
export type StepPayload =
  | { kind: 'tool_call'; args: Record<string, unknown>; action?: ActionDescriptor }
  | {
      kind: 'tool_result'
      args: Record<string, unknown>
      outcome: ToolOutcomeWire
      action?: ActionDescriptor
    }
  | { kind: 'compaction'; manifestRevision: number; compactedMessages: number }

/** 工具执行的规范结果，必须原样抵达 step 账本、事件流和 provider transcript。 */
export interface ToolOutcomeWire {
  status: 'success' | 'failure'
  /** 是否真的执行了。权限拒绝 / 未知工具 = false，绝不伪装成功。 */
  executed: boolean
  message: string
  data?: Record<string, unknown>
  /** 文件类工具产出的变更摘要，供实时预览与 diff 面板消费。 */
  fileChanges?: FileChange[]
  /** 本次调用落盘的中间资源引用。只含定位事实，不携带正文。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

// ─────────────────────────── 中间资源 ───────────────────────────

export type ResourceStatus = 'complete' | 'partial' | 'failed'

/**
 * 覆盖事实：投递给模型的那一段，相对于完整正文处于什么位置、占多少。
 *
 * 这几个数字**必须随结果一起交给模型**。只给一段截断正文而不说
 * 「这是 2.3 MB 里的 8 KB」，模型会把它当成全部，然后基于不完整的信息下结论——
 * 比不给它更糟，因为它不知道自己不知道。
 */
export interface ResourceCoverage {
  deliveredBytes?: number
  totalBytes?: number
  truncated?: boolean
  /** 产生它的查询/命令/URL，供模型判断这段内容的语义。 */
  query?: string
  [k: string]: unknown
}

/** 执行记录里的落地正文引用；只含定位事实，正文在内容库里按哈希寻址。 */
export interface IntermediateResourceRef {
  resourceId: ResourceId
  status: ResourceStatus
  contentHash: string | null
  sizeBytes: number
  mimeType: string | null
  coverage: ResourceCoverage
}

export interface FileChange {
  path: string
  changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  renamedFrom?: string
}

// ─────────────────────────────── 产物 ───────────────────────────────

// ─────────────────────────────── 上下文压缩 ───────────────────────────────

export interface CompactionManifest {
  revision: number
  /** 该 id 及之前的消息已被摘要替代。 */
  compactedThroughMessageId: MessageId | null
  /**
   * 累计被摘要替代掉的消息条数。
   *
   * 这里曾经是 `compactedRunSteps: Record<runId, 步数>`——**没有任何投影消费它**
   * （投影只按 `compactedThroughMessageId` 过滤），唯一的读者是前端，
   * 而它拿 `Object.keys(...).length`（run 个数）当消息数显示，数字本身是错的。
   */
  compactedMessageCount: number
  summary: string
  /** 摘要保留的精确事实包（文件路径、决定、未完成项），不是自由文本。 */
  facts: CompactionFacts
  createdAt: number
}

export interface CompactionFacts {
  filesTouched: string[]
  openItems: string[]
  userConstraints: string[]
}

// ─────────────────────────────── 工作区 ───────────────────────────────

export interface Workspace {
  id: WorkspaceId
  name: string
  rootPath: string
  /** 上次打开时间，用于「最近」列表排序。 */
  lastOpenedAt: number
  createdAt: number
  /**
   * 置顶时间。不存在这个键 = 没置顶。
   *
   * 存时间戳不存布尔：多个置顶项目之间也要有确定顺序（后置顶的在前）。
   */
  pinnedAt?: number
}
