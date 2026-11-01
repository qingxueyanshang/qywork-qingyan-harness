/**
 * docx 只读预览：结构解析、样式继承与逐段排版（可在 Worker 中运行）。
 *
 * - `parseDocx` 由文件字节得到纯数据的 `DocxDocument`：正文段落的属性已按样式链、编号与主题字体解决，
 *   编号文本已生成；未实现的元素按种类计入 `unsupported`。
 * - `layoutDocument` 按调用方提供的字体逐段排版正文的顶层段落，输出行与片段的坐标及段前段后间距；分页、表格与浮动对象不在其中。
 * - `layoutPages` 在逐段排版之上排版表格、定位浮动对象、分页并排列页眉页脚，输出纯数据的 `DocumentPages`；
 *   `paintPage` 把一页（含页面背景、表格与浮动对象）绘制到 Canvas，`pageImages` 列出它读取的图片。
 *   字体经 `DocxFonts` 提供（`requiredFonts` 列出所需字体名，`loadDocxFace` 读取字体文件）。
 */

export {
  type DocumentLayout,
  type FontMatch,
  type FontSource,
  layoutDocument,
  type ParagraphLayout,
} from './layout.ts'
export { type DocxFailure, type DocxResult, parseDocx } from './load.ts'
export type {
  Anchor,
  AnchorPosition,
  Background,
  Block,
  Border,
  CellBorders,
  DocumentSettings,
  DocxDocument,
  DrawingGroup,
  DrawingNode,
  DrawingShape,
  Edges,
  FontNames,
  Numbering,
  PageBorders,
  Paragraph,
  ParagraphProps,
  Run,
  RunProps,
  Section,
  TableBlock,
  TableBorders,
  TableCell,
  TableRow,
  TableWidth,
  TabStop,
  TextBox,
  UnsupportedCounts,
  UnsupportedKind,
  Wrap,
} from './model.ts'
export { layoutPages, type PagesResult, requiredFonts } from './page/build.ts'
export type {
  BorderLine,
  DocumentPages,
  FaceRef,
  Page,
  PageBackground,
  PageBorderBox,
  PageEdge,
  PageFill,
  PageFloat,
  PageFragment,
  PageImage,
  PageImageSource,
  PageItem,
  PageLine,
  PageParagraph,
  PageTable,
  ParagraphBox,
  Underline,
  UnderlineStyle,
} from './page/model.ts'
export { type DocxFace, DocxFonts, loadDocxFace } from './render/fonts.ts'
export {
  type PageBitmap,
  type PageContext,
  type PageFonts,
  type PageResources,
  pageImages,
  paintPage,
  SCREEN_SCALE,
} from './render/paint.ts'
