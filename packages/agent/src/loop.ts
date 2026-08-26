/**
 * AgentLoop —— ReAct 主循环。
 *
 * 职责边界（刻意画得很窄）：装配上下文 → 调模型 → 执行工具 → 落账本 → 发事件。
 * 它**不**负责：决定用哪个 provider（adapter 的事）、怎么存（store 的事）、
 * 怎么传给客户端（server 的事）。
 *
 * 上下文装配的硬约束（靠代码保证，不靠提示词）：
 * - 冻结前缀 = system.md + environment.md + rules.md，跨 run 逐字节稳定。
 * - 日期、技能清单、记忆**永不进冻结前缀**——它们随时间/用户增删而变，
 *   放进前缀等于每次都破缓存。一律压到 transcript 之后的尾区。
 * - 工具 schema 按名排序（registry 保证），排在最前，顺序抖动即全量失效。
 */

import { readFile, stat } from 'node:fs/promises'
import type {
  ChatRequest,
  ContentBlock,
  LlmAdapter,
  ProviderEvent,
  ProviderUsage,
  TokenDensity,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import {
  computeCost,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  ProviderError,
} from '@qywork/ai'
import type {
  ActionDescriptor,
  AgentEvent,
  ContextBreakdown,
  ContextOmitted,
  FileChange,
  RunId,
  RunUsage,
  StopReason,
  ToolOutcomeWire,
} from '@qywork/core'
import { emptyBreakdown, emptyOmitted, newBatchId, reconcileBreakdown } from '@qywork/core'
import type { CompactionOutcome } from './compaction.ts'
import { stepStamp } from './compaction.ts'
import { drainUntil, EventQueue } from './event-queue.ts'
import { describeDrift, PrefixAudit } from './prefix-audit.ts'
import {
  actionFingerprint,
  cycleFingerprint,
  type ProgressEvidence,
  repeatsNoProgress,
} from './progress.ts'
import {
  isParallelSafe,
  resetBatchBudget,
  resolveAction,
  type ToolContext,
  type ToolContextBase,
  type ToolRegistry,
} from './registry.ts'

export interface LoopDeps {
  adapter: LlmAdapter
  registry: ToolRegistry
  /** 三层冻结前缀，已拼好。 */
  systemPrompt: string
  /**
   * 尾区注记：日期、工作区状态、技能索引、记忆索引、待加载的外部工具清单。
   *
   * 每条自带分组，**不要一律标成 `workspaceState`**：那样面板上「记忆内容」
   * 与「技能清单」两行永远是 0——数据一直在发，只是没人按组去量。
   */
  tailNotes: () => {
    content: string
    group: 'workspaceState' | 'skills' | 'memory' | 'mcpTools'
  }[]
  /**
   * 除 `emit` 外的执行上下文。**`emit` 不在这里**——它要带的 stepId 只有 loop 有，
   * 理由写在 `ToolContext.emit` 上方。
   */
  makeToolContext(runId: RunId, emit: (e: AgentEvent) => void): ToolContextBase
  /** 每个 step 的持久化回调。事件发出前必须先落盘。 */
  persist: LoopPersistence
  /**
   * 上下文压缩。由 runtime 装配（它才知道怎么从账本取历史、往哪写 manifest）。
   *
   * 不给的话由构造函数补一个透传实现，**调用点因此不必判空**。这不是给缺失
   * 留后路：可缺性只服务测试夹具，而让它泄漏到每个调用点的代价是三处
   * `if (compaction)`，其中任何一处漏判都是一次静默的「压缩没发生」。
   */
  compaction?: CompactionPort
  /**
   * 流空闲超时（毫秒）。不传用 `STREAM_IDLE_TIMEOUT_MS`。
   * 存在的理由只有一个：让测试在几百毫秒内验到这条路径。回归测试不能等三分钟。
   */
  streamIdleTimeoutMs?: number
}

/**
 * 压缩端口。
 *
 * 定义成端口而不是让 loop 直接操作账本：loop 的职责边界是「装配上下文 → 调模型 →
 * 执行工具」，一旦它开始知道 manifest 存在哪张表，这条边界就没了。
 */
export interface CompactionPort {
  /**
   * 把整串待发消息投影成实际要发的那份。未压缩时原样返回。
   * 每次构造请求都调用——压缩发生在两次请求之间，投影必须跟着变。
   */
  project(messages: WireMessage[]): WireMessage[]
  /**
   * 执行一次压缩并落库。**不抛异常**，失败以 outcome 表达。
   *
   * 信号必须逐层传到落库点前：`untilAborted` 只让 loop 从等待中返回，
   * 压缩仍在后台执行，其结果要靠同一个信号在落库前被丢弃。
   */
  run(input: CompactionRunInput): Promise<CompactionOutcome>
}

export interface CompactionRunInput {
  /** 中断信号。**可缺**：手动压缩不属于任何 run，没有 run 信号。 */
  signal?: AbortSignal
  /** 当前占用读数。**必须与触发判定同一把尺**，两处各量一次就是两本账。 */
  occupancy: number
  /** 模型窗口。软阈值与保留预算都从它推导，不另传现成的数字。 */
  contextWindow: number
  /**
   * 会话主模型那把尺，与 `occupancy` 同一把。
   *
   * **不是 summarizer 的**：摘要可以由另一个模型生成，但这些量描述的是主模型
   * 看到的上下文，换尺就是拿另一个 tokenizer 去量别人的窗口。
   */
  density: TokenDensity
}

export interface LoopPersistence {
  nextSeq(runId: RunId): number
  openTextStep(runId: RunId, seq: number): string
  /**
   * 思考正文的行。**与文本行同构**：流到就开，逐段追加，`appendText` 共用。
   *
   * 单开一种 step 而不是挂在工具行上：挂上去的推论是「这一轮没有工具调用就没有
   * 地方放」，因此纯文本轮的思考直接丢弃——刷新一次页面它就不存在了。
   *
   * 它同时是 DeepSeek 类兼容端点的必需品：带 tool_calls 的 assistant 消息要原样
   * 回传 `reasoning_content`，否则后续轮次 400；历史从 steps 投影回去时缺这一段
   * 就是必然的 400。
   */
  openThinkingStep(runId: RunId, seq: number): string
  /**
   * 轮内自动重发前，把失败那次留下的思考 step 落成失败终态。
   *
   * 边界：只标不删——那些 step 真实发生过，也已经渲染给用户。投影侧据这个终态
   * 把它们排除在模型视图之外，不排除就会与重发那次的思考拼成一条回传给 provider。
   */
  failThinkingSteps(stepIds: string[]): void
  appendText(stepId: string, delta: string): void
  openToolStep(
    runId: RunId,
    seq: number,
    call: WireToolCall,
    batchId: string,
    callIndex: number,
    waveIndex: number,
    action: ActionDescriptor,
  ): string
  markExecuting(stepId: string): void
  settleTool(
    stepId: string,
    status: 'success' | 'failure',
    outcome: ToolOutcomeWire,
    args: Record<string, unknown>,
    action: ActionDescriptor,
    /**
     * 这次调用跑了多久。**与 `tool.finished` 事件里那个数是同一个**——
     * 一处量、两处用：事件给运行期的界面，落库给刷新之后的回放。
     */
    durationMs: number,
  ): void
  saveUsage(runId: RunId, usage: RunUsage): void
  /**
   * 压缩落一条 step。
   *
   * **这是 `'compaction'` 这种 step 的唯一生产者。** 少了它，`steps.kind` 的 CHECK、
   * `StepKind`、archive 渲染分支就都是没有生产者的死链路（C1 第 1 款）：压缩条只由
   * 活事件创建，刷新即消失，而它是解释「上下文为什么降了」的唯一线索。
   */
  recordCompaction(
    runId: RunId,
    seq: number,
    payload: {
      /**
       * 终态的**唯一**记法，与 `CompactionEvent.phase` 同源。
       * 行上的 `status` 列由它导出，不要反过来让调用方各报一次。
       */
      phase: 'done' | 'skipped' | 'failed'
      manifestRevision: number
      compactedMessages: number
      /** `phase='done'` 专有：摘要线跟着前移了（true），还是只收纳了工具正文（false）。 */
      summarized?: boolean
      reasonCode?: string
    },
  ): void
  /**
   * 逐请求账。**装配完成、发出之前**记一行，返回 id 供后续回填。
   *
   * **不能写成挂在 run 上的三个标量**（tokens / limit / percent）：那样每个 step
   * 覆盖一次，一个 run 有 N 次请求而账只剩最后一次的读数，
   * 「这一轮上下文怎么长起来的」在账本里不存在。
   */
  openRequest(input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    model: string
    measuredInputTokens: number
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    /** 本次请求的信封指纹。跨 run 复用锚点时靠它判「还是同一份上下文吗」。 */
    cacheRouteFingerprint: string
  }): string
  /** 请求真的发出去了。sent_at 只在这里置。 */
  markRequestSent(requestId: string): void
  /**
   * 请求终态。`usage` 为 null = provider 没回报，**四个字段落 null 不落 0**——
   * 中转站漏 usage 是常态，记成 0 会让上下文锚点误判成「这次什么都没占」。
   */
  settleRequest(
    requestId: string,
    status: 'received' | 'uncertain' | 'rejected',
    usage: {
      inputTokens: number
      outputTokens: number
      cachedTokens: number | null
      cacheWriteTokens: number | null
    } | null,
    errorCode: string | null,
    /** provider 的原话。拿不到就空串——编一个是给账本注水。 */
    finishReason?: string,
  ): void
}

export interface RunInput {
  runId: RunId
  history: WireMessage[]
  effort?: ChatRequest['effort']
  maxSteps?: number
  cacheKey?: string
  signal: AbortSignal
  /**
   * 上一次 provider 真值回执，从账本取。**决定这一轮开头显示的是不是同一把尺。**
   *
   * 没有它，每个 run 的第一次请求只能报本地估算（系统性偏低），第二次请求起才切到
   * 真值：读数在每轮开头掉一次再弹回，而会话内容一个字没变。
   *
   * `throughMessageId`：这个回执覆盖到哪条消息为止。它之后的历史消息是
   * 锚点没算过的，要另外估。
   */
  anchor?: {
    tokens: number
    throughMessageId: string | null
    /**
     * 产生这个真值的那次请求的信封指纹（`envelopeHashOf`）。
     *
     * 与本轮不一致就作废——拿旧信封的真值配新信封的上下文是两把尺。
     *
     * **`null` 不算「变了」。** 它是「这一行没记过指纹」（本次迁移之前建的），
     * 而把「不知道」当成「变了」和当成「没变」一样是编出来的确定性——
     * 同 `cachedTokens` 的立场：未回报不等于 0。新行一律带指纹，
     * 所以 null 只存在于存量行，保护对此后的每一次请求都成立。
     */
    envelopeFingerprint: string | null
  }
  /**
   * 本轮 transcript 归属的用户消息。
   *
   * 不带它的话本 run 内新产生的执行记录没有归属，压缩投影认不出它们的位置，
   * 因此 run 内涨起来的那部分永远压不掉——而涨的正是那部分。
   */
  userMessageId?: string
}

