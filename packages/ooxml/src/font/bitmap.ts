/**
 * 内嵌点阵字形：`EBLC`（位置）与 `EBDT`（图像）。
 *
 * - 读取索引子表格式 1–5；图像格式 1、2、5、7，位深 1。含其他图像格式、其他位深或没有横排度量的 strike
 *   不列入 `sizes`，该字号按轮廓字形处理。
 * - 只在调用 `glyph` 时解码单个字形，读取时只建立 strike 与索引子表的目录。
 */

import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'
import { codePageRange1 } from './vertical.ts'

/**
 * `OS/2.ulCodePageRange1` 的第 17–20 位：日文、简体中文、韩文（Wansung）、繁体中文。
 * 不含第 21 位（韩文 Johab）：只带该位的字体在 ClearType 下不使用点阵。
 */
const SCREEN_BITMAP_CODE_PAGES = 0x001e0000
const BITMAP_SIZE_LENGTH = 48
const HORIZONTAL = 1
const SUPPORTED_IMAGE_FORMATS = new Set([1, 2, 5, 7])

export interface BitmapGlyph {
  readonly width: number
  readonly height: number
  /** 原点到点阵左边的像素数，向右为正。 */
  readonly bearingX: number
  /** 基线到点阵上边的像素数，向上为正。 */
  readonly bearingY: number
  /**
   * 点阵度量中的前进宽度，像素。等宽字体（`post.isFixedPitch` 为 1，如新宋体）在奇数 ppem 下，
   * GDI 的全角字形前进宽度取半角宽度的 2 倍，比此值大 1。
   */
  readonly advance: number
  /** 逐行排列，每像素一个字节，1 为着墨；长度为 `width × height`。 */
  readonly pixels: Uint8Array
}

export interface EmbeddedBitmaps {
  /** 可读取的 strike 的 ppem（横纵相同），升序。 */
  readonly sizes: readonly number[]
  /**
   * Windows 在 ClearType 下以点阵模式绘制该字号：字体代码页含日文、简体中文、韩文（Wansung）或繁体中文，
   * 有该 ppem 的 strike，且不是斜体。`gasp` 表与文字颜色不影响这一判定。
   * - 点阵模式下 strike 中有的字形取点阵，只用前景色一种颜色；没有的字形按轮廓绘制且不做平滑。
   * - 点阵超出基线以上 `ascent`、以下 `descent`（见 `readPixelVerticalMetrics`）的行不绘制。
   * - 粗体取点阵后加粗，见 `emboldenBitmap`；斜体按轮廓字形倾斜绘制，同样不做平滑。
   */
  screenMode(ppem: number, italic: boolean): boolean
  /** 该 ppem 没有可读取的 strike，或 strike 中没有这个字形时返回 `null`。 */
  glyph(ppem: number, glyphId: number): BitmapGlyph | null
}

interface SubTable {
  first: number
  last: number
  indexFormat: number
  imageFormat: number
  /** `EBDT` 中图像数据的起点。 */
  imageData: number
  /** 索引子表头之后的位置（`EBLC` 内）。 */
  body: number
}

interface Strike {
  ppem: number
  subTables: SubTable[]
}

