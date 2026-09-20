/**
 * 定时任务调度。
 *
 * **触发语义**：
 * - **跑在哪个会话**：默认发回建这条任务的那条会话，prompt 作为一条用户消息进去，上下文
 *   跨次延续，模型据此能接着上一次说的话做，也能用 `delete_schedule` 自己停掉。声明了
 *   `newConversation` 的任务每次另建一条，各次互不可见。上下文增长由既有压缩机制处理。
 * - **跑在哪个项目**：按任务自己的 `workspaceRoot` 查工作区，不按服务启动时的目录筛选。
 *   一个服务进程同时服务多个项目，按启动目录筛选会让别的项目的任务永远不触发。
 * - **权限按谁算**：与手动发消息完全一致（同一个 `submitMessage`、同一份 config）。
 *   给定时任务单开一档权限等于造一条绕过裁决的路。
 * - **失败了谁看得见**：落在这一次触发的那条 Run 上，任务表不存第二份终态。
 * - **会话忙就跳过**：上一轮还没落终态就不叠加，判据是 runs 表而不是本进程的 RunManager。
 *
 * 到期判定、忙态检查、取会话、推进游标在 `claimDueSchedules` 的单个写事务里完成，只有提交
 * 成功的一方才投递；投递照旧非阻塞，一个慢模型不会拖住下一次 tick。
 *
 * **`submit` 由 `server.ts` 注入**，与 `api/types.ts` 里那条同一个理由：投递住在
 * `run-control.ts` 与 `bus.ts`，而调度只需要「交付一次触发」这一个动作，不需要
 * bus / runs / 子 agent 登记表。
 */

import { log } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { claimDueSchedules, type ScheduleClaim, type Store } from '@qywork/store'

/**
 * 30 秒一跳。
 *
 * 调度精度是分钟级（`diagnoseSchedule` 拒绝小于 1 分钟的间隔），30 秒的 tick 保证分钟边界
 * 不会被整体错过一格。
 */
const SCHEDULER_TICK_MS = 30_000

export interface SchedulerDeps {
  canStart?: () => boolean
  store: Store
  /** 建会话时定死的接口与模型，取 `active`。 */
  config: QyConfig
  /**
   * 交付一次触发：新建的会话先广播，再把 prompt 作为一条用户消息发进去。
   * 装配方接到与手动发消息完全相同的那条路径上。
   */
  submit(claim: ScheduleClaim): Promise<void>
}

/**
 * 推进一次：认领这一刻所有到期的任务，逐条投递。
 *
 * **每条单独收口异常。** 认领已经提交（游标推进、会话取定），一条投递失败不能把后面那些
 * 已提交的认领一起跳掉——跳掉的那些不会重试，等于静默丢一次触发。失败的那条留下的是
 * 「有会话、无 Run」，界面按「没有执行记录」显示，成因写进 stderr。
 */
export async function tickSchedules(deps: SchedulerDeps): Promise<void> {
  if (deps.canStart?.() === false) return
  // 没配默认模型就不认领：认领要按 active 定会话的接口与模型，没有 active 就无从起轮。
  // 不认领 = 任务留在到期状态，配好模型后照常触发，不静默丢一次。
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
        `定时任务「${claim.schedule.title}」起轮失败：${err instanceof Error ? err.message : String(err)}`,
        { scheduleId: claim.schedule.id },
      )
    }
  }
}

/**
 * 挂上计时器。`unref()` 让它不阻止进程退出——定时任务不该成为关不掉的理由。
 *
 * 这里只收口认领本身的失败（账本读写异常）：计时器回调里的未处理拒绝会终止进程。
 * 单条起轮的失败在 `tickSchedules` 里就地收口，不会走到这里。
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
