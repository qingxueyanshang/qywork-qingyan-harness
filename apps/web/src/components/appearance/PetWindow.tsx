/**
 * 桌面宠物窗口的页面（`pet.html`）。外壳以透明、无边框、置顶的窗口加载它。
 *
 * 只显示主窗口推送的状态（`pet-window.ts`），不连接服务：未查看结果只在主窗口记录一份。
 * 不 import store：store 在导入时即创建服务连接对象，宠物窗口不需要它。
 *
 * 窗口只容纳宠物，尺寸只随宠物包改变。气泡与列表在任务框窗口中（`PetBox.tsx`）：
 * 窗口位置改变的那一帧 WebView 仍按左上角显示上一帧画面，放在同一个窗口中展开时宠物会跳动一次。
 */

import { createEffect, onMount, Show } from 'solid-js'
import {
  PET_BOX_LABEL,
  PET_BOX_TOGGLE_EVENT,
  PET_MOVED_EVENT,
  PET_WINDOW_MOVED_EVENT,
  type PetAnchor,
} from '../../lib/pet-protocol.ts'
import { tauriEmitTo, tauriInvoke, tauriListen } from '../../lib/store/shell.ts'
import { PetSprite } from './PetSprite.tsx'
import { MAIN_WINDOW, petView } from './pet-view.ts'

/** 宠物四周的留白：容纳角标与动作的位移。 */
const PAD = 14
/** 指针移动超过该距离即视为拖动，否则视为点击。 */
const DRAG_THRESHOLD = 4

export function PetWindow() {
  const view = petView()

  /** 最近一次请求的边长。第一次请求之前窗口位置来自保存值或缺省位置，不需要上报。 */
  let side = 0
  createEffect(() => {
    const v = view()
    if (!v) return
    const next = v.pack.size + PAD * 2
    if (next === side) return
    side = next
    void tauriInvoke('pet_window_resize', { width: next, height: next }).catch(() => undefined)
  })

  onMount(() => {
    void tauriListen<{ x: number; y: number }>(PET_WINDOW_MOVED_EVENT, (at) => {
      if (!side) return
      const anchor: PetAnchor = { left: at.x, bottom: at.y + side }
      void tauriEmitTo(MAIN_WINDOW, PET_MOVED_EVENT, anchor).catch(() => undefined)
    }).catch(() => undefined)
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
    if (down && !dragging)
      void tauriEmitTo(PET_BOX_LABEL, PET_BOX_TOGGLE_EVENT, null).catch(() => undefined)
    down = null
  }

  return (
    <Show when={view()}>
      {(v) => (
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
      )}
    </Show>
  )
}
