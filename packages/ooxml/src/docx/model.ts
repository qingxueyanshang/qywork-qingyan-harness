/**
 * docx 解析结果：已解决样式继承、编号与主题字体的正文模型。纯数据，可经 `postMessage` 传递。
 *
 * - 长度单位为磅；字号为磅。缩进、间距、制表位均已按所在节的文档网格与字符单位换算。
 * - 正文为节内的顶层段落与表格；单元格与文本框的内容同为段落与表格，可以嵌套。
 *   页眉页脚部件的段落在 `parts` 中，按关系标识索引。浮动对象（`wp:anchor` 与 VML）记在所在段落的 `anchors` 中。
 * - 表格样式与条件格式已解决：单元格的边框、底纹、边距与单元格中段落的属性都是最终值。
 * - 隐藏文字（`vanish`）、域代码、删除的修订不出现在字段文字中；域只取结果文字，字段记录所在域名。
 */

import type { Chart } from '../drawingml/chart/model.ts'
import type { Diagram } from '../drawingml/diagram/model.ts'
import type { Effect, Line, RelativeRect, ShapeFill } from '../drawingml/fill.ts'
import type { Geometry } from '../drawingml/geometry/model.ts'
import type { Frame } from '../drawingml/shape/model.ts'
import type { MathJustification, MathSettings, MathZone } from '../math/index.ts'
import type { Alignment, LineSpacing } from '../text/index.ts'

/**
 * 遇到但未实现的元素与属性，按出现次数计数：
 * - 正文结构：`frame`（`framePr` 段落）、`floatingTable`（`tblpPr`：按普通表格排在原位置，横向按其偏移，纵向相对文字时
 *   下移其偏移；文字不环绕表格）、
 *   `altChunk` 与 `subDocument`（外部内容）。
 * - 对象：`picture`、`chart`、`smartArt`、`shape`、`group`、`canvas`、`drawing`（其他 DrawingML 对象）、
 *   `vml`（无法转换的 VML）、`ole`（没有 VML 形状或图片部件的 `w:object`）、`contentPart`。图片、形状、文本框、组合与 VML 的
 *   形状、文本框、图片可以绘制，不计数；图表在部件存在且不含未实现内容时可以绘制，否则计入 `chart`；
 *   SmartArt 在数据部件存在且布局可以求值时可以绘制，否则计入 `smartArt`。
 *   嵌入式的其余对象只占行高，浮动的其余对象只占位置。
 *   `effect` 为形状中外部阴影之外的效果、三维效果与艺术字变形，`imageFormat` 为无法绘制的图片格式（浏览器无法解码的位图，
 *   含未实现内容的图元文件）。
 * - 版面：`columns`（多栏节；连续分节前的多栏平衡与不等宽栏的排版宽度未实现）、`footnote`、`endnote`、`comment`、
 *   `artBorder`（艺术型页面边框，按单线绘制）、`lineNumbers`、`textDirection`。
 * - 文字效果：`characterScale`、`emphasisMark`、`smallCaps`、`eastAsianLayout`、
 *   `fitText`、`rtl`、`charGrid`（字符网格）、`tabLeader`（点以外的制表位前导符）、`decimalTab`、`barTab`、`ruby`、
 *   `ptab`、`softHyphen`。
 * - 内容：`revision`（修订标记，按最终状态显示）、`dynamicField`（打开时由应用重新计算的域，显示文件中缓存的结果）、
 *   `numberFormat`（未实现的编号格式，按中文计数显示）、`autoSpacing`（HTML 自动段间距）。
 */
export type UnsupportedKind =
  | 'frame'
  | 'floatingTable'
  | 'altChunk'
  | 'subDocument'
  | 'picture'
  | 'chart'
  | 'smartArt'
  | 'shape'
  | 'group'
  | 'canvas'
  | 'drawing'
  | 'effect'
  | 'imageFormat'
  | 'vml'
  | 'ole'
  | 'contentPart'
  | 'columns'
  | 'footnote'
  | 'endnote'
  | 'comment'
  | 'artBorder'
  | 'lineNumbers'
  | 'textDirection'
  | 'characterScale'
  | 'emphasisMark'
  | 'smallCaps'
  | 'eastAsianLayout'
  | 'fitText'
  | 'rtl'
  | 'charGrid'
  | 'tabLeader'
  | 'decimalTab'
  | 'barTab'
  | 'ruby'
  | 'ptab'
  | 'softHyphen'
  | 'revision'
  | 'dynamicField'
  | 'numberFormat'
  | 'autoSpacing'

