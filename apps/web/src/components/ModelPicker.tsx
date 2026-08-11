import { createSignal, For, onCleanup, Show } from 'solid-js'
import { activeModel, loadModels, type ModelOption, setModel, state } from '../lib/store/index.ts'
import { IconChevron } from './Icons.tsx'

/**
 * 模型选择器。
 *
 * 模型是**会话级**属性：同一个工作区里一个会话用重模型改代码、另一个用轻模型
 * 快速问答是常态，所以入口放在输入区而不是全局设置里。
 *
 * 列表按需拉取——不是每个会话都会点开它。
 */
export function ModelPicker() {
  const [open, setOpen] = createSignal(false)
  const [models, setModels] = createSignal<ModelOption[]>([])
  const [error, setError] = createSignal<string | null>(null)

  const toggle = async () => {
    if (open()) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (models().length > 0) return
    try {
      setModels(await loadModels())
      setError(null)
    } catch (e) {
      // 拉不到就说拉不到。留一个空列表会让用户以为「没有别的模型可选」。
      setError(e instanceof Error ? e.message : '模型列表加载失败')
    }
  }

  const onDocClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.model-picker')) setOpen(false)
  }
  document.addEventListener('click', onDocClick)
  onCleanup(() => document.removeEventListener('click', onDocClick))

  // 切换期间禁用：run 已经带着旧模型发出去了，中途换不会改变本轮。
  const locked = () => state.running

  return (
    <div class="model-picker">
      <button
        class="mode-chip"
        type="button"
        disabled={locked() || !state.activeConversation}
        title={locked() ? '执行中不能切换模型' : '切换模型'}
        onClick={toggle}
      >
        <span class="truncate">{activeModel() ?? '选择模型'}</span>
        <IconChevron size={11} dir={open() ? 'down' : 'right'} />
      </button>

      <Show when={open()}>
        <div class="model-menu" role="listbox">
          <Show when={error()}>
            <div class="model-menu-error">{error()}</div>
          </Show>
          <For each={models()}>
            {(m) => (
              <button
                class="model-item"
                classList={{ active: m.id === activeModel() }}
                type="button"
                role="option"
                aria-selected={m.id === activeModel()}
                onClick={() => {
                  setModel(m.id)
                  setOpen(false)
                }}
              >
                <span class="truncate">{m.label}</span>
                {/* 自建端点的模型标出来：它没有内置的计价与能力信息，
                    用量和费用只能按 provider 回报的算。 */}
                <Show when={!m.known}>
                  <span class="model-tag">自定义</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
