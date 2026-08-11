import { createSignal, Show } from 'solid-js'
import { interrupt, sendMessage, state } from '../lib/store/index.ts'
import { IconPlus, IconSend, IconShield, IconStop } from './Icons.tsx'
import { ModelPicker } from './ModelPicker.tsx'

/**
 * 输入区。
 *
 * 两条交互决定：
 * - Enter 发送、Shift+Enter 换行。中文输入法组合期间（isComposing）必须放行，
 *   否则用拼音选词时按回车会把半截拼音发出去。
 * - 自适应高度，封顶后转内部滚动，不把会话区挤没。
 */
export function Composer() {
  const [text, setText] = createSignal('')
  let ta!: HTMLTextAreaElement

  const autosize = () => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  const submit = () => {
    const v = text().trim()
    if (!v || state.running) return
    sendMessage(v)
    setText('')
    queueMicrotask(() => {
      ta.style.height = 'auto'
      ta.focus()
    })
  }

  return (
    <div class="composer-wrap">
      <Show when={state.fileChanges.length > 0}>
        <div class="changes-chip">
          <strong>{state.fileChanges.length} 个文件已更改</strong>
          <span class="add">+{state.fileChanges.reduce((s, c) => s + c.additions, 0)}</span>
          <span class="del">-{state.fileChanges.reduce((s, c) => s + c.deletions, 0)}</span>
        </div>
      </Show>

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={ta}
          class="composer-input"
          rows={1}
          placeholder="随心输入"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value)
            autosize()
          }}
          onKeyDown={(e) => {
            // isComposing：中文/日文输入法组合期的回车属于选词，不能当发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div class="composer-bar">
          <button class="icon-btn" type="button" aria-label="添加附件">
            <IconPlus size={16} />
          </button>

          <button class="mode-chip" type="button">
            <IconShield size={13} />
            需要授权
          </button>

          <ModelPicker />

          <Show when={state.context}>
            {(c) => (
              <span
                class="ctx-meter"
                classList={{ warn: c().percent > 75 }}
                title={`${c().tokens.toLocaleString()} / ${c().limit.toLocaleString()} tokens`}
              >
                {c().percent}%
              </span>
            )}
          </Show>

          <span class="spacer" />

          <Show when={state.usage}>
            {(u) => <span class="cost">${u().costUsd.toFixed(4)}</span>}
          </Show>

          <Show
            when={state.running}
            fallback={
              <button class="send-btn" type="submit" disabled={!text().trim()} aria-label="发送">
                <IconSend size={16} />
              </button>
            }
          >
            <button class="send-btn stop" type="button" onClick={interrupt} aria-label="停止">
              <IconStop size={16} />
            </button>
          </Show>
        </div>
      </form>
    </div>
  )
}
