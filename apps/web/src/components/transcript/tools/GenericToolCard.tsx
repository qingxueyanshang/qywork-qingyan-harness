import { For, Show } from 'solid-js'
import { actionDetail } from '../../../lib/render-items.ts'
import { fileDelta, resultImages, statusWord } from '../../../lib/step-view.ts'
import type { TranscriptItem } from '../../../lib/store/index.ts'
import { Fold, foldKey } from '../Fold.tsx'
import { StepBody } from './StepBody.tsx'

/**
 * 没有专用卡片的工具：折叠条目，标题为「开头 · 动词 对象」，展开内容由 `StepBody` 按动作选择。
 * 开头、动词与对象都取自 `step.action` 与 `outcome.subject`，不按工具名推断。
 * `onHeadDblClick` 由专用卡片传入。
 */
export function GenericToolCard(props: { item: TranscriptItem; onHeadDblClick?: () => void }) {
  const changes = () => fileDelta(props.item.outcome?.fileChanges)
  const detail = () => actionDetail(props.item)
  const images = () =>
    props.item.outcome?.presentation?.images === 'inline'
      ? resultImages(props.item.outcome.data)
      : []
  return (
    <>
      <Fold
        id={foldKey('tool', props.item.id)}
        failed={props.item.status === 'failure'}
        label={props.item.action?.head ?? ''}
        statusWord={statusWord(props.item.status, props.item.outcome, props.item.imagesUndelivered)}
        {...(detail() ? { target: detail() } : {})}
        {...(changes() ? { changes: changes()! } : {})}
        {...(props.onHeadDblClick ? { onHeadDblClick: props.onHeadDblClick } : {})}
      >
        <StepBody item={props.item} />
      </Fold>
      {/* 模型的视觉输入默认不在会话流中显示。只有工具结果明确声明 inline 时，才把账本中的
          同一份图片渲染到会话流；read_file 读取的图片因此不会显示为用户附件。 */}
      <Show when={images().length > 0}>
        <div class="tool-images">
          <For each={images()}>
            {(img, index) => (
              <img
                src={`data:${img.mime};base64,${img.data}`}
                alt={`${detail() || '工具结果'} 图片 ${index() + 1}`}
                loading="lazy"
              />
            )}
          </For>
        </div>
      </Show>
    </>
  )
}
