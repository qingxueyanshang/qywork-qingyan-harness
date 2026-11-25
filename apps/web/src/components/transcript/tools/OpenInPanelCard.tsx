import { Show } from 'solid-js'
import { panelTargetOf, type TranscriptItem } from '../../../lib/store/index.ts'
import { GenericToolCard } from './GenericToolCard.tsx'

/**
 * `open_in_panel`：通用卡片加「打开」按钮。窄屏上工具成功后不自动打开（面板覆盖全屏），由此按钮打开；
 * 宽屏上用于重新打开已关闭的页。该工具独立成行（`render-items.ts` 的 `STANDALONE`），不并入工具组：
 * 位于折叠的工具组中时按钮不可见。
 */
export function OpenInPanelCard(props: { item: TranscriptItem }) {
  const open = () =>
    props.item.status === 'success' ? panelTargetOf(props.item.outcome?.data) : null
  return (
    <div class="open-in-panel">
      <GenericToolCard item={props.item} />
      <Show when={open()}>
        {(run) => (
          <button class="btn-ghost sm" type="button" onClick={() => run()()}>
            打开
          </button>
        )}
      </Show>
    </div>
  )
}
