/**
 * OfficeArt 形状属性中的颜色、填充、线条与阴影换算为已求值的 DrawingML 模型（`../drawingml/fill.ts`）。
 *
 * - 属性表为缺省属性、母版形状与形状自身依次合并后的结果（`mergeProperties`）；表中没有的属性取 MS-ODRAW 规定的缺省值。
 * - 颜色（OfficeArtCOLORREF）：第 3 字节为标志。配色方案序号（0x08）取宿主的配色方案；系统序号（0x10）的低 8 位
 *   0xF0–0xF7 引用本形状的填充色、线条色等，其后按第 8–11 位的运算（变暗、变亮、加减灰度、阈值）与第 12–15 位的标志
 *   （灰度、反转高位、反转）以第 2 字节为参数修改；低于 0xF0 的系统序号取 Windows 缺省的系统颜色。调色板序号（0x01）无法求值。
 * - 渐变（填充类型 4–8）：`fillAngle` 为 16.16 定点数的角度，`fillFocus` 为百分比。两色渐变的起止颜色、方向与轴向渐变的判定
 *   按 `fillAngle` 的符号、`fillFocus` 是否为 0、为负与是否在 (40, 60) 之间逐项互换，线性渐变的 DrawingML 角度为
 *   `fillAngle + 90°`。`fillShadeColors` 给出多个色标时取色标。
 * - 图案填充（类型 1）的图案是 8 × 8 单色位图，按宿主给出的预设名绘制，前景为 `fillColor`、背景为 `fillBackColor`。
 * - 阴影只实现偏移阴影（`shadowType` 0、1）；其他阴影类型计入 `effect`，三维（`f3D`）计入 `effect3d`。
 */

import type { Color } from '../drawingml/color.ts'
import type {
  Effect,
  GradientStop,
  ImageEffect,
  ImageFill,
  Line,
  LineEnd,
  LineEndSize,
  ShapeFill,
} from '../drawingml/fill.ts'
import { type ArtProperties, arrayElementSize, flagOf } from './records.ts'

export type ArtFinding = 'effect' | 'effect3d' | 'imageEffect'

export interface ArtStyleContext {
  /** 配色方案序号的颜色：.ppt 为幻灯片配色方案的 8 种颜色；宿主没有配色方案时为空。 */
  readonly scheme: readonly Color[]
  /** `pib`（从 1 起）的图片部件名；图片库中没有该图片时为 `null`。 */
  picture(pib: number): string | null
  /** `pib` 所指的图案位图对应的 DrawingML 预设图案名；不是可识别的图案时为 `null`。 */
  pattern(pib: number): string | null
  /** 填充类型 9（使用背景）的填充。 */
  readonly background: ShapeFill
  readonly found: { push(...kinds: ArtFinding[]): unknown }
}

const P = {
  rotation: 0x0004,
  cropTop: 0x0100,
  cropBottom: 0x0101,
  cropLeft: 0x0102,
  cropRight: 0x0103,
  pib: 0x0104,
  pictureTransparent: 0x0107,
  pictureContrast: 0x0108,
  pictureBrightness: 0x0109,
  blipBooleans: 0x013f,
  fillType: 0x0180,
  fillColor: 0x0181,
  fillOpacity: 0x0182,
  fillBackColor: 0x0183,
  fillBackOpacity: 0x0184,
  fillBlip: 0x0186,
  fillAngle: 0x018b,
  fillFocus: 0x018c,
  fillToLeft: 0x018d,
  fillToTop: 0x018e,
  fillToRight: 0x018f,
  fillToBottom: 0x0190,
  fillShadeColors: 0x0197,
  fillBooleans: 0x01bf,
  lineColor: 0x01c0,
  lineOpacity: 0x01c1,
  lineBackColor: 0x01c2,
  lineType: 0x01c4,
  lineWidth: 0x01cb,
  lineMiterLimit: 0x01cc,
  lineStyle: 0x01cd,
  lineDashing: 0x01ce,
  lineStartArrowhead: 0x01d0,
  lineEndArrowhead: 0x01d1,
  lineStartArrowWidth: 0x01d2,
  lineStartArrowLength: 0x01d3,
  lineEndArrowWidth: 0x01d4,
  lineEndArrowLength: 0x01d5,
  lineJoinStyle: 0x01d6,
  lineEndCapStyle: 0x01d7,
  lineBooleans: 0x01ff,
  shadowType: 0x0200,
  shadowColor: 0x0201,
  shadowOpacity: 0x0204,
  shadowOffsetX: 0x0205,
  shadowOffsetY: 0x0206,
  shadowBooleans: 0x023f,
  threeDBooleans: 0x02bf,
} as const

const WHITE = 0x00ffffff
const BLACK = 0x00000000
const GRAY = 0x00808080

