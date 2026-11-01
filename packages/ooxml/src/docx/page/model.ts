/**
 * 分页结果：纯数据，可经 `postMessage` 传递。长度单位为磅，坐标原点为页面左上角，x 向右、y 向下。
 *
 * - 字体以 `DocumentPages.faces` 的下标引用；绘制时由调用方按族名与字形取得字体（`paintPage`）。
 * - 段落按页切分：同一段落跨页时，每页各有一项 `PageParagraph`，`firstLine` 为本页第一行在整段中的序号。
 * - 表格按页切分：每页一项 `PageTable`，含单元格底纹、单元格中的内容与边框线。
 * - 浮动对象（`PageFloat`）按叠放次序排列，文本框的内容已排版为页面坐标中的项。
 */

import type { DrawingNode } from '../model.ts'

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
  /** 线宽（磅）。 */
  readonly width: number
  readonly color: string
  readonly style: 'single' | 'double' | 'dotted' | 'dashed'
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

/** 浮动对象：对象框（页面坐标）与可绘制的内容。 */
export interface PageFloat {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly behind: boolean
  /** 形状、图片与组合；`null` 为未实现的对象（不绘制）。 */
  readonly drawing: DrawingNode | null
  /** 文本框中的内容（页面坐标）。 */
  readonly items: readonly PageItem[]
}

/** 页面背景：底色与按像素尺寸（1 像素为 0.75 磅）自页面左上角平铺的图片（`DocumentPages.images` 的下标）。 */
export interface PageBackground {
  readonly color: string | null
  readonly image: number | null
}

/** 页面边框：四边的线与所围矩形（页面坐标）。 */
export interface PageBorderBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
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
  /**
   * 本页未绘制的嵌入式图片个数：与文字同行的图片（绘制未实现）。没有可绘制内容的对象（图表、缺少部件的图片等）
   * 已在解析时按种类计入 `DocxDocument.unsupported`，不在此计数。
   */
  readonly hidden: number
}

export interface PageImageSource {
  /** 图片部件名：形状的图片填充按部件名引用。 */
  readonly part: string
  readonly contentType: string
  /** 图片文件的字节，由调用方解码（浏览器中为 `createImageBitmap`）。 */
  readonly bytes: Uint8Array<ArrayBuffer>
}

export interface DocumentPages {
  readonly faces: readonly FaceRef[]
  readonly images: readonly PageImageSource[]
  readonly pages: readonly Page[]
}
