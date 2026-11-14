import { createSignal, Show } from 'solid-js'

/** 用户名的长度上限，与云端相同；超出时云端拒绝写入。 */
const NAME_MAX = 30

/** 未设置用户名时按钮的文字，也是输入框为空时的占位文字。 */
const UNSET = '设置用户名'

/**
 * 账号弹窗头部的用户名：点击后原地改为输入框，Enter 或失去焦点时保存，Escape 放弃；保存空内容即清除。
 * 按钮与输入框的高度相同，进入编辑时宽度也相同，头部其余内容不移动。内容未改变时不调用 `onSave`。
 */
export function NameEdit(props: { name: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = createSignal(false)
  /** 输入框的当前内容：编辑状态的宽度随它变化（样式见 `.account-name-sizer`）。 */
  const [draft, setDraft] = createSignal('')

  // 输入框移除时浏览器可能再触发一次 blur，`editing` 已为 false，不重复保存。
  const commit = (value: string) => {
    if (!editing()) return
    setEditing(false)
    const next = value.trim()
    if (next !== props.name) props.onSave(next)
  }

  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          class="account-name"
          classList={{ unset: !props.name }}
          onClick={() => {
            setDraft(props.name)
            setEditing(true)
          }}
        >
          {props.name || UNSET}
        </button>
      }
    >
      <span class="account-name-edit">
        <span class="account-name-sizer" classList={{ unset: !draft() }} aria-hidden="true">
          {draft() || UNSET}
        </span>
        <input
          class="account-name-input"
          aria-label="用户名"
          placeholder={UNSET}
          maxLength={NAME_MAX}
          value={draft()}
          ref={(el) =>
            queueMicrotask(() => {
              el.focus()
              el.select()
            })
          }
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          // 用原生监听并阻止冒泡：账号弹窗在 window 上监听 Escape 关闭自身，放弃编辑时弹窗须保留。
          on:keydown={(e) => {
            if (e.isComposing) return
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
        />
      </span>
    </Show>
  )
}
