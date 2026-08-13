import type { JSX } from 'solid-js'
import { createEffect, onCleanup } from 'solid-js'
import { closeOverlay } from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'

/**
 * 浮层外壳。标题 + 关闭 + 一块可滚动的内容区。
 *
 * 抽出来是因为四个浮层原本各写了一遍同样的三层结构（遮罩、对话框、头），
 * 而「Esc 关不掉」这类毛病每复制一遍就要再修一遍——`PairPanel` 的 Esc 是
 * 后来单独补的，其余几个当时并没有跟上。
 *
 * 关闭遮罩是对话框的**兄弟节点**，不是父节点：套成父节点是无效 HTML
 * （button 里不能放交互内容），还得靠 stopPropagation 才不误触发，
 * 而那正是 a11y 规则在拦的形状。
 */
export function Sheet(props: {
  title: string
  /** 标题右侧的次要说明，可省。用于「这个面板的边界」，不写引导语。 */
  note?: string
  wide?: boolean
  children: JSX.Element
}) {
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="关闭" onClick={closeOverlay} />
      <div class="sheet-backdrop pass-through">
        <div
          class="sheet"
          classList={{ 'sheet-wide': props.wide }}
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
        >
          <header class="sheet-head">
            <span class="sheet-title">{props.title}</span>
            {props.note ? <span class="sheet-note">{props.note}</span> : null}
            <button
              class="icon-btn"
              type="button"
              aria-label="关闭"
              style={{ 'margin-left': 'auto' }}
              onClick={closeOverlay}
            >
              <IconX size={15} />
            </button>
          </header>
          <div class="sheet-body">{props.children}</div>
        </div>
      </div>
    </>
  )
}
