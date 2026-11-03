/**
 * pptx 解析结果：已解决继承的幻灯片模型。纯数据，可经 `postMessage` 传递。
 *
 * - 坐标与尺寸为幻灯片坐标系中的 EMU；角度为度；字号、字距、磅值行距为磅；百分比为小数。
 * - 组合内形状的 `frame` 已按各级组合的 `chOff`/`chExt` 换算到幻灯片坐标，但不含祖先组合的旋转与翻转：
 *   绘制时每个组合的旋转与翻转以该组合 `frame` 的中心为原点作用于其全部后代。自身旋转角在 [45°, 135°) 或
 *   [225°, 315°) 的子形状，宽高分别按组合的纵向与横向比例缩放，中心点照常映射。
 * - 颜色已按幻灯片的主题与生效的颜色映射求值；填充中的图片为部件名。
 * - 文字样式已按「字段 → 段落 → 形状列表样式 → 形状样式 `fontRef` → 版式占位符 → 母版占位符 → 末层样式」解决，
 *   末层样式：标题与正文占位符为母版 `titleStyle`、`bodyStyle`，其余形状为 `defaultTextStyle`，表格单元格为母版 `otherStyle`。
 *   字号为自动调整缩放之前的值，缩放比例见 `BodyProperties.autofit`。链上都未指定的西文字体为 Arial（WPS 实测），
 *   东亚、复杂文种与符号字体为空串。
 * - 尚未实现的元素按种类计数（`UnsupportedKind`），不出现在形状列表之外的位置。
 */

import type { Chart } from '../drawingml/chart/model.ts'
import type { Color } from '../drawingml/color.ts'
import type { Diagram } from '../drawingml/diagram/model.ts'
import type { Effect, Fill, Line, ShapeFill } from '../drawingml/fill.ts'
import type { Geometry } from '../drawingml/geometry/model.ts'
import type { Frame } from '../drawingml/shape/model.ts'
import type { TextBody } from '../drawingml/text/model.ts'
import type { ThreeD } from '../drawingml/three/model.ts'

/**
 * - `chart`、`smartArt`、`ole`：`graphicFrame` 中未绘制的图表（扩展图表与不支持的图表类型）、SmartArt（布局或内容含
 *   未实现的构造）与 OLE 对象；
 *   `graphic` 为其他种类的 `graphicFrame`。
 * - `media`：带音视频的图片（显示其封面图片）。`ink`：部件缺失或没有笔画的墨迹（`contentPart`）。
 * - `animation`：有动画的形状数；`transition`：带切换效果的幻灯片。
 * - `effect3d`：绘制端未实现的三维设置（挤出、轮廓、棱台、斜二测与 `legacy*` 相机、未实测的光照方案，见
 *   `../drawingml/three/camera.ts`；相机旋转、透视与光照照常绘制）；`textWarp`：艺术字变形；
 *   `effect`：`fillOverlay`、`effectDag` 等未实现的效果。
 * - `tableStyle`：表格引用的样式不在表格样式部件中，也不在收录的内置样式中，按无样式处理。
 * - 以下由求值阶段按绘制端的能力计数：`effect` 另含模糊与预设阴影、连接线与三维形状上的发光、柔化边缘与映像、文字中
 *   外部阴影、发光与映像之外的效果（每个文本框计一次）、组合的内部阴影；`imageFormat`：无法绘制的图片（TIFF 等浏览器无法解码的
 *   位图、含未实现内容的图元文件；含图片项目符号的图片）；`imageEffect`：亮度对比度、灰度、黑白、双色调与透明色之外的
 *   图片效果（如 `hsl`、`tint`），图片形状与形状、表格、文字的图片填充都计；`verticalText`：`wordArtVert`、`mongolianVert` 等竖排文字
 *   （`vert`、`vert270`、`eaVert` 按旋转绘制，不计）；`math`：含未实现结构（如矩阵）的公式，每个公式计一次。
 */
export type UnsupportedKind =
  | 'chart'
  | 'smartArt'
  | 'ole'
  | 'graphic'
  | 'media'
  | 'ink'
  | 'animation'
  | 'transition'
  | 'effect3d'
  | 'textWarp'
  | 'imageEffect'
  | 'effect'
  | 'tableStyle'
  | 'imageFormat'
  | 'verticalText'
  | 'math'

export type UnsupportedCounts = Partial<Record<UnsupportedKind, number>>

export type PlaceholderType =
  | 'title'
  | 'body'
  | 'ctrTitle'
  | 'subTitle'
  | 'dt'
  | 'sldNum'
  | 'ftr'
  | 'hdr'
  | 'obj'
  | 'chart'
  | 'tbl'
  | 'clipArt'
  | 'dgm'
  | 'media'
  | 'sldImg'
  | 'pic'

export interface Placeholder {
  /** 缺省为 `obj`。 */
  readonly type: PlaceholderType
  /** 缺省为 0。 */
  readonly idx: number
  /** 继承来源的形状 `id`：幻灯片上的占位符匹配到的版式占位符与母版占位符；没有匹配时为 `null`。 */
  readonly layoutShape: number | null
  readonly masterShape: number | null
}

interface ShapeBase {
  readonly id: number
  readonly name: string
  /** 形状所在的部件层级：母版与版式上的非占位符形状绘制在幻灯片形状之下。 */
  readonly origin: 'master' | 'layout' | 'slide'
  readonly hidden: boolean
  readonly frame: Frame
  readonly placeholder: Placeholder | null
}

export interface AutoShape extends ShapeBase {
  readonly kind: 'shape'
  readonly geometry: Geometry
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  /** 相机旋转、透视与光照；没有 `scene3d` 时为 `null`。 */
  readonly threeD: ThreeD | null
  readonly textBox: boolean
  readonly text: TextBody | null
}

