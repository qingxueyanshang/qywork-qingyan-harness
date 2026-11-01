/**
 * DrawingML 图表模型：已求值的 `c:chartSpace`。纯数据，可经 `postMessage` 传递。
 *
 * - 数据取自工作簿单元格（WPS 表格）或部件中的缓存值（`numCache`、`strCache`、`numLit`、`strLit`），不重算公式。
 * - 颜色、线条与文字样式已按主题与颜色映射求值；文件未写出的属性取 WPS 的缺省值（见 `resolve.ts`）。
 * - 长度：线宽为 EMU；字号为磅；布局比例（`manualLayout`）为相对图表区的小数。角度为度。
 * - 坐标轴的刻度范围与标签位置不在模型中：它们依赖绘制时的字体度量，由 `layout.ts` 计算。
 */

import type { Line, ShapeFill } from '../fill.ts'
import type { RunStyle, TextBody } from '../text/model.ts'

/** 填充与线条；`line` 为 `null` 表示无线条。 */
export interface ChartBox {
  readonly fill: ShapeFill
  readonly line: Line | null
}

/** 文字样式：字段样式与 `bodyPr/@rot`（度）；`rotation` 为 `null` 时按自动规则决定。 */
export interface TextStyle {
  readonly run: RunStyle
  readonly rotation: number | null
}

/** `c:manualLayout`：`x`、`y` 为 `edge` 时是位置比例，为 `factor` 时是相对自动位置的偏移；`null` 为未指定。 */
export interface ManualLayout {
  readonly target: 'inner' | 'outer'
  readonly xMode: 'edge' | 'factor'
  readonly yMode: 'edge' | 'factor'
  readonly x: number | null
  readonly y: number | null
  readonly w: number | null
  readonly h: number | null
}

export interface ChartTitle {
  /** 文字已解决样式：标题文字取自 `c:rich`，自动标题按系列名生成。 */
  readonly text: TextBody
  readonly overlay: boolean
  readonly layout: ManualLayout | null
  readonly box: ChartBox
}

export interface Marker {
  /** `circle`、`square`、`diamond`、`triangle`、`x`、`star`、`plus`、`dash`、`dot`、`none`。 */
  readonly symbol: string
  /** 磅。 */
  readonly size: number
  readonly box: ChartBox
}

export interface DataLabels {
  readonly showValue: boolean
  readonly showCategory: boolean
  readonly showSeries: boolean
  readonly showPercent: boolean
  /** `dLblPos`；未写出时为按图表类型的缺省位置（条形 `outEnd`，堆积条形 `ctr`，饼图 `bestFit`，折线与散点 `r`）。 */
  readonly position: string
  /** 数字格式；`null` 时取数据的格式代码。 */
  readonly format: string | null
  readonly separator: string
  readonly text: TextStyle
  readonly box: ChartBox
}

/** 数据点的单独格式（`c:dPt`）与单独标签（`c:dLbl`）。 */
export interface DataPoint {
  readonly index: number
  readonly box: ChartBox
  readonly marker: Marker | null
  /** 饼图扇区的分离比例（百分比的小数）。 */
  readonly explosion: number
}

export interface Series {
  readonly index: number
  readonly name: string
  /** 分类标签（已按缓存的格式代码格式化），按点下标；散点图为 `x` 值的文字。 */
  readonly categories: readonly string[]
  readonly values: readonly (number | null)[]
  /** 值为 `#N/A` 的点下标（`values` 中为 `null`）：不绘制，折线跨过该点连接，与 `Chart.blanks` 无关。 */
  readonly missing: ReadonlySet<number>
  /** 数值分类（散点图的 `x` 值、日期轴的日期序列号）；分类为文字或没有分类时为 `null`（散点图按 1、2、3… 绘制）。 */
  readonly xValues: readonly (number | null)[] | null
  /** 分类数据的格式代码：数值分类按它判断是否为日期。 */
  readonly categoryFormat: string
  /** 数值缓存的格式代码。 */
  readonly format: string
  readonly box: ChartBox
  readonly marker: Marker | null
  readonly smooth: boolean
  readonly points: readonly DataPoint[]
  /** 单个点的标签覆盖：按点下标，`null` 为删除该点的标签。 */
  readonly pointLabels: ReadonlyMap<number, DataLabels | null>
  readonly labels: DataLabels | null
  /** 饼图扇区的分离比例。 */
  readonly explosion: number
}

export type PlotType = 'bar' | 'line' | 'scatter' | 'pie' | 'doughnut'

