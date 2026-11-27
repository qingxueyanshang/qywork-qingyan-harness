import { For, Show } from 'solid-js'
import { groupTitle } from '../../../lib/render-items.ts'
import { statusWord } from '../../../lib/step-view.ts'
import { foldOpen, seedFoldOpen, type TranscriptItem } from '../../../lib/store/index.ts'
import { Fold, foldKey } from '../Fold.tsx'
import { ThinkingFold } from '../ThinkingFold.tsx'
import { ToolCard } from './ToolCard.tsx'

export function ToolGroup(props: { id: string; members: TranscriptItem[] }) {
  /**
   * 有问题的调用按状态词计数，与各行行尾的状态词相同（「失败 1 次」「已中断 1 次」「部分完成 1 次」），
   * 按首次出现的顺序排列。失败类状态单独着色，其余保持默认颜色。
   */
  const states = () => {
    const counts = new Map<string, { n: number; failed: boolean }>()
    for (const m of props.members) {
      if (m.kind !== 'tool') continue
      const word = statusWord(m.status, m.outcome, m.imagesUndelivered)
      if (!word) continue
      const c = counts.get(word) ?? { n: 0, failed: m.status === 'failure' }
      c.n += 1
      counts.set(word, c)
    }
    return [...counts]
  }
  /*
   * 分组卡片创建时的展开状态取决于其成员在创建时是否已展开。用户正在查看一个展开的单条
   * 工具时，下一个工具启动会把它合并进分组卡片；分组卡片以收起状态创建会隐藏正在查看的
   * 内容。该值只写入一次，此后分组卡片与成员的展开状态均由用户控制。
   */
  seedFoldOpen(
    foldKey('group', props.id),
    props.members.some(
      (m) => (m.kind === 'tool' || m.kind === 'thinking') && foldOpen(foldKey(m.kind, m.id)),
    ),
  )

  // 标题行不显示组内合计的增删行数：增删行数只在展开后的各文件行显示。
  return (
    <Fold
      id={foldKey('group', props.id)}
      label={
        <>
          {groupTitle(props.members)}
          <For each={states()}>
            {([word, c]) => (
              <>
                ，<span classList={{ 'fold-failure-count': c.failed }}>{`${word} ${c.n} 次`}</span>
              </>
            )}
          </For>
        </>
      }
    >
      <div class="fold-group">
        <For each={props.members}>
          {(m) => (
            <Show when={m.kind === 'tool'} fallback={<ThinkingFold item={m} />}>
              <ToolCard item={m} />
            </Show>
          )}
        </For>
      </div>
    </Fold>
  )
}
