/**
 * DrawingML 填充、线条与效果：先读取为带 `ColorSpec` 的规格，再结合颜色上下文求值。
 *
 * - 读取函数在对应元素的开始标签处调用，返回时位于其结束标签。元素按本地名匹配，不限定前缀。
 * - 填充与效果的类型以颜色类型为参数：读取结果的颜色为 `ColorSpec | null`（缺少颜色元素或无法解析时为 `null`），
 *   求值结果的颜色为 `Color`。求值时颜色无法确定：纯色填充视为无填充，渐变色标与效果整项去掉，
 *   图案填充的前景取黑色、背景取白色。
 * - 图片填充的 `r:embed` 在读取时按传入的关系表解析为部件名；未传关系表、关系不存在或为外部链接时 `part` 为 `null`。
 * - 线条规格的字段均可缺省：主题线条样式、继承来源与形状自身的 `ln` 按字段逐层覆盖（`mergeLine`）。
 * - 长度单位为 EMU，角度单位为度，百分比为小数（50% 为 0.5）。
 */

import { NS } from '../opc/namespace.ts'
import type { Relationships } from '../opc/package.ts'
import type { PartScanner } from '../opc/scanner.ts'
import {
  type Color,
  type ColorContext,
  type ColorSpec,
  isColorElement,
  parsePercentage,
  readColor,
  resolveColor,
} from './color.ts'

export type Reader = Pick<PartScanner, 'next' | 'local' | 'depth' | 'attr' | 'attrNs'>

/** 四边相对内缩的比例，正值向内。 */
export interface RelativeRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export const ZERO_RECT: RelativeRect = { left: 0, top: 0, right: 0, bottom: 0 }

export type GradientShade =
  | { readonly kind: 'linear'; readonly angle: number; readonly scaled: boolean }
  | {
      readonly kind: 'path'
      readonly path: 'circle' | 'rect' | 'shape'
      /** `fillToRect`：渐变终点所在的矩形。 */
      readonly focus: RelativeRect
    }

export type TileFlip = 'none' | 'x' | 'y' | 'xy'

export interface GradientStop<C> {
  /** 0–1。 */
  readonly position: number
  readonly color: C
}

export interface ImageTile {
  readonly offsetX: number
  readonly offsetY: number
  readonly scaleX: number
  readonly scaleY: number
  readonly flip: TileFlip
  /** `tl`、`t`、`tr`、`l`、`ctr`、`r`、`bl`、`b`、`br`。 */
  readonly align: string
}

export interface ImageFill {
  /** 图片部件名。 */
  readonly part: string | null
  /** `srcRect`：从原图四边裁去的比例，负值为向外扩展。 */
  readonly crop: RelativeRect
  /** 拉伸模式下图片所占的区域（`fillRect`）；平铺模式为 `null`。 */
  readonly stretch: RelativeRect | null
  readonly tile: ImageTile | null
  /** `alphaModFix` 的不透明度，缺省为 1。 */
  readonly alpha: number
  /** 未实现的图片效果的元素本地名（如 `duotone`、`grayscl`、`artisticPhotocopy`），按出现顺序。 */
  readonly effects: readonly string[]
  readonly rotateWithShape: boolean
}

export type FillOf<C> =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: C }
  | {
      readonly kind: 'gradient'
      readonly stops: readonly GradientStop<C>[]
      readonly shade: GradientShade
      readonly flip: TileFlip
      readonly rotateWithShape: boolean
    }
  | { readonly kind: 'picture'; readonly image: ImageFill }
  | {
      readonly kind: 'pattern'
      /** `ST_PresetPatternVal`，如 `pct20`、`horz`、`smCheck`。 */
      readonly preset: string
      readonly foreground: C
      readonly background: C
    }
  /** 使用所在组合的填充，由调用方按组合求值。 */
  | { readonly kind: 'group' }

export type FillSpec = FillOf<ColorSpec | null>
export type Fill = FillOf<Color>
/** 组合填充已替换为所在组合的填充。 */
export type ShapeFill = Exclude<Fill, { readonly kind: 'group' }>

export type LineCap = 'rnd' | 'sq' | 'flat'
export type LineJoin = 'round' | 'bevel' | 'miter'
export type LineEndSize = 'sm' | 'med' | 'lg'