export interface Picture extends ShapeBase {
  readonly kind: 'picture'
  readonly image: Extract<Fill, { readonly kind: 'picture' }>['image']
  readonly geometry: Geometry
  /** 图片之下的形状填充（透明图片可见）。 */
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly threeD: ThreeD | null
}

export interface ConnectionRef {
  readonly shape: number
  readonly site: number
}

export interface Connector extends ShapeBase {
  readonly kind: 'connector'
  readonly geometry: Geometry
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly start: ConnectionRef | null
  readonly end: ConnectionRef | null
}

export interface Group extends ShapeBase {
  readonly kind: 'group'
  /** 子形状的组合填充已按此值替换；组合未指定填充时为上一级组合的填充。 */
  readonly fill: ShapeFill
  readonly effects: readonly Effect[]
  readonly children: readonly Shape[]
}

export interface TableBorders {
  readonly left: Line | null
  readonly right: Line | null
  readonly top: Line | null
  readonly bottom: Line | null
  /** 左上到右下。 */
  readonly diagonalDown: Line | null
  /** 左下到右上。 */
  readonly diagonalUp: Line | null
}

export interface TableCell {
  readonly text: TextBody
  readonly gridSpan: number
  readonly rowSpan: number
  /** 被左侧单元格横向合并。 */
  readonly hMerge: boolean
  /** 被上方单元格纵向合并。 */
  readonly vMerge: boolean
  readonly marginLeft: number
  readonly marginRight: number
  readonly marginTop: number
  readonly marginBottom: number
  readonly anchor: string
  readonly anchorCenter: boolean
  readonly vertical: string
  /** 单元格自身的填充；未指定时为表格样式的填充，都没有时为无填充。 */
  readonly fill: ShapeFill
  readonly borders: TableBorders
}

export interface TableRow {
  readonly height: number
  readonly cells: readonly TableCell[]
}

export interface TableFlags {
  readonly firstRow: boolean
  readonly firstColumn: boolean
  readonly lastRow: boolean
  readonly lastColumn: boolean
  readonly bandRows: boolean
  readonly bandColumns: boolean
  readonly rtl: boolean
}

export interface Table extends ShapeBase {
  readonly kind: 'table'
  readonly columns: readonly number[]
  readonly rows: readonly TableRow[]
  /** `tableStyleId`；表格样式部件中有该样式时已应用到单元格的填充、边框与文字。 */
  readonly styleId: string | null
  readonly flags: TableFlags
  /** 表格背景（`tblPr` 的填充，或表格样式的 `tblBg`）。 */
  readonly fill: ShapeFill
}

/** 未实现的 `graphicFrame` 内容（同时计入 `unsupported`）。 */
export interface Graphic extends ShapeBase {
  readonly kind: 'graphic'
  readonly content: 'chart' | 'smartArt' | 'ole' | 'graphic'
}

/** 已求值的图表（`graphicFrame` 中的 `c:chart`）；图表不支持时为 `Graphic`。 */
export interface ChartFrame extends ShapeBase {
  readonly kind: 'chart'
  readonly chart: Chart
}

/** 已求值的 SmartArt；布局或内容含未实现的构造时为 `Graphic`。 */
export interface DiagramFrame extends ShapeBase {
  readonly kind: 'diagram'
  readonly diagram: Diagram
}

/** 墨迹笔画的一点：相对形状框左上角的坐标与该点的笔宽（EMU）。 */
export interface InkVertex {
  readonly x: number
  readonly y: number
  readonly width: number
}

export interface InkStroke {
  readonly points: readonly InkVertex[]
  readonly color: Color
}

/** 墨迹（`contentPart` 引用的 InkML）；部件缺失或没有笔画时 `strokes` 为空并计入 `ink`。 */
export interface Ink extends ShapeBase {
  readonly kind: 'ink'
  readonly strokes: readonly InkStroke[]
}

export type Shape =
  | AutoShape
  | Picture
  | Connector
  | Group
  | Table
  | Graphic
  | ChartFrame
  | DiagramFrame
  | Ink

export interface Slide {
  readonly part: string
  /** 从 `firstSlideNumber` 起的幻灯片编号。 */
  readonly number: number
  /** `show="0"`。 */
  readonly hidden: boolean
  readonly layout: string
  readonly master: string
  /** 幻灯片、版式、母版中第一个有背景的层级；都没有时为 `null`。 */
  readonly background: ShapeFill | null
  /** 绘制顺序：母版非占位符形状、版式非占位符形状（`showMasterSp` 为假时省略）、幻灯片形状。 */
  readonly shapes: readonly Shape[]
  readonly unsupported: UnsupportedCounts
}

/** 嵌入字体部件：每种字形一项。 */
export interface EmbeddedFont {
  /** `embeddedFont/font/@typeface`，文字样式中引用的字体名。 */
  readonly typeface: string
  readonly bold: boolean
  readonly italic: boolean
  /** 字体部件名（通常为 `.fntdata`）。 */
  readonly part: string
}

export interface Presentation {
  readonly width: number
  readonly height: number
  readonly firstSlideNumber: number
  /** `embeddedFontLst` 中的字体，按文档顺序；关系不存在或为外部链接的项不列出。 */
  readonly embeddedFonts: readonly EmbeddedFont[]
  /** `sldMasterIdLst` 中的母版部件名，按文档顺序。 */
  readonly masters: readonly string[]
  readonly slides: readonly Slide[]
  /** 各幻灯片 `unsupported` 之和。 */
  readonly unsupported: UnsupportedCounts
  /** 可以绘制的图元文件中文字的字体名（去重）。 */
  readonly metafileFonts: readonly string[]
}