/** 换行。日志里用，避免转义在工具链上被折半。 */
const NEWLINE = String.fromCharCode(10)

const DEFAULT_MAX_STEPS = 120

/**
 * 流空闲超时。**两个事件之间**超过这个时长没有新事件就判定流卡死。
 *
 * 没有这条超时，provider 侧断流之后 run 既不出错也不结束：界面持续转圈，日志无输出。
 * `stream_idle_timeout` 这个码因此必须有生产者——它是少数**只能靠事件不出现**
 * 才发现得了的死链路。
 *
 * 计的是**间隔**不是总时长：一轮 agent 跑十分钟是正常的，十分钟里一个字节都没有不是。
 * 180 秒给得比较宽，因为首个事件之前要等首 token，长 prompt 上这一段本来就慢；
 * 判错的代价（把一次正常的慢请求掐掉）比判漏（无限期挂住）大。
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000

/**
 * 按思考档位放宽空闲超时。
 *
 * 180 秒是给常规档留的。高档位下首 token 之前模型要先想很久——`xhigh`/`max`
 * 在长 prompt 上实测能超过三分钟，而那时掐掉的是一次**完全正常**的请求。
 * 判错的代价（把慢请求掐死）比判漏（多挂一会儿）大得多，所以往宽了给。
 *
 * 这条与「不按模型名猜行为」不冲突：档位是**用户显式选的配置**，不是从名字推的。
 */
function idleTimeoutFor(effort: ChatRequest['effort']): number {
  if (effort === 'max') return STREAM_IDLE_TIMEOUT_MS * 3
  if (effort === 'xhigh') return STREAM_IDLE_TIMEOUT_MS * 2
  return STREAM_IDLE_TIMEOUT_MS
}

/**
 * 上游自报「暂时不可用」后的等待。
 *
 * 这类故障的恢复是秒级，而重发期间界面上没有任何反馈，等更久用户会当成卡死。
 */
export const UNAVAILABLE_BACKOFF_MS = 3_000

/**
 * 一轮之内最多原样重发几次。**对表里每个码一视同仁。**
 *
 * **这个数只有这一处**，界面上那句「正在重连 N / M」的 M 由 `run.retrying` 事件
 * 带过去，不许在前端再写一遍。
 *
 * 取 5 的依据是 2026-08-22 的一次实测：长思考请求 11/11 在 `reasoning_content`
 * 中途干净 EOF（无 `finish_reason`、无 `[DONE]`、无网络错误），短请求正常收尾。
 * 断的是上游的某条路线不是整条链路，重发一次接不住；而每次尝试本身要跑几十秒到
 * 两分钟，5 次不构成对上游的连打。
 *
 * 重发的门槛在尝试循环里，判的是**模型可见输出为零**——正文吐过字就一次都不重发，
 * 这个上限管不到那种情形。
 */
export const MAX_RESENDS = 5

/**
 * 会自动重发的失败，值是重发前的等待毫秒。次数上限见 `MAX_RESENDS`。
 *
 * **传输层等 0，上游明确答复的不可用要等。** 连接失败时无从判断请求是否送达，
 * 原样立刻重发是唯一选择；`provider_unavailable` 是上游明确答复的「暂时不可用」，
 * 不等就是无退避地重压对端。
 *
 * 这张表只说「等多久」，**不说「什么时候够格重发」**——那条判据在尝试循环里，
 * 判的是模型可见输出为零。
 *
 * 不要以「重发要多付一次长 prompt 的钱」为由把 `provider_unavailable` 摘掉：
 * 不重发时用户要手动继续，那一次付的是同一笔钱，而且 run 已经落成 failed，
 * 新消息还得让模型重新理解上一轮做到哪。
 *
 * `rate_limited` 不在表里：429 该按 provider 给的 `Retry-After` 等，不是固定值。
 *
 * 已知代价：`provider_unavailable` 同时装着 4xx 参数错误（`errors.ts` 的 400/422 一支），
 * 那类重发必然拿回同一个拒绝——按 `MAX_RESENDS` 就是空等 5 轮退避（15 秒）、
 * 白付 5 次长 prompt。接受它是因为参数错误由配置决定，改一次就不再出现；
 * 而临时不可用是随机的，不救就是丢掉整轮已完成的工作。
 */
const RESENDABLE: ReadonlyMap<string, number> = new Map([
  ['network_error', 0],
  ['stream_idle_timeout', 0],
  ['provider_unavailable', UNAVAILABLE_BACKOFF_MS],
])

/**
 * 传输失败的现场读数。
 *
 * 分类短语（「连接被断开」「请求超时」「模型响应中断」）由 `ai/src/errors.ts` 与
 * `openStream` 给，它们拿不到静默时长，也不知道这次收到过数据没有；而这两项区分
 * 请求未落地（一个字节都没收到）与传输中断（收到过之后停了）。
 *
 * 这句只在这里拼，全项目只有这一个拼装处。
 */
function transportReading(providerEvents: number, silentMs: number): string {
  const secs = Math.round(silentMs / 1000)
  if (providerEvents === 0) return `${secs} 秒未收到响应`
  return `${secs} 秒未收到后续数据`
}

/**
 * 让一个 await 能被中止信号提前结束。
 *
 * **abort 只是置一个信号，等的人不看它就等于没停。** provider 那侧的等待本来就和
 * 卡死检测赛跑（见 `openStream` 里的 `Promise.race`），工具与压缩这两侧没有：
 * 其中任何一个不返回，整轮就停在那个 await 上：停止按钮**无响应**——
 * 不报错、转圈不停、日志无输出，只能重启应用。
 *
 * 返回之后那批工作仍在后台执行。这是有意的：`ctx.signal` 已经 abort，守规矩的
 * 工具自己收手；收不了的由会话收尾时把它们的 step 落成「执行期间被中断，结果未知」
 * ——那正是崩溃恢复给这种情形定的说法，不是新造一套。
 *
 * 不要改成「abort 之后还等它跑完再退」：那等于把停止的时限交给卡住的那一方决定。
 */
/**
 * 给这一次调用配一个带 stepId 的 `emit`。
 *
 * 中途输出的事件必须认得出属于哪张卡片——前端拿 stepId 在 transcript 里找那一条，
 * 找不到就整条丢弃。而 stepId 是开 step 时才产生的，装配方造不出来，
 * 所以这条通道只能在这里绑（见 `ToolContext.emit`）。
 *
 * **其余字段原样带过去**：`state` / `resources` 传的是同一个 Map 引用，
 * 「ToolContext 整个 run 只建一个」那条不变量护的是这几本账跨调用可见，
 * 外面套一层壳不动它们。
 */
function withStep(
  base: ToolContextBase,
  runId: RunId,
  stepId: string,
  queue: EventQueue,
): ToolContext {
  return {
    ...base,
    stepId,
    emit: (channel, delta) => {
      queue.push({ type: 'tool.delta', runId, stepId: stepId as never, channel, delta })
    },
  }
}

function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new DOMException('已中断', 'AbortError'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    // 附上 then 而不是丢开：被放弃的那份若稍后抛错，没有处理器就是一条
    // unhandledRejection，而它会把整个进程带下去。
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', fail))
  })
}

/** 单纯的等待。**它自己不认中止信号**，要能被停止就套 `untilAborted`。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 触发线在窗口里的位置。**压缩链路唯一的阈值常数。**
 *
 * 留两成给「这一轮还要发生的事」：模型这一轮的输出、下一波工具结果、
 * 估算与真值之间的残差。取 0.8 是通用做法，与模型无关——每一档都是 80%。
 *
 * **不要把输出上限或投递预算再减一遍。** 那样阈值会随模型的 `maxOutputTokens`
 * 漂移（同为 1M 窗口的两个模型会得到 36.6% 与 62.2% 两条线），而请求合法性
 * 由申报钳位（`declaredMaxOutput`）保证，不由阈值保证。
 */
const TRIGGER_RATIO = 0.8

/**
 * 压缩的软阈值：占用超过它就在**发出之前**压一次。
 *
 * 具名导出是因为上下文面板要画同一条线——两处算出不同的数，用户看到的刻度
 * 就不是真正会触发的那个点。
 */
export function softLimit(spec: { contextWindow: number }): number {
  return Math.floor(spec.contextWindow * TRIGGER_RATIO)
}

/**
 * 申报余量。**这一处必须自己留，`softLimit` 罩不到它**——软阈值不在下面那个式子里。
 *
 * 占用是估算出来的，估算低估多少，申报就超出窗口多少。取占用的 5%：估算器标定在
 * 1.03–1.18 倍（`ai/tokens.ts` 的 `TokenDensity`），已标定的模型上这个余量用不到；
 * 它挡的是未标定模型走上界档仍然偏低的那一档。
 */
const OUTPUT_DECLARATION_MARGIN_RATIO = 0.05

/**
 * 这一轮申报多少输出上限。`null` = 不申报。
 *
 * 兼容协议按 `输入 + max_tokens ≤ 窗口` 校验，所以申报回答的是「这一轮还装得下
 * 多少输出」，不是「这个模型最多能输出多少」。**静态按规格上限申报**会让
 * 高占用请求被 provider 直接拒——1M 档上那是每次都挂着 384K 的申报。
 *
 * 规格上限是 `null`（未收录 = 没测过）时**整轮不申报**，不拿窗口余量顶上去：
 * 那个数在没测过的端点上一样是编的，发出去换来的是一个 400，而不申报换来的
 * 是端点自己的默认。
 *
 * **余量不能省。** `occupancy` 是估算值，它低估时这个式子申报的就是一个装不下的
 * 上限，换回来一个 400；而那个 400 若被容量分类认成撞窗，还会白花一次有损压缩去
 * 救一个申报错误。
 *
 * `max(1, …)` 是除零保护，不是可调的余量。
 */
