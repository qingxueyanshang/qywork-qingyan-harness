/**
 * 按像素的纵向度量，与 Windows GDI `GetTextMetrics` 在给定 ppem 下的整数结果一致。
 *
 * - 上沿与下沿：`VDMX` 中有 1:1 比例且 `bCharSet` 为 1 的记录组，且组内有该 ppem 时取其 `yMax`、`-yMin`；
 *   否则为 `usWinAscent`、`usWinDescent` 按 ppem 缩放后四舍五入。`bCharSet` 为 0 的记录组不使用，
 *   不要放宽为任意记录组：只带这类记录组的字体（如 Tahoma）在 GDI 中按缩放取整计算。
 * - 外部行距：`hhea.lineGap - ((usWinAscent + usWinDescent) - (hhea.ascender - hhea.descender))` 按 ppem 缩放后
 *   四舍五入，小于 0 时取 0。
 * - 取整为四舍五入（0.5 进位），按整数运算，不经浮点。不要改为向上取整：宋体 12 像素的上沿 220 × 12 / 256 = 10.3，
 *   GDI 为 10。
 */

import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'
import { readVerticalMetrics } from './vertical.ts'

export interface PixelVerticalMetrics {
  /** 基线以上的像素数（`tmAscent`）。 */
  ascent: number
  /** 基线以下的像素数（`tmDescent`）。 */
  descent: number
  /** `ascent + descent`（`tmHeight`）。 */
  height: number
  /** `height - ppem`（`tmInternalLeading`）。 */
  internalLeading: number
  /** `tmExternalLeading`。 */
  externalLeading: number
}

type VdmxGroup = ReadonlyMap<number, readonly [yMax: number, yMin: number]>

/** 按 1:1 显示比例选用的 `VDMX` 记录组；没有可用的记录组时返回 `null`。 */
function readVdmx(table: Uint8Array): VdmxGroup | null {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  if (table.byteLength < 6) throw new FontFormatError('VDMX 表长度不足')
  const ratios = v.getUint16(4)
  if (table.byteLength < 6 + 6 * ratios) throw new FontFormatError('VDMX 比例记录超出表范围')
  for (let i = 0; i < ratios; i++) {
    const at = 6 + 4 * i
    const charSet = v.getUint8(at)
    const x = v.getUint8(at + 1)
    const yStart = v.getUint8(at + 2)
    const yEnd = v.getUint8(at + 3)
    const matches = (x === 0 && yStart === 0 && yEnd === 0) || (yStart <= x && x <= yEnd)
    if (charSet !== 1 || !matches) continue
    const group = v.getUint16(6 + 4 * ratios + 2 * i)
    if (table.byteLength < group + 4) throw new FontFormatError('VDMX 记录组超出表范围')
    const count = v.getUint16(group)
    if (table.byteLength < group + 4 + 6 * count) throw new FontFormatError('VDMX 记录组超出表范围')
    const out = new Map<number, readonly [number, number]>()
    for (let k = 0; k < count; k++) {
      const rec = group + 4 + 6 * k
      out.set(v.getUint16(rec), [v.getInt16(rec + 2), v.getInt16(rec + 4)])
    }
    return out
  }
  return null
}

/** `value × ppem / unitsPerEm` 四舍五入（0.5 进位）。 */
function scaleRound(value: number, ppem: number, unitsPerEm: number): number {
  return Math.floor((2 * value * ppem + unitsPerEm) / (2 * unitsPerEm))
}

/**
 * 返回按 ppem 求纵向度量的函数。`ppem` 为整数像素字号（GDI 字体高度取负值时的字符高度）。
 * 粗体、斜体传入对应字形的字体文件；没有对应文件而由 GDI 合成时传入常规字形，合成不改变这些度量。
 * `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。字体缺少 `OS/2` 表时抛出。
 */
export function readPixelVerticalMetrics(
  bytes: Uint8Array,
  face: SfntFace,
): (ppem: number) => PixelVerticalMetrics {
  const m = readVerticalMetrics(bytes, face)
  const vdmx = face.tables.has('VDMX') ? readVdmx(tableBytes(bytes, face, 'VDMX')) : null
  const gap = m.hheaLineGap - (m.winAscent + m.winDescent - (m.hheaAscender - m.hheaDescender))
  return (ppem) => {
    const rec = vdmx?.get(ppem)
    const ascent = rec ? rec[0] : scaleRound(m.winAscent, ppem, m.unitsPerEm)
    const descent = rec ? -rec[1] : scaleRound(m.winDescent, ppem, m.unitsPerEm)
    const height = ascent + descent
    return {
      ascent,
      descent,
      height,
      internalLeading: height - ppem,
      externalLeading: Math.max(0, scaleRound(gap, ppem, m.unitsPerEm)),
    }
  }
}
