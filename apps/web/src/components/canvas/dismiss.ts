/** 画布上的菜单与弹出框：点击其外部或按 Esc 时收起。 */

import { createEffect, onCleanup } from 'solid-js'

/** 这些浮层内部的点击不视为外部点击。 */
const INSIDE =
  '.canvas-menu, .canvas-pick, .canvas-picker, .canvas-params-panel, .canvas-bar-menu, .canvas-context-menu, .canvas-frame-bar'

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
    // Esc 只收起最上层：阻止事件继续传播，画布层的 Esc（取消选中）不随之触发。
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
