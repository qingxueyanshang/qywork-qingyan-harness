/**
 * 幻灯片视口：幻灯片按顺序纵向排列在原生滚动容器中，只为与可见区域相交的幻灯片保留画布并绘制。
 * 滚动位置的记录与缩放手势见 `../viewport.ts`。
 *
 * - 内容坐标以幻灯片宽度为单位：缩放比例为 1 时幻灯片列（含两侧间距）与滚动容器同宽，小于 1 时居中。
 *   不要改为 CSS 像素：以幻灯片宽度为单位，滚动容器宽度改变后仍定位到同一处内容。
 * - 画布像素按 CSS 尺寸乘 `devicePixelRatio` 分配，面积超过 `MAX_CANVAS_PIXELS` 时等比缩小，由浏览器放大显示。
 * - 缩放期间已绘制的画布随元素尺寸拉伸显示，停止缩放 `SETTLE_MS` 后按新尺寸重绘；没有内容的画布立即绘制。
 * - 每帧最多绘制一张幻灯片，其余留到后续帧：一张幻灯片的排版与绘制可达数十毫秒。待绘制的可见幻灯片在同一帧中
 *   全部调用 `prepare`，资源的读取不随绘制推迟到后续帧。
 * - 离开可见区域的幻灯片释放画布。重新显示（改写后重新加载）时保留已有画布，绘制完成前显示原内容。
 */

import { createZoomScroll, type ViewPosition } from '../viewport.ts'

/** 幻灯片之间与幻灯片列四周的间距，以幻灯片宽度为单位。 */
export const GAP = 0.03
/** 单个画布的像素面积上限：iOS Safari 的画布面积上限为 4096 × 4096，超出后画布不显示。 */
const MAX_CANVAS_PIXELS = 4096 * 4096
/** 最后一次缩放之后经过此时长才按新尺寸重绘。 */
const SETTLE_MS = 150

export interface SlideLayout {
  readonly count: number
  /** 幻灯片高度与宽度之比。 */
  readonly aspect: number
}

export interface SlidePainter {
  /** 第 `index` 张幻灯片所需的资源已就绪。未就绪时开始准备并返回 `false`，就绪后由调用方调用 `repaint(index)`。 */
  prepare(index: number): boolean
  /** 绘制到已设定像素尺寸的画布上，铺满画布。 */
  paint(index: number, canvas: HTMLCanvasElement): void
}

export interface SlideViewport {
  /** 显示幻灯片并定位到 `at`；`at` 为 `null` 时回到顶部，缩放比例为 1。 */
  show(layout: SlideLayout, at: ViewPosition | null): void
  /** 第 `index` 张幻灯片按当前内容重新绘制。 */
  repaint(index: number): void
  /** 当前位置；尚未显示时为 `null`。 */
  position(): ViewPosition | null
  destroy(): void
}

interface Page {
  readonly canvas: HTMLCanvasElement
  /** 已绘制内容的像素尺寸与所属的显示序号；尚未绘制时为 `null`。 */
  drawn: { readonly size: string; readonly generation: number } | null
}

export function createSlideViewport(
  els: { scroller: HTMLElement; extent: HTMLElement },
  painter: SlidePainter,
): SlideViewport {
  const { scroller, extent } = els
  let layout: SlideLayout | null = null
  /** 每次 `show` 加一：画布上的内容属于更早的显示时须重绘。 */
  let generation = 0
  const pages = new Map<number, Page>()
  let frame = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let lastZoom = 1
  let zoomedAt = Number.NEGATIVE_INFINITY

  const measure = (zoom: number) => {
    const width = scroller.clientWidth
    const scale = (zoom * width) / (1 + 2 * GAP)
    return { scale, originX: Math.max(0, (width * (1 - zoom)) / 2) }
  }

  const fit = (_x: number, _y: number, zoom: number) => {
    if (!layout) return
    const { scale, originX } = measure(zoom)
    extent.style.width = `${(1 + 2 * GAP) * scale + 2 * originX}px`
    extent.style.height = `${(GAP + layout.count * (layout.aspect + GAP)) * scale}px`
  }

  const release = (index: number) => {
    const page = pages.get(index)
    if (!page) return
    page.canvas.width = 0
    page.canvas.height = 0
    page.canvas.remove()
    pages.delete(index)
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  const changed = () => {
    const { zoom } = view.position()
    if (zoom !== lastZoom) {
      lastZoom = zoom
      zoomedAt = performance.now()
      clearTimeout(settleTimer)
      settleTimer = setTimeout(schedule, SETTLE_MS)
    }
    schedule()
  }

  function render() {
    frame = 0
    const width = scroller.clientWidth
    const height = scroller.clientHeight
    if (!layout || width === 0 || height === 0) return
    const { scrollY, zoom } = view.position()
    const { scale, originX } = measure(zoom)
    const step = layout.aspect + GAP
    const top = scrollY
    const bottom = scrollY + height / scale
    // 第 i 张占据 [GAP + i·step, GAP + i·step + aspect]，与 [top, bottom) 相交。
    const first = Math.max(0, Math.floor((top - GAP - layout.aspect) / step) + 1)
    const last = Math.min(layout.count - 1, Math.ceil((bottom - GAP) / step) - 1)
    for (const index of [...pages.keys()]) if (index < first || index > last) release(index)

    const dpr = window.devicePixelRatio || 1
    let pw = scale * dpr
    let ph = layout.aspect * scale * dpr
    const shrink = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (pw * ph)))
    pw = Math.max(1, Math.round(pw * shrink))
    ph = Math.max(1, Math.round(ph * shrink))
    const size = `${pw}x${ph}`
    const settling = performance.now() - zoomedAt < SETTLE_MS

    let painted = false
    let pending = false
    for (let index = first; index <= last; index++) {
      let page = pages.get(index)
      if (!page) {
        const canvas = document.createElement('canvas')
        canvas.className = 'slide-page'
        extent.append(canvas)
        page = { canvas, drawn: null }
        pages.set(index, page)
      }
      const style = page.canvas.style
      style.left = `${originX + GAP * scale}px`
      style.top = `${(GAP + index * step) * scale}px`
      style.width = `${scale}px`
      style.height = `${layout.aspect * scale}px`

      const drawn = page.drawn
      if (drawn?.size === size && drawn.generation === generation) continue
      // 内容属于本次显示、只是尺寸不同：缩放未停止时保留拉伸显示。
      if (drawn?.generation === generation && settling) continue
      if (!painter.prepare(index)) continue
      if (painted) {
        pending = true
        continue
      }
      page.canvas.width = pw
      page.canvas.height = ph
      painter.paint(index, page.canvas)
      page.drawn = { size, generation }
      painted = true
    }
    if (pending) schedule()
  }

  const view = createZoomScroll(scroller, { measure, fit, changed })

  return {
    show(next, at) {
      layout = next
      generation += 1
      for (const index of [...pages.keys()]) if (index >= next.count) release(index)
      const start = at ?? { scrollX: 0, scrollY: 0, zoom: 1 }
      lastZoom = start.zoom
      view.moveTo(start)
      schedule()
    },
    repaint(index) {
      const page = pages.get(index)
      if (page) page.drawn = null
      schedule()
    },
    position() {
      return layout ? view.position() : null
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(settleTimer)
      view.destroy()
      for (const index of [...pages.keys()]) release(index)
    },
  }
}
