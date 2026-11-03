/**
 * 公式（OMML）：读取公式树、按 OpenType `MATH` 表与 WPS 实测规则排版、绘制到 Canvas 2D。
 *
 * - `readMath` / `readMathParagraph` 自 `m:oMath` / `m:oMathPara` 读取；字符属性由调用方的回调解释。
 * - `layoutMath` 输出宽度、墨迹上下沿、行顶留白与字形、横线、轮廓项；遇到未实现的结构时返回 `unsupported`。
 * - `paintMath` 按 96 dpi 屏幕显示的规则绘制排版结果。
 */

export { type AtomClass, atomClass, mathLetter, mathText } from './chars.ts'
export {
  layoutMath,
  layoutMathParagraph,
  type MathEnvironment,
  type MathGlyph,
  type MathItem,
  type MathLayout,
  type MathLine,
  type MathOutline,
  type MathParagraphResult,
  type MathRect,
  type MathResult,
  type MathRule,
  type MathRunStyle,
  type MathSegment,
  type MathSlash,
} from './layout.ts'
export {
  hasUnsupportedMath,
  MATH_SETTINGS_DEFAULTS,
  type MathAccent,
  type MathArg,
  type MathBar,
  type MathBox,
  type MathDelimiter,
  type MathEquationArray,
  type MathFraction,
  type MathFunction,
  type MathJustification,
  type MathLimit,
  type MathNary,
  type MathNode,
  type MathParagraph,
  type MathRadical,
  type MathRun,
  type MathScript,
  type MathScripts,
  type MathSettings,
  type MathStyle,
  type MathUnsupported,
  type MathZone,
  mapMathZone,
  mathPropsOf,
} from './model.ts'
export {
  fillAliased,
  MATH_SCREEN_SCALE,
  type MathCanvas,
  type MathPaintFonts,
  paintMath,
} from './paint.ts'
export { MATH_NS, type ReadProps, readMath, readMathParagraph, readMathSettings } from './parse.ts'
export {
  type GlyphConstruction,
  type GlyphPart,
  type GlyphVariant,
  type MathConstantName,
  type MathConstants,
  type MathFont,
  type MathTable,
  readMathFont,
  readMathTable,
} from './table.ts'
