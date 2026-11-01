/**
 * 桌面宠物窗口的页面（`pet.html`）。外壳以透明、无边框、置顶的窗口加载它。
 *
 * 只显示主窗口推送的状态（`pet-window.ts`），不连接服务：未查看结果只在主窗口记录一份。
 * 不 import store：store 在导入时即创建服务连接对象，宠物窗口不需要它。
 *
 * 窗口有三种尺寸：只容纳宠物、宠物加气泡、宠物加列表。列表的高度在打开时按行数确定，
 * 打开期间不随内容变化（B9）。外壳调整尺寸时固定底边与宠物所在的一侧，宠物在屏幕上的位置不变。
 */

import { createEffect, createSignal, For, onMount, Show, untrack } from 'solid-js'
import {
  PET_ACTION_EVENT,
  PET_MOVED_EVENT,
  PET_READY_EVENT,
  PET_STATE_EVENT,
  PET_WINDOW_MOVED_EVENT,
  type PetAnchor,
  type PetWindowAction,
  type PetWindowState,
} from '../../lib/pet-protocol.ts'
import { tauriEmitTo, tauriInvoke, tauriListen } from '../../lib/store/shell.ts'
import { IconCheck, IconSpinner, IconStop, IconX } from '../Icons.tsx'
import { PetSprite } from './PetSprite.tsx'

/** 宠物四周的留白：容纳角标与动作的位移。 */
const PAD = 14
/** 展开时的宽度，以及气泡、列表与窗口顶边和宠物之间的间距。 */
const EXPANDED_W = 260
const GAP = 8
const BUBBLE_H = 34
/** 列表一行的高度（与 `.petw-row-main` 一致）、最多显示的行数、内边距与边框之和。 */
const ROW_H = 30
const MENU_MAX_ROWS = 6
const MENU_CHROME = 10
/** 指针移动超过该距离即视为拖动，否则视为点击。 */
const DRAG_THRESHOLD = 4

const MAIN = 'main'

function act(a: PetWindowAction): void {
  void tauriEmitTo(MAIN, PET_ACTION_EVENT, a).catch(() => undefined)
}

function openConversation(id: string): void {
  void tauriInvoke('pet_open_main', { conversationId: id }).catch(() => undefined)
}

