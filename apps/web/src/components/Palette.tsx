import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  compactContext,
  newConversation,
  openPanel,
  paletteOpen,
  setPaletteOpen,
  setSettingsOpen,
  state,
} from '../lib/store/index.ts'
import { IconEye, IconFile, IconNewChat, IconSettings, IconSpinner, IconUsers } from './Icons.tsx'

interface Command {
  id: string
  label: string
  hint: string
  icon: (p: { size?: number }) => unknown
  run(): void
}

/**
 * 命令面板。
 *
 * 键盘可达性是这里的全部意义，所以焦点管理不能省：打开时抢焦点、
 * Esc 关闭、上下键选择、关闭后把焦点还给原来的元素——否则用鼠标点开一次之后
 * 键盘用户就找不着北了。
 */
export function Palette() {
  const [query, setQuery] = createSignal('')
  const [cursor, setCursor] = createSignal(0)
  let input!: HTMLInputElement
  let restoreFocus: HTMLElement | null = null

  /**
   * 命令表。
   *
   * 这里曾经有三条不产生任何效果的命令：`browser` 是空函数，`terminal` 挂着
   * 「终端」的名字实际只是收起面板（Web 端根本没有终端——PTY 在 Rust 侧），
   * `新对话` 同样是空函数。命令面板里的死命令比侧边栏的死按钮更隐蔽：
   * 它藏在搜索结果里，用户搜到了、按下回车、什么都没发生，还以为自己搜错了。
   *
   * 现在每一条都能点出结果，删掉的两条对应的能力本来就不存在。
   */
  const commands: Command[] = [
    { id: 'new', label: '新对话', hint: '', icon: IconNewChat, run: () => void newConversation() },
    {
      id: 'review',
      label: '审阅改动',
      hint: '',
      icon: IconEye,
      run: () => openPanel('git'),
    },
    {
      id: 'files',
      label: '文件',
      hint: '',
      icon: IconFile,
      run: () => openPanel('files'),
    },
    { id: 'team', label: '协作', hint: '', icon: IconUsers, run: () => openPanel('team') },
    {
      id: 'settings',
      label: '设置',
      hint: '',
      icon: IconSettings,
      run: () => setSettingsOpen(true),
    },
    {
      id: 'compact',
      // 文案说清代价：压缩不可见地改变模型能看到的东西，
      // 只写「压缩上下文」的话用户不知道自己按下去会发生什么。
      label: state.context ? `压缩上下文（当前 ${state.context.percent}%）` : '压缩上下文',
      hint: '',
      icon: IconSpinner,
      run: compactContext,
    },
  ]

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
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
      {/* 同 PairSheet：关闭遮罩是兄弟节点而不是父节点。Esc 由 onKey 处理。 */}
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
                    <Show when={cmd.hint}>
                      <kbd>{cmd.hint}</kbd>
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
