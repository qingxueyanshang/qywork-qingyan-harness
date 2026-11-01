/**
 * 幻灯片绘制：背景、形状树（形状、图片、连接线、组合、表格）与文字，绘制到 Canvas 2D 上下文。
 *
 * - 坐标：形状局部坐标以 96 dpi 像素为单位（1 px = 9525 EMU），原点为形状框左上角；`scale` 为每个
 *   96 dpi 像素对应的设备像素数，画布尺寸见 `slideSize`。
 * - 自选图形、连接线与组合的绘制规则见 `../../drawingml/shape/paint.ts`；本模块按形状种类分派，并绘制图片与表格。
 * - 绘制顺序：背景（没有背景时为白色）、各形状按文档顺序。
 * - 图片的外部阴影取图片区域与线条的轮廓。
 * - 图表见 `../../drawingml/chart/paint.ts`。不绘制：隐藏的形状、`graphic`（未绘制的图表、SmartArt、OLE，已计数）。
 */

import { paintChart } from '../../drawingml/chart/paint.ts'
import type { ShapeOutline } from '../../drawingml/geometry/path.ts'
import {
  type Matrix,
  multiply,
  type PaintContext,
  scaling,
  setMatrix,
} from '../../drawingml/paint/context.ts'
import {
  appendPath,
  type PaintResources,
  paintFill,
  paintImageFill,
  traceRect,
} from '../../drawingml/paint/fill.ts'
import { paintLine } from '../../drawingml/paint/line.ts'
import { paintWithShadows, pathBounds } from '../../drawingml/paint/shadow.ts'
import {
  EMU_PER_PX,
  outlineOf,
  type Placed,
  paintAutoShape,
  paintConnector,
  paintGroup,
  placeFrame,
  type ShapeScene,
  shadowsOf,
  strokeMargin,
} from '../../drawingml/shape/paint.ts'
import type { TextSettings } from '../../drawingml/text/body.ts'
import { FaceCache, type SlideFontSource } from '../../drawingml/text/fonts.ts'
import type { Picture, Presentation, Shape, Slide } from '../model.ts'
import { layoutTable, paintTable } from './table.ts'

export interface SlideResources extends PaintResources {
  readonly fonts: SlideFontSource
}

/** 幻灯片上的文字总有排版设置（缺少字体时使用 `SlideFontSource.fallback`）。 */
interface SlideScene extends ShapeScene {
  readonly settings: TextSettings
}

/** 幻灯片在 `scale` 下的画布像素尺寸。 */
export function slideSize(p: Presentation, scale: number): { width: number; height: number } {
  return {
    width: Math.round((p.width / EMU_PER_PX) * scale),
    height: Math.round((p.height / EMU_PER_PX) * scale),
  }
}

function paintPictureBody(
  scene: SlideScene,
  ctx: PaintContext,
  shape: Picture,
  outline: ShapeOutline,
  placed: Placed,
): void {
  const area = { width: placed.width, height: placed.height, matrix: placed.matrix }
  const fillPaths = outline.paths.filter((p) => p.fill !== 'none')
  // 多条路径合为一个区域：图片与其下的填充都裁剪到该区域。
  const trace = () => {
    ctx.beginPath()
    for (const p of fillPaths) appendPath(ctx, p.segments)
  }
  setMatrix(ctx, placed.matrix)
  paintFill(ctx, trace, shape.fill, area, scene.res)
  ctx.save()
  trace()
  ctx.clip()
  paintImageFill(ctx, shape.image, area, scene.res)
  ctx.restore()
  if (shape.line !== null) paintLine(ctx, outline.paths, shape.line, area, scene.res, scene.canvas)
}

function paintPicture(scene: SlideScene, shape: Picture, parent: Matrix): void {
  const placed = placeFrame(shape.frame, parent)
  const outline = outlineOf(shape)
  const shadows = shadowsOf(shape.effects)
  if (shadows.length === 0) {
    paintPictureBody(scene, scene.ctx, shape, outline, placed)
    return
  }
  const bounds = pathBounds(outline.paths, placed.matrix, strokeMargin(shape, placed), scene.canvas)
  if (bounds === null) return
  paintWithShadows(
    scene.ctx,
    shadows,
    { matrix: placed.matrix, width: placed.width, height: placed.height, scale: scene.scale },
    bounds,
    scene.res,
    scene.canvas,
    (c, offset) =>
      paintPictureBody(scene, c, shape, outline, {
        ...placed,
        matrix: multiply(offset, placed.matrix),
      }),
  )
}

function paintShape(scene: SlideScene, shape: Shape, parent: Matrix): void {
  if (shape.hidden) return
  scene.ctx.save()
  switch (shape.kind) {
    case 'shape':
      paintAutoShape(scene, shape, parent)
      break
    case 'connector':
      paintConnector(scene, shape, parent)
      break
    case 'picture':
      paintPicture(scene, shape, parent)
      break
    case 'group':
      paintGroup(scene, shape, parent, (sub, inner) => {
        for (const child of shape.children) paintShape(sub, child, inner)
      })
      break
    case 'table': {
      const placed = placeFrame(shape.frame, parent)
      const layout = layoutTable(shape, scene.settings)
      paintTable(
        scene.ctx,
        shape,
        layout,
        placed.matrix,
        scene.scale,
        scene.res,
        scene.canvas,
        scene.settings,
      )
      break
    }
    case 'chart':
      paintChart(scene, shape.chart, shape.frame, parent)
      break
    case 'graphic':
      break
  }
  scene.ctx.restore()
}

/**
 * 把幻灯片绘制到画布上，画布尺寸应为 `slideSize(presentation, scale)`。调用前须取得 `presentationFonts`
 * 列出的字体与幻灯片引用的图片（`slideImages`）。
 */
export function paintSlide(
  ctx: PaintContext,
  presentation: Presentation,
  slide: Slide,
  res: SlideResources,
  scale: number,
): void {
  const canvas = slideSize(presentation, scale)
  const scene: SlideScene = {
    ctx,
    res,
    scale,
    canvas,
    settings: { faces: new FaceCache(res.fonts), slideNumber: slide.number },
  }
  const base = scaling(scale, scale)
  const width = presentation.width / EMU_PER_PX
  const height = presentation.height / EMU_PER_PX
  ctx.save()
  setMatrix(ctx, base)
  ctx.beginPath()
  ctx.rect(0, 0, width, height)
  ctx.clip()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  if (slide.background !== null) {
    paintFill(
      ctx,
      () => traceRect(ctx, width, height),
      slide.background,
      { width, height, matrix: base },
      res,
    )
  }
  for (const shape of slide.shapes) paintShape(scene, shape, base)
  ctx.restore()
}
