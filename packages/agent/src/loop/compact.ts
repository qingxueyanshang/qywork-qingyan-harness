/**
 * run 内压缩的三个调用点：发送前按占用触发、执行工具之前按占用触发，以及 provider 容量拒绝后压缩一次再重发。
 *
 * 三处调用同一个 `CompactionPort.run()`、写入同一份 manifest、使用同一条落库路径，
 * 它们是调用点，不是三个权威。
 */

import type { ProviderError } from '@qywork/ai'
import { estimateMessages, estimateRequest } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { envelopeHeadTokens, log } from '@qywork/core'
import { tailRetain } from '../delivery.ts'
import { markCompacted } from '../registry.ts'
import { breakdownOf, envelopeHashOf, softLimit } from './request.ts'
import { type LoopHost, type RunState, type TurnState, untilAborted } from './run-state.ts'

/**
 * ── 压缩触发：主入口 ──
 *
 * 发送前按占用检查。容量拒绝路径（`recoverFromOverflow`）是第二个**调用点**，不是第二个
 * 权威：调用同一个 `CompactionPort.run()`、写入同一份 manifest。
 *
 * 主路径不采用「先发送、被 provider 拒绝后压缩、然后重发」：该方式每次触发都要
 * 先消耗一次必然失败的长请求，长 prompt 下耗时几秒到几十秒且产生费用。占用读数采用
 * 锚定估算（provider 真值 + 锚点之后一轮的本地增量），误差限制在单轮增量之内，
 * 足以用于发送前判断。
 *
 * 估算失误时此处放行，由容量拒绝路径作为后备处理；该路径的触发条件很严格，
 * 泛化的 400 不触发（理由见该函数的注释）。
 *
 * 返回 `interrupted` 时 `run.stopReason` 已置为 `user_interrupt`，调用方结束循环。
 */