export interface LineEnd {
  /** `triangle`、`stealth`、`diamond`、`oval`、`arrow`。 */
  readonly type: string
  readonly width: LineEndSize
  readonly length: LineEndSize
}

export type LineDash =
  | { readonly kind: 'preset'; readonly name: string }
  /** `dash` 与 `space` 为线宽的倍数。 */
  | {
      readonly kind: 'custom'
      readonly stops: readonly { readonly dash: number; readonly space: number }[]
    }

export interface LineSpec {
  readonly width?: number
  readonly fill?: FillSpec
  readonly dash?: LineDash
  readonly cap?: LineCap
  /** `sng`、`dbl`、`thickThin`、`thinThick`、`tri`。 */
  readonly compound?: string
  readonly align?: 'ctr' | 'in'
  readonly join?: LineJoin
  /** 只在 `join` 为 `miter` 时有值。 */
  readonly miterLimit?: number
  /** `type` 为 `none` 时同样记录，用于覆盖下层的箭头。 */
  readonly head?: LineEnd
  readonly tail?: LineEnd
}

export interface Line {
  readonly width: number
  readonly fill: Exclude<Fill, { readonly kind: 'none' } | { readonly kind: 'group' }>
  readonly dash: LineDash
  readonly cap: LineCap
  readonly compound: string
  readonly align: 'ctr' | 'in'
  readonly join: LineJoin
  readonly miterLimit: number | null
  /** 没有箭头时为 `null`。 */
  readonly head: LineEnd | null
  readonly tail: LineEnd | null
}

interface ShadowGeometry {
  readonly blur: number
  readonly distance: number
  readonly direction: number
}

interface Skew {
  readonly scaleX: number
  readonly scaleY: number
  readonly skewX: number
  readonly skewY: number
  readonly align: string
  readonly rotateWithShape: boolean
}

export type EffectOf<C> =
  | ({ readonly kind: 'outerShadow'; readonly color: C } & ShadowGeometry & Skew)
  | ({ readonly kind: 'innerShadow'; readonly color: C } & ShadowGeometry)
  | {
      readonly kind: 'presetShadow'
      readonly color: C
      readonly preset: string
      readonly distance: number
      readonly direction: number
    }
  | { readonly kind: 'glow'; readonly color: C; readonly radius: number }
  | { readonly kind: 'softEdge'; readonly radius: number }
  | ({
      readonly kind: 'reflection'
      readonly startAlpha: number
      readonly startPosition: number
      readonly endAlpha: number
      readonly endPosition: number
      readonly fadeDirection: number
    } & ShadowGeometry &
      Skew)
  | { readonly kind: 'blur'; readonly radius: number; readonly grow: boolean }
  /** 未实现的效果（`fillOverlay`、`effectDag`），只记录元素本地名。 */
  | { readonly kind: 'other'; readonly name: string }

export type EffectSpec = EffectOf<ColorSpec | null>
export type Effect = EffectOf<Color>

const FILL_ELEMENTS = new Set([
  'noFill',
  'solidFill',
  'gradFill',
  'blipFill',
  'pattFill',
  'grpFill',
])
/** `blip` 的子元素中可解析为不透明度的效果；其余效果按名称记入 `effects`。 */
const BLIP_IGNORED = new Set(['alphaModFix', 'extLst'])
const DEFAULT_LINE_END: LineEnd = { type: 'none', width: 'med', length: 'med' }

function eachChild(x: Reader, visit: (local: string) => void): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
    if (t === 'start' && x.depth === depth + 1) visit(x.local)
  }
}

