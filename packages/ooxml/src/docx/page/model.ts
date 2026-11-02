/**
 * 分页结果：纯数据，可经 `postMessage` 传递。长度单位为磅，坐标原点为页面左上角，x 向右、y 向下。
 *
 * - 字体以 `DocumentPages.faces` 的下标引用；绘制时由调用方按族名与字形取得字体（`paintPage`）。
 * - 段落按页切分：同一段落跨页时，每页各有一项 `PageParagraph`，`firstLine` 为本页第一行在整段中的序号。
 * - 表格按页切分：每页一项 `PageTable`，含单元格底纹、单元格中的内容与边框线。
 * - 浮动对象（`PageFloat`）按叠放次序排列，文本框的内容已排版为页面坐标中的项，每个文本框带裁剪范围（`PageTextBox`）。
 * - 公式（`PageFormula`）的排版结果以 `DocumentPages.faces` 的下标引用字体。
 */

import type { RelativeRect } from '../../drawingml/fill.ts'
import type { MathLayout } from '../../math/index.ts'
import type { BorderStroke } from '../border.ts'
import type { DrawingGraphic, DrawingNode } from '../model.ts'

export interface FaceRef {
  /** 族名，与调用方注册的 `FontFace` 族名相同。 */
  readonly family: string
  /** 字体文件本身的字形。 */
  readonly bold: boolean
  readonly italic: boolean
  /** 请求粗体而字体没有粗体字形：已按仿粗体排版，绘制时合成粗体。 */
  readonly syntheticBold: boolean
  /** 请求斜体而字体没有斜体字形：绘制时倾斜。 */
  readonly syntheticItalic: boolean
}

export type UnderlineStyle =
  | 'single'
  | 'double'
  | 'thick'
  | 'dotted'
  | 'dash'
  | 'dotDash'
  | 'dotDotDash'
  | 'wave'
  | 'words'

export interface Underline {
  readonly style: UnderlineStyle
  /** `#rrggbb`；与文字同色时为文字颜色。 */
  readonly color: string
}

export interface PageFragment {
  /** `DocumentPages.faces` 的下标。 */
  readonly face: number
  readonly size: number
  /** 首字左端。 */
  readonly x: number
  readonly baseline: number
  readonly text: string
  /** 每个码位的步进，长度等于 `text` 的码位数。 */
  readonly advances: readonly number[]
  /** `#rrggbb`。 */
  readonly color: string
  readonly underline: Underline | null
  readonly strike: 'single' | 'double' | null
  /** 突出显示与字符底纹的填充色（`#rrggbb`）；突出显示优先。 */
  readonly fill: string | null
}

export interface PageLine {
  readonly top: number
  readonly height: number
  readonly fragments: readonly PageFragment[]
}

export interface BorderLine {
  /** 各条线距线组起点的偏移与粗细（磅），按自上而下、自左而右的顺序（见 `../border.ts`）。 */
  readonly strokes: readonly BorderStroke[]
  readonly color: string
  /** 点线与虚线只有一条线。 */
  readonly style: 'solid' | 'dotted' | 'dashed'
  /** 与文字的距离（磅）。 */
  readonly space: number
}

export interface ParagraphBox {
  /** 底纹与边框所围区域：左右为缩进处，上下为本页各行的范围。 */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: string | null
  readonly top: BorderLine | null
  readonly bottom: BorderLine | null
  readonly left: BorderLine | null
  readonly right: BorderLine | null
}

export interface PageImage {
  /** `DocumentPages.images` 的下标。 */
  readonly image: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** 图片各边裁去的比例（`InlineImage.crop`）：未裁去的部分拉伸到对象框。 */
  readonly crop: RelativeRect
}

