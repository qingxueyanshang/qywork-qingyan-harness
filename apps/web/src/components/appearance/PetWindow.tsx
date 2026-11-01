/**
 * 桌面宠物窗口的页面（`pet.html`）。外壳以透明、无边框、置顶的窗口加载它。
 *
 * 只显示主窗口推送的状态（`pet-window.ts`），不连接服务：未查看结果只在主窗口记录一份。
 * 不 import store：store 在导入时即创建服务连接对象，宠物窗口不需要它。
 *
 * 窗口有两种尺寸：只容纳宠物的紧凑尺寸，与容纳气泡或列表的展开尺寸。尺寸只在展开状态改变时切换，
 * 不随内容变化（B9）；外壳按左下角固定调整，宠物在屏幕上的位置不变。
 */

import { createEffect, createSignal, For, onMount, Show } from 'solid-js'
import {
  PET_ACTION_EVENT,
  PET_READY_EVENT,
  PET_STATE_EVENT,
  type PetWindowAction,
  type PetWindowState,
} from '../../lib/pet-protocol.ts'
import { tauriEmitTo, tauriInvoke, tauriListen } from '../../lib/store/shell.ts'
import { IconCheck, IconSpinner, IconStop, IconX } from '../Icons.tsx'
import { PetSprite } from './PetSprite.tsx'

/** 宠物四周的留白：容纳角标与动作的位移。 */
const PAD = 14
/** 展开时的宽度与气泡、列表所需的高度。 */
const EXPANDED_W = 260
const EXPANDED_EXTRA_H = 236
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
  const [open, setOpen] = createSignal(false)

  onMount(() => {
    void tauriListen<PetWindowState>(PET_STATE_EVENT, setView).then(() =>
      tauriEmitTo(MAIN, PET_READY_EVENT, null),
    )
  })

  const expanded = () => open() || view()?.bubble != null
  createEffect(() => {
    const v = view()
    if (!v) return
    const compact = v.pack.size + PAD * 2
    const size = expanded()
      ? { width: EXPANDED_W, height: compact + EXPANDED_EXTRA_H }
      : { width: compact, height: compact }
    void tauriInvoke('pet_window_resize', size).catch(() => undefined)
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
    if (down && !dragging) setOpen(!open())
    down = null
  }

  return (
    <Show when={view()}>
      {(v) => (
        <div class="petw">
          <Show when={open()}>
            <div class="petw-menu">
              <div class="petw-list">
                <For each={v().entries}>
                  {(e) => (
                    <div class="petw-row">
                      <button
                        class="petw-row-main"
                        type="button"
                        onClick={() => openConversation(e.conversationId)}
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
              <div class="petw-split" />
              <button class="petw-item" type="button" onClick={() => act({ type: 'hide' })}>
                隐藏宠物
              </button>
            </div>
          </Show>
          <Show when={!open() && v().bubble}>
            {(b) => (
              <button
                class="petw-bubble"
                type="button"
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
