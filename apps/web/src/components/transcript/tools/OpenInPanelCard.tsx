import { type TranscriptItem, togglePanelTarget } from '../../../lib/store/index.ts'
import { GenericToolCard } from './GenericToolCard.tsx'

/**
 * `open_in_panel`：通用卡片，成功后双击标题行在面板中打开或收起该目标（`togglePanelTarget`）。
 * 面板由界面在工具成功后自动打开（`events/tools.ts`）。
 */
export function OpenInPanelCard(props: { item: TranscriptItem }) {
  return (
    <GenericToolCard
      item={props.item}
      onHeadDblClick={() => {
        if (props.item.status === 'success') togglePanelTarget(props.item.outcome?.data)
      }}
    />
  )
}
