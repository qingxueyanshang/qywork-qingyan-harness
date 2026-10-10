/**
 * 异步生成任务的等待：提交后按间隔查询，直到远端报告成功或失败，或用户停止。
 *
 * 不设总时长上限：远端每次查询都报告任务所处阶段，排队与生成的耗时由远端决定。
 * 任务号交出之后的其余失败（查询被拒绝、下载失败、进程停止）均不是终态：远端任务仍存在，
 * 可在服务商规定的结果保留期内用同一任务号接续取回。只有远端明确报告失败才是终态。
 */

import { transientFailure } from './http.ts'
import { MediaError, type MediaRunOptions, type MediaUsage } from './types.ts'

const FIRST_INTERVAL_MS = 5_000
const MAX_INTERVAL_MS = 15_000

interface TaskOutput {
  url: string
  extra?: string[]
  usage?: MediaUsage
}

export type TaskState<T = TaskOutput> =
  | { state: 'pending'; status: string }
  /** `extra`：结果地址之外随任务返回的产物地址（方舟的尾帧图），与视频一同下载、一同落盘。 */
  | ({ state: 'done' } & T)
  | { state: 'failed'; message: string }

/** 远端任务所处阶段：排队中或生成中。百炼与方舟可撤销排队中的任务，无法撤销生成中的任务。 */
export type TaskPhase = 'queued' | 'running'

const PHASES: Record<string, TaskPhase> = {
  // 百炼 PENDING / RUNNING，方舟与 OpenAI queued，可灵 submitted / processing，xAI pending / processing，
  // Gemini 交互 queued / in_progress。Veo 未完成时只有 processing，无法区分排队，按生成中处理。
  pending: 'queued',
  queued: 'queued',
  submitted: 'queued',
  running: 'running',
  in_progress: 'running',
  processing: 'running',
}

/** 将各厂商查询结果中的进行中状态词归并为两个阶段；无法识别的返回 null。 */
export function taskPhase(status: string): TaskPhase | null {
  return PHASES[status.toLowerCase()] ?? null
}

/**
 * 远端报告失败时显示的原因：错误码与错误信息原文；两者都没有时使用该状态的说明。
 * 不显示 `failed` / `FAILED` 等状态值本身，它与「远端任务失败」重复。
 */
export function failureDetail(code: unknown, message: unknown, fallback: string): string {
  const parts = [code, message].flatMap((v) =>
    (typeof v === 'string' && v.trim()) || typeof v === 'number' ? [String(v).trim()] : [],
  )
  return parts.length ? parts.join('：').slice(0, 500) : fallback
}

/** 任务完成：结果地址与查询结果中的计量。 */
export type TaskDone<T = TaskOutput> = Extract<TaskState<T>, { state: 'done' }>

/** 远端明确报告失败：终态，任务号不再用于接续。 */
class RemoteTaskFailed extends MediaError {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * 等待任务完成，返回结果地址与计量。首次查询不等待：接续取回时任务通常已完成。
 * 查询遇到可重发的失败（`transientFailure`：连接中断、静默超时、408 / 429 / 5xx）时按间隔继续查询，
 * 不结束等待；其余失败原样抛出，由 `afterSubmit` 附带任务号。
 * 状态变化时经 `onStatus` 回报一次，不按查询次数回报。
 */
export async function waitTask<T = TaskOutput>(
  check: () => Promise<TaskState<T>>,
  opts: MediaRunOptions,
): Promise<TaskDone<T>> {
  let interval = FIRST_INTERVAL_MS
  let last = ''
  for (;;) {
    const s = await check().catch((err: unknown) => {
      if (opts.signal.aborted || !transientFailure(err)) throw err
      return null
    })
    if (s?.state === 'done') return s
    if (s?.state === 'failed') throw new RemoteTaskFailed(`远端任务失败：${s.message}`)
    if (s && s.status !== last) {
      last = s.status
      opts.onStatus?.(s.status)
    }
    await sleep(interval, opts.signal)
    interval = Math.min(Math.round(interval * 1.5), MAX_INTERVAL_MS)
  }
}

/**
 * 包装任务号交出之后的全部步骤：远端失败与用户停止原样抛出；其余失败附带任务号，
 * 调用方据此保留任务记录，之后接续取回，不重新提交。
 */
export async function afterSubmit<T>(
  taskId: string,
  signal: AbortSignal,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step()
  } catch (err) {
    if (signal.aborted || err instanceof RemoteTaskFailed) throw err
    if (err instanceof MediaError && err.pendingTaskId) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new MediaError(`${reason}（远端任务 ${taskId} 仍可取回）`, { pendingTaskId: taskId })
  }
}