/** Windows 缺省的系统颜色（`GetSysColor` 的序号）。 */
const SYSTEM_COLORS: readonly number[] = [
  0xc8c8c8, 0x000000, 0xd1b499, 0xdbcdbf, 0xf0f0f0, 0xffffff, 0x646464, 0x000000, 0x000000,
  0x000000, 0xb4b4b4, 0xfcf7f4, 0xababab, 0xff9933, 0xffffff, 0xf0f0f0, 0xa0a0a0, 0x6d6d6d,
  0x000000, 0x544e43, 0xffffff, 0x696969, 0xe3e3e3, 0x000000, 0xe1ffff,
]

function rgb(value: number, a: number): Color {
  return {
    r: (value & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: ((value >> 16) & 0xff) / 255,
    a,
  }
}

function toByte(c: number): number {
  return Math.round(Math.min(Math.max(c, 0), 1) * 255)
}

/** 系统序号的颜色修改：参数、运算与标志见文件头。 */
function modify(base: Color, value: number): Color {
  const p = (value >>> 16) & 0xff
  const op = (value >>> 8) & 0x0f
  const flags = (value >>> 12) & 0x0f
  let [r, g, b] = [toByte(base.r), toByte(base.g), toByte(base.b)]
  if (flags & 0x8) r = g = b = Math.round((r * 77 + g * 151 + b * 28) / 256)
  const each = (f: (c: number) => number) => {
    r = f(r)
    g = f(g)
    b = f(b)
  }
  if (op === 1) each((c) => (p * c) >> 8)
  else if (op === 2) each((c) => ((0xff - p) * 0xff + p * c) >> 8)
  else if (op === 3) each((c) => Math.min(c + p, 0xff))
  else if (op === 4) each((c) => Math.max(c - p, 0))
  else if (op === 5) each((c) => Math.max(p - c, 0))
  else if (op === 6) each((c) => (c < p ? 0 : 0xff))
  if (flags & 0x4) each((c) => c ^ 0x80)
  if (flags & 0x2) each((c) => 0xff - c)
  return { r: r / 255, g: g / 255, b: b / 255, a: base.a }
}

/** 系统序号 0xF0–0xF7 引用的属性与其缺省值。 */
const REFERENCED: Readonly<Record<number, readonly [number, number]>> = {
  240: [P.fillColor, WHITE],
  242: [P.lineColor, BLACK],
  243: [P.shadowColor, GRAY],
  245: [P.fillBackColor, WHITE],
  246: [P.lineBackColor, WHITE],
  247: [P.fillColor, WHITE],
}

/** OfficeArtCOLORREF 求值；无法求值时为 `null`。`depth` 防止系统序号互相引用。 */
export function artColor(
  value: number,
  alpha: number,
  props: ArtProperties,
  scheme: readonly Color[],
  depth = 0,
): Color | null {
  const flags = value >>> 24
  if (flags & 0x10) {
    const index = value & 0xff
    let base: Color | null
    if (index >= 0xf0) {
      const ref =
        index === 0xf1
          ? props.values.has(P.lineColor)
            ? REFERENCED[0xf2]
            : REFERENCED[0xf0]
          : REFERENCED[index]
      if (ref === undefined || depth > 2) return null
      base = artColor(props.values.get(ref[0]) ?? ref[1], alpha, props, scheme, depth + 1)
    } else {
      const sys = SYSTEM_COLORS[index]
      base = sys === undefined ? null : rgb(sys, alpha)
    }
    return base === null ? null : modify(base, value)
  }
  if (flags & 0x08) {
    const c = scheme[value & 0xff]
    return c === undefined ? null : { ...c, a: alpha }
  }
  if (flags & 0x01) return null
  return rgb(value, alpha)
}

function fixed(props: ArtProperties, id: number, fallback: number): number {
  const v = props.values.get(id)
  return v === undefined ? fallback : (v | 0) / 65536
}

function color(
  props: ArtProperties,
  id: number,
  fallback: number,
  alpha: number,
  ctx: ArtStyleContext,
) {
  return artColor(props.values.get(id) ?? fallback, alpha, props, ctx.scheme)
}

function shadeStops(
  props: ArtProperties,
  ctx: ArtStyleContext,
  a1: number,
  a2: number,
): GradientStop<Color>[] | null {
  const data = props.complex.get(P.fillShadeColors)
  if (data === undefined || data.length < 6) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const size = arrayElementSize(view.getUint16(4, true))
  const count = view.getUint16(0, true)
  if (size !== 8 || count < 2 || data.length < 6 + count * 8) return null
  const out: GradientStop<Color>[] = []
  for (let i = 0; i < count; i++) {
    const c = artColor(view.getUint32(6 + i * 8, true), 1, props, ctx.scheme)
    if (c === null) return null
    const position = Math.min(Math.max(view.getInt32(10 + i * 8, true) / 65536, 0), 1)
    out.push({ position, color: { ...c, a: a1 + (a2 - a1) * position } })
  }
  return out
}

function gradientFill(type: number, props: ArtProperties, ctx: ArtStyleContext): ShapeFill {
  const alpha = fixed(props, P.fillOpacity, 1)
  const backAlpha = fixed(props, P.fillBackOpacity, 1)
  const angle = fixed(props, P.fillAngle, 0)
  let focus = (props.values.get(P.fillFocus) ?? 0) | 0
  let swap = angle >= 0
  if (focus === 0) swap = !swap
  else if (focus < 0) {
    focus = -focus
    swap = !swap
  }
  const axial = focus > 40 && focus < 60
  if (axial) swap = !swap
  const path = type === 5 || type === 6
  if (path) swap = !swap
  const c1 = color(props, P.fillColor, WHITE, alpha, ctx)
  const c2 = color(props, P.fillBackColor, WHITE, backAlpha, ctx)
  if (c1 === null || c2 === null) return { kind: 'none' }
  // 起点为 c2、终点为 c1（互换后相反）；路径渐变的起点在边缘，DrawingML 的位置 0 在中心。
  let stops: GradientStop<Color>[] = shadeStops(props, ctx, backAlpha, alpha) ?? [
    { position: 0, color: c2 },
    { position: 1, color: c1 },
  ]
  if (swap) stops = stops.map((s) => ({ ...s, position: 1 - s.position })).reverse()
  if (path) stops = stops.map((s) => ({ ...s, position: 1 - s.position })).reverse()
  if (axial && !path) {
    stops = [
      ...stops.map((s) => ({ ...s, position: s.position / 2 })),
      ...stops
        .slice(0, -1)
        .reverse()
        .map((s) => ({ ...s, position: 1 - s.position / 2 })),
    ]
  }
  if (!path) {
    return {
      kind: 'gradient',
      stops,
      shade: { kind: 'linear', angle: (((angle + 90) % 360) + 360) % 360, scaled: type === 7 },
      flip: 'none',
      rotateWithShape: true,
    }
  }
  const focusRect =
    type === 6
      ? { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }
      : {
          left: fixed(props, P.fillToLeft, 0),
          top: fixed(props, P.fillToTop, 0),
          right: 1 - fixed(props, P.fillToRight, 0),
          bottom: 1 - fixed(props, P.fillToBottom, 0),
        }
  return {
    kind: 'gradient',
    stops,
    shade: { kind: 'path', path: type === 6 ? 'shape' : 'rect', focus: focusRect },
    flip: 'none',
    rotateWithShape: true,
  }
}

function imageFill(part: string, tiled: boolean, alpha: number): ImageFill {
  return {
    part,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    stretch: tiled ? null : { left: 0, top: 0, right: 0, bottom: 0 },
    tile: tiled
      ? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flip: 'none', align: 'tl' }
      : null,
    alpha,
    effects: [],
    rotateWithShape: true,
  }
}

