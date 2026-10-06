import { foldFileChanges, todoProgress } from '@qywork/core'
import { Show } from 'solid-js'
import { activeDesktopTarget, hasRunStatus, openPanel, state } from '../lib/store/index.ts'
import { IconSpinner } from './Icons.tsx'

/**
 * 本轮的执行状态：进度与改动量。
 *
 * **一条居中的状态条，不是两块分别贴边的读数。** 「已完成 2 / 6」与「7 个文件
 * +303 −47」回答同一个问题：本轮的执行进展，因此放在同一个 chip 中。
 * 居中显示是因为它不属于任何一侧的控件，左对齐时会被误认为输入框的附件。
 *
 * **显示已完成数，不显示「第几步」。** `step` 取的是**正在执行**的条目，第 3 步尚未产生任何输出时
 * 就会显示为进度；「第 3 / 4 步」不带条目名时会被理解为「4 步中已完成 3 步」。带条目名的表述保留在
 * `write_todos` 的回执中。进度口径只有 `todoProgress`（core）一处，不要在此处重新计算。
 *
 * **只在运行时显示。** 执行完毕即隐藏：停止状态下它会成为常驻浮层，
 * 而它显示的两项内容另有位置：清单在右侧「待办」页，变更在「变更」页。
 * 每轮开始时按当前状态重新决定是否显示，因此上一轮未完成的待办在下一轮仍会显示。
 *
 * **判据是「有一轮正在运行」，不是「当前会话忙碌」。** 忙碌状态由 `sendMessage` 在按下回车时
 * 乐观设置，而本轮的文件读数要等服务端的 `run.started` 才清空，中间经过一次往返
 * 与一次历史装配（`session.ts` 的 `buildHistory` 需读取全部 steps 与附件），实测最短
 * 1.6ms，带附件的长会话耗时更长。只按忙碌状态显示时，chip 会带着**上一轮**的文件
 * 读数出现，数帧后再缩小。`runStartedAt` 由 `run.started` 设置、由 `run.finished`
 * 清除，两处都与读数的清空位于同一个 handler 中，按它判定时不存在该时间窗口。
 *
 * 仍需同时判定忙碌状态：重新获取会话时 `runStartedAt` 取自账本中 `status='running'` 的行，
 * 服务进程崩溃后该行不再有效（同 `reloadActiveConversation` 的说明）。
 *
 * 三段各自的显示条件：
 *
 * - **目标应用**：当前会话正在操作的应用。归属由持有桌面的执行者决定，释放或宿主
 *   断开时由服务端清空；其他会话的目标不在本轮显示。
 * - **进度**：是否还有未完成的条目，而不是清单是否非空。全部完成后不显示：它回答的是剩余进度。
 * - **文件**：本轮的读数，`run.started` 时清空。新建后又删除的文件不计入，与变更页一致。
 */
export function RunStatus() {
  const todos = () => state.todos
  const progress = () => todoProgress(todos())
  const inProgress = () => todos().some((t) => t.status !== 'completed')
  // 与变更页使用同一折叠函数：观察器判定的写入不带行数，累加时跳过缺失值，合计不因此变为未知。
  const files = () => foldFileChanges(state.fileChanges)
  const additions = () => files().reduce((s, c) => s + c.additions, 0)
  const deletions = () => files().reduce((s, c) => s + c.deletions, 0)

  return (
    <Show when={hasRunStatus()}>
      <div class="run-status">
        <div class="changes-chip">
          {/* 目标应用没有可跳转的页面，因此显示为文字而不是按钮。 */}
          <Show when={activeDesktopTarget()}>
            {(target) => (
              <span>
                {target().foreground ? '正在前台操作' : '正在操作'} {target().app}
              </span>
            )}
          </Show>
          <Show when={activeDesktopTarget() && (inProgress() || files().length > 0)}>
            <span class="sep" aria-hidden="true">
              ·
            </span>
          </Show>
          <Show when={inProgress()}>
            <IconSpinner size={12} />
            {/* 完整清单在右侧面板，此处只显示进度；显示的数值必须能跳转到对应明细。 */}
            <button
              class="run-jump"
              type="button"
              data-tip="查看完整待办"
              onClick={() => openPanel('todos')}
            >
              已完成 {progress().done} / {progress().total}
            </button>
          </Show>
          {/* 两段同时显示时才显示分隔点；只有一段时分隔点会孤立显示。 */}
          <Show when={inProgress() && files().length > 0}>
            <span class="sep" aria-hidden="true">
              ·
            </span>
          </Show>
          <Show when={files().length > 0}>
            <button
              class="run-jump"
              type="button"
              data-tip="查看本会话的变更"
              onClick={() => openPanel('changes')}
            >
              {files().length} 个文件
              <span class="add">+{additions()}</span>
              <span class="del">-{deletions()}</span>
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}