export interface PlotGroup {
  readonly type: PlotType
  /** 条形图：`col` 为竖向柱形，`bar` 为横向条形。 */
  readonly direction: 'col' | 'bar'
  readonly grouping: 'clustered' | 'stacked' | 'percentStacked' | 'standard'
  readonly varyColors: boolean
  /** 百分比。 */
  readonly gapWidth: number
  readonly overlap: number
  readonly series: readonly Series[]
  /** 关联的坐标轴 `axId`：分类（或 `x`）轴在前；饼图为空。 */
  readonly axes: readonly number[]
  readonly firstSliceAngle: number
  /** 圆环图内径占外径的百分比。 */
  readonly holeSize: number
  /** 折线与散点是否绘制线段；`scatterStyle` 为 `marker` 或 `none` 时为假。 */
  readonly lines: boolean
  /** 三维饼图（`pie3DChart`）：`Chart.view3D` 为 `null` 时按平面饼图绘制（WPS 实测）。 */
  readonly threeD: boolean
}

/** 日期轴的设置：单位为 `days`、`months`、`years`，`null` 为自动。 */
export interface DateAxis {
  /** `c:dateAx` 且 `auto` 为假：分类为数值时一律按日期轴；否则只在分类为日期格式的数值时按日期轴。 */
  readonly forced: boolean
  readonly base: 'days' | 'months' | 'years' | null
  readonly majorTimeUnit: 'days' | 'months' | 'years' | null
}

export interface Axis {
  readonly id: number
  readonly kind: 'category' | 'value'
  /** 与之交叉的坐标轴（`crossAx`）；未写出为 `null`。 */
  readonly crossAx: number | null
  /** 分类轴可按日期轴显示时的设置；数值轴与不按日期的分类轴为 `null`。 */
  readonly date: DateAxis | null
  readonly title: ChartTitle | null
  /** 坐标轴标题的旋转角（度）；`null` 为自动：竖直坐标轴 −90，水平坐标轴 0。 */
  readonly titleRotation: number | null
  readonly position: 'l' | 'r' | 't' | 'b'
  readonly deleted: boolean
  readonly reversed: boolean
  readonly min: number | null
  readonly max: number | null
  /** 主要单位；日期轴以 `DateAxis.majorTimeUnit` 计。 */
  readonly majorUnit: number | null
  /** `autoZero`、`min`、`max`，或指定的交叉值。 */
  readonly crosses: 'autoZero' | 'min' | 'max' | number
  readonly crossBetween: 'between' | 'midCat'
  readonly majorGridlines: Line | null
  readonly majorTickMark: 'none' | 'in' | 'out' | 'cross'
  readonly tickLabelPosition: 'nextTo' | 'low' | 'high' | 'none'
  /** 数字格式；`sourceLinked` 为真或未指定时为 `null`，取数据的格式代码。 */
  readonly format: string | null
  readonly line: Line | null
  readonly text: TextStyle
  /** 分类轴每隔几个分类显示一个标签；`null` 为自动。 */
  readonly labelSkip: number | null
}

export interface Legend {
  readonly position: 'b' | 't' | 'l' | 'r' | 'tr'
  readonly overlay: boolean
  readonly layout: ManualLayout | null
  readonly text: TextStyle
  readonly box: ChartBox
  /** 被删除的图例项下标（`legendEntry/delete`）。 */
  readonly hidden: readonly number[]
}

export interface PlotArea {
  readonly layout: ManualLayout | null
  readonly box: ChartBox
  readonly groups: readonly PlotGroup[]
  readonly axes: readonly Axis[]
}

/** 三维视图（`c:view3D`）：角度为度；`perspective` 为文件中的值，`rightAngle` 为真时不按透视。 */
export interface View3D {
  readonly rotX: number
  readonly rotY: number
  readonly perspective: number
  readonly rightAngle: boolean
  /** `hPercent`：高度占底面直径的百分比。 */
  readonly heightPercent: number
}

export interface Chart {
  readonly box: ChartBox
  readonly roundedCorners: boolean
  readonly title: ChartTitle | null
  readonly plot: PlotArea
  readonly legend: Legend | null
  /** `dispBlanksAs`：`gap`、`zero`、`span`。 */
  readonly blanks: 'gap' | 'zero' | 'span'
  /** 日期序列号按 1904 日期系统换算（数字格式中的日期）。 */
  readonly date1904: boolean
  readonly view3D: View3D | null
  /** 图表所在的应用：WPS 表格（`sheet`）与 WPS 演示（`slide`）的个别规则不同（图表区缺省边框、竖直数值轴的区间数）。 */
  readonly host: 'sheet' | 'slide'
}
