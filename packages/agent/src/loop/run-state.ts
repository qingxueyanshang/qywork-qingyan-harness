/**
 * 一次 run 的可变状态与一轮请求的可变状态。
 *
 * `AgentLoop.run` 的各阶段（跟进注入、发送前压缩、发送与重发、收尾、工具波次）读写同一份
 * 状态。不要在阶段函数中另存副本：副本与此处的值不一致后，读数、锚点与停机判定会各自依据不同的状态。
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
import { estimateMessages, estimateRequest, videoBlocksOf } from '@qywork/ai'
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

/** 相同轮次第二次出现时交给模型的事实，文本陈述的是第三次即停止的规则。 */
const REPEAT_NOTICE = '工具调用与结果已连续两轮重复，未取得进展；连续三轮重复时本次运行停止。'

/** 各阶段从 `AgentLoop` 取用的能力。由 `AgentLoop` 构造，每个实例一份。 */
export interface LoopHost {
  readonly deps: LoopDeps
  readonly compaction: CompactionPort
  /** 可被中止信号提前结束的退避等待。 */
  backoff(ms: number, signal: AbortSignal): Promise<void>
  summaryTrace(
    run: RunState,
    turnIndex: number,
  ): SummaryTrace & { opened: boolean; merged: boolean }
  openStream(req: ChatRequest): Promise<AsyncIterable<ProviderEvent>>
  buildRequest(run: RunState): ChatRequest
  /** 最近一次 `buildRequest` 算出的省略量。 */
  lastOmitted(): ContextOmitted
}

/** 上下文读数的锚点，含义见 `RunState.anchor`。 */
export interface ContextAnchor {
  tokens: number
  uncovered: number
  /** `uncovered` 范围内的视频段数。估算对视频记 0，因此它们不计入 `uncovered`。 */
  uncoveredVideos: number
  transcriptIndex: number
  /** 产生该真值的请求所用的模型。与本轮不同时整个锚点作废。 */
  model: string
  /** 该请求的信封占用。信封变化时据此替换头部。 */
  headTokens: number
  /** 产生该真值的请求的信封指纹。 */
  envelope: string | null
}

export class RunState {
  readonly input: RunInput
  readonly adapter: LlmAdapter
  readonly registry: ToolRegistry
  readonly persist: LoopPersistence
  /** 本轮的估算密度。读数、压缩触发、申报钳位三处共用。 */
  readonly density: TokenDensity
  readonly usage: RunUsage
  readonly fileChanges: FileChange[] = []
  /** transcript = 本 run 内新产生的对话，与传入的 history 拼接后发给模型。 */
  readonly transcript: WireMessage[] = []

  /** 本 run 已分配的最大 step seq。单元戳取此值，见 `stampUnit`。 */
  private lastSeq = 0

  /*
   * 上下文读数的唯一锚点：最后一次 provider 真值 + 锚点后的本地结构增量。
   *
   * 易错点：不要写成 `max(全量估算, 真值)`。两个数值的计量方式不同，锚点一旦失效，显示值即从
   * provider 真值降为系统性偏低的本地估算，会话内容未变而数值下降三成（实测 33%→20%）。
   *
   * `uncovered` 是锚点之后新增的历史消息（本轮的新用户消息）。锚点只覆盖到
   * 上一轮，不计入这部分就会漏算。
   */
  anchor: ContextAnchor | null

  // 无限循环没有自然结束的分支。默认值按失败闭合处理，所有合法出口都必须显式设置终态；
  // 若误加一条裸 `break`，也不会把未完成的 run 报告为 completed。
  stopReason: StopReason = 'internal_guard'
  /** 停机的具体依据，随 run.finished 发出。 */
  stopDetail: string | undefined
  /**
   * 溢出恢复是否已使用。这是状态标记，不是重试计数。
   *
   * 计数常量需要确定重试次数，而此处第二次没有意义：超出窗口后压缩一次
   * 是有效的，压缩后仍超出说明压缩已无法继续缩减，再压缩一次的输入与上一次逐字相同。
   * 收到一次带用量回执的成功响应即复位：说明请求已能容纳，此后再次超出属于新情况。
   */
  overflowRecovered = false
  /**
   * 上次尝试压缩时的 transcript 长度高水位。这是进展判据，不是次数限制。
   *
   * run 内 `input.history` 不变，新的可折叠单元只可能来自 transcript 追加，
   * 因此是否有新单元可压缩等价于 transcript 是否变长。
   * 不判断进展时，占用一旦超过软阈值，每一步都会再压缩一次；
   * 限定为每个 run 只压缩一次时，run 内新增的数十批工具结果无法被压缩。
   */
  compactedAt = -1
  /** 进展证据，按调用顺序累积，用于判定重复无进展，见 progress.ts。 */
  readonly progress: ProgressEvidence[] = []
  /**
   * 请求账的轮次编号（`uq_provider_run_turn` 的第二段）。主循环每轮推进一次，
   * 压缩的摘要请求占用编号时由压缩阶段另行推进。
   */
  requestTurn = 0
  /** 用量账的轮次编号，见 `mergeUsage`。 */
  turnIndex = 0
  /**
   * 带上下文继续发送时转入下一轮的重发次数。正文已显示的请求中断后，下一次请求是新的一轮
   * （transcript 增加了模型的上一条消息），重发次数必须随之转入：不转入时，每次中断后继续发送
   * 都重新计数，重发没有上限。正常结束的一轮将其清零。
   */
  carriedResends = 0

