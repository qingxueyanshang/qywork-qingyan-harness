/**
 * 工作表视口：画布叠在原生滚动容器上方，只绘制可见区域。滚动位置的记录与缩放手势见 `viewport.ts`，内容坐标为工作表像素。
 *
 * - 滚动范围由占位元素的尺寸决定：已用区域之后再加一屏，滚动到末端附近时再延长一屏，上限为工作表总尺寸
 *   （`geometry.total`）与 `MAX_EXTENT`。不要直接取总尺寸：工作表固定有 1048576 行，默认行高下约 2100 万像素，
 *   放大后超出浏览器的元素尺寸上限，滚动条也无法用于定位内容。
 * - 画布按 `devicePixelRatio` 分配像素，缩放与设备像素比以画布变换施加，绘制仍按工作表像素计算。
 * - 画布不接收指针事件（`pointer-events: none`），滚轮与触摸落在其下方的滚动容器上。
 */

import type { CreateCanvas, PaintCanvas } from '@qywork/ooxml/drawingml'
import {
  initialScroll,
  type PaintContext,
  type PaintImage,
  paintView,
  type SheetScene,
} from '@qywork/ooxml/xlsx'
import { createZoomScroll, type ViewPosition } from './viewport.ts'

export interface SheetViewport {
  /** 显示工作表并定位到 `at`；`at` 为 `null` 时取工作表保存的打开位置与缩放比例。 */
  show(scene: SheetScene, at: ViewPosition | null): void
  /** 图片解码完成后传入，与 `scene.sheet.images` 逐项对应，无法解码的为 `null`。 */
  setImages(images: readonly (PaintImage | null)[]): void
  /** 当前位置；尚未显示工作表时为 `null`。 */
  position(): ViewPosition | null
  destroy(): void
}

/** 占位元素的尺寸上限（CSS 像素）。Firefox 的元素尺寸上限约 1790 万像素，Chromium 与 WebKit 约 3355 万像素。 */
const MAX_EXTENT = 16_000_000

/**
 * 形状的阴影、图案与复合线条所需的图层。DOM 类型中 `createPattern` 的参数为 `CanvasImageSource`，与 `@qywork/ooxml`
 * 声明的 Canvas 子集无法互相赋值，此处与绘制上下文同样按结构转换；运行时接口相同。
 */
const createCanvas: CreateCanvas = (width, height) =>
  new OffscreenCanvas(Math.max(1, width), Math.max(1, height)) as unknown as PaintCanvas

export function createSheetViewport(els: {
  scroller: HTMLElement
  extent: HTMLElement
  canvas: HTMLCanvasElement
}): SheetViewport {
  const { scroller, extent, canvas } = els
  let scene: SheetScene | null = null
  let images: readonly (PaintImage | null)[] = []
  let frame = 0

  /** 按滚动位置 (`x`, `y`)（工作表像素）设置占位元素的尺寸，使该位置可以到达。 */
  const fitExtent = (x: number, y: number, zoom: number) => {
    if (!scene) return
    const { cols, rows } = scene.geometry
    const viewW = scroller.clientWidth / zoom
    const viewH = scroller.clientHeight / zoom
    const usedW = cols.offset(scene.sheet.maxCol + 1)
    const usedH = rows.offset(scene.sheet.maxRow + 1)
    const w = Math.min(cols.total, Math.max(usedW + viewW, x + 2 * viewW))
    const h = Math.min(rows.total, Math.max(usedH + viewH, y + 2 * viewH))
    extent.style.width = `${Math.min(w * zoom, MAX_EXTENT)}px`
    extent.style.height = `${Math.min(h * zoom, MAX_EXTENT)}px`
  }

  const paint = () => {
    frame = 0
    const ctx = canvas.getContext('2d') as PaintContext | null
    if (!scene || !ctx) return
    const { scrollX, scrollY, zoom } = view.position()
    const w = scroller.clientWidth
    const h = scroller.clientHeight
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(w * dpr)
    const ph = Math.round(h * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0)
    paintView(
      ctx,
      scene,
      { scrollX, scrollY, width: w / zoom, height: h / zoom },
      { images, createCanvas },
    )
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint)
  }

  const view = createZoomScroll(scroller, {
    measure: (zoom) => ({ scale: zoom, originX: 0 }),
    fit: fitExtent,
    changed: schedule,
  })

  return {
    show(next, at) {
      scene = next
      images = []
      view.moveTo(at ?? { ...initialScroll(next), zoom: next.sheet.view.zoom / 100 })
    },
    setImages(next) {
      images = next
      schedule()
    },
    position() {
      return scene ? view.position() : null
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      view.destroy()
    },
  }
}
