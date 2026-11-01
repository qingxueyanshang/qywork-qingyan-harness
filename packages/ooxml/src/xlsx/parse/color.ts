/**
 * SpreadsheetML 颜色（`color`、`fgColor`、`bgColor` 等元素）换算为 `#rrggbb`。
 *
 * - 取值顺序：`auto` 为自动颜色（返回 `null`，由使用处决定黑或白）；其次 `rgb`（ARGB，忽略透明度）、
 *   `theme`、`indexed`。都没有时为 `null`。
 * - `theme` 的编号与主题 `clrScheme` 的元素顺序不同：0 为 `lt1`、1 为 `dk1`、2 为 `lt2`、3 为 `dk2`，其后依次为
 *   `accent1`–`accent6`、`hlink`、`folHlink`。按元素顺序取会使「文本 1」与「背景 1」互换。
 * - `tint` 在 HSL 的亮度上计算：负值按比例变暗 `L × (1 + tint)`，正值向白色靠近 `L × (1 − tint) + tint`。
 */

import { colorToHex, hslToRgb, parseHexColor, rgbToHsl, type Theme } from '../../drawingml/index.ts'

/** 默认索引色调色板：0–63，另有 64（系统前景色）与 65（系统背景色）。`indexedColors` 可整体替换 0–63。 */
export const DEFAULT_PALETTE: readonly string[] = [
  '#000000',
  '#ffffff',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
  '#000000',
  '#ffffff',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
  '#800000',
  '#008000',
  '#000080',
  '#808000',
  '#800080',
  '#008080',
  '#c0c0c0',
  '#808080',
  '#9999ff',
  '#993366',
  '#ffffcc',
  '#ccffff',
  '#660066',
  '#ff8080',
  '#0066cc',
  '#ccccff',
  '#000080',
  '#ff00ff',
  '#ffff00',
  '#00ffff',
  '#800080',
  '#800000',
  '#008080',
  '#0000ff',
  '#00ccff',
  '#ccffff',
  '#ccffcc',
  '#ffff99',
  '#99ccff',
  '#ff99cc',
  '#cc99ff',
  '#ffcc99',
  '#3366ff',
  '#33cccc',
  '#99cc00',
  '#ffcc00',
  '#ff9900',
  '#ff6600',
  '#666699',
  '#969696',
  '#003366',
  '#339966',
  '#003300',
  '#333300',
  '#993300',
  '#993366',
  '#333399',
  '#333333',
  '#000000',
  '#ffffff',
]

const THEME_SLOTS = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const

/** 颜色元素的属性原文，换算推迟到调色板确定之后：`indexedColors` 位于样式表末尾。 */
export interface RawColor {
  readonly auto: boolean
  readonly rgb: string | null
  readonly theme: number | null
  readonly indexed: number | null
  readonly tint: number
}

export function readRawColor(attr: (name: string) => string | null): RawColor {
  const num = (name: string): number | null => {
    const v = attr(name)
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const auto = attr('auto')
  return {
    auto: auto === '1' || auto === 'true',
    rgb: attr('rgb'),
    theme: num('theme'),
    indexed: num('indexed'),
    tint: num('tint') ?? 0,
  }
}

export interface ColorContext {
  readonly palette: readonly string[]
  readonly theme: Theme | null
}

export function resolveRawColor(raw: RawColor | null, ctx: ColorContext): string | null {
  if (raw === null || raw.auto) return null
  let hex: string | null = null
  if (raw.rgb !== null) {
    const rgb = raw.rgb.length === 8 ? raw.rgb.slice(2) : raw.rgb
    if (parseHexColor(rgb)) hex = `#${rgb.toLowerCase()}`
  } else if (raw.theme !== null) {
    const slot = THEME_SLOTS[raw.theme]
    const c = slot && ctx.theme ? ctx.theme.colors[slot] : null
    if (c) hex = `#${colorToHex(c).toLowerCase()}`
  } else if (raw.indexed !== null) {
    hex = ctx.palette[raw.indexed] ?? null
  }
  if (hex === null || raw.tint === 0) return hex
  return applyTint(hex, raw.tint)
}

export function applyTint(hex: string, tint: number): string {
  const c = parseHexColor(hex.slice(1))
  if (!c) return hex
  const hsl = rgbToHsl(c)
  const l = tint < 0 ? hsl.l * (1 + tint) : hsl.l * (1 - tint) + tint
  return `#${colorToHex(hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, l)) })).toLowerCase()}`
}
