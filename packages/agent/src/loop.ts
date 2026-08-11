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
  CapacityRejection,
  ChatRequest,
  LlmAdapter,
  ProviderEvent,
  WireMessage,
  WireToolCall,
} from '@qywork/ai'
import { computeCost, ProviderError } from '@qywork/ai'
import type {
  ActionDescriptor,
  AgentEvent,
  FileChange,
  RunId,
  RunUsage,
  StopReason,
  ToolOutcomeWire,
} from '@qywork/core'
import { newBatchId } from '@qywork/core'
import type { CompactionOutcome } from './compaction.ts'
import { describeDrift, PrefixAudit } from './prefix-audit.ts'
import { isParallelSafe, resolveAction, type ToolContext, type ToolRegistry } from './registry.ts'

export interface LoopDeps {
  adapter: LlmAdapter
  registry: ToolRegistry
  /** 三层冻结前缀，已拼好。 */
  systemPrompt: string
  /** 尾区注记：日期、技能索引、工作区状态。随时变化，不进前缀。 */
  tailNotes: () => string[]
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
  saveContext(runId: RunId, tokens: number, limit: number, percent: number): void
}

export interface RunInput {
  runId: RunId
  history: WireMessage[]
  effort?: ChatRequest['effort']
  maxSteps?: number
  cacheKey?: string
  signal: AbortSignal
}

const DEFAULT_MAX_STEPS = 120

/**
 * 一次请求最多压缩几次。
 *
 * 压缩后仍然超限说明压不动了——比如单条用户消息本身就超过窗口，或者工具 schema
 * 加冻结前缀已经吃满。继续循环就是每轮烧一次摘要调用的无限循环。
 * 2 次的依据：第一次压历史，第二次压上一次压完后新增的部分；再多没有新东西可压。
 */
const MAX_COMPACTION_ATTEMPTS = 2

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
 * 「本地测得的输入远低于窗口」里的**远**。
 *
 * 本地估算是 4 字符 ≈ 1 token 的粗估，对中文会**低估**——纯中文大约
 * 1～1.5 token/字，粗估可能只报到实际的 1/4 甚至 1/6。所以倍率必须留足余量：
 * 20 倍意味着即使低估了 6 倍，仍然有 3 倍以上的空档才会触发否决。
 *
 * 实测撞到过的那次是 1963 / 1,000,000 —— 500 倍，离阈值远得很。
 */
const IMPLAUSIBLE_CAPACITY_RATIO = 20

/**
 * 否决一个明显不成立的容量拒绝信号。
 *
 * ## 这不违背「拒绝驱动」
 *
 * 拒绝驱动说的是**不要用本地估算去触发压缩**——那会在根本不需要的时候损失信息。
 * 这里做的是反方向的事：用一个**量级差**去**否掉**一个信号。
 * 触发仍然只认 provider 亲口说的话，本地数字没有资格让压缩发生，
 * 只有资格在差了 20 倍以上时说一句「这条大概不是真的」。
 *
 * ## 三个条件必须同时满足，缺一不否
 *
 * 1. **判据来自文案匹配而非 provider 原生错误码**。`provider_code` 是端点
 *    自己说的「context_length_exceeded」，那没什么可怀疑的；`provider_message`
 *    是我们从一句话里认出来的，认错的可能性真实存在。
 * 2. **provider 没有自报任何数字**。它要是说了「用了 213000，上限 200000」，
 *    那就是一次带证据的拒绝，本地估算没资格推翻它。
 * 3. **本地测得的输入比窗口小 20 倍以上**。
 *
 * 否掉之后**不吞错误**，原样抛出去。我们只是拒绝为它烧一次摘要调用——
 * 「这条拒绝可疑」和「这次请求成功了」是两回事。
 */
