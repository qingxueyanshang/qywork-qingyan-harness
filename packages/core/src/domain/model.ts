/**
 * 核心领域模型。
 *
 * 口径：
 * - run  = 一次用户回合（一次 agent loop）
 * - step = loop 内可回放的 text / tool_action / compaction
 * - 一次工具调用 = 一行 tool_action，原地从 running 更新到终态；没有 tool_call / tool_result 两行。
 * - thinking **不回放给用户**，但要落库——两件事。给用户看的回放不含它；
 *   而 DeepSeek 类兼容端点要求带 tool_calls 的 assistant 消息原样回传
 *   `reasoning_content`，否则后续轮次 400。历史从 steps 投影回去时缺这一段
 *   就是必然的 400，所以它借 tool_action 首条的 `content` 落库。
 */

import type { ActionDescriptor } from '../protocol/events.ts'
import type {
  ConversationId,
  GoalId,
  MessageId,
  ProviderRequestId,
  ResourceId,
  RunId,
  StepId,
  WorkspaceId,
} from './ids.ts'

// ──────────────────────────── 共享词表 ────────────────────────────
//
// 配置、协议、界面三方都要说的那几个词。放在 core 是因为**只有它三方都够得着**：
// `ai` 在 L1、`runtime` 在 L5，而界面只依赖 core，写在任何一个更高层都会逼出
// 第二份拷贝，而拷贝之间会漂。

/**
 * 思考强度档位，**弱到强有序**。
 *
 * 派生方向是「数组 → 类型」而不是反过来：类型只能在编译期存在，
 * 而 `qy probe` 要逐档试、适配器要按序比大小（`indexOf`），两处都需要
 * 一个能在运行期枚举的数组。反过来写就必然再抄一份出来。
 *
 * 注意：**「档位全集」和「某个模型支持哪些档」是两件事。**
 * `catalog.ts` 里各家 spec 的 `effortLevels` 是照实测填的事实声明，
 * 不能改成引用这个数组——那等于替新加的档位替所有厂商作保。
 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_ORDER)[number]

/**
 * 权限模式。**只有两种**：`auto` 由硬边界 + 静态规则 + 分类器裁决，
 * `full` 全放行（`full` 仍保留三条硬边界）。
 *
 * 真源是服务端的 config.json，握手把它带给客户端；客户端只显示与请求修改，
 * 不自己存一份。
 */
export type PermissionMode = 'auto' | 'full'

/**
 * 接口说哪套协议。**是协议，不是厂商**——DeepSeek、OpenAI、任何中转站都可以是
 * `openai_chat_completions`。
 *
 * 顺序即界面顺序（接口协议下拉、模型库保存扇出的默认清单），改序会改界面。
 */
