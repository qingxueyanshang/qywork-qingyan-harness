/**
 * 文本框中的公式（`model.ts` 的 `Run` 中 `kind` 为 `math` 的字段）：按 `../../math/` 排版为行内对象，绘制时按设备像素取整。
 *
 * - 字号、颜色、粗斜体取各字段的 `RunStyle`；普通文字（数学字体以外的字符）按字段字体的选择规则取字体，缺字形时为
 *   `FaceCache.fallback`。公式设置取缺省值：PresentationML 没有 `m:mathPr`。
 * - 行内公式按 `layoutMath` 的分段成为可在运算符处断开的对象；显示公式（`m:oMathPara`）按显示样式排版，每个 `m:oMath`
 *   独占一行，对齐方式见 `displayAlignment`。有项目符号的段落中的显示公式按行内公式排版（见 `body.ts`）。
 * - 主机没有数学字体或公式含未实现的结构时，公式不绘制、宽度为 0（未实现的结构在求值时计入能力边界）。
 */

import type { GlyphOutlines } from '../../font/index.ts'
import {
  layoutMath,
  MATH_SETTINGS_DEFAULTS,
  type MathEnvironment,
  type MathFont,
  type MathJustification,
  type MathLayout,
  type MathPaintFonts,
  type MathRunStyle,
  type MathZone,
  paintMath,
} from '../../math/index.ts'
import { type Alignment, fontSlot, type InlineObject } from '../../text/index.ts'
import { colorToCss } from '../color.ts'
import type { ShapeFill } from '../fill.ts'
import type { Matrix, PaintContext } from '../paint/context.ts'
import { deviceScale } from '../paint/fill.ts'
import type { FaceCache, PaintFace } from './fonts.ts'
import type { RunStyle } from './model.ts'

const EAST_ASIAN_LANG = /^(zh|ja|ko)(-|$)/i

/** 公式所用的字体，由宿主提供（只有幻灯片上的文字有公式）。 */
export interface TextMathFonts {
  /** 数学字体（`MATH_SETTINGS_DEFAULTS.font`）；主机没有时为 `null`，公式不绘制。 */
  readonly font: MathFont<unknown> | null
  /** 绘制字形所用字体文件的 TrueType 轮廓；没有轮廓时为 `null`。 */
  outlines(face: PaintFace): GlyphOutlines | null
}

/** 一段公式的排版结果与绘制所需的字体。 */
export interface FormulaPaint {
  readonly layout: MathLayout<PaintFace>
  readonly fonts: MathPaintFonts<PaintFace>
}

export interface FormulaPart {
  readonly object: InlineObject
  /** 公式不绘制时为 `null`。 */
  readonly paint: FormulaPaint | null
}

function cssColor(fill: ShapeFill): string {
  if (fill.kind === 'solid') return colorToCss(fill.color)
  if (fill.kind === 'gradient' && fill.stops[0] !== undefined)
    return colorToCss(fill.stops[0].color)
  if (fill.kind === 'pattern') return colorToCss(fill.foreground)
  return '#000000'
}

/** 显示公式的对齐（`m:jc`）对应的段落对齐。WPS 演示实测：显示公式按 `m:jc` 对齐，与段落的 `algn` 无关。 */
export function displayAlignment(jc: MathJustification): Alignment {
  return jc === 'left' ? 'left' : jc === 'right' ? 'right' : 'center'
}

function environment(
  base: RunStyle,
  scale: number,
  faces: FaceCache,
  fonts: TextMathFonts,
): MathEnvironment<RunStyle, PaintFace> | null {
  if (fonts.font === null) return null
  const font: MathFont<PaintFace> = {
    ...fonts.font,
    font: faces.get(MATH_SETTINGS_DEFAULTS.font, false, false),
  }
  const styles = new Map<RunStyle, MathRunStyle<PaintFace>>()
  const style = (props: RunStyle | null): MathRunStyle<PaintFace> => {
    const s = props ?? base
    let out = styles.get(s)
    if (out === undefined) {
      const slots = {
        eastAsiaHint: EAST_ASIAN_LANG.test(s.lang),
        complexScript: false,
        chineseCharset: false,
      }
      out = {
        size: s.size * scale,
        color: cssColor(s.fill),
        bold: s.bold,
        italic: s.italic,
        textFace: (cp) => {
          const slot = fontSlot(cp, slots)
          let f =
            slot === 'eastAsia'
              ? faces.get(s.ea, s.bold, s.italic)
              : slot === 'cs'
                ? faces.get(s.cs, s.bold, s.italic)
                : faces.latin(s.latin, s.latinCharset, s.bold, s.italic)
          if (f.face.metrics.glyphId(cp) === 0) f = faces.fallback
          return {
            face: f.face,
            font: f,
            outlines: fonts.outlines(f),
            eastAsia: slot === 'eastAsia',
          }
        },
      }
      styles.set(s, out)
    }
    return out
  }
  return { font, settings: MATH_SETTINGS_DEFAULTS, style }
}

/** 不绘制的公式：宽度为 0，上下沿取段落缺省字符属性的西文字体。 */
function hidden(base: RunStyle, scale: number, faces: FaceCache): FormulaPart {
  const v = faces.latin(base.latin, base.latinCharset, base.bold, base.italic).face.vertical
  const size = base.size * scale
  return {
    object: {
      advance: 0,
      width: 0,
      ascent: (v.winAscent / v.unitsPerEm) * size,
      descent: (v.winDescent / v.unitsPerEm) * size,
      breaks: 'western',
      breakBefore: false,
      textual: true,
    },
    paint: null,
  }
}

/** 一个 `m:oMath` 排成的行内对象，按可断开处分段。`base` 为段落的缺省字符属性。 */
export function formulaParts(
  zone: MathZone<RunStyle>,
  display: boolean,
  base: RunStyle,
  scale: number,
  faces: FaceCache,
  fonts: TextMathFonts | undefined,
): FormulaPart[] {
  const env = fonts === undefined ? null : environment(base, scale, faces, fonts)
  const result = env === null ? null : layoutMath(zone, env, display)
  if (fonts === undefined || result === null || result.kind !== 'layout')
    return [hidden(base, scale, faces)]
  const paintFonts: MathPaintFonts<PaintFace> = {
    family: (f) => f.family,
    outlines: (f) => fonts.outlines(f),
  }
  return result.segments.map((g, k) => ({
    object: {
      advance: g.advance,
      width: g.width,
      ascent: g.lineAscent,
      descent: g.lineDescent,
      breaks: 'western',
      breakBefore: k > 0,
      textual: true,
    },
    paint: { layout: g, fonts: paintFonts },
  }))
}

/**
 * 在文本区域坐标 (`x`, `baseline`)（磅）处绘制公式。`matrix` 为文本区域到设备坐标的变换：字形按设备像素取整，
 * 绘制期间临时改为不含平移的变换，平移折算到公式原点。
 */
export function paintFormula(
  ctx: PaintContext,
  formula: FormulaPaint,
  x: number,
  baseline: number,
  matrix: Matrix,
): void {
  const s = deviceScale(matrix)
  const { a, b, c, d, e, f } = matrix
  const det = a * d - b * c
  if (s <= 0 || det === 0) return
  // 平移 (e, f) 换算到文本区域坐标：解 [a c; b d]·(u, v) = (e, f)。
  const u = (d * e - c * f) / det
  const v = (a * f - b * e) / det
  ctx.save()
  ctx.setTransform(a / s, b / s, c / s, d / s, 0, 0)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  paintMath(ctx, formula.layout, x + u, baseline + v, formula.fonts, s)
  ctx.restore()
}
