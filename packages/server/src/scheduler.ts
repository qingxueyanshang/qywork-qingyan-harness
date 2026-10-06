/**
 * 定时任务调度。
 *
 * **触发语义**：
 * - **运行所在的会话**：默认发送到创建该任务的会话，prompt 作为一条用户消息进入，上下文
 *   跨次延续，模型据此能延续上一次的内容，也能用 `delete_schedule` 自行停止任务。声明了
 *   `newConversation` 的任务每次另建一条会话，各次互不可见。上下文增长由既有压缩机制处理。
 * - **运行所在的项目**：按任务自身的 `workspaceRoot` 查询工作区，不按服务启动时的目录筛选。
 *   一个服务进程同时服务多个项目，按启动目录筛选会使其他项目的任务永远不触发。
 * - **权限**：与手动发送消息完全一致（同一个 `submitMessage`、同一份 config）。
 *   为定时任务单独设置权限等于提供一条绕过裁决的路径。
 * - **失败记录**：写入本次触发的 Run，任务表不保存第二份终态。
 * - **会话忙碌时跳过**：上一轮尚未进入终态时不叠加，判据是 runs 表而不是本进程的 RunManager。
 *
 * 到期判定、忙态检查、取得会话、推进游标在 `claimDueSchedules` 的单个写事务中完成，只有提交
 * 成功的一方才投递；投递仍为非阻塞，响应缓慢的模型不会阻塞下一次 tick。
 *
 * **`submit` 由 `server.ts` 注入**，理由与 `api/types.ts` 中的相同：投递逻辑位于
 * `run-control.ts` 与 `bus.ts`，而调度只需要交付一次触发这一个操作，不需要
 * bus / runs / 子 agent 登记表。
 */

import { log } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { claimDueSchedules, type ScheduleClaim, type Store } from '@qywork/store'

/**
 * 每 30 秒执行一次 tick。
 *
 * 调度精度是分钟级（`diagnoseSchedule` 拒绝小于 1 分钟的间隔），30 秒的 tick 保证分钟边界
 * 不会被错过。
 */
const SCHEDULER_TICK_MS = 30_000

export interface SchedulerDeps {
  canStart?: () => boolean
  store: Store
  /** 创建会话时固定的接口与模型，取自 `active`。 */
  config: QyConfig
  /**
   * 交付一次触发：先广播新建的会话，再将 prompt 作为一条用户消息发送。
   * 装配方将其接入与手动发送消息完全相同的路径。
   */
  submit(claim: ScheduleClaim): Promise<void>
}

/**
 * 执行一次 tick：认领当前所有到期的任务，逐条投递。
 *
 * **每条单独捕获异常。** 认领已提交（游标已推进、会话已确定），一条投递失败不能导致其后
 * 已提交的认领一并跳过：跳过的认领不会重试，等于静默丢失一次触发。失败的投递留下
 * 「有会话、无 Run」的状态，界面显示为「没有执行记录」，原因写入 stderr。
 */
export async function tickSchedules(deps: SchedulerDeps): Promise<void> {
  if (deps.canStart?.() === false) return
  // 未配置默认模型时不认领：认领需要按 active 确定会话的接口与模型，没有 active 则无法启动轮次。
  // 不认领时任务保持到期状态，配置模型后照常触发，不会静默丢失一次触发。
  const active = deps.config.active
  if (!active) return
  const claims = claimDueSchedules(deps.store, {
    now: Date.now(),
    provider: active.provider,
    model: active.model,
  })
  for (const claim of claims) {
    try {
      await deps.submit(claim)
    } catch (err) {
      log.error(
        'scheduler',
        `定时任务「${claim.schedule.title}」启动失败：${err instanceof Error ? err.message : String(err)}`,
        { scheduleId: claim.schedule.id },
      )
    }
  }
}

/**
 * 启动计时器。`unref()` 使其不阻止进程退出：定时任务不应导致进程无法退出。
 *
 * 此处只捕获认领本身的失败（账本读写异常）：计时器回调中未处理的拒绝会终止进程。
 * 单条启动的失败在 `tickSchedules` 中就地捕获，不会到达此处。
 */
export function startScheduler(deps: SchedulerDeps, tickMs = SCHEDULER_TICK_MS): { stop(): void } {
  const timer = setInterval(() => {
    void tickSchedules(deps).catch((err) => {
      log.error(
        'scheduler',
        `定时任务认领失败：${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }, tickMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
    },
  }
}