function declaredMaxOutput(
  spec: { contextWindow: number; maxOutputTokens: number | null },
  occupancy: number,
): number | null {
  if (spec.maxOutputTokens === null) return null
  const margin = Math.ceil(occupancy * OUTPUT_DECLARATION_MARGIN_RATIO)
  return Math.min(spec.maxOutputTokens, Math.max(1, spec.contextWindow - occupancy - margin))
}

export class AgentLoop {
  /**
   * 前缀审计。
   *
   * 挂在 loop 实例上而不是全局：loop 每轮新建（adapter 绑具体模型），
   * 所以它天然覆盖「同一 run 内多次请求」——那正是前缀**必须**稳定的范围。
   * 跨 run 的稳定性由 `PrefixAudit` 的 cacheKey 维度承担，
   * 装配方（runtime）传的是 conversationId。
   */
  private readonly audit = new PrefixAudit()

  /** 上一次装配丢掉了多少原文。由 `buildRequest` 写，`context` 事件与账本读。 */
  private lastOmitted: ContextOmitted = emptyOmitted()

  /**
   * 压缩端口。**恒非空**——缺省时是下面那个透传实现。
   *
   * 透传的语义与「没有压缩」逐字相同：投影原样返回、压缩报「没什么可折」，
   * 因此容量拒绝照旧上报为 run 错误。差别只在调用点少了三处判空。
   */
  private readonly compaction: CompactionPort

  constructor(private readonly deps: LoopDeps) {
    this.compaction = deps.compaction ?? {
      project: (messages) => messages,
      run: async () => ({ status: 'skipped', reasonCode: 'nothing_to_fold' }),
    }
  }

