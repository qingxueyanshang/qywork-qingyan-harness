/**
 * 工作簿模型：解析的产出、绘制的输入。
 *
 * - 只含纯数据（对象、数组、`Map`、`Uint8Array`），可经结构化克隆在 Worker 与主线程之间传递；
 *   不含类实例与函数。
 * - 行号与列号一律从 0 起算；区域两端都包含在内。
 * - 颜色一律为 `#rrggbb` 小写十六进制；主题色、索引色与 tint 在解析时已换算完毕。
 * - 长度单位：字号、行高为磅（pt），列宽为 Excel 字符宽度单位，绘图对象的锚点偏移与形状坐标为 EMU
 *   （.xls 的锚点偏移为单元格宽高的比例，见 `RatioMarker`）。
 *   换算为像素在 `render/geometry.ts` 中进行，依赖默认字体的度量。
 */

import type { Chart } from '../drawingml/chart/model.ts'
import type { Effect, Line, ShapeFill } from '../drawingml/fill.ts'
import type { Geometry } from '../drawingml/geometry/model.ts'
import type { Frame } from '../drawingml/shape/model.ts'
import type { TextBody } from '../drawingml/text/model.ts'

export type BorderLineStyle =
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double'
  | 'hair'
  | 'mediumDashed'
  | 'dashDot'
  | 'mediumDashDot'
  | 'dashDotDot'
  | 'mediumDashDotDot'
  | 'slantDashDot'

export interface BorderLine {
  readonly style: BorderLineStyle
  readonly color: string
}

export interface CellBorder {
  readonly left: BorderLine | null
  readonly right: BorderLine | null
  readonly top: BorderLine | null
  readonly bottom: BorderLine | null
  /** 左下到右上的对角线。 */
  readonly diagonalUp: BorderLine | null
  /** 左上到右下的对角线。 */
  readonly diagonalDown: BorderLine | null
}

export type UnderlineStyle = 'none' | 'single' | 'double' | 'singleAccounting' | 'doubleAccounting'

export interface FontStyle {
  readonly name: string
  /** 磅。 */
  readonly size: number
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: UnderlineStyle
  readonly strike: boolean
  /** `null` 为自动颜色（黑色）。 */
  readonly color: string | null
  readonly vertAlign: 'baseline' | 'superscript' | 'subscript'
}

/** `patternFill` 的图案类型，`none` 不进入模型（对应的填充为 `null`）。 */
export type PatternType =
  | 'solid'
  | 'darkGray'
  | 'mediumGray'
  | 'lightGray'
  | 'gray125'
  | 'gray0625'
  | 'darkHorizontal'
  | 'darkVertical'
  | 'darkDown'
  | 'darkUp'
  | 'darkGrid'
  | 'darkTrellis'
  | 'lightHorizontal'
  | 'lightVertical'
  | 'lightDown'
  | 'lightUp'
  | 'lightGrid'
  | 'lightTrellis'

export interface GradientStop {
  /** 0 到 1。 */
  readonly position: number
  readonly color: string
}

export type CellFill =
  | {
      readonly kind: 'pattern'
      readonly pattern: PatternType
      /** 图案前景色；`solid` 的填充色即此色。 */
      readonly fg: string
      readonly bg: string
    }
  | {
      readonly kind: 'gradient'
      /** `linear` 按 `degree` 方向渐变；`path` 从 `left/right/top/bottom` 围成的矩形向外渐变。 */
      readonly type: 'linear' | 'path'
      readonly degree: number
      readonly left: number
      readonly right: number
      readonly top: number
      readonly bottom: number
      readonly stops: readonly GradientStop[]
    }

export type HorizontalAlign =
  | 'general'
  | 'left'
  | 'center'
  | 'right'
  | 'fill'
  | 'justify'
  | 'centerContinuous'
  | 'distributed'

export type VerticalAlign = 'top' | 'center' | 'bottom' | 'justify' | 'distributed'

