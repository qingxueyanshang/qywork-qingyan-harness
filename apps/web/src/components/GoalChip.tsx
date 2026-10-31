/** 输入框顶部的当前目标栏：目标正文、运行状态与停止或继续按钮。 */

import type { Goal } from '@qywork/core'
import { Show } from 'solid-js'
import { interrupt, isRunning, resumeGoal, state } from '../lib/store/index.ts'

/**
 * 目标状态的说明文字。每一种状态都必须有说明，尤其以下两种：
 *
 * - `blocked` 必须原样显示理由。后端强制每一次 blocked 都附带理由
 *   （`run-control.ts` 的 `STOP_NOTE`、触发轮数上限的说明），界面不显示时，
 *   循环已经停止，而用户只看到「受阻」两个字。
 * - `active` 但没有运行中的一轮，含义是「自动继续未开启」。**自动继续标记不落盘**
 *   （`server/runs.ts` 的 `GoalArm`：若落盘，失控后崩溃的循环会在下次
 *   启动时自动恢复运行），因此进程重启、会话恢复之后目标仍保留在账本中，但不会
 *   自动启动新一轮。不说明这一点，界面上呈现的就是「目标仍在、但没有任何动作」。
 */
function goalNote(goal: Goal, running: boolean): string {
  if (goal.status === 'blocked') return `受阻：${goal.blockedReason ?? '未提供理由'}`
  if (goal.status === 'paused') return '已暂停'
  return running ? '自动继续中' : '自动继续未开启，点击「继续」恢复执行'
}

/**
 * 当前目标：内容、是否在运行、能否停止。
 *
 * **自动循环必须可见**：它逐轮自动执行，而界面上只有正文在增长。
 * 因此它常驻在输入框顶部，与等待队列共用同一组状态栏：目标回答「多轮执行
 * 要达成什么」，待办回答「本轮进行到哪一步」，用户应能同时看到这两项。
 *
 * **两个按钮的执行路径**：
 * - **停止 = 中断本轮**（`interrupt`）。run 收尾时服务端把目标置回 `paused`
 *   并解除自动继续标记，因此停止本轮即停止该循环。**不另设「暂停目标」指令**：
 *   同一操作有第二个入口时，两条路径终将对「当前是否已停止」给出不同答案。
 * - **继续 = `goal.resume`**（`resumeGoal`）。它不只把状态改回 `active`，
 *   而是重新启用自动继续，并立即发起一轮。
 *
 * **完成后不显示。** 它回答的是「是否仍在运行」，`completed` 之后不存在该问题。`completed` 是终
 * 态，没有任何出边：保留一个点击后必然被服务端拒绝的「继续」按钮，比不保留更差。
 *
 * **不显示轮数。** 该循环没有轮数上限（见 `core` 中 `Goal` 的注释），因此没有「第几轮 / 共几轮」
 * 可显示。也不显示已执行的轮数：该数值不影响用户的任何决定，显示后只会把
 * 「是否完成」转换为「运行了多久」，而循环是否应停止取决于目标本身，不取决于计数。
 * 用户需要的两项信息都在这一行中：是否在运行，以及如何停止。
 *
 * **单行，且窄于输入框。** 空间不足时先截断目标正文，再截断状态，两处都有悬停提示。高度固定（B9）：
 * 状态文字长短不一，若由内容撑高，「停止」按钮的位置会移动。
 */
export function GoalChip() {
  const goal = () => state.goal
  const live = () => {
    const g = goal()
    return g && g.status !== 'completed' ? g : null
  }

  return (
    <Show when={live()}>
      {(g) => (
        <div class="goal-chip">
          <div class="goal-line">
            <span class="goal-label">目标</span>
            {/* 正文过长时截断并提供悬停提示，不做悬停卡片：卡片承载的信息这一行
                已经显示，唯一的效果是鼠标经过时遮挡下一行。 */}
            <span class="goal-text truncate" data-tip={g().objective}>
              {g().objective}
            </span>
            {/* 状态紧邻「停止」：用户读到运行状态后，紧接着应看到停止按钮。 */}
            <span
              class="goal-note truncate"
              classList={{ blocked: g().status === 'blocked' }}
              data-tip={goalNote(g(), isRunning())}
            >
              {goalNote(g(), isRunning())}
            </span>
            <Show
              when={isRunning()}
              fallback={
                <button class="goal-act" type="button" onClick={resumeGoal}>
                  继续
                </button>
              }
            >
              <button class="goal-act" type="button" onClick={interrupt}>
                停止
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
