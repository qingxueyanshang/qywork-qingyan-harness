/**
 * DrawingML 颜色模型与颜色变换。
 *
 * - `Color` 的 r、g、b 为 sRGB 编码值，a 为不透明度，均为 0–1 的浮点数；只在输出（`colorToHex`、`colorToCss`）时取整。
 * - 读取与求值分开：`readColor` 只记录基色与变换，`resolveColor` 在主题与 `phClr` 占位色确定后求值。
 * - 变换按文档顺序逐个作用，每一步的输入是上一步的输出，结果夹到有效范围（分量与不透明度 0–1，色相取模 360°）。
 * - 各变换作用的色彩空间：
 *   - `hue`、`sat`、`lum` 及其 `Mod`、`Off` 与 `comp` 在 HSL 中计算，HSL 由 sRGB 编码值换算（规范：HSL 采用感知伽马 2.2）。
 *     `comp` 为色相旋转 180°，结果与输入混合为灰色。
 *   - `tint`、`shade`、`inv`、`red`、`green`、`blue` 及其 `Mod`、`Off` 在线性 RGB 中计算
 *     （规范：scRGB 为线性伽马 1.0，`red` 等的取值与 `scrgbClr` 的分量同为百分比）。规范未写明 `tint`、`shade`、
 *     `inv` 的色彩空间：`tint` 与白色、`shade` 与黑色按比例混合，`inv` 取反，均按线性值计算
 *     （WPS 演示导出图中三种变换的 15 个色块逐值一致，按 sRGB 编码值计算均不一致）。
 *   - `gray` 在 sRGB 编码值上按 55 : 182 : 18 加权：WPS 演示导出图中 48 种基色的色块与
 *     `round((55R + 182G + 18B) / 255)` 全部一致；按线性值加权、按 Rec. 709 系数加权均不一致。
 *   - `gamma`、`invGamma` 对 sRGB 编码值施加 sRGB 传递函数及其反函数。
 *   - `alpha` 及其 `Mod`、`Off` 只作用于不透明度。
 * - sRGB 与线性值的换算使用 IEC 61966-2-1 的分段传递函数。
 */

import type { XmlScanner } from '../xml/index.ts'
import { presetColorHex } from './preset.ts'

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface Color extends Rgb {
  readonly a: number
}

/** h 为 0–360 的角度，s 与 l 为 0–1。 */
export interface Hsl {
  readonly h: number
  readonly s: number
  readonly l: number
}

/** 主题颜色方案的十二个槽位，按 `clrScheme` 中的元素顺序。 */
export const SCHEME_SLOTS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const

export type SchemeSlot = (typeof SCHEME_SLOTS)[number]

/** 槽位缺失或无法求值时为 `null`。 */
export type ColorScheme = Readonly<Record<SchemeSlot, Color | null>>

/** 颜色映射（`clrMap`）的键：`schemeClr` 中经映射再落到槽位的名称。 */
export type ColorMapKey =
  | 'bg1'
  | 'tx1'
  | 'bg2'
  | 'tx2'
  | 'accent1'
  | 'accent2'
  | 'accent3'
  | 'accent4'
  | 'accent5'
  | 'accent6'
  | 'hlink'
  | 'folHlink'

export type ColorMap = Readonly<Record<ColorMapKey, SchemeSlot>>

/** 没有 `clrMap` 的格式（SpreadsheetML）与未指定映射时使用：背景取浅色槽位，文本取深色槽位。 */
export const DEFAULT_COLOR_MAP: ColorMap = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
}

/** `schemeClr` 的 `val` 取值：槽位名、映射键与占位色 `phClr`。 */
export type SchemeColorName = SchemeSlot | ColorMapKey | 'phClr'