export function PetWindow() {
  const [view, setView] = createSignal<PetWindowState | null>(null)
  /** 列表打开时的行数，0 表示关闭。打开期间行数增加时多出的行在框内滚动。 */
  const [menuRows, setMenuRows] = createSignal(0)

  /**
   * 最近一次请求的窗口尺寸与宠物所在的一侧。外壳按请求的顺序调整并发出移动事件，
   * 调整引起的移动事件到达时窗口已是该尺寸；第一次请求之前窗口位置来自保存值或缺省位置，不需要上报。
   */
  let layout: { width: number; height: number; compact: number; leftward: boolean } | null = null

  onMount(() => {
    void tauriListen<PetWindowState>(PET_STATE_EVENT, setView).then(() =>
      tauriEmitTo(MAIN, PET_READY_EVENT, null),
    )
    void tauriListen<{ x: number; y: number }>(PET_WINDOW_MOVED_EVENT, (at) => {
      if (!layout) return
      const anchor: PetAnchor = {
        left: at.x + (layout.leftward ? layout.width - layout.compact : 0),
        bottom: at.y + layout.height,
      }
      void tauriEmitTo(MAIN, PET_MOVED_EVENT, anchor).catch(() => undefined)
    }).catch(() => undefined)
  })

  // 列表只列出运行中的会话与未查看的结果，没有条目时不显示空框。
  createEffect(() => {
    if (view()?.entries.length === 0) setMenuRows(0)
  })
  const toggleMenu = () => {
    const count = view()?.entries.length ?? 0
    setMenuRows(menuRows() ? 0 : Math.min(count, MENU_MAX_ROWS))
  }
  const menuHeight = () => menuRows() * ROW_H + MENU_CHROME

  /**
   * 向左展开：宠物右侧到屏幕工作区右边缘的空间不足展开宽度时为 true，宠物改为固定在右下角。
   * 只在由紧凑变为展开时判定，收起时沿用，否则收起后宠物在屏幕上移位。
   */
  const [leftward, setLeftward] = createSignal(false)
  let expanded = false
  createEffect(() => {
    const v = view()
    if (!v) return
    const compact = v.pack.size + PAD * 2
    const above = menuRows() ? menuHeight() : v.bubble ? BUBBLE_H : 0
    if (above && !expanded) {
      // `availLeft` 是 Chromium 提供的非标准属性，DOM 类型声明中没有。
      const area = screen as Screen & { availLeft: number }
      setLeftward(window.screenX + EXPANDED_W > area.availLeft + area.availWidth)
    }
    expanded = above > 0
    const size = above
      ? { width: EXPANDED_W, height: compact + above + GAP * 2 }
      : { width: compact, height: compact }
    layout = { ...size, compact, leftward: untrack(leftward) }
    void tauriInvoke('pet_window_resize', { ...size, leftward: layout.leftward }).catch(
      () => undefined,
    )
  })

  createEffect(() => {
    const dark = view()?.dark
    if (dark !== undefined)
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  })

  // 拖动与点击共用一次按下：移动超过阈值时交给系统拖动窗口，否则在抬起时视为点击。
  let down: { x: number; y: number } | null = null
  let dragging = false
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    down = { x: e.screenX, y: e.screenY }
    dragging = false
  }
  const onMove = (e: PointerEvent) => {
    if (!down || dragging) return
    if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > DRAG_THRESHOLD) {
      dragging = true
      down = null
      void tauriInvoke('plugin:window|start_dragging').catch(() => undefined)
    }
  }
  const onUp = () => {
    if (down && !dragging) toggleMenu()
    down = null
  }

  return (
    <Show when={view()}>
      {(v) => (
        <div class="petw" classList={{ leftward: leftward() }}>
          <Show when={menuRows()}>
            <div class="petw-menu" style={{ top: `${GAP}px`, height: `${menuHeight()}px` }}>
              <div class="petw-list">
                <For each={v().entries}>
                  {(e) => (
                    <div class="petw-row">
                      <button
                        class="petw-row-main"
                        type="button"
                        onClick={() => {
                          setMenuRows(0)
                          openConversation(e.conversationId)
                        }}
                      >
                        <span class={`petw-row-icon ${e.status}`}>
                          <Show
                            when={e.status === 'running'}
                            fallback={
                              e.status === 'done' ? <IconCheck size={13} /> : <IconX size={13} />
                            }
                          >
                            <IconSpinner size={13} />
                          </Show>
                        </span>
                        <span class="petw-title">{e.title}</span>
                      </button>
                      <Show when={e.status === 'running'}>
                        <button
                          class="petw-stop"
                          type="button"
                          aria-label="停止"
                          onClick={() => act({ type: 'stop', id: e.conversationId })}
                        >
                          <IconStop size={12} />
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={!menuRows() && v().bubble}>
            {(b) => (
              <button
                class="petw-bubble"
                type="button"
                style={{ top: `${GAP}px`, height: `${BUBBLE_H}px` }}
                onClick={() => openConversation(b().conversationId)}
              >
                <span class="petw-title">{b().title}</span>
                <span class="petw-bubble-state" classList={{ failed: b().outcome === 'failed' }}>
                  {b().outcome === 'done' ? '已完成' : '出错'}
                </span>
              </button>
            )}
          </Show>
          <div
            class="petw-pet"
            style={{ padding: `${PAD}px` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            <PetSprite pack={v().pack} state={v().mood} frameUrl={(n) => v().frames[n] ?? ''} />
            <Show when={v().badge}>{(t) => <span class="petw-badge">{t()}</span>}</Show>
          </div>
        </div>
      )}
    </Show>
  )
}
