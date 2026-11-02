/**
 * TrueType 字形的指令提示：不平滑绘制（见 `EmbeddedBitmaps.screenMode`）时没有点阵的字形与合成斜体的单色光栅化，
 * ClearType 绘制的提示后轮廓，以及 GDI 的整数前进宽度。
 *
 * - 每个 ppem 与绘制方式执行一次 `fpgm` 与 `prep`（`SizeHinter`），单色字形按编号、ppem 与是否倾斜缓存，前进宽度按编号与 ppem 缓存。
 * - 单色字形输出与内嵌点阵相同的 `BitmapGlyph`：原点为提示后的左侧位点，`advance` 为提示后的前进宽度。
 * - 合成斜体：先按正体提示，再把轮廓按 `OBLIQUE_SHEAR` 倾斜（x 增加 y 的倍数，以基线为轴），最后光栅化。
 */

import type { BitmapGlyph } from '../bitmap.ts'
import { readHead } from '../metrics.ts'
import { readGlyphOutlines } from '../outline.ts'
import { type SfntFace, tableBytes } from '../sfnt.ts'
import { type ClearTypeRange, readClearTypeRanges } from './gasp.ts'
import { type HintedOutline, hintGlyph, type VerticalAdvance } from './glyph.ts'
import { type FontPrograms, SizeHinter } from './interpreter.ts'
import { rasterize } from './raster.ts'

/**
 * 合成斜体的倾斜系数。实测（WPS 表格，宋体 9–13 磅的全部可打印 ASCII 与汉字）：0.3392–0.3398 与真值的差异最小，
 * 与正体字形的残差相当；1/3 时 13 磅每行相差约 20 像素。先倾斜再提示的结果与真值不符。
 */
const OBLIQUE_SHEAR = 0.3395

export interface GlyphHinting {
  /**
   * 字形 `glyphId` 在 `ppem` 下提示后的单色图像；`oblique` 为真时按合成斜体倾斜。没有轮廓的字形为 0×0。
   * 字形数据不合法时抛出 `FontFormatError`。
   */
  glyph(glyphId: number, ppem: number, oblique: boolean): BitmapGlyph
  /**
   * ClearType 绘制下字形 `glyphId` 在 `ppem` 下提示后的轮廓（`gasp` 不要求网格对齐的字号为缩放后未提示的轮廓），
   * `oblique` 为真时按合成斜体倾斜。不缓存，调用方缓存光栅化的结果。字形数据不合法时抛出 `FontFormatError`。
   */
  clearTypeOutline(glyphId: number, ppem: number, oblique: boolean): HintedOutline
  /** 单色提示后的前进宽度（整数像素），按编号与 ppem 缓存。字形数据不合法时抛出 `FontFormatError`。 */
  advance(glyphId: number, ppem: number): number
  /** ClearType 绘制在 `ppem` 下的方式（`gasp`）。 */
  clearTypeRange(ppem: number): ClearTypeRange
}

