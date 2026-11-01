/**
 * 字体表读取：服务端拆分 TTC 与建立字体索引、浏览器端排版度量共用这一入口。
 */

export {
  type BitmapGlyph,
  type EmbeddedBitmaps,
  emboldenBitmap,
  readEmbeddedBitmaps,
} from './bitmap.ts'
export {
  decodeMicroTypeExpress,
  type EmbeddedOpenType,
  readEmbeddedOpenType,
} from './embedded/eot.ts'
export { type FontMetrics, readHead, readMetrics } from './metrics.ts'
export { readFamilyNames } from './name.ts'
export { readPixelAdvances } from './pixel-advance.ts'
export { type PixelVerticalMetrics, readPixelVerticalMetrics } from './pixel-metrics.ts'
export {
  extractFace,
  FontFormatError,
  isCffOutline,
  readFaces,
  type SfntFace,
  type TableRecord,
  tableBytes,
  tableRecord,
} from './sfnt.ts'
export { readVerticalMetrics, type VerticalMetrics } from './vertical.ts'
