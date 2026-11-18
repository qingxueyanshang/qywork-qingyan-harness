/**
 * 预览的缩放快捷键：Ctrl+滚轮、Ctrl+= / Ctrl+-、Ctrl+0。图片、Office、Markdown 与代码共用同一套按键与倍率。
 *
 * 按键监听在窗口上：打开文件后焦点通常停留在文件树中。`target` 不可见（所在页签不是当前页签时宽度为 0）
 * 或焦点在输入框中时不响应。主窗口没有开启页面缩放快捷键，未处理的组合键不会缩放整个界面。
 */

/** 加减按钮与 Ctrl+加减号每次缩放的倍数。 */
export const ZOOM_STEP = 1.25
/** 滚轮每像素对应的缩放指数：滚轮一格（约 100 像素）缩放约 16%。 */
export const WHEEL_ZOOM_RATE = 0.0015

export interface ZoomInputs {
  /** 比例可以计算时为真：内容尺寸尚未取得时快捷键不响应。 */
  ready(): boolean
  /** 按倍数缩放。`at` 为锚点的视口坐标，缺省时以可视区中心为锚点。 */
  zoomBy(factor: number, at?: { clientX: number; clientY: number }): void
  /** 回到打开时的比例。 */
  reset(): void
}

/** 滚轮事件换算为缩放倍数。 */
export function wheelFactor(e: WheelEvent, pageHeight: number): number {
  const unit =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? pageHeight
        : 1
  return Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE)
}

/**
 * 在 `target` 上注册 Ctrl+滚轮，在窗口上注册按键，返回注销函数。
 * `wheel` 为假时只注册按键：Office 的滚动容器自行处理 Ctrl+滚轮与双指捏合。
 */
export function bindZoomInputs(
  target: HTMLElement,
  inputs: ZoomInputs,
  options: { wheel: boolean },
): () => void {
  // 必须设为 `passive: false` 才能阻止页面滚动。触控板捏合同样以 Ctrl+滚轮送达。
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey || !inputs.ready()) return
    e.preventDefault()
    inputs.zoomBy(wheelFactor(e, target.clientHeight), { clientX: e.clientX, clientY: e.clientY })
  }
  const keydown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !target.clientWidth || !inputs.ready()) return
    const focused = e.target instanceof Element ? e.target : null
    if (focused?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
      return
    if (e.key === '=' || e.key === '+') inputs.zoomBy(ZOOM_STEP)
    else if (e.key === '-') inputs.zoomBy(1 / ZOOM_STEP)
    else if (e.key === '0') inputs.reset()
    else return
    e.preventDefault()
  }
  if (options.wheel) target.addEventListener('wheel', wheel, { passive: false })
  window.addEventListener('keydown', keydown)
  return () => {
    target.removeEventListener('wheel', wheel)
    window.removeEventListener('keydown', keydown)
  }
}
