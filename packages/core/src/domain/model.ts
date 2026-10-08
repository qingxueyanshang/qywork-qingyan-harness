/**
 * 核心领域模型。
 *
 * 术语约定：
 * - run  = 一次用户回合（一次 agent loop）
 * - step = loop 内可回放的 text / tool_action / compaction
 * - 一次工具调用 = 一行 tool_action，原地从 running 更新到终态；不拆分为 tool_call / tool_result 两行。
 * - thinking 不回放给用户，但必须落库。DeepSeek 类兼容端点要求带 tool_calls 的
 *   assistant 消息原样回传 `reasoning_content`，否则后续轮次返回 400；从 steps
 *   投影历史时缺少这一段必然返回 400，因此它借用 tool_action 首条的 `content` 落库。
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
import type { MediaSpend } from './media.ts'
import type { SubagentKind } from './workflow.ts'

// ──────────────────────────── 共享词表 ────────────────────────────
//
// 配置、协议、界面三方共用的词表。放在 core 是因为只有 core 能被三方引用：
// `ai` 在 L1、`runtime` 在 L5，而界面只依赖 core，写在任何更高层都需要
// 第二份副本，副本之间会逐渐不一致。

/**
 * 思考强度档位，按从弱到强排序。
 *
 * 派生方向是「数组 → 类型」，不能反过来：类型只存在于编译期，
 * 而 `qy probe` 需要逐档试探、适配器需要按顺序比较大小（`indexOf`），两处都需要
 * 一个可在运行期枚举的数组。反向派生必然需要另写一份数组。
 *
 * 「档位全集」与「某个模型支持的档位」是不同的概念。
 * `catalog.ts` 中各厂商 spec 的 `effortLevels` 是按实测填写的事实声明，
 * 不能改为引用本数组：那样会把新增档位声明为所有厂商都支持。
 */
export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_ORDER)[number]

/**
 * 权限模式，只有两种：`auto` 由路径边界与 `run_command` 的拒绝规则裁决，
 * `full` 全部放行，路径边界一并放开，只保留凭证剥离（`scrubEnv`）。
 *
 * 真源是服务端的 config.json，经握手传给客户端；客户端只负责显示与请求修改，
 * 不另存副本。
 */
export type PermissionMode = 'auto' | 'full'

/**
 * 接口使用的协议。它表示协议而不是厂商：DeepSeek、OpenAI 与任何中转站都可以使用
 * `openai_chat_completions`。
 *
 * 顺序即界面顺序（接口协议下拉框、模型库保存时扇出的默认清单），调整顺序会改变界面。
 */
