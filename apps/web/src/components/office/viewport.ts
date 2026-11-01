/**
 * Office 预览共用的滚动与缩放：原生滚动容器提供滚动、滚动条与触屏惯性，本模块记录内容坐标中的位置并处理缩放手势。
 *
 * - 内容坐标由调用方定义：缩放比例为 `zoom` 时每单位对应 `measure(zoom).scale` 个 CSS 像素，内容原点位于滚动内容
 *   左缘右侧 `measure(zoom).originX` 处（内容窄于滚动容器而居中显示时大于 0）。
 * - 位置以记录的内容坐标为准，不以 `scrollLeft` 为准：所在页签隐藏（`display: none`）时浏览器丢弃滚动位置，
 *   隐藏期间的定位也无法生效；重新显示时由 `ResizeObserver` 按记录的位置恢复。可见时每次写入滚动位置后
 *   按浏览器限制后的实际值更新记录。
 * - 缩放：Ctrl + 滚轮（触控板捏合同样以 Ctrl + 滚轮送达）与双指捏合，以指针或双指中点为锚点。
 * - 单指滚动交给浏览器（样式 `touch-action: pan-x pan-y`），双指由本模块处理：缩放的同时随中点平移。
 *   不放行 `pinch-zoom`：放行后浏览器缩放整个页面。
 */

export interface ViewPosition {
  /** 滚动容器左上角的内容坐标。 */
  readonly scrollX: number
  readonly scrollY: number
  /** 1 为 100%。 */
  readonly zoom: number
}

/** 缩放范围，与 Excel、WPS 的缩放范围相同。 */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4
/** 滚轮每像素对应的缩放指数：滚轮一格（约 100 像素）缩放约 16%。 */
const WHEEL_ZOOM_RATE = 0.0015

export interface ZoomScrollHooks {
  measure(zoom: number): { readonly scale: number; readonly originX: number }
  /** 按位置 (`x`, `y`) 与缩放比例设置滚动内容的尺寸，使该位置可以到达。每次写入滚动位置之前与每次滚动后调用。 */
  fit(x: number, y: number, zoom: number): void
  /** 位置或缩放比例改变后调用，含用户滚动。 */
  changed(): void
}

export interface ZoomScroll {
  moveTo(at: ViewPosition): void
  position(): ViewPosition
  destroy(): void
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function createZoomScroll(scroller: HTMLElement, hooks: ZoomScrollHooks): ZoomScroll {
  let zoom = 1
  let sx = 0
  let sy = 0
  /** 滚动容器有尺寸。隐藏期间不读取滚动位置：此时的 `scrollLeft` 已被浏览器归零。 */
  let visible = scroller.clientWidth > 0 && scroller.clientHeight > 0

  const readBack = () => {
    const { scale, originX } = hooks.measure(zoom)
    sx = (scroller.scrollLeft - originX) / scale
    sy = scroller.scrollTop / scale
  }

  /** 把记录的位置写入滚动容器，再按浏览器限制后的滚动量更新记录。 */
  const apply = () => {
    hooks.fit(sx, sy, zoom)
    const { scale, originX } = hooks.measure(zoom)
    scroller.scrollLeft = sx * scale + originX
    scroller.scrollTop = sy * scale
    readBack()
    hooks.changed()
  }

  const moveTo = (x: number, y: number, next: number) => {
    zoom = clampZoom(next)
    sx = x
    sy = y
    if (visible) apply()
  }

  /** 缩放到 `next`，使内容点 `anchor` 位于滚动容器中的 (`ax`, `ay`)。 */
  const zoomAround = (next: number, ax: number, ay: number, anchor: { x: number; y: number }) => {
    const z = clampZoom(next)
    const { scale } = hooks.measure(z)
    moveTo(anchor.x - ax / scale, anchor.y - ay / scale, z)
  }

  const local = (clientX: number, clientY: number) => {
    const box = scroller.getBoundingClientRect()
    return { x: clientX - box.left, y: clientY - box.top }
  }
  const contentPoint = (p: { x: number; y: number }) => {
    const { scale } = hooks.measure(zoom)
    return { x: sx + p.x / scale, y: sy + p.y / scale }
  }

  const onScroll = () => {
    visible = scroller.clientWidth > 0 && scroller.clientHeight > 0
    if (!visible) return
    readBack()
    hooks.fit(sx, sy, zoom)
    hooks.changed()
  }

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : 1
    const p = local(e.clientX, e.clientY)
    zoomAround(zoom * Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE), p.x, p.y, contentPoint(p))
  }

  /** 双指捏合开始时的缩放比例、两指距离与中点下的内容点。 */
  let pinch: { zoom: number; distance: number; anchor: { x: number; y: number } } | null = null
  const fingers = (e: TouchEvent) => {
    const a = local(e.touches[0]!.clientX, e.touches[0]!.clientY)
    const b = local(e.touches[1]!.clientX, e.touches[1]!.clientY)
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    }
  }
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return
    const f = fingers(e)
    pinch = { zoom, distance: f.distance, anchor: contentPoint(f.mid) }
  }
  const onTouchMove = (e: TouchEvent) => {
    if (!pinch || e.touches.length !== 2) return
    e.preventDefault()
    const f = fingers(e)
    zoomAround((pinch.zoom * f.distance) / pinch.distance, f.mid.x, f.mid.y, pinch.anchor)
  }
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) pinch = null
  }

  const resize = new ResizeObserver(() => {
    visible = scroller.clientWidth > 0 && scroller.clientHeight > 0
    if (visible) apply()
  })
  resize.observe(scroller)
  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('wheel', onWheel, { passive: false })
  scroller.addEventListener('touchstart', onTouchStart, { passive: true })
  scroller.addEventListener('touchmove', onTouchMove, { passive: false })
  scroller.addEventListener('touchend', onTouchEnd, { passive: true })
  scroller.addEventListener('touchcancel', onTouchEnd, { passive: true })

  return {
    moveTo(at) {
      moveTo(at.scrollX, at.scrollY, at.zoom)
    },
    position() {
      return { scrollX: sx, scrollY: sy, zoom }
    },
    destroy() {
      resize.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', onTouchEnd)
    },
  }
}