export type UnsupportedCounts = Partial<Record<UnsupportedKind, number>>

export interface FontNames {
  readonly ascii: string
  readonly hAnsi: string
  readonly eastAsia: string
  readonly cs: string
}

/** 字段属性的解决结果。字体名已由主题字体换算并补足缺省值，不为空串。 */
export interface RunProps {
  readonly fonts: FontNames
  /** 东亚字体取自主题（`w:eastAsiaTheme` 或未指定）：主机没有该字体时不按字体表替代（见 `resolve/fonts.ts`）。 */
  readonly eastAsiaTheme: boolean
  /** `w:rFonts/@w:hint`。 */
  readonly hint: 'default' | 'eastAsia' | 'cs'
  /** 带 `w:cs` 或 `w:rtl`：全部字符使用 `cs` 字体与 `sizeCs`。 */
  readonly complexScript: boolean
  readonly size: number
  readonly sizeCs: number
  readonly bold: boolean
  readonly boldCs: boolean
  readonly italic: boolean
  readonly italicCs: boolean
  readonly caps: boolean
  readonly smallCaps: boolean
  readonly strike: boolean
  readonly emboss: boolean
  readonly imprint: boolean
  readonly outline: boolean
  readonly shadow: boolean
  /** 字符间距（磅）。 */
  readonly spacing: number
  readonly vertAlign: 'baseline' | 'superscript' | 'subscript'
  /** 基线提升（磅），向下为负。 */
  readonly position: number
  /** 字距调整的最小字号（磅）；0 为不调整。 */
  readonly kern: number
  /** `w:lang/@w:eastAsia`；未指定时为空串。 */
  readonly eastAsiaLanguage: string
  /** 文字颜色 `#rrggbb`；`null` 为自动颜色。主题颜色按 `w:val` 中的颜色值取。 */
  readonly color: string | null
  /** 下划线：线型为 `ST_Underline` 的取值；颜色为 `null` 时与文字同色。 */
  readonly underline: { readonly style: string; readonly color: string | null } | null
  /** 突出显示的颜色 `#rrggbb`。 */
  readonly highlight: string | null
  /** 字符底纹的填充色 `#rrggbb`。 */
  readonly shading: string | null
  readonly doubleStrike: boolean
}

export interface Run {
  /** `\t` 为制表符，`\n` 为换行（`w:br`、`w:cr`），`\f` 为分页符，`\v` 为分栏符。 */
  readonly text: string
  readonly props: RunProps
  /** 字段所在域（最内层、处于结果部分）的域名，大写；不在域中时为 `null`。 */
  readonly field: string | null
  /** 页眉页脚中 STYLEREF 域的结果（合并为一个字段）：文字由分页按页求出，`text` 为文件中缓存的结果。 */
  readonly styleRef?: StyleRef
  /**
   * 公式（一个 `m:oMath`）：`text` 为空串，按段参与断行（见 `../layout.ts`）；`props` 为段落的缺省字段属性，
   * 公式中没有字符属性的部分取此值。
   */
  readonly math?: RunMath
}

export interface RunMath {
  readonly zone: MathZone<RunProps>
  /**
   * 显示公式的对齐方式（已按 `defJc` 补足）；行内公式为 `null`。WPS 实测：段落中只有公式、没有其他文字，且公式为一个
   * `m:oMathPara` 或若干个不在 `m:oMathPara` 中的 `m:oMath` 时为显示公式，段落中的各个公式依次排列；否则全部为行内公式。
   * 段落中另有嵌入式对象时按行内公式排版（未与 WPS 核对）。
   */
  readonly display: MathJustification | null
}

