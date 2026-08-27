import { todoProgress } from '@qywork/core'
import { Show } from 'solid-js'
import { hasRunStatus, openPanel, state } from '../lib/store/index.ts'
import { IconSpinner } from './Icons.tsx'

/**
 * 这一轮跑到哪了：进度 + 改了多少。
 *
 * **一条居中的状态条，不是两块各自贴边的读数。** 「已完成 2 / 6」和「7 个文件
 * +303 −47」回答的是同一个问题——这一轮进行得怎么样了，所以同处一枚 chip。
 * 居中是因为它不属于任何一侧的控件，左对齐时看起来像输入框长出来的一个附件。
 *
 * **报的是已完成数，不是「第几步」。** `step` 取的是**正在做**的那一条，第 3 步一个字都还没写就先显
 * 示成了进度；「第 3 / 4 步」不带条目名又会被读成「4 步做完了 3 步」。带条目名的说法留在
 * `write_todos` 的回执里。口径只有 `todoProgress` 一个（core），别在这里重算。
 *
 * **只在跑着时挂。** 跑完整条就撤掉——停着的时候它是一枚常驻的浮层，
 * 而它说的两件事都另有去处：清单在右侧「待办」页，变更在「变更」页。
 * 每轮开始时按当下状态重新决定挂不挂，所以「上一轮没做完的待办」下一轮照样显示。
 *
 * **判据是「有一轮在跑」，不是「这条会话忙」。** 忙闲由 `sendMessage` 在按下回车那一刻
 * 乐观置上，而这一轮的文件读数要等服务端的 `run.started` 才清空——中间隔着一次往返
 * 加一次历史装配（`session.ts` 的 `buildHistory` 要读全部 steps 与附件），实测最小
 * 1.6ms，带附件的长会话远不止。只按忙闲挂的话，这一枚 chip 会带着**上一轮**的文件
 * 读数出现，过几帧再自己缩掉那一段。`runStartedAt` 由 `run.started` 立、`run.finished`
 * 清，两处都与读数的清空写在同一个 handler 里，按它挂两端都没有这个窗口。
 *
 * 忙闲那一半仍要判：重拉会话时 `runStartedAt` 取自账本里 `status='running'` 的那一行，
 * 服务进程崩过之后那一行不再成立（同 `reloadActiveConversation` 的说明）。
 *
 * 两段各自的条件：
 *
 * - **进度**：还剩没剩，不是清单有没有条目。全打勾之后不显示——它回答「还要多久」。
 * - **文件**：这一轮的读数，`run.started` 时清空。
 */
export function RunStatus() {
  const todos = () => state.todos
  const progress = () => todoProgress(todos())
  const inProgress = () => todos().some((t) => t.status !== 'completed')
  const files = () => state.fileChanges
  const additions = () => files().reduce((s, c) => s + c.additions, 0)
  const deletions = () => files().reduce((s, c) => s + c.deletions, 0)

  return (
    <Show when={hasRunStatus()}>
      <div class="run-status">
        <div class="changes-chip">
          <Show when={inProgress()}>
            <IconSpinner size={12} />
            {/* 完整清单在右侧面板，这里只报进度：给出的数必须有去处。 */}
            <button
              class="run-jump"
              type="button"
              data-tip="查看完整待办"
              onClick={() => openPanel('todos')}
            >
              已完成 {progress().done} / {progress().total}
            </button>
          </Show>
          {/* 两段都在时才要分隔点——只有一段时它会变成一个悬空的符号。 */}
          <Show when={inProgress() && files().length > 0}>
            <span class="sep" aria-hidden="true">
              ·
            </span>
          </Show>
          <Show when={files().length > 0}>
            <button
              class="run-jump"
              type="button"
              data-tip="查看这条会话的变更"
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
