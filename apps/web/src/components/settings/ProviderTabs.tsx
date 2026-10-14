import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconChevron } from '../Icons.tsx'

/** 接口标签按实际宽度折叠，当前查看的接口始终保留在主栏。 */
export function ProviderTabs(props: {
  names: string[]
  current: string | null
  live: string | undefined
  library: boolean
  onPick: (name: string) => void
  children?: JSX.Element
}) {
  let root!: HTMLDivElement
  let tabs!: HTMLDivElement
  let list!: HTMLDivElement
  let measure!: HTMLDivElement
  let moreMeasure!: HTMLSpanElement
  let more!: HTMLButtonElement
  const [visible, setVisible] = createSignal<string[] | null>(null)
  const [open, setOpen] = createSignal(false)
  const shown = () => props.names.filter((name) => visible()?.includes(name) ?? true)
  const hidden = () => props.names.filter((name) => !shown().includes(name))

  const close = () => setOpen(false)
  const layout = () => {
    if (!tabs.isConnected || tabs.clientWidth === 0) return
    const style = getComputedStyle(list)
    const gap = Number.parseFloat(style.columnGap) || 0
    const available = tabs.clientWidth - (Number.parseFloat(style.paddingLeft) || 0)
    const widths = [...measure.children].map((item) => item.getBoundingClientRect().width)
    const total = widths.reduce((sum, width) => sum + width, 0)
    if (total + gap * Math.max(0, widths.length - 1) <= available) {
      setVisible([...props.names])
    } else {
      const selected = props.names.indexOf(props.current ?? '')
      const keep = new Set<number>(selected < 0 ? [] : [selected])
      let used =
        moreMeasure.getBoundingClientRect().width +
        (Number.parseFloat(getComputedStyle(tabs).columnGap) || 0)
      if (selected >= 0) used += widths[selected]!
      for (let i = 0; i < widths.length; i++) {
        if (i === selected) continue
        const next = used + widths[i]! + (keep.size ? gap : 0)
        if (next > available) break
        keep.add(i)
        used = next
      }
      setVisible(props.names.filter((_, i) => keep.has(i)))
    }
    close()
  }

  createEffect(() => {
    props.names
    props.current
    queueMicrotask(layout)
  })

  onMount(() => {
    const observer = new ResizeObserver(layout)
    observer.observe(tabs)
    observer.observe(measure)
    observer.observe(moreMeasure)
    layout()
    onCleanup(() => observer.disconnect())
  })

  const menuItems = () => [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const toggle = () => {
    setOpen(!open())
    if (open()) menuItems()[0]?.focus()
  }
  const onOutside = (event: PointerEvent) => {
    if (!tabs.contains(event.target as Node)) close()
  }
  const onScroll = (event: Event) => {
    if (!(event.target as Element).closest?.('.provider-tabs-menu')) close()
  }
  const onKey = (event: KeyboardEvent) => {
    if (!tabs.contains(event.target as Node)) return
    if (event.key === 'Escape' && open()) {
      event.preventDefault()
      event.stopPropagation()
      close()
      more.focus()
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (!open() && event.target !== more) return
      event.preventDefault()
      const wasOpen = open()
      setOpen(true)
      const items = menuItems()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === 'Home' || (!wasOpen && event.key === 'ArrowDown')
          ? 0
          : event.key === 'End' || (!wasOpen && event.key === 'ArrowUp')
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }
  document.addEventListener('pointerdown', onOutside)
  document.addEventListener('keydown', onKey)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', close)
  onCleanup(() => {
    document.removeEventListener('pointerdown', onOutside)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', close)
  })

  return (
    <div class="tab-strip" ref={root}>
      <div class="provider-tabs" ref={tabs}>
        <div class="provider-tabs-measure" ref={measure} aria-hidden="true">
          <For each={props.names}>
            {(name) => (
              <span class="provider-tab-measure provider-tab">
                <span class="truncate">{name}</span>
              </span>
            )}
          </For>
        </div>
        <span class="provider-more-measure" ref={moreMeasure} aria-hidden="true">
          更多 <IconChevron size={11} />
        </span>
        <div class="provider-tab-list" ref={list}>
          <For each={shown()}>
            {(name) => (
              <button
                class="tab-chip provider-tab"
                classList={{
                  active: !props.library && props.current === name,
                  live: props.live === name,
                }}
                type="button"
                title={name}
                aria-pressed={!props.library && props.current === name}
                onClick={() => props.onPick(name)}
              >
                <span class="truncate">{name}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={hidden().length > 0}>
          <button
            ref={more}
            class="tab-chip provider-more"
            type="button"
            aria-label="更多接口"
            aria-haspopup="menu"
            aria-expanded={open()}
            onClick={toggle}
          >
            更多 <IconChevron size={11} dir={open() ? 'up' : 'down'} />
          </button>
          <Show when={open()}>
            <AnchoredMenu class="provider-tabs-menu" anchor={more} lockHeight>
              <For each={hidden()}>
                {(name) => (
                  <button
                    class="provider-menu-item"
                    classList={{ live: props.live === name }}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close()
                      props.onPick(name)
                      queueMicrotask(() => {
                        root.querySelector<HTMLButtonElement>('.provider-tab.active')?.focus()
                      })
                    }}
                  >
                    {name}
                  </button>
                )}
              </For>
            </AnchoredMenu>
          </Show>
        </Show>
      </div>
      <div class="provider-tab-actions">{props.children}</div>
    </div>
  )
}
