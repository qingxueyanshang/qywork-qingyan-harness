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

import type {
  ChatRequest,
  LlmAdapter,
  ProviderEvent,
  ProviderUsage,
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
import { emptyBreakdown, emptyOmitted, newBatchId } from '@qywork/core'
import type { CompactionOutcome } from './compaction.ts'
import { describeDrift, PrefixAudit } from './prefix-audit.ts'
import {
  actionFingerprint,
  cycleFingerprint,
  type ProgressEvidence,
  repeatsNoProgress,
} from './progress.ts'
import {
  BATCH_BUDGET_RATIO,
  isParallelSafe,
  resetBatchBudget,
  resolveAction,
  type ToolContext,
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
  makeToolContext(runId: RunId, emit: (e: AgentEvent) => void): ToolContext
  /** 每个 step 的持久化回调。事件发出前必须先落盘。 */
  persist: LoopPersistence
  /**
   * 上下文压缩。不给 = 本次执行不支持压缩，容量拒绝直接上报为 run 错误。
   * 由 runtime 装配（它才知道怎么从账本取历史、往哪写 manifest）。
   */
  compaction?: CompactionPort
  /**
   * 流空闲超时（毫秒）。不传用 `STREAM_IDLE_TIMEOUT_MS`。
   * 存在的理由只有一个：让测试能在几百毫秒内验到这条路径，
   * 而不是让回归测试等三分钟——等三分钟的测试没人会跑。
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
   * 把历史投影成实际要发的消息。未压缩时原样返回。
   * 每次构造请求都调用——压缩发生在两次请求之间，投影必须跟着变。
   */
  project(history: WireMessage[]): WireMessage[]
  /** 执行一次压缩并落库。**不抛异常**，失败以 outcome 表达。 */
  run(): Promise<CompactionOutcome>
}

export interface LoopPersistence {
  nextSeq(runId: RunId): number
  openTextStep(runId: RunId, seq: number): string
  appendText(stepId: string, delta: string): void
  openToolStep(
    runId: RunId,
    seq: number,
    call: WireToolCall,
    batchId: string,
    callIndex: number,
    waveIndex: number,
    action: ActionDescriptor,
    /**
     * 本轮的思考正文，**只在一个 batch 的第一条上给**（其余传空串）。
     *
     * 它属于整个 assistant 轮而不是某一次调用，挂在首条上是最省的编码方式。
     *
     * 坑：这段必须落库。DeepSeek 类兼容端点要求带 tool_calls 的 assistant 消息
     * 原样回传 `reasoning_content`，**否则后续轮次 400**；历史一旦从 steps 投影
     * 回去（跨轮记忆），缺这一段就是必然的 400。不额外花上下文——活的 transcript
     * 本来就在发它，落库只是让下一轮还能发。
     */
    reasoning: string,
  ): string
  markExecuting(stepId: string): void
  settleTool(
    stepId: string,
    status: 'success' | 'failure',
    outcome: ToolOutcomeWire,
    args: Record<string, unknown>,
    action: ActionDescriptor,
  ): void
  saveUsage(runId: RunId, usage: RunUsage): void
  /**
   * 压缩落一条 step。
   *
   * `steps.kind` 的 CHECK 里一直有 `'compaction'`，`StepKind`、`StepPayload`、
   * archive 渲染分支也都在——**唯独没有生产者**。前端的压缩条纯由活事件创建，
   * 刷新一次就消失，而它恰恰是解释「上下文为什么降了」的唯一线索。
   * 这是 C1 第 1 款的标准死链：协议有、界面认、没人往里写。
   */
  recordCompaction(
    runId: RunId,
    seq: number,
    status: 'success' | 'failure',
    payload: { manifestRevision: number; compactedMessages: number },
  ): void
  /**
   * 逐请求账。**装配完成、发出之前**记一行，返回 id 供后续回填。
   *
   * **不能写成挂在 run 上的三个标量**（tokens / limit / percent）：那样每个 step
   * 覆盖一次，一个 run 有 N 次请求而账只剩最后一次的读数，
   * 「这一轮上下文怎么长起来的」在账本里根本不存在。
   */
  openRequest(input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    model: string
    measuredInputTokens: number
    measurementExact: boolean
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
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
   * 没有它的话，每个 run 的第一次请求只能报本地估算（系统性偏低），
   * 第二次请求起才切到真值——用户看到的就是每轮开头掉一次、然后弹回去。
   * 那正是「上下文跳了好几次」里跨轮的那一半。
   *
   * `throughMessageId`：这个回执覆盖到哪条消息为止。它之后的历史消息是
   * 锚点没算过的，要另外估。
   */
  anchor?: { tokens: number; throughMessageId: string | null }
}

const DEFAULT_MAX_STEPS = 120

/**
 * 流空闲超时。**两个事件之间**超过这个时长没有新事件就判定流卡死。
 *
 * 这条之前完全不存在：`stream_idle_timeout` 在 ErrorCode 里躺着，全项目没有生产者——
 * 是「协议里有类型 ≠ 有实现」的第七条，也是唯一一条**靠事件不出现**才能发现的。
 * 后果实测撞到过——provider 侧抖了一下，run 就那么挂着，既不出错也不结束，
 * 用户看到的是一个永远转圈的界面，日志里也没有任何线索。
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
 * 会原样重发一次的失败。
 *
 * **只有传输层。** 429 与 5xx 的 `retryable` 也是 true，但那两类 provider 明确答复过
 * ——我们知道请求到了，立刻重发就是在无退避地捶它，而 429 的正确动作是等。
 * 传输层不一样：连接坏了，我们连「它收没收到」都不知道，原样再发一次是唯一的答案。
 */
const RESENDABLE: ReadonlySet<string> = new Set(['network_error', 'stream_idle_timeout'])

/**
 * 传输失败的现场读数。
 *
 * 分类短语（「连接被断开」「请求超时」「模型响应中断」）由 `ai/src/errors.ts` 与
 * `openStream` 给，它们都拿不到这两个数；而这两个数才是「是网络断了还是还在等」的答案
 * ——**一个字节都没收到过**说明请求根本没落地，**收到过又停了**说明是传输被掐。
 *
 * 所以这句只在这里拼，**全项目只有这一个拼装处**。
 */
function transportReading(providerEvents: number, silentMs: number, chars: number): string {
  const secs = Math.round(silentMs / 1000)
  if (providerEvents === 0) return `发出后 ${secs} 秒内没有收到任何数据`
  return `最后一次收到数据在 ${secs} 秒前，本次共收到 ${chars} 字`
}

/**
 * 压缩的软阈值：占用超过它就在**发出之前**压一次。
 *
 * 三段相减，每一段都有理由：
 *
 * - **减 `maxOutputTokens`**：那块空间是这一轮的输出要用的，provider 会按
 *   `输入 + max_output > 窗口` 直接拒。不减它，检查放行的请求照样会被拒。
 * - **减一个批级投递预算**：两次检查之间最多再进一个执行波次的结果，
 *   而那一波的上界正是 `BATCH_BUDGET_RATIO`。不留这块余量，跳变就会跨过阈值——
 *   而「只留一个触发入口」的全部前提就是跳变有上界。
 *
 * 所以这个阈值不是拍的百分比，是「还能安全装下多少」的算术结果。
 */
function softLimit(spec: { contextWindow: number; maxOutputTokens: number }): number {
  return Math.max(
    0,
    spec.contextWindow - spec.maxOutputTokens - Math.floor(spec.contextWindow * BATCH_BUDGET_RATIO),
  )
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

  constructor(private readonly deps: LoopDeps) {}

  /**
   * 给整条流套上空闲计时器，并**把第一个事件先拉出来**。
   *
   * 先拉一次是为了把「压根没发出去」和「发出去了没回」分开：装配阶段抛出的错
   * （`buildBody` 拼请求体失败）在这里就浮出来，账本行还没被标成 sent。
   *
   * **不要以为这一拉就把网络错误拿到了。** 三个适配器都在发请求之前先 yield
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
    const it = adapter.stream(req)[Symbol.asyncIterator]()

    /** 等一个事件，超时就判流卡死并中止本次请求。 */
    const step = async (): Promise<IteratorResult<ProviderEvent>> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 先中止底层请求再拒绝：不然连接会一直挂着，
          // 而它占着的正是我们判定为「已经没救了」的那条流。
          onStall()
          reject(
            new ProviderError({
              code: 'stream_idle_timeout',
              // 只给分类短语，不带数字。「收到了多少 / 多久没动静」由 `run()` 统一补
              // （`transportReading`）——两处各拼一半的话，同一句话就有了两个作者。
              message: '模型响应中断',
              retryable: true,
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

    /*
     * 上下文读数的**唯一一把尺**：最后一次 provider 真值 + 仅对其后新增内容的估算。
     *
     * 坑：不要写成 `max(全量估算, 真值)`。两个数出自两把尺，锚点一失效显示值就从
     * 真值尺跌到系统性偏低的估算尺，会话内容一个字没变而数字掉三成（实测 33%→20%）。
     *
     * `uncovered` 是锚点之后新增的历史消息（本轮的新用户消息）。锚点覆盖到
     * 上一轮为止，不减掉这一块就会漏算。
     */
    let anchor: { tokens: number; uncovered: number; transcriptIndex: number } | null = input.anchor
      ? {
          tokens: input.anchor.tokens,
          uncovered: estimateMessages(
            input.history.filter(
              (m) =>
                !input.anchor?.throughMessageId ||
                !m._messageId ||
                m._messageId > input.anchor.throughMessageId,
            ),
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
              estimateMessages(transcript.slice(anchor.transcriptIndex)),
            source: 'actual',
          }
        : { tokens: fallback, source: 'estimated' }

    let stopReason: StopReason = 'completed'
    /** 进展证据，按调用顺序累积。判「原地打转」用，见 progress.ts。 */
    const progress: ProgressEvidence[] = []
    let turnIndex = 0

    // `run.finished` 上这两个字段一直写死 0。协议里有、渲染层认得、值是假的，
    // 比没有更坏——所以要么填真，要么删字段；这里填真。
    const startedAt = Date.now()
    let stepsRun = 0

    // ToolContext 必须**整个 run 只建一个**。工具往 ctx.state 里回写的东西
    // （files 插件记录的「哪些文件本轮读过」、目录大小缓存等）要跨调用可见；
    // 每波新建一个 = 状态永远是空的，写入守卫会把模型刚读过的文件判成没读过，
    // 模型随后会绕道用 shell 手写文件。这条已经实测踩中过一次。
    const emitBuffer: AgentEvent[] = []
    const ctx = this.deps.makeToolContext(input.runId, (e) => emitBuffer.push(e))

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (input.signal.aborted) {
          stopReason = 'user_interrupt'
          break
        }
        stepsRun++

        const batchId = newBatchId()

        let textStepId: string | null = null
        let assistantText = ''
        let thinkingText = ''
        const calls: WireToolCall[] = []
        let providerStop: string = 'end_turn'
        let refusalNote: string | null = null
        /** 本次请求 provider 回报的 usage。null = 它没报——不要拿累计值代替。 */
        let turnUsage: ProviderUsage | null = null

        /*
         * ── 压缩触发：**只有这一个入口** ──
         *
         * 发送前按占用检查。容量拒绝那条路保留，但**不触发压缩**——它只如实报错。
         * 两个触发就是两个执行入口，A2 第五问过不去。
         *
         * 不写成「先发、被 provider 拒了再压、然后重发」：那个形状每次触发都要先
         * 烧掉一次注定失败的长请求，长 prompt 上是几秒到几十秒外加计费。占用取的是
         * 锚定尺（provider 真值 + 仅一轮尾巴的估算），误差被限制在单轮增量内，
         * 够做发送前判断。
         *
         * 代价说清楚：估算失误时不再自动救回，直接报错。可接受——报错是诚实的，
         * 而单次/单批投递预算（`RESULT_BUDGET_RATIO` / `BATCH_BUDGET_RATIO`）
         * 给了跳变上界，不存在无预警的跃迁。
         */
        // `signal` 不在这里合成：每次尝试要自己的 `attemptAbort`（卡死检测掐的是
        // 那一次连接），所以装配只出请求体，信号在尝试循环里逐次接上。
        let req = this.buildRequest(input, transcript)

        if (this.deps.compaction) {
          const occupancy = anchor ? meter(0).tokens : estimateRequest(req)
          if (occupancy > softLimit(adapter.spec)) {
            process.stderr.write(
              `[qy] 发送前检查触发压缩：占用约 ${occupancy}，软阈值 ${softLimit(adapter.spec)}
`,
            )
            yield { type: 'compaction', runId: input.runId, phase: 'started' }
            const outcome = await this.deps.compaction.run()
            if (outcome.status === 'compacted') {
              persist.recordCompaction(input.runId, persist.nextSeq(input.runId), 'success', {
                manifestRevision: outcome.manifest.revision,
                compactedMessages: outcome.manifest.compactedMessageCount,
              })
              yield {
                type: 'compaction',
                runId: input.runId,
                phase: 'done',
                manifest: outcome.manifest,
              }
              // 压缩改的是投影，必须重新装配——拿旧请求发出去等于这次压缩白花。
              req = this.buildRequest(input, transcript)
            } else {
              // 压不动不是致命错：照常发出去，让 provider 来判。
              persist.recordCompaction(input.runId, persist.nextSeq(input.runId), 'failure', {
                manifestRevision: 0,
                compactedMessages: 0,
              })
              yield {
                type: 'compaction',
                runId: input.runId,
                phase: 'failed',
                reasonCode: outcome.reasonCode,
              }
            }
          }
        }

        const breakdown = breakdownOf(req)

        // 前缀漂移只报不拦：拦了等于让一个计费问题变成一个功能故障。
        // 但必须**说出来**——缓存失效本身是完全静默的，不报就永远没人知道。
        const drift = this.audit.observe(input.cacheKey ?? input.runId, req.system)
        if (drift)
          process.stderr.write(`[qy] ${describeDrift(drift)}
`)

        /*
         * ── 发送与消费：一次尝试，断了原样再来一次 ──
         *
         * **重发的窗口只有一个：provider 一个事件都没回来。** 重发是重新生成，
         * 模型不会接着上次那半截往下写；已经吐过字再重发，界面上就得表达
         * 「刚才那段作废」，而 `superseded` 是 run 级语义（靠一条新 run 行接替旧的），
         * 轮内重发没有第二条 run 行可挂。零输出时重发完全无痕，这是唯一不需要
         * 新显示语义的窗口。
         *
         * `request_prepared` 不算 provider 事件——三个适配器都在发请求**之前**
         * 先 yield 它（见各 `stream()` 首行），所以「只收到过它」就等于
         * 「一个字节都没回来」。网络失败因此**全部落在下面这个 `for await` 里**，
         * 不在 `openStream` 里。
         */
        let requestId = ''
        let attempt = 0
        for (;;) {
          // 每次尝试自己的中止器：卡死检测掐的是**这一次**连接，
          // 复用上一次那个等于新连接一开就已经是 aborted。
          const attemptAbort = new AbortController()
          req = { ...req, signal: AbortSignal.any([input.signal, attemptAbort.signal]) }

          // 账本行在**发出之前**落。这一刻我们已经知道要发什么（分组、指纹都算得出），
          // 但还不知道 provider 会不会收——两件事分开记，「发出去了没回」
          // 和「压根没发出去」在账本上才可区分。
          requestId = persist.openRequest({
            runId: input.runId,
            turnIndex: step,
            // 同一轮的第 N 次发送。`uq_provider_run_turn` 靠它区分，
            // 重发因此不会顶掉上一次那行——两次都真实发生过，账要分开记。
            retryIndex: attempt,
            model: adapter.spec.id,
            measuredInputTokens: estimateRequest(req),
            measurementExact: false,
            sentCategories: breakdown,
            omittedCategories: this.lastOmitted,
            payloadHash: payloadHashOf(req),
          })

          /**
           * 最后一次收到事件的时刻。**起点是「发出」而不是 0**——一个事件都没收到时，
           * 它与此刻的差正好是「发出去之后干等了多久」，不需要另记一个发送时刻。
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
                    breakdown: breakdown ?? emptyBreakdown(),
                    omitted: this.lastOmitted,
                  }
                  break
                }
                case 'thinking_delta': {
                  thinkingText += ev.delta
                  // delta 只做实时状态；整段思考在开这一批的首条工具步时随 reasoning 落库。
                  yield {
                    type: 'thinking.delta',
                    runId: input.runId,
                    delta: ev.delta,
                    redacted: false,
                  }
                  break
                }
                case 'text_delta': {
                  if (textStepId === null) {
                    textStepId = persist.openTextStep(input.runId, persist.nextSeq(input.runId))
                  }
                  assistantText += ev.delta
                  persist.appendText(textStepId, ev.delta)
                  yield {
                    type: 'text.delta',
                    runId: input.runId,
                    stepId: textStepId as never,
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
             * 我们不知道它收没收到、计没计费，只能记 `uncertain`。
             * 原来按 `code === 'stream_idle_timeout'` 判，于是一次「压根没连上」
             * 被记成「provider 拒了」——那是编出来的确定性。
             */
            persist.settleRequest(
              requestId,
              pe?.status !== undefined ? 'rejected' : 'uncertain',
              null,
              code,
            )

            // 用户按了停止：不重发，也不改写正文，交给外层认成中断。
            if (input.signal.aborted) throw err
            // 其余非传输失败（4xx、容量拒绝）原样上抛：provider 已经说清是什么了，
            // 补读数、重发都无从谈起。
            if (!pe || !RESENDABLE.has(code)) throw err

            const silentMs = Date.now() - lastEventAt
            /*
             * 原始错误形状只写日志。
             *
             * `errno` 与英文原文对排查是全部，对界面是噪音——归类之后那句中文说的是
             * 「哪一类」，说不出「是哪个码」。少了这行，账本里只剩中文，
             * 回头分不出 `ECONNRESET`（对端重置）和我们自己那 60 秒掐的。
             *
             * 取的是 `cause` 而不是 `err`：走到这里 `err` 已经是归类后的
             * `ProviderError`，它的 `code` 是 `network_error` 这种分类码，
             * 真正的 errno 挂在被它包住的那个原始错误上。
             */
            const raw = (err as { cause?: unknown }).cause
            process.stderr.write(
              `[qy] 传输失败 turn=${step} retry=${attempt} code=${code} errno=${String(
                (raw as { code?: unknown })?.code ?? '-',
              )} events=${providerEvents} silent=${Math.round(silentMs / 1000)}s | ${
                raw instanceof Error ? raw.message : pe.message
              }\n`,
            )

            if (attempt === 0 && providerEvents === 0) {
              attempt++
              continue
            }

            // 分类短语 + 现场读数 + 有没有替他试过，一行说完。
            throw new ProviderError({
              code: pe.code,
              message: [
                pe.message,
                transportReading(
                  providerEvents,
                  silentMs,
                  thinkingText.length + assistantText.length,
                ),
                ...(attempt > 0 ? ['已自动重发一次，仍然中断'] : []),
              ].join('，'),
              retryable: pe.retryable,
              provider: pe.provider,
              cause: err,
            })
          }
        }

        turnIndex++

        // 流跑完了就给这一行落终态。中途被用户打断算 `uncertain`——
        // provider 那边收没收全我们不知道，而这正是 `uncertain` 存在的意义。
        persist.settleRequest(
          requestId,
          input.signal.aborted ? 'uncertain' : 'received',
          turnUsage,
          null,
        )

        if (input.signal.aborted) {
          stopReason = 'user_interrupt'
          break
        }

        // 把本轮 assistant 输出写回 transcript：模型下一轮必须看到自己刚说过什么、
        // 调了哪些工具，否则会重复调用。
        if (assistantText || calls.length) {
          transcript.push({
            role: 'assistant',
            content: assistantText,
            ...(calls.length ? { toolCalls: calls } : {}),
            // DeepSeek 类兼容端点要求带 tool_calls 的 assistant 消息原样回传思考内容。
            ...(thinkingText && calls.length ? { reasoningContent: thinkingText } : {}),
            _group: 'executionRecords',
          })
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
            anchor = { tokens: total, uncovered: 0, transcriptIndex: transcript.length }
        }

        if (refusalNote) {
          stopReason = 'provider_error'
          yield {
            type: 'run.error',
            runId: input.runId,
            code: 'provider_unavailable',
            message: refusalNote,
            retryable: false,
          }
          break
        }

        if (!calls.length) {
          // `pause_turn` 不是「说完了」，是「服务端把这一轮切开了，原样再发一次继续」。
          // 当成结束的表现是：用户拿到一个**半截**回答，而 run 显示成功完成、
          // 既不报错也不续写。本轮 assistant 输出已经在上面进了 transcript，
          // 直接进下一步就是官方要的那个「原样重发」。maxSteps 兜住反复暂停的情形。
          if (providerStop === 'pause_turn') continue

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
         * 注册表是工具的唯一权威——名字不在表里的东西不是工具，它是 provider
         * 违反了我们下发的工具表（模型胡诌了一个名字）。放它进去就会开出一条
         * tool step、发一条 `tool.started`，界面上多一张既没有动作、也什么都没做的
         * 卡片，而标题只能编（「读取 xxx」或「未知工具」都是在给不存在的东西造词条）。
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
        let denied = false

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
                persist.nextSeq(input.runId),
                call,
                batchId,
                callIndex,
                waveIndex,
                action,
                // 整个 batch 的思考只落一份，挂在首条上。
                callIndex === 0 ? thinkingText : '',
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

          const settled = await Promise.all(
            results.map(async (r) => {
              const started = Date.now()
              // 提交「即将执行」的时间戳必须在调用执行器之前——这是崩溃恢复的歧义边界。
              persist.markExecuting(r.stepId)
              const outcome = await registry.execute(r.call.name, r.call.arguments, ctx)
              return { ...r, outcome, durationMs: Date.now() - started }
            }),
          )

          // 排空本波的中途输出（shell stdout 等），下一波复用同一个缓冲区。
          while (emitBuffer.length) yield emitBuffer.shift()!

          for (const s of settled) {
            const status = s.outcome.status === 'success' ? 'success' : 'failure'
            persist.settleTool(s.stepId, status, s.outcome, s.call.arguments, s.action)

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
            // 装配层不得摘要、截断或"美化"。
            transcript.push({
              role: 'tool',
              toolCallId: s.call.id,
              content: JSON.stringify({
                call_id: s.call.id,
                tool: s.call.name,
                status: s.outcome.status,
                executed: s.outcome.executed,
                summary: s.outcome.message,
                ...(s.outcome.data ? { result: s.outcome.data } : {}),
              }),
              _group: 'executionRecords',
            })

            if (s.outcome.errorKind === 'permission_denied') denied = true

            // 进展证据：**`noProgress` 取执行器给出的事实，不猜**。
            // 报错不算证据——写了一半再抛也是错，那时副作用已经发生了。
            progress.push({
              action: actionFingerprint(s.call.name, s.call.arguments),
              cycle: cycleFingerprint(s.call.name, s.call.arguments, s.outcome),
              noProgress: !s.outcome.fileChanges?.length,
            })
          }
        }

        if (denied) {
          // 用户拒了授权：不要装作无事发生继续跑，也不要重试。
          stopReason = 'permission_denied'
          break
        }

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
          stepCount: stepsRun,
          durationMs: Date.now() - startedAt,
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
        retryable: pe?.retryable ?? false,
      }
      yield {
        type: 'run.finished',
        runId: input.runId,
        status: 'failed',
        stopReason,
        usage,
        stepCount: stepsRun,
        durationMs: Date.now() - startedAt,
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
      stepCount: stepsRun,
      durationMs: Date.now() - startedAt,
      fileChanges,
    }
  }

  /**
   * 装配一次请求，并**同时算出这次没发出去多少原文**。
   *
   * 省略量不是事后统计出来的，是装配时**同尺两测相减**——原文一直在
   * Message/Step 里躺着（压缩是投影、不销毁数据），所以量得到。
   * 前提就是这个：一旦哪天把旧结果正文改写成占位串，原文不在任何可测处，
   * 这个数就只能瞎报，届时该删掉它而不是估一个。
   */
  private buildRequest(input: RunInput, transcript: WireMessage[]): ChatRequest {
    const { adapter, registry, systemPrompt } = this.deps

    // 冻结前缀。缓存断点打在这里的末尾——它之后的所有内容都是易变的。
    const system: ChatRequest['system'] = [{ text: systemPrompt, cacheBreakpoint: true }]

    // 历史先过压缩投影：压缩发生在两次请求之间，每次构造都要重新投影，
    // 拿旧投影会把刚压掉的内容又发一遍——那次压缩就白花了。
    const projected = this.deps.compaction
      ? this.deps.compaction.project(input.history)
      : input.history
    const messages: WireMessage[] = [...projected]

    /*
     * 缓存断点之二：**投影后历史的末尾**。
     *
     * 位置是被布局逼出来的。请求的形状是
     * `[tools][system] [history] [tailNotes] [transcript]`：
     *
     * - `history` 跨轮**只追加不改写**（新一轮的历史是上一轮的前缀），
     *   所以这里是跨请求逐字节稳定的最远点——断点打在这儿，
     *   上一轮缓存的那段这一轮直接命中。
     * - `tailNotes` 里有日期和按当轮查询召回的记忆，**跨轮必变**。
     *   断点打在它之后，每轮都会整体失配，等于没打。
     *
     * 在此之前 qywork 只有一个断点、打在系统提示词末尾，所以缓存住的只有
     * 工具 schema + 系统提示词（约 1.8k）——**消息历史每一轮都在全价重付**。
     * 这条只对 Anthropic 有效；兼容协议的前缀缓存由服务端自动做，不需要标记
     * （`openai-compat.ts` 从不读这个字段，上线字节一个不变）。
     */
    const lastHistory = messages.length - 1
    if (lastHistory >= 0) {
      messages[lastHistory] = { ...messages[lastHistory]!, cacheBreakpoint: true }
    }

    // 被投影丢掉的那部分原文，按分组分开记：历史消息一份、工具结果一份。
    // 面板的「省略上下文」两行就是它——只回答「被谁占的」是半张账，
    // 用户看到占用下降却不知道降在哪里。
    const kept = new Set(projected)
    this.lastOmitted = emptyOmitted()
    for (const m of input.history) {
      if (kept.has(m)) continue
      const n = estimateMessage(m)
      if (m.role === 'tool' || m._group === 'intermediateContent') {
        this.lastOmitted.intermediateOriginal += n
      } else {
        this.lastOmitted.historyOriginal += n
      }
    }

    // 尾区注记：日期、技能索引、工作区状态。放在 transcript **之前**但在冻结前缀
    // **之后**，这样它们变化时不会冲掉前缀缓存，同时又足够靠近生成位置。
    for (const note of this.deps.tailNotes()) {
      if (note.content.trim()) {
        messages.push({ role: 'system', content: note.content, _group: note.group })
      }
    }

    messages.push(...transcript)

    /*
     * 缓存断点之三：**整串消息的末尾**。
     *
     * 一个 run 内 `tailNotes` 逐字节不变（日期不跨天、记忆每 run 只选一次、
     * 技能索引每轮只刷一次），而 `transcript` 只追加。所以 run 内
     * 「历史 + 尾区 + 已产生的 transcript」是一个不断变长的稳定前缀：
     * 每一步读上一步缓存的那段（0.1×）、只写新增的那点（1.25×），
     * 而不是每一步把整串 transcript 全价重付一遍。
     *
     * 跨 run 它必然失配（尾区变了），那时退回断点之二，历史那段照样命中。
     */
    const lastMessage = messages.length - 1
    if (lastMessage > lastHistory) {
      messages[lastMessage] = { ...messages[lastMessage]!, cacheBreakpoint: true }
    }

    return {
      model: adapter.spec.id,
      system,
      messages,
      tools: registry.schemas(),
      maxOutputTokens: adapter.spec.maxOutputTokens,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      signal: input.signal,
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
 * 工具结果消息的**执行记录 / 工具结果**二分。
 *
 * 一条 tool 消息里装的是 `{call_id, tool, status, executed, summary, result}`：
 * 前四个是这次调用的**事实信封**，后两个是它**带回来的正文**。两者的处置完全
 * 不同——正文可以落 sink、可以在压缩时换成定位符，信封不能动。合成一个桶，
 * 面板就答不了「上下文是被工具输出吃掉的，还是被模型自己的话吃掉的」。
 *
 * 量法：把同一份记录**去掉正文再量一次**，两次之差就是正文。
 * tokenization 不可加，所以不能分别量两段再相加。
 */
function splitToolResult(content: string, total: number): { envelope: number; body: number } {
  try {
    const record = JSON.parse(content) as Record<string, unknown>
    if (typeof record !== 'object' || record === null) return { envelope: total, body: 0 }
    const { summary: _s, result: _r, ...envelope } = record
    const envelopeTokens = Math.min(total, estimateJson(envelope))
    return { envelope: envelopeTokens, body: total - envelopeTokens }
  } catch {
    // 不是我们那份形状（插件自定义结果等）——整条算执行记录，不硬拆。
    return { envelope: total, body: 0 }
  }
}

/**
 * 上下文占用按组分解。桶的口径只有一份：`core` 的 `ContextGroup`。
 *
 * 这里只负责量，不负责对账——各组之和与总数的恒等由 `context-meter.ts` 保证
 * （固定类目保实测值，差额归到消息类目）。不要在这个函数里追求「加起来正好」。
 */
function breakdownOf(req: ChatRequest): ContextBreakdown {
  const out = emptyBreakdown()
  out.systemPrompt = req.system.reduce((n, b) => n + estimateText(b.text), 0)

  // 工具 schema 分两桶。判据是 `mcp__` 前缀——`mcp/register.ts` 保证 MCP 工具
  // 一律带它，插件工具走 `<插件id>__` 归内置一侧。这两类的处置完全不同：
  // MCP 涨了是用户自己装的服务器在涨，内置涨了是我们自己的事。
  const mcp = req.tools.filter((t) => t.name.startsWith('mcp__'))
  const builtin = req.tools.filter((t) => !t.name.startsWith('mcp__'))
  if (mcp.length) out.mcpTools = estimateSchemas(mcp)
  if (builtin.length) out.systemTools = estimateSchemas(builtin)

  for (const m of req.messages) {
    // 整条量：正文 + tool call 参数 + 思考正文 + 协议开销。
    // 只量 `m.content` 会把 `write_file` 的整份文件正文漏掉——它在参数里。
    const n = estimateMessage(m)
    // 没有 `_group` 的一律归 historyMessages，不单开「其他」桶——
    // 一个永远对不上账的「其他」比归错桶更难解释。
    const group = m._group ?? 'historyMessages'
    if (m.role === 'tool' && typeof m.content === 'string') {
      const { envelope, body } = splitToolResult(m.content, n)
      out.executionRecords += envelope
      out.intermediateContent += body
      continue
    }
    out[group] += n
  }
  return out
}
