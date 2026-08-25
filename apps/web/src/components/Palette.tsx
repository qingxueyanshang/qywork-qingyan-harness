import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { buildCommands } from '../lib/commands.ts'
import { paletteOpen, setPaletteOpen } from '../lib/store/index.ts'

/**
 * 命令面板。
 *
 * 键盘可达性是这里的全部意义，所以焦点管理不能省：打开时抢焦点、
 * Esc 关闭、上下键选择、关闭后把焦点还给打开它的那个元素——不还的话焦点回到
 * 文档开头，键盘用户要从头 Tab 一遍。
 *
 * **命令表不在这里**，在 `lib/commands.ts`——输入区的斜杠命令用的是同一份。
 * 两份清单必然漂移成「Ctrl-K 搜得到、打 / 搜不到」，而那种不一致没人会当成 bug。
 */
export function Palette() {
  const [query, setQuery] = createSignal('')
  const [cursor, setCursor] = createSignal(0)
  let input!: HTMLInputElement
  let restoreFocus: HTMLElement | null = null

  const commands = () => buildCommands()

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return commands()
    return commands().filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
  })

  createEffect(() => {
    if (paletteOpen()) {
      restoreFocus = document.activeElement as HTMLElement | null
      setQuery('')
      setCursor(0)
      queueMicrotask(() => input?.focus())
    } else {
      restoreFocus?.focus()
      restoreFocus = null
    }
  })

  const close = () => setPaletteOpen(false)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, filtered().length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      filtered()[cursor()]?.run()
      close()
    }
  }

  onCleanup(() => {
    restoreFocus = null
  })

  return (
    <Show when={paletteOpen()}>
      {/* 同 Sheet：关闭遮罩是兄弟节点而不是父节点。Esc 由 onKey 处理。 */}
      <button class="backdrop-close" type="button" aria-label="关闭" onClick={close} />
      <div class="palette-backdrop pass-through">
        <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
          <input
            ref={input}
            class="palette-input"
            placeholder="搜索命令"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setCursor(0)
            }}
            onKeyDown={onKey}
          />
          <ul class="palette-list">
            <For each={filtered()}>
              {(cmd, i) => (
                <li>
                  <button
                    class="palette-item"
                    classList={{ active: i() === cursor() }}
                    type="button"
                    onMouseEnter={() => setCursor(i())}
                    onClick={() => {
                      cmd.run()
                      close()
                    }}
                  >
                    <span class="palette-icon">{cmd.icon({ size: 15 }) as never}</span>
                    {cmd.label}
                    {/* hint 是代价说明不是快捷键，所以不用 <kbd>。 */}
                    <Show when={cmd.hint}>
                      <span class="palette-hint truncate">{cmd.hint}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </Show>
  )
}