export type ColorTransformName =
  | 'tint'
  | 'shade'
  | 'comp'
  | 'inv'
  | 'gray'
  | 'alpha'
  | 'alphaOff'
  | 'alphaMod'
  | 'hue'
  | 'hueOff'
  | 'hueMod'
  | 'sat'
  | 'satOff'
  | 'satMod'
  | 'lum'
  | 'lumOff'
  | 'lumMod'
  | 'red'
  | 'redOff'
  | 'redMod'
  | 'green'
  | 'greenOff'
  | 'greenMod'
  | 'blue'
  | 'blueOff'
  | 'blueMod'
  | 'gamma'
  | 'invGamma'

/** `value`：百分比为小数（50% 为 0.5），`hue` 与 `hueOff` 为角度，无参数的变换为 0。 */
export interface ColorTransform {
  readonly name: ColorTransformName
  readonly value: number
}

export type ColorSpec =
  | { readonly kind: 'rgb'; readonly color: Color; readonly transforms: readonly ColorTransform[] }
  | {
      readonly kind: 'scheme'
      readonly name: SchemeColorName
      readonly transforms: readonly ColorTransform[]
    }

export interface ColorContext {
  readonly scheme: ColorScheme
  /** 缺省为 `DEFAULT_COLOR_MAP`。 */
  readonly map?: ColorMap
  /** `phClr` 的取值，由引用样式的上下文提供；缺省时 `phClr` 无法求值。 */
  readonly placeholder?: Color
}

const COLOR_ELEMENTS = new Set(['srgbClr', 'scrgbClr', 'hslClr', 'sysClr', 'prstClr', 'schemeClr'])
const SCHEME_NAMES = new Set<string>([...SCHEME_SLOTS, 'bg1', 'tx1', 'bg2', 'tx2', 'phClr'])
const NO_VALUE = new Set<string>(['comp', 'inv', 'gray', 'gamma', 'invGamma'])
const ANGLE = new Set<string>(['hue', 'hueOff'])
const TRANSFORMS = new Set<string>([
  ...NO_VALUE,
  ...ANGLE,
  'tint',
  'shade',
  'alpha',
  'alphaOff',
  'alphaMod',
  'hueMod',
  'sat',
  'satOff',
  'satMod',
  'lum',
  'lumOff',
  'lumMod',
  'red',
  'redOff',
  'redMod',
  'green',
  'greenOff',
  'greenMod',
  'blue',
  'blueOff',
  'blueMod',
])
/** `gray` 的加权系数，作用于 sRGB 编码值，三者之和为 1。 */
const GRAY_R = 55 / 255
const GRAY_G = 182 / 255
const GRAY_B = 18 / 255

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function wrapDegrees(h: number): number {
  const w = h % 360
  return w < 0 ? w + 360 : w
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

/** 分量为 0–1。无彩色（最大分量等于最小分量）时 h 与 s 为 0。 */
export function rgbToHsl(c: Rgb): Hsl {
  const { r, g, b } = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = Math.min(1, d / (1 - Math.abs(2 * l - 1)))
  const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: wrapDegrees(h * 60), s, l }
}

export function hslToRgb(c: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * c.l - 1)) * c.s
  const sector = wrapDegrees(c.h) / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const m = c.l - chroma / 2
  const [r, g, b] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return { r: r + m, g: g + m, b: b + m }
}

/** `RRGGBB`（不区分大小写）为不透明颜色；格式不符时为 `null`。 */
export function parseHexColor(hex: string | null): Color | null {
  if (hex === null || !/^[0-9A-Fa-f]{6}$/.test(hex)) return null
  const n = Number.parseInt(hex, 16)
  return { r: (n >> 16) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255, a: 1 }
}

function byte(v: number): number {
  return Math.round(clamp01(v) * 255)
}

/** 大写 `RRGGBB`，不含不透明度。 */
export function colorToHex(c: Rgb): string {
  return ((byte(c.r) << 16) | (byte(c.g) << 8) | byte(c.b))
    .toString(16)
    .toUpperCase()
    .padStart(6, '0')
}

