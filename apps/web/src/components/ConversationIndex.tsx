import type { ConversationTurnRef } from '@qywork/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from 'solid-js'
import type { TranscriptItem } from '../lib/store/index.ts'
import { activeTurn, turnIds, turnPreview } from '../lib/turn-index.ts'

/**
 * 会话索引：整条会话的每条用户输入一条刻度，当前所在的一条以颜色区分；悬停显示摘要，点击定位到该条。
 *
 * 刻度包含尚未加载的条目（`earlier`）；已加载的条目与会话流中的行按 `data-turn` 对应。
 * 位置在滚动时从 DOM 读取，不另存一份：屏幕外条目的高度是占位值，进入视口后才改为实际值，缓存的位置会过期。
 */
export function ConversationIndex(props: {
  /** 早于已加载内容的用户输入。 */
  earlier: readonly ConversationTurnRef[]
  items: TranscriptItem[]
  /** 会话流的滚动容器。挂载后才可读取。 */
  scroller: () => HTMLElement
  /** 定位到指定 id 的用户输入。由滚动状态机执行：它负责加载未加载的条目，并使定位后不被底部跟随写回。 */
  onJump: (id: string) => void
}) {
  // 刻度不足两条时列表未挂载，此时为 undefined。
  let list: HTMLDivElement | undefined
  const ids = createMemo(() => turnIds(props.earlier, props.items))
  const [active, setActive] = createSignal<string | null>(null)
  const [hovered, setHovered] = createSignal<{ id: string; top: number } | null>(null)

  const rows = () => [...props.scroller().querySelectorAll<HTMLElement>('.row.user[data-turn]')]

  let frame = 0
  const measure = () => {
    frame = 0
    const scroller = props.scroller()
    const found = rows()
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 2
    const at = activeTurn(
      found.map((row) => row.getBoundingClientRect().top),
      line,
    )
    setActive(found[at]?.dataset.turn ?? null)
  }
  // 每帧至多读取一次布局：平滑滚动时一次滚轮派发多个 scroll 事件。
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }

  onMount(() => {
    const scroller = props.scroller()
    scroller.addEventListener('scroll', schedule, { passive: true })
    onCleanup(() => {
      scroller.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    })
  })
  createEffect(() => {
    ids()
    schedule()
  })

  // 刻度多于一屏时列表自身滚动，当前项保持在列表中部。
  createEffect(() => {
    const id = active()
    if (!list) return
    const tick = [...list.children].find((el) => (el as HTMLElement).dataset.turn === id)
    if (tick) list.scrollTop = (tick as HTMLElement).offsetTop - list.clientHeight / 2
  })

  const show = (id: string, tick: HTMLElement) =>
    setHovered({ id, top: tick.offsetTop - (list?.scrollTop ?? 0) + tick.offsetHeight / 2 })
  const preview = createMemo(() => {
    const at = hovered()
    return at ? turnPreview(props.earlier, props.items, at.id) : null
  })

  return (
    // 只有一条用户输入时没有可定位的目标，不显示。
    <Show when={ids().length > 1}>
      <nav class="turn-index" aria-label="会话索引" onPointerLeave={() => setHovered(null)}>
        <div class="turn-index-list" ref={list}>
          <For each={ids()}>
            {(id) => (
              <button
                class="turn-tick"
                classList={{ active: active() === id }}
                type="button"
                data-turn={id}
                // 标题只取决于用户输入的正文，不随回复的流式更新重新计算。
                aria-label={untrack(() => turnPreview(props.earlier, props.items, id)?.title)}
                aria-current={active() === id ? 'true' : undefined}
                onPointerEnter={(e) => show(id, e.currentTarget)}
                onFocus={(e) => show(id, e.currentTarget)}
                onBlur={() => setHovered(null)}
                onClick={() => props.onJump(id)}
              />
            )}
          </For>
        </div>
        <Show when={preview()}>
          {(p) => (
            <div class="turn-index-card" style={{ top: `${hovered()?.top ?? 0}px` }}>
              <div class="turn-index-title">{p().title}</div>
              <div class="turn-index-reply">{p().reply}</div>
            </div>
          )}
        </Show>
      </nav>
    </Show>
  )
}