  /**
   * 给整条流套上空闲计时器，并**把第一个事件先拉出来**。
   *
   * 先拉一次是为了把「没发出去」和「发出去了没回」分开：装配阶段抛出的错
   * （`buildBody` 拼请求体失败）在这里就浮出来，账本行还没被标成 sent。
   *
   * **这一拉拿不到网络错误。** 三个适配器都在发请求之前先 yield
   * `request_prepared`，所以这里拉到的恒是它，真正的网络往返发生在调用方的
   * `for await` 里——重发与终态判定因此必须写在那一侧，不能写在这。
   */
  private async openStream(
    adapter: LlmAdapter,
    req: ChatRequest,
    onStall: () => void,
  ): Promise<AsyncIterable<ProviderEvent>> {
    const provider = adapter.spec.provider
    const idleMs = this.deps.streamIdleTimeoutMs ?? idleTimeoutFor(req.effort)
    const it = adapter.stream(await materialize(req))[Symbol.asyncIterator]()

    /** 等一个事件，超时就判流卡死并中止本次请求。 */
    const step = async (): Promise<IteratorResult<ProviderEvent>> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 先中止底层请求再拒绝：不然连接会一直挂着，
          // 而它占着的正是已被判定为不可恢复的那条流。
          onStall()
          reject(
            new ProviderError({
              code: 'stream_idle_timeout',
              // 只给分类短语，不带数字。「收到了多少 / 多久没动静」由 `run()` 统一补
              // （`transportReading`）——两处各拼一半的话，同一句话就有了两个作者。
              message: '模型响应中断',
              provider,
            }),
          )
        }, idleMs)
      })
      try {
        return await Promise.race([it.next(), stalled])
      } finally {
        clearTimeout(timer)
      }
    }

    const first = await step()
    return {
      async *[Symbol.asyncIterator]() {
        if (first.done) return
        yield first.value
        for (;;) {
          const next = await step()
          if (next.done) return
          yield next.value
        }
      },
    }
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent, void, unknown> {
    const { adapter, registry, persist } = this.deps
    // 这一轮那把尺。三个消费者（读数、压缩触发、申报钳位）共用它。
    const density = adapter.spec.density
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS

    const usage: RunUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      cost: 0,
      // 币种跟着模型走，一个 run 只用一个模型，所以整轮同一个币种。
      currency: adapter.spec.pricing.currency ?? 'USD',
      turns: [],
    }
    const fileChanges: FileChange[] = []
    // transcript = 本 run 内新产生的对话，与传入的 history 拼接后发给模型。
    const transcript: WireMessage[] = []

    /** 本 run 已分配到的最大 step seq。单元戳取它，见 `stampUnit`。 */
    let lastSeq = 0
    const nextSeq = (): number => {
      lastSeq = persist.nextSeq(input.runId)
      return lastSeq
    }

    /**
     * 给 transcript 尾部这一段盖上单元戳。
     *
     * 一个执行波次（assistant 消息 + 它的全部 tool 结果）共用一个戳，压缩因此
     * 只能在戳之间切界，**tool_call 与 tool_result 永远同进同出**。
     * 戳的口径必须与 `runtime/transcript.ts` 投影历史时那一份逐字相同：
     * 取单元里最后一个 step 的 seq。
     */
    const stampUnit = (from: number): void => {
      const stamp = stepStamp(input.runId, lastSeq)
      for (let i = from; i < transcript.length; i++) {
        transcript[i] = {
          ...transcript[i]!,
          _step: stamp,
          ...(input.userMessageId ? { _messageId: input.userMessageId } : {}),
        }
      }
    }

    /*
     * 上下文读数的**唯一一把尺**：最后一次 provider 真值 + 仅对其后新增内容的估算。
     *
     * 坑：不要写成 `max(全量估算, 真值)`。两个数出自两把尺，锚点一失效显示值就从
     * 真值尺跌到系统性偏低的估算尺，会话内容一个字没变而数字掉三成（实测 33%→20%）。
     *
     * `uncovered` 是锚点之后新增的历史消息（本轮的新用户消息）。锚点覆盖到
     * 上一轮为止，不减掉这一块就会漏算。
     */
    let anchor: {
      tokens: number
      uncovered: number
      transcriptIndex: number
      /** 产生这个真值的那次请求的信封指纹。信封一换它就作废。 */
      envelope: string | null
    } | null = input.anchor
      ? {
          envelope: input.anchor.envelopeFingerprint,
          tokens: input.anchor.tokens,
          uncovered: estimateMessages(
            input.history.filter(
              (m) =>
                !input.anchor?.throughMessageId ||
                !m._messageId ||
                m._messageId > input.anchor.throughMessageId,
            ),
            this.deps.adapter.spec.density,
          ),
          transcriptIndex: 0,
        }
      : null

    const meter = (fallback: number): { tokens: number; source: 'actual' | 'estimated' } =>
      anchor
        ? {
            tokens:
              anchor.tokens +
              anchor.uncovered +
              estimateMessages(transcript.slice(anchor.transcriptIndex), density),
            source: 'actual',
          }
        : { tokens: fallback, source: 'estimated' }

    /**
     * 这一轮的占用读数。**触发判定与申报钳位共用它。**
     *
     * 两处各量一次就是两把尺：会出现「检查说没超阈值」和「申报按已经超了算」
     * 同时成立，而这两个结论都会被写进请求。
     */
    const occupancyOf = (req: ChatRequest): number =>
      anchor ? meter(0).tokens : estimateRequest(req, density)

    let stopReason: StopReason = 'completed'
    /**
     * 溢出恢复用过没有。**状态机，不是重试计数。**
     *
     * 计数常量要回答「几次算够」，而这里没有第二次的意义：撞窗之后压一次
     * 是有效的，压完还撞说明压缩已经压不动了，再压一次的输入与上一次逐字相同。
     * 收到一次带回执的成功响应即复位——那说明请求已经装得下，此后再撞是新情况。
     */
    let overflowRecovered = false
    /**
     * 上次尝试压缩时的 transcript 高水位。**进展判据，不是次数闸。**
     *
     * run 内 `input.history` 不变，新的可折单元只可能来自 transcript 追加，
     * 所以「有没有新单元可压」就等于「transcript 有没有变长」。
     * 不判进展的话，占用一旦越过软阈值就是每一步再压一次；
     * 判成「一个 run 只压一次」的话，run 内涨出来的那几十波工具结果永远压不掉。
     */
    let compactedAt = -1
    /** 进展证据，按调用顺序累积。判「原地打转」用，见 progress.ts。 */
    const progress: ProgressEvidence[] = []
    let turnIndex = 0

    // ToolContext 必须**整个 run 只建一个**。工具往 ctx.state 里回写的状态
    // （files 插件记录的「哪些文件本轮读过」、目录大小缓存等）要跨调用可见；
    // 每波新建一个 = 状态永远是空的，写入守卫会把模型刚读过的文件判成没读过，
    // 模型随后会绕道用 shell 手写文件。
    const emitQueue = new EventQueue()
    const ctx = this.deps.makeToolContext(input.runId, (e) => emitQueue.push(e))

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (input.signal.aborted) {
          stopReason = 'user_interrupt'
          break
        }
        const batchId = newBatchId()

        /**
         * 当前正在写的那条 step，**跟通道切换开闭，不跟一轮闩死**。
         *
         * 一次调用里模型可以先思考、再说话、再思考。闩死的话这三段会被并进
         * 「一条思考 + 一条正文」，`seq` 就再也表达不出真实顺序——
         * 实时看到的顺序与刷新后按 seq 重放出来的顺序会不一样。
         *
         * 端点若逐 chunk 交替两个通道，这里就逐 chunk 开新 step。
         * **不要为此加防抖**：那等于为顺序再记一本账，而顺序的真源只能有一份。
         */
        let open: { kind: 'text' | 'thinking'; id: string } | null = null
        /**
         * 本次尝试开过的思考 step。自动重发时这批要落成失败终态——它们装的是被丢弃
         * 的那次生成。**每次尝试开头清空**，读它的只有下面那条重发分支。
         */
        let attemptThinking: string[] = []
        /** 拿到该写的 step；通道换了就先封上旧的、开一条新的。**懒开**，不产生空 step。 */
        const stepFor = (kind: 'text' | 'thinking'): string => {
          if (open?.kind !== kind) {
            const id =
              kind === 'text'
                ? persist.openTextStep(input.runId, nextSeq())
                : persist.openThinkingStep(input.runId, nextSeq())
            if (kind === 'thinking') attemptThinking.push(id)
            open = { kind, id }
          }
          return open.id
        }
        let assistantText = ''
        let thinkingText = ''
        const calls: WireToolCall[] = []
        let providerStop: string = 'end_turn'
        /** provider 的原话，只进账本不参与判断。 */
        let rawStop = ''
        let refusalNote: string | null = null
        /** 本次请求 provider 回报的 usage。null = 它没报——不要拿累计值代替。 */
        let turnUsage: ProviderUsage | null = null

        /*
         * ── 压缩触发：主入口 ──
         *
         * 发送前按占用检查。下面的容量拒绝分支是第二个**调用点**，不是第二个权威：
         * 调的是同一个 `CompactionPort.run()`、落同一份 manifest。
         *
         * 主路径不写成「先发、被 provider 拒了再压、然后重发」：那个形状每次触发都要
         * 先烧掉一次注定失败的长请求，长 prompt 上是几秒到几十秒外加计费。占用取的是
         * 锚定尺（provider 真值 + 仅一轮尾巴的估算），误差被限制在单轮增量内，
         * 够做发送前判断。
         *
         * 估算失误时这里放行，由容量拒绝那条窄路兜底——凭证收得很窄，
         * 泛化的 400 不触发（理由写在那个分支上）。
         */
        // `signal` 不在这里合成：每次尝试要自己的 `attemptAbort`（卡死检测掐的是
        // 那一次连接），所以装配只出请求体，信号在尝试循环里逐次接上。
        let req = this.buildRequest(input, transcript, occupancyOf)

        /*
         * **信封变了就不能再用旧锚点。**
         *
         * 锚点是「上一次 provider 真值描述的那个上下文」。装卸一个 MCP、装个技能、
         * `load_tool` 装一个工具、换条模型，冻结前缀或工具表就换了一份，那个真值
         * 描述的已经不是这一次的上下文——而它是显示、压缩触发、`max_tokens` 钳位
         * 三处共用的那把尺。作废之后退回估算尺一轮，本轮回报一到即重锚。
         *
         * 判在这里而不是取锚点的地方：只有装配完才知道这一次的信封长什么样，
         * 两处各算一遍就是两份指纹。
         */
        if (anchor?.envelope && anchor.envelope !== envelopeHashOf(req)) anchor = null

        if (transcript.length > compactedAt) {
          const occupancy = occupancyOf(req)
          if (occupancy > softLimit(adapter.spec)) {
            compactedAt = transcript.length
            process.stderr.write(
              `[qy] 发送前检查触发压缩：占用约 ${occupancy}，软阈值 ${softLimit(adapter.spec)}
`,
            )
            yield { type: 'compaction', runId: input.runId, phase: 'started' }
            // 同工具波次：压缩可能要调一次模型，卡住的话整轮停在这里，而且它不写
            // `provider_requests`，账本上连「卡在哪」都看不出来。
            const outcome = await untilAborted(
              input.signal,
              this.compaction.run({
                signal: input.signal,
                occupancy,
                contextWindow: adapter.spec.contextWindow,
                density,
              }),
            )
            if (outcome.status === 'aborted') {
              /*
               * 中断的压缩什么都没落库，所以这里什么都不发、什么都不记：
               * run 随即以 `user_interrupt` 收尾，停止时刻多一张红卡是噪音，
               * 而账本上无痕正是「它没有产生任何副作用」这件事的如实记法。
               */
              stopReason = 'user_interrupt'
              break
            }
            if (outcome.status === 'compacted') {
              persist.recordCompaction(input.runId, nextSeq(), {
                phase: 'done',
                manifestRevision: outcome.manifest.revision,
                compactedMessages: outcome.manifest.compactedMessageCount,
                summarized: outcome.summarized,
                ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
              })
              yield {
                type: 'compaction',
                runId: input.runId,
                phase: 'done',
                manifest: outcome.manifest,
                summarized: outcome.summarized,
                ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
              }
              /*
               * 锚点作废。
               *
               * 锚点描述的是**折叠前**那个前缀，折完还拿它算就是读数不降，
               * 下一步又越线、又压一次——压缩变成每步一次的死循环。
               * 退回估算尺一轮，下一个 provider 真值到来即重锚。
               */
              anchor = null
              // 压缩改的是投影，必须重新装配——拿旧请求发出去等于这次压缩白花。
              req = this.buildRequest(input, transcript, occupancyOf)
            } else {
              // 压不动不是致命错：照常发出去，让 provider 来判。
              // **skipped 与 failed 分开报**：「没什么可压」不是失败，
              // 把它显示成红色的压缩失败会让用户去查一个并不存在的故障。
              const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
              persist.recordCompaction(input.runId, nextSeq(), {
                phase,
                manifestRevision: 0,
                compactedMessages: 0,
                reasonCode: outcome.reasonCode,
              })
              yield {
                type: 'compaction',
                runId: input.runId,
                phase,
                reasonCode: outcome.reasonCode,
              }
            }
          }
        }

        const breakdown = breakdownOf(req, density)

        // 前缀漂移只报不拦：拦了等于让一个计费问题变成一个功能故障。
        // 但必须**说出来**——缓存失效本身是完全静默的，不报就永远没人知道。
        const drift = this.audit.observe(input.cacheKey ?? input.runId, req.system)
        if (drift)
          process.stderr.write(`[qy] ${describeDrift(drift)}
`)

        /*
         * ── 发送与消费：一次尝试，断了原样再来，至多 `MAX_RESENDS` 次 ──
         *
         * **重发的窗口是「模型可见输出为零」**：正文一个字都没有、也没有 tool_calls。
         * 重发是重新生成，模型不会接着上次那半截往下写；半截**正文**已经输出后再重发，
         * 界面上就得表达「刚才那段作废」，而 `superseded` 是 run 级语义（靠一条新 run 行
         * 接替旧的），轮内重发没有第二条 run 行可挂——所以正文出现后不再重发。
         *
         * 半截**思考**不在此列：它本来就不进模型视图（活侧只在 `calls.length` 时挂
         * `reasoningContent`，投影侧 `flushText` 直接清空 `pendingReasoning`），
         * 丢弃它不改写任何模型可见状态。代价是失败那次的思考 step 要落失败终态，
         * 见下面重发分支。
         *
         * `request_prepared` 不算 provider 事件——三个适配器都在发请求**之前**
         * 先 yield 它（见各 `stream()` 首行），所以「只收到过它」就等于
         * 「一个字节都没回来」。网络失败因此**全部落在下面这个 `for await` 里**，
         * 不在 `openStream` 里。
         */
        let requestId = ''
        /** 本轮已经开过几行账。`uq_provider_run_turn` 的第三段取的就是它。 */
        let sendIndex = 0
        /**
         * 这一轮自动重发过几次。上限 `MAX_RESENDS`。
         *
         * **不要拿 `sendIndex` 代替它计数**：那个数还会被压缩重发推进，共用一个数
         * 等于压一次就消耗一次重发额度，界面上报的次数也跟着虚高。
         */
        let resends = 0
        for (;;) {
          attemptThinking = []
          // 每次尝试自己的中止器：卡死检测掐的是**这一次**连接，
          // 复用上一次那个等于新连接一开就已经是 aborted。
          const attemptAbort = new AbortController()
          req = { ...req, signal: AbortSignal.any([input.signal, attemptAbort.signal]) }

          // 同一轮的第 N 次发送。`uq_provider_run_turn` 靠它区分，重发因此不会顶掉
          // 上一次那行——两次都真实发生过，账要分开记。**就地自增**，不要挪到各条
          // 重发分支里去加：漏一条就是拿同一组键再插一次，整轮死在唯一索引上。
          const retryIndex = sendIndex++

          // 账本行在**发出之前**落。此刻要发什么已经确定（分组、指纹都算得出），
          // provider 是否接收仍未知——两件事分开记，「发出去了没回」
          // 和「没发出去」在账本上才可区分。
          requestId = persist.openRequest({
            runId: input.runId,
            turnIndex: step,
            retryIndex,
            model: adapter.spec.id,
            measuredInputTokens: estimateRequest(req, density),
            sentCategories: breakdown,
            omittedCategories: this.lastOmitted,
            payloadHash: payloadHashOf(req),
            cacheRouteFingerprint: envelopeHashOf(req),
          })

          /**
           * 最后一次收到事件的时刻。**起点是「发出」而不是 0**——一个事件都没收到时，
           * 它与此刻的差正好是「发出去之后等了多久」，不需要另记一个发送时刻。
           */
          let lastEventAt = Date.now()
          /** provider 真的回过来的事件数（不含 `request_prepared`）。 */
          let providerEvents = 0

          try {
            const stream = await this.openStream(adapter, req, () => attemptAbort.abort())
            persist.markRequestSent(requestId)

            for await (const ev of stream) {
              lastEventAt = Date.now()
              if (ev.type !== 'request_prepared') providerEvents++
              if (input.signal.aborted) break

              switch (ev.type) {
                case 'request_prepared': {
                  const limit = adapter.spec.contextWindow
                  const m = meter(ev.measuredInputTokens)
                  // 保留一位小数：1M 窗口下 2139 token 取整就是 0%，那一位有信息量。
                  const pct = limit ? Math.round((m.tokens / limit) * 1000) / 10 : 0
                  yield {
                    type: 'context',
                    runId: input.runId,
                    tokens: m.tokens,
                    limit,
                    percent: pct,
                    source: m.source,
                    compactAt: softLimit(adapter.spec),
                    /*
                     * **必须对账**：`tokens` 走锚定尺（provider 真值 + 一轮尾巴），
                     * `breakdown` 是本地估算，两者天然不等。不对账的话面板上各行
                     * 加起来对不上标题，而差额无声地落进「剩余空间」那一行。
                     *
                     * 会话面板那侧（`runtime/context-panel.ts`）一直是对过账的，
                     * 这里不对就成了同一个面板两条路显示两组数：打开会话看到一组，
                     * run 一跑起来换成另一组。实测差过 271k。
                     *
                     * `m.source === 'estimated'` 时 `m.tokens` 与 `breakdown` 同尺
                     * 同源（都是 `estimateRequest` 的同一次装配），差额为零，
                     * 这里是恒等变换。
                     */
                    breakdown: reconcileBreakdown(breakdown, m.tokens),
                    omitted: this.lastOmitted,
                  }
                  break
                }
                case 'thinking_delta': {
                  thinkingText += ev.delta
                  const stepId = stepFor('thinking')
                  persist.appendText(stepId, ev.delta)
                  yield {
                    type: 'thinking.delta',
                    runId: input.runId,
                    stepId: stepId as never,
                    delta: ev.delta,
                    redacted: false,
                  }
                  break
                }
                case 'text_delta': {
                  const stepId = stepFor('text')
                  assistantText += ev.delta
                  persist.appendText(stepId, ev.delta)
                  yield {
                    type: 'text.delta',
                    runId: input.runId,
                    stepId: stepId as never,
                    delta: ev.delta,
                  }
                  break
                }
                case 'tool_calls': {
                  calls.push(...ev.calls)
                  break
                }
                case 'usage': {
                  turnUsage = ev.usage
                  mergeUsage(usage, ev.usage, adapter, turnIndex)
                  persist.saveUsage(input.runId, usage)
                  yield { type: 'usage', runId: input.runId, usage: structuredClone(usage) }
                  break
                }
                case 'done': {
                  providerStop = ev.stopReason
                  rawStop = ev.rawStopReason
                  if (ev.stopReason === 'refusal') {
                    refusalNote = ev.refusal?.explanation ?? '模型出于安全策略拒绝了该请求'
                  }
                  break
                }
                default:
                  break
              }
            }

            break
          } catch (err) {
            const pe = err instanceof ProviderError ? err : null
            const code = pe?.code ?? 'internal_error'

            /*
             * 终态判据是**「provider 有没有答复过」**，不是错误码。
             *
             * 有 HTTP 状态码 = 它明确回绝了，`rejected`；没有 = 连接层面就没成，
             * 是否送达、是否计费均无从判断，只能记 `uncertain`。
             * 不要按 `code === 'stream_idle_timeout'` 判：那会把一次「没连上」
             * 记成「provider 拒了」，是编出来的确定性。
             *
             * **用量与终态是两件事。** 流在收尾之前断掉时 provider 常常已经把用量
             * 报过了（实测：断流样本带着 `completion_tokens` 6476/5126）。那一格是实数，
             * 记 `null` 会让账本与实际不符。`uncertain` 表示送达状态未知，
             * 不表示未计费。`pe.usage` 缺席仍记 `null`——缺席不等于零。
             */
            persist.settleRequest(
              requestId,
              pe?.status !== undefined ? 'rejected' : 'uncertain',
              pe?.usage ?? null,
              code,
              rawStop,
            )

            // 用户按了停止：不重发，也不改写正文，交给外层认成中断。
            if (input.signal.aborted) throw err

            /*
             * ── 容量拒绝：压一次再重发 ──
             *
             * 这是压缩的**第二个调用点**，不是第二个权威：调的是同一个
             * `CompactionPort.run()`、落同一份 manifest、走同一条落库路径、
             * 失败仍报 `context_overflow`。
             *
             * 为什么必须有它：占用读数对附件按固定值估（`ai/tokens.ts` 的
             * `MEDIA_TOKENS`），一份大附件能低估两个数量级。那时发送前检查恒放行、
             * provider 恒拒绝、重试拿到的还是同一个估算——**会话就此卡死，
             * 而手动压缩也救不回来**（附件在保留区里）。失败路径必须有终态。
             *
             * 凭证收得很窄：光看 `code` 不够，必须同时有 `capacity`
             * （`ai/capacity.ts` 的窄分类：provider 原生容量码或强消息匹配），
             * 泛化的 400 不触发。宁可不救，也不能把一次参数错误当成容量问题
             * 反复压缩。
             */
            if (code === 'context_overflow' && pe?.capacity && !overflowRecovered) {
              overflowRecovered = true
              const cap = pe.capacity
              /*
               * 用 provider 自报的输入量校正锚点——它是真值，而本地那个估算
               * 刚刚被证明是错的。拿不到就把锚点作废退回估算，**不要用本地估算
               * 去填这个位置**：那正是撞窗的原因，填进去等于确认一遍错误。
               */
              if (cap.reportedInputTokens !== null) {
                anchor = {
                  tokens: cap.reportedInputTokens,
                  uncovered: 0,
                  transcriptIndex: transcript.length,
                  envelope: envelopeHashOf(req),
                }
              } else {
                anchor = null
              }
              // 压缩前后用**同一把尺**量请求本身。判据不是「压缩返回成功」——
              // 收纳段可能落了库却一个 token 没省。
              const sizeBefore = estimateRequest(req, density)
              yield { type: 'compaction', runId: input.runId, phase: 'started' }
              const outcome = await untilAborted(
                input.signal,
                this.compaction.run({
                  signal: input.signal,
                  occupancy: cap.reportedInputTokens ?? occupancyOf(req),
                  contextWindow: adapter.spec.contextWindow,
                  density,
                }),
              )
              if (outcome.status === 'aborted') {
                stopReason = 'user_interrupt'
                throw err
              }
              if (outcome.status === 'compacted') {
                const rebuilt = this.buildRequest(input, transcript, occupancyOf)
                if (estimateRequest(rebuilt, density) < sizeBefore) {
                  persist.recordCompaction(input.runId, nextSeq(), {
                    phase: 'done',
                    manifestRevision: outcome.manifest.revision,
                    compactedMessages: outcome.manifest.compactedMessageCount,
                    summarized: outcome.summarized,
                  })
                  yield {
                    type: 'compaction',
                    runId: input.runId,
                    phase: 'done',
                    manifest: outcome.manifest,
                    summarized: outcome.summarized,
                  }
                  compactedAt = transcript.length
                  anchor = null
                  req = rebuilt
                  continue
                }
              }
              /*
               * **没变小就不重发。** 同一份字节再发一次只会拿到同一个拒绝，
               * 而那一次要付全额的长 prompt 费用。
               */
              const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
              const reasonCode =
                outcome.status === 'compacted' ? 'no_reduction' : outcome.reasonCode
              persist.recordCompaction(input.runId, nextSeq(), {
                phase,
                manifestRevision: 0,
                compactedMessages: 0,
                reasonCode,
              })
              yield { type: 'compaction', runId: input.runId, phase, reasonCode }
              throw err
            }

            // 不在重发表里的原样上抛：provider 已经说清是什么了（参数错、没权限、
            // 模型不存在），重发拿回来的是同一个拒绝。
            if (!pe) throw err
            const backoffMs = RESENDABLE.get(code)
            if (backoffMs === undefined) throw err

            const silentMs = Date.now() - lastEventAt
            /*
             * 原始错误形状只写日志。
             *
             * `errno` 与英文原文对排查是全部，对界面是噪音——归类之后那句中文说的是
             * 「哪一类」，说不出「是哪个码」。少了这行，账本里只剩中文，
             * 回头分不出 `ECONNRESET`（对端重置）和本地 60 秒空闲超时中止的。
             *
             * 取的是 `cause` 而不是 `err`：走到这里 `err` 已经是归类后的
             * `ProviderError`，它的 `code` 是 `network_error` 这种分类码，
             * 真正的 errno 挂在被它包住的那个原始错误上。
             */
            const raw = (err as { cause?: unknown }).cause
            process.stderr.write(
              `[qy] 请求失败 turn=${step} retry=${retryIndex} code=${code} errno=${String(
                (raw as { code?: unknown })?.code ?? '-',
              )} events=${providerEvents} silent=${Math.round(silentMs / 1000)}s | ${
                raw instanceof Error ? raw.message : pe.message
              }\n`,
            )

            /*
             * **额度是整轮的，不按码各记一份。** 一轮里先断流再被拒的话，前面用掉的
             * 次数照算——那一轮已经真的发出去过那么多次，换个码不该把账清零。
             */
            if (resends < MAX_RESENDS && assistantText === '' && calls.length === 0) {
              resends++
              /*
               * 重发是**重新生成**，不是接着上次那半截写。所以本次尝试的痕迹要一起处置：
               *
               * - 思考 step 落失败终态。不落的话它们与重发那次的思考在同一个 run 里
               *   相邻，投影时被 `pendingReasoning` 拼成一条回传给 provider。
               * - `open` 必须置空。不置空的话重发后第一个 thinking_delta 经 `stepFor`
               *   命中旧 id，新生成被 `appendText` 拼进已失败的那条 step。
               * - `thinkingText` 同理，不清就是两次生成首尾相接后一起挂上
               *   `reasoningContent`。
               */
              persist.failThinkingSteps(attemptThinking)
              open = null
              thinkingText = ''
              // 界面此刻的末条是失败那次的半截思考，不发这条事件它会一直显示「正在思考…」。
              yield {
                type: 'run.retrying',
                runId: input.runId,
                attempt: resends,
                max: MAX_RESENDS,
              }
              // 等待必须可中断：退避的这几秒内用户点停止，不中断等待就是按钮无响应。
              if (backoffMs > 0) await untilAborted(input.signal, sleep(backoffMs))
              continue
            }

            /*
             * 分类短语 + 现场读数 + 是否自动重发过，一行说完。
             *
             * 现场读数只给传输层。`provider_unavailable` 是上游明确答复的，
             * 给它拼「N 秒未收到响应」等于告诉用户请求没落地。
             */
            throw new ProviderError({
              code: pe.code,
              message: [
                pe.message,
                ...(code === 'provider_unavailable'
                  ? []
                  : [transportReading(providerEvents, silentMs)]),
                ...(resends > 0 ? [`已重发 ${resends} 次`] : []),
              ].join('，'),
              provider: pe.provider,
              cause: err,
            })
          }
        }

        turnIndex++

        // 流跑完了就给这一行落终态。中途被用户打断算 `uncertain`——
        // provider 是否收全无从判断，这正是 `uncertain` 的语义。
        persist.settleRequest(
          requestId,
          input.signal.aborted ? 'uncertain' : 'received',
          turnUsage,
          null,
          rawStop,
        )

        if (input.signal.aborted) {
          stopReason = 'user_interrupt'
          break
        }

        // 把本轮 assistant 输出写回 transcript：模型下一轮必须看到自己刚说过什么、
        // 调了哪些工具，否则会重复调用。
        /** 本轮这个可折单元在 transcript 里的起点。工具结果随后追加到它后面。 */
        const unitStart = transcript.length
        if (assistantText || calls.length) {
          transcript.push({
            role: 'assistant',
            content: assistantText,
            ...(calls.length ? { toolCalls: calls } : {}),
            // DeepSeek 类兼容端点要求带 tool_calls 的 assistant 消息原样回传思考内容。
            ...(thinkingText && calls.length ? { reasoningContent: thinkingText } : {}),
            _group: 'executionRecords',
          })
          stampUnit(unitStart)
        }

        /*
         * 锚点前移。**只有真的拿到 usage 才动**——0 或缺失不是可用回执，
         * 那种时候锚点原地不动、增量继续长，显示值不会因为一次漏报而跳水。
         *
         * `transcriptIndex` 取**推完 assistant 消息之后**的长度：这一轮的输出
         * 已经算在 `outputTokens` 里，再估一遍就是重复计数。其后推进来的
         * 工具结果才是锚点没覆盖到的增量。
         */
        if (turnUsage) {
          const total =
            turnUsage.inputTokens +
            (turnUsage.cachedTokens ?? 0) +
            (turnUsage.cacheWriteTokens ?? 0) +
            turnUsage.outputTokens
          if (total > 0)
            anchor = {
              tokens: total,
              uncovered: 0,
              transcriptIndex: transcript.length,
              envelope: envelopeHashOf(req),
            }
          /*
           * ── 静默溢出 ──
           *
           * 有的 provider 撞窗**不报错**，静默丢弃超出部分并照常返回
           * （实测 deepseek-v4-flash：发出约 200 万 token，自报收到 1,000,086，
           * 而窗口正好 1,000,000，全程没有任何错误）。这种 provider 上靠错误分类
           * 拿不到恢复凭证，而会话已经在无声地丢历史——比撞窗报错更坏，
           * 那至少还有个终态。
           *
           * 判据从**两个真值**反推：provider 自报的输入量顶到了模型自带的窗口。
           * 没有阈值可调，也不需要——顶到窗口就是顶到了。
           *
           * 处理是**放开压缩闸**而不是作废这一轮：回答已经拿到了，作废没有意义；
           * 把进展判据清零，下一次发送前检查就会重新折一次。
           */
          if (total >= adapter.spec.contextWindow) {
            process.stderr.write(
              `[qy] provider 静默截断：自报输入 ${total} 顶到窗口 ${adapter.spec.contextWindow}` +
                NEWLINE,
            )
            compactedAt = -1
          } else {
            // 装得下了。此后再撞窗是新情况，恢复通道重新可用。
            overflowRecovered = false
          }
        }

        if (refusalNote) {
          stopReason = 'provider_error'
          yield {
            type: 'run.error',
            runId: input.runId,
            code: 'provider_unavailable',
            message: refusalNote,
          }
          break
        }

        if (!calls.length) {
          // `pause_turn` 不是「说完了」，是「服务端把这一轮切开了，原样再发一次继续」。
          // 当成结束的表现是：用户拿到一个**半截**回答，而 run 显示成功完成、
          // 既不报错也不续写。本轮 assistant 输出已经在上面进了 transcript，
          // 直接进下一步就是官方要的那个「原样重发」。maxSteps 兜住反复暂停的情形。
          if (providerStop === 'pause_turn') continue

          /*
           * **provider 声明要调工具，而一条都没解析出来 = 故障，不是完成。**
           *
           * 这两种情况长得一样但性质相反：`end_turn` 是模型说完了，
           * `tool_use` 是它要调工具而调用在解析链上丢了（流里少了名字分片、
           * 中转站把非流式响应硬转成 SSE）。记成 `completed` 是编出来的确定性——
           * 界面上是「跑完了、零步骤」，账本里查不出原因，而这正是
           * 「说做了却没做」最难查的那种形状。
           *
           * 判据用 provider 的归一化终态，不用它的原话：原话每家一套词，
           * 拿它做判断等于每多一个端点就多一条分支。
           */
          if (providerStop === 'tool_use') {
            stopReason = 'provider_error'
            yield {
              type: 'run.error',
              runId: input.runId,
              code: 'provider_unavailable',
              message: '模型声明要调用工具，但返回里没有可解析的调用',
            }
            break
          }

          // 没有工具调用 = 模型认为任务结束。
          // 唯一例外是 provider 报 max_tokens：那是**输出**被截断，模型话没说完，
          // 不是它认为结束了。判成输入超限会把用户引向「精简上下文」，
          // 而那条路解决不了输出截断。
          stopReason = providerStop === 'max_tokens' ? 'output_truncated' : 'completed'
          break
        }

        // ── 工具执行：按波次调度 ──
        /*
         * **名字不在注册表里的，一律不进执行链。**
         *
         * 注册表是工具的唯一权威——名字不在表里的调用不是工具，它是 provider
         * 违反了下发的工具表（模型编造了一个名字）。放它进去就会开出一条
         * tool step、发一条 `tool.started`，界面上多一张既没有动作、也什么都没做的
         * 卡片，而标题只能编（「读取 xxx」或「未知工具」都是在给不存在的工具造词条）。
         *
         * 在这里挡掉之后，**下游每一条 step 都必然有 spec、必然解析得出动作**，
         * 渲染那侧不再需要任何兜底分支。
         *
         * 但结果**必须回给模型**：provider 的契约是每个 tool_call 都要有一条
         * 对应 id 的 tool 结果，少一条下一轮直接 400。所以照常推一条失败结果，
         * 它自己会改用真实存在的工具。
         */
        const bogus = calls.filter((c) => !registry.has(c.name))
        for (const c of bogus) {
          transcript.push({
            role: 'tool',
            toolCallId: c.id,
            content: JSON.stringify({
              call_id: c.id,
              tool: c.name,
              status: 'failure',
              executed: false,
              summary: `没有这个工具：${c.name}。只能调用工具表里列出的那些。`,
            }),
            _group: 'executionRecords',
          })
        }

        const waves = planWaves(
          calls.filter((c) => registry.has(c.name)),
          this.deps.registry,
        )

        for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
          const wave = waves[waveIndex]!
          // 批级投递预算按波次清零。限单次没有上界——一波五个 read_file
          // 各自都在 1/8 以内，加起来就是 5/8，而「压缩只留一个入口」的前提
          // 正是两次检查之间的跳变有上界。
          resetBatchBudget(ctx.state)
          const results = await Promise.all(
            wave.map(async ({ call, callIndex }) => {
              // 非空断言成立：上面已经把不在注册表里的调用整段挡掉了，
              // 走到这里的每一条都有 spec。
              const action = resolveAction(registry.get(call.name)!, call.arguments, ctx)
              const stepId = persist.openToolStep(
                input.runId,
                nextSeq(),
                call,
                batchId,
                callIndex,
                waveIndex,
                action,
              )
              return { call, callIndex, stepId, action }
            }),
          )

          // 先把「开始了」全部广播出去，UI 才能同时点亮同一波的多个工具卡。
          for (const r of results) {
            yield {
              type: 'tool.started',
              runId: input.runId,
              stepId: r.stepId as never,
              toolCallId: r.call.id,
              toolName: r.call.name,
              batchId,
              callIndex: r.callIndex,
              waveIndex,
              args: r.call.arguments,
              action: r.action,
            }
          }

          /*
           * 与停止赛跑，并且**边等边把中途输出交出去**。
           *
           * 裸 `Promise.all` 有两处问题：一个不返回的工具把整轮钉死在这里，
           * 而停止按钮只是置了个信号没人看；以及这一波跑多久，shell 的 stdout
           * 就在内存里压多久（实测 `npm test` 50.7 秒，界面全程不动）。
           * `drainUntil` 两件都管——它的返回值就是这一波的执行结果。
           */
          const settled = yield* drainUntil(
            emitQueue,
            untilAborted(
              input.signal,
              Promise.all(
                results.map(async (r) => {
                  const started = Date.now()
                  // 提交「即将执行」的时间戳必须在调用执行器之前——这是崩溃恢复的歧义边界。
                  persist.markExecuting(r.stepId)
                  const outcome = await registry.execute(
                    r.call.name,
                    r.call.arguments,
                    withStep(ctx, input.runId, r.stepId, emitQueue),
                  )
                  return { ...r, outcome, durationMs: Date.now() - started }
                }),
              ),
            ),
          )

          for (const s of settled) {
            const status = s.outcome.status === 'success' ? 'success' : 'failure'
            persist.settleTool(
              s.stepId,
              status,
              s.outcome,
              s.call.arguments,
              s.action,
              s.durationMs,
            )

            if (s.outcome.fileChanges?.length) {
              fileChanges.push(...s.outcome.fileChanges)
              yield { type: 'file.changed', runId: input.runId, changes: s.outcome.fileChanges }
            }

            yield {
              type: 'tool.finished',
              runId: input.runId,
              stepId: s.stepId as never,
              toolCallId: s.call.id,
              status,
              outcome: s.outcome,
              durationMs: s.durationMs,
            }

            // 工具结果必须原样回传给模型——这是不可改写的事实，
            // 装配层不得摘要、截断或改写措辞。
            const landed = (s.outcome.resources ?? []).map((r) => r.resourceId)
            transcript.push({
              role: 'tool',
              toolCallId: s.call.id,
              content: toolResultContent(
                JSON.stringify({
                  call_id: s.call.id,
                  tool: s.call.name,
                  status: s.outcome.status,
                  executed: s.outcome.executed,
                  summary: s.outcome.message,
                  // 落盘定位符**要单独成键**，不能只留在正文里：收纳把正文换成信封时
                  // 正文里那行 `[完整输出已保存：rs_xxx]` 一起没了，`read_resource`
                  // 就再也无从调起。
                  ...(landed.length ? { resources: landed } : {}),
                  // 图像字节不进信封，只进图像块——见 `envelopeResult`。
                  ...(envelopeResult(s.outcome.data)
                    ? { result: envelopeResult(s.outcome.data) }
                    : {}),
                }),
                s.outcome.data,
              ),
              _group: 'executionRecords',
            })

            // 进展证据：**`noProgress` 取执行器给出的事实，不猜**。
            // 报错不算证据——写了一半再抛也是错，那时副作用已经发生了。
            progress.push({
              action: actionFingerprint(s.call.name, s.call.arguments),
              cycle: cycleFingerprint(s.call.name, s.call.arguments, s.outcome),
              noProgress: !s.outcome.fileChanges?.length,
            })
          }
        }

        // 波次跑完才知道这个单元的末 step seq，整段重盖一次。
        stampUnit(unitStart)

        // 原地打转：同样的调用、同样的结果、没有副作用，连着两个周期。
        // **判在批次跑完之后**，不在下发之前——提前中断会在 transcript 里留下
        // 一条有 tool_calls 却没有 tool 结果的 assistant 消息，下一轮请求会被
        // provider 直接 400。代价是晚一轮才停，仍然远好过烧满 maxSteps。

        if (repeatsNoProgress(progress)) {
          stopReason = 'no_progress'
          break
        }

        if (step === maxSteps - 1) stopReason = 'max_steps'
      }
    } catch (err) {
      // **先看是不是用户按了停止。**
      //
      // run 的绝大部分时间挂在等 provider 事件的 await 上，中止在那里表现为底层请求
      // 被拒绝并抛出，而不是「两个事件之间」——上面三处 `signal.aborted` 检查一个都
      // 赶不上。不在这里认出来的话，一次主动停止会落成 status:'failed' + 一条红色的
      // internal_error（`ai/src/errors.ts` 把 AbortError 归到那里），
      // 而那个文件自己写着「中断不是错误：不该报红也不该重试」。
      if (input.signal.aborted) {
        yield {
          type: 'run.finished',
          runId: input.runId,
          status: 'interrupted',
          stopReason: 'user_interrupt',
          usage,
          fileChanges,
        }
        return
      }

      const pe = err instanceof ProviderError ? err : null
      stopReason = 'provider_error'
      yield {
        type: 'run.error',
        runId: input.runId,
        code: pe?.code ?? 'internal_error',
        message: pe?.message ?? (err instanceof Error ? err.message : String(err)),
      }
      yield {
        type: 'run.finished',
        runId: input.runId,
        status: 'failed',
        stopReason,
        usage,
        fileChanges,
      }
      return
    }

    yield {
      type: 'run.finished',
      runId: input.runId,
      status:
        stopReason === 'user_interrupt'
          ? 'interrupted'
          : stopReason === 'completed' || stopReason === 'max_steps'
            ? 'done'
            : 'failed',
      stopReason,
      usage,
      fileChanges,
    }
  }

  /**
   * 装配一次请求，并**同时算出这次没发出去多少原文**。
   *
   * 省略量不是事后统计出来的，是装配时**同尺两测相减**——原文一直在
   * Message/Step 里躺着（压缩是投影、不销毁数据），所以量得到。
   * 前提就是这个：一旦哪天把旧结果正文改写成占位串，原文不在任何可测处，
   * 这个数就失去依据，届时该删掉它而不是估一个。
   */
  private buildRequest(
    input: RunInput,
    transcript: WireMessage[],
    occupancyOf: (req: ChatRequest) => number,
  ): ChatRequest {
    const { adapter, registry, systemPrompt } = this.deps

    // 冻结前缀。缓存断点打在这里的末尾——它之后的所有内容都是易变的。
    const system: ChatRequest['system'] = [{ text: systemPrompt, cacheBreakpoint: true }]

    /*
     * 请求的形状是 `[tools][system] [history] [transcript] [tailNotes]`。
     *
     * **注记必须排在最后一段，这是约束不是偏好。** 缓存是前缀匹配的，而
     * 兼容协议没有显式断点（`openai-compat.ts` 文件头第 2 条），命中完全靠
     * 前缀逐字节相同。注记夹在 history 与 transcript 之间的话，跨 run 时
     * 上一轮的 transcript 折进 history，位置从「注记之后」挪到「注记之前」：
     *
     *   上一轮：S + H + Notes + T
     *   这一轮：S + H + T'    + Notes + …     ← 在 |S+H| 处分叉
     *
     * 因此**每开一个新 run，上一轮跑出来的全部工具结果必然全价重付**
     * （实测一次 grep 产出约 1.4 万 token，下一轮可命中上限因此从约 2.6 万
     * 掉到约 1.2 万）。排在最后之后，`history + transcript` 是一条跨 run
     * 只追加的稳定前缀，注记是唯一的易变尾巴。
     *
     * 代价是注记从「每 run 付一次」变成「每轮付一次」：本机实测注记 40 token
     * （技能/记忆/外部工具全空），装满 MCP 的极端约 1200–1500。两笔账相比，
     * 净值仍然强正向；而且 `load_tool` 装走一个工具、清单少一条时，
     * 旧布局下它一变整段 transcript 缓存全废，新布局下只废注记自己。
     *
     * 三段先拼完整，**再整串过一次压缩投影**。不要只投影 history：run 内涨起来的
     * 全是 transcript 里的工具结果，把它留在投影之外就等于压缩碰不到大头。
     * 尾区注记没有单元戳，投影按「无戳恒保留」原样让它过，位置无关。
     */
    const notes: WireMessage[] = []
    for (const note of this.deps.tailNotes()) {
      if (note.content.trim()) {
        notes.push({ role: 'system', content: note.content, _group: note.group })
      }
    }
    /*
     * 缓存断点之二：**history 的最后一条**（跨 run 稳定点）。
     *
     * 标在装配之前，随投影一起流下来——投影之后 history 与 transcript 之间
     * 没有任何分界标记，事后再找不出来。投影若把这条折掉，断点跟着没，
     * 退化成少一个断点，正确性无损。
     */
    const history = input.history.length
      ? [
          ...input.history.slice(0, -1),
          { ...input.history[input.history.length - 1]!, cacheBreakpoint: true },
        ]
      : input.history
    const assembledRaw: WireMessage[] = [...history, ...transcript, ...notes]
    const projected = this.compaction.project(assembledRaw)
    const messages: WireMessage[] = [...projected]

    /*
     * 被投影丢掉的那部分原文，按分组分开记：历史消息一份、工具结果一份。
     *
     * 同尺两测相减——原文一直在 Message/Step 里躺着（压缩是投影、不销毁数据），
     * 所以量得到。整条被折掉和只被换成信封在这里是同一件事：差额都算省略。
     * 面板的「省略上下文」两行就是它；只回答「被谁占的」是半张账，
     * 用户看到占用下降却不知道降在哪里。
     */
    const omitted = emptyOmitted()
    const account = (list: readonly WireMessage[], sign: 1 | -1): void => {
      for (const m of list) {
        // 无戳的（尾区注记、投影出的摘要两条）不参与——它们不是被折的原文。
        if (!m._messageId) continue
        const n = sign * estimateMessage(m, adapter.spec.density)
        if (m.role === 'tool' || m._group === 'intermediateContent')
          omitted.intermediateOriginal += n
        else omitted.historyOriginal += n
      }
    }
    account(assembledRaw, 1)
    account(projected, -1)
    omitted.historyOriginal = Math.max(0, omitted.historyOriginal)
    omitted.intermediateOriginal = Math.max(0, omitted.intermediateOriginal)
    this.lastOmitted = omitted

    /*
     * 缓存断点之三：**尾区注记之前的那条消息**（run 内稳定点）。
     *
     * run 内 `transcript` 只追加，所以「历史 + 已产生的 transcript」是一个不断
     * 变长的稳定前缀：每一步读上一步缓存的那段（0.1×）、只写新增的那点（1.25×），
     * 而不是每一步把整串 transcript 全价重付一遍。
     *
     * 找位置认 `role === 'system'`：整串消息里只有尾区注记是这个角色
     * （压缩投影出的摘要两条是 user/assistant，见 `compaction.ts` 的
     * `projectManifest`）。注记为空时它落在最后一条上，与断点之二可能重合，
     * 下面的 `>` 挡住重复标记。
     *
     * 这条只对 Anthropic 有效；兼容协议的前缀缓存由服务端自动做，不需要标记
     * （`openai-compat.ts` 从不读这个字段，上线字节一个不变）。
     */
    const noteStart = messages.findIndex((m) => m.role === 'system')
    const beforeNotes = (noteStart < 0 ? messages.length : noteStart) - 1
    if (beforeNotes >= 0 && !messages[beforeNotes]!.cacheBreakpoint) {
      messages[beforeNotes] = { ...messages[beforeNotes]!, cacheBreakpoint: true }
    }

    const assembled: ChatRequest = {
      model: adapter.spec.id,
      system,
      messages,
      tools: registry.schemas(),
      maxOutputTokens: adapter.spec.maxOutputTokens,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      signal: input.signal,
    }
    // 申报值要量过装配结果才算得出来，所以先装配、再钳位覆盖同一个字段。
    return {
      ...assembled,
      maxOutputTokens: declaredMaxOutput(adapter.spec, occupancyOf(assembled)),
    }
  }
}

