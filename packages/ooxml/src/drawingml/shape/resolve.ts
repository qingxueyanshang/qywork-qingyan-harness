/**
 * DrawingML 形状求值：样式矩阵引用、填充线条效果、组合坐标换算，以及绘制端不实现的内容的登记。
 *
 * - 样式矩阵引用（`fillRef`、`lnRef`、`effectRef`、`bgRef`）按主题格式方案取样式再求值；引用元素中的颜色作为 `phClr`
 *   的取值，只作用于该次引用取出的样式。
 * - 填充与效果：`spPr` 中出现的值优先，否则取 `style` 的 `fillRef`、`effectRef`；线条以 `lnRef` 的样式为底，
 *   再由各层 `ln` 逐字段覆盖。
 * - 组合坐标：子形状的 `off`/`ext` 按组合的 `chOff`/`chExt` 线性映射到组合的 `off`/`ext`，逐级复合；
 *   `chExt` 为 0 的方向按比例 1 处理。组合的旋转与翻转不并入子形状的 `frame`，绘制时施加。
 *   子形状自身旋转接近 90° 或 270° 时横纵比例互换（见 `frameOf`，WPS 实测）。
 */

import { readMetafile } from '../../metafile/index.ts'
import { type ColorContext, type ColorSpec, resolveColor } from '../color.ts'
import {
  type Effect,
  type EffectSpec,
  type FillSpec,
  type LineSpec,
  mergeLine,
  resolveEffects,
  resolveFill,
  resolveLine,
  type ShapeFill,
} from '../fill.ts'
import type { TextBody } from '../text/model.ts'
import type { ListStyleSpec, RunSpec } from '../text/read.ts'
import { styleEffect, styleFill, styleLine, type Theme } from '../theme.ts'
import type { Scene3D, Shape3D } from '../three/model.ts'
import type { FindingSink, Frame } from './model.ts'
import type { ShapeProps, StyleRefs, Xfrm } from './read.ts'

export interface StyleScope {
  readonly theme: Theme
  readonly colors: ColorContext
  /** 求值过程中遇到的未实现内容。 */
  readonly found: FindingSink
}

const NONE: ShapeFill = { kind: 'none' }

/** 以引用元素的颜色作为 `phClr` 的颜色上下文；颜色缺失或无法求值时不设 `phClr`。 */
export function refColors(scope: StyleScope, color: ColorSpec | null): ColorContext {
  const placeholder = color === null ? null : resolveColor(color, scope.colors)
  return placeholder === null ? scope.colors : { ...scope.colors, placeholder }
}

/** 样式矩阵填充；索引为 0、1000 或超出列表时为无填充。组合填充在此处没有所在组合，按无填充处理。 */
export function matrixFill(scope: StyleScope, idx: number, color: ColorSpec | null): ShapeFill {
  const spec = styleFill(scope.theme.formats, idx)
  if (spec === null) return NONE
  const fill = resolveFill(spec, refColors(scope, color))
  return fill.kind === 'group' ? NONE : fill
}

/** 样式矩阵线条规格与求值所用的颜色上下文；索引为 0 或超出列表时规格为空。 */
export function matrixLine(
  scope: StyleScope,
  idx: number,
  color: ColorSpec | null,
): { spec: LineSpec; colors: ColorContext } {
  return { spec: styleLine(scope.theme.formats, idx) ?? {}, colors: refColors(scope, color) }
}

export function matrixEffects(scope: StyleScope, idx: number, color: ColorSpec | null): Effect[] {
  const style = styleEffect(scope.theme.formats, idx)
  if (style === null) return []
  for (const e of style.effects) if (e.kind === 'other') scope.found.push('effect')
  return resolveEffects(style.effects, refColors(scope, color))
}

/** `spec` 为 `spPr` 中的填充（没有时为 `null`）；`grpFill` 取 `group`。 */
export function resolveShapeFill(
  spec: FillSpec | null,
  style: StyleRefs | null,
  group: ShapeFill,
  scope: StyleScope,
): ShapeFill {
  if (spec === null) {
    return style?.fill ? matrixFill(scope, style.fill.idx, style.fill.color) : NONE
  }
  const fill = resolveFill(spec, scope.colors)
  return fill.kind === 'group' ? group : fill
}

