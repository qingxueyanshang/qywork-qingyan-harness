/**
 * 看板中 Office 一行的文件选择框：打开即列出工作区中该格式的文件，输入时按名称筛选，选中一个即交给调用方。
 *
 * 筛选由服务端的预览分类判定（`/api/files/find` 的 `office`），本组件不持有扩展名清单。
 * 尺寸固定，结果在框内滚动；样式为独立的 `.office-picker` 规则，不与其他浮层共用选择器。
 */

import { For, onCleanup, onMount, Show } from 'solid-js'
import { createFileSearch, type OfficeFormat } from '../../lib/file-search.ts'
import { holdOverlay } from '../../lib/store/index.ts'
import FileTypeIcon from '../FileTypeIcon.tsx'

export function OfficePicker(props: {
  format: OfficeFormat
  onPick: (path: string) => void
  onClose: () => void
}) {
  // 内置浏览器页是原生子视图，渲染在所有 DOM 之上；浮层打开时需先将其移出可视区。
  holdOverlay(() => true)
  const { hits, error, search } = createFileSearch(() => ({ office: props.format }))
  search('')

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      props.onClose()
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="取消" onClick={props.onClose} />
      <div class="sheet-backdrop pass-through">
        <div class="office-picker" role="dialog" aria-modal="true" aria-label="选择文件">
          <input
            type="search"
            placeholder="搜索文件"
            spellcheck={false}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => search(e.currentTarget.value)}
          />
          <div class="office-picker-list">
            <Show when={error()}>{(m) => <div class="office-picker-error">{m()}</div>}</Show>
            <For each={hits()}>
              {(path) => (
                <button type="button" data-tip={path} onClick={() => props.onPick(path)}>
                  <FileTypeIcon name={path} />
                  <span class="truncate">{path}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </>
  )
}
