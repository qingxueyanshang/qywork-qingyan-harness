/**
 * 一次 run 的可变状态与一轮请求的可变状态。
 *
 * `AgentLoop.run` 的各阶段（跟进注入、发送前压缩、发送与重发、收尾、工具波次）读写同一份
 * 状态。不要在阶段函数里另存副本：副本与这里的值分叉后，读数、锚点与停机判定各记一本账。
 */

import type {
  ChatRequest,
  LlmAdapter,
  ProviderEvent,
  ProviderUsage,
  TokenDensity,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import { estimateMessages, estimateRequest } from '@qywork/ai'
import type {
  ContextBreakdown,
  ContextOmitted,
  FileChange,
  ResponseReasoning,
  RunUsage,
  StepId,
  StopReason,
} from '@qywork/core'
import { envelopeHeadTokens } from '@qywork/core'
import { type SummaryTrace, stepStamp } from '../compaction.ts'
import { EventQueue } from '../event-queue.ts'
import { MAX_CYCLE_WIDTH, type ProgressEvidence, repeatsNoProgress } from '../progress.ts'
import type { ToolContextBase, ToolRegistry } from '../registry.ts'
import { envelopeHashOf } from './request.ts'
import type { CompactionPort, LoopDeps, LoopPersistence, RunInput } from './types.ts'

/** 第二次出现相同的轮次时交给模型的事实。第三次就停，这句话说的就是这条规则。 */
const REPEAT_NOTICE = '工具调用、参数与结果已连续两轮相同；连续三轮相同时本次运行停止。'

/** 各阶段从 `AgentLoop` 取用的能力。由 `AgentLoop` 构造，一个实例一份。 */
export interface LoopHost {
  readonly deps: LoopDeps
  readonly compaction: CompactionPort
  /** 可被中止信号提前结束的退避等待。 */
  backoff(ms: number, signal: AbortSignal): Promise<void>
  summaryTrace(
    run: RunState,
    turnIndex: number,
  ): SummaryTrace & { opened: boolean; merged: boolean }
  openStream(req: ChatRequest, requestId: string): Promise<AsyncIterable<ProviderEvent>>
  buildRequest(run: RunState, notice: string | null): ChatRequest
  /** 最近一次 `buildRequest` 算出的省略量。 */
  lastOmitted(): ContextOmitted
}

/** 上下文读数的锚点，含义见 `RunState.anchor`。 */
export interface ContextAnchor {
  tokens: number
  uncovered: number
  transcriptIndex: number
  /** 产生这个真值的那次请求用的模型。与本轮不同就整条作废。 */
  model: string
  /** 那次请求的信封占用。信封一换按它换头部。 */
  headTokens: number
  /** 产生这个真值的那次请求的信封指纹。 */
  envelope: string | null
}

export class RunState {
  readonly input: RunInput
  readonly adapter: LlmAdapter
  readonly registry: ToolRegistry
  readonly persist: LoopPersistence
  /** 这一轮那把尺。三个消费者（读数、压缩触发、申报钳位）共用它。 */
  readonly density: TokenDensity
  readonly usage: RunUsage
  readonly fileChanges: FileChange[] = []
  /** transcript = 本 run 内新产生的对话，与传入的 history 拼接后发给模型。 */
  readonly transcript: WireMessage[] = []

  /** 本 run 已分配到的最大 step seq。单元戳取它，见 `stampUnit`。 */
  private lastSeq = 0

  /*
   * 上下文读数的**唯一锚点**：最后一次 provider 真值 + 锚点后的本地结构增量。
   *
   * 坑：不要写成 `max(全量估算, 真值)`。两个数出自两把尺，锚点一失效显示值就从
   * 真值尺跌到系统性偏低的估算尺，会话内容一个字没变而数字掉三成（实测 33%→20%）。
   *
   * `uncovered` 是锚点之后新增的历史消息（本轮的新用户消息）。锚点覆盖到
   * 上一轮为止，不减掉这一块就会漏算。
   */
  anchor: ContextAnchor | null

  // 无限循环没有自然耗尽这一支。默认失败闭合，所有合法出口都必须在现场覆盖；
  // 将来若误加一条裸 `break`，也不会把半成品假报成 completed。
  stopReason: StopReason = 'internal_guard'
  /** 停机的具体依据，随 run.finished 交出去。 */
  stopDetail: string | undefined
  /**
   * 溢出恢复用过没有。**状态机，不是重试计数。**
   *
   * 计数常量要回答「几次算够」，而这里没有第二次的意义：撞窗之后压一次
   * 是有效的，压完还撞说明压缩已经压不动了，再压一次的输入与上一次逐字相同。
   * 收到一次带回执的成功响应即复位——那说明请求已经装得下，此后再撞是新情况。
   */
  overflowRecovered = false
  /**
   * 上次尝试压缩时的 transcript 高水位。**进展判据，不是次数闸。**
   *
   * run 内 `input.history` 不变，新的可折单元只可能来自 transcript 追加，
   * 因此「是否有新单元可压缩」等价于「transcript 是否变长」。
   * 不判进展的话，占用一旦越过软阈值就是每一步再压一次；
   * 判成「一个 run 只压一次」的话，run 内涨出来的那几十波工具结果永远压不掉。
   */
  compactedAt = -1
  /** 进展证据，按调用顺序累积。判「原地打转」用，见 progress.ts。 */
  readonly progress: ProgressEvidence[] = []
  /**
   * 交给下一次请求的事实，一次性。**不落账本、不进界面**：它是给模型的输入，
   * 不是会话内容。装配时以 user 消息附在末尾（见 `buildRequest`）。
   */
  readonly notices: string[] = []
  /**
   * 请求账的轮次编号（`uq_provider_run_turn` 的第二段）。主循环每轮推进一次，
   * 压缩的摘要请求占用编号时由压缩阶段另行推进。
   */
  requestTurn = 0
  /** 用量账的轮次编号，见 `mergeUsage`。 */
  turnIndex = 0
  /**
   * 带上下文续发时交给下一轮的重发次数。正文已显示的请求断开后，下一次请求是新的一轮
   * （transcript 多了模型的上一条），额度必须跟过去：不跟，断一次续一次就没有上限。
   * 正常收尾的一轮清零。
   */
  carriedResends = 0

  // ToolContext 必须**整个 run 只建一个**。工具往 ctx.state 里回写的状态
  // （files 插件记录的「哪些文件本轮读过」、目录大小缓存等）要跨调用可见；
  // 每波新建一个 = 状态永远是空的，写入守卫会把模型刚读过的文件判成没读过，
  // 模型随后会绕道用 shell 手写文件。
  readonly emitQueue = new EventQueue()
  readonly ctx: ToolContextBase

  constructor(deps: LoopDeps, input: RunInput) {
    this.input = input
    this.adapter = deps.adapter
    this.registry = deps.registry
    this.persist = deps.persist
    this.density = deps.adapter.spec.density
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 0,
      cost: 0,
      // 币种跟着模型走，一个 run 只用一个模型，所以整轮同一个币种。
      currency: deps.adapter.spec.pricing.currency ?? 'USD',
      turns: [],
    }
    this.anchor = input.anchor
      ? {
          envelope: input.anchor.envelopeFingerprint,
          model: input.anchor.model,
          headTokens: input.anchor.headTokens,
          tokens: input.anchor.tokens,
          uncovered: estimateMessages(
            input.history.filter(
              (m) =>
                !input.anchor?.throughMessageId ||
                !m._messageId ||
                m._messageId > input.anchor.throughMessageId,
            ),
            deps.adapter.spec.density,
          ),
          transcriptIndex: 0,
        }
      : null
    this.ctx = deps.makeToolContext(input.runId, (e) => this.emitQueue.push(e))
  }

  nextSeq(): number {
    this.lastSeq = this.persist.nextSeq(this.input.runId)
    return this.lastSeq
  }

  /**
   * 给 transcript 尾部这一段盖上单元戳。
   *
   * 一个执行波次（assistant 消息 + 它的全部 tool 结果）共用一个戳，压缩因此
   * 只能在戳之间切界，**tool_call 与 tool_result 永远同进同出**。
   * 戳的口径必须与 `runtime/transcript.ts` 投影历史时那一份逐字相同：
   * 取单元里最后一个 step 的 seq。
   */
  stampUnit(from: number): void {
    const stamp = stepStamp(this.input.runId, this.lastSeq)
    for (let i = from; i < this.transcript.length; i++) {
      this.transcript[i] = {
        ...this.transcript[i]!,
        _step: stamp,
        ...(this.input.userMessageId ? { _messageId: this.input.userMessageId } : {}),
      }
    }
  }

  meter(fallback: number): { tokens: number; source: 'actual' | 'projected' | 'estimated' } {
    const anchor = this.anchor
    return anchor
      ? {
          tokens:
            anchor.tokens +
            anchor.uncovered +
            estimateMessages(this.transcript.slice(anchor.transcriptIndex), this.density),
          source:
            anchor.uncovered > 0 || this.transcript.length > anchor.transcriptIndex
              ? 'projected'
              : 'actual',
        }
      : { tokens: fallback, source: 'estimated' }
  }

  /**
   * 这一轮的占用读数。**触发判定与申报钳位共用它。**
   *
   * 两处各量一次就是两把尺：会出现「检查说没超阈值」和「申报按已经超了算」
   * 同时成立，而这两个结论都会被写进请求。
   */
  occupancyOf(req: ChatRequest): number {
    return this.anchor ? this.meter(0).tokens : estimateRequest(req, this.density)
  }

  /** 空转判据：满三次就停；满两次先把「你在重复」当事实交给下一次请求。 */
  stalled(): boolean {
    if (repeatsNoProgress(this.progress)) return true
    if (repeatsNoProgress(this.progress, MAX_CYCLE_WIDTH, 2)) this.notices.push(REPEAT_NOTICE)
    return false
  }

  /*
   * **信封换了一份时只换头部，不作废整条锚点。**
   *
   * 锚点是「上一次 provider 真值描述的那个上下文」。装卸一个 MCP、装个技能、
   * `load_tool` 装一个工具，换掉的只有冻结前缀与工具表——消息侧一个字没变，
   * 那一大段真值仍然成立。整条作废会让裸估算尺接管显示、压缩触发、
   * `max_tokens` 钳位三处，而未收录模型上那把尺实测高 1.4 倍：一条真实占用
   * 54.5% 的会话读作 80.0%，距软阈值只差 56 token。
   *
   * 换模型是另一回事，只能作废：tokenizer 不同，头部换掉也修不回来。
   *
   * 修正引入的是**头部这一段**的系数误差（几个百分点），而不是整份请求的
   * （二成半）。
   *
   * 判在这里而不是取锚点的地方：两处各算一遍就是两份指纹。
   */
  rebaseAnchor(req: ChatRequest, breakdown: ContextBreakdown): void {
    const envelope = envelopeHashOf(req)
    const anchor = this.anchor
    if (anchor?.envelope && anchor.envelope !== envelope) {
      if (anchor.model !== req.model) {
        this.anchor = null
      } else {
        const head = envelopeHeadTokens(breakdown)
        this.anchor = {
          ...anchor,
          tokens: Math.max(0, anchor.tokens - anchor.headTokens + head),
          headTokens: head,
          envelope,
        }
      }
    }
  }
}

