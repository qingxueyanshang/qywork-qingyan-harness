/**
 * 外部 CLI 这一次改了哪些文件。
 *
 * 用在两处：单发的工具卡展开体，和图里 CLI 节点的那一页。**两处形状相同**，
 * 各写一遍必然漂移——说的是同一件事。
 *
 * 这份清单是**量出来的一手事实**（跑前跑后各照一棵快照树相 diff），
 * 与 CLI 自己在产出里写的那份并列。
 *
 * **「量不了」与「没有改动」是两件事**：前者给 `unmeasured` 一句原因，
 * 后者是 `changes.total === 0`。把前者显示成「没有改动」是撒谎。
 */

import type { FileChange } from '@qywork/core'
import { For, Show } from 'solid-js'

export function ChangeList(props: {
  changes?: { files: FileChange[]; total: number }
  unmeasured?: string
}) {
  return (
    <div class="change-list">
      <For each={props.changes?.files}>
        {(c) => (
          <div class="change-line">
            <span class="truncate-left" dir="ltr">
              {c.path}
            </span>
            {/* 删掉的不报行数：画成 +0 −0 会被读成「什么都没改」。 */}
            <Show
              when={c.changeType !== 'deleted'}
              fallback={<span class="change-gone">已删除</span>}
            >
              <span class="change-delta">
                <span class="add">+{c.additions}</span>
                <span class="del">−{c.deletions}</span>
              </span>
            </Show>
          </div>
        )}
      </For>
      {/* 被截掉的那些由它说出来。**只在真截了的时候出现**：条数与总数相等时这一行是废话。 */}
      <Show when={(props.changes?.total ?? 0) > (props.changes?.files.length ?? 0)}>
        <div class="change-note">共 {props.changes?.total} 个文件</div>
      </Show>
      <Show when={props.changes?.total === 0}>
        <div class="change-note">没有改动</div>
      </Show>
      {/* 能力边界，不是解释：这一次没有一手清单，界面上没有第二处说得出这件事。 */}
      <Show when={props.unmeasured}>
        <div class="change-note">{props.unmeasured}</div>
      </Show>
    </div>
  )
}
