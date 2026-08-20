import { createEffect, onCleanup, Show } from 'solid-js'

/**
 * 确认弹窗。
 *
 * ## 为什么不是就地展开
 *
 * 别把确认句塞进侧栏那一行里：左栏只有 232px，一句带边界声明的话要折三行，
 * 把下面的项目挤开；而它盖在列表上，看起来像列表自己坏了。
 * 破坏性动作的确认属于「打断」——它就该是一个夺焦点的弹窗。
 *
 * ## 开合不进全局状态
 *
 * 确认框的开合只属于按下按钮的那一行。做成全局状态就要为每个调用点编一个名字，
 * 还得把上下文塞进全局 store。这里只受 `open` 这一个 prop 控制。
 */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  /** 一句话说清后果与边界。B7：能力边界要留全，不折叠、不降对比度。 */
  message: string
  /** 确认按钮的文字。用动词本身（「移除」「归档」），不写「确定」。 */
  confirmLabel: string
  /** 真的会毁东西时才给 true，按钮转成危险色。 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
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
      {/* 遮罩是对话框的兄弟节点而不是父节点：套成父节点是无效 HTML
          （button 里不能放交互内容），还得靠 stopPropagation 才不误触发。 */}
      <button class="backdrop-close" type="button" aria-label="取消" onClick={props.onCancel} />
      <div class="sheet-backdrop pass-through">
        <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={props.title}>
          <h2 class="confirm-title">{props.title}</h2>
          <p class="confirm-message">{props.message}</p>
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