interface Metrics {
  height: number
  width: number
  bearingX: number
  bearingY: number
  advance: number
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function check(table: Uint8Array, end: number, what: string): void {
  if (end > table.byteLength) throw new FontFormatError(`${what}超出表范围`)
}

/** `BigGlyphMetrics` 的横排部分（8 字节）或 `SmallGlyphMetrics`（5 字节），两者前 5 个字段的布局相同。 */
function readMetricsAt(v: DataView, at: number): Metrics {
  return {
    height: v.getUint8(at),
    width: v.getUint8(at + 1),
    bearingX: v.getInt8(at + 2),
    bearingY: v.getInt8(at + 3),
    advance: v.getUint8(at + 4),
  }
}

function readStrikes(eblc: Uint8Array): Strike[] {
  const v = view(eblc)
  check(eblc, 8, 'EBLC 表头')
  const count = v.getUint32(4)
  check(eblc, 8 + BITMAP_SIZE_LENGTH * count, 'EBLC strike 目录')
  const strikes: Strike[] = []
  for (let i = 0; i < count; i++) {
    const at = 8 + BITMAP_SIZE_LENGTH * i
    const arrayOffset = v.getUint32(at)
    const subCount = v.getUint32(at + 8)
    const ppemX = v.getUint8(at + 44)
    const ppemY = v.getUint8(at + 45)
    const bitDepth = v.getUint8(at + 46)
    const flags = v.getUint8(at + 47)
    check(eblc, arrayOffset + 8 * subCount, 'EBLC 索引子表目录')
    const subTables: SubTable[] = []
    for (let k = 0; k < subCount; k++) {
      const entry = arrayOffset + 8 * k
      const header = arrayOffset + v.getUint32(entry + 4)
      check(eblc, header + 8, 'EBLC 索引子表头')
      subTables.push({
        first: v.getUint16(entry),
        last: v.getUint16(entry + 2),
        indexFormat: v.getUint16(header),
        imageFormat: v.getUint16(header + 2),
        imageData: v.getUint32(header + 4),
        body: header + 8,
      })
    }
    const readable =
      ppemX === ppemY &&
      bitDepth === 1 &&
      (flags & HORIZONTAL) !== 0 &&
      subTables.every(
        (s) =>
          s.indexFormat >= 1 &&
          s.indexFormat <= 5 &&
          SUPPORTED_IMAGE_FORMATS.has(s.imageFormat) &&
          // 图像格式 5 不带度量，度量只在索引格式 2、5 中。
          (s.imageFormat !== 5 || s.indexFormat === 2 || s.indexFormat === 5),
      )
    if (readable) strikes.push({ ppem: ppemY, subTables })
  }
  return strikes.sort((a, b) => a.ppem - b.ppem)
}

/** 字形在 `EBDT` 中的范围 `[start, end)`；索引格式 2、5 另带共用度量。字形不在子表中时返回 `null`。 */
function locate(
  v: DataView,
  eblc: Uint8Array,
  s: SubTable,
  glyphId: number,
): { start: number; end: number; metrics: Metrics | null } | null {
  const n = glyphId - s.first
  switch (s.indexFormat) {
    case 1:
    case 3: {
      const size = s.indexFormat === 1 ? 4 : 2
      const at = s.body + size * n
      check(eblc, at + 2 * size, 'EBLC 偏移数组')
      const read = (p: number) => (size === 4 ? v.getUint32(p) : v.getUint16(p))
      const start = read(at)
      const end = read(at + size)
      return end > start
        ? { start: s.imageData + start, end: s.imageData + end, metrics: null }
        : null
    }
    case 2: {
      check(eblc, s.body + 12, 'EBLC 索引格式 2')
      const imageSize = v.getUint32(s.body)
      const start = s.imageData + imageSize * n
      return { start, end: start + imageSize, metrics: readMetricsAt(v, s.body + 4) }
    }
    case 4: {
      check(eblc, s.body + 4, 'EBLC 索引格式 4')
      const count = v.getUint32(s.body)
      const pairs = s.body + 4
      check(eblc, pairs + 4 * (count + 1), 'EBLC 字形偏移对')
      let lo = 0
      let hi = count - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const g = v.getUint16(pairs + 4 * mid)
        if (g < glyphId) lo = mid + 1
        else if (g > glyphId) hi = mid - 1
        else {
          const start = v.getUint16(pairs + 4 * mid + 2)
          const end = v.getUint16(pairs + 4 * mid + 6)
          return end > start
            ? { start: s.imageData + start, end: s.imageData + end, metrics: null }
            : null
        }
      }
      return null
    }
    case 5: {
      check(eblc, s.body + 16, 'EBLC 索引格式 5')
      const imageSize = v.getUint32(s.body)
      const count = v.getUint32(s.body + 12)
      const ids = s.body + 16
      check(eblc, ids + 2 * count, 'EBLC 字形编号数组')
      let lo = 0
      let hi = count - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const g = v.getUint16(ids + 2 * mid)
        if (g < glyphId) lo = mid + 1
        else if (g > glyphId) hi = mid - 1
        else {
          const start = s.imageData + imageSize * mid
          return { start, end: start + imageSize, metrics: readMetricsAt(v, s.body + 4) }
        }
      }
      return null
    }
    default:
      return null
  }
}

