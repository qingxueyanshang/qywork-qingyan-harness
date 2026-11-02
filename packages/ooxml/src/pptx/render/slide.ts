/**
 * 幻灯片绘制：背景、形状树（形状、图片、连接线、组合、表格、墨迹）与文字，绘制到 Canvas 2D 上下文。
 *
 * - 坐标：形状局部坐标以 96 dpi 像素为单位（1 px = 9525 EMU），原点为形状框左上角；`scale` 为每个
 *   96 dpi 像素对应的设备像素数，画布尺寸见 `slideSize`。
 * - 自选图形、连接线与组合的绘制规则见 `../../drawingml/shape/paint.ts`；本模块按形状种类分派，并绘制图片与表格。
 * - 绘制顺序：背景（没有背景时为白色）、各形状按文档顺序。
 * - 文字的行高与基线按演示文稿的规则，字形按点阵条件绘制（`./fonts.ts` 的 `slideGlyphs`）；`SlideResources.clearType`
 *   不为 `null` 时其余字号以 ClearType 字形写入画布像素（`slideClearType`），画布宜以 `willReadFrequently: true` 创建。
 *   旋转的文字、没有 TrueType 轮廓的字体、半透明的文字与画到图层上的文字以 `fillText` 绘制（见 `TextClearType`）。
 *   形状与表格的文字暂存，在下一个不是只有文字的形状与表格边框之前一并混合；图表与 SmartArt 的文字与其他绘制交错，
 *   每段立即混合。
 * - 图片的外部阴影取图片区域与线条的轮廓。图片可以是位图或图元文件（`../../drawingml/paint/picture.ts`），
 *   图元文件文字的字体取自幻灯片字体（`slideMetafileFonts`）。
 * - 三维效果（相机旋转、透视与光照）见 `../../drawingml/three/paint.ts`，图片与自选图形相同。
 * - 图表见 `../../drawingml/chart/paint.ts`，SmartArt 见 `../../drawingml/diagram/paint.ts`，墨迹见 `./ink.ts`。
 *   不绘制：隐藏的形状、`graphic`（未绘制的图表、SmartArt、OLE，已计数）。
 */

import { paintChart } from '../../drawingml/chart/paint.ts'
import { paintDiagram } from '../../drawingml/diagram/paint.ts'
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
  paintAutoShapeThreeD,
  paintConnector,
  paintGroup,
  placeFrame,
  type ShapeScene,
  shadowsOf,
  strokeMargin,
} from '../../drawingml/shape/paint.ts'
import type { TextSettings } from '../../drawingml/text/body.ts'
import { FaceCache, SINGLE_LINE } from '../../drawingml/text/fonts.ts'
import { paintThreeD } from '../../drawingml/three/paint.ts'
import type { ClearTypeDisplay, PixelCanvas } from '../../glyph/cleartype/index.ts'
import type { Picture, Presentation, Shape, Slide } from '../model.ts'
import { type SlideFonts, slideClearType, slideGlyphs, slideMetafileFonts } from './fonts.ts'
import { paintInk } from './ink.ts'
import { layoutTable, paintTable } from './table.ts'

/** 调用方提供的资源；图元文件文字的字体由幻灯片字体生成（`slideMetafileFonts`）。 */
export interface SlideResources extends Omit<PaintResources, 'metafileFonts'> {
  readonly fonts: SlideFonts
  /** 显示器的 ClearType 设置；为 `null` 时文字以浏览器字体绘制（不平滑的字号仍按点阵）。 */
  readonly clearType: ClearTypeDisplay | null
}

/** 绘制幻灯片的上下文：ClearType 字形读写画布像素（`getImageData`、`putImageData`）。 */
export interface SlideContext extends PaintContext, PixelCanvas {}

/**
 * 幻灯片上的文字总有排版设置（缺少字体时使用 `SlideFonts.fallback`）。`settings` 的 ClearType 字形暂存（见 `paintShape`），
 * `immediate` 的每段立即混合，用于图表与 SmartArt。
 */
interface SlideScene extends ShapeScene {
  readonly settings: TextSettings
  readonly immediate: TextSettings
}

/** 只画文字的形状（没有填充、线条与三维效果）：其文字可以与前后形状的文字一并混合。 */
function textOnly(shape: Shape): boolean {
  return (
    shape.kind === 'shape' &&
    shape.fill.kind === 'none' &&
    shape.line === null &&
    shape.threeD === null
  )
}