export const PROVIDER_KINDS = [
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** 工具定义的发送策略；兼容同一 API 不代表支持相同的 JSON Schema 子集。 */
export const TOOL_SCHEMA_MODES = ['native', 'openai_strict'] as const
export type ToolSchemaMode = (typeof TOOL_SCHEMA_MODES)[number]

/** 一次工具契约检测的记录，只用于诊断，不裁决运行时能否调用工具。 */
export interface ToolCallCheck {
  kind: ProviderKind
  model: string
  baseUrl: string
  schema: ToolSchemaMode
  checkedAt: number
  status: 'passed' | 'failed' | 'inconclusive'
}

export function matchesToolCallCheck(
  check: ToolCallCheck,
  target: Pick<ToolCallCheck, 'kind' | 'model' | 'baseUrl' | 'schema'>,
): boolean {
  return (
    check.kind === target.kind &&
    check.model === target.model &&
    check.baseUrl.replace(/\/+$/, '') === target.baseUrl.replace(/\/+$/, '') &&
    check.schema === target.schema
  )
}

/**
 * 思考强度的发送方式。每个模型在每种协议上各有一个取值，由模型库中的对应字段裁决。
 *
 * 派生方向同 `EFFORT_ORDER`：先定义数组，因为落盘校验需要在运行期逐项比对。
 */
export const THINKING_MODES = [
  /** 只接受 `{type:'adaptive'}`；发送 `budget_tokens` 返回 400。 */
  'adaptive_only',
  /** 思考始终开启，发送 `{type:'disabled'}` 也返回 400，只能省略 thinking 字段。 */
  'always_on',
  /** 较早的模型：`{type:'enabled', budget_tokens:N}`。 */
  'budget_tokens',
  /**
   * OpenAI Responses 形式：思考默认开启，由 `reasoning.effort` 控制；
   * 产品只发送正向强度，用户未选择时省略整个字段，使用模型默认值。
   *
   * 厂商协议可能另外接受 `none` 作为“关闭思考”命令，但它不是强度档位，
   * 不进入 `EffortLevel`、模型选择器或后台摘要请求。
   */
  'reasoning_effort',
  /**
   * DeepSeek 专有方式：`thinking` 开关与 `reasoning_effort` 档位必须同时发送。
   *
   * 只发送 `reasoning_effort` 而不发送 `thinking` 时思考未开启，档位不生效；
   * 该现象容易被误判为「模型不支持 effort」，实际原因是缺少 `thinking` 开关。
   */
  'deepseek_thinking',
  'none',
] as const
export type ThinkingMode = (typeof THINKING_MODES)[number]

/**
 * 缓存路由字段的发送方式。
 *
 * `prompt_cache_key` 是 OpenAI Responses / 部分兼容端点的请求体字段；
 * `x_grok_conv_id` 是 xAI Chat Completions 的同义请求头。两者都用于把同一会话
 * 路由到同一缓存分片，但在请求中的位置不同，不能因为同属缓存路由字段而混用。
 */
export const CACHE_ROUTINGS = ['prompt_cache_key', 'x_grok_conv_id', 'none'] as const
export type CacheRouting = (typeof CACHE_ROUTINGS)[number]

/**
 * 带 tool_calls 的历史消息是否把上一轮的推理原文回传给端点。
 *
 * 这是接收请求的端点的要求，不是历史的属性，因此由模型库中的对应字段决定。
 * 不要改为「依据历史中是否存在推理文本进行反推」：摘要型端点（`reasoning.summary`）
 * 同样会返回推理文本，反推必然产生假阳性，其后果是每一轮工具调用之后
 * 请求都无法发送。
 *
 * 只有 Responses 适配器消费它。
 */
export const REASONING_ECHOES = [
  /** 不回传。 */
  'none',
  /** 回传 `{type:'reasoning', content:[{type:'reasoning_text'}]}`。 */
  'reasoning_text',
  /** GLM Responses 的 content 是单个 reasoning_text 对象。 */
  'reasoning_text_object',
  /** 原样回传带 encrypted_content 的 reasoning 条目。 */
  'encrypted_content',
] as const
export type ReasoningEcho = (typeof REASONING_ECHOES)[number]

/**
 * provider 返回的原生推理条目（Anthropic 带签名的思考块、Responses 的加密推理），
 * 不展示为思考正文，只在产生它的请求前缀未变时原样回放。
 */
export interface ResponseReasoning {
  items: Record<string, unknown>[]
  /**
   * 回放时计入输入的 token 数，取 provider 回报的推理用量。估算以该值为准：
   * 按字节估算条目中的签名与密文会高出数倍。
   */
  tokens: number
  /**
   * 产生该条目的请求的前缀指纹（模型、系统提示、工具表与全部消息），由装配方写入，
   * 适配器不感知。回放时与本次请求在该消息之前的前缀比对，不同或缺失即不回放：
   * 前缀变化后 provider 不会原样使用这些条目。
   */
  prefix?: string
}

// ─────────────────────────────── 会话 ───────────────────────────────

export interface Conversation {
  id: ConversationId
  /** 所属工作区（一个本地目录）。业务路径必须显式绑定，不做隐式全局回退。 */
  workspaceId: WorkspaceId
  title: string
  /**
   * 该会话使用的接口（`config.providers` 的键）。
   *
   * 与 `model` 成对保存，不能只保存其一。两个接口提供同一个模型 id 是常见情况
   * （两家中转站都提供 `claude-opus-5`），只保存模型时，会话的归属在落盘时
   * 即已丢失，此后各层只能按 id 反查，结果取决于对象键的枚举顺序。
   *
   * 新建会话一律写入实际接口名。迁移 37 只按历史请求中的唯一证据补全旧会话；仍为空串说明
   * 归属无法证明，必须由用户重新选择，运行时不会按模型名推测接口。
   */
  provider: string
  model: string
  /** 上下文压缩的唯一投影权威。有界 JSON，正文仍只保存在 messages/steps 中。 */
  compactionManifest: CompactionManifest | null
  /** 用户显式重置缓存时递增；稳定路由键含该值，旧 provider 缓存因此被隔离。 */
  cacheGeneration: number
  /**
   * null 表示用户会话，显示在会话列表中；其余三个值表示子 agent 的种类，不显示在列表中。
   * 子 agent 的 id 即该会话的 id，三种种类共用一个 id 空间。
   *
   * `sourceRef`：`role` 存角色 id，`cli` 存 CLI id，`temp` 为 null。名称保存在 `title`。
   */
  source: 'role' | 'temp' | 'cli' | null
  sourceRef: string | null
  /** 外部 CLI 子 agent 的会话句柄，续接时传回给该 CLI；内置子 agent 为 null。 */
  externalSession: string | null
  /**
   * 派发任务创建的子会话所属的父会话；顶层会话为 `null`。
   *
   * 账本汇总、级联删除与运行页都由该字段推导。它在创建会话时写入，
   * 之后不再修改：子会话不会更换父会话。
   */
  parentConversationId: ConversationId | null
  createdAt: number
  updatedAt: number
}

/** 侧栏一行可容纳的字数。 */
const TITLE_MAX = 30

/**
 * 从第一条用户消息派生标题：取首行、合并空白、截断。
 *
 * 空正文返回空串，不要生成占位标题（如「图片」）；空串由界面显示为「新对话」。
 */
export function deriveConversationTitle(prompt: string): string {
  const line = (prompt.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim()
  // 按字符截断：slice 会把代理对（emoji）拆成半个字符。
  const chars = [...line]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : line
}

/** 用户发送的一条消息。助手回复与工具记录保存在 run 的 steps 中，不在此处。 */
export interface Message {
  id: MessageId
  conversationId: ConversationId
  role: 'user'
  content: string
  attachments: Attachment[]
  /**
   * 该消息的来源：子 agent 的回执、workflow 的回执；`null` 表示用户本人。
   *
   * 在 wire 上三者都是 user 角色（provider 不接受脱离调用的 tool 角色），
   * 只能依据该字段区分：界面据此决定渲染为回执行还是用户气泡，
   * 账本据此区分用户输入与回执。
   *
   * 必填且允许 `null`，不要写成可选：落盘列可空，读取结果必须是显式的 `null`；
   * 缺少该键时，消费方会把「没有来源」与「记录未携带来源」判定为同一种情况。
   */
  origin: 'subagent' | 'workflow' | null
  createdAt: number
}

export interface Attachment {
  type: 'image' | 'video' | 'file'
  /** 源文件名，用于展示与消息记录；不能用安全化后的存储名替代。 */
  name: string
  mime: string
  /**
   * 对路径型附件不是真值：该对象由前端组装，此时无法取得字节数，填 0。
   * 需要真实大小时调用 `stat`，不要依赖该字段。
   */
  size: number
  /**
   * 该文件在本机的位置：绝对路径或工作区相对路径。
   *
   * 字节不写入消息。能取得源路径时（桌面端拖入、原生选择器），该值即源文件的
   * 位置，不落盘任何字节；只有源文件不存在时（剪贴板中只有位图、浏览器不提供
   * 路径）才先落盘，再引用落盘的副本。
   *
   * 两种取值由同一条解析规则处理：相对路径按工作区解析，绝对路径直接使用
   * （`tools` 的 `resolveInWorkspace`）。不要为此新增第二个字段。
   *
   * 一律使用正斜杠：该值需要跨端传输（手机端也能发送），反斜杠在其他环境中会被当作转义符。
   * Windows 的各 API 均接受 `D:/x/y.png`。
   */
  path: string
}

/**
 * 会被内联为图像块的扩展名。
 *
 * 判定范围有意收窄，且必须与「发送时内联的类型」严格同源。放宽到 `image/*`
 * 会把 svg、bmp 等也判定为 `type: 'image'`，而多数 provider 拒绝这些格式，
 * 导致界面显示为图片、发送时整条请求返回 400。
 *
 * 按扩展名而不是 mime 判定：路径型附件没有 mime，只有路径。
 */
const INLINE_IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i
const INLINE_VIDEO_RE = /\.(mp4|mov|webm|mkv)$/i
const INLINE_AUDIO_RE = /\.(wav|mp3)$/i

/** 判定路径或文件名是否为可内联的图片。 */
export function isInlineImage(pathOrName: string): boolean {
  return INLINE_IMAGE_RE.test(pathOrName)
}

/** 判定路径或文件名是否为可直接提交给视频模型的视频。 */
export function isInlineVideo(pathOrName: string): boolean {
  return INLINE_VIDEO_RE.test(pathOrName)
}

/** 判定路径或文件名是否为可直接提交给视频模型的参考音频。各厂商都只接受 wav 与 mp3。 */
export function isInlineAudio(pathOrName: string): boolean {
  return INLINE_AUDIO_RE.test(pathOrName)
}

/** 扩展名 → mime。只覆盖可内联的类型与 Art 页面（HTML），其余返回通用二进制类型。 */
export function mimeOf(pathOrName: string): string {
  const ext = pathOrName.slice(pathOrName.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  return 'application/octet-stream'
}

/** 附件分类。判据与 `isInlineImage` 同源，不要在别处另行判定。 */
export function attachmentTypeOf(pathOrName: string): Attachment['type'] {
  if (isInlineImage(pathOrName)) return 'image'
  if (isInlineVideo(pathOrName)) return 'video'
  return 'file'
}

/** 路径中的文件名。两种分隔符都必须支持：拖放提供的是平台原生分隔符。 */
export function baseNameOf(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

/** 反斜杠统一替换为正斜杠。约定见 `Attachment.path`。 */
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
 * 停止原因。每次停止都必须带有原因，前端据此向用户展示。
 */
export type StopReason =
  | 'completed'
  /**
   * 无进展循环：连续三次出现相同的执行周期、相同的结果或待办快照，且没有任何副作用。
   * 判据见 `@qywork/agent` 的 `repeatsNoProgress`。执行循环没有回合总上限；
   * 无进展的循环必须由该进展判据识别，不能以固定步数中止正常的长任务。
   */
  | 'no_progress'
  | 'user_interrupt'
  /**
   * 进程退出，本轮终止，但没有工具停留在执行中，已完成的步骤结果可信
   * （`store` 的 `recoverStaleRuns`）。
   *
   * 不要合并到 `user_interrupt`：后者表示用户点击了停止，本值表示进程已退出；
   * 合并后事后无法区分两者，界面只能显示「已中断」，而用户并未点击停止。
   * 与 `internal_guard` 的区别在于结果是否可信：后者有工具停留在执行中。
   */
  | 'process_exit'
  /**
   * 输出被 max_tokens 截断。答案不完整，但已生成的部分有效。
   *
   * 不要在这一维度上并列「输入超出窗口」。两者合并为一个值时，输出截断也会
   * 提示用户清理历史，而清理历史无效。输入超出窗口由 `run.error.code = 'context_overflow'`
   * 表达，停止原因为 `provider_error`，同一事实只记录在一处。
   */
  | 'output_truncated'
  | 'provider_error'
  /**
   * 上次进程在工具执行期间退出，本轮的执行进度无法判定（`store` 的 `recoverStaleRuns`）。
   * 与 `user_interrupt` 区分：后者表示用户点击了停止，已完成的步骤结果可信；本值不可信。
   */
  | 'internal_guard'

/**
 * 一轮被中断时，本机实际观察到的终止来源。
 *
 * `stopReason` 表示本轮结果是否可信；本类型表示终止由谁或什么触发。两者不能
 * 合并：桌面 sidecar 被系统终止与用户点击停止，都可能发生在没有工具执行的时刻，
 * 但排查方向完全不同。
 */
export interface RunInterruption {
  source: 'user' | 'server_shutdown' | 'consumer_closed' | 'desktop_sidecar' | 'orphan_recovery'
  /** 终止首次被观察到的时间。 */
  observedAt: number
  /** 恢复进程把事实写回账本的时间；正常进程内收尾时与 observedAt 相同。 */
  recordedAt: number
  /** 上一进程的归属与最后心跳。只有启动恢复能取得。 */
  ownerPid?: number | null
  lastHeartbeatAt?: number | null
  /** 桌面外壳观察到的系统退出码/信号。无法取得时不编造。 */
  exitCode?: number | null
  signal?: number | null
  exitKind?: 'terminated' | 'output_channel_closed' | null
  /** qy serve 退出前最后一段 stderr，已在持久化边界脱敏并限制长度。 */
  stderrTail?: string | null
  /** true = 有工具已进入执行器但没有终态，禁止自动重放。 */
  ambiguousToolExecution: boolean
}

export interface Run {
  id: RunId
  conversationId: ConversationId
  workspaceId: WorkspaceId
  userMessageId: MessageId | null
  /**
   * Run 创建时会话消息的高水位。执行锁在创建之后才获取；排队期间新增的消息
   * 不得进入本 run 的历史。
   */
  messageIdUpperBound: MessageId | null
  model: string
  /** 前端执行意图幂等键，(conversationId, clientRequestId) 唯一。 */
  clientRequestId: string
  status: RunStatus
  stopReason: StopReason | null

  usage: RunUsage
  stepCount: number

  errorMessage: string | null
  errorCode: string | null
  /** 中断来源的结构化事实。NULL = 正常完成、普通失败或迁移前旧记录。 */
  interruption: RunInterruption | null
  /**
   * 产生本轮的任务派发：父会话中派发任务卡的 step 与卡上对应的节点。创建 run 时写入，
   * 变更投影据此把子会话的写入归入父会话的对应轮次。`null` 表示并非派发产生（用户自己的会话）。
   * 必填且允许 null，理由同 `Message.origin`。
   */
  dispatchStepId: StepId | null
  dispatchNodeId: string | null

  // 上下文读数不在此处。真源是 `ProviderRequest`：一个 run 有 N 次请求，
  // 账本就应有 N 行；挂在 run 上的标量每个 step 覆盖一次，只保留最后一次的读数。

  createdAt: number
  finishedAt: number | null
}

/**
 * 计价币种。
 *
 * 放在 core 而不是 ai 包中，因为账本（store）、界面（web）和目录（ai）
 * 三方都使用它。各自定义时三份副本会逐渐不一致（`IGNORED_DIRS` 的三份副本
 * 出现过 13/12/11 条的差异）。
 *
 * 只包含目录中实际出现的两种。新增第三种时必须同时检查 `usage_ledger` 中
 * 已有的行：这些行的币种是历史事实，不能改记为其他币种。
 */
export type Currency = 'USD' | 'CNY'

export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', CNY: '¥' }

/**
 * 金额显示。命令行与界面共用本函数：两侧各写一份必然出现
 * 「`qy usage` 显示 $0.0001、面板显示 $0.00」的差异，且这种不一致很难被当作缺陷报告。
 *
 * 小额必须可见：实际产生费用却显示 `$0.0000`，会被理解为免费。
 * 因此金额低于四位小数能表示的下限时显示 `<$0.0001`，而不是全零：
 * 「金额过小无法显示」与「没有费用」是不同的情况。
 */
export function formatMoney(amount: number, currency: Currency = 'USD'): string {
  const s = CURRENCY_SYMBOL[currency] ?? '$'
  if (amount === 0) return `${s}0.00`
  if (amount < 0.0001) return `<${s}0.0001`
  if (amount < 0.01) return `${s}${amount.toFixed(4)}`
  return `${s}${amount.toFixed(2)}`
}

/**
 * 多币种金额。各币种分开列出，不合计：¥100 与 $20 相加得到的数字没有意义。
 *
 * 空对象显示为零：它表示该区间确实没有费用，而不是金额未知。
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
  /** 缓存读取命中。null 表示 provider 未回报，与真实的 0 命中含义不同。 */
  cachedTokens: number | null
  /** 缓存写入，与读取分离，便于与中转账单对账。 */
  cacheWriteTokens: number | null
  reasoningTokens: number
  /**
   * 累计花费，单位是下方的 `currency`，不固定为美元。
   *
   * 该字段不得命名为 `costUsd`。阿里 / 月之暗面 / 智谱三家官网按人民币标价，
   * 把 ¥6 存入名为 usd 的字段会产生约七倍的偏差，而界面上只显示一个数字，无法察觉。
   * 落盘的列名与此相同（迁移 7）。
   */
  cost: number
  /** `cost` 的币种。不做汇率换算：换算得到的数字没有依据。 */
  currency: Currency
  /** 每轮一条，供命中率分桶与成本审计；不参与计费。 */
  turns: UsageTurn[]
  /** 本轮的生成花费（图片、视频、语音）。没有生成时不带该键。`cost` 只包含模型调用的花费。 */
  media?: MediaSpend[]
}

/**
 * 一轮的全部花费：模型调用与生成之和，按币种分开。读数条与「运行」面板共用本函数，
 * 分别计算会使同一轮在两处显示不同的金额。金额为 0 的项不计入（0 表示金额不明，不表示免费）。
 */
export function runCosts(usage: RunUsage): Record<string, number> {
  const costs: Record<string, number> = {}
  const add = (amount: number, currency: Currency) => {
    if (amount > 0) costs[currency] = (costs[currency] ?? 0) + amount
  }
  add(usage.cost, usage.currency)
  for (const m of usage.media ?? []) add(m.cost, m.currency)
  return costs
}

export interface UsageTurn {
  turnIndex: number
  input: number
  output: number
  cached: number | null
  cacheWrite: number | null
  reasoning: number
  /** provider 表示模型实际回报；estimated 表示本地估算的后备值，二者不可混同。 */
  source: 'provider' | 'estimated'
  usageStatus: 'ok' | 'missing' | 'partial'
  costUsd: number
  at: number
}

// ─────────────────────────────── 用量账本 ───────────────────────────────
//
// 类型定义放在 core，不放在 store。写入方是 store、发送方是 server、渲染方是 web，
// 三方都依赖这些类型；放在 store 中时 web 无法引用（依赖只能指向底层），
// 只能各自复制一份，修改字段名时另外两份不会产生类型错误。

/**
 * 费用的种类。
 *
 * 每一种都是独立于 run 的开销，未列入时该笔费用在界面上不存在。
 * `summary`（压缩时的摘要调用）是典型：不记入账本就完全不可见，
 * 压缩越频繁，账单与界面的差额越大。`media` 是轮次中的一次生成，带所属轮次的 run_id。
 */
export type UsageKind = 'run' | 'summary' | 'media'

export interface UsageTotals {
  entries: number
  inputTokens: number
  outputTokens: number
  /** null 表示该区间内没有任何一笔记录回报过缓存。不要显示为 0。 */
  cachedTokens: number | null
  /** 同上。缓存写入与命中分开记录，两者计价不同。 */
  cacheWriteTokens: number | null
  reasoningTokens: number
  /**
   * 按币种分开，不合计也不换算。
   *
   * 只包含该区间内实际出现过的币种，空对象表示该区间没有费用。
   * 合并为一个数字需要汇率，而汇率每天变化，落盘之后该数字即不再成立，
   * 却仍显示为确切的金额。
   */
  cost: Record<string, number>
}

export interface UsageBucket extends UsageTotals {
  /** 分组键：模型名 / 日期 / 工作区 id。 */
  key: string
}

/** 账本中的一行。`runId` 为空表示该笔费用不属于任何一轮（如压缩摘要）。 */
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
 * 待办进度的唯一算法，工具回执与输入框上方的状态条共用。
 *
 * 分别计算会使同一屏上的两个数字矛盾：工具卡显示「（0/5）」（计已完成数），
 * 状态条显示「第 1 / 5 步」（计进行中的条目），而两者描述的是同一份清单的同一时刻。
 * 计数规则由共享本函数统一，不依赖两侧约定。
 *
 * 两个数值各有用途，不得互相替代。
 *
 * - `step` 取进行中的条目（1-based）。它表示位置，不表示完成量：
 *   显示「第 3 步」时第 3 步尚未开始产出。因此只能与条目名一起显示
 *   （「第 3/4 步：编写 main.js」）。单独显示「第 3 / 4 步」会被理解为
 *   「4 步完成了 3 步」，而这一理解不成立。
 * - `done` 是实际完成的条数。无法附带条目名的位置一律使用它
 *   （输入区的状态条），它与待办面板上已勾选的数目恒等。
 *
 * 没有进行中的条目时（刚勾选完成、尚未认领下一条），`step` 回落到 `done`。
 */
export function todoProgress(todos: readonly TodoItem[]): {
  /** 1-based；没有进行中的条目时等于已完成数。 */
  step: number
  total: number
  done: number
  /** 进行中的条目；没有则为 null（全部完成，或刚勾选完成、尚未认领下一条）。 */
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
 * 目标的生命周期，只有四个状态，不再增加。
 *
 * 「provider 报错」「需要人工输入」「连续无进展」不各占一个状态，全部使用
 * `blocked`，由 `blockedCode` 与 `blockedReason` 区分。状态越多，转移矩阵越大，
 * 而它们对用户的含义相同：已停止，等待用户输入。
 */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked'

/**
 * 会话的当前目标。同一时间只有一个，不支持并行目标。
 *
 * 待办（`TodoItem`）表示本轮的进度，目标表示跨越多轮要达成的结果：
 * 目标为 `active` 时，每轮 run 结束后自动开始下一轮（`server/run-control.ts`）。
 *
 * 没有轮数上限。循环只有三个出口：模型自检达成 → `complete`、模型无法继续 →
 * `blocked`、用户点击停止 → `paused`。此外，本轮未正常结束时
 * （provider 报错、权限被拒、连续无进展），服务端也会转为 `blocked`：这是异常出口，不是配额。
 *
 * 不设「最多运行 N 轮」：用户没有确定该数值的依据，而它一旦显示在界面上就会成为
 * 循环的主要指标，把「是否达成」替换为「剩余轮数」。是否达成由目标本身判定，
 * 不由计数器判定。
 */
export interface Goal {
  id: GoalId
  conversationId: ConversationId
  objective: string
  status: GoalStatus
  /**
   * 从 1 开始单调递增，每次变更 +1。
   *
   * 写入方必须携带自己读取到的 revision，不一致时直接拒绝：模型持有的目标可能
   * 是几轮之前读取的，静默覆盖会抹去其间发生的暂停或修改。
   */
  revision: number
  /** `blocked` 专有：机器可读的短代码，供界面分类。其余状态为 null。 */
  blockedCode: string | null
  /** `blocked` 专有：一句自然语言说明阻塞在何处。必填，否则无从得知停止原因。 */
  blockedReason: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 目标上的五个动作，全部由 `update_goal` 一个工具承担：
 * 五个动作共享必填的 `goal_id` 与 `revision`，差异只在两个条件必填字段。
 */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

/**
 * 一次目标变更的结果。
 *
 * 失败以返回值表达，不抛异常：绝大多数调用方是工具，而工具需要把拒绝原因
 * 原样交给模型（revision 过期、状态不允许、缺少理由）；异常在该路径上会被
 * 注册表统一替换为「工具执行出错」。
 */
export type GoalWriteResult =
  | { ok: true; goal: Goal }
  | { ok: false; code: string; message: string }

// ─────────────────────────────── Step ───────────────────────────────

/**
 * step 的种类。
 *
 * `user` 是唯一不由模型产生的种类：run 执行过程中用户插入的消息
 * （「调整方向」）。它必须写入 steps 而不是 `messages`：历史投影的结构是
 * 「messages 按 id 升序，每条之后接 `userMessageId` 指向它的各 run 的全部 steps」
 * （`runtime/transcript.ts` 的 `buildHistory`），写入 `messages` 的行在下一轮会被重排到
 * 整个 run 的全部步骤之后，注入点在回放中的时序因此与实时 transcript 不一致。
 * 写入 steps 时位置由 seq 决定，两侧逐条对应。
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
  /** 同一 provider 响应中的所有调用共享该值，用于保留「一个 assistant 轮包含 N 个调用」的原始结构。 */
  providerBatchId: string | null
  callIndex: number | null
  /**
   * 一个 provider batch 内的后端执行边界。相同 index 属于同一批并行执行的调用；
   * 不同 index 依次执行；未进入批次规划的保持 null。
   */
  executionWaveIndex: number | null
  /**
   * 有副作用工具的执行歧义边界：进入执行器前立即提交并持久化。
   * 崩溃恢复必须把「有时间戳的 running 行」视为「可能已执行」。
   */
  executionStartedAt: number | null

  content: string | null
  payload: StepPayload | null
  status: ToolActionStatus | 'done'
  createdAt: number
  /**
   * 本次工具调用的执行时长（毫秒）。只有已落终态的 `tool_action` 带有该值。
   *
   * 与 `executionStartedAt` 的分工：后者是进入执行器之前写入的时间戳（崩溃恢复的歧义
   * 边界），本字段是执行完成后的时长。不要用两者相减代替本字段：前者在提交事务时写入，
   * 与执行器实际开始执行相差一次落盘。
   *
   * 迁移 28 之前的行为 null：这些调用确实发生过，但时长未落库。
   */
  durationMs: number | null
}

/** 派发任务卡上一个节点的进度。 */
export type NodePhase =
  | 'waiting'
  | 'queued'
  | 'working'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'interrupted'

/**
 * 派发任务卡上一个节点的状态。单个派发与图上的节点使用同一结构，保存在 step payload 的 `nodes` 中，
 * 流式阶段的 `team.member` 事件携带的也是该结构：界面只以它为来源。
 *
 * 它同时是该节点的回执：终态记录带有 `output` / `note`，`foldWorkflow` 据此
 * 折叠出 `WorkflowProjection.results`。工具返回值中没有第二份：派发后立即返回，
 * 此时尚无产出。
 */
export interface NodeState {
  phase: NodePhase
  /** 节点名称，即子 agent 的名称。 */
  label: string
  /**
   * 派发目标的子 agent 种类。界面据此显示标签并决定打开哪个页面。
   * 目标无效且只提供了子 agent id 时缺失：此时没有可用于判定种类的记录。
   */
  kind?: SubagentKind
  /** 子 agent 的会话 id。创建后每条状态都带有该值。 */
  subagentId?: ConversationId
  durationMs?: number
  /** failed / skipped / interrupted 的原因。 */
  error?: string
  /**
   * 终态记录带有的产出摘录，已经过投递限制（超出预算的部分落盘，正文中保留定位符）。
   * 下游节点的输入与检查点的可传递输出都取该值，因此不要改为完整正文：
   * 它随 step payload 落库，也随 `team.member` 事件广播。
   */
  output?: string
  /** 派发时模型应知道的事实：续接失败、角色已不存在。随终态一起返回。 */
  note?: string
  /**
   * 外部 CLI 节点执行期间工作区观察器记录的写入。只有外部 CLI 节点带有该字段：内置子 agent 的写入
   * 是其子会话中的 step，变更投影按 `subagentId` 从子会话读取。
   */
  fileChanges?: FileChange[]
}

/**
 * `action` 随 step 一起落库，而不是让前端按工具名推测。
 *
 * 动作语义由后端的 ToolSpec 解析（多动作门面按参数分派），前端无法推测：
 * 不落库时，刷新后所有历史工具卡都显示为「读取」，包括写入与执行命令。
 */
export type StepPayload =
  | { kind: 'response_reasoning'; reasoning: ResponseReasoning }
  | {
      kind: 'tool_call'
      args: Record<string, unknown>
      action?: ActionDescriptor
      /**
       * 派发任务卡上每个节点的进度，键是节点 id（单个派发使用 `SUBAGENT_NODE_ID`）。
       * 每次状态变化都立即写入，不等待工具执行完毕：切换会话后返回、刷新之后都从此处重新渲染，
       * 与流式阶段的 `team.member` 事件结构相同。
       */
      nodes?: Record<string, NodeState>
    }
  | {
      kind: 'tool_result'
      /**
       * 可缺失。正常终态一定带有，但恢复/中断收尾（`settleRunningSteps`）
       * 整体替换 payload 时会清除 `args` 与 `action`：此时只能确定
       * 「该调用没有终态」，无法重建调用参数。
       *
       * 不能声明为必填：写入侧确实会写入不带该字段的行，声明必填会使类型声明与库中
       * 存储的内容不一致，历史投影会在孤儿行上取得 undefined 后展开。
       * 消费方（`runtime/transcript.ts`）按 `args ?? {}` 处理，
       * 且这类行的 status 必然是 failure：模型看到的是「调用失败、参数已无法确定」，
       * 而不是一条「参数为空却显示成功」的记录。
       */
      args?: Record<string, unknown>
      outcome: ToolOutcomeWire
      action?: ActionDescriptor
      /**
       * 同 `tool_call` 的 `nodes`。`settleToolStep` 从运行中的行保留该值；
       * 崩溃恢复把未执行完毕的节点标记为中断。
       */
      nodes?: Record<string, NodeState>
    }
  | {
      kind: 'compaction'
      /**
       * 压缩终态，与 `CompactionEvent.phase` 同源；刷新之后压缩卡据此重建。
       *
       * 迁移 37 已补全旧行；新写入也必须带有该字段。
       */
      phase: 'done' | 'skipped' | 'failed'
      manifestRevision: number
      compactedMessages: number
      /** `phase='done'` 专有：摘要线随之前移（true），或只收纳了工具正文（false）。 */
      summarized?: boolean
      reasonCode?: string
      message?: string
      trigger?: 'manual' | 'automatic' | 'overflow'
      occupancy?: number
      estimatedOccupancy?: number
      contextWindow?: number
    }
  | {
      /**
       * run 内注入的用户消息。正文保存在 `content` 列，与 `text` / `thinking` 相同；
       * 此处只保存附件引用。
       */
      kind: 'user'
      attachments?: Attachment[]
      /** 同 `Message.origin`：该消息的来源，缺失表示用户本人。 */
      origin?: 'subagent' | 'workflow'
      /**
       * 装配层交给模型的执行事实（待办未完成、重复告警、断流后续发），不是任何参与者的发言：
       * 界面与导出不显示，投影到历史时归入运行上下文。
       */
      notice?: true
    }

/** 判定 step 是否为装配层交给模型的执行事实（见 `StepPayload` 的 `notice`），而不是任何参与者的发言。 */
export function isNoticeStep(step: Pick<Step, 'kind' | 'payload'>): boolean {
  return step.kind === 'user' && step.payload?.kind === 'user' && step.payload.notice === true
}

/** 工具执行的规范结果，必须原样抵达 step 账本、事件流和 provider transcript。 */
export interface ToolOutcomeWire {
  status: 'success' | 'failure'
  /** 是否实际执行。权限拒绝 / 注册表未命中时为 false，不得伪装为成功。 */
  executed: boolean
  message: string
  data?: Record<string, unknown>
  /**
   * 可选的用户界面展示意图。工具结果默认只供模型与账本消费；只有生产者明确声明，
   * 前端才把其中的图片展开到会话正文。模型视觉输入与用户展示相互独立。
   */
  presentation?: { images?: 'inline' }
  /** 文件类工具产出的变更摘要，供实时预览与 diff 面板消费。 */
  fileChanges?: FileChange[]
  /** 本次调用落盘的中间资源引用。只含定位事实，不携带正文。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

/**
 * 一条排队中的跟进消息。
 *
 * 会话忙碌时用户发送的消息进入该队列，去向由 `steer` 决定：注入当前轮，
 * 或等待当前轮执行完毕后作为下一轮发起。进入 run 之前它不写入任何表：
 * 队列是进程内的意图，不是账本事实，落盘的队列会在崩溃重启后自行开始执行。
 */
export interface FollowUp {
  /**
   * 幂等键，直接使用 `message.send` 的 `clientRequestId`。
   *
   * 该键有三种用途：服务端据此去重，客户端的乐观卡片据此与服务端快照对账，
   * 卡片上的切换与删除据此寻址。
   */
  id: string
  content: string
  attachments?: Attachment[]
  /** true = 在当前 run 的下一个 step 边界注入；false = 等待当前轮收尾后发起下一轮。 */
  steer: boolean
  /**
   * 同 `Message.origin`：该消息的来源，缺失表示用户本人。
   *
   * 队列不落盘，该字段只负责把来源传递到落库环节：注入时写入 step 的
   * `payload.origin`，开始新一轮时写入 `messages.origin`。
   */
  origin?: 'subagent' | 'workflow'
}

// ─────────────────────────── 中间资源 ───────────────────────────

export type ResourceStatus = 'complete' | 'partial' | 'failed'

/**
 * 覆盖事实：投递给模型的片段在完整正文中的位置与占比。
 *
 * 这些数值必须随结果一起交给模型。只提供截断后的正文而不说明
 * 「这是 2.3 MB 中的 8 KB」，模型会把它当作全部内容，并基于不完整的信息得出结论；
 * 这比不提供正文更糟，因为模型无从得知信息不完整。
 */
export interface ResourceCoverage {
  deliveredBytes?: number
  totalBytes?: number
  truncated?: boolean
  /** 产生它的查询/命令/URL，供模型判断这段内容的语义。 */
  query?: string
  [k: string]: unknown
}

/** 执行记录中已落盘正文的引用；只含定位事实，正文在内容库中按哈希寻址。 */
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
  /** 观察器判定的 created 是估算值：原子保存（先写临时文件再重命名）同样会产生窗口内的创建时间。 */
  changeType: 'created' | 'modified' | 'deleted' | 'renamed'
  /**
   * 增删行数。文件类工具一定提供；工作区观察器判定的写入（shell、外部 CLI）
   * 无法取得改动前的内容，两个字段同时缺失。缺失不等于 0：消费方只累加已知的数值，
   * 界面上这类行不显示增删数。
   */
  additions?: number
  deletions?: number
  renamedFrom?: string
}

/** 一轮中单个文件的净效果。`counted` 表示本轮至少有一次记录带有行数；均未带行数时不显示增删数。 */
export interface FoldedFileChange {
  path: string
  changeType: FileChange['changeType']
  additions: number
  deletions: number
  counted: boolean
}

/**
 * 把一轮的写入按路径折叠为净效果：输入按发生顺序排列，输出按路径首次被修改的顺序排列。
 *
 * 本轮中先创建后删除的路径整行丢弃：它对工作区没有净效果，与观察器在单个窗口内
 * 把「创建后删除」判定为临时文件是同一条规则，只是范围扩大到整轮。浏览器 profile、
 * 构建缓存等包含成百上千个文件的目录正属于这种情况。修改后被删除的路径保留：
 * 它表示用户原有的文件已被删除。
 *
 * 其余规则：创建后修改仍记为新建，删除后重建仍记为新建，其余按最后一次变更；
 * 行数只累加已知值（缺失不等于 0，见 `FileChange.additions`）。
 *
 * 变更页的行与表头合计都取自本函数。若界面折叠一次、服务端另行计算合计，
 * 被丢弃的数百行会从列表中消失，却仍计入表头的合计。
 */
export function foldFileChanges(changes: readonly FileChange[]): FoldedFileChange[] {
  const byPath = new Map<string, FoldedFileChange>()
  const bornHere = new Set<string>()
  for (const c of changes) {
    const cur = byPath.get(c.path)
    if (!cur) {
      if (c.changeType === 'created') bornHere.add(c.path)
      byPath.set(c.path, {
        path: c.path,
        changeType: c.changeType,
        additions: c.additions ?? 0,
        deletions: c.deletions ?? 0,
        counted: c.additions !== undefined,
      })
      continue
    }
    cur.additions += c.additions ?? 0
    cur.deletions += c.deletions ?? 0
    cur.counted ||= c.additions !== undefined
    cur.changeType =
      c.changeType === 'deleted'
        ? 'deleted'
        : cur.changeType === 'created'
          ? 'created'
          : c.changeType
  }
  return [...byPath.values()].filter((f) => !(f.changeType === 'deleted' && bornHere.has(f.path)))
}

// ─────────────────────────────── 产物 ───────────────────────────────

// ─────────────────────────────── 上下文分组 ───────────────────────────────

/**
 * 上下文占用的分组定义。这是唯一的定义，面板、装配层与账本都使用它。
 *
 * 十个键是固定的：改变划分方式等于更换度量标准，历史会话的面板数字与新会话将无法对照，
 * 排查时无法判定哪些数值本应一致。可以新增类目，不要合并或重命名已有类目。
 *
 * 定义在 `core` 而不是 `ai`：`ai` 的 `WireMessage._group` 与 `core` 的事件协议
 * 必须使用同一个类型。放在 `ai` 中时 `core` 无法引用（依赖只能指向下层），
 * 只能两处各写一份枚举：一份十个键，另一份七个名称不同的分组，而面板只基于其中一份。
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
 * 分组顺序。面板按此顺序渲染，零值行也显示。
 *
 * 顺序本身是协议的一部分：按值排序会使行随数值大小上下移动，用户查找某一行
 * 时每次都需要重新浏览；零值行不显示会使行数随会话变化（九行变为十行），
 * 浮层高度随之变化（B9）。
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
 * 未发送给模型的原文量。
 *
 * 压缩把一段历史替换为摘要、把工具结果替换为定位符之后，原文仍保留在账本中，
 * 只是未进入本次请求。这两个数值表示被移出请求的内容；面板只报告占用构成
 * 是不完整的，用户看到占用下降却无法得知下降来自何处。
 *
 * 能报告该数值的前提是压缩是投影、不销毁原文：原文仍在 Step / 正文库中，
 * 装配时用同一度量方式测量两次后相减即得到该值。若改为直接改写正文，原文将不在
 * 任何可测量的位置，这两个数值即失去依据：届时应删除它们，而不是填入估算值。
 */
export interface ContextOmitted {
  /** 被摘要替代的历史消息原文。 */
  historyOriginal: number
  /** 被定位符存根替代的工具结果正文。 */
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
 * 随对话增长的三个分组。对账的差额优先归入这些分组。
 *
 * 其余分组（系统提示词、工具 schema、记忆、技能、工作区）在装配时可逐字计数，
 * 估算误差极小；把差额分摊给它们会把最准确的数值改错。
 */
const VARIABLE_GROUPS: readonly ContextGroup[] = [
  'historyMessages',
  'executionRecords',
  'intermediateContent',
]

/** 其余分组。顺序沿用 `CONTEXT_GROUPS`，只有差额无法由可变分组吸收时才调整它们。 */
const FIXED_GROUPS: readonly ContextGroup[] = CONTEXT_GROUPS.filter(
  (g) => !VARIABLE_GROUPS.includes(g),
)

/**
 * 把 `keys` 中的分组按现有占比重新分配，使其总和精确等于 `want`。
 *
 * 余数归入其中最大的分组，不留下一两个 token 的差额。
 * 全部为零时没有占比可依据，全部分配给第一个键。
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
 * 使分组之和等于总数。
 *
 * 必须对账：总数是 provider 真值，分组是本地估算，两者必然不等。差额中还固定包含
 * 上一轮的输出 token：它不属于任何分组，但确实占用窗口，在下一轮成为历史的
 * 一部分。不对账时，面板上各行之和与标题中的总数不一致，差额会
 * 不加提示地计入「剩余空间」一行。
 *
 * 也不要用「各组之和略小于总数：总数包含请求体本身的结构开销」这类说法掩盖差额：
 * 该说法不成立，差额中有真实内容（tool call 参数、思考正文、按自然语言标准被低估的
 * base64）。实测实例：两张按文本发送的 PNG 使总数与分组之和相差 271k，
 * 面板上各行之和只占 36.9%，其余全部计入「剩余空间」，没有任何一行对应它们。
 *
 * 采用吸收法，不采用缩放法：固定类目保留实测值，差额归入误差实际所在的分组，由三个可变分组按各自占比分摊。
 *
 * 不要改为「一律按占比缩放全部类目」：该方法要求全部类目使用同一度量方式且误差均匀，
 * 而此处是估算，误差集中在可变分组上。
 *
 * 真值低于固定类目之和时（会话刚开始、工具表的估算高于真值），
 * 可变分组清零后仍无法平衡，此时才按占比缩减固定类目。
 * 「各行之和等于标题」优先于「固定类目保留实测值」：前者用户可以直接验证，
 * 后者用户无法验证；若钳制到零后不再处理，面板显示的仍是一组不一致的数值。
 *
 * 边界：按占比分摊只保证总和正确，不保证差额归入实际出错的分组；误差实际
 * 集中在某一个分组时，另外两个分组也会被抬高。因此本函数给出的是总占用量与
 * 大致构成，不能指明哪一个分组计算有误。定位单个分组的误差需要查看逐请求记录。
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
 * 请求信封部分的占用：系统提示词与两张工具表。
 *
 * 三项与 `envelopeHashOf`（`agent/loop/request.ts`）哈希的 `[model, system, tools]` 逐项
 * 对应。信封变化时只需重新估算这三项，多计一项会把未变化的内容也重新估算。
 *
 * 具名导出，两处都调用本函数，不要各自相加。锚点修正在 loop 与
 * `runtime/context-panel.ts` 两处发生，两份定义一旦不一致，同一会话在运行中与
 * 事后查看时会显示两个不同的数值，且不产生任何报错。理由同 `softLimit`。
 *
 * 边界：三项都是估算值，不是 provider 真值。基于它做加减运算的结果带有系数误差，
 * 不是精确值。
 */
export function envelopeHeadTokens(breakdown: ContextBreakdown): number {
  return breakdown.systemPrompt + breakdown.systemTools + breakdown.mcpTools
}

// ─────────────────────────── 逐请求记录 ───────────────────────────

export type ProviderRequestPurpose = 'turn' | 'summary'
export type ProviderRequestContentKind = 'thinking' | 'text' | 'tool_arguments' | 'other'

/** 请求装配时的参数；不含正文、凭证和请求头值，不能用导出时的配置回填旧请求。 */
export interface ProviderRequestConfiguration {
  contextWindow: number
  modelMaxOutputTokens: number | null
  maxOutputTokens: number | null
  effort: EffortLevel | null
  idleTimeoutMs: number
  toolCount: number
  messageCount: number
  endpoint?: string | null
}

/**
 * 一次真实模型请求的快照。不保存 payload 本身，只保存可用于对账的事实。
 *
 * 记录粒度是请求而不是 run：记录在 `runs` 上
 * （如 `context_tokens/limit/percent` 三列）会被每个 step 覆盖一次，一个 run 只保留最后一次请求的
 * 读数，账本中不存在本轮上下文的增长过程。面板刷新后只能显示单个数字，也无法查明
 * 第三轮为何比第二轮低。一个 run 有 N 次请求，账本就应有 N 行。
 *
 * `status` 的五个状态对应 provider 交互的实际过程：`pending`（已装配未发出）→ `in_flight`（已发出未
 * 返回）→ 三个终态之一：`received` 正常接收完毕 / `rejected` 被 4xx 拒绝 / `uncertain` 超时或断流。
 * `uncertain` 不能合并到 `rejected`：被拒绝是 provider 给出的明确答复，超时表示送达状态未知；按拒绝
 * 处理会把一次可能已计费的请求记为未发生。
 *
 * usage 的四个字段允许为 null。`null` 表示 provider 未回报，与真实的 0 含义不同。中转站缺失 usage 是
 * 常见情况，把未回报记为 0 会使上下文锚点误判为「本次请求没有任何占用」。
 */
export interface ProviderRequest {
  id: ProviderRequestId
  runId: RunId
  /** 本 run 内第几次模型往返，从 0 起。 */
  turnIndex: number
  /** 同一 turn 的第几次重试，从 0 起。与 turnIndex 一起构成唯一键。 */
  retryIndex: number
  /**
   * 本次往返的类型：主模型的一轮（turn），或一轮之内压缩时的摘要请求（summary）。
   * 摘要请求同样占用一个 turn 编号、计入本轮的 usage；但它发送的不是会话上下文，
   * 上下文锚点与命中率只统计 turn。
   */
  purpose: ProviderRequestPurpose
  /** 请求发出时绑定的接口名。null = 迁移前旧行或测试夹具未提供。 */
  providerName: string | null
  /** 请求实际使用的协议。与接口名一起区分同一模型的不同调用路径。 */
  providerKind: ProviderKind | null
  model: string
  status: ProviderRequestStatus
  /**
   * 发送前本地测得的输入量，一律为字符估算：三种协议都没有在热路径上
   * 实测 token 的接口。真值由 `providerInputTokens` 等列提供，读数以真值为准，
   * 本列在尚无任何回报时作为后备；取得 usage 后还与真值配对，用于校准锚点之后
   * 的增量，并为压缩回收量做两种度量之间的换算（`context-panel.ts` / `compaction.ts`）。
   */
  measuredInputTokens: number
  /**
   * 发出时运行中的上下文读数：上一次回执的输入与输出加上其后的本地增量，即界面读数条显示的数值。
   * 面板对尚无回执的请求读取该值，与运行中使用同一度量方式。NULL 表示摘要请求或迁移前旧行。
   */
  occupancyTokens: number | null
  providerInputTokens: number | null
  providerOutputTokens: number | null
  providerCachedTokens: number | null
  providerCacheWriteTokens: number | null
  /**
   * provider 返回的原始值（`stop` / `tool_calls` / `completed:max_output_tokens` …）。
   *
   * 不是 `runs.stop_reason`：该列保存归一化之后的本仓库词表，
   * 而归一化把「输出完毕」与「需要调用工具」合并为同一组值，两者在账本中因此
   * 无法区分。空串表示流在取得终态之前中断，或本次迁移之前的行。
   */
  finishReason: string
  /** 本次请求各分组的占用。 */
  sentCategories: ContextBreakdown
  /** 本次请求中未发送的原文。 */
  omittedCategories: ContextOmitted
  errorCode: string | null
  /** provider 返回的错误正文。NULL 表示未返回、连接层失败或存量请求。 */
  errorMessage: string | null
  /** 失败现场与重试裁决；NULL 表示成功、迁移前记录，或进程在裁决写入账本前退出。 */
  diagnostic: ProviderRequestDiagnostic | null
  configuration: ProviderRequestConfiguration | null
  /** 请求体指纹，用于识别同一份内容被发送了两次。 */
  payloadHash: string
  /** 模型可见请求主体的 UTF-8 字节数；不含凭证和传输头。 */
  requestBytes: number | null
  cacheRouteFingerprint: string | null
  sentAt: number | null
  /**
   * 响应头到达的时刻，由传输层在 `fetch` 返回时观察。
   *
   * 它与 `firstEventAt` 之间的时段表示远端已接收请求、模型尚未产出；缺少该值时，
   * 连接未建立与接收后等待在账本中无法区分。
   */
  headersAt: number | null
  /** provider 返回的第一个流事件；不含本地 request_prepared 和响应头 response_started。 */
  firstEventAt: number | null
  /** 第一段思考、正文或工具调用到达的时刻。 */
  firstContentAt: number | null
  /**
   * 最后一段非空思考、正文或新增工具参数到达的时刻。
   *
   * 当前静默时长只能由该值计算。`firstContentAt` 表示的是另一件事：
   * 持续输出时它距当前时刻越来越远，以它作为静默起点会把正常输出报告为长时间无响应。
   * 心跳、空 delta、响应头与用量都不更新该值。NULL 表示存量行或本次尚无内容。
   */
  lastContentAt: number | null
  /** 最近一段内容的类型；NULL 表示尚无内容或旧行。用于刷新后恢复运行中状态。 */
  lastContentKind: ProviderRequestContentKind | null
  /** 最后一次实际显示到会话中的思考或正文的时刻；工具参数增量不更新该值。 */
  lastVisibleAt: number | null
  /** 请求进入 received / uncertain / rejected 终态的时刻。 */
  completedAt: number | null
  createdAt: number
}

export type ProviderRequestStatus = 'pending' | 'in_flight' | 'received' | 'uncertain' | 'rejected'

export type ProviderRetryDecision =
  | 'resend'
  | 'interrupted'
  | 'not_retryable'
  | 'limit_exhausted'
  | 'context_compaction'
  | 'context_compaction_failed'
  | 'process_exit'
  | 'run_ended'

/** 单个异常链节点。message 在 runtime 持久化边界脱敏。 */
export interface ProviderFailureCause {
  name: string
  code: string | null
  message: string
}

/**
 * 失败时刻的传输层读数。与事件层的 `providerEvents` / `silentMs` 对照可以区分：
 * 响应头未到达（`status` 为 null）、服务端排队中（有保活行、字节仍在到达）、
 * 连接已失效（`sinceLastByteMs` 与 `silentMs` 相等）。
 */
export interface ProviderTransportReading {
  /** 响应状态码；响应头未到达时为 null。 */
  status: number | null
  /** 发出到响应头到达的毫秒数；未到达时为 null。 */
  headersAfterMs: number | null
  /**
   * 响应头到达的绝对时刻；未到达时为 null。
   *
   * 与 `headersAfterMs` 用途不同：诊断只使用时长，账本中的对应列需要时刻。
   * 非 2xx 的响应头只能经此写入 `ProviderRequest.headersAt`：该路径上适配器直接抛错，
   * 不经过 `response_started`。
   */
  headersAt: number | null
  /** 正文累计字节数。 */
  bytes: number
  /** 最后一个正文字节到失败时刻的毫秒数；未收到任何字节时为 null。 */
  sinceLastByteMs: number | null
  /** SSE 注释行（以 `:` 开头）的条数，即服务端排队时的保活行。 */
  keepAliveLines: number
}

/**
 * 一次失败请求的可导出诊断。它属于 `provider_requests` 中的对应行，不另建重试状态表。
 */
export interface ProviderRequestDiagnostic {
  provider?: {
    status: number | null
    code: string | null
    type: string | null
    param: string | null
  }
  causes: ProviderFailureCause[]
  providerEvents: number | null
  silentMs: number | null
  /** 适配器未接入传输读数的路径（本地拒绝、子进程）为 null。 */
  transport: ProviderTransportReading | null
  assistantChars: number | null
  toolCallCount: number | null
  retry: {
    decision: ProviderRetryDecision
    /** 即将进行第几次自动重发，从 1 起；不重发时为 null。 */
    attempt: number | null
    max: number
    backoffMs: number | null
    /**
     * 退避等待开始的时刻；不重发时为 null。
     *
     * 刷新之后的倒计时只能由该值加 `backoffMs` 还原：`completedAt` 是终态写入账本的时刻，
     * 与等待起点不同。
     */
    at: number | null
  }
}

// ─────────────────────────────── 上下文压缩 ───────────────────────────────

/**
 * 一条折叠边界。
 *
 * 排序规则：先按消息 id，同一消息内再按 step 戳。`step` 缺省表示边界只到消息
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
   * 收纳线：该位置及之前的工具结果只发送信封，不发送正文。
   *
   * 不变量：收纳线 ≥ 摘要线，由构造点保证。缺少该键表示与摘要线重合。
   */
  condensedThrough?: CompactionCut
  /**
   * 累计被摘要替代的消息条数。
   *
   * 记录消息条数，不要记录为按 run 分组的步数：投影只按 `compactedThroughMessageId`
   * 过滤，按 run 分组的数据没有任何投影使用，而前端把其键数当作消息数显示，
   * 显示的数字因此错误。
   */
  compactedMessageCount: number
  summary: string
  /** 摘要保留的精确事实包（文件路径、决定、未完成项），不是自由文本。 */
  facts: CompactionFacts
  /**
   * 该投影落库后，下一次请求预计占用的上下文。
   *
   * 它是 manifest 的派生快照，不是第二份上下文记录：`basedOnProviderRequestId`
   * 指明它从哪一条已发送请求中扣除了本次投影回收量；发出新请求后，面板立即
   * 改用逐请求记录。压缩后的请求尚未经 provider 真值验证，因此界面必须标为估算。
   *
   * 允许缺失是为了读取升级前已落库的 manifest；新写入一律带有该字段。
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
   * 被压缩部分中已落盘的中间产物，形如
   * `run_command npm test → rs_abc123`。
   *
   * 缺少该字段时，压缩会使 sink 中的正文不可达：登记行仍在正文库中，
   * 但模型无从得知 `rs_abc123` 这个 id，无法调用 `read_resource`。
   * 落盘只保证内容不丢失，模型还需要能够重新读取才能使用；缺少该记录时，压缩后无法重新读取。
   *
   * 只保存定位事实，不保存正文：正文始终在内容库中按哈希寻址。
   * 旧 manifest 没有该键，读取结果为 `undefined`，按空处理（已落盘的数据是历史事实）。
   */
  resources?: string[]
  /**
   * 按行读取过的文件与已读取的行段（相邻、重叠的行段已合并）。
   *
   * 摘要线越过这些读取之后，模型只能依据该记录得知读取进度；缺少该记录时，继续读取大文件
   * 会从头重新读取。旧 manifest 没有该键，按空处理。
   */
  filesRead?: FileReadProgress[]
}

export interface FileReadProgress {
  path: string
  /** 文件总行数，取最近一次读取时的值。 */
  totalLines: number
  /** 已读取的行段 `[起, 止]`（含两端，从 1 开始），升序、互不相邻。 */
  ranges: [number, number][]
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
   * 置顶时间。不存在该键表示未置顶。
   *
   * 保存时间戳而不是布尔值：多个置顶项目之间也需要确定的顺序（后置顶的在前）。
   */
  pinnedAt?: number
}
