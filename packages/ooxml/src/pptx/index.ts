/**
 * pptx 只读预览：结构解析与样式继承（可在 Worker 中运行）、Canvas 绘制。
 *
 * 接入顺序：
 * 1. `parsePptx(bytes)` 得到纯数据的 `Presentation`：每张幻灯片的形状已解决占位符继承、样式引用与组合坐标，
 *    颜色已求值，文字样式已逐级解决；未显示的内容按种类计入 `unsupported`，界面据此显示一行能力边界。
 * 2. 按 `presentationFonts(presentation, host)` 取得字体（`host` 为主机字体的族名）：每个字体以同一族名注册为浏览器
 *    `FontFace`，以 `readSlideFace` 读取度量与点阵，按字体名交给 `SlideFontSet.of`（缺字与缺少字体时依次尝试的字体名与
 *    主机字体的族名 `families` 由调用方提供）。主机没有的字体取
 *    `readEmbeddedFonts(bytes, presentation.embeddedFonts 中主机没有的项)` 还原的嵌入字体（不经主机字体接口）。
 * 3. 按 `slideImages(slide)` 以 `readImages(bytes, parts)` 读取图片部件（可在 Worker 中），由调用方解码为位图。
 * 4. `paintSlide(ctx, presentation, slide, resources, scale)` 绘制到尺寸为 `slideSize(presentation, scale)` 的画布；
 *    `resources.createCanvas` 提供阴影、渐变线条与图案所需的图层（浏览器中为 `OffscreenCanvas`），
 *    `resources.clearType` 为显示器的 ClearType 设置（不为 `null` 时文字读写画布像素），`resources.date` 为日期字段
 *    显示的日期（`fieldDate(new Date())`）。
 */

export { type FieldDate, fieldDate } from '../drawingml/text/date.ts'
export type { ClearTypeDisplay } from '../glyph/cleartype/index.ts'
export { type PptxFailure, type PptxResult, parsePptx } from './load.ts'
export type {
  AutoShape,
  ChartFrame,
  ConnectionRef,
  Connector,
  DiagramFrame,
  EmbeddedFont,
  Graphic,
  Group,
  Picture,
  Placeholder,
  PlaceholderType,
  Presentation,
  Shape,
  Slide,
  Table,
  TableBorders,
  TableCell,
  TableFlags,
  TableRow,
  UnsupportedCounts,
  UnsupportedKind,
} from './model.ts'
export {
  presentationFonts,
  readSlideFace,
  type SlideFace,
  SlideFontSet,
  type SlideFonts,
} from './render/fonts.ts'
export {
  type EmbeddedFontFile,
  type ImagePart,
  readEmbeddedFonts,
  readImages,
  slideImages,
} from './render/resources.ts'
export {
  paintSlide,
  type SlideContext,
  type SlideResources,
  slideSize,
} from './render/slide.ts'