/** 不透明时为 `#RRGGBB`，否则为 `rgba(r, g, b, a)`，a 保留三位小数。 */
export function colorToCss(c: Color): string {
  if (c.a >= 1) return `#${colorToHex(c)}`
  return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(clamp01(c.a) * 1000) / 1000})`
}

/** 百分比属性：`50%` 形式与千分之一百分点的整数形式（`50000`）都接受，返回小数；无法解析时为 `null`。 */
export function parsePercentage(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const percent = value.endsWith('%')
  const n = Number(percent ? value.slice(0, -1) : value)
  if (!Number.isFinite(n)) return null
  return percent ? n / 100 : n / 100000
}

/** 角度属性：六万分之一度的整数，返回度。 */
function parseAngle(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n / 60000 : null
}

export function isColorElement(local: string): boolean {
  return COLOR_ELEMENTS.has(local)
}

/**
 * 读取一个颜色元素及其变换子元素。调用时 `x` 位于颜色元素的开始标签，返回时位于其结束标签。
 *
 * 元素按本地名匹配。不是颜色元素、基色无法解析（十六进制格式错误、`sysClr` 缺少 `lastClr`、未知的预设名或槽位名）
 * 时返回 `null`，同样读到结束标签为止。无法解析的变换跳过，其余变换保留。
 */
export function readColor(
  x: Pick<XmlScanner, 'next' | 'local' | 'depth' | 'attr'>,
): ColorSpec | null {
  const depth = x.depth
  const base = readBase(x)
  const transforms: ColorTransform[] = []
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.depth !== depth + 1 || !TRANSFORMS.has(x.local)) continue
    const name = x.local as ColorTransformName
    const value = NO_VALUE.has(name)
      ? 0
      : ANGLE.has(name)
        ? parseAngle(x.attr('val'))
        : parsePercentage(x.attr('val'))
    if (value !== null) transforms.push({ name, value })
  }
  if (base === null) return null
  return typeof base === 'string'
    ? { kind: 'scheme', name: base, transforms }
    : { kind: 'rgb', color: base, transforms }
}

function readBase(x: Pick<XmlScanner, 'local' | 'attr'>): Color | SchemeColorName | null {
  switch (x.local) {
    case 'srgbClr':
      return parseHexColor(x.attr('val'))
    case 'sysClr':
      return parseHexColor(x.attr('lastClr'))
    case 'prstClr': {
      const name = x.attr('val')
      return name === null ? null : parseHexColor(presetColorHex(name))
    }
    case 'scrgbClr': {
      const r = parsePercentage(x.attr('r'))
      const g = parsePercentage(x.attr('g'))
      const b = parsePercentage(x.attr('b'))
      if (r === null || g === null || b === null) return null
      const srgb = (v: number) => linearToSrgb(clamp01(v))
      return { r: srgb(r), g: srgb(g), b: srgb(b), a: 1 }
    }
    case 'hslClr': {
      const h = parseAngle(x.attr('hue'))
      const s = parsePercentage(x.attr('sat'))
      const l = parsePercentage(x.attr('lum'))
      if (h === null || s === null || l === null) return null
      return { ...hslToRgb({ h, s: clamp01(s), l: clamp01(l) }), a: 1 }
    }
    case 'schemeClr': {
      const val = x.attr('val')
      return val !== null && SCHEME_NAMES.has(val) ? (val as SchemeColorName) : null
    }
  }
  return null
}

function slotOf(name: SchemeSlot | ColorMapKey, map: ColorMap): SchemeSlot {
  return name in map ? map[name as ColorMapKey] : (name as SchemeSlot)
}

/** 基色无法确定（槽位为 `null`、`phClr` 没有占位色）时为 `null`。 */
export function resolveColor(spec: ColorSpec, context: ColorContext): Color | null {
  let base: Color | null
  if (spec.kind === 'rgb') base = spec.color
  else if (spec.name === 'phClr') base = context.placeholder ?? null
  else base = context.scheme[slotOf(spec.name, context.map ?? DEFAULT_COLOR_MAP)]
  return base === null ? null : applyTransforms(base, spec.transforms)
}

/** 按顺序施加变换；色彩空间见文件头。 */
export function applyTransforms(color: Color, transforms: readonly ColorTransform[]): Color {
  let c = color
  for (const t of transforms) c = applyTransform(c, t)
  return c
}

function inHsl(c: Color, edit: (hsl: Hsl) => Hsl): Color {
  const { h, s, l } = edit(rgbToHsl(c))
  return { ...hslToRgb({ h: wrapDegrees(h), s: clamp01(s), l: clamp01(l) }), a: c.a }
}

function inLinear(c: Color, edit: (linear: Rgb) => Rgb): Color {
  const { r, g, b } = edit({ r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) })
  return {
    r: linearToSrgb(clamp01(r)),
    g: linearToSrgb(clamp01(g)),
    b: linearToSrgb(clamp01(b)),
    a: c.a,
  }
}

function applyTransform(c: Color, { name, value: v }: ColorTransform): Color {
  switch (name) {
    case 'hue':
      return inHsl(c, (x) => ({ ...x, h: v }))
    case 'hueOff':
      return inHsl(c, (x) => ({ ...x, h: x.h + v }))
    case 'hueMod':
      return inHsl(c, (x) => ({ ...x, h: x.h * v }))
    case 'comp':
      return inHsl(c, (x) => ({ ...x, h: x.h + 180 }))
    case 'sat':
      return inHsl(c, (x) => ({ ...x, s: v }))
    case 'satOff':
      return inHsl(c, (x) => ({ ...x, s: x.s + v }))
    case 'satMod':
      return inHsl(c, (x) => ({ ...x, s: x.s * v }))
    case 'lum':
      return inHsl(c, (x) => ({ ...x, l: v }))
    case 'lumOff':
      return inHsl(c, (x) => ({ ...x, l: x.l + v }))
    case 'lumMod':
      return inHsl(c, (x) => ({ ...x, l: x.l * v }))
    case 'tint':
      return inLinear(c, (x) => ({
        r: 1 - (1 - x.r) * v,
        g: 1 - (1 - x.g) * v,
        b: 1 - (1 - x.b) * v,
      }))
    case 'shade':
      return inLinear(c, (x) => ({ r: x.r * v, g: x.g * v, b: x.b * v }))
    case 'inv':
      return inLinear(c, (x) => ({ r: 1 - x.r, g: 1 - x.g, b: 1 - x.b }))
    case 'gray': {
      const y = GRAY_R * c.r + GRAY_G * c.g + GRAY_B * c.b
      return { r: y, g: y, b: y, a: c.a }
    }
    case 'red':
      return inLinear(c, (x) => ({ ...x, r: v }))
    case 'redOff':
      return inLinear(c, (x) => ({ ...x, r: x.r + v }))
    case 'redMod':
      return inLinear(c, (x) => ({ ...x, r: x.r * v }))
    case 'green':
      return inLinear(c, (x) => ({ ...x, g: v }))
    case 'greenOff':
      return inLinear(c, (x) => ({ ...x, g: x.g + v }))
    case 'greenMod':
      return inLinear(c, (x) => ({ ...x, g: x.g * v }))
    case 'blue':
      return inLinear(c, (x) => ({ ...x, b: v }))
    case 'blueOff':
      return inLinear(c, (x) => ({ ...x, b: x.b + v }))
    case 'blueMod':
      return inLinear(c, (x) => ({ ...x, b: x.b * v }))
    case 'gamma':
      return { r: linearToSrgb(c.r), g: linearToSrgb(c.g), b: linearToSrgb(c.b), a: c.a }
    case 'invGamma':
      return { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b), a: c.a }
    case 'alpha':
      return { ...c, a: clamp01(v) }
    case 'alphaOff':
      return { ...c, a: clamp01(c.a + v) }
    case 'alphaMod':
      return { ...c, a: clamp01(c.a * v) }
  }
}
