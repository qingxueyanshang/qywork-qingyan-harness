/**
 * DrawingML 主题、颜色与填充：docx、xlsx、pptx 共用的主题解析、颜色模型、颜色变换与填充线条效果。
 *
 * - `parseTheme` 读取主题部件的颜色方案、字体方案与格式方案；`styleFill`、`styleLine`、`styleEffect` 按样式矩阵索引取格式方案中的样式。
 * - 颜色先以 `readColor` 读成 `ColorSpec`，再由 `resolveColor` 结合主题、颜色映射与 `phClr` 求值为 `Color`。
 * - 填充、线条与效果同样先读成规格（`readFill`、`readLine`、`readEffects`），再由 `resolveFill`、`resolveLine`、`resolveEffects` 求值。
 * - `rgbToHsl`、`hslToRgb`、`srgbToLinear`、`linearToSrgb` 为色彩空间换算工具，SpreadsheetML 的 `tint` 算法复用前两者。
 * - 几何：`Geometry` 为预设或自定义几何的定义，`shapeOutline` 求值为路径段与文本矩形（预设定义见 `geometry/preset.ts`）。
 * - 绘制：`PaintContext` 为 Canvas 2D 子集；`paintFill`、`paintLine`、`paintWithShadows` 在形状局部坐标中绘制填充、
 *   线条与外部阴影，docx 与 pptx 共用。
 * - 形状与文字：`shape/` 读取与求值形状属性并绘制自选图形、连接线与组合，`text/` 读取、求值、排版与绘制文本框，
 *   pptx 与 xlsx 共用；模型类型 `Frame`、`TextBody` 等在此导出。
 */

export {
  type Color,
  type ColorContext,
  type ColorMap,
  type ColorMapKey,
  type ColorScheme,
  type ColorSpec,
  type ColorTransform,
  type ColorTransformName,
  colorToCss,
  colorToHex,
  DEFAULT_COLOR_MAP,
  type Hsl,
  hslToRgb,
  isColorElement,
  linearToSrgb,
  parseHexColor,
  parsePercentage,
  type Rgb,
  readColor,
  resolveColor,
  rgbToHsl,
  SCHEME_SLOTS,
  type SchemeColorName,
  type SchemeSlot,
  srgbToLinear,
} from './color.ts'
export {
  type Effect,
  type EffectOf,
  type EffectSpec,
  type Fill,
  type FillOf,
  type FillSpec,
  type GradientShade,
  type GradientStop,
  type ImageFill,
  type ImageTile,
  isFillElement,
  type Line,
  type LineCap,
  type LineDash,
  type LineEnd,
  type LineEndSize,
  type LineJoin,
  type LineSpec,
  mergeLine,
  type Reader,
  type RelativeRect,
  readEffects,
  readFill,
  readLine,
  readThreeD,
  resolveEffects,
  resolveFill,
  resolveLine,
  type ShapeFill,
  type TileFlip,
  ZERO_RECT,
} from './fill.ts'
export {
  evaluateFormula,
  evaluateGuides,
  type GuideValues,
} from './geometry/formula.ts'
export type {
  CustomGeometry,
  Geometry,
  GeometryPath,
  GeometryValue,
  Guide,
  PathCommand,
  PathPoint,
  TextRect,
} from './geometry/model.ts'
export {
  type Box,
  type PathFill,
  pathEnds,
  type Segment,
  type ShapeOutline,
  type ShapePath,
  shapeOutline,
  type Tangent,
} from './geometry/path.ts'
export { presetGeometry } from './geometry/preset.ts'
export type {
  CreateCanvas,
  Matrix,
  PaintCanvas,
  PaintContext,
  PaintGradient,
  PaintImage,
  PaintPattern,
} from './paint/context.ts'
export {
  type FillArea,
  type PaintResources,
  paintFill,
  paintImageFill,
  tracePath,
} from './paint/fill.ts'
export { paintLine } from './paint/line.ts'
export {
  type DeviceRect,
  type OuterShadow,
  paintWithShadows,
  type ShadowFrame,
} from './paint/shadow.ts'
export type { Frame } from './shape/model.ts'
export type {
  Autofit,
  BodyProperties,
  Bullet,
  Paragraph,
  Run,
  RunStyle,
  Spacing,
  TabStop,
  TextBody,
} from './text/model.ts'
export {
  type EffectStyle,
  EMPTY_THEME,
  type FontCollection,
  type FontScheme,
  type FormatScheme,
  parseTheme,
  styleEffect,
  styleFill,
  styleLine,
  type Theme,
} from './theme.ts'