/** `own` 为各层的 `ln`，按优先级从高到低（形状自身在前）；缺失的层为 `null`。 */
export function resolveShapeLine(
  own: readonly (LineSpec | null)[],
  style: StyleRefs | null,
  scope: StyleScope,
) {
  let spec: LineSpec = {}
  let colors = scope.colors
  if (style?.line) ({ spec, colors } = matrixLine(scope, style.line.idx, style.line.color))
  for (let i = own.length - 1; i >= 0; i--) {
    const layer = own[i]
    if (layer !== null && layer !== undefined) spec = mergeLine(spec, layer)
  }
  return resolveLine(spec, colors)
}

export function resolveShapeEffects(
  spec: readonly EffectSpec[] | null,
  style: StyleRefs | null,
  scope: StyleScope,
) {
  if (spec !== null) return resolveEffects(spec, scope.colors)
  return style?.effect ? matrixEffects(scope, style.effect.idx, style.effect.color) : []
}

/**
 * 三维设置：`scene3d` 与 `sp3d` 各自取 `layers`（各层 `spPr`，按优先级从高到低）中最先出现的一项，都没有时取
 * `effectRef` 所引用的效果样式中的一项。
 */
export function shapeThreeD(
  layers: readonly ShapeProps[],
  style: StyleRefs | null,
  scope: StyleScope,
): { readonly scene: Scene3D | null; readonly shape: Shape3D | null } {
  const ref = style?.effect ? styleEffect(scope.theme.formats, style.effect.idx) : null
  return {
    scene: layers.find((p) => p.scene3d !== null)?.scene3d ?? ref?.scene3d ?? null,
    shape: layers.find((p) => p.shape3d !== null)?.shape3d ?? ref?.shape3d ?? null,
  }
}

/** `fontRef` 作为一层列表样式：每个层级都只有字段属性（主题字体与颜色）。 */
export function fontRefStyle(font: StyleRefs['font']): ListStyleSpec | null {
  if (font === null) return null
  const run: { -readonly [K in keyof RunSpec]: RunSpec[K] } = {}
  const prefix = font.idx === 'major' ? '+mj' : font.idx === 'minor' ? '+mn' : null
  if (prefix !== null) {
    run.latin = `${prefix}-lt`
    run.ea = `${prefix}-ea`
    run.cs = `${prefix}-cs`
  }
  if (font.color !== null) run.fill = { kind: 'solid', color: font.color }
  return { levels: Array.from({ length: 9 }, () => ({ run })) }
}

/** 局部坐标到外层坐标：`outer = s * local + t`。 */
export interface Transform {
  readonly sx: number
  readonly sy: number
  readonly tx: number
  readonly ty: number
}

export const IDENTITY_TRANSFORM: Transform = { sx: 1, sy: 1, tx: 0, ty: 0 }

export const EMPTY_XFRM: Xfrm = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  flipH: false,
  flipV: false,
  child: null,
}

/** 旋转角落在 [45°, 135°) 或 [225°, 315°)：形状的宽度方向接近竖直。 */
export function nearVertical(rotation: number): boolean {
  const r = ((rotation % 360) + 360) % 360
  return (r >= 45 && r < 135) || (r >= 225 && r < 315)
}

/**
 * 中心点按变换映射；宽高按比例缩放，旋转角接近 90° 或 270° 时横纵比例互换：
 * 这类形状的宽度方向在外层坐标中接近竖直，不互换时非等比缩放会把它拉伸到错误的方向。
 */
export function frameOf(xfrm: Xfrm, t: Transform): Frame {
  const swap = nearVertical(xfrm.rotation)
  const width = (swap ? t.sy : t.sx) * xfrm.width
  const height = (swap ? t.sx : t.sy) * xfrm.height
  const cx = t.sx * (xfrm.x + xfrm.width / 2) + t.tx
  const cy = t.sy * (xfrm.y + xfrm.height / 2) + t.ty
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotation: xfrm.rotation,
    flipH: xfrm.flipH,
    flipV: xfrm.flipV,
  }
}