function num(x: Reader, name: string, fallback: number): number {
  const v = x.attr(name)
  if (v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function percent(x: Reader, name: string, fallback: number): number {
  return parsePercentage(x.attr(name)) ?? fallback
}

function angle(x: Reader, name: string, fallback: number): number {
  return num(x, name, fallback * 60000) / 60000
}

function bool(x: Reader, name: string, fallback: boolean): boolean {
  const v = x.attr(name)
  if (v === null) return fallback
  return v === '1' || v === 'true'
}

function readRect(x: Reader): RelativeRect {
  return {
    left: percent(x, 'l', 0),
    top: percent(x, 't', 0),
    right: percent(x, 'r', 0),
    bottom: percent(x, 'b', 0),
  }
}

function readFlip(x: Reader): TileFlip {
  const v = x.attr('flip')
  return v === 'x' || v === 'y' || v === 'xy' ? v : 'none'
}

/** 读取当前元素的第一个颜色子元素，返回时位于当前元素的结束标签。 */
function readChildColor(x: Reader): ColorSpec | null {
  let color: ColorSpec | null = null
  let found = false
  eachChild(x, (local) => {
    if (found || !isColorElement(local)) return
    found = true
    color = readColor(x)
  })
  return color
}

export function isFillElement(local: string): boolean {
  return FILL_ELEMENTS.has(local)
}

/** 在填充元素（`isFillElement`）的开始标签处调用。 */
export function readFill(x: Reader, rels: Relationships | null): FillSpec {
  switch (x.local) {
    case 'solidFill':
      return { kind: 'solid', color: readChildColor(x) }
    case 'gradFill':
      return readGradient(x)
    case 'blipFill':
      return { kind: 'picture', image: readImageFill(x, rels) }
    case 'pattFill':
      return readPattern(x)
    case 'grpFill':
      eachChild(x, () => {})
      return { kind: 'group' }
    default:
      eachChild(x, () => {})
      return { kind: 'none' }
  }
}

function readGradient(x: Reader): FillSpec {
  const flip = readFlip(x)
  const rotateWithShape = bool(x, 'rotWithShape', true)
  const stops: GradientStop<ColorSpec | null>[] = []
  let shade: GradientShade = { kind: 'linear', angle: 0, scaled: false }
  eachChild(x, (local) => {
    if (local === 'gsLst') {
      eachChild(x, (gs) => {
        if (gs !== 'gs') return
        const position = percent(x, 'pos', 0)
        stops.push({ position, color: readChildColor(x) })
      })
    } else if (local === 'lin') {
      shade = { kind: 'linear', angle: angle(x, 'ang', 0), scaled: bool(x, 'scaled', false) }
    } else if (local === 'path') {
      const p = x.attr('path')
      const path = p === 'rect' || p === 'shape' ? p : 'circle'
      let focus = ZERO_RECT
      eachChild(x, (child) => {
        if (child === 'fillToRect') focus = readRect(x)
      })
      shade = { kind: 'path', path, focus }
    }
  })
  stops.sort((a, b) => a.position - b.position)
  return { kind: 'gradient', stops, shade, flip, rotateWithShape }
}

function readImageFill(x: Reader, rels: Relationships | null): ImageFill {
  const rotateWithShape = bool(x, 'rotWithShape', true)
  let part: string | null = null
  let crop = ZERO_RECT
  let stretch: RelativeRect | null = null
  let tile: ImageTile | null = null
  let alpha = 1
  const effects: string[] = []
  eachChild(x, (local) => {
    if (local === 'blip') {
      const embed = x.attrNs(NS.relationships, 'embed')
      if (embed !== null && rels !== null) {
        const r = rels.byId(embed)
        part = r !== null && !r.external ? r.part : null
      }
      eachChild(x, (effect) => {
        if (effect === 'alphaModFix') alpha = percent(x, 'amt', 1)
        else if (effect === 'extLst') readImageExtensions(x, effects)
        else if (!BLIP_IGNORED.has(effect)) effects.push(effect)
      })
    } else if (local === 'srcRect') {
      crop = readRect(x)
    } else if (local === 'stretch') {
      stretch = ZERO_RECT
      eachChild(x, (child) => {
        if (child === 'fillRect') stretch = readRect(x)
      })
    } else if (local === 'tile') {
      tile = {
        offsetX: num(x, 'tx', 0),
        offsetY: num(x, 'ty', 0),
        scaleX: percent(x, 'sx', 1),
        scaleY: percent(x, 'sy', 1),
        flip: readFlip(x),
        align: x.attr('algn') ?? 'tl',
      }
    }
  })
  return { part, crop, stretch, tile, alpha, effects, rotateWithShape }
}

/** 扩展中的图片效果（艺术效果、亮度对比度、背景删除）记入 `effects`；其余扩展（SVG 原图、本地 DPI）不影响位图显示。 */
function readImageExtensions(x: Reader, effects: string[]): void {
  const depth = x.depth
  let effectDepth = -1
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end') {
      if (x.depth === depth) return
      if (x.depth === effectDepth) effectDepth = -1
      continue
    }
    if (t !== 'start') continue
    if (effectDepth >= 0 && x.depth === effectDepth + 1) effects.push(x.local)
    else if (x.local === 'imgEffect') effectDepth = x.depth
    else if (x.local === 'backgroundRemoval') effects.push('backgroundRemoval')
  }
}

