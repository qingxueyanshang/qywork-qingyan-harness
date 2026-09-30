/** 画布上的菜单与弹出块：点到它们之外、或按 Esc 就收起。 */

import { createEffect, onCleanup } from 'solid-js'

/** 这些浮层之内的点击不算「之外」。 */
const INSIDE =
  '.canvas-menu, .canvas-pick, .canvas-made, .canvas-picker, .canvas-params-panel, .canvas-bar-menu'

export function dismissOnOutside(
  open: () => { anchor: HTMLElement } | null,
  close: () => void,
): void {
  createEffect(() => {
    const current = open()
    if (!current) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest(INSIDE) || current.anchor.contains(target)) return
      close()
    }
    // Esc 只收最上层：不往外传，画布那一层的 Esc（取消选中）不跟着触发。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    })
  })
}