/** 形状填充：`fFilled`（0x01BF 第 4 位，缺省为真）为假时无填充。 */
export function artFill(props: ArtProperties, ctx: ArtStyleContext): ShapeFill {
  if (!flagOf(props, P.fillBooleans, 4, true)) return { kind: 'none' }
  const type = props.values.get(P.fillType) ?? 0
  const alpha = fixed(props, P.fillOpacity, 1)
  if (type === 0) {
    const c = color(props, P.fillColor, WHITE, alpha, ctx)
    return c === null ? { kind: 'none' } : { kind: 'solid', color: c }
  }
  if (type === 1) {
    const preset = ctx.pattern(props.values.get(P.fillBlip) ?? 0)
    const fg = color(props, P.fillColor, WHITE, alpha, ctx)
    const bg = color(props, P.fillBackColor, WHITE, fixed(props, P.fillBackOpacity, 1), ctx)
    if (preset === null || fg === null || bg === null) {
      ctx.found.push('effect')
      return fg === null ? { kind: 'none' } : { kind: 'solid', color: fg }
    }
    return { kind: 'pattern', preset, foreground: fg, background: bg }
  }
  if (type === 2 || type === 3) {
    const part = ctx.picture(props.values.get(P.fillBlip) ?? 0)
    return part === null
      ? { kind: 'none' }
      : { kind: 'picture', image: imageFill(part, type === 2, alpha) }
  }
  if (type >= 4 && type <= 8) return gradientFill(type, props, ctx)
  if (type === 9) return ctx.background
  return { kind: 'none' }
}