/**
 * 执行波次规划。
 *
 * 默认全部串行。只有当**连续**若干个调用都声明了并行安全、且它们触碰的资源键
 * 互不相交时，才合并成一个波次。
 *
 * 「连续」这条限制很重要：模型给出的调用顺序本身携带意图（先读后写），
 * 跨越一个不安全调用去合并后面的安全调用会打乱这个顺序。
 */
function planWaves(
  calls: WireToolCall[],
  registry: ToolRegistry,
): { call: WireToolCall; callIndex: number }[][] {
  const waves: { call: WireToolCall; callIndex: number }[][] = []
  let current: { call: WireToolCall; callIndex: number }[] = []
  let currentKeys = new Set<string>()

  const flush = () => {
    if (current.length) waves.push(current)
    current = []
    currentKeys = new Set()
  }

  calls.forEach((call, callIndex) => {
    const spec = registry.get(call.name)
    const safe = spec ? isParallelSafe(spec, call.arguments) : false
    if (!safe) {
      flush()
      waves.push([{ call, callIndex }])
      return
    }
    const keys = spec?.resourceKeys?.(call.arguments) ?? []
    // 资源冲突：同一个文件不能在同一波里被两个调用碰。
    if (keys.some((k) => currentKeys.has(k))) flush()
    for (const k of keys) currentKeys.add(k)
    current.push({ call, callIndex })
  })
  flush()

  return waves
}

