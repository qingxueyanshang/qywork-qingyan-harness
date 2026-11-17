/**
 * 画布卡片的生成状态：正在进行的生成（`running`）与卡片上显示的最近一次失败（`failures`），只保存在进程内，重启后清空。
 * 每次生成的结果（含失败原文）在收尾时追加到画布文件的生成记录（`runs`）中，随文件保留。
 *
 * 两份记录只由 `CanvasRuns` 写入；`CanvasDocs` 经 `entryOf` 拒绝删除正在生成的卡片，经 `stateOf` 得出节点状态。
 * 不要并入 `runs.ts`：`docs.ts` 依赖本模块，而 `runs.ts` 依赖 `docs.ts`，并入后形成引用环。
 */

import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TaskPhase } from '@qywork/ai'
import type {
  CanvasNode,
  CanvasNodeState,
  CanvasRunRecord,
  CanvasRunResult,
  MediaOutput,
  RetryWait,
} from '@qywork/core'
import { TASK_SUFFIX } from '@qywork/tools'

/**
 * 写入队列、运行中集合与失败记录的键：按字面拼接得到的画布绝对路径。
 * 不使用相对路径：多个工作区并存时，两个工作区根下同名的画布会冲突。
 * 不等待 `realpath`：键必须在调用时同步得出，才能按调用顺序排队。
 */
export function keyOf(workspaceRoot: string, path: string): string {
  return resolve(workspaceRoot, path)
}

/**
 * 生成卡的一次远端任务（视频，以及经由云端的出图与音频），以及指向该任务的版本（取得任务号时未能写入画布则为 null）。
 * `type` 是卡片的生成类别，撤销时按它取得模型的配置。
 */
export interface CanvasTask {
  taskId: string
  provider: string
  model: string
  type: MediaOutput
  /** 任务记录的工作区路径。 */
  record: string
  versionId: string | null
}

/** 一张卡的一次生成（运行或取回）。 */
export interface RunEntry {
  startedAt: number
  action: 'run' | 'retrieve'
  version?: string
  /** false 仅在已接通发送边界的视频准备阶段使用；未接通的类型不能据此声称未付费。 */
  requestSent?: boolean
  stopMessage?: string
  done?: Promise<CanvasRunResult>
  /** 停止本地等待；只有 cancelled 表示远端确已撤销。 */
  stop: AbortController
  task?: CanvasTask
  /** 平台报告的排队中 / 生成中；报告之前不存在。 */
  phase?: TaskPhase
  /** 请求被拒绝后正在等待自动重试；不在等待时不存在。 */
  retry?: RetryWait
  /** 远端已撤销：收尾时删除该版本与任务记录，不记录失败。 */
  cancelled?: true
  /**
   * 本次生成或取回的任务记录：工作区相对路径与 `keyOf` 形式的绝对路径。每次生成在提交之前写入记录，卡片的占位版本引用它；
   * 画布在等待期间改名或移动后，按卡片版本引用的记录找到本条目（`entryOf`），对同一记录的取回并入本次等待。
   */
  record?: { path: string; key: string }
  /** 收尾时确定的写回位置（`cardsOf`）；生成记录与结束事件写到这里。未确定时为发起时的画布。 */
  cards?: CardAt[]
}

/** 某张画布中引用任务记录的版本所在的卡片。 */
export interface CardAt {
  path: string
  nodeId: string
  versionId: string
}

export class CanvasStates {
  /** 键：`画布绝对路径#节点 id`。多个工作区并存时相对路径会冲突。 */
  readonly running = new Map<string, RunEntry>()
  readonly failures = new Map<string, string>()

  /**
   * 正在为该卡生成或取回的条目。先按画布路径与卡片查找；画布在等待期间改名或移动后，按该卡版本引用的任务记录查找：
   * 任务的归属以任务记录为准，不以发起时的画布路径为准。`canvasKey` 见 `keyOf`。
   */
  entryOf(root: string, canvasKey: string, node: CanvasNode): RunEntry | undefined {
    const direct = this.running.get(`${canvasKey}#${node.id}`)
    if (direct || node.type !== 'generate') return direct
    const records = new Set(
      node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX)).map((v) => keyOf(root, v.path)),
    )
    if (!records.size) return undefined
    return [...this.running.values()].find((e) => e.record && records.has(e.record.key))
  }

  /** 一个节点的状态，次序见 `CanvasNodeState`。`canvasKey` 见 `keyOf`。 */
  async stateOf(
    workspaceRoot: string,
    canvasKey: string,
    node: CanvasNode,
    lastRun?: CanvasRunRecord,
    newest?: string,
  ): Promise<CanvasNodeState> {
    const exists = (path: string) =>
      stat(join(workspaceRoot, path)).then(
        (s) => s.isFile(),
        () => false,
      )
    if (node.type === 'file') {
      return (await exists(node.path)) ? { state: 'normal' } : { state: 'missing' }
    }
    if (node.type === 'timeline') {
      const found = await Promise.all(node.clips.map((c) => exists(c.path)))
      return found.every(Boolean) ? { state: 'normal' } : { state: 'missing' }
    }
    const key = `${canvasKey}#${node.id}`
    const run = this.entryOf(workspaceRoot, canvasKey, node)
    if (run) {
      return {
        state: 'running',
        startedAt: run.startedAt,
        action: run.action,
        ...(run.version ? { version: run.version } : {}),
        ...(run.requestSent !== undefined && !run.task
          ? { stage: run.requestSent ? ('submitting' as const) : ('preparing' as const) }
          : {}),
        ...(run.task ? { taskId: run.task.taskId } : {}),
        ...(run.phase ? { phase: run.phase } : {}),
        ...(run.retry ? { retry: run.retry } : {}),
      }
    }
    const tasks = node.versions.filter((v) => v.path.endsWith(TASK_SUFFIX))
    const pending = tasks.find((v) => v.id === node.current)
    if (pending) return { state: 'pending', version: pending.id }
    /*
     * 取回的失败只在取回的是最近一次生成时显示：该版本取回失败后被删除，卡片恢复为之前的结果，
     * 只比较当前版本时这次失败（含原因与是否扣费）不再显示。取回更早的任务失败时不显示：卡片上是之后生成的结果。
     */
    const relevant =
      lastRun?.action !== 'retrieve' ||
      !node.current ||
      lastRun.version === node.current ||
      lastRun.version === newest
    if (relevant && (lastRun?.result === 'unknown' || lastRun?.result === 'failed'))
      return {
        state: lastRun.result,
        message: lastRun.message ?? (lastRun.result === 'unknown' ? '远端结果未知' : '生成失败'),
      }
    const failure = this.failures.get(key)
    if (relevant && failure !== undefined) return { state: 'failed', message: failure }
    const current = node.versions.find((v) => v.id === node.current)
    if (!current) return { state: 'empty' }
    return (await exists(current.path)) ? { state: 'normal' } : { state: 'missing' }
  }
}