function implausibleCapacity(
  capacity: CapacityRejection,
  measuredInputTokens: number,
  contextWindow: number,
): string | null {
  if (capacity.matchSource !== 'provider_message') return null
  if (capacity.reportedInputTokens !== null || capacity.reportedLimitTokens !== null) return null
  if (contextWindow <= 0 || measuredInputTokens <= 0) return null
  if (measuredInputTokens * IMPLAUSIBLE_CAPACITY_RATIO >= contextWindow) return null
  return `本地测得输入约 ${measuredInputTokens} token，模型窗口 ${contextWindow.toLocaleString()} token，相差 ${Math.round(
    contextWindow / measuredInputTokens,
  )} 倍`
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

  constructor(private readonly deps: LoopDeps) {}

  /**
   * 打开流并**把第一个事件拉出来**。
   *
   * adapter.stream() 是异步生成器，请求要到第一次 next() 才真正发出——
   * 直接返回可迭代对象的话，4xx 会在 `for await` 里抛，那时已经出了压缩重试的作用域。
   * 所以这里先拉一次，让容量拒绝在能被处理的地方浮出来，再把拉出来的那个事件补回流首。
   */
  private async openStream(
    adapter: LlmAdapter,
    req: ChatRequest,
    onStall: () => void,
  ): Promise<AsyncIterable<ProviderEvent>> {
    const provider = adapter.spec.provider
    const idleMs = this.deps.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
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
              message: `模型响应中断：${Math.round(idleMs / 1000)} 秒没有收到任何数据`,
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
      costUsd: 0,
      turns: [],
    }
    const fileChanges: FileChange[] = []
    // transcript = 本 run 内新产生的对话，与传入的 history 拼接后发给模型。
    const transcript: WireMessage[] = []

    let stopReason: StopReason = 'completed'
    let turnIndex = 0

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

        const batchId = newBatchId()

        let textStepId: string | null = null
        let assistantText = ''
        let thinkingText = ''
        const calls: WireToolCall[] = []
        let providerStop: string = 'end_turn'
        let refusalNote: string | null = null

        // ── 拒绝驱动的压缩：先发，被拒了再压 ──
        //
        // 不用阈值触发。本地 token 估算永远不准（各家 tokenizer 不同、工具 schema
        // 与缓存前缀的计法也各异），按估算提前压缩会在**根本不需要压缩的时候**损失信息。
        // 等 provider 亲口说「超了」，判据才是确定的。
        //
        // 这里的重试次数必须有上限：压缩后仍然超限说明压不动了（比如单条消息本身
        // 就超过窗口），继续循环就是无限烧钱。
        let stream: AsyncIterable<ProviderEvent>
        for (let attempt = 0; ; attempt++) {
          // 每次尝试一个独立的中止句柄，链到 run 的 signal 上。
          // 空闲超时只掐**这一次**请求，不能把整个 run 的 signal 也 abort 掉——
          // 那样重试和后续步骤会一起死掉。
          const attemptAbort = new AbortController()
          const signal = AbortSignal.any([input.signal, attemptAbort.signal])
          const req = { ...this.buildRequest(input, transcript), signal }

          // 前缀漂移只报不拦：拦了等于让一个计费问题变成一个功能故障。
          // 但必须**说出来**——缓存失效本身是完全静默的，不报就永远没人知道。
          const drift = this.audit.observe(input.cacheKey ?? input.runId, req.system)
          if (drift)
            process.stderr.write(`[qy] ${describeDrift(drift)}
`)
          try {
            stream = await this.openStream(adapter, req, () => attemptAbort.abort())
            break
          } catch (err) {
            const capacity = err instanceof ProviderError ? err.capacity : undefined
            if (!capacity || !this.deps.compaction || attempt >= MAX_COMPACTION_ATTEMPTS) throw err

            // 明显不成立的容量信号：否掉它，别为它烧一次摘要调用。
            // `measure` 失败不能连累主路径——探测失败时按「测不出来」处理，照常压缩。
            const measured = await adapter.measure(req).catch(() => 0)
            const implausible = implausibleCapacity(capacity, measured, adapter.spec.contextWindow)
            if (implausible) {
              process.stderr.write(
                `[qy] 容量拒绝存疑，已跳过压缩：${implausible}；判据来自文案匹配且 provider 未自报数字。原始错误：${
                  (err as Error).message
                }\n`,
              )
              throw err
            }

            // 把触发压缩的那条 provider 错误打到 stderr。
            //
            // 压缩是**拒绝驱动**的，所以「为什么会压缩」等价于「provider 说了什么」。
            // 事件里只有 phase，没有原因——真出现误判（在一个 1M 窗口的模型上
            // 因为两千 token 就触发压缩）时，没有这一行就完全无从查起。
            // 实测撞到过一次，当时唯一的线索就是「有两条 compaction 事件」。
            process.stderr.write(
              `[qy] 容量拒绝触发压缩（第 ${attempt + 1} 次）：status=${
                (err as ProviderError).status ?? '?'
              } ${(err as Error).message}
`,
            )
            yield { type: 'compaction', runId: input.runId, phase: 'started' }
            const outcome = await this.deps.compaction.run()
            if (outcome.status === 'compacted') {
              yield {
                type: 'compaction',
                runId: input.runId,
                phase: 'done',
                manifest: outcome.manifest,
              }
            } else {
              // 压不动就把原始的容量错误抛出去。**不要吞掉它换成压缩失败**——
              // 用户要知道的是「上下文超了」，压缩失败只是没能自动解决而已。
              yield {
                type: 'compaction',
                runId: input.runId,
                phase: 'failed',
                reasonCode: outcome.reasonCode,
              }
              throw err
            }
          }
        }

        for await (const ev of stream) {
          if (input.signal.aborted) break

          switch (ev.type) {
            case 'request_prepared': {
              const limit = adapter.spec.contextWindow
              const pct = limit ? Math.round((ev.measuredInputTokens / limit) * 100) : 0
              persist.saveContext(input.runId, ev.measuredInputTokens, limit, pct)
              yield {
                type: 'context',
                runId: input.runId,
                tokens: ev.measuredInputTokens,
                limit,
                percent: pct,
                breakdown: {
                  systemPrompt: 0,
                  toolSchemas: 0,
                  skills: 0,
                  historyMessages: 0,
                  executionRecords: 0,
                  summary: 0,
                  workspaceState: 0,
                },
              }
              break
            }
            case 'thinking_delta': {
              thinkingText += ev.delta
              // 思考只做实时状态，不落库回放——与 Python 版口径一致。
              yield { type: 'thinking.delta', runId: input.runId, delta: ev.delta, redacted: false }
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

        turnIndex++

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
          // 没有工具调用 = 模型认为任务结束。
          // 唯一例外是 provider 报 max_tokens：那是**输出**被截断，模型话没说完，
          // 不是它认为结束了。曾经这里判成 context_exhausted（输入超限），
          // 会把用户引向「精简上下文」——那条路解决不了输出截断。
          stopReason = providerStop === 'max_tokens' ? 'output_truncated' : 'completed'
          if (assistantText && textStepId) {
            yield {
              type: 'message.committed',
              runId: input.runId,
              messageId: '' as never,
              stepId: textStepId as never,
              content: assistantText,
            }
          }
          break
        }

        // ── 工具执行：按波次调度 ──
        const waves = planWaves(calls, this.deps.registry)
        let denied = false

        for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
          const wave = waves[waveIndex]!
          const results = await Promise.all(
            wave.map(async ({ call, callIndex }) => {
              const spec = registry.get(call.name)
              const action = spec
                ? resolveAction(spec, call.arguments)
                : { kind: 'read' as const, objectLabel: call.name, target: null }
              const stepId = persist.openToolStep(
                input.runId,
                persist.nextSeq(input.runId),
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
          }
        }

        if (denied) {
          // 用户拒了授权：不要装作无事发生继续跑，也不要重试。
          stopReason = 'permission_denied'
          break
        }

        if (step === maxSteps - 1) stopReason = 'max_steps'
      }
    } catch (err) {
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
        stepCount: 0,
        durationMs: 0,
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
      stepCount: 0,
      durationMs: 0,
      fileChanges,
    }
  }

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

    // 尾区注记：日期、技能索引、工作区状态。放在 transcript **之前**但在冻结前缀
    // **之后**，这样它们变化时不会冲掉前缀缓存，同时又足够靠近生成位置。
    for (const note of this.deps.tailNotes()) {
      if (note.trim()) {
        messages.push({ role: 'system', content: note, _group: 'workspaceState' })
      }
    }

    messages.push(...transcript)

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
  acc.costUsd = Math.round((acc.costUsd + turnCost) * 1e6) / 1e6
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
