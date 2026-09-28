/**
 * run 内压缩的三个调用点：发送前按占用触发、执行工具之前按占用触发，以及 provider 容量拒绝后压一次再重发。
 *
 * 三处调的是同一个 `CompactionPort.run()`、落同一份 manifest、走同一条落库路径，
 * 它们是调用点不是三个权威。
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
 * 发送前按占用检查。容量拒绝那条（`recoverFromOverflow`）是第二个**调用点**，不是第二个
 * 权威：调的是同一个 `CompactionPort.run()`、落同一份 manifest。
 *
 * 主路径不写成「先发、被 provider 拒了再压、然后重发」：那个形状每次触发都要
 * 先烧掉一次注定失败的长请求，长 prompt 上是几秒到几十秒外加计费。占用取的是
 * 锚定尺（provider 真值 + 锚点后的一轮本地增量），误差被限制在单轮增量内，
 * 够做发送前判断。
 *
 * 估算失误时这里放行，由容量拒绝那条窄路兜底——凭证收得很窄，
 * 泛化的 400 不触发（理由写在那个函数上）。
 *
 * 返回 `interrupted` 时 `run.stopReason` 已置为 `user_interrupt`，调用方结束循环。
 */
export async function* compactBeforeSend(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'sent' | 'interrupted', unknown> {
  if (run.transcript.length <= run.compactedAt) return 'sent'
  // 摘要请求占这一轮的编号，主请求顺延。
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
 * 执行工具之前的检查点：软阈值以下的余量不足一份尾部保留量时先压一次。
 * 返回此刻的占用读数与估算尺折算比，投递额度按这两个数开账；
 * `interrupted` 时 `run.stopReason` 已置为 `user_interrupt`。
 *
 * 折算比是整份请求上本地估算与 provider 真值之比，只缩不放（上限 1）：它是平均值，
 * 一段结果的比值可能低得多。V00 实测整份请求 1.2–1.6、生僻字正文 0.65；按 1.23 放大时，
 * 62 万字的生僻字文件一次整读，下一次请求真值 101.7 万、超出 1M 窗口。
 * 触发线与投递额度必须用同一个比值：触发线按放大后的比值算、额度按不放大算时，
 * 余量已只够一小段而触发线未到，续读段在压缩之前缩成两份半保留量（V02 实测）。
 *
 * 触发线比发送前那一处低一份尾部保留量（按两把尺的比值折成真值）：余量不足这么多时，
 * 这次决策只放得下一小段甚至一行都放不下。本次响应的输出把占用推过软阈值时同理，那时额度为 0。
 * 软阈值以下端口只做收回量够大的收纳、不摘要，收不出时不动，这次决策按剩下的余量部分投递。
 *
 * **必须在打开第一条工具记录之前调。** 压缩记录占一个 step 序号，夹在同一批次的工具记录之间时，
 * `runtime/transcript.ts` 的 `stepsToUnits` 只收连续的同批次记录，这次决策会被拆成两个单元：
 * 重建出的历史与实际对话不同形，前一段的结果还可能在模型看到之前被折叠。落在本次响应的
 * text / thinking 与工具记录之间则仍是一个单元。
 *
 * 读数与发送前同一把尺：有锚点取锚点（响应后已含本轮输出）；没有锚点时是上一次请求的估算
 * 加上本次响应推进 transcript 的那条 assistant 消息。不为量占用重装请求：装配会多投影一次。
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
  // 上一次尝试已看到本次响应之前的全部历史：本次响应属于最后一个单元，不可折，不再重试。
  if (run.compactedAt >= turn.unitStart) return { occupancy, scale }
  // 这一轮的编号已被刚完成的主请求占用：摘要请求占下一个，下一轮主请求再顺延。
  const done = yield* compactOverSoftLimit(host, run, turn, {
    occupancy,
    estimated,
    threshold: softLimit(run.adapter.spec) - tailRetain(run.adapter.spec.contextWindow) / scale,
    summaryTurn: run.requestTurn + 1,
    latestUnitSeen: true,
  })
  if (done === 'interrupted') return 'interrupted'
  if (done === 'unchanged') return { occupancy, scale }
  // 压缩生效后锚点作废、请求已按新投影重装（含本次响应），读数改按重装后的请求估，两把尺重合。
  return { occupancy: estimateRequest(turn.req, run.density), scale: 1 }
}

/**
 * 占用越过 `threshold` 时压一次。
 *
 * 占用未越过软阈值时端口只收纳或跳过、不调模型（`CompactionRunInput.occupancy` 的约定），
 * 因此不播报开始；这时的跳过也不落记录、不发事件：什么都没改，也没有需要用户知道的状态。
 * 越过软阈值时照旧播报开始，跳过要落记录——那表示上下文仍在软阈值以上。
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
  log.info('agent', '占用越过压缩线，触发压缩', {
    occupancy,
    threshold: Math.round(at.threshold),
    softLimit: softLimit(adapter.spec),
  })
  const overLine = occupancy > softLimit(adapter.spec)
  if (overLine) yield { type: 'compaction', runId: input.runId, phase: 'started' }
  // 同工具波次：压缩可能要调一次模型，卡住的话整轮停在这里，而且它不写
  // `provider_requests`，账本上连「卡在哪」都看不出来。
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
     * 中断的压缩什么都没落库，所以这里什么都不发、什么都不记：
     * run 随即以 `user_interrupt` 收尾，停止时刻多一张红卡是噪音，
     * 而账本上无痕正是「它没有产生任何副作用」这件事的如实记法。
     */
    run.stopReason = 'user_interrupt'
    return 'interrupted'
  }
  if (outcome.status === 'compacted') {
    markCompacted(run.ctx.state)
    persist.recordCompaction(input.runId, run.nextSeq(), {
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
     *
     * 这里不套信封修正（`RunState.rebaseAnchor`）：压缩换掉的是消息侧的大头，
     * 头部修正只覆盖信封那三项，修正完的数仍然是折叠前那个数。
     */
    run.anchor = null
    // 压缩改的是投影，必须重新装配——拿旧请求发出去等于这次压缩白花。
    turn.req = host.buildRequest(run)
    turn.breakdown = breakdownOf(turn.req, density)
    return 'compacted'
  } else {
    // 压不动不是致命错：照常发出去，让 provider 来判。
    // **skipped 与 failed 分开报**：「没什么可压」不是失败，
    // 把它显示成红色的压缩失败会让用户去查一个并不存在的故障。
    const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
    if (phase === 'skipped' && !overLine) return 'unchanged'
    persist.recordCompaction(input.runId, run.nextSeq(), {
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

/** 容量拒绝那一次尝试的现场，由发送阶段交过来。 */
export interface OverflowAttempt {
  /** 被拒的错误本身；恢复不成时原样上抛。 */
  err: unknown
  pe: ProviderError
  /** 把这次尝试的重试裁决写进请求账。 */
  recordDecision(decision: 'interrupted' | 'context_compaction' | 'context_compaction_failed'): void
  /** 本轮已经开过几行账，与发送阶段共用一份；压缩后重发另起一个 turn，从 0 重新数。 */
  ledger: { sendIndex: number }
}

/**
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
 *
 * 调用方只在 `code === 'context_overflow'`、带 `capacity` 且本 run 还没恢复过时调用。
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
   * 用 provider 自报的输入量校正锚点——它是真值，而本地那个估算
   * 刚刚被证明是错的。拿不到就把锚点作废退回估算，**不要用本地估算
   * 去填这个位置**：那正是撞窗的原因，填进去等于确认一遍错误。
   */
  if (cap.reportedInputTokens !== null) {
    run.anchor = {
      tokens: cap.reportedInputTokens,
      uncovered: 0,
      transcriptIndex: transcript.length,
      model: turn.req.model,
      headTokens: envelopeHeadTokens(turn.breakdown),
      envelope: envelopeHashOf(turn.req),
    }
  } else {
    run.anchor = null
  }
  // 压缩前后用**同一把尺**量请求本身。判据不是「压缩返回成功」——
  // 收纳段可能落了库却一个 token 没省。
  const sizeBefore = estimateRequest(turn.req, density)
  yield { type: 'compaction', runId: input.runId, phase: 'started' }
  /*
   * 被拒的那次已占着 (requestTurn, retry)。摘要请求记到下一个 turn；压缩后重发的
   * 是另一份内容（历史已换成摘要），不再算同一 turn 的重试，也另起一个 turn。
   */
  const trace = host.summaryTrace(run, run.requestTurn + 1)
  const outcome = await untilAborted(
    input.signal,
    host.compaction.run({
      signal: input.signal,
      trace,
      trigger: 'automatic',
      model: adapter.spec.id,
      // 被拒的那次请求里最后一批结果还没到模型手里。
      latestUnitSeen: false,
      occupancy: cap.reportedInputTokens ?? run.occupancyOf(turn.req),
      // `sizeBefore` 就是这一份请求的本地估算，同一次装配、同一把尺。
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
      run.compactedAt = transcript.length
      run.anchor = null
      turn.req = rebuilt
      turn.breakdown = breakdownOf(turn.req, density)
      attempt.recordDecision('context_compaction')
      return
    }
  }
  /*
   * **没变小就不重发。** 同一份字节再发一次只会拿到同一个拒绝，
   * 而那一次要付全额的长 prompt 费用。
   */
  const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
  const reasonCode = outcome.status === 'compacted' ? 'no_reduction' : outcome.reasonCode
  persist.recordCompaction(input.runId, run.nextSeq(), {
    phase,
    manifestRevision: 0,
    compactedMessages: 0,
    reasonCode,
  })
  yield { type: 'compaction', runId: input.runId, phase, reasonCode }
  attempt.recordDecision('context_compaction_failed')
  throw err
}
