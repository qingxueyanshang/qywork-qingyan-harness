import { todoProgress } from '@qywork/core'
import { Show } from 'solid-js'
import { openPanel, state } from '../lib/store/index.ts'
import { IconSpinner } from './Icons.tsx'

/**
 * 这一轮跑到哪了：进度 + 改了多少。
 *
 * **一条居中的状态条，不是两块各自贴边的东西。** 「已完成 2 / 6」和「7 个文件
 * +303 −47」回答的是同一个问题——这一轮进行得怎么样了，所以同处一枚 chip。
 * 居中是因为它不属于任何一侧的控件，左对齐时看起来像输入框长出来的一个附件。
 *
 * ## 报的是已完成数，不是「第几步」
 *
 * `step` 取的是**正在做**的那一条，第 3 步一个字都还没写就先显示成了进度；
 * 「第 3 / 4 步」不带条目名又会被读成「4 步做完了 3 步」。带条目名的说法留在
 * `write_todos` 的回执里。口径只有 `todoProgress` 一个（core），别在这里重算。
 *
 * ## 两段各有各的出现条件
 *
 * - **进度**：还剩没剩，不是清单有没有条目。全打勾之后不显示——它回答「还要多久」。
 * - **文件**：这一轮的读数，`run.started` 时清空。整条会话改过哪些文件另有右侧
 *   「变更」页，那是从 step 账本投影的永久记录。
 */
export function RunStatus() {
  const todos = () => state.todos
  const progress = () => todoProgress(todos())
  const inProgress = () => todos().some((t) => t.status !== 'completed')
  const files = () => state.fileChanges
  const additions = () => files().reduce((s, c) => s + c.additions, 0)
  const deletions = () => files().reduce((s, c) => s + c.deletions, 0)

  return (
    <Show when={inProgress() || files().length > 0}>
      <div class="run-status">
        <div class="changes-chip">
          <Show when={inProgress()}>
            {/* 转圈只在真的还在跑时给：停下来之后它还在转，是在说一件不成立的事。 */}
            <Show when={state.running}>
              <IconSpinner size={12} />
            </Show>
            {/* 完整清单在右侧面板，这里只报进度：给出的数必须有去处。 */}
            <button
              class="run-jump"
              type="button"
              title="查看完整待办"
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
              title="查看这条会话的变更"
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
