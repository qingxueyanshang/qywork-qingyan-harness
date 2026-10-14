import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import type { MediaParamOption } from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconCheck, IconChevron, IconPlay, IconSpinner, IconStop } from '../Icons.tsx'

export interface ParamChoice {
  text: string
  of: unknown
  checked: () => boolean
  pick: () => void
}

/** 大量选项的搜索菜单；音色说明与试听使用模型目录，不按音色编号猜测。 */
export function ParamPicker(props: { param: MediaParamOption; choices: ParamChoice[] }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [preview, setPreview] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const id = createUniqueId()
  let trigger!: HTMLButtonElement
  let audio!: HTMLAudioElement
  let sequence = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const current = () => props.choices.find((c) => c.checked())
  const description = (c: ParamChoice | undefined) =>
    c ? props.param.valueDescriptions?.[String(c.of)] : undefined
  const filtered = createMemo(() => {
    const q = query().trim().toLocaleLowerCase()
    return props.choices.filter((c) =>
      `${c.text} ${String(c.of ?? '')} ${description(c) ?? ''}`.toLocaleLowerCase().includes(q),
    )
  })
  const stop = () => {
    sequence++
    clearTimeout(timeout)
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    setPreview(null)
    setLoading(false)
  }
  const close = (focus = false) => {
    setOpen(false)
    stop()
    if (focus) trigger.focus()
  }
  onCleanup(stop)
  createEffect(() => {
    if (!open()) return
    const outside = (e: Event) => {
      const target = e.target as Element | null
      if (trigger.contains(target) || target?.closest(`#${id}`)) return
      close()
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    const reposition = () => close()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', onEscape, true)
    window.addEventListener('resize', reposition)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('resize', reposition)
    })
  })
  const listen = async (c: ParamChoice) => {
    const key = String(c.of)
    const sample = props.param.valueSamples?.[key]
    if (!sample) return
    const wasPlaying = preview() === key
    stop()
    setError('')
    if (wasPlaying) return
    const request = sequence
    setPreview(key)
    setLoading(true)
    timeout = setTimeout(() => {
      if (request !== sequence) return
      stop()
      setError('试听加载超时，请重试')
    }, 15000)
    audio.src = sample.url
    try {
      await audio.play()
      if (request === sequence) {
        clearTimeout(timeout)
        setLoading(false)
      }
    } catch {
      if (request === sequence) {
        stop()
        setError('试听暂不可用，请重试')
      }
    }
  }
  const sampleButton = (c: ParamChoice) => (
    <Show when={props.param.valueSamples?.[String(c.of)]}>
      {(sample) => (
        <button
          class="canvas-param-preview"
          type="button"
          aria-label={`${preview() === String(c.of) ? '停止试听' : '试听'} ${c.text}`}
          title={sample().label ? `官方样音 · ${sample().label}` : '官方样音'}
          onClick={() => void listen(c)}
        >
          <Show when={preview() === String(c.of)} fallback={<IconPlay size={12} />}>
            <Show when={loading()} fallback={<IconStop size={12} />}>
              <IconSpinner size={12} />
            </Show>
          </Show>
          <span>{sample().label || '试听'}</span>
        </button>
      )}
    </Show>
  )
  const move = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const options = [...document.querySelectorAll<HTMLButtonElement>(`#${id} [data-param-option]`)]
    if (!options.length) return
    e.preventDefault()
    const i = options.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? options.length - 1
          : (i + (e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
    options[next]?.focus()
  }
  return (
    <div class="canvas-param-dropdown">
      <audio
        ref={audio}
        preload="none"
        onEnded={stop}
        onError={() => {
          if (preview() === null) return
          stop()
          setError('试听暂不可用，请重试')
        }}
      />
      <div class="canvas-param-dropdown-current">
        <button
          ref={trigger}
          class="canvas-param-trigger"
          type="button"
          aria-label={props.param.label}
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-controls={open() ? id : undefined}
          onClick={() => {
            if (open()) close()
            else {
              setQuery('')
              setOpen(true)
            }
          }}
        >
          <span class="truncate">{current()?.text ?? '请选择'}</span>
          <IconChevron size={12} dir={open() ? 'up' : 'down'} />
        </button>
        <Show when={current()}>{(choice) => sampleButton(choice())}</Show>
      </div>
      <Show when={description(current())}>
        <p class="canvas-param-description">{description(current())}</p>
      </Show>
      <Show when={error()}>
        <output class="canvas-param-error">{error()}</output>
      </Show>
      <Show when={open()}>
        <Portal>
          <AnchoredMenu class="canvas-param-picker" anchor={trigger} placement="below-start">
            <div id={id} class="canvas-param-picker-content">
              <input
                type="search"
                aria-label={`搜索${props.param.label}`}
                placeholder={props.param.name === 'voice' ? '搜索名称、特点或编号' : '搜索选项'}
                ref={(el) =>
                  queueMicrotask(() => {
                    if (el.isConnected) el.focus()
                  })
                }
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={move}
              />
              <div class="canvas-param-options">
                <For each={filtered()}>
                  {(c) => (
                    <div class="canvas-param-option" classList={{ selected: c.checked() }}>
                      <button
                        data-param-option
                        type="button"
                        role="menuitemradio"
                        aria-checked={c.checked()}
                        onKeyDown={move}
                        onClick={() => {
                          c.pick()
                          close(true)
                        }}
                      >
                        <span class="canvas-param-option-name">
                          {c.text}
                          <Show when={c.checked()}>
                            <IconCheck size={12} />
                          </Show>
                        </span>
                        <Show when={description(c)}>
                          <span class="canvas-param-description">{description(c)}</span>
                        </Show>
                        <Show when={props.param.name === 'voice'}>
                          <span class="canvas-param-id">{String(c.of ?? '')}</span>
                        </Show>
                      </button>
                      {sampleButton(c)}
                    </div>
                  )}
                </For>
                <Show when={!filtered().length}>
                  <p class="canvas-param-description">没有匹配的选项</p>
                </Show>
              </div>
              <Show when={error()}>
                <output class="canvas-param-error">{error()}</output>
              </Show>
            </div>
          </AnchoredMenu>
        </Portal>
      </Show>
    </div>
  )
}
