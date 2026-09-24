/**
 * run 内压缩的两个调用点：发送前按占用触发，以及 provider 容量拒绝后压一次再重发。
 *
 * 两处调的是同一个 `CompactionPort.run()`、落同一份 manifest、走同一条落库路径，
 * 它们是调用点不是两个权威。
 */

import type { ProviderError } from '@qywork/ai'
import { estimateRequest } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { envelopeHeadTokens, log } from '@qywork/core'
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
  const { adapter, input, persist, density } = run
  if (run.transcript.length <= run.compactedAt) return 'sent'
  const occupancy = run.occupancyOf(turn.req)
  if (occupancy <= softLimit(adapter.spec)) return 'sent'

  run.compactedAt = run.transcript.length
  log.info('agent', '发送前检查触发压缩', {
    occupancy,
    softLimit: softLimit(adapter.spec),
  })
  yield { type: 'compaction', runId: input.runId, phase: 'started' }
  // 同工具波次：压缩可能要调一次模型，卡住的话整轮停在这里，而且它不写
  // `provider_requests`，账本上连「卡在哪」都看不出来。
  // 摘要请求占下一个 turn 编号；主请求顺延。
  const trace = host.summaryTrace(run, run.requestTurn)
  const outcome = await untilAborted(
    input.signal,
    host.compaction.run({
      signal: input.signal,
      trace,
      trigger: 'automatic',
      model: adapter.spec.id,
      occupancy,
      estimatedOccupancy: estimateRequest(turn.req, density),
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
    turn.req = host.buildRequest(run, turn.turnNotice)
    turn.breakdown = breakdownOf(turn.req, density)
  } else {
    // 压不动不是致命错：照常发出去，让 provider 来判。
    // **skipped 与 failed 分开报**：「没什么可压」不是失败，
    // 把它显示成红色的压缩失败会让用户去查一个并不存在的故障。
    const phase = outcome.status === 'skipped' ? 'skipped' : 'failed'
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
  return 'sent'
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
    const rebuilt = host.buildRequest(run, turn.turnNotice)
    if (estimateRequest(rebuilt, density) < sizeBefore) {
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