export const PROVIDER_KINDS = [
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/**
 * 思考强度怎么发到线上。**每条模型在每条协议上各有一个值**，由模型库那一格裁决。
 *
 * 派生方向同 `EFFORT_ORDER`：数组在前，因为落盘校验要在运行期逐个比对。
 */
export const THINKING_MODES = [
  /** 只接受 `{type:'adaptive'}`；`budget_tokens` 会 400。 */
  'adaptive_only',
  /** 思考恒开，连 `{type:'disabled'}` 都会 400——只能省略 thinking 字段。 */
  'always_on',
  /** 老模型：`{type:'enabled', budget_tokens:N}`。 */
  'budget_tokens',
  /**
   * OpenAI Responses 形态：思考默认开着，靠 `reasoning.effort` 控制，
   * **`'none'` 是唯一能真的关掉它的值**。
   *
   * 与 `always_on` 的区别是「关得掉」，与 `none` 的区别是「本来就在思考」。
   * 这两条差别都要钱：当成 `always_on` 会让「不思考」这个选项静默失效，
   * 当成 `none` 会让适配器一个 reasoning 字段都不发、因此同样关不掉。
   *
   * 实测（2026-08，deepseek-v4-flash / max_output_tokens=900，各三次）：
   * `effort:'none'` → reasoning_tokens 0/0/0；其余每一档都是 899~900。
   * 即除 `none` 外，**effort 被接受但不被采纳**——
   * 这类模型的 `effortLevels` 应当照实填 `[]`。
   */
  'reasoning_effort',
  /**
   * DeepSeek 自己的那套：**`thinking` 开关和 `reasoning_effort` 档位要一起发**。
   *
   * 只发 `reasoning_effort` 不发 `thinking` 时思考没开，档位自然没有效果。
   * 那个现象容易被归因成「模型不支持 effort」，实际是少发了一半。
   */
  'deepseek_thinking',
  'none',
] as const
export type ThinkingMode = (typeof THINKING_MODES)[number]

/**
 * 缓存路由亲和键的发法。
 *
 * `prompt_cache_key` 是 OpenAI Responses / 部分兼容端点的请求体字段；
 * `x_grok_conv_id` 是 xAI Chat Completions 的同义请求头。两者都用于把同一会话
 * 路由到同一缓存分片，但上线位置不同，不能因为都叫“亲和键”就混发。
 */
export const CACHE_ROUTINGS = ['prompt_cache_key', 'x_grok_conv_id', 'none'] as const
export type CacheRouting = (typeof CACHE_ROUTINGS)[number]

/**
 * 带 tool_calls 的历史消息，要不要把上一轮的推理原文回传给端点。
 *
 * 这是**接收请求的那个端点**的要求，不是历史的属性——所以它归模型库那一格。
 * 不要改回「从历史里有没有推理文本反推」：摘要型端点（`reasoning.summary`）
 * 同样会给出推理文本，反推必然假阳性，而假阳性的代价是每一轮工具调用之后
 * 都发不出去。
 *
 * 只有 Responses 适配器消费它。
 */
export const REASONING_ECHOES = [
  /** 不回传。 */
  'none',
  /** 回传 `{type:'reasoning', content:[{type:'reasoning_text'}]}`。 */
  'reasoning_text',
] as const
export type ReasoningEcho = (typeof REASONING_ECHOES)[number]

// ─────────────────────────────── 会话 ───────────────────────────────

export interface Conversation {
  id: ConversationId
  /** 所属工作区（一个本地目录）。业务路径必须显式绑定，不做隐式全局回退。 */
  workspaceId: WorkspaceId
  title: string
  /**
   * 这条会话发给哪个接口（`config.providers` 的键）。
   *
   * **和 `model` 是一对，不能只存一半。** 两个接口挂同一个模型 id 是常态
   * （两家中转站都转 `claude-opus-5`），只存模型的话「这条会话归谁」在落盘那一刻
   * 就不存在了，后面每一层都只能按 id 反查，查出哪个取决于对象键的枚举顺序。
   *
   * 空串 = 迁移 24 之前建的会话，没记过接口；按模型 id 反查，与迁移前行为一致。
   * 新建会话一律写实名。
   */
  provider: string
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
   * 要么再加一个并列的值（两个值回答同一个问题），要么让新的编排顶着 `team` 的名字跑。
   *
   * 「是哪一次编排、哪个角色」由 `sourceRef` 带，那才是该区分的地方。
   */
  source: 'workflow' | null
  sourceRef: string | null
  createdAt: number
  updatedAt: number
}

/** 侧栏那一行放得下的字数。 */
const TITLE_MAX = 30

/**
 * 从第一条用户消息派生标题：取首行、压空白、截断。
 *
 * 空正文回空串，**不要造假标题**（「图片」之类）——空串由界面兜底成「新对话」。
 */
export function deriveConversationTitle(prompt: string): string {
  const line = (prompt.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim()
  // 按字符截：slice 会把代理对（emoji）劈成半个字符。
  const chars = [...line]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : line
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
  /**
   * 对**路径型**附件不是真值——组装它的是前端，那时候拿不到字节数，填 0。
   * 要用真实大小就去 `stat`，不要信这一格。
   */
  size: number
  /**
   * 这个文件在本机的位置：绝对路径，或工作区相对路径。
   *
   * **字节不进消息。** 拿得到源路径时（桌面端拖入、原生选择器）这里就是源文件的
   * 位置，一个字节都不落盘；只有连源文件都不存在（剪贴板里只有位图、浏览器不给
   * 路径）才先落盘再引用那一份。
   *
   * 两种取值由同一条解析规则吃下——相对路径按工作区解，绝对路径直接用
   * （`tools` 的 `resolveInWorkspace`）。不要为此加第二个字段。
   *
   * 一律正斜杠：这个值要跨端传（手机也发得到），反斜杠在别处会被当转义。
   * Windows 的 `D:/x/y.png` 各 API 都认。
   */
  path: string
}

/**
 * 会被内联成图像块的扩展名。
 *
 * **刻意判得窄，且必须与「发出去时内联哪些」严格同源。** 放宽到 `image/*`
 * 会把 svg、bmp 之类也推成 `type: 'image'`，而多数 provider 拒收它们——
 * 表现是界面上显示成图片、发出去整条请求 400。
 *
 * 按扩展名而不是 mime：路径型附件没有 mime，它只有一个路径。
 */
const INLINE_IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i

/** 这个路径或文件名算不算可内联的图片。 */
export function isInlineImage(pathOrName: string): boolean {
  return INLINE_IMAGE_RE.test(pathOrName)
}

/** 扩展名 → mime。只覆盖可内联的那几种，其余交给通用二进制类型。 */
export function mimeOf(pathOrName: string): string {
  const ext = pathOrName.slice(pathOrName.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

/** 附件分类。判据与 `isInlineImage` 同一处，不要在别处再判一次。 */
export function attachmentTypeOf(pathOrName: string): Attachment['type'] {
  return isInlineImage(pathOrName) ? 'image' : 'file'
}

/** 路径里的文件名。两种分隔符都要吃——拖放给的是平台原生分隔符。 */
export function baseNameOf(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

/** 反斜杠统一成正斜杠。见 `Attachment.path` 的约定。 */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// ─────────────────────────────── Run ───────────────────────────────

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

/**
 * 一次 run 开始时冻结的非对话上下文。
 *
 * 它属于运行输入，不属于用户消息，也不进入公开 `Run`：store 负责持久化，runtime
 * 负责在对应的真实用户消息前重建，provider 适配器再把它并入那条用户消息。
 */
export interface RunContextSegment {
  content: string
  group: 'workspaceState' | 'skills' | 'memory' | 'mcpTools'
}

/**
 * 为什么停。废除「静默 done」——前端据此展示停止原因，用户不必追问「怎么暂停了」。
 */
export type StopReason =
  | 'completed'
  | 'max_steps'
  /**
   * 原地打转：同样的执行周期、同样的结果或待办快照、没有任何副作用，连续三次。
   *
   * 与 `max_steps` 严格区分——那是「步数不够」，这是「多给一百步也一样」。
   * 判据见 `@qywork/agent` 的 `repeatsNoProgress`。
   */
  | 'no_progress'
  | 'user_interrupt'
  /**
   * 进程退出，本轮到此为止，但**没有工具停在执行中**，已完成的步骤结果可信
   * （`store` 的 `recoverStaleRuns`）。
   *
   * **不要并进 `user_interrupt`。** 那是「用户按了停止」，这是「进程没了」——
   * 事后分不出这两件事，界面上就只剩一句「已中断」，而用户没点过停止。
   * 与 `internal_guard` 的区别是结果可不可信：那条有工具停在执行中。
   */
  | 'process_exit'
  /**
   * **输出**被 max_tokens 截断。答案不完整但已发生的部分是有效的。
   *
   * **不要在这条轴上再并列一个「输入超窗」。** 两者混成一个值的后果是输出截断时
   * 提示用户去清理历史，而清了也没用。输入超窗由 `run.error.code = 'context_overflow'`
   * 表达，停止原因是 `provider_error`——一件事一本账。
   */
  | 'output_truncated'
  | 'provider_error'
  /**
   * 上次进程在工具执行期间退出，这一轮跑到哪判不明（`store` 的 `recoverStaleRuns`）。
   * 与 `user_interrupt` 分开：那是用户按了停止、已完成的步骤结果可信，这条不可信。
   */
  | 'internal_guard'

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

  // 上下文读数不在这里。真源是 `ProviderRequest`——一个 run 有 N 次请求，
  // 账就该有 N 行；挂在 run 上的标量每 step 覆盖一次，只剩最后一次的读数。

  createdAt: number
  finishedAt: number | null
}

/**
 * 计价币种。
 *
 * **放在 core 而不是 ai 包里**，因为账本（store）、界面（web）和目录（ai）
 * 三边都要认它。各自定义一遍的下场是三份拷贝各自漂移（`IGNORED_DIRS` 抄成三份时
 * 已经漂成 13/12/11 条）。
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
   * **不要叫它 `costUsd`。** 阿里 / 月之暗面 / 智谱三家官网按人民币标价，
   * 把 ¥6 装进一个叫 usd 的字段差的是七倍，而界面上完全看不出来——它只是一个数字。
   * 落盘的列名同名（迁移 7）。
   */
  cost: number
  /** 上面那个数字的币种。**不做汇率换算**：换算出来的数字没有出处。 */
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

// ─────────────────────────────── 用量账本 ───────────────────────────────
//
// **形状放在 core，不放在 store。** 写它的是 store、发它的是 server、画它的是 web，
// 三边都要认这几个形状；放在 store 里的话，web 够不着（依赖只能朝底层走），
// 因此只能各抄一份，而改一个字段名时另外两份不会红。

/**
 * 花钱的种类。
 *
 * 每一条都是**独立于 run 的一笔开销**，不加进来就意味着那笔钱在界面上不存在。
 * `summary`（压缩时的摘要调用）是典型：不进账本它就完全看不见，
 * 压缩越频繁账单和界面差得越多。
 *
 * `classifier` 是权限裁决的那次小模型调用。它按**每条待判命令**计费，
 * 频次可能比 run 本身高一个量级，所以必须能单独查——
 * `qy usage --by kind` 才答得出「裁决占了多少」，以及要不要换个更小的模型。
 */
export type UsageKind = 'run' | 'summary' | 'team' | 'classifier'

export interface UsageTotals {
  entries: number
  inputTokens: number
  outputTokens: number
  /** null = 这段区间里没有任何一笔回报过缓存。不要显示成 0。 */
  cachedTokens: number | null
  /** 同上。缓存写入与命中分开记，两者计价不同。 */
  cacheWriteTokens: number | null
  reasoningTokens: number
  /**
   * **按币种分开，不合计也不换算。**
   *
   * 只放这段区间里真的出现过的币种——空对象就是「这段区间没花钱」。
   * 合成一个数字要一个汇率，而汇率天天变，落盘之后那个数字就不再成立，
   * 而它看起来仍然是个确切的金额。
   */
  cost: Record<string, number>
}

export interface UsageBucket extends UsageTotals {
  /** 分组键：模型名 / 日期 / 工作区 id。 */
  key: string
}

/** 账本里的一行。`runId` 为空即这笔不属于任何一轮（压缩摘要就是这种）。 */
export interface UsageLedgerRow {
  id: string
  kind: UsageKind
  runId: string | null
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number | null
  cacheWriteTokens: number | null
  cost: number
  currency: Currency
  occurredAt: number
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * 待办进度。**唯一的算法**，工具回执与输入框上那条状态条共用它。
 *
 * 各算各的后果是同一屏上两个数打架：工具卡写「（0/5）」（数已完成），
 * 状态条写「第 1 / 5 步」（数正在做的那条），而它们说的是同一份清单的同一时刻。
 * 口径靠共享这一个函数统一，不靠两边约定。
 *
 * **两个数各有各的用处，不许互相冒充。**
 *
 * - `step` 取**正在做的那一条**（1-based）。它是**位置**，不是完成量——
 *   报「第 3 步」时第 3 步一个字都还没写。所以**只能和条目名一起说**
 *   （「第 3/4 步：编写 main.js」）。光秃秃一句「第 3 / 4 步」会被读成
 *   「4 步做完了 3 步」，而这话是假的。
 * - `done` 是真的做完了几条。**没有条目名可带的地方一律用它**
 *   （输入区那条状态条），它和待办面板上勾的数目恒等。
 *
 * `step` 在没有进行中那条时（刚打完勾、还没认领下一条）回落到 `done`。
 */
export function todoProgress(todos: readonly TodoItem[]): {
  /** 1-based；没有进行中的那条时等于已完成数。 */
  step: number
  total: number
  done: number
  /** 正在做的那一条；没有就是 null（全做完，或者打完勾还没认领下一条）。 */
  current: TodoItem | null
} {
  const done = todos.filter((t) => t.status === 'completed').length
  const at = todos.findIndex((t) => t.status === 'in_progress')
  return {
    step: at >= 0 ? at + 1 : done,
    total: todos.length,
    done,
    current: at >= 0 ? todos[at]! : null,
  }
}

// ─────────────────────────────── 目标 ───────────────────────────────

/**
 * 目标的生命周期。**四个，不再多。**
 *
 * 「provider 报错」「要人工输入」「原地打转」不各占一个状态——全部走
 * `blocked`，靠 `blockedCode` + `blockedReason` 区分。状态越多转移矩阵越大，
 * 而它们对用户的意义是同一件事：停了，等用户输入。
 */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked'

/**
 * 一条会话的当前目标。**同时只有一个**，不做并行目标。
 *
 * 待办（`TodoItem`）回答「这一轮进行到哪了」，目标回答「一轮接一轮要做到什么」：
 * 目标 `active` 时，每轮 run 收尾会自动再起一轮（`server/run-control.ts`）。
 *
 * **没有轮数上限。** 循环的出口只有三个：**模型自检达成 → `complete`**、模型做不下去 →
 * `blocked`、用户点停止 → `paused`。此外服务端还会在这一轮没正常收尾时
 * （provider 报错、权限被拒、原地打转）转 `blocked`——那是异常出口，不是配额。
 *
 * 不设「最多跑 N 轮」：那个数用户没有依据去定，而它一旦露在界面上就变成了
 * 循环的主要说法，把「做到没有」换成了「还剩几轮」。达没达成由目标本身判，
 * 不由计数器判。
 */
export interface Goal {
  id: GoalId
  conversationId: ConversationId
  objective: string
  status: GoalStatus
  /**
   * 从 1 开始单调递增，每次变更 +1。
   *
   * 写入方必须带上自己读到的那个 revision，对不上直接拒——模型手里的目标可能
   * 是几轮之前读的，静默覆盖会把中间那次暂停或改写抹掉。
   */
  revision: number
  /** `blocked` 专有：机器可读的短代码，供界面分类。其余状态为 null。 */
  blockedCode: string | null
  /** `blocked` 专有：一句人话说明卡在哪。**必填**，否则没人知道它为什么停。 */
  blockedReason: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 目标上的五个动作。**`update_goal` 一个工具全包**（见 §4.1 的第二档门面判据）：
 * 五个动作共享必填的 `goal_id` + `revision`，差异只在两条条件必填。
 */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

/**
 * 一次目标变更的结果。
 *
 * **失败是返回值不是异常**：绝大多数调用方是工具，而工具要把「为什么被拒」
 * 原样交给模型（revision 过期、状态不允许、缺理由），异常在那条路上会被
 * 注册表压成一句「工具执行出错」。
 */
export type GoalWriteResult =
  | { ok: true; goal: Goal }
  | { ok: false; code: string; message: string }

// ─────────────────────────────── Step ───────────────────────────────

/**
 * step 的种类。
 *
 * `user` 是唯一不由模型产生的一种：run 跑到一半时用户插进来的那句话
 * （「调整方向」）。**它必须落在 steps 而不是 `messages`**——历史投影的骨架是
 * 「messages 按 id 升序，每条后面挂 `userMessageId` 指向它的那些 run 的全部 steps」
 * （`runtime/transcript.ts` 的 `buildHistory`），写进 `messages` 的行下一轮会被重排到
 * 整个 run 的全部步骤之后，注入点在回放里的时序因此与活的 transcript 不一致。
 * 落 steps 则位置由 seq 决定，两侧逐条同位。
 */
export type StepKind = 'text' | 'tool_action' | 'compaction' | 'thinking' | 'user'

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
  /**
   * 这次工具调用跑了多久（毫秒）。**只有 `tool_action` 有，且只有落过终态的才有。**
   *
   * 与 `executionStartedAt` 分工：那个是进执行器之前写下的时间戳（崩溃恢复的歧义
   * 边界），这个是执行完的时长。**不要拿两者相减代替它**——前者在提交事务时写，
   * 与执行器实际起跑差着一次落盘。
   *
   * 迁移 28 之前的行是 null：那些调用真实发生过，时长没有落库。
   */
  durationMs: number | null
}

/**
 * `action` 随 step 一起落库，而不是让前端按工具名回猜。
 *
 * 动作语义由后端的 ToolSpec 解析（多动作门面会按参数分派），前端猜不出来——
 * 早期版本没存，刷新后所有历史工具卡都显示成「读取」，包括写入和执行命令。
 */
export type StepPayload =
  | {
      kind: 'tool_call'
      args: Record<string, unknown>
      action?: ActionDescriptor
      /**
       * 内置子 agent 的会话入口。子会话一创建就写入，不等工具跑完：用户切走父会话
       * 再切回来时，运行中的 step 还没有 outcome，回放仍要能点开那条子会话。
       */
      childConversationId?: ConversationId
    }
  | {
      kind: 'tool_result'
      /**
       * **可缺**。正常终态一定有，但恢复/中断收尾（`settleRunningSteps`）
       * 整体替换 payload 时 `args` 与 `action` 会被抹掉——那一刻可知的只有
       * 「这次调用没有终态」，重建不出调用参数。
       *
       * **不能声明成必填**：写入侧确实在写不带它的行，声明必填就是类型说的和库里
       * 躺的不是一回事，历史投影会在孤儿行上拿到 undefined 再展开。
       * 消费方（`runtime/transcript.ts`）的口径是 `args ?? {}`，
       * 且那种行的 status 必然是 failure——模型看到「调用失败、参数已不可考」，
       * 而不是一次「参数为空却自称成功」的记录。
       */
      args?: Record<string, unknown>
      outcome: ToolOutcomeWire
      action?: ActionDescriptor
      /**
       * 崩溃恢复会在原 payload 上把 tool_call 改成 tool_result，因此早先写入的入口
       * 仍可能留在这里。正常终态同时会在 outcome.data.conversationId 里带一份。
       */
      childConversationId?: ConversationId
    }
  | {
      kind: 'compaction'
      /**
       * 压缩终态，与 `CompactionEvent.phase` 同源；刷新之后压缩卡按它重建。
       *
       * **可缺**：这个键之前不存在，旧行读出 `undefined`。历史事实不回改，
       * 消费方按「已压缩」显示。
       */
      phase?: 'done' | 'skipped' | 'failed'
      manifestRevision: number
      compactedMessages: number
      /** `phase='done'` 专有：摘要线跟着前移了（true），还是只收纳了工具正文（false）。 */
      summarized?: boolean
      reasonCode?: string
    }
  | {
      /**
       * run 内注入的那句用户消息。正文在 `content` 列，与 `text` / `thinking` 同法；
       * 这里只装附件引用。
       */
      kind: 'user'
      attachments?: Attachment[]
    }

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

/**
 * 一条排着的跟进消息。
 *
 * 会话正忙时用户发的消息进这份队列，去向由 `steer` 决定：注入当前这一轮，
 * 或者等这一轮跑完再作为下一轮发起。**进 run 之前它不落任何表**——
 * 队列是进程内的意志，不是账本事实，落盘的队列会在崩溃重启后自己跑起来。
 */
export interface FollowUp {
  /**
   * 幂等键，直接用 `message.send` 的 `clientRequestId`。
   *
   * 一个键三用：服务端按它去重、客户端的乐观卡按它与服务端快照对账、
   * 卡片上的翻转与删除按它寻址。
   */
  id: string
  content: string
  attachments?: Attachment[]
  /** true = 在当前 run 的下一个 step 边界注入；false = 等这一轮收尾后发起下一轮。 */
  steer: boolean
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

// ─────────────────────────────── 上下文分组 ───────────────────────────────

/**
 * 上下文占用的分组口径。**这是唯一一份**，面板、装配层、账本都用它。
 *
 * 十个键是固定的：改切法就等于换一把尺，历史会话的面板数字与新会话再也没法对照，
 * 排查时连「谁和谁应该一样」都说不清。要加类目就加，别把已有的合并或改名。
 *
 * 定义在 `core` 而不是 `ai`：`ai` 的 `WireMessage._group` 与 `core` 的事件协议
 * 必须是同一个类型。放在 `ai` 里的话 `core` 引不到（依赖只能朝下层走），
 * 否则两处各写一份枚举：一份十个键、另一份七个不同名的桶，而面板只建在其中一份上。
 */
export type ContextGroup =
  | 'systemPrompt'
  | 'systemTools'
  | 'mcpTools'
  | 'skills'
  | 'memory'
  | 'summary'
  | 'historyMessages'
  | 'executionRecords'
  | 'intermediateContent'
  | 'workspaceState'

/**
 * 分组顺序。**面板按这个顺序定序渲染，零值行也显示。**
 *
 * 顺序本身是协议的一部分：按值排序会让行随数字大小上下跳，用户在上面找一行
 * 得每次重新扫一遍；而零值行不显示会让行数随会话变化——上一秒有九行，
 * 下一秒十行，浮层高度跟着跳（B9）。
 */
export const CONTEXT_GROUPS: readonly ContextGroup[] = [
  'historyMessages',
  'executionRecords',
  'intermediateContent',
  'systemTools',
  'mcpTools',
  'systemPrompt',
  'memory',
  'skills',
  'summary',
  'workspaceState',
]

/** 各分组的 token 占用。键集与 `ContextGroup` 恒等，不允许出现别的键。 */
export type ContextBreakdown = Record<ContextGroup, number>

/**
 * **没有发给模型**的那部分原文有多少。
 *
 * 压缩把一段历史换成摘要、把工具结果换成定位符之后，原文仍在账本里躺着，
 * 只是没进这次请求。这两个数回答「什么被拿掉了」——面板只报「被谁占的」
 * 是半张账，用户看到占用下降却不知道降在哪里。
 *
 * 能报出这个数的前提是**压缩是投影、不销毁原文**：原文还在 Step / 正文库里，
 * 装配时用同一把尺量两次相减就得到它。一旦哪天改成直接改写正文，原文就不在
 * 任何可测处，这两个数就失去依据——届时该删掉它们，不是估一个填上。
 */
export interface ContextOmitted {
  /** 被摘要替代掉的历史消息原文。 */
  historyOriginal: number
  /** 被定位符存根替代掉的工具结果正文。 */
  intermediateOriginal: number
}

export function emptyBreakdown(): ContextBreakdown {
  return {
    systemPrompt: 0,
    systemTools: 0,
    mcpTools: 0,
    skills: 0,
    memory: 0,
    summary: 0,
    historyMessages: 0,
    executionRecords: 0,
    intermediateContent: 0,
    workspaceState: 0,
  }
}

export function emptyOmitted(): ContextOmitted {
  return { historyOriginal: 0, intermediateOriginal: 0 }
}

/**
 * 会随对话增长的那三个桶。对账的差额优先往这里归。
 *
 * 其余桶（系统提示词、工具 schema、记忆、技能、工作区）在装配时是逐字可数的，
 * 估算误差极小；把差额摊到它们头上等于把最准的数改错。
 */
const VARIABLE_GROUPS: readonly ContextGroup[] = [
  'historyMessages',
  'executionRecords',
  'intermediateContent',
]

/** 其余的。顺序沿用 `CONTEXT_GROUPS`，差额摊不进可变桶时才动它们。 */
const FIXED_GROUPS: readonly ContextGroup[] = CONTEXT_GROUPS.filter(
  (g) => !VARIABLE_GROUPS.includes(g),
)

/**
 * 把 `keys` 这几个桶按现有占比重新分配，使它们之和**精确等于** `want`。
 *
 * 余数给其中最大的那个，不留一两个 token 的尾巴。
 * 全为零时没有占比可依据，整块给第一个键。
 */
function allocate(out: ContextBreakdown, keys: readonly ContextGroup[], want: number): void {
  const base = keys.reduce((n, k) => n + out[k], 0)
  const first = keys[0]
  if (!first) return
  if (base <= 0) {
    for (const k of keys) out[k] = 0
    out[first] = want
    return
  }
  let assigned = 0
  let biggest = first
  for (const k of keys) {
    out[k] = Math.trunc((out[k] / base) * want)
    assigned += out[k]
    if (out[k] > out[biggest]) biggest = k
  }
  out[biggest] += want - assigned
}

/**
 * 让分组之和恒等于总数。
 *
 * **为什么必须对账。** 总数是 provider 真值，分组是本地估算，两者天然不等。差额里还结构性地含着
 * 上一轮的输出 token——它不属于任何一个桶，但它确实占着窗口，下一轮就是历史的
 * 一部分。不对账的话，面板上「各行加起来」和「标题上那个数」对不上，而差额会
 * 无声地落进「剩余空间」那一行。
 *
 * 也不要用「各组之和略小于总数：总数含请求体本身的结构开销」这类话糊过去——
 * 那是错的，差额里有真实内容（tool call 参数、思考正文、被按自然语言口径低估的
 * base64）。实测过一次代价：两张按文本发出去的 PNG 让总数与分组差了 271k，
 * 面板上各行加起来只有 36.9%，剩下的全躺在「剩余空间」里，没有任何一行指向它们。
 *
 * **吸收法，不是缩放法。** 固定类目保实测值，差额归到误差实际所在的桶——三个可变桶按各自占比分摊。
 *
 * **不要改成「一律按占比缩放全部类目」。** 那要求全部类目出自同一把尺、误差均匀，
 * 而这里是估算，误差集中在会变的那几个桶上。
 *
 * **真值低于固定类目时。** 真值小到连固定类目本身都装不下（会话刚开始、工具表的估算比真值高）时，
 * 可变桶清零也补不平，这时**才**按占比缩固定类目。
 * 「各行加起来等于标题」优先于「固定类目保实测值」——前者用户一眼就能验，
 * 后者他无从验证；而钳到零之后放着不管，面板给出的又是一组对不上的数。
 *
 * **边界。** 按占比分摊只保证**和**是对的，不保证差额落在真正出错的那个桶上——误差实际
 * 集中在某一个桶时，另外两个会跟着被抬高。所以这个函数回答的是「总共被占了多少、
 * 大致是谁」，不是「哪一个桶算错了」。定位单个桶的误差要看逐请求账。
 */
export function reconcileBreakdown(breakdown: ContextBreakdown, total: number): ContextBreakdown {
  const out = { ...breakdown }
  const target = Math.max(0, total)
  const sum = Object.values(out).reduce((n, v) => n + v, 0)
  if (sum === target) return out
  if (sum === 0) {
    out.historyMessages = target
    return out
  }

  const fixedSum = FIXED_GROUPS.reduce((n, k) => n + out[k], 0)
  if (target >= fixedSum) {
    allocate(out, VARIABLE_GROUPS, target - fixedSum)
    return out
  }
  for (const k of VARIABLE_GROUPS) out[k] = 0
  allocate(out, FIXED_GROUPS, target)
  return out
}

/**
 * 请求信封那部分的占用：系统提示词 + 两张工具表。
 *
 * 三项与 `envelopeHashOf`（`agent/loop.ts`）哈希的 `[model, system, tools]` 逐项
 * 对应。信封换了一份时要重估的只有这三项，多算一项就把没变的内容也重估了一遍。
 *
 * **具名导出，两处都调它，不许各写一遍相加。** 锚点修正在 loop 与
 * `runtime/context-panel.ts` 两处发生，两份定义一旦漂移，同一条会话在运行中和
 * 回头看会给出两个数，而这种漂移不产生任何报错。理由同 `softLimit`。
 *
 * 边界：三项都是估算不是 provider 真值。拿它做加减法的一方承担的是系数误差，
 * 不是零误差。
 */
export function envelopeHeadTokens(breakdown: ContextBreakdown): number {
  return breakdown.systemPrompt + breakdown.systemTools + breakdown.mcpTools
}

// ─────────────────────────── 逐请求账 ───────────────────────────

/**
 * 一次真实模型请求的快照。**不存 payload 本身**，只存能对账的事实。
 *
 * **为什么账要落到「请求」这一层，而不是「run」这一层。** 挂在 `runs` 上
 * （`context_tokens/limit/percent` 那种三列）会被每个 step 覆盖一次，一个 run 只剩最后一次请求的读
 * 数，「这一轮上下文怎么长起来的」在账本里不存在。面板刷新后只能显示一个孤零零的数字，更查不出「为
 * 什么第三轮比第二轮还低」。一个 run 有 N 次请求，账就该有 N 行。
 *
 * **`status` 的五态是 provider 交互的真实形状。** `pending`（已装配未发出）→ `in_flight`（已发出未
 * 回）→ 终态三选一：`received` 正常收完 / `rejected` 被 4xx 拒 / `uncertain` 超时或断流。**
 * `uncertain` 不能并进 `rejected`**：被拒是 provider 明确说了话，超时是送达状态未知——按「拒了」
 * 处理会把一次可能已计费的请求记成没发生。
 *
 * **usage 四个字段允许为 null。** `null` = provider 没回报，与真实的 0 是两回事。中转站漏 usage 是
 * 常态，把没回报记成 0 会让上下文锚点误判成「这次请求什么都没占」。
 */
export interface ProviderRequest {
  id: ProviderRequestId
  runId: RunId
  /** 本 run 内第几次模型往返，从 0 起。 */
  turnIndex: number
  /** 同一 turn 的第几次重试，从 0 起。与 turnIndex 一起构成唯一键。 */
  retryIndex: number
  model: string
  status: ProviderRequestStatus
  /**
   * 发送前本地测得的输入量。**一律是字符估算**——三条协议都没有在热路径上
   * 实测 token 的通道。真值由 `providerInputTokens` 那几列给，读数以它们为准，
   * 这一列只在一条回报都还没有时兜底（`context-panel.ts`）。
   */
  measuredInputTokens: number
  providerInputTokens: number | null
  providerOutputTokens: number | null
  providerCachedTokens: number | null
  providerCacheWriteTokens: number | null
  /**
   * provider 的原话（`stop` / `tool_calls` / `completed:max_output_tokens` …）。
   *
   * **不是 `runs.stop_reason`。** 那一列存的是归一化之后的本仓词表，
   * 而归一化把「说完了」和「要调工具」压成了同一批词——两者在账本上因此
   * 分不出来。空串 = 流断在拿到终态之前，或本次迁移之前的行。
   */
  finishReason: string
  /** 本次请求各分组的占用。 */
  sentCategories: ContextBreakdown
  /** 本次请求**没有**发出去的那部分原文。 */
  omittedCategories: ContextOmitted
  errorCode: string | null
  /** provider 返回的错误正文。NULL = 没给、连接层失败，或存量请求。 */
  errorMessage: string | null
  /** 请求体指纹。用来认出「同一份内容发了两遍」。 */
  payloadHash: string
  cacheRouteFingerprint: string | null
  sentAt: number | null
  createdAt: number
}

export type ProviderRequestStatus = 'pending' | 'in_flight' | 'received' | 'uncertain' | 'rejected'

// ─────────────────────────────── 上下文压缩 ───────────────────────────────

/**
 * 一条折叠边界。
 *
 * 排序按「先消息 id、同一条消息内再按 step 戳」。`step` 缺省表示边界只到消息
 * 本体，该消息的执行记录不在边界以内。
 */
export interface CompactionCut {
  messageId: MessageId
  step?: string
}

export interface CompactionManifest {
  revision: number
  /** 摘要线：该 id 及之前的消息已被摘要替代。 */
  compactedThroughMessageId: MessageId | null
  /** 摘要线在归属消息内推进到的 step 戳。 */
  compactedThroughStep?: string
  /**
   * 收纳线：这一条及之前的工具结果只发信封，不发正文。
   *
   * 不变量 **收纳线 ≥ 摘要线**，由构造点保证。缺这个键 = 与摘要线重合。
   */
  condensedThrough?: CompactionCut
  /**
   * 累计被摘要替代掉的消息条数。
   *
   * 记**消息条数**，不要记成按 run 分组的步数：投影只按 `compactedThroughMessageId`
   * 过滤，按 run 分组的那份没有任何投影消费，而前端拿它的键个数当消息数显示，
   * 数字本身就是错的。
   */
  compactedMessageCount: number
  summary: string
  /** 摘要保留的精确事实包（文件路径、决定、未完成项），不是自由文本。 */
  facts: CompactionFacts
  /**
   * 这份投影落库后，下一次请求预计会占多少上下文。
   *
   * 它是 manifest 的派生快照，不是第二本上下文账：`basedOnProviderRequestId`
   * 指明它从哪一条已发送请求扣除了本次投影回收量；一旦又发出新请求，面板立即
   * 回到逐请求账。没有 provider 真值验证过压缩后的请求，所以界面必须标成估算。
   *
   * 可缺是为了读取升级前已经落库的 manifest；新写入一律带上。
   */
  contextAfter?: {
    basedOnProviderRequestId: ProviderRequestId | null
    model: string
    total: number
    measured: number
  }
  createdAt: number
}

export interface CompactionFacts {
  filesTouched: string[]
  openItems: string[]
  userConstraints: string[]
  /**
   * 被压掉那段里**落过盘的中间产物**，形如
   * `run_command npm test → rs_abc123`。
   *
   * 不带它的话，压缩会让 sink 里那份正文变成**不可达**：登记行还在正文库里，
   * 但模型再也不知道 `rs_abc123` 这个 id 存在过，`read_resource` 无从调起。
   * 因此「落盘只解决不丢，读回才解决要用」这句话在压缩之后就不成立了。
   *
   * 只存定位事实，不存正文——正文一直在内容库里按哈希寻址。
   * 旧 manifest 没有这个键，读出来是 `undefined`，按空处理（已落盘的是历史事实）。
   */
  resources?: string[]
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