/** 按 `OBLIQUE_SHEAR` 倾斜轮廓：x 增加 y 的倍数，取整到 26.6 的单位。 */
function shear(h: HintedOutline): HintedOutline {
  return { ...h, xs: h.xs.map((x, i) => x + Math.round(OBLIQUE_SHEAR * h.ys[i]!)) }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function table(bytes: Uint8Array, face: SfntFace, tag: string): Uint8Array {
  return face.tables.has(tag) ? tableBytes(bytes, face, tag) : new Uint8Array(0)
}

/** 各字体已读取的提示：同一字体的前进宽度（`readPixelAdvances`）与 ClearType 字形共用 `SizeHinter` 与各项缓存。 */
const readers = new WeakMap<SfntFace, { bytes: Uint8Array; hinting: GlyphHinting | null }>()

/**
 * 读取提示所需的表。没有 `glyf` 的字形（CFF 轮廓）返回 `null`。同一 `bytes` 与 `face` 对象返回同一个实例
 * （按对象判定，不比较内容）。
 */
export function readGlyphHinting(bytes: Uint8Array, face: SfntFace): GlyphHinting | null {
  const known = readers.get(face)
  if (known?.bytes === bytes) return known.hinting
  const hinting = createGlyphHinting(bytes, face)
  readers.set(face, { bytes, hinting })
  return hinting
}

function createGlyphHinting(bytes: Uint8Array, face: SfntFace): GlyphHinting | null {
  const outlines = readGlyphOutlines(bytes, face)
  if (outlines === null) return null
  const maxp = view(tableBytes(bytes, face, 'maxp'))
  const v1 = maxp.byteLength >= 32 && maxp.getUint32(0) === 0x00010000
  const cvtBytes = table(bytes, face, 'cvt ')
  const cvt = new Int16Array(cvtBytes.byteLength >> 1)
  const cv = view(cvtBytes)
  for (let i = 0; i < cvt.length; i++) cvt[i] = cv.getInt16(2 * i)
  const programs: FontPrograms = {
    unitsPerEm: readHead(tableBytes(bytes, face, 'head')).unitsPerEm,
    fpgm: table(bytes, face, 'fpgm'),
    prep: table(bytes, face, 'prep'),
    cvt,
    maxTwilight: v1 ? maxp.getUint16(16) : 0,
    maxStorage: v1 ? maxp.getUint16(18) : 0,
    maxStack: v1 ? maxp.getUint16(24) : 0,
  }
  const vertical = readVertical(bytes, face, (g) => outlines.bounds(g)?.yMax ?? 0)
  const ranges = readClearTypeRanges(bytes, face)
  const sizes = new Map<number, SizeHinter>()
  const size = (ppem: number, clearType: boolean): SizeHinter => {
    const key = ppem * 2 + (clearType ? 1 : 0)
    let s = sizes.get(key)
    if (s === undefined) {
      s = new SizeHinter(programs, ppem, clearType, clearType && ranges(ppem).smoothY)
      sizes.set(key, s)
    }
    return s
  }
  const glyphs = new Map<number, BitmapGlyph>()
  const advances = new Map<number, number>()
  const advance = (glyphId: number, ppem: number): number => {
    const key = ppem * 0x10000 + glyphId
    let a = advances.get(key)
    if (a === undefined) {
      a = Math.round(hintGlyph(outlines, vertical, size(ppem, false), glyphId).advance / 64)
      advances.set(key, a)
    }
    return a
  }
  return {
    glyph(glyphId, ppem, oblique) {
      const key = (ppem * 0x10000 + glyphId) * 2 + (oblique ? 1 : 0)
      let g = glyphs.get(key)
      if (g === undefined) {
        const h = hintGlyph(outlines, vertical, size(ppem, false), glyphId)
        g = rasterize(oblique ? shear(h) : h)
        glyphs.set(key, g)
      }
      return g
    },
    clearTypeOutline(glyphId, ppem, oblique) {
      const h = hintGlyph(
        outlines,
        vertical,
        size(ppem, true),
        glyphId,
        ranges(ppem).gridFit,
        () => 64 * advance(glyphId, ppem),
      )
      return oblique ? shear(h) : h
    },
    advance,
    clearTypeRange: ranges,
  }
}

/**
 * 幻影点所需的纵向度量：有 `vhea`/`vmtx` 时取自其中；否则上方点取 `OS/2.sTypoAscender`（没有 `OS/2` 时取 `hhea` 的上沿），
 * 纵向前进取上下沿之差。
 */
function readVertical(
  bytes: Uint8Array,
  face: SfntFace,
  yMax: (glyph: number) => number,
): (glyph: number) => VerticalAdvance {
  if (face.tables.has('vhea') && face.tables.has('vmtx')) {
    const count = view(tableBytes(bytes, face, 'vhea')).getUint16(34)
    const vmtxBytes = tableBytes(bytes, face, 'vmtx')
    const vmtx = view(vmtxBytes)
    if (count > 0 && vmtxBytes.byteLength >= 4 * count) {
      return (g) => {
        const advanceHeight = vmtx.getUint16(4 * Math.min(g, count - 1))
        const at = g < count ? 4 * g + 2 : 4 * count + 2 * (g - count)
        const topSideBearing = at + 2 <= vmtxBytes.byteLength ? vmtx.getInt16(at) : 0
        return { topSideBearing, advanceHeight }
      }
    }
  }
  let ascender: number
  let descender: number
  if (face.tables.has('OS/2') && face.tables.get('OS/2')!.length >= 72) {
    const os2 = view(tableBytes(bytes, face, 'OS/2'))
    ascender = os2.getInt16(68)
    descender = os2.getInt16(70)
  } else {
    const hhea = view(tableBytes(bytes, face, 'hhea'))
    ascender = hhea.getInt16(4)
    descender = hhea.getInt16(6)
  }
  return (g) => ({ topSideBearing: ascender - yMax(g), advanceHeight: ascender - descender })
}
