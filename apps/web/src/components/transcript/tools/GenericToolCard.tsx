import { For, Show } from 'solid-js'
import { desktopWindowLabel } from '../../../lib/desktop-target.ts'
import { actionLabel } from '../../../lib/render-items.ts'
import {
  displayTarget,
  fileDelta,
  readRange,
  resultImages,
  statusWord,
} from '../../../lib/step-view.ts'
import { browserTabLabel, type TranscriptItem } from '../../../lib/store/index.ts'
import { Fold, foldKey } from '../Fold.tsx'
import { StepBody } from './StepBody.tsx'

/**
 * 动作行末尾显示的目标。浏览器工具的 `action.target` 是宿主的 tabId（打开新页面时是占位字符串），
 * 仅用于权限与冲突判定；界面显示该页面的标签页标题，页面已关闭时显示参数中的地址，两者都没有时不显示。
 * 电脑控制工具同理：`action.target` 是不透明的窗口编号，界面显示结果中返回的窗口标题。
 * 分段读取文件时在路径后附加实际读取的行号范围。
 */
function shownTarget(item: TranscriptItem): string | undefined {
  if (item.toolName === 'write_file' && item.status === 'success') {
    const actualPath = item.outcome?.fileChanges?.[0]?.path
    if (actualPath) return displayTarget(actualPath)
  }
  const target = item.action?.target
  if (!target) return undefined
  if (item.toolName === 'read_file') {
    const range = readRange(item.outcome?.data)
    return range ? `${displayTarget(target)}:${range}` : displayTarget(target)
  }
  if (item.toolName?.startsWith('desktop_')) return desktopWindowLabel(item.outcome?.data)
  if (!item.toolName?.startsWith('browser_')) return displayTarget(target)
  const url = item.args?.url
  return browserTabLabel(target) ?? (typeof url === 'string' ? url : undefined)
}

/** 没有专用卡片的工具：折叠条目，展开内容由 `StepBody` 按动作选择。 */
export function GenericToolCard(props: { item: TranscriptItem }) {
  const changes = () => fileDelta(props.item.outcome?.fileChanges)
  const images = () =>
    props.item.outcome?.presentation?.images === 'inline'
      ? resultImages(props.item.outcome.data)
      : []
  return (
    <>
      <Fold
        id={foldKey('tool', props.item.id)}
        failed={props.item.status === 'failure'}
        label={actionLabel(props.item)}
        statusWord={statusWord(props.item.status, props.item.imagesUndelivered)}
        {...(shownTarget(props.item) ? { target: shownTarget(props.item)! } : {})}
        {...(changes() ? { changes: changes()! } : {})}
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
                alt={`${props.item.action?.target ?? '工具结果'} 图片 ${index() + 1}`}
                loading="lazy"
              />
            )}
          </For>
        </div>
      </Show>
    </>
  )
}
