/**
 * 定时任务调度。
 *
 * **触发语义**：
 * - **跑在哪个会话**：每次触发新建一个会话，标题取任务标题。复用同一个会话的话，几十次触发
 *   之后上下文会长到每一轮都在压缩，而且任务之间会互相看见——「每天的日报」不该记得昨天那次的
 *   中间过程。新建会话也让每次触发都留下一个可以点开的现场。
 * - **跑在哪个项目**：按任务自己的 `workspaceRoot` 查工作区，不按服务启动时的目录筛选。
 *   一个服务进程同时服务多个项目，按启动目录筛选会让别的项目的任务永远不触发。
 * - **权限按谁算**：与手动发消息完全一致（同一个 `startRun`、同一份 config）。
 *   给定时任务单开一档权限等于造一条绕过裁决的路。
 * - **失败了谁看得见**：落在这一次触发建的那条 Run 上，任务表不存第二份终态。
 * - **会话忙就跳过**：上一轮还没落终态就不叠加，判据是 runs 表而不是本进程的 RunManager。
 *
 * 到期判定、忙态检查、建会话、推进游标在 `claimDueSchedules` 的单个写事务里完成，只有提交
 * 成功的一方才起轮；起轮照旧非阻塞，一个慢模型不会拖住下一次 tick。
 *
 * **`start` 由 `server.ts` 注入**，与 `api/types.ts` 里那条同一个理由：`startRun` 住在
 * `run-control.ts`，而调度只需要「起一轮」这一个动作，不需要 bus / runs / 子 agent 登记表。
 */

import type { ConversationId } from '@qywork/core'
import { log } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { claimDueSchedules, type Store } from '@qywork/store'

/**
 * 30 秒一跳。
 *
 * 调度精度是分钟级（`diagnoseSchedule` 拒绝小于 1 分钟的间隔），30 秒的 tick 保证分钟边界
 * 不会被整体错过一格。
 */
const SCHEDULER_TICK_MS = 30_000

export interface SchedulerDeps {
  store: Store
  /** 建会话时定死的接口与模型，取 `active`。 */
  config: QyConfig
  /** 起一轮。装配方接到与手动发消息完全相同的那条路径上。 */
  start(conversationId: ConversationId, prompt: string): Promise<void>
}

/**
 * 推进一次：认领这一刻所有到期的任务，逐条起轮。
 *
 * **每条单独收口异常。** 认领已经提交（游标推进、会话建好），一条起轮失败不能把后面那些
 * 已提交的认领一起跳掉——跳掉的那些不会重试，等于静默丢一次触发。失败的那条留下的是
 * 「有会话、无 Run」，界面按「没有执行记录」显示，成因写进 stderr。
 */
export async function tickSchedules(deps: SchedulerDeps): Promise<void> {
  // 没配默认模型就不认领：定时任务要按 active 建会话，没有 active 就无从起轮。
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
      await deps.start(claim.conversationId, claim.schedule.prompt)
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