/** 一轮请求（含轮内的重发）的可变状态。每轮新建一个。 */
export class TurnState {
  /**
   * 本次尝试的请求账行 id。**它同时是这次生成的批次 id**：正文、思考与工具行
   * 都落这一个值，投影据此认出「这几条是同一次响应产出的」。
   *
   * 另起一个自生成的批次 id 会让批次与请求成为两本账，而生成边界正是靠
   * 「哪一次请求产出的」定义的。重发换一行账，批次跟着换。
   */
  requestId = ''

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
  open = null as { kind: 'text' | 'thinking'; id: string } | null
  /**
   * 本次尝试开过的思考 step。自动重发时这批要落成失败终态——它们装的是被丢弃
   * 的那次生成。**每次尝试开头清空**，读它的只有重发那条分支。
   */
  attemptThinking: StepId[] = []
  assistantText = ''
  /**
   * 正文通道开头收到、尚未落任何可见字符的空白。正文 step 只在第一个含可见字符的
   * 增量到达时才开：模型消息常以一个只含空格的 `text_delta` 起头，为它开出的 step
   * 落盘后是一条零高度的空正文条目，在会话列里占一道缝，还把本该合并的工具组切开。
   * 攒下的空白随首个可见增量一并写入，缩进类前导空白不丢；通道切到思考时清空。
   */
  pendingText = ''
  thinkingText = ''
  responseReasoning: ResponseReasoning | undefined
  readonly calls: WireToolCall[] = []
  providerStop: string = 'end_turn'
  /** provider 的原话，只进账本不参与判断。 */
  rawStop = ''
  refusalNote: string | null = null
  /** 本次请求 provider 回报的 usage。null = 它没报——不要拿累计值代替。 */
  turnUsage: ProviderUsage | null = null
  /** 本轮这个可折单元在 transcript 里的起点。由收尾阶段置，工具结果随后追加到它后面。 */
  unitStart = 0