export async function* compactBeforeSend(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'sent' | 'interrupted', unknown> {
  if (run.transcript.length <= run.compactedAt) return 'sent'
  // 摘要请求占用本轮的编号，主请求顺延。
  const done = yield* compactOverSoftLimit(host, run, turn, {
    occupancy: run.occupancyOf(turn.req),
    estimated: estimateRequest(turn.req, run.density),
    threshold: softLimit(run.adapter.spec),
    summaryTurn: run.requestTurn,
    latestUnitSeen: false,
  })
  return done === 'interrupted' ? 'interrupted' : 'sent'
}

/**
 * 执行工具之前的检查点：软阈值以下的余量不足一份尾部保留量时先压缩一次。
 * 返回当前的占用读数与估算折算比，投递额度按这两个数值开立；
 * 返回 `interrupted` 时 `run.stopReason` 已置为 `user_interrupt`。
 *
 * 折算比是整份请求的本地估算与 provider 真值之比，只缩小不放大（上限为 1）：它是平均值，
 * 单段结果的比值可能低得多。实测整份请求为 1.2–1.6、生僻字正文为 0.65；按 1.23 放大时，
 * 一次完整读取 62 万字的生僻字文件，下一次请求的真值为 101.7 万，超出 1M 窗口。
 * 触发线与投递额度必须使用同一个比值：触发线按放大后的比值计算、额度按未放大的比值计算时，
 * 余量只够容纳一小段而触发线尚未达到，续读段在压缩之前缩小为两份半保留量（实测）。
 *
 * 触发线比发送前的触发线低一份尾部保留量（按两种估算的比值折算为真值）：余量不足该值时，
 * 本次决策只能容纳一小段，甚至一行都无法容纳。本次响应的输出使占用超过软阈值时同理，此时额度为 0。
 * 软阈值以下时端口只执行回收量足够大的收纳、不摘要，无法回收时不做改动，本次决策按剩余余量部分投递。
 *
 * **必须在打开第一条工具记录之前调用。** 压缩记录占用一个 step 序号，位于同一批次的工具记录之间时，
 * `runtime/transcript.ts` 的 `stepsToUnits` 只收集连续的同批次记录，本次决策会被拆成两个单元：
 * 重建的历史与实际对话结构不同，前一段的结果还可能在模型看到之前被折叠。位于本次响应的
 * text / thinking 与工具记录之间时仍是一个单元。
 *
 * 读数与发送前采用同一口径：有锚点时取锚点（响应后已包含本轮输出）；没有锚点时取上一次请求的估算
 * 加上本次响应推进 transcript 的 assistant 消息。不为计算占用而重新装配请求：装配会多执行一次投影。
 */
export async function* compactBeforeTools(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, { occupancy: number; scale: number } | 'interrupted', unknown> {
  const estimated =
    estimateRequest(turn.req, run.density) +
    estimateMessages(run.transcript.slice(turn.unitStart), run.density)
  const occupancy = run.anchor ? run.meter(0).tokens : estimated
  const scale = occupancy > 0 ? Math.min(1, estimated / occupancy) : 1
  // 上一次尝试已看到本次响应之前的全部历史：本次响应属于最后一个单元，不可折叠，不再重试。
  if (run.compactedAt >= turn.unitStart) return { occupancy, scale }
  // 本轮的编号已被刚完成的主请求占用：摘要请求占用下一个编号，下一轮主请求再顺延。
  const done = yield* compactOverSoftLimit(host, run, turn, {
    occupancy,
    estimated,
    threshold: softLimit(run.adapter.spec) - tailRetain(run.adapter.spec.contextWindow) / scale,
    summaryTurn: run.requestTurn + 1,
    latestUnitSeen: true,
  })
  if (done === 'interrupted') return 'interrupted'
  if (done === 'unchanged') return { occupancy, scale }
  // 压缩生效后锚点作废、请求已按新投影重新装配（含本次响应），读数改按重新装配后的请求估算，两种口径一致。
  return { occupancy: estimateRequest(turn.req, run.density), scale: 1 }
}

/**
 * 占用超过 `threshold` 时压缩一次。
 *
 * 占用未超过软阈值时端口只收纳或跳过、不调用模型（`CompactionRunInput.occupancy` 的约定），
 * 因此不发送开始事件；此时的跳过也不写入记录、不发送事件：没有任何改动，也没有需要告知用户的状态。
 * 超过软阈值时照常发送开始事件，跳过必须写入记录：它表示上下文仍在软阈值以上。
 */
async function* compactOverSoftLimit(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
  at: {
    occupancy: number
    estimated: number
    threshold: number
    summaryTurn: number
    latestUnitSeen: boolean
  },
): AsyncGenerator<AgentEvent, 'compacted' | 'unchanged' | 'interrupted', unknown> {
  const { adapter, input, persist, density } = run
  const { occupancy } = at
  if (occupancy <= at.threshold) return 'unchanged'

  run.compactedAt = run.transcript.length
  log.info('agent', '占用超过压缩阈值，触发压缩', {
    occupancy,
    threshold: Math.round(at.threshold),
    softLimit: softLimit(adapter.spec),
  })
  const overLine = occupancy > softLimit(adapter.spec)
  if (overLine) yield { type: 'compaction', runId: input.runId, phase: 'started' }
  // 与工具波次相同：压缩可能调用一次模型，停滞时整轮阻塞于此，且它不写入
  // `provider_requests`，账本上无法看出阻塞于何处。
  const trace = host.summaryTrace(run, at.summaryTurn)
  const outcome = await untilAborted(
    input.signal,
    host.compaction.run({
      signal: input.signal,
      trace,
      trigger: 'automatic',
      model: adapter.spec.id,
      latestUnitSeen: at.latestUnitSeen,
      occupancy,
      estimatedOccupancy: at.estimated,
      contextWindow: adapter.spec.contextWindow,
      density,
    }),
  )
  if (trace.opened) {
    run.requestTurn++
    run.turnIndex++
    if (trace.merged) {
      yield { type: 'usage', runId: input.runId, usage: structuredClone(run.usage) }
    }
  }
  if (outcome.status === 'aborted') {
    /*
     * 中断的压缩没有落库任何内容，因此此处不发送事件、不写入记录：
     * run 随即以 `user_interrupt` 结束，停止时多显示一张错误卡片是噪音，
     * 而账本上不留记录正是对「没有产生任何副作用」的如实反映。
     */
    run.stopReason = 'user_interrupt'
    return 'interrupted'
  }
  if (outcome.status === 'compacted') {
    markCompacted(run.ctx.state)
    persist.recordCompaction(input.runId, run.nextSeq(), {
      trigger: 'automatic',
      occupancy,
      estimatedOccupancy: at.estimated,
      contextWindow: adapter.spec.contextWindow,
      ...('message' in outcome && outcome.message ? { message: outcome.message } : {}),
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
     * 锚点描述的是**折叠前**的前缀，折叠后仍用它计算会使读数不下降，
     * 下一步再次越线、再次压缩：压缩变成每步一次的死循环。
     * 退回估算口径一轮，下一个 provider 真值到来即重新锚定。
     *
     * 此处不应用信封修正（`RunState.rebaseAnchor`）：压缩替换的是消息侧的主要部分，
     * 头部修正只覆盖信封的三项，修正后的数值仍是折叠前的数值。
     */
    run.anchor = null
    // 压缩修改的是投影，必须重新装配：发送旧请求会使本次压缩无效。
    turn.req = host.buildRequest(run)
    turn.breakdown = breakdownOf(turn.req, density)
    return 'compacted'
  } else {
    // 无法压缩不是致命错误：照常发送，由 provider 判定。
    // **skipped 与 failed 分开报告**：「没有可压缩的内容」不是失败，
    // 将其显示为红色的压缩失败会使用户排查一个并不存在的故障。
    const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
    if (phase === 'skipped' && !overLine) return 'unchanged'
    persist.recordCompaction(input.runId, run.nextSeq(), {
      trigger: 'automatic',
      occupancy,
      estimatedOccupancy: at.estimated,
      contextWindow: adapter.spec.contextWindow,
      ...('message' in outcome && outcome.message ? { message: outcome.message } : {}),
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
  return 'unchanged'
}

/** 被容量拒绝的那次尝试的现场信息，由发送阶段传入。 */
export interface OverflowAttempt {
  /** 被拒的错误本身；恢复失败时原样上抛。 */
  err: unknown
  pe: ProviderError
  /** 把本次尝试的重试裁决写入请求账。 */
  recordDecision(decision: 'interrupted' | 'context_compaction' | 'context_compaction_failed'): void
  /** 本轮已开的请求记录行数，与发送阶段共用；压缩后重发另起一个 turn，从 0 重新计数。 */
  ledger: { sendIndex: number }
}

/**
 * ── 容量拒绝：压缩一次再重发 ──
 *
 * 这是压缩的**第二个调用点**，不是第二个权威：调用同一个
 * `CompactionPort.run()`、写入同一份 manifest、使用同一条落库路径、
 * 失败时仍报告 `context_overflow`。
 *
 * 必须保留本路径：占用读数对附件按固定值估算（`ai/tokens.ts` 的
 * `MEDIA_TOKENS`），一份大附件可能被低估两个数量级。此时发送前检查始终放行、
 * provider 始终拒绝、重试得到的仍是同一个估算：**会话就此停滞，
 * 手动压缩也无法恢复**（附件在保留区中）。失败路径必须有终态。
 *
 * 触发条件很严格：只有 `code` 不够，必须同时带有 `capacity`
 * （`ai/capacity.ts` 的严格分类：provider 原生容量码或强消息匹配），
 * 泛化的 400 不触发。宁可不恢复，也不能把一次参数错误当作容量问题
 * 反复压缩。
 *
 * 调用方只在 `code === 'context_overflow'`、带有 `capacity` 且本 run 尚未恢复过时调用。
 * 返回即表示请求已重建、应当重发；其余情形原样抛出被拒的错误。
 */
export async function* recoverFromOverflow(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
  attempt: OverflowAttempt,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { adapter, input, persist, density, transcript } = run
  const { err, pe } = attempt
  run.overflowRecovered = true
  const cap = pe.capacity!
  /*
   * 用 provider 自报的输入量校正锚点：它是真值，而本地估算
   * 刚被证明有误。无法取得时把锚点作废、退回估算，**不要用本地估算
   * 填入此处**：本地估算正是超出窗口的原因，填入等于再次确认错误。
   */
  if (cap.reportedInputTokens !== null) {
    run.anchor = {
      tokens: cap.reportedInputTokens,
      uncovered: 0,
      uncoveredVideos: 0,
      transcriptIndex: transcript.length,
      model: turn.req.model,
      headTokens: envelopeHeadTokens(turn.breakdown),
      envelope: envelopeHashOf(turn.req),
    }
  } else {
    run.anchor = null
  }
  // 压缩前后用**同一口径**估算请求本身。判据不是「压缩返回成功」：
  // 收纳段可能已经落库，却未减少任何 token。
  const sizeBefore = estimateRequest(turn.req, density)
  yield { type: 'compaction', runId: input.runId, phase: 'started' }
  /*
   * 被拒的那次已占用 (requestTurn, retry)。摘要请求记入下一个 turn；压缩后重发的
   * 是另一份内容（历史已替换为摘要），不再算作同一 turn 的重试，同样另起一个 turn。
   */
  const trace = host.summaryTrace(run, run.requestTurn + 1)
  const outcome = await untilAborted(
    input.signal,
    host.compaction.run({
      signal: input.signal,
      trace,
      trigger: 'automatic',
      model: adapter.spec.id,
      // 被拒的那次请求中的最后一批结果尚未送达模型。
      latestUnitSeen: false,
      occupancy: cap.reportedInputTokens ?? run.occupancyOf(turn.req),
      // `sizeBefore` 即本次请求的本地估算，来自同一次装配、同一口径。
      estimatedOccupancy: sizeBefore,
      contextWindow: adapter.spec.contextWindow,
      density,
    }),
  )
  if (trace.opened) {
    run.requestTurn += 2
    run.turnIndex += 2
    attempt.ledger.sendIndex = 0
    if (trace.merged) {
      yield { type: 'usage', runId: input.runId, usage: structuredClone(run.usage) }
    }
  }
  if (outcome.status === 'aborted') {
    run.stopReason = 'user_interrupt'
    attempt.recordDecision('interrupted')
    throw err
  }
  if (outcome.status === 'compacted') {
    const rebuilt = host.buildRequest(run)
    if (estimateRequest(rebuilt, density) < sizeBefore) {
      markCompacted(run.ctx.state)
      persist.recordCompaction(input.runId, run.nextSeq(), {
        trigger: 'overflow',
        occupancy: cap.reportedInputTokens ?? run.occupancyOf(turn.req),
        estimatedOccupancy: sizeBefore,
        contextWindow: adapter.spec.contextWindow,
        ...('message' in outcome && outcome.message ? { message: outcome.message } : {}),
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
      run.compactedAt = transcript.length
      run.anchor = null
      turn.req = rebuilt
      turn.breakdown = breakdownOf(turn.req, density)
      attempt.recordDecision('context_compaction')
      return
    }
  }
  /*
   * **请求未变小时不重发。** 同一份字节再发一次只会得到同一个拒绝，
   * 而那一次需要支付全额的长 prompt 费用。
   */
  const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
  const reasonCode = outcome.status === 'compacted' ? 'no_reduction' : outcome.reasonCode
  persist.recordCompaction(input.runId, run.nextSeq(), {
    trigger: 'overflow',
    occupancy: cap.reportedInputTokens ?? run.occupancyOf(turn.req),
    estimatedOccupancy: sizeBefore,
    contextWindow: adapter.spec.contextWindow,
    ...('message' in outcome && outcome.message ? { message: outcome.message } : {}),
    phase,
    manifestRevision: 0,
    compactedMessages: 0,
    reasonCode,
  })
  yield { type: 'compaction', runId: input.runId, phase, reasonCode }
  attempt.recordDecision('context_compaction_failed')
  throw err
}