/** STYLEREF 域所引用的段落样式。 */
export interface StyleRef {
  /** 段落样式标识；样式名有效而文档中没有该样式时为 `null`（显示未找到的提示）。 */
  readonly style: string | null
  /** `\l`：取本页最后一个而不是第一个该样式的段落。 */
  readonly last: boolean
}

export interface InlineImage {
  /** 对象之后第一个字段在 `Paragraph.runs` 中的序号；等于字段个数时对象位于段末。 */
  readonly run: number
  /** 所在字段的基线提升（磅，向下为负）：对象框随之上移或下移。 */
  readonly raise: number
  /** `DocxDocument.media` 的下标；不是图片（图表、文本框等）或没有图片部件时为 -1。 */
  readonly media: number
  /** 可绘制的图表或 SmartArt；不是这两种对象、部件不存在或含未实现内容时为 `null`。 */
  readonly graphic: DrawingGraphic | null
  /** `wp:extent`（磅）。 */
  readonly width: number
  readonly height: number
  /** `wp:effectExtent`：四周为效果预留的范围（磅），计入对象框。 */
  readonly effect: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  }
  /** 图片各边裁去的比例：DrawingML 图片的 `a:srcRect`，`w:object` 中 `v:imagedata` 的 `crop*`。 */
  readonly crop: RelativeRect
}

