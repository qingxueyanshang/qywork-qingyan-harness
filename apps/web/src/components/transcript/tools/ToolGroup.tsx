import { For, Show } from 'solid-js'
import { groupTitle } from '../../../lib/render-items.ts'
import { foldOpen, seedFoldOpen, type TranscriptItem } from '../../../lib/store/index.ts'
import { Fold, foldKey } from '../Fold.tsx'
import { ThinkingFold } from '../ThinkingFold.tsx'
import { ToolCard } from './ToolCard.tsx'

export function ToolGroup(props: { id: string; members: TranscriptItem[] }) {
  const failed = () =>
    props.members.filter((m) => m.kind === 'tool' && m.status === 'failure').length
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

  // 失败计数单独着色，普通操作摘要保持默认颜色。
  return (
    <Fold
      id={foldKey('group', props.id)}
      label={
        <>
          {groupTitle(props.members)}
          <Show when={failed() > 0}>
            ，<span class="fold-failure-count">{failed()} 个失败</span>
          </Show>
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