function mergeUsage(
  acc: RunUsage,
  turn: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number
    source: 'provider' | 'estimated'
  },
  adapter: LlmAdapter,
  turnIndex: number,
): void {
  acc.inputTokens += turn.inputTokens
  acc.outputTokens += turn.outputTokens
  acc.reasoningTokens += turn.reasoningTokens
  // null + 数字仍应是数字；null + null 保持 null（未回报）。
  if (turn.cachedTokens !== null) acc.cachedTokens = (acc.cachedTokens ?? 0) + turn.cachedTokens
  if (turn.cacheWriteTokens !== null) {
    acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + turn.cacheWriteTokens
  }
  const turnCost = computeCost(adapter.spec, turn)
  acc.cost = Math.round((acc.cost + turnCost) * 1e6) / 1e6
  acc.turns.push({
    turnIndex,
    input: turn.inputTokens,
    output: turn.outputTokens,
    cached: turn.cachedTokens,
    cacheWrite: turn.cacheWriteTokens,
    reasoning: turn.reasoningTokens,
    source: turn.source,
    usageStatus: turn.source === 'provider' ? 'ok' : 'missing',
    costUsd: turnCost,
    at: Date.now(),
  })
}

/**
 * 请求体指纹。用来在账本上认出「同一份内容发了两遍」。
 *
 * 非加密哈希是够的：它回答的是「这两行是不是同一次请求的重复」，
 * 不承担任何安全语义。用加密哈希只会让每次装配多花几毫秒。
 */
