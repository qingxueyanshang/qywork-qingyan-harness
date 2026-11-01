/**
 * 文档页面视口：页面按顺序纵向排列在原生滚动容器中，只为与可见区域相交的页面保留画布并绘制。
 * 滚动位置的记录与缩放手势见 `../viewport.ts`。
 *
 * - 内容坐标以磅为单位，缩放比例为 1 时每磅 `PX_PER_POINT` 个 CSS 像素，与 WPS 100% 显示相同。首次显示时缩放比例取 1 与
 *   页面列适合滚动容器宽度的比例中的较小者。页面列宽为最宽的页面加两侧间距，各页在列中水平居中，列窄于滚动容器时居中显示。
 * - 绘制比例（画布像素/磅）为 CSS 比例乘 `devicePixelRatio`，交给 `paint`，不由画布宽度反推：缩放比例与设备像素比都为 1 时
 *   必须恰为 4/3，字号换算的整数像素与点阵字形才与 WPS 屏幕显示一致。画布的位置按设备像素取整，CSS 尺寸取画布像素除以设备像素比，
 *   使画布像素与屏幕像素一一对应；不取整时浏览器按小数位置重采样，文字发虚。
 * - 画布面积超过 `MAX_CANVAS_PIXELS` 时等比缩小，由浏览器放大显示。
 * - 缩放期间已绘制的画布随元素尺寸拉伸显示，停止缩放 `SETTLE_MS` 后按新尺寸重绘；没有内容的画布立即绘制。
 * - 每帧最多绘制一页，其余留到后续帧：一页的绘制可达数十毫秒。待绘制的可见页面在同一帧中全部调用 `prepare`，
 *   资源的读取不随绘制推迟到后续帧。
 * - 离开可见区域的页面释放画布。重新显示（改写后重新加载）时保留已有画布，绘制完成前显示原内容。
 */

import { createZoomScroll, type ViewPosition } from '../viewport.ts'

/** 页面之间与页面列四周的间距（磅）。 */
export const GAP = 10
/** 缩放比例为 1 时每磅的 CSS 像素数：96 dpi。 */
export const PX_PER_POINT = 4 / 3
/** 单个画布的像素面积上限：iOS Safari 的画布面积上限为 4096 × 4096，超出后画布不显示。 */
const MAX_CANVAS_PIXELS = 4096 * 4096
/** 最后一次缩放之后经过此时长才按新尺寸重绘。 */
const SETTLE_MS = 150

/** 页面尺寸（磅）。 */
export interface PageSize {
  readonly width: number
  readonly height: number
}

export interface PagePainter {
  /** 第 `index` 页所需的资源已就绪。未就绪时开始准备并返回 `false`，就绪后由调用方调用 `repaint(index)`。 */
  prepare(index: number): boolean
  /** 绘制到已设定像素尺寸的画布上；`scale` 为每磅的画布像素数。 */
  paint(index: number, canvas: HTMLCanvasElement, scale: number): void
}

export interface PageViewport {
  /** 显示页面并定位到 `at`；`at` 为 `null` 时回到顶部，缩放比例按首次显示的规则求得。 */
  show(pages: readonly PageSize[], at: ViewPosition | null): void
  /** 第 `index` 页按当前内容重新绘制。 */
  repaint(index: number): void
  /** 当前位置；尚未显示时为 `null`。 */
  position(): ViewPosition | null
  destroy(): void
}

interface Layout {
  readonly pages: readonly PageSize[]
  /** 各页顶边与左边（磅）。 */
  readonly tops: readonly number[]
  readonly lefts: readonly number[]
  readonly width: number
  readonly height: number
}

interface Sheet {
  readonly canvas: HTMLCanvasElement
  /** 已绘制内容的像素尺寸与所属的显示序号；尚未绘制时为 `null`。 */
  drawn: { readonly size: string; readonly generation: number } | null
}

function arrange(pages: readonly PageSize[]): Layout {
  const widest = Math.max(0, ...pages.map((p) => p.width))
  const tops: number[] = []
  const lefts: number[] = []
  let y = GAP
  for (const p of pages) {
    tops.push(y)
    lefts.push(GAP + (widest - p.width) / 2)
    y += p.height + GAP
  }
  return { pages, tops, lefts, width: widest + 2 * GAP, height: y }
}