const DASHES = [
  'solid',
  'sysDash',
  'sysDot',
  'sysDashDot',
  'sysDashDotDot',
  'dot',
  'dash',
  'lgDash',
  'dashDot',
  'lgDashDot',
  'lgDashDotDot',
]
const COMPOUNDS = ['sng', 'dbl', 'thickThin', 'thinThick', 'tri']
const ARROWHEADS = ['none', 'triangle', 'stealth', 'diamond', 'oval', 'arrow']
const END_SIZES: readonly LineEndSize[] = ['sm', 'med', 'lg']
const JOINS = ['bevel', 'miter', 'round'] as const
const CAPS = ['rnd', 'sq', 'flat'] as const

function lineEnd(
  props: ArtProperties,
  head: number,
  width: number,
  length: number,
): LineEnd | null {
  const type = ARROWHEADS[props.values.get(head) ?? 0]
  if (type === undefined || type === 'none') return null
  return {
    type,
    width: END_SIZES[props.values.get(width) ?? 1] ?? 'med',
    length: END_SIZES[props.values.get(length) ?? 1] ?? 'med',
  }
}

/** 线条：`fLine`（0x01FF 第 3 位，缺省为真）为假时没有线条。非纯色线条按线条颜色绘制并计入 `effect`。 */
export function artLine(props: ArtProperties, ctx: ArtStyleContext): Line | null {
  if (!flagOf(props, P.lineBooleans, 3, true)) return null
  const c = color(props, P.lineColor, BLACK, fixed(props, P.lineOpacity, 1), ctx)
  if (c === null) return null
  if ((props.values.get(P.lineType) ?? 0) !== 0) ctx.found.push('effect')
  const join = JOINS[props.values.get(P.lineJoinStyle) ?? 2] ?? 'round'
  return {
    width: props.values.get(P.lineWidth) ?? 9525,
    fill: { kind: 'solid', color: c },
    dash: { kind: 'preset', name: DASHES[props.values.get(P.lineDashing) ?? 0] ?? 'solid' },
    cap: CAPS[props.values.get(P.lineEndCapStyle) ?? 2] ?? 'flat',
    compound: COMPOUNDS[props.values.get(P.lineStyle) ?? 0] ?? 'sng',
    align: 'ctr',
    join,
    miterLimit: join === 'miter' ? fixed(props, P.lineMiterLimit, 8) : null,
    head: lineEnd(props, P.lineStartArrowhead, P.lineStartArrowWidth, P.lineStartArrowLength),
    tail: lineEnd(props, P.lineEndArrowhead, P.lineEndArrowWidth, P.lineEndArrowLength),
  }
}

/** 阴影（`fShadow`，0x023F 第 1 位）与三维（`f3D`，0x02BF 第 3 位）。 */
export function artEffects(props: ArtProperties, ctx: ArtStyleContext): Effect[] {
  if (flagOf(props, P.threeDBooleans, 3, false)) ctx.found.push('effect3d')
  if (!flagOf(props, P.shadowBooleans, 1, false)) return []
  const type = props.values.get(P.shadowType) ?? 0
  if (type > 1) {
    ctx.found.push('effect')
    return []
  }
  const c = color(props, P.shadowColor, GRAY, fixed(props, P.shadowOpacity, 1), ctx)
  if (c === null) return []
  const dx = (props.values.get(P.shadowOffsetX) ?? 25400) | 0
  const dy = (props.values.get(P.shadowOffsetY) ?? 25400) | 0
  return [
    {
      kind: 'outerShadow',
      color: c,
      blur: 0,
      distance: Math.hypot(dx, dy),
      direction: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
      align: 'b',
      rotateWithShape: false,
    },
  ]
}

/** 图片形状的图片：裁剪（16.16 定点数的比例）与图片效果（灰度、黑白；对比度、亮度与透明色计入 `imageEffect`）。 */
export function artPicture(props: ArtProperties, ctx: ArtStyleContext): ImageFill | null {
  const part = ctx.picture(props.values.get(P.pib) ?? 0)
  if (part === null) return null
  const effects: ImageEffect[] = []
  if (flagOf(props, P.blipBooleans, 2, false)) effects.push({ kind: 'grayscale' })
  if (flagOf(props, P.blipBooleans, 1, false)) effects.push({ kind: 'biLevel', threshold: 0.5 })
  if (
    props.values.has(P.pictureContrast) ||
    props.values.has(P.pictureBrightness) ||
    props.values.has(P.pictureTransparent)
  ) {
    ctx.found.push('imageEffect')
  }
  return {
    ...imageFill(part, false, 1),
    crop: {
      left: fixed(props, P.cropLeft, 0),
      top: fixed(props, P.cropTop, 0),
      right: fixed(props, P.cropRight, 0),
      bottom: fixed(props, P.cropBottom, 0),
    },
    effects,
  }
}

/** 旋转角（度，16.16 定点数）。 */
export function artRotation(props: ArtProperties): number {
  return fixed(props, P.rotation, 0)
}