export interface CellAlignment {
  readonly horizontal: HorizontalAlign
  readonly vertical: VerticalAlign
  readonly wrap: boolean
  readonly shrink: boolean
  /**
   * `textRotation` 原值：0–90 为逆时针角度，91–180 为顺时针 `值 - 90` 度，255 为竖排（字符自上而下堆叠）。
   */
  readonly rotation: number
  /** 缩进级数，每级为默认字体最大数字宽度的 3 倍。 */
  readonly indent: number
}

export interface CellStyle {
  readonly font: FontStyle
  readonly fill: CellFill | null
  readonly border: CellBorder | null
  readonly alignment: CellAlignment
  /** 数字格式代码；`General` 为常规。 */
  readonly numFmt: string
}

/**
 * 差异样式的填充。图案填充中缺失的颜色为 `null`，叠加到单元格时补齐（见 `../render/conditional.ts` 的 `overlay`）：
 * `fg` 为图案色，`bg` 为底色，纯色填充显示 `bg`（`fg` 与 `bg` 相同）。
 */
export type DifferentialFill =
  | Extract<CellFill, { readonly kind: 'gradient' }>
  | {
      readonly kind: 'pattern'
      readonly pattern: PatternType
      readonly fg: string | null
      readonly bg: string | null
    }

/** 条件格式命中后叠加的差异样式（`dxf`）。未出现的部分为 `null`，表示不改变单元格样式。 */
export interface DifferentialStyle {
  readonly bold: boolean | null
  readonly italic: boolean | null
  readonly strike: boolean | null
  readonly underline: UnderlineStyle | null
  readonly color: string | null
  readonly fill: DifferentialFill | null
  readonly border: CellBorder | null
  readonly numFmt: string | null
}

export interface RichRun {
  readonly text: string
  /** `null` 表示沿用单元格字体。 */
  readonly font: FontStyle | null
}

export type CellValue =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'string'; readonly value: string; readonly runs: readonly RichRun[] | null }
  | { readonly type: 'boolean'; readonly value: boolean }
  /** 错误值原文，如 `#DIV/0!`。 */
  | { readonly type: 'error'; readonly value: string }
  /** 没有缓存值的公式：`value` 为以 `=` 开头的公式文本。 */
  | { readonly type: 'formula'; readonly value: string }

export interface Cell {
  /** `null` 为空单元格（文件中写出了该单元格，样式可以为 0）。 */
  readonly value: CellValue | null
  /** `Workbook.styles` 的下标。 */
  readonly style: number
}