function readPattern(x: Reader): FillSpec {
  const preset = x.attr('prst') ?? 'pct5'
  let foreground: ColorSpec | null = null
  let background: ColorSpec | null = null
  eachChild(x, (local) => {
    if (local === 'fgClr') foreground = readChildColor(x)
    else if (local === 'bgClr') background = readChildColor(x)
  })
  return { kind: 'pattern', preset, foreground, background }
}

function readLineEnd(x: Reader): LineEnd {
  const size = (name: string): LineEndSize => {
    const v = x.attr(name)
    return v === 'sm' || v === 'lg' ? v : 'med'
  }
  return { type: x.attr('type') ?? 'none', width: size('w'), length: size('len') }
}

/** 在 `ln`（或表格边框 `lnL` 等同类元素）的开始标签处调用。 */
export function readLine(x: Reader, rels: Relationships | null): LineSpec {
  const out: {
    -readonly [K in keyof LineSpec]: LineSpec[K]
  } = {}
  const w = x.attr('w')
  if (w !== null && Number.isFinite(Number(w))) out.width = Number(w)
  const cap = x.attr('cap')
  if (cap === 'rnd' || cap === 'sq' || cap === 'flat') out.cap = cap
  const compound = x.attr('cmpd')
  if (compound !== null) out.compound = compound
  const align = x.attr('algn')
  if (align === 'ctr' || align === 'in') out.align = align
  eachChild(x, (local) => {
    if (isFillElement(local)) out.fill = readFill(x, rels)
    else if (local === 'prstDash') out.dash = { kind: 'preset', name: x.attr('val') ?? 'solid' }
    else if (local === 'custDash') {
      const stops: { dash: number; space: number }[] = []
      eachChild(x, (ds) => {
        if (ds === 'ds') stops.push({ dash: percent(x, 'd', 1), space: percent(x, 'sp', 1) })
      })
      out.dash = { kind: 'custom', stops }
    } else if (local === 'round' || local === 'bevel') out.join = local
    else if (local === 'miter') {
      out.join = 'miter'
      out.miterLimit = percent(x, 'lim', 8)
    } else if (local === 'headEnd') out.head = readLineEnd(x)
    else if (local === 'tailEnd') out.tail = readLineEnd(x)
  })
  return out
}

/** 按字段合并，`over` 中出现的字段覆盖 `base`。 */
export function mergeLine(base: LineSpec, over: LineSpec): LineSpec {
  return { ...base, ...over }
}

function shadowGeometry(x: Reader): ShadowGeometry {
  return { blur: num(x, 'blurRad', 0), distance: num(x, 'dist', 0), direction: angle(x, 'dir', 0) }
}

function skew(x: Reader): Skew {
  return {
    scaleX: percent(x, 'sx', 1),
    scaleY: percent(x, 'sy', 1),
    skewX: angle(x, 'kx', 0),
    skewY: angle(x, 'ky', 0),
    align: x.attr('algn') ?? 'b',
    rotateWithShape: bool(x, 'rotWithShape', true),
  }
}