/** 位于 `[start, end)` 的单色图像解码为每像素一字节。`byteAligned` 为真时每行从新的字节开始。 */
function decode(
  ebdt: Uint8Array,
  start: number,
  end: number,
  m: Metrics,
  byteAligned: boolean,
): Uint8Array {
  const pixels = new Uint8Array(m.width * m.height)
  const rowBits = byteAligned ? ((m.width + 7) >> 3) << 3 : m.width
  if (Math.ceil((rowBits * m.height) / 8) > end - start) {
    throw new FontFormatError('EBDT 图像数据长度不足')
  }
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const bit = y * rowBits + x
      pixels[y * m.width + x] = (ebdt[start + (bit >> 3)]! >> (7 - (bit & 7))) & 1
    }
  }
  return pixels
}

/**
 * 读取内嵌点阵。字体没有 `EBLC` 或 `EBDT` 时返回 `null`。
 * `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。
 */
export function readEmbeddedBitmaps(bytes: Uint8Array, face: SfntFace): EmbeddedBitmaps | null {
  if (!face.tables.has('EBLC') || !face.tables.has('EBDT')) return null
  const eblc = tableBytes(bytes, face, 'EBLC')
  const ebdt = tableBytes(bytes, face, 'EBDT')
  const strikes = readStrikes(eblc)
  const cjk = face.tables.has('OS/2')
    ? (codePageRange1(tableBytes(bytes, face, 'OS/2')) & SCREEN_BITMAP_CODE_PAGES) !== 0
    : false
  const ev = view(eblc)
  const dv = view(ebdt)
  const byPpem = new Map(strikes.map((s) => [s.ppem, s]))

  return {
    sizes: strikes.map((s) => s.ppem),
    screenMode: (ppem, italic) => cjk && !italic && byPpem.has(ppem),
    glyph(ppem, glyphId) {
      const strike = byPpem.get(ppem)
      const s = strike?.subTables.find((t) => glyphId >= t.first && glyphId <= t.last)
      if (!s) return null
      const loc = locate(ev, eblc, s, glyphId)
      if (!loc) return null
      if (loc.end > ebdt.byteLength) throw new FontFormatError('EBDT 字形超出表范围')
      let metrics: Metrics
      let image: number
      switch (s.imageFormat) {
        case 1:
        case 2:
          metrics = readMetricsAt(dv, loc.start)
          image = loc.start + 5
          break
        case 7:
          metrics = readMetricsAt(dv, loc.start)
          image = loc.start + 8
          break
        default:
          // 图像格式 5：度量来自索引格式 2 或 5，读取 strike 时已核对。
          metrics = loc.metrics!
          image = loc.start
      }
      return { ...metrics, pixels: decode(ebdt, image, loc.end, metrics, s.imageFormat === 1) }
    },
  }
}

/**
 * Windows 对点阵字形的粗体模拟：点阵与其右移 1 像素的副本取并集，宽度与前进宽度各加 1。
 */
export function emboldenBitmap(g: BitmapGlyph): BitmapGlyph {
  const width = g.width + 1
  const pixels = new Uint8Array(width * g.height)
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (g.pixels[y * g.width + x]) {
        pixels[y * width + x] = 1
        pixels[y * width + x + 1] = 1
      }
    }
  }
  return { ...g, width, advance: g.advance + 1, pixels }
}
