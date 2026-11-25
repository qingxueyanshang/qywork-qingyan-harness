/**
 * 触屏长按：单指按住不动达到 `LONG_PRESS_MS` 时调用 `onPress`，用于在触屏上打开右键菜单。
 *
 * - 触屏没有右键。iOS Safari 长按不派发 `contextmenu`；Android 长按可拖动的元素时开始拖放，同样不派发。
 *   因此触屏的右键菜单只经本模块打开，不依赖浏览器的 `contextmenu`。
 * - 移动超过 `TOUCH_SLOP`、松开、第二根手指按下或触点被取消时不触发。
 * - 触屏按压期间与触发之后，元素不接收本次按压的 `contextmenu` 与松开后的 `click`：菜单不打开两次，
 *   松开手指不再执行轻点的操作。鼠标与触控笔不经本模块。
 */

/** 长按的时长（毫秒）。 */
const LONG_PRESS_MS = 500
/** 长按与轻点期间允许的移动距离（CSS 像素）：手指按住时会轻微移动，超过该距离视为拖动或滚动。 */
export const TOUCH_SLOP = 8

/** 主要指针为触屏（手机、平板）。 */
export function touchPrimary(): boolean {
  return globalThis.matchMedia?.('(pointer: coarse)').matches === true
}

/** 在元素上启用长按。`target` 为按下处的元素，坐标为按下处的窗口坐标。 */
export function attachLongPress(
  el: HTMLElement,
  onPress: (x: number, y: number, target: HTMLElement) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let press: { id: number; x: number; y: number } | null = null
  let fired = false

  const cancel = () => {
    clearTimeout(timer)
    press = null
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    if (press) {
      cancel()
      return
    }
    fired = false
    press = { id: e.pointerId, x: e.clientX, y: e.clientY }
    const target = e.target as HTMLElement
    timer = setTimeout(() => {
      press = null
      fired = true
      onPress(e.clientX, e.clientY, target)
    }, LONG_PRESS_MS)
  })
  el.addEventListener('pointermove', (e) => {
    if (
      press?.id === e.pointerId &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) >= TOUCH_SLOP
    ) {
      cancel()
    }
  })
  el.addEventListener('pointerup', (e) => {
    if (press?.id === e.pointerId) cancel()
  })
  el.addEventListener('pointercancel', cancel)

  const swallow = (e: Event) => {
    if (!press && !fired) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'click') fired = false
  }
  el.addEventListener('contextmenu', swallow, true)
  el.addEventListener('click', swallow, true)
}