export interface CellRange {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

export interface ColumnSpec {
  readonly min: number
  readonly max: number
  /** Excel 字符宽度单位；`null` 为未指定，使用默认列宽。 */
  readonly width: number | null
  readonly hidden: boolean
  /** 列默认样式，`null` 为未指定。 */
  readonly style: number | null
}

export interface RowSpec {
  /** 磅；`null` 为未指定。`custom` 为假时是保存时按内容推算的值，显示时按内容重新推算。 */
  readonly height: number | null
  /** 行高由用户指定（`customHeight`），不随内容变化；`height` 为 `null` 时取默认行高。 */
  readonly custom: boolean
  readonly hidden: boolean
  /** 行默认样式（`customFormat` 为真时有效），`null` 为未指定。 */
  readonly style: number | null
}

export interface SheetFormat {
  /** 磅。 */
  readonly defaultRowHeight: number
  /** 未列出的行默认隐藏。 */
  readonly zeroHeight: boolean
  /** 默认行高由用户指定（`customHeight`）：文件中没有的行取默认行高，文件中有的行仍按内容推算。 */
  readonly customHeight: boolean
  /** Excel 字符宽度单位，`null` 为未指定（按 `baseColWidth` 推算，见 `../render/geometry.ts`）。 */
  readonly defaultColWidth: number | null
  readonly baseColWidth: number
  /** 文件中写出了 `sheetFormatPr`。没有时默认列宽不按字体推算（见 `defaultColumnPixels`）。 */
  readonly declared: boolean
}

export interface SheetView {
  readonly showGridLines: boolean
  /**
   * `colorId` 指定的网格线颜色（索引色），`null` 为未指定。WPS 实测：指定时网格线为该颜色隔一像素一点的点线，
   * 与 `defaultGridColor` 无关；未指定时为浅灰实线。
   */
  readonly gridColor: string | null
  /** 百分比，100 为原始大小。 */
  readonly zoom: number
  readonly rightToLeft: boolean
  /** 冻结的行数与列数；0 为不冻结。 */
  readonly frozenRows: number
  readonly frozenCols: number
  /** 可滚动窗格左上角的单元格，即打开时的滚动位置。 */
  readonly topLeft: { readonly row: number; readonly col: number }
}

/** 条件格式阈值（`cfvo`）。 */
export interface CfThreshold {
  readonly type:
    | 'min'
    | 'max'
    | 'num'
    | 'percent'
    | 'percentile'
    | 'formula'
    | 'autoMin'
    | 'autoMax'
  /** `num`、`percent`、`percentile` 的数值；无法求值时为 `null`。 */
  readonly value: number | null
}

export type CfRuleKind =
  | {
      readonly type: 'cellIs'
      readonly operator:
        | 'lessThan'
        | 'lessThanOrEqual'
        | 'equal'
        | 'notEqual'
        | 'greaterThanOrEqual'
        | 'greaterThan'
        | 'between'
        | 'notBetween'
      readonly formulas: readonly string[]
    }
  | { readonly type: 'expression'; readonly formula: string }
  | {
      readonly type: 'colorScale'
      readonly thresholds: readonly CfThreshold[]
      readonly colors: readonly string[]
    }
  | {
      readonly type: 'dataBar'
      readonly thresholds: readonly CfThreshold[]
      readonly color: string
    }
  | {
      readonly type: 'top10'
      readonly rank: number
      readonly percent: boolean
      readonly bottom: boolean
    }
  | { readonly type: 'aboveAverage'; readonly above: boolean; readonly equal: boolean }
  | { readonly type: 'duplicateValues' | 'uniqueValues' }
  | {
      readonly type: 'containsText' | 'notContainsText' | 'beginsWith' | 'endsWith'
      readonly text: string
    }
  | {
      readonly type: 'containsBlanks' | 'notContainsBlanks' | 'containsErrors' | 'notContainsErrors'
    }

export type CfRule = CfRuleKind & {
  readonly priority: number
  readonly stopIfTrue: boolean
  /** 命中后叠加的差异样式；`null` 为不改变样式（色阶与数据条没有 dxf）。 */
  readonly dxf: DifferentialStyle | null
}

export interface ConditionalFormat {
  readonly ranges: readonly CellRange[]
  readonly rules: readonly CfRule[]
}

/** 绘图对象锚点的一端：单元格加单元格内偏移（EMU）。 */
export interface AnchorMarker {
  readonly col: number
  readonly colOff: number
  readonly row: number
  readonly rowOff: number
}

/**
 * .xls 锚点的一端：单元格内偏移为该列宽度、该行高度的比例（0–1，文件中为列宽的 1/1024 与行高的 1/256）。
 * 不能在解析时换算为 EMU：列宽像素取决于默认字体的最大数字宽度，只在绘制时可知。
 */
export interface RatioMarker {
  readonly col: number
  readonly colRatio: number
  readonly row: number
  readonly rowRatio: number
}

/**
 * 绘图对象的锚点，决定对象在工作表上的矩形。`twoCellAnchor` 的 `editAs` 只决定编辑时调整行列尺寸的行为，
 * 不改变显示位置，不进入模型。
 */
export type DrawingAnchor =
  | { readonly kind: 'twoCell'; readonly from: AnchorMarker; readonly to: AnchorMarker }
  | {
      readonly kind: 'oneCell'
      readonly from: AnchorMarker
      readonly width: number
      readonly height: number
    }
  | { readonly kind: 'cellRatio'; readonly from: RatioMarker; readonly to: RatioMarker }
  /** 绝对位置与尺寸，EMU。 */
  | {
      readonly kind: 'absolute'
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }

export type AbsoluteAnchor = Extract<DrawingAnchor, { readonly kind: 'absolute' }>

export interface SheetImage {
  readonly anchor: DrawingAnchor
  /** 锚点在绘图部件中的序号（从 0 起），与 `SheetShape.order` 共用：序号大的绘制在上层。 */
  readonly order: number
  /** 媒体类型，如 `image/png`；取自包的内容类型。 */
  readonly contentType: string
  readonly bytes: Uint8Array
  /** 裁剪比例（0–1），四边各自从原图边缘向内。 */
  readonly crop: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  }
}