  constructor(
    private readonly run: RunState,
    /** 只交给这一轮请求的事实（见 `RunState.notices`），压缩后重建请求时沿用同一份。 */
    readonly turnNotice: string | null,
    public req: ChatRequest,
    /*
     * 分组明细。**在信封判定之前算**——头部修正要用本轮的头部占用，而只有
     * 装配完才知道这一次的信封长什么样。`req` 每次重新装配都要跟着重算。
     */
    public breakdown: ContextBreakdown,
  ) {}

  /** 拿到该写的 step；通道换了就先封上旧的、开一条新的。**懒开**，不产生空 step。 */
  stepFor(kind: 'text' | 'thinking'): string {
    if (this.open?.kind !== kind) {
      const { persist, input } = this.run
      const id =
        kind === 'text'
          ? persist.openTextStep(input.runId, this.run.nextSeq(), this.requestId)
          : persist.openThinkingStep(input.runId, this.run.nextSeq(), this.requestId)
      if (kind === 'thinking') this.attemptThinking.push(id as StepId)
      this.open = { kind, id }
    }
    return this.open.id
  }
}

/**
 * 让一个 await 能被中止信号提前结束。
 *
 * **abort 只是置一个信号，等的人不看它就等于没停。** provider 那侧的等待有传输层的
 * 字节空闲上限兜着，工具与压缩这两侧没有：
 * 其中任何一个不返回，整轮就停在那个 await 上：停止按钮**无响应**——
 * 不报错、转圈不停、日志无输出，只能重启应用。
 *
 * 返回之后那批工作仍在后台执行。这是有意的：`ctx.signal` 已经 abort，守规矩的
 * 工具自己收手；收不了的由会话收尾时把它们的 step 落成「执行期间被中断，结果未知」
 * ——那正是崩溃恢复给这种情形定的说法，不是新造一套。
 *
 * 不要改成「abort 之后还等它跑完再退」：那等于把停止的时限交给卡住的那一方决定。
 */
export function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
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
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