/** 组合的子坐标系到外层坐标的变换。 */
export function childTransform(xfrm: Xfrm | null, t: Transform): Transform {
  if (xfrm === null) return t
  const child = xfrm.child ?? { x: xfrm.x, y: xfrm.y, width: xfrm.width, height: xfrm.height }
  const kx = child.width === 0 ? 1 : xfrm.width / child.width
  const ky = child.height === 0 ? 1 : xfrm.height / child.height
  return {
    sx: t.sx * kx,
    sy: t.sy * ky,
    tx: t.sx * (xfrm.x - child.x * kx) + t.tx,
    ty: t.sy * (xfrm.y - child.y * ky) + t.ty,
  }
}

/** 浏览器 `createImageBitmap` 可解码的图片内容类型。 */
const DECODABLE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/bmp',
  'image/webp',
])
/** 绘制端不实现的文字方向；`vert`、`vert270`、`eaVert` 按旋转绘制。 */
const UNPAINTED_VERTICAL = new Set(['wordArtVert', 'mongolianVert', 'wordArtVertRtl'])

/**
 * 图片部件能否绘制：内容类型为浏览器可解码的位图，或字节为没有未实现内容的图元文件（按字节识别，与
 * `../paint/picture.ts` 的 `decodePicture` 相同）。其余（TIFF、含未实现记录的图元文件等）登记为 `imageFormat`。
 */
export function drawableImage(type: string, bytes: Uint8Array): boolean {
  const mf = readMetafile(bytes)
  return mf === null ? DECODABLE_IMAGES.has(type) : mf.unsupported.length === 0
}

/** 内容类型为浏览器可解码的位图：这类部件不必读取字节即可判定（`drawableImage`）。 */
export function decodableImage(type: string): boolean {
  return DECODABLE_IMAGES.has(type)
}

/** `drawable` 为 `null` 表示部件不在包中，没有可绘制的内容，不登记。 */
export function countImage(drawable: boolean | null, found: FindingSink): void {
  if (drawable === false) found.push('imageFormat')
}

/** 绘制端在图层上实现的效果（`../paint/effects.ts`）。 */
const LAYER_EFFECTS: ReadonlySet<Effect['kind']> = new Set(['glow', 'softEdge', 'reflection'])

/**
 * 未绘制的效果：预设阴影与模糊；`layered` 为假时另含发光、柔化边缘与映像。`layered` 只在该元素经过效果图层绘制时为真
 * （演示文稿的自选图形、图片与组合；连接线与三维形状不经过）。`other` 已在读取时登记。内部阴影画在形状的填充区域内
 * （`../shape/paint.ts`）。
 */
export function countEffects(
  effects: readonly Effect[],
  found: FindingSink,
  layered = false,
): void {
  for (const e of effects) {
    if (e.kind === 'outerShadow' || e.kind === 'innerShadow' || e.kind === 'other') continue
    if (layered && LAYER_EFFECTS.has(e.kind)) continue
    found.push('effect')
  }
}

/** 绘制端实现的文字效果（`../text/body.ts`）。 */
const TEXT_EFFECTS: ReadonlySet<Effect['kind']> = new Set(['outerShadow', 'glow', 'reflection'])

/** 竖排文字方向是否按旋转绘制之外的方式书写。 */
export function unpaintedVertical(vertical: string): boolean {
  return UNPAINTED_VERTICAL.has(vertical)
}

/**
 * 文字中绘制端不实现的内容：竖排、外部阴影、发光与映像之外的文字效果（每个文本框登记一次）。`fill` 处理字段的填充（图片填充的格式
 * 由调用方按部件判断），`bullet` 处理图片项目符号的部件（由调用方按宿主能否绘制登记）。
 */
export function countText(
  text: TextBody,
  found: FindingSink,
  fill: (f: ShapeFill) => void,
  bullet: (part: string | null) => void,
): void {
  if (unpaintedVertical(text.body.vertical)) found.push('verticalText')
  let effect = false
  for (const p of text.paragraphs) {
    if (p.bullet.kind === 'picture') bullet(p.bullet.part)
    for (const r of p.runs) {
      fill(r.style.fill)
      if (r.style.effects.some((e) => !TEXT_EFFECTS.has(e.kind))) effect = true
    }
  }
  if (effect) found.push('effect')
}
