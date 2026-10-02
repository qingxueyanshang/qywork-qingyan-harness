/**
 * 异步生成任务的等待：提交后按间隔查询，直到成功、失败或超过等待上限。
 *
 * 任务号一旦交出，这之后的任何失败（查询断网、等待超时、下载失败）都不是终态：远端任务还在，
 * 结果地址 24 小时内有效，可以用同一个任务号接续取回。只有远端明确报失败才是终态。
 */

import { MediaError, type MediaRunOptions, type MediaUsage } from './types.ts'

/** 等待上限。视频典型 1–5 分钟，留足余量；超过就把任务号交还调用方接续取回。 */
export const TASK_WAIT_MS = 20 * 60_000
const FIRST_INTERVAL_MS = 5_000
const MAX_INTERVAL_MS = 15_000

interface TaskOutput {
  url: string
  extra?: string[]
  usage?: MediaUsage
}

export type TaskState<T = TaskOutput> =
  | { state: 'pending'; status: string }
  /** `extra`：结果地址之外随任务返回的产物地址（方舟的尾帧图），与视频一起下载、一起落盘。 */
  | ({ state: 'done' } & T)
  | { state: 'failed'; message: string }

/** 远端任务进行到哪一步：排队中还是生成中。排队中的任务百炼与方舟撤得动，生成中的撤不回。 */
export type TaskPhase = 'queued' | 'running'

const PHASES: Record<string, TaskPhase> = {
  // 百炼 PENDING / RUNNING，方舟与 OpenAI queued，可灵 submitted / processing，xAI pending / processing，
  // Gemini 交互 queued / in_progress。Veo 未完成时只有 processing，分不出排队，按生成中算。
  pending: 'queued',
  queued: 'queued',
  submitted: 'queued',
  running: 'running',
  in_progress: 'running',
  processing: 'running',
}

/** 各家查询结果里的进行中状态词归成两步；认不出的回 null。 */
export function taskPhase(status: string): TaskPhase | null {
  return PHASES[status.toLowerCase()] ?? null
}

/** 任务完成：结果地址与查询结果里的计量。 */
export type TaskDone<T = TaskOutput> = Extract<TaskState<T>, { state: 'done' }>

/** 远端明确报了失败：终态，任务号没有接续的意义。 */
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
 * 等任务完成，返回结果地址与计量。第一次查询不等待：接续取回时任务通常已经完成。
 * 状态变化时经 `onStatus` 回报一句，不按查询次数回报。
 */
export async function waitTask<T = TaskOutput>(
  taskId: string,
  check: () => Promise<TaskState<T>>,
  opts: MediaRunOptions,
): Promise<TaskDone<T>> {
  const deadline = Date.now() + TASK_WAIT_MS
  let interval = FIRST_INTERVAL_MS
  let last = ''
  for (;;) {
    const s = await check()
    if (s.state === 'done') return s
    if (s.state === 'failed') throw new RemoteTaskFailed(`远端任务失败：${s.message}`)
    if (s.status !== last) {
      last = s.status
      opts.onStatus?.(s.status)
    }
    if (Date.now() + interval > deadline) {
      throw new MediaError('等待超过 20 分钟仍未完成', { pendingTaskId: taskId })
    }
    await sleep(interval, opts.signal)
    interval = Math.min(Math.round(interval * 1.5), MAX_INTERVAL_MS)
  }
}

/**
 * 包住任务号交出之后的全部步骤：远端失败与用户停止原样抛；其余失败带上任务号，
 * 调用方据此留下任务记录，之后接续取回，不重新提交。
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