  // 每个 run 只创建一个 ToolContext。工具写入 ctx.state 的状态
  // （files 插件记录的本轮已读文件、目录大小缓存等）必须跨调用可见；
  // 每批新建时状态始终为空，写入守卫会把模型刚读过的文件判定为未读，
  // 模型随后会改用 shell 直接写文件。
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
      // 币种由模型决定；一个 run 只使用一个模型，因此整轮使用同一币种。
      currency: deps.adapter.spec.pricing.currency ?? 'USD',
      turns: [],
    }
    const uncovered = input.anchor
      ? input.history.filter(
          (m) =>
            !input.anchor?.throughMessageId ||
            !m._messageId ||
            m._messageId > input.anchor.throughMessageId,
        )
      : []
    this.anchor = input.anchor
      ? {
          envelope: input.anchor.envelopeFingerprint,
          model: input.anchor.model,
          headTokens: input.anchor.headTokens,
          tokens: input.anchor.tokens,
          uncovered: estimateMessages(uncovered, deps.adapter.spec.density),
          uncoveredVideos: videoBlocksOf(uncovered),
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
   * 为 transcript 末尾从 `from` 起的消息写入单元戳。
   *
   * 一个执行波次（assistant 消息及其全部 tool 结果）共用一个戳，压缩因此
   * 只能在戳之间划分边界，tool_call 与 tool_result 始终同时保留或同时移除。
   * 戳的取值规则必须与 `runtime/transcript.ts` 投影历史时的规则逐字一致：
   * 取单元中最后一个 step 的 seq。
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
   * 本轮的占用读数，触发判定与申报钳位共用此值。
   *
   * 两处分别计算会得到两个口径：可能同时出现阈值检查判定未超限、而申报按已超限计算，
   * 两个结论都会写入请求。
   */
  occupancyOf(req: ChatRequest): number {
    return this.anchor ? this.meter(0).tokens : estimateRequest(req, this.density)
  }

  /**
   * 读数中未计入的视频段数：估算对视频记 0，只有接口回报的真值包含视频。
   * 锚点之前的视频已计入真值；锚点之后新增的视频尚未计入。
   */
  unmeasuredVideos(req: ChatRequest): number {
    const anchor = this.anchor
    return anchor
      ? anchor.uncoveredVideos + videoBlocksOf(this.transcript.slice(anchor.transcriptIndex))
      : videoBlocksOf(req.messages)
  }

  /** 无进展判据：重复满三次即停止；满两次时先将重复的事实交给模型。 */
  stalled(): boolean {
    if (repeatsNoProgress(this.progress)) return true
    if (repeatsNoProgress(this.progress, MAX_CYCLE_WIDTH, 2)) this.notify(REPEAT_NOTICE)
    return false
  }

  /**
   * 交给模型的执行事实（待办未完成、重复告警、流中断后继续）：写入一条不显示的用户 step，
   * 并追加到 transcript 末尾，此后每次请求都在原位置携带它。
   *
   * 不要改为只附在下一次请求末尾：此后的请求不含它时，前缀与产生该轮响应时不同，
   * provider 据此作废该轮之后的思考块，缓存也从该位置失效。
   *
   * 单元戳由本方法写入，方式与 run 内注入的用户消息相同；投影侧（`runtime/transcript.ts`）按载荷中的
   * `notice` 还原为同一条消息。
   */
  notify(text: string): void {
    const seq = this.nextSeq()
    this.persist.landUserStep(this.input.runId, seq, { text, notice: true })
    this.transcript.push({
      role: 'user',
      content: text,
      _group: 'workspaceState',
      _step: stepStamp(this.input.runId, seq),
      ...(this.input.userMessageId ? { _messageId: this.input.userMessageId } : {}),
    })
  }

  /*
   * 信封变化时只替换头部，不作废整个锚点。
   *
   * 锚点表示上一次 provider 真值所描述的上下文。安装或卸载 MCP、安装技能、
   * 经 `load_tool` 加载工具，改变的只有冻结前缀与工具表；消息部分未变，
   * 这部分真值仍然有效。整体作废会使显示、压缩触发、`max_tokens` 钳位三处改用
   * 本地估算，而未收录模型上的本地估算实测偏高 1.4 倍：真实占用
   * 54.5% 的会话显示为 80.0%，距软阈值只差 56 token。
   *
   * 换模型时只能作废：tokenizer 不同，替换头部也无法修正。
   *
   * 修正引入的是头部部分的系数误差（数个百分点），而不是整份请求的误差（约 25%）。
   *
   * 在此处判定，而不是在读取锚点处判定：两处分别计算会产生两份指纹。
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

/** 一轮请求（含轮内重发）的可变状态，每轮新建。 */
export class TurnState {
  /**
   * 本次尝试的请求账行 id，同时作为本次生成的批次 id：正文、思考与工具行
   * 都记录该值，投影据此识别同一次响应产出的条目。
   *
   * 另行生成批次 id 会使批次与请求成为两套独立记录，而生成边界正是由产出它的请求定义的。
   * 重发时请求账新增一行，批次随之更换。
   */
  requestId = ''

  /**
   * 当前正在写入的 step，随通道切换开启与关闭，不在整轮内固定。
   *
   * 一次调用中模型可以先思考、再输出正文、再思考。整轮固定时这三段会被合并为
   * 一条思考与一条正文，`seq` 无法表达真实顺序：
   * 实时显示的顺序与刷新后按 seq 重放的顺序不一致。
   *
   * 端点若逐 chunk 交替两个通道，此处就逐 chunk 开启新 step。
   * 不要为此添加防抖：防抖相当于为顺序另建一份记录，而顺序的真源只能有一份。
   */
  open = null as { kind: 'text' | 'thinking'; id: string } | null
  /**
   * 本次尝试开启的思考 step。自动重发时这些 step 必须写为失败终态：它们记录的是被丢弃的
   * 生成。每次尝试开始时清空，只有重发分支读取它。
   */
  attemptThinking: StepId[] = []
  assistantText = ''
  /**
   * 正文通道开头收到、尚未写入的空白字符。正文 step 只在第一个含可见字符的
   * 增量到达时开启：模型消息常以一个只含空格的 `text_delta` 开头，为它开启的 step
   * 落盘后是一条零高度的空正文条目，在会话列中形成一道空隙，并把本应合并的工具组分开。
   * 暂存的空白随首个可见增量一并写入，缩进类前导空白不会丢失；通道切换到思考时清空。
   */
  pendingText = ''
  thinkingText = ''
  responseReasoning: ResponseReasoning | undefined
  readonly calls: WireToolCall[] = []
  providerStop: string = 'end_turn'
  /** provider 返回的原始终止原因，只写入账本，不参与判断。 */
  rawStop = ''
  refusalNote: string | null = null
  /** 本次请求 provider 回报的 usage。null 表示未回报，不要用累计值代替。 */
  turnUsage: ProviderUsage | null = null
  /** 本轮可折叠单元在 transcript 中的起点。由收尾阶段设置，工具结果随后追加在其后。 */
  unitStart = 0

  constructor(
    private readonly run: RunState,
    public req: ChatRequest,
    /*
     * 分组明细，必须在信封判定之前计算：头部修正需要本轮的头部占用，而本次信封的内容
     * 只有在装配完成后才能确定。`req` 每次重新装配时都必须重新计算。
     */
    public breakdown: ContextBreakdown,
  ) {}

  /** 取得应写入的 step；通道变化时先关闭旧 step、再开启新 step。延迟开启，不产生空 step。 */
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
 * 使 await 能被中止信号提前结束。
 *
 * abort 只设置信号，等待方不检查信号时等待不会结束。provider 一侧的等待受传输层的
 * 字节空闲上限约束，工具与压缩两侧没有该约束：
 * 其中任何一方不返回，整轮就阻塞在该 await 上，停止按钮无响应：
 * 不报错、加载状态持续、日志无输出，只能重启应用。
 *
 * 返回之后，被放弃的工作仍在后台执行，这是有意设计：`ctx.signal` 已经 abort，响应信号的
 * 工具会自行结束；不能结束的，由会话结束时将其 step 写为「执行期间被中断，结果未知」，
 * 该表述与崩溃恢复对同类情形的处理一致，不另设一套。
 *
 * 不要改为 abort 之后仍等待工作执行完毕再退出：这会使停止的时限由停滞的一方决定。
 */
export function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new DOMException('已中断', 'AbortError'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    // 必须附加 then 处理器：被放弃的 Promise 若稍后抛错，没有处理器会产生
    // unhandledRejection，导致整个进程退出。
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', fail))
  })
}

/** 单纯的等待，不响应中止信号；需要可停止时用 `untilAborted` 包装。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