/**
 * 形状树的节点：自选图形（含文本框）、连接线与组合。`frame` 为 EMU，位于顶层对象 `xfrm` 的坐标系中
 * （组合内的子形状已按各级组合的 `chOff`/`chExt` 换算，组合的旋转与翻转在绘制时施加）；填充、线条、效果与文字已求值。
 */
export interface AutoShapeNode {
  readonly kind: 'shape'
  readonly frame: Frame
  readonly geometry: Geometry
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly text: TextBody | null
}

export interface ConnectorNode {
  readonly kind: 'connector'
  readonly frame: Frame
  readonly geometry: Geometry
  readonly line: Line | null
  readonly effects: readonly Effect[]
}

export interface GroupNode {
  readonly kind: 'group'
  readonly frame: Frame
  readonly effects: readonly Effect[]
  readonly children: readonly ShapeNode[]
}

export type ShapeNode = AutoShapeNode | ConnectorNode | GroupNode

/**
 * 锚定在工作表上的形状（`sp`、`cxnSp`、`grpSp`）。绘制时顶层节点的 `frame`（旋转接近 90° 或 270° 时宽高互换）
 * 映射到锚点矩形，树中全部 `frame` 随之换算。隐藏的形状不进入模型。
 */
export interface SheetShape {
  readonly anchor: DrawingAnchor
  /** 锚点在绘图部件中的序号，与 `SheetImage.order` 共用。 */
  readonly order: number
  readonly shape: ShapeNode
}

/** 锚定在工作表上的图表：锚点矩形即图表区。 */
export interface SheetChart<A extends DrawingAnchor = DrawingAnchor> {
  readonly anchor: A
  /** 锚点在绘图部件中的序号，与 `SheetImage.order` 共用。 */
  readonly order: number
  readonly chart: Chart
}

/**
 * 已识别但未实现的内容种类。预览按计数显示一行能力边界，不静默丢弃。
 *
 * - `chart`：未绘制的图表（扩展图表、含不支持内容的图表、组合内的图表、没有可绘制图表的图表工作表）；
 *   `otherSheet`：宏表与对话框表。
 * - `graphic`：未绘制的图形对象：SmartArt 等非图表的 `graphicFrame`、墨迹（`contentPart`）、锚点不完整或缺少 `xfrm`
 *   的形状，组合内的逐个计数。
 * - 形状中未绘制的部分（形状本身照常绘制）：`textWarp` 艺术字变形；`effect3d` 改变外观的三维设置（按平面绘制）；
 *   `effect` 外部阴影之外的效果；`verticalText` 未绘制的竖排文字（`wordArtVert` 等；按旋转绘制的竖排与 `eaVert` 照常绘制）。
 * - `pivotTable`、`slicer`、`sparkline`、`table`（表格样式的条纹与标题填充）。
 * - `comment`：批注。
 * - `control`：表单控件与 ActiveX 控件。
 * - `oleObject`：嵌入对象。
 * - `cellImage`：单元格内图片（`DISPIMG` 公式）。
 * - `conditionalFormat`：无法求值的条件格式规则（公式类规则、图标集等）。
 * - `image`：未显示的图片（组合内的图片、锚点不完整、关系目标缺失、形状的图片填充与图片项目符号、图表的图片填充）。
 */