/** 在 `effectLst` 的开始标签处调用。 */
export function readEffects(x: Reader): EffectSpec[] {
  const out: EffectSpec[] = []
  eachChild(x, (local) => {
    switch (local) {
      case 'outerShdw': {
        const geometry = { ...shadowGeometry(x), ...skew(x) }
        out.push({ kind: 'outerShadow', ...geometry, color: readChildColor(x) })
        return
      }
      case 'innerShdw': {
        const geometry = shadowGeometry(x)
        out.push({ kind: 'innerShadow', ...geometry, color: readChildColor(x) })
        return
      }
      case 'prstShdw': {
        const preset = x.attr('prst') ?? 'shdw1'
        const distance = num(x, 'dist', 0)
        const direction = angle(x, 'dir', 0)
        out.push({ kind: 'presetShadow', preset, distance, direction, color: readChildColor(x) })
        return
      }
      case 'glow': {
        const radius = num(x, 'rad', 0)
        out.push({ kind: 'glow', radius, color: readChildColor(x) })
        return
      }
      case 'softEdge':
        out.push({ kind: 'softEdge', radius: num(x, 'rad', 0) })
        return
      case 'reflection':
        out.push({
          kind: 'reflection',
          ...shadowGeometry(x),
          ...skew(x),
          startAlpha: percent(x, 'stA', 1),
          startPosition: percent(x, 'stPos', 0),
          endAlpha: percent(x, 'endA', 0),
          endPosition: percent(x, 'endPos', 1),
          fadeDirection: angle(x, 'fadeDir', 90),
        })
        return
      case 'blur':
        out.push({ kind: 'blur', radius: num(x, 'rad', 0), grow: bool(x, 'grow', true) })
        return
      default:
        out.push({ kind: 'other', name: local })
    }
  })
  return out
}

/**
 * 在 `scene3d` 或 `sp3d` 的开始标签处调用，返回三维设置是否改变外观：
 * `scene3d` 的相机不是正视或带旋转，`sp3d` 有棱台、挤出或轮廓。
 */
export function readThreeD(x: Reader): boolean {
  let visible = false
  if (x.local === 'sp3d') {
    visible = num(x, 'extrusionH', 0) > 0 || num(x, 'contourW', 0) > 0
    eachChild(x, (local) => {
      if (local === 'bevelT' || local === 'bevelB') visible = true
    })
    return visible
  }
  eachChild(x, (local) => {
    if (local !== 'camera') return
    if ((x.attr('prst') ?? 'orthographicFront') !== 'orthographicFront') visible = true
    eachChild(x, (child) => {
      if (child !== 'rot') return
      if (num(x, 'lat', 0) !== 0 || num(x, 'lon', 0) !== 0 || num(x, 'rev', 0) !== 0) visible = true
    })
  })
  return visible
}

function color(spec: ColorSpec | null, context: ColorContext): Color | null {
  return spec === null ? null : resolveColor(spec, context)
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 }

export function resolveFill(spec: FillSpec, context: ColorContext): Fill {
  switch (spec.kind) {
    case 'solid': {
      const c = color(spec.color, context)
      return c === null ? { kind: 'none' } : { kind: 'solid', color: c }
    }
    case 'gradient': {
      const stops: GradientStop<Color>[] = []
      for (const s of spec.stops) {
        const c = color(s.color, context)
        if (c !== null) stops.push({ position: s.position, color: c })
      }
      if (stops.length === 0) return { kind: 'none' }
      return { ...spec, stops }
    }
    case 'pattern':
      return {
        kind: 'pattern',
        preset: spec.preset,
        foreground: color(spec.foreground, context) ?? BLACK,
        background: color(spec.background, context) ?? WHITE,
      }
    default:
      return spec
  }
}

/** 没有线条（缺少填充或为无填充、组合填充）时为 `null`。 */
export function resolveLine(spec: LineSpec, context: ColorContext): Line | null {
  if (spec.fill === undefined) return null
  const fill = resolveFill(spec.fill, context)
  if (fill.kind === 'none' || fill.kind === 'group') return null
  const head = spec.head ?? DEFAULT_LINE_END
  const tail = spec.tail ?? DEFAULT_LINE_END
  return {
    width: spec.width ?? 0,
    fill,
    dash: spec.dash ?? { kind: 'preset', name: 'solid' },
    cap: spec.cap ?? 'flat',
    compound: spec.compound ?? 'sng',
    align: spec.align ?? 'ctr',
    join: spec.join ?? 'round',
    miterLimit: spec.join === 'miter' ? (spec.miterLimit ?? 8) : null,
    head: head.type === 'none' ? null : head,
    tail: tail.type === 'none' ? null : tail,
  }
}

export function resolveEffects(list: readonly EffectSpec[], context: ColorContext): Effect[] {
  const out: Effect[] = []
  for (const e of list) {
    if (!('color' in e)) {
      out.push(e)
      continue
    }
    const c = color(e.color, context)
    if (c !== null) out.push({ ...e, color: c })
  }
  return out
}