function payloadHashOf(req: ChatRequest): string {
  return Bun.hash(JSON.stringify([req.system, req.messages, req.tools])).toString(36)
}

/**
 * 请求信封的指纹：模型 + 冻结前缀 + 工具表，**不含消息**。
 *
 * 锚点的语义是「上一次真值描述的那个上下文」。两次请求之间用户可以装卸 MCP、
 * 装技能、`load_tool` 装工具、换模型——信封换了，那个真值描述的就不是这一次
 * 的上下文了，而它仍然是三处共用的那把尺（显示、压缩触发、`max_tokens` 钳位）。
 *
 * **`req.model` 必须在里面。** 系统提示词不随模型变、工具表也不随模型变，所以
 * 只哈希这两项时换模型得到的是同一个指纹，锚点存活——而那个真值是另一个
 * tokenizer 量出来的。中文密度各家差 1.8 倍（`ai/tokens.ts` 的 `TokenDensity`），
 * 拿它去判新模型的窗口就是量错了尺，而且不会有任何报错。
 *
 * **不要复用 `payloadHashOf`**：它含 messages，每轮必变，当不了信封。
 * 也不要复用 `prefix-audit` 的 `hashFrozen`：它只覆盖到最后一个缓存断点，
 * 不含工具表，而工具表正是最常变的那一半。
 */