export type UnsupportedKind =
  | 'chart'
  | 'otherSheet'
  | 'graphic'
  | 'textWarp'
  | 'effect3d'
  | 'effect'
  | 'verticalText'
  | 'pivotTable'
  | 'slicer'
  | 'sparkline'
  | 'table'
  | 'comment'
  | 'control'
  | 'oleObject'
  | 'cellImage'
  | 'conditionalFormat'
  | 'image'

export type UnsupportedCounts = Partial<Record<UnsupportedKind, number>>

export interface Worksheet {
  readonly kind: 'worksheet'
  readonly name: string
  readonly state: 'visible' | 'hidden' | 'veryHidden'
  /** 按行、再按列索引的稀疏单元格表。 */
  readonly cells: Map<number, Map<number, Cell>>
  readonly rows: Map<number, RowSpec>
  /** 按 `min` 升序，互不重叠。 */
  readonly cols: readonly ColumnSpec[]
  readonly format: SheetFormat
  readonly merges: readonly CellRange[]
  readonly view: SheetView
  readonly conditionalFormats: readonly ConditionalFormat[]
  readonly images: readonly SheetImage[]
  readonly shapes: readonly SheetShape[]
  readonly charts: readonly SheetChart[]
  /** 自动筛选区域：首行显示筛选按钮。 */
  readonly autoFilter: CellRange | null
  /** 含值或样式的单元格所占的最大行号与列号；空表为 -1。 */
  readonly maxRow: number
  readonly maxCol: number
  readonly unsupported: UnsupportedCounts
}

export interface ChartsheetView {
  /** 百分比，100 为原始大小。`zoomToFit` 不进入模型：WPS 实测带该属性时显示比例仍为此值。 */
  readonly zoom: number
}

/**
 * 图表工作表：只显示图表、没有单元格的页面。图表的锚点为绝对位置（EMU），即图表区在页面上的矩形：xlsx 取绘图部件的
 * `absoluteAnchor`，.xls 取 Chart 记录（见 `../biff/chart.ts` 的 `chartsheetAnchor`）；页面设置不改变图表区（WPS 实测）。
 */
export interface Chartsheet {
  readonly kind: 'chartsheet'
  readonly name: string
  readonly state: Worksheet['state']
  readonly view: ChartsheetView
  /** 可以绘制的图表，通常只有一个；没有时页面空白，图表计入 `unsupported.chart`。 */
  readonly charts: readonly SheetChart<AbsoluteAnchor>[]
  readonly unsupported: UnsupportedCounts
}

export type Sheet = Worksheet | Chartsheet

export interface Workbook {
  /** 按工作簿顺序，含隐藏的工作表与图表工作表；宏表与对话框表不在其中，计入 `unsupported`。 */
  readonly sheets: readonly Sheet[]
  /** 单元格样式表（`cellXfs` 逐项解析的结果）。 */
  readonly styles: readonly CellStyle[]
  /** 「常规」样式的字体，列宽换算与行高推算以它为准。 */
  readonly defaultFont: FontStyle
  /** 主题正文字体：西文与简体中文（`Hans` 文种，缺失时取 `ea`）；没有主题时为 `null`。缺字回退时使用。 */
  readonly minorFont: { readonly latin: string; readonly eastAsian: string } | null
  /** 1904 日期系统。 */
  readonly date1904: boolean
  /** 索引色调色板（`indexedColors` 覆盖默认调色板之后），数字格式的 `[ColorN]` 引用它。 */
  readonly palette: readonly string[]
  /** 打开时显示的工作表，`sheets` 的下标。 */
  readonly activeSheet: number
  /** 工作表网格的行数与列数：xlsx 为 1048576 × 16384，xls 为 65536 × 256。 */
  readonly gridSize: { readonly rows: number; readonly cols: number }
  /** 样式、富文本与形状文字中出现的全部字体名，供调用方按名取得字体文件。 */
  readonly fontNames: readonly string[]
  /** 全部工作表的计数之和，加上工作簿级的内容（宏表与对话框表）。 */
  readonly unsupported: UnsupportedCounts
}