export function createPageViewport(
  els: { scroller: HTMLElement; extent: HTMLElement },
  painter: PagePainter,
): PageViewport {
  const { scroller, extent } = els
  let layout: Layout | null = null
  /** 每次 `show` 加一：画布上的内容属于更早的显示时须重绘。 */
  let generation = 0
  const sheets = new Map<number, Sheet>()
  let frame = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let lastZoom = 1
  let zoomedAt = Number.NEGATIVE_INFINITY

  const measure = (zoom: number) => {
    const scale = zoom * PX_PER_POINT
    const column = (layout?.width ?? 0) * scale
    return { scale, originX: Math.max(0, (scroller.clientWidth - column) / 2) }
  }

  const fit = (_x: number, _y: number, zoom: number) => {
    if (!layout) return
    const { scale, originX } = measure(zoom)
    extent.style.width = `${layout.width * scale + 2 * originX}px`
    extent.style.height = `${layout.height * scale}px`
  }

  const release = (index: number) => {
    const sheet = sheets.get(index)
    if (!sheet) return
    sheet.canvas.width = 0
    sheet.canvas.height = 0
    sheet.canvas.remove()
    sheets.delete(index)
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
    const height = scroller.clientHeight
    if (!layout || scroller.clientWidth === 0 || height === 0) return
    const { scrollY, zoom } = view.position()
    const { scale, originX } = measure(zoom)
    const top = scrollY
    const bottom = scrollY + height / scale
    const { pages, tops, lefts } = layout
    const visible: number[] = []
    for (let i = 0; i < pages.length; i++) {
      if (tops[i]! >= bottom) break
      if (tops[i]! + pages[i]!.height > top) visible.push(i)
    }
    for (const index of [...sheets.keys()]) if (!visible.includes(index)) release(index)

    const dpr = window.devicePixelRatio || 1
    const snap = (v: number) => Math.round(v * dpr) / dpr
    const settling = performance.now() - zoomedAt < SETTLE_MS
    let painted = false
    let pending = false
    for (const index of visible) {
      const page = pages[index]!
      const shrink = Math.min(
        1,
        Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height * (scale * dpr) ** 2)),
      )
      const pixels = scale * dpr * shrink
      const pw = Math.max(1, Math.ceil(page.width * pixels))
      const ph = Math.max(1, Math.ceil(page.height * pixels))
      let sheet = sheets.get(index)
      if (!sheet) {
        const canvas = document.createElement('canvas')
        canvas.className = 'doc-page'
        extent.append(canvas)
        sheet = { canvas, drawn: null }
        sheets.set(index, sheet)
      }
      const style = sheet.canvas.style
      style.left = `${snap(originX + lefts[index]! * scale)}px`
      style.top = `${snap(tops[index]! * scale)}px`
      style.width = `${pw / (dpr * shrink)}px`
      style.height = `${ph / (dpr * shrink)}px`

      const size = `${pw}x${ph}`
      const drawn = sheet.drawn
      if (drawn?.size === size && drawn.generation === generation) continue
      // 内容属于本次显示、只是尺寸不同：缩放未停止时保留拉伸显示。
      if (drawn?.generation === generation && settling) continue
      if (!painter.prepare(index)) continue
      if (painted) {
        pending = true
        continue
      }
      sheet.canvas.width = pw
      sheet.canvas.height = ph
      painter.paint(index, sheet.canvas, pixels)
      sheet.drawn = { size, generation }
      painted = true
    }
    if (pending) schedule()
  }

  const view = createZoomScroll(scroller, { measure, fit, changed })

  return {
    show(pages, at) {
      layout = arrange(pages)
      generation += 1
      for (const index of [...sheets.keys()]) if (index >= pages.length) release(index)
      const width = scroller.clientWidth
      const start = at ?? {
        scrollX: 0,
        scrollY: 0,
        zoom: width > 0 ? Math.min(1, width / (layout.width * PX_PER_POINT)) : 1,
      }
      lastZoom = start.zoom
      view.moveTo(start)
      schedule()
    },
    repaint(index) {
      const sheet = sheets.get(index)
      if (sheet) sheet.drawn = null
      schedule()
    },
    position() {
      return layout ? view.position() : null
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(settleTimer)
      view.destroy()
      for (const index of [...sheets.keys()]) release(index)
    },
  }
}