function envelopeHashOf(req: ChatRequest): string {
  return Bun.hash(JSON.stringify([req.model, req.system, req.tools])).toString(36)
}

/**
 * 工具结果消息的**执行记录 / 工具结果**二分。
 *
 * 一条 tool 消息里装的是 `{call_id, tool, status, executed, summary, result}`：
 * 前四个是这次调用的**事实信封**，后两个是它**带回来的正文**。两者的处置完全
 * 不同——正文可以落 sink、可以在压缩时换成定位符，信封不能动。合成一个桶，
 * 面板就答不了「上下文是被工具输出占用的，还是被模型正文占用的」。
 *
 * 量法：把同一份记录**去掉正文再量一次**，两次之差就是正文。
 * tokenization 不可加，所以不能分别量两段再相加。
 *
 * **两次必须同尺，而且是 `estimateMessage` 量整条时用的那一把。** tool 角色整条走
 * JSON 档（`ai/tokens.ts` 的 `estimateMessage`），所以信封也只能走 `estimateJson`。
 * 尺不同的代价实测过：信封虚高一倍、差额从正文里扣，一条 327 次调用的会话里
 * 167 条被下面的 `Math.min` 夹成 `body = 0`，面板上读作「这次调用没带回任何正文」，
 * 而它带回了一句 summary。
 */
function splitToolResult(
  content: string,
  total: number,
  density: TokenDensity,
): { envelope: number; body: number } {
  try {
    const record = JSON.parse(content) as Record<string, unknown>
    if (typeof record !== 'object' || record === null) return { envelope: total, body: 0 }
    const { summary: _s, result: _r, ...envelope } = record
    const envelopeTokens = Math.min(total, estimateJson(JSON.stringify(envelope), density))
    return { envelope: envelopeTokens, body: total - envelopeTokens }
  } catch {
    // 不是约定的那份形状（插件自定义结果等）——整条算执行记录，不硬拆。
    return { envelope: total, body: 0 }
  }
}

/**
 * 上下文占用按组分解。桶的口径只有一份：`core` 的 `ContextGroup`。
 *
 * 这里只负责量，不负责对账——各组之和与总数的恒等由 `core` 的 `reconcileBreakdown`
 * 保证（固定类目保实测值，差额归到消息类目）。不要在这个函数里追求「加起来正好」。
 */
function breakdownOf(req: ChatRequest, density: TokenDensity): ContextBreakdown {
  const out = emptyBreakdown()
  out.systemPrompt = req.system.reduce((n, b) => n + estimateText(b.text, density), 0)

  // 工具 schema 分两桶。判据是 `mcp__` 前缀——`mcp/register.ts` 保证 MCP 工具
  // 一律带它，插件工具走 `<插件id>__` 归内置一侧。这两类的处置完全不同：
  // MCP 涨了是用户装的服务器在涨，内置涨了是内置工具表在涨。
  const mcp = req.tools.filter((t) => t.name.startsWith('mcp__'))
  const builtin = req.tools.filter((t) => !t.name.startsWith('mcp__'))
  if (mcp.length) out.mcpTools = estimateSchemas(mcp, density)
  if (builtin.length) out.systemTools = estimateSchemas(builtin, density)

  for (const m of req.messages) {
    // 整条量：正文 + tool call 参数 + 思考正文 + 协议开销。
    // 只量 `m.content` 会把 `write_file` 的整份文件正文漏掉——它在参数里。
    const n = estimateMessage(m, density)
    // 没有 `_group` 的一律归 historyMessages，不单开「其他」桶——
    // 一个永远对不上账的「其他」比归错桶更难解释。
    const group = m._group ?? 'historyMessages'
    if (m.role === 'tool') {
      // 带图的工具结果是块数组：信封那一块照旧拆成「执行记录 / 工具结果原文」，
      // 图片按固定值计进工具结果一侧。不取出文本块的话整条会落进 `_group`，
      // 面板上那两格从此对不上。
      const envelopeText =
        typeof m.content === 'string'
          ? m.content
          : (m.content.find((b) => b.type === 'text')?.text ?? '')
      const media = typeof m.content === 'string' ? 0 : n - estimateJson(envelopeText, density)
      const { envelope, body } = splitToolResult(envelopeText, n - media, density)
      out.executionRecords += envelope
      out.intermediateContent += body + media
      continue
    }
    out[group] += n
  }
  return out
}

/**
 * 工具结果的模型可见内容。
 *
 * **信封那段 JSON 一个字不改**——量账（`breakdownOf`）与收纳（`condenseMessage`）
 * 都靠解析它认路。图片作为**并列的一块**挂在它旁边，不塞进信封里。
 *
 * 图像块给的是**路径不是字节**，所以这个函数是同步的，投影那侧
 * （`runtime/transcript.ts` 的 `toolContent`）才能用同一份形状重建历史——
 * 那边有一个同步调用方（压缩的单元装配），读盘会把整条链拖成 async。
 *
 * **两侧必须逐字同形。** 不同形的话，同一次调用在本轮和下一轮长得不一样，
 * 模型会当成两件事，而这种不一致不会有任何报错。
 */
export function toolResultContent(
  envelope: string,
  data: Record<string, unknown> | undefined,
): string | ContentBlock[] {
  const images = imagesOf(data)
  if (!images.length) return envelope
  return [
    { type: 'text', text: envelope },
    ...images.map(
      (i): ContentBlock => ({
        type: 'image',
        mimeType: i.mime,
        source: { kind: 'base64', data: i.data },
      }),
    ),
  ]
}

/**
 * `outcome.data.images` 里那几张。
 *
 * **是数组不是单张**：MCP 工具一次调用能带回好几张图，取第一张就是把其余的静默丢掉。
 * `read_file` 读一个文件，给一个一元数组。
 */
function imagesOf(data: Record<string, unknown> | undefined): { data: string; mime: string }[] {
  const raw = data?.images
  if (!Array.isArray(raw)) return []
  const out: { data: string; mime: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { data: bytes, mime } = item as { data?: unknown; mime?: unknown }
    if (typeof bytes === 'string' && bytes) {
      out.push({ data: bytes, mime: typeof mime === 'string' ? mime : 'image/png' })
    }
  }
  return out
}

/**
 * 进信封的那一份 `result`。
 *
 * **必须把图像字节摘掉**：信封是一段 JSON 文本，`images` 留在里面会让同一份
 * base64 在请求体里出现两次——一次在图像块里、一次在信封的文本里，而后者对模型
 * 毫无用处（它读不懂一串 base64），只是照价计费。
 */
export function envelopeResult(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || !('images' in data)) return data
  const { images: _bytes, ...rest } = data
  return Object.keys(rest).length ? rest : undefined
}

/** 图像块进请求体的上限。10 MB 的 base64 约 13 MB，已经贴着多数 provider 的单请求上限。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * 把 path 形态的图像块换成 base64，交给适配器。
 *
 * **产副本，绝不回写。** 原地改会同时坏两件事：
 *
 * - 重试循环里 `req = { ...req, signal }` 是浅拷贝、**复用同一个 `messages` 数组**，
 *   而 `payloadHash` 在每次尝试发出**之前**就落了账。原地改之后第二次尝试会对同一份
 *   内容算出不同的哈希，而那个字段的职责是「认出同一份内容发了两遍」。
 * - `req.messages` 的元素与 `transcript` 是同一批对象，原地改等于把 base64 留在
 *   内存里常驻整个 run。
 *
 * **只处理附件那一种。** 走到这里的 path 形态**只可能来自用户附件**——工具读到的图在观察那一刻就已
 * 经是字节了（见 `ImageSource`）。附件是活引用：用户改了自己的文件，历史跟着变，那是他自己的文
 * 件，这个语义是对的。
 *
 * **读不到不是致命错。** 文件没了、超了上限、指纹对不上——三种都换成一个文本块，
 * 不抛。一张图发不出去不该让整轮起不来，而**必须让模型看见这句话**：静默丢掉时
 * 模型会把这次读取当成已完成。
 */
export async function materialize(req: ChatRequest): Promise<ChatRequest> {
  if (!req.messages.some((m) => typeof m.content !== 'string')) return req
  const messages = await Promise.all(
    req.messages.map(async (m) => {
      if (typeof m.content === 'string') return m
      const blocks = await Promise.all(m.content.map(loadBlock))
      return { ...m, content: blocks }
    }),
  )
  return { ...req, messages }
}

async function loadBlock(b: ContentBlock): Promise<ContentBlock> {
  if (b.type !== 'image' || b.source.kind !== 'path') return b
  const { path } = b.source
  const note = (why: string): ContentBlock => ({ type: 'text', text: `［图片 ${path}：${why}］` })

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return note('已不存在')
  if (info.size > MAX_IMAGE_BYTES) return note('超过 10 MB，未发送')
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return note('读取失败')
  return {
    type: 'image',
    mimeType: b.mimeType,
    source: { kind: 'base64', data: bytes.toString('base64') },
  }
}