/** 幻灯片在 `scale` 下的画布像素尺寸。 */
export function slideSize(p: Presentation, scale: number): { width: number; height: number } {
  return {
    width: Math.round((p.width / EMU_PER_PX) * scale),
    height: Math.round((p.height / EMU_PER_PX) * scale),
  }
}

/**
 * 图片的绘制矩形取整到设备像素：左上角四舍五入（恰为 .5 时向下），宽高各自四舍五入；返回把形状框映射到取整后矩形的
 * 变换，变换含旋转、斜切或镜像时原样返回。裁剪路径与线条不取整。实测（WPS 演示导出图）：400×300 的图片 1:1 放在
 * (500.5, 50.5)、(50.25, 400.75)、(850.75, 400.25) 时与放在 (500, 50)、(50, 401)、(851, 400) 逐像素相同；
 * 2730×1471 的照片缩小到 1229.67×591.2 放在 5 种小数位置时，都与按取整后的矩形重采样最接近（宽高 1230×591，
 * 不按右下角取整）。形状的图片填充不取整：语料中两个图片填充的矩形与按原位置重采样一致，取整后低约 0.02。
 */
function snapPicture(m: Matrix, width: number, height: number): Matrix {
  if (m.b !== 0 || m.c !== 0 || m.a <= 0 || m.d <= 0 || width <= 0 || height <= 0) return m
  return {
    a: Math.round(m.a * width) / width,
    b: 0,
    c: 0,
    d: Math.round(m.d * height) / height,
    e: Math.ceil(m.e - 0.5),
    f: Math.ceil(m.f - 0.5),
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
  const snapped = snapPicture(placed.matrix, placed.width, placed.height)
  setMatrix(ctx, snapped)
  paintImageFill(ctx, shape.image, { ...area, matrix: snapped }, scene.res)
  ctx.restore()
  if (shape.line !== null) paintLine(ctx, outline.paths, shape.line, area, scene.res, scene.canvas)
}

function paintPicture(scene: SlideScene, shape: Picture, parent: Matrix): void {
  const placed = placeFrame(shape.frame, parent)
  const outline = outlineOf(shape)
  const shadows = shadowsOf(shape.effects)
  if (shape.threeD !== null) {
    paintThreeD(
      scene,
      shape.threeD,
      placed,
      strokeMargin(shape, placed),
      shadows,
      (c, offset, size) =>
        paintPictureBody({ ...scene, ctx: c, canvas: size }, c, shape, outline, {
          ...placed,
          matrix: multiply(offset, placed.matrix),
        }),
    )
    return
  }
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
  // 组合本身不绘制（有阴影时除外），其子形状各自判定。
  const draws = shape.kind === 'group' ? shadowsOf(shape.effects).length > 0 : !textOnly(shape)
  if (draws) scene.settings.faces.clearType?.flush()
  scene.ctx.save()
  switch (shape.kind) {
    case 'shape':
      if (shape.threeD === null) paintAutoShape(scene, shape, parent)
      else paintAutoShapeThreeD(scene, shape, shape.threeD, parent)
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
      paintChart({ ...scene, settings: scene.immediate }, shape.chart, shape.frame, parent)
      break
    case 'diagram':
      paintDiagram({ ...scene, settings: scene.immediate }, shape.diagram, shape.frame, parent)
      break
    case 'ink':
      paintInk(scene.ctx, shape, placeFrame(shape.frame, parent).matrix)
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
  ctx: SlideContext,
  presentation: Presentation,
  slide: Slide,
  res: SlideResources,
  scale: number,
): void {
  const canvas = slideSize(presentation, scale)
  const resources: PaintResources = { ...res, metafileFonts: slideMetafileFonts(res.fonts) }
  const settings = (deferred: boolean): TextSettings => ({
    faces: new FaceCache(
      res.fonts,
      SINGLE_LINE,
      null,
      slideGlyphs(res.fonts),
      res.clearType === null ? null : slideClearType(res.fonts, res.clearType, ctx, deferred),
    ),
    slideNumber: slide.number,
  })
  const scene: SlideScene = {
    ctx,
    res: resources,
    scale,
    canvas,
    settings: settings(true),
    immediate: settings(false),
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
      resources,
    )
  }
  for (const shape of slide.shapes) paintShape(scene, shape, base)
  scene.settings.faces.clearType?.flush()
  ctx.restore()
}
