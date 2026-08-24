/**
 * 「改了哪些文件」的清单。
 *
 * 用在两处：单发外部 CLI 的工具卡展开体，和图里 CLI 节点的那一页。**两处形状相同**，
 * 各写一遍必然漂移——说的是同一件事。
 *
 * 这份清单是**量出来的一手事实**（跑前跑后各照一棵快照树相 diff），
 * 与 CLI 自己在产出里写的那份并列。工作区不是 git 仓库时整块缺席，
 * 调用方不要拿空数组顶上：空数组的意思是「确定没改」。
 *
 * `total` 大于列出的条数时把总数说出来——只给一截还让人以为是全部，比不给更坏。
 */

import type { FileChange } from '@qywork/core'
import { For, Show } from 'solid-js'

export function ChangeList(props: { changes: FileChange[]; total?: number }) {
  return (
    <div class="change-list">
      <For each={props.changes}>
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
      <Show when={(props.total ?? 0) > props.changes.length}>
        <div class="change-more">共 {props.total} 个文件</div>
      </Show>
    </div>
  )
}