export interface MediaPart {
  readonly part: string
  readonly contentType: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** 段落、表格、单元格与页面共用的边框。 */
export interface Border {
  /** `ST_Border` 的取值。段落边框中带非零 `space` 的 `none` 保留为 `none`（只占高度，不绘制），其余边框中没有 `none`。 */
  readonly style: string
  /** 线宽（磅）。 */
  readonly width: number
  /** `#rrggbb`；`null` 为自动颜色。 */
  readonly color: string | null
  /** 与文字的距离（磅）。 */
  readonly space: number
}

/** 页眉或页脚的关系标识，按种类；`null` 为本节未引用。 */
export interface PartRefs {
  readonly default: string | null
  readonly first: string | null
  readonly even: string | null
}

export interface TabStop {
  /** 相对版心左边。 */
  readonly position: number
  /** 小数点对齐按右对齐排版，计入 `decimalTab`。 */
  readonly align: 'left' | 'center' | 'right'
  /** 前导符字符：`dot` 为「.」；其余前导符未实现（计入 `tabLeader`），与没有前导符同为 `null`。 */
  readonly leader: string | null
}

export interface ParagraphProps {
  readonly align: Alignment
  /** 相对版心左右边。 */
  readonly left: number
  readonly right: number
  /** 首行相对其余各行的缩进，负值为悬挂缩进。 */
  readonly firstLine: number
  /**
   * 计算内容宽度（`ParagraphLayouter.contentWidths`）所用的左缩进与首行缩进：按字符给出的首行与悬挂缩进以缺省段落样式的
   * 字号为单位，其余与 `left`、`firstLine` 相同（WPS 实测，构造文档 w10b、w10f：字段 12 磅、缺省段落样式 10.5 磅时，
   * `firstLineChars="200"` 排版按 24 磅、自动调整列宽按 21 磅；段落样式另设字号时仍按缺省段落样式）。
   */
  readonly contentIndent: { readonly left: number; readonly firstLine: number }
  /** 段前段后间距，未计入 `contextualSpacing` 的抵消。 */
  readonly before: number
  readonly after: number
  readonly contextualSpacing: boolean
  readonly lineSpacing: LineSpacing
  /** 对齐行网格：所在节的网格类型不为 `default` 且段落未关闭 `snapToGrid`。 */
  readonly snapToGrid: boolean
  readonly kinsoku: boolean
  readonly wordWrap: boolean
  /** 行尾标点可以悬挂；表格单元格中的段落为假（见 `parse/body.ts`）。 */
  readonly overflowPunct: boolean
  readonly autoSpaceDE: boolean
  readonly autoSpaceDN: boolean
  /** 按位置升序；不含竖线制表位与清除项。 */
  readonly tabs: readonly TabStop[]
  readonly keepNext: boolean
  readonly keepLines: boolean
  /** 文件未指定时为真（WPS 实测）。 */
  readonly widowControl: boolean
  readonly pageBreakBefore: boolean
  /** 段落底纹的填充色 `#rrggbb`。 */
  readonly shading: string | null
  readonly borders: {
    readonly top: Border | null
    readonly bottom: Border | null
    readonly left: Border | null
    readonly right: Border | null
  } | null
}

export interface Numbering {
  /** 编号文本，不含后缀。 */
  readonly text: string
  /** 段落标记的字段属性叠加编号级别的 `rPr`。 */
  readonly props: RunProps
  readonly suffix: 'tab' | 'space' | 'nothing'
  /** 编号相对首行起点的对齐（`lvlJc`）。 */
  readonly align: 'left' | 'center' | 'right'
}

export interface Paragraph {
  readonly kind: 'paragraph'
  /** `sections` 的下标。 */
  readonly section: number
  /** 生效的段落样式标识；文档没有样式时为空串。 */
  readonly style: string
  readonly props: ParagraphProps
  readonly runs: readonly Run[]
  /** 段落标记的字段属性：决定空段落与段末换行之后一行的行高。 */
  readonly mark: RunProps
  readonly numbering: Numbering | null
  /** 嵌入式对象，按出现顺序。 */
  readonly images: readonly InlineImage[]
  /** 浮动对象，按出现顺序。 */
  readonly anchors: readonly Anchor[]
}

/** 四边的距离（磅）。 */
export interface Edges {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** `tblW`、`tcW`：`dxa` 为磅，`pct` 为比例（1 为 100%），`auto` 与 `nil` 的值为 0。 */
export interface TableWidth {
  readonly type: 'auto' | 'dxa' | 'pct' | 'nil'
  readonly value: number
}

/** 单元格各边明确给出的边框：缺少的边使用表格的边框，`null` 为明确无边框。 */
export interface CellBorders {
  readonly top?: Border | null
  readonly left?: Border | null
  readonly bottom?: Border | null
  readonly right?: Border | null
}

export interface TableBorders {
  readonly top: Border | null
  readonly left: Border | null
  readonly bottom: Border | null
  readonly right: Border | null
  readonly insideH: Border | null
  readonly insideV: Border | null
}

export interface TableCell {
  /** 跨越的网格列数。 */
  readonly span: number
  readonly vMerge: 'restart' | 'continue' | null
  /** 段落与嵌套表格。 */
  readonly content: readonly Block[]
  readonly width: TableWidth | null
  /** 直接格式与条件格式中给出的边框。 */
  readonly borders: CellBorders
  /** 填充色 `#rrggbb`：单元格、条件格式、表格样式、表格的底纹依次取第一个给出的值。 */
  readonly shading: string | null
  /** 单元格边距：单元格的 `tcMar` 逐边覆盖表格的 `tblCellMar`。 */
  readonly margins: Edges
  readonly vAlign: 'top' | 'center' | 'bottom'
  /** `noWrap`：自动调整布局中单元格内不断行。 */
  readonly noWrap: boolean
}

export interface TableRow {
  readonly height: { readonly rule: 'atLeast' | 'exact'; readonly value: number } | null
  /** 标题行（`tblHeader`）。 */
  readonly header: boolean
  readonly cantSplit: boolean
  /** 行首空出的网格列数。 */
  readonly gridBefore: number
  readonly cells: readonly TableCell[]
}

/** 浮动表格（`tblpPr`）的横向与纵向偏移（磅）及各自的基准。 */
export interface TableFloat {
  readonly from: 'margin' | 'page' | 'text'
  readonly x: number
  readonly vertical: 'margin' | 'page' | 'text'
  readonly y: number
}

/** 表格：网格、表格属性与行。表格样式与条件格式已并入单元格与段落。 */
export interface TableBlock {
  readonly kind: 'table'
  readonly section: number
  /** 网格列宽（磅）。 */
  readonly grid: readonly number[]
  readonly rows: readonly TableRow[]
  readonly width: TableWidth | null
  readonly layout: 'fixed' | 'autofit'
  /** `tblInd`（磅）。 */
  readonly indent: number
  readonly align: 'left' | 'center' | 'right'
  readonly borders: TableBorders
  /** 表格的单元格边距（`tblCellMar`，含表格样式）；都未给出时为 0。 */
  readonly margins: Edges
  readonly float: TableFloat | null
}

export type Block = Paragraph | TableBlock

/** 浮动对象的定位：`align` 不为 `null` 时按对齐，否则按偏移（磅）。 */
export interface AnchorPosition {
  /** `ST_RelFromH` 或 `ST_RelFromV` 的取值。 */
  readonly from: string
  readonly align: string | null
  readonly offset: number
}

export interface Wrap {
  readonly type: 'none' | 'square' | 'tight' | 'through' | 'topAndBottom'
  readonly side: 'bothSides' | 'left' | 'right' | 'largest'
  /** 距正文的距离（磅）。 */
  readonly distance: Edges
}

/** 文本框：内容与文字区域相对形状框的内缩（磅）。 */
export interface TextBox {
  readonly content: readonly Block[]
  readonly inset: Edges
  /** 内容在文字区域中的纵向位置。 */
  readonly anchor: 'top' | 'center' | 'bottom'
  /** 根据文字调整形状大小（`spAutoFit`）：形状高度取内容高度加上下内缩，与文件中记录的高度无关。 */
  readonly autoFit: boolean
  /** 文字在文字区域宽度处换行；为假（`wrap="none"`）且根据文字调整大小时，形状宽度另取内容不换行的宽度加左右内缩。 */
  readonly wrap: boolean
}

/**
 * 形状：几何、填充、线条与效果已按主题求值；图片为图片填充的矩形。`frame` 为 EMU，组合中的形状已换算到
 * 对象框的坐标（原点在对象框左上角），组合的旋转与翻转在绘制时施加于其后代。
 */
export interface DrawingShape {
  readonly kind: 'shape'
  readonly frame: Frame
  readonly geometry: Geometry
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly text: TextBox | null
}

export interface DrawingGroup {
  readonly kind: 'group'
  readonly frame: Frame
  readonly effects: readonly Effect[]
  readonly children: readonly DrawingNode[]
}

/** 图表：`frame` 为对象框（EMU，原点在对象框左上角）。 */
export interface DrawingChart {
  readonly kind: 'chart'
  readonly frame: Frame
  readonly chart: Chart
}

/** SmartArt：`frame` 为对象框（EMU，原点在对象框左上角），图示在对象框中排版。 */
export interface DrawingDiagram {
  readonly kind: 'diagram'
  readonly frame: Frame
  readonly diagram: Diagram
}

/** `graphicData` 中由调用方按关系读取部件的对象：图表与 SmartArt。 */
export type DrawingGraphic = DrawingChart | DrawingDiagram

export type DrawingNode = DrawingShape | DrawingGroup | DrawingGraphic

/** 浮动对象（`wp:anchor` 与 VML）。 */
export interface Anchor {
  /** 段落文字（各字段依次相接）中的位置。 */
  readonly offset: number
  readonly horizontal: AnchorPosition
  readonly vertical: AnchorPosition
  /** 对象框（磅），不含 `effectExtent`。 */
  readonly width: number
  readonly height: number
  /** `wp:effectExtent`：四周为效果预留的范围（磅），计入避让矩形，不改变对象框的位置。 */
  readonly effect: Edges
  readonly wrap: Wrap
  /** 衬于文字下方。 */
  readonly behind: boolean
  /** 叠放次序（`relativeHeight`），大者在上。 */
  readonly z: number
  /** 可绘制的内容；画布、含未实现内容的图表与 SmartArt 等为 `null`，只占位置。 */
  readonly drawing: DrawingNode | null
}

/** 页面背景：`w:background` 的颜色与填充。 */
export type Background =
  | { readonly kind: 'color'; readonly color: string }
  /**
   * 图片填充（`v:fill` 的 `type` 为 `frame` 或 `tile`）：自页面左上角平铺；`part` 为图片部件名，`color` 为图片之下的底色，
   * `tile` 为真时平铺单元按图片文件记录的分辨率换算，否则按图片的像素尺寸（1 像素为 0.75 磅）。
   */
  | {
      readonly kind: 'image'
      readonly part: string
      readonly color: string | null
      readonly tile: boolean
    }

/** 页面边框（`pgBorders`）。 */
export interface PageBorders {
  readonly top: Border | null
  readonly left: Border | null
  readonly bottom: Border | null
  readonly right: Border | null
  /** 各边的 `space` 以页面边缘（`page`）或正文（`text`）为基准。 */
  readonly offsetFrom: 'page' | 'text'
  readonly display: 'allPages' | 'firstPage' | 'notFirstPage'
}

export interface Section {
  readonly pageWidth: number
  readonly pageHeight: number
  readonly marginTop: number
  readonly marginRight: number
  readonly marginBottom: number
  readonly marginLeft: number
  readonly header: number
  readonly footer: number
  readonly gutter: number
  /** 各栏的宽度与其后的栏间距；单栏时只有一项。 */
  readonly columns: readonly { readonly width: number; readonly space: number }[]
  /** `docGrid` 的类型；`default` 为不使用网格。 */
  readonly gridType: 'default' | 'lines' | 'linesAndChars' | 'snapToChars'
  /** `docGrid/@w:linePitch`（行网格的行距）；没有 `docGrid` 时为 0。 */
  readonly linePitch: number
  /** `sectPr/type`：本节的开始方式。 */
  readonly start: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn'
  /** 首页使用首页页眉页脚（`titlePg`）。 */
  readonly titlePage: boolean
  /** `pgNumType/@w:fmt`。 */
  readonly numberFormat: string
  /** `pgNumType/@w:start`；`null` 为接续上一节。 */
  readonly numberStart: number | null
  readonly headers: PartRefs
  readonly footers: PartRefs
  readonly pageBorders: PageBorders | null
}

export interface DocumentSettings {
  readonly defaultTabStop: number
  /** `compat/doNotExpandShiftReturn` 的反义：以换行结束的行参与两端对齐。 */
  readonly expandLineBreak: boolean
  /** `noLineBreaksBefore` 与 `noLineBreaksAfter`；未指定时为 `null`，使用缺省禁则表。 */
  readonly noLineBreakBefore: string | null
  readonly noLineBreakAfter: string | null
  /** `characterSpacingControl` 为压缩标点。 */
  readonly compressPunctuation: boolean
  /** `compat/balanceSingleByteDoubleByteWidth`。 */
  readonly balanceSingleByte: boolean
  /** `compatSetting` 中的 `compatibilityMode`；没有该项时为 0。 */
  readonly compatibilityMode: number
  /** 奇偶页使用不同的页眉页脚。 */
  readonly evenAndOddHeaders: boolean
  /** `compat/adjustLineHeightInTable`：表格中的段落对齐行网格（WPS 实测：未设置时不对齐）。 */
  readonly gridInTables: boolean
  /** 公式设置（`m:mathPr`）；没有该元素时取 `MATH_SETTINGS_DEFAULTS`。 */
  readonly math: MathSettings
}

/** 字体表（`fontTable`）中一个字体名的条目。 */
export interface FontTableEntry {
  /** `w:altName`；未指定时为空串。 */
  readonly altName: string
  /** `w:charset`；未指定时为 `null`。 */
  readonly charset: number | null
}

export interface DocxDocument {
  readonly sections: readonly Section[]
  readonly body: readonly Block[]
  readonly settings: DocumentSettings
  /** 字体表：字体名的第一个条目，供字体选择判断中文字符集与主机没有该字体时的替代（见 `resolve/fonts.ts`）。 */
  readonly fontTable: ReadonlyMap<string, FontTableEntry>
  readonly unsupported: UnsupportedCounts
  /** 页眉页脚部件中的段落与表格，按关系标识（`Section.headers`、`Section.footers`）。 */
  readonly parts: Readonly<Record<string, readonly Block[]>>
  /** 图片部件：嵌入式图片、浮动对象与页面背景引用的图片。 */
  readonly media: readonly MediaPart[]
  /** 页面背景；设置中未开启背景形状的显示（`displayBackgroundShape`）时为 `null`。 */
  readonly background: Background | null
}