/** 嵌入式图表与 SmartArt：对象框（页面坐标）。 */
export interface PageGraphic {
  readonly graphic: DrawingGraphic
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 公式：左端与基线（页面坐标）及排版结果，字体为 `DocumentPages.faces` 的下标。 */
export interface PageFormula {
  readonly x: number
  readonly baseline: number
  readonly layout: MathLayout<number>
}

export interface PageParagraph {
  readonly kind: 'paragraph'
  /** 所在内容（正文或页眉页脚部件）中的块下标。 */
  readonly block: number
  /** 本页第一行在整段中的序号。 */
  readonly firstLine: number
  readonly lines: readonly PageLine[]
  readonly box: ParagraphBox | null
  readonly images: readonly PageImage[]
  readonly graphics: readonly PageGraphic[]
  readonly formulas: readonly PageFormula[]
}

/** 表格的一条边框线：横线的 `y` 为线的上沿，竖线的 `x` 为线的中线。`line` 为 `null` 时为无边框处的表格虚框。 */
export interface PageEdge {
  readonly vertical: boolean
  readonly x: number
  readonly y: number
  readonly length: number
  readonly line: BorderLine | null
}

export interface PageFill {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** `#rrggbb`。 */
  readonly color: string
}

export interface PageTable {
  readonly kind: 'table'
  readonly block: number
  /** 本页显示其内容的行（含在本页切开的行，不含续页重复的标题行）。 */
  readonly rows: readonly number[]
  readonly top: number
  readonly height: number
  /** 单元格底纹。 */
  readonly fills: readonly PageFill[]
  /** 单元格中的段落与嵌套表格。 */
  readonly items: readonly PageItem[]
  readonly edges: readonly PageEdge[]
}

export type PageItem = PageParagraph | PageTable

/** 矩形（页面坐标）。 */
export interface PageRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 一个文本框的内容（页面坐标），绘制时裁剪到 `clip`：横向为形状框，纵向自形状框顶边至下内缩以内（WPS 实测，构造文档
 * w13 x1、y1：内容超出时宽于形状的图片裁到形状的外边缘，超出的行与图片裁到下内缩以内，内缩为 0 时裁到外边缘，
 * 与 `vertOverflow` 无关）。竖排文字与形状旋转相抵时形状框为旋转后的框（`TextBox.turned`）。
 */
export interface PageTextBox {
  readonly clip: PageRect
  /**
   * 文字随形状旋转：顺时针角度（度）与旋转中心（形状框中心，页面坐标）；不旋转时为 `null`。`items` 与 `clip` 为旋转前的位置
   * （WPS 实测，构造文档 w14 x1 的 X18：旋转 270° 的形状中横排文字按未旋转的形状框排版后随形状旋转）。
   */
  readonly rotation: { readonly angle: number; readonly x: number; readonly y: number } | null
  readonly items: readonly PageItem[]
}

/** 浮动对象：对象框（页面坐标）与可绘制的内容。 */
export interface PageFloat {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly behind: boolean
  /** 形状、图片、组合、图表与 SmartArt；`null` 为未实现的对象（不绘制）。 */
  readonly drawing: DrawingNode | null
  /** 对象（含组合内）中各文本框的内容。 */
  readonly texts: readonly PageTextBox[]
}

/** 页面背景：底色与自页面左上角平铺的图片（`DocumentPages.images` 的下标）。 */
export interface PageBackground {
  readonly color: string | null
  readonly image: number | null
  /** 平铺单元按图片文件记录的分辨率换算；为假时按图片的像素尺寸（1 像素为 0.75 磅）。 */
  readonly tile: boolean
}

/** 页面边框：四边的线与矩形（页面坐标）。 */
export interface PageBorderBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** 线画在矩形内侧（矩形为线的外缘，`offsetFrom` 为 `page`）或外侧（矩形为线的内缘，`offsetFrom` 为 `text`）。 */
  readonly inside: boolean
  readonly top: BorderLine | null
  readonly bottom: BorderLine | null
  readonly left: BorderLine | null
  readonly right: BorderLine | null
}

export interface Page {
  /** 节的下标。 */
  readonly section: number
  readonly width: number
  readonly height: number
  /** 页码域显示的文字（按节的页码格式与起始值）。 */
  readonly number: string
  readonly header: readonly PageItem[]
  readonly body: readonly PageItem[]
  readonly footer: readonly PageItem[]
  /** 浮动对象（含页眉页脚中的），按叠放次序从下到上。 */
  readonly floats: readonly PageFloat[]
  readonly background: PageBackground | null
  readonly borders: PageBorderBox | null
  /** 图表、SmartArt 与图元文件文字的字体（全文档相同）；本页没有这三种对象时为 `null`。 */
  readonly graphicFonts: GraphicFonts | null
  /**
   * 本页未绘制的公式个数：含未实现的结构或主机没有数学字体的公式。页眉页脚部件中的只在使用该部件的第一页计入，
   * 使各页之和中每个部件只计一次。
   */
  readonly hiddenMath: number
}

export interface PageImageSource {
  /** 图片部件名：形状的图片填充按部件名引用。 */
  readonly part: string
  readonly contentType: string
  /** 图片文件的字节，由调用方解码（`decodePicture`）。 */
  readonly bytes: Uint8Array<ArrayBuffer>
}

/**
 * 图表、SmartArt 与图元文件文字按字体名取得的字体：请求的字体名与字形所对应的 `DocumentPages.faces` 下标（字体文件本身的字形）。
 */
export interface GraphicFace {
  readonly name: string
  readonly bold: boolean
  readonly italic: boolean
  readonly face: number
}

/** 图表、SmartArt 与图元文件文字的字体：主机有的字体逐一列出，其余字体名取 `fallback`（`DocumentPages.faces` 的下标）。 */
export interface GraphicFonts {
  readonly named: readonly GraphicFace[]
  readonly fallback: number
}

export interface DocumentPages {
  readonly faces: readonly FaceRef[]
  readonly images: readonly PageImageSource[]
  readonly pages: readonly Page[]
}
