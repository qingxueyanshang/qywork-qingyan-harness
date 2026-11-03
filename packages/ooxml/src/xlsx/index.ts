/**
 * xlsx 只读预览：解析（可在 Worker 中运行）与 Canvas 绘制。
 *
 * 接入顺序：
 * 1. `parseXlsx(bytes)` 得到纯数据的 `Workbook`，可在 Worker 中调用并经 `postMessage` 传回。
 *    `workbook.unsupported` 为未显示内容的计数，界面据此显示一行能力边界。
 * 2. 按 `workbook.fontNames`（含图片中图元文件文字的字体）与 `fallbackFonts(workbook)` 取得字体文件，主机上没有的字体名再取得 `substituteFont(name)`：
 *    每个字体以同一族名注册为浏览器 `FontFace`，并以 `loadFace` 读取度量，组成 `FontSet`。
 * 3. `createScene(workbook, sheet, fonts)` 计算行高列宽并换算形状的位置；`sheet.images` 由调用方以 `../drawingml/` 的
 *    `decodePicture` 解码（位图与图元文件）。
 * 4. `paintView`（按冻结窗格）或 `paintRegion`（任意区域）绘制到 Canvas 2D 或 `OffscreenCanvas` 上下文；
 *    `SheetResources` 提供解码后的图片、形状所需的图层与显示器的 ClearType 设置。只访问可见区域，滚动时重绘即可。
 */

export type { ClearTypeDisplay } from '../glyph/cleartype/index.ts'
export {
  type FormatOptions,
  type FormatPart,
  type FormattedValue,
  formatNumber,
  formatText,
  plainText,
} from '../numfmt/format.ts'
export type {
  AnchorMarker,
  AutoShapeNode,
  BorderLine,
  BorderLineStyle,
  Cell,
  CellAlignment,
  CellBorder,
  CellFill,
  CellRange,
  CellStyle,
  CellValue,
  CfRule,
  CfRuleKind,
  CfThreshold,
  ColumnSpec,
  ConditionalFormat,
  ConnectorNode,
  DifferentialFill,
  DifferentialStyle,
  DrawingAnchor,
  FontStyle,
  GradientStop,
  GroupNode,
  HorizontalAlign,
  PatternType,
  RichRun,
  RowSpec,
  ShapeNode,
  SheetChart,
  SheetFormat,
  SheetImage,
  SheetShape,
  SheetView,
  UnderlineStyle,
  UnsupportedCounts,
  UnsupportedKind,
  VerticalAlign,
  Workbook,
  Worksheet,
} from './model.ts'
export { colName } from './parse/refs.ts'
export { parseXlsx, type XlsxFailure, type XlsxResult } from './parse/workbook.ts'
export type { Axis } from './render/axis.ts'
export {
  type FaceChain,
  FontSet,
  fallbackFonts,
  type LoadedFace,
  loadFace,
  pointsToPixels,
  substituteFont,
} from './render/fonts.ts'
export type { SheetGeometry } from './render/geometry.ts'
export {
  anchorRect,
  createScene,
  initialScroll,
  type PaintContext,
  type PaintRegion,
  type PaintView,
  paintRegion,
  paintView,
  type SheetDrawing,
  type SheetResources,
  type SheetScene,
} from './render/painter.ts'
