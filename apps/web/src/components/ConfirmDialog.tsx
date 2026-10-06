import { createEffect, onCleanup, Show } from 'solid-js'
import { holdOverlay } from '../lib/store/index.ts'

/**
 * 确认弹窗。
 *
 * **不采用就地展开。** 不要把确认句放进侧栏的行内：左栏只有 232px，一句带边界声明的文字要折成三行，
 * 把下方的项目挤开；且它覆盖在列表上，看起来像列表显示异常。
 * 破坏性操作的确认属于中断操作，应使用获取焦点的弹窗。
 *
 * **开合状态不进入全局状态。** 确认框的开合只属于触发它的那一行。做成全局状态需要为每个调用点命名，
 * 还要把上下文写入全局 store。此处只受 `open` 一个 prop 控制。
 */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  /** 仅补充标题未包含的必要信息。 */
  message?: string | undefined
  /** 确认按钮的文字。使用动词本身（「移除」「归档」），不写「确定」。 */
  confirmLabel: string
  /** 仅在操作不可逆时设为 true，按钮显示为危险色。 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  // 内置浏览器页是原生子视图，渲染在所有 DOM 之上；浮层打开时需先将其移出可视区。
  holdOverlay(() => props.open)

  createEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <Show when={props.open}>
      {/* 遮罩是对话框的兄弟节点而不是父节点：作为父节点是无效 HTML
          （button 内不能放交互内容），且需要 stopPropagation 才能避免误触发。 */}
      <button class="backdrop-close" type="button" aria-label="取消" onClick={props.onCancel} />
      <div class="sheet-backdrop pass-through">
        <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={props.title}>
          <h2 class="confirm-title">{props.title}</h2>
          <Show when={props.message}>
            <p class="confirm-message">{props.message}</p>
          </Show>
          <div class="confirm-actions">
            <button class="btn-ghost" type="button" onClick={props.onCancel}>
              取消
            </button>
            <button
              class="btn-primary"
              classList={{ danger: props.danger }}
              type="button"
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
