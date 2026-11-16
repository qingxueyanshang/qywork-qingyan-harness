/** 收尾阶段：run 行的终态。正常结束、异常与提前关闭三条路径都在此处写入，每轮只写一次。 */

import { DelegatePort } from '@qywork/agent'
import { ProviderError } from '@qywork/ai'
import type { AgentEvent, RunInterruption } from '@qywork/core'
import { finishRun, recordUsage, settleRunningSteps, stepInExecution } from '@qywork/store'
import { CommandPort } from '@qywork/tools'
import { releaseRunTemp } from '../../temp-files.ts'
import type { SessionState } from '../types.ts'
import type { AskState } from './state.ts'

/** 对话循环发出 `run.finished`：写入终态与本轮的用量账，处理本轮的临时目录。 */
export async function recordFinished(
  session: SessionState,
  ask: AskState,
  ev: Extract<AgentEvent, { type: 'run.finished' }>,
): Promise<void> {
  const { store } = session.opts
  const { adapter, conversation, conversationId, model, run } = ask
  ask.finished = true
  const interruption =
    ev.stopReason === 'user_interrupt' ? interruptionFrom(session.opts.signal, 'user', false) : null
  finishRun(store, run.id, {
    status: ev.status,
    stopReason: ev.stopReason,
    errorMessage:
      ask.failure?.message ?? interruptionMessage(interruption) ?? ev.stopDetail ?? null,
    errorCode: ask.failure?.code ?? null,
    interruption,
  })
  // 账本在收尾时记录一次。中途的 usage 是累计值，每次都记录会将同一笔费用
  // 重复记账；而 run 上的 usage 会随会话删除一并消失，无法用于
  // 统计月度花费。
  recordUsage(store, {
    kind: 'run',
    runId: run.id,
    conversationId,
    workspaceId: session.workspaceId,
    model,
    provider: adapter.kind,
    inputTokens: ev.usage.inputTokens,
    outputTokens: ev.usage.outputTokens,
    cachedTokens: ev.usage.cachedTokens,
    cacheWriteTokens: ev.usage.cacheWriteTokens,
    reasoningTokens: ev.usage.reasoningTokens,
    cost: ev.usage.cost,
    currency: ev.usage.currency,
  })
  /*
   * 临时目录在发出 `run.finished` 之前处理：收到该事件的一方可以立即发起下一轮，
   * 此后不能再有等待。只改名移入回收目录、实际删除在后台进行（见 `temp-files.ts`）。
   * 没有 `run.finished` 的轮次（生成器被提前关闭）不处理，其目录随会话临时目录删除。
   */
  await releaseRunTemp({
    store,
    workspaceRoot: session.opts.workspaceRoot,
    conversationId,
    runId: run.id,
    stopReason: ev.stopReason,
    topLevel: !conversation?.parentConversationId,
    backgroundRunning:
      (session.ports.get(DelegatePort)?.inflight().length ?? 0) > 0 ||
      (session.ports.get(CommandPort)?.list().length ?? 0) > 0,
  })
}

/** 生成器内抛出异常：未写入终态且不是用户停止时记为失败。由调用方继续抛出。 */
export function recordFailure(session: SessionState, ask: AskState, error: unknown): void {
  const { store } = session.opts
  const { run } = ask
  if (!ask.finished && !session.opts.signal.aborted) {
    ask.finished = true
    const pe = error instanceof ProviderError ? error : null
    finishRun(store, run.id, {
      status: 'failed',
      stopReason: 'provider_error',
      errorMessage: pe?.message ?? (error instanceof Error ? error.message : String(error)),
      errorCode: pe?.code ?? 'internal_error',
    })
  }
}

/** 每轮必经的收尾：停止心跳，未写入终态时写为中断，结算仍在运行的 step。 */
export function closeRun(session: SessionState, ask: AskState): void {
  const { store } = session.opts
  const { heartbeat, run } = ask
  // 先停止心跳。停止较晚不影响正确性（只更新 running 的行），但最先停止才能保证
  // 无论下面哪一步抛出异常，都不会留下仍在推送心跳的定时器。
  clearInterval(heartbeat)
  session.mediaSpends.delete(run.id)
  session.modelUsage.delete(run.id)
  // 生成器被提前关闭（用户 Ctrl-C、客户端断开连接）时也须为 run 写入终态，
  // 否则账本中会永久保留一条 running 的孤儿记录。
  if (!ask.finished) {
    // 只读状态列：逐条读取 step 会解析 payload，payload 损坏时在此抛出，run 行停留在 running。
    const ambiguous = stepInExecution(store, run.id)
    const interruption = interruptionFrom(
      session.opts.signal,
      session.opts.signal.aborted ? 'user' : 'consumer_closed',
      ambiguous,
    )
    finishRun(store, run.id, {
      status: 'interrupted',
      stopReason: ambiguous ? 'internal_guard' : 'user_interrupt',
      errorMessage: interruptionMessage(interruption),
      interruption,
    })
  }
  // step 也须写为终态，不只是 run。
  //
  // 只对 run 收尾不够：在 `tool.started` 的 yield 处被 `.return()` 中止时，
  // step 已是 running 却无人 settle；run 随即被标为终态，因此该 step
  // 永远不会被启动时的 `recoverStaleRuns` 处理（它只扫描 running/queued 的 run）。
  //
  // 后果不限于界面上一张持续显示加载状态的卡片：历史投影必须跳过含未终结调用的整个 batch，
  // 一条孤儿 step 会使同批次中已经成功的写文件结果一并从历史中消失。
  settleRunningSteps(store, run.id)
}

type InterruptionSource = RunInterruption['source']

/** AbortSignal.reason 是进程内的中止来源；调用方未携带 reason 时沿用 fallback。 */
function interruptionFrom(
  signal: AbortSignal,
  fallback: InterruptionSource,
  ambiguousToolExecution: boolean,
): RunInterruption {
  const raw = signal.reason
  const reason =
    typeof raw === 'object' && raw !== null
      ? (raw as { source?: unknown; observedAt?: unknown })
      : null
  const allowed: ReadonlySet<InterruptionSource> = new Set([
    'user',
    'server_shutdown',
    'consumer_closed',
    'parent_agent',
  ])
  const source =
    typeof reason?.source === 'string' && allowed.has(reason.source as InterruptionSource)
      ? (reason.source as InterruptionSource)
      : fallback
  const observedAt =
    typeof reason?.observedAt === 'number' && Number.isFinite(reason.observedAt)
      ? reason.observedAt
      : Date.now()
  return {
    source,
    observedAt,
    recordedAt: Date.now(),
    ambiguousToolExecution,
  }
}

function interruptionMessage(interruption: RunInterruption | null): string | null {
  if (!interruption || interruption.source === 'user') return null
  if (interruption.source === 'server_shutdown') return '服务正常关闭，本轮随之中断'
  if (interruption.source === 'consumer_closed') return '执行流被调用方提前关闭，本轮中断'
  if (interruption.source === 'parent_agent') return '派发该子 agent 的会话停止了本轮'
  return null
}
