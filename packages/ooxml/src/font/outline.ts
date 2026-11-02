/**
 * TrueType 字形：按字形编号读取前进宽度与左侧位（`hmtx`）、墨迹框、轮廓与字形数据（`glyf`/`loca`），供绘制没有码位的字形
 * （如 OpenType `MATH` 表中的变体字形）、按墨迹计算的排版与指令提示（`hinting/`）。
 *
 * - 轮廓为字体单位，y 向上；二次曲线按 TrueType 规则补出相邻控制点之间的隐含落点。
 * - 组合字形按分量的偏移与变换展开；按点号对齐的分量（`ARGS_ARE_XY_VALUES` 为 0）不平移。
 * - `data` 给出未展开的字形数据（点、落点标志、轮廓终点、分量与字形指令），提示时按此逐分量处理。
 * - CFF 轮廓的字体（没有 `glyf`）返回 `null`。
 */

import { readHead } from './metrics.ts'
import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'

export interface GlyphBounds {
  readonly xMin: number
  readonly yMin: number
  readonly xMax: number
  readonly yMax: number
}

export type OutlineCommand =
  | { readonly op: 'M'; readonly x: number; readonly y: number }
  | { readonly op: 'L'; readonly x: number; readonly y: number }
  | {
      readonly op: 'Q'
      readonly cx: number
      readonly cy: number
      readonly x: number
      readonly y: number
    }
  | { readonly op: 'Z' }

/** 简单字形：点的坐标为字体单位，`ends` 为各轮廓最后一个点的序号。 */
export interface SimpleGlyphData {
  readonly kind: 'simple'
  readonly ends: readonly number[]
  readonly xs: Int32Array
  readonly ys: Int32Array
  /** 每点一个字节，1 为落点。 */
  readonly onCurve: Uint8Array
  readonly instructions: Uint8Array
}

/** 组合字形的分量：`flags` 为文件中的分量标志，变换为 `[a, b, c, d]`（没有缩放时为单位矩阵）。 */
export interface GlyphComponent {
  readonly glyph: number
  readonly flags: number
  /** `ARGS_ARE_XY_VALUES` 为 1 时是偏移（字体单位），否则为已有点与分量点的序号。 */
  readonly arg1: number
  readonly arg2: number
  readonly transform: readonly [number, number, number, number]
}

export interface CompositeGlyphData {
  readonly kind: 'composite'
  readonly components: readonly GlyphComponent[]
  /** 全部分量之后的字形指令；没有时为空数组。 */
  readonly instructions: Uint8Array
}

export type GlyphData = SimpleGlyphData | CompositeGlyphData

export interface GlyphOutlines {
  readonly unitsPerEm: number
  readonly numGlyphs: number
  /** 前进宽度，字体单位。编号越界时为 0。 */
  advance(glyph: number): number
  /** 左侧位，字体单位。编号越界时为 0。 */
  leftSideBearing(glyph: number): number
  /** 墨迹框，字体单位；没有轮廓的字形（如空格）与越界编号为 `null`。 */
  bounds(glyph: number): GlyphBounds | null
  /** 轮廓，字体单位，y 向上；没有轮廓的字形为空数组。 */
  outline(glyph: number): readonly OutlineCommand[]
  /** 字形数据；没有轮廓的字形与越界编号为 `null`。 */
  data(glyph: number): GlyphData | null
}

/** 组合字形分量标志。 */
const ARG_WORDS = 0x0001
export const ARGS_ARE_XY = 0x0002
export const ROUND_XY_TO_GRID = 0x0004
const HAVE_SCALE = 0x0008
const MORE = 0x0020
const HAVE_XY_SCALE = 0x0040
const HAVE_2X2 = 0x0080
const HAVE_INSTRUCTIONS = 0x0100
export const USE_MY_METRICS = 0x0200
export const SCALED_COMPONENT_OFFSET = 0x0800

const ON_CURVE = 0x01
const X_SHORT = 0x02
const Y_SHORT = 0x04
const REPEAT = 0x08
const X_SAME = 0x10
const Y_SAME = 0x20

/** 组合字形的展开深度上限：超过时视为结构错误，避免循环引用。 */
const MAX_DEPTH = 8

interface Point {
  x: number
  y: number
  on: boolean
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。没有 `glyf` 时返回 `null`。 */
export function readGlyphOutlines(bytes: Uint8Array, face: SfntFace): GlyphOutlines | null {
  if (!face.tables.has('glyf') || !face.tables.has('loca')) return null
  const headBytes = tableBytes(bytes, face, 'head')
  const { unitsPerEm } = readHead(headBytes)
  const longLoca = view(headBytes).getInt16(50) === 1
  const maxp = view(tableBytes(bytes, face, 'maxp'))
  const numGlyphs = maxp.getUint16(4)
  const hhea = view(tableBytes(bytes, face, 'hhea'))
  const metricCount = hhea.getUint16(34)
  const hmtxBytes = tableBytes(bytes, face, 'hmtx')
  const hmtx = view(hmtxBytes)
  if (metricCount === 0 || hmtxBytes.byteLength < 4 * metricCount) {
    throw new FontFormatError('hmtx 表长度不足')
  }
  const locaBytes = tableBytes(bytes, face, 'loca')
  const loca = view(locaBytes)
  if (locaBytes.byteLength < (numGlyphs + 1) * (longLoca ? 4 : 2)) {
    throw new FontFormatError('loca 表长度不足')
  }
  const glyfBytes = tableBytes(bytes, face, 'glyf')
  const glyf = view(glyfBytes)

  const range = (g: number): [number, number] | null => {
    if (g < 0 || g >= numGlyphs) return null
    const start = longLoca ? loca.getUint32(4 * g) : 2 * loca.getUint16(2 * g)
    const end = longLoca ? loca.getUint32(4 * g + 4) : 2 * loca.getUint16(2 * g + 2)
    if (end <= start) return null
    if (end > glyfBytes.byteLength) throw new FontFormatError('glyf 表长度不足')
    return [start, end]
  }

  const simple = (at: number, end: number, contours: number): SimpleGlyphData => {
    const ends: number[] = []
    let p = at + 10
    for (let i = 0; i < contours; i++, p += 2) ends.push(glyf.getUint16(p))
    const count = contours === 0 ? 0 : ends[contours - 1]! + 1
    const instructionLength = glyf.getUint16(p)
    const instructions = glyfBytes.subarray(p + 2, p + 2 + instructionLength)
    p += 2 + instructionLength
    const flags = new Uint8Array(count)
    for (let i = 0; i < count; ) {
      const f = glyf.getUint8(p++)
      flags[i++] = f
      if (f & REPEAT) {
        let n = glyf.getUint8(p++)
        while (n-- > 0 && i < count) flags[i++] = f
      }
    }
    const xs = new Int32Array(count)
    const ys = new Int32Array(count)
    let v = 0
    for (let i = 0; i < count; i++) {
      const f = flags[i]!
      if (f & X_SHORT) {
        const d = glyf.getUint8(p++)
        v += f & X_SAME ? d : -d
      } else if (!(f & X_SAME)) {
        v += glyf.getInt16(p)
        p += 2
      }
      xs[i] = v
    }
    v = 0
    for (let i = 0; i < count; i++) {
      const f = flags[i]!
      if (f & Y_SHORT) {
        const d = glyf.getUint8(p++)
        v += f & Y_SAME ? d : -d
      } else if (!(f & Y_SAME)) {
        v += glyf.getInt16(p)
        p += 2
      }
      ys[i] = v
    }
    if (p > end) throw new FontFormatError('glyf 字形数据越界')
    const onCurve = new Uint8Array(count)
    for (let i = 0; i < count; i++) onCurve[i] = flags[i]! & ON_CURVE
    return { kind: 'simple', ends, xs, ys, onCurve, instructions }
  }

  const composite = (at: number, end: number): CompositeGlyphData => {
    const components: GlyphComponent[] = []
    let p = at + 10
    let flags: number
    do {
      flags = glyf.getUint16(p)
      const child = glyf.getUint16(p + 2)
      p += 4
      const xy = (flags & ARGS_ARE_XY) !== 0
      let arg1: number
      let arg2: number
      if (flags & ARG_WORDS) {
        arg1 = xy ? glyf.getInt16(p) : glyf.getUint16(p)
        arg2 = xy ? glyf.getInt16(p + 2) : glyf.getUint16(p + 2)
        p += 4
      } else {
        arg1 = xy ? glyf.getInt8(p) : glyf.getUint8(p)
        arg2 = xy ? glyf.getInt8(p + 1) : glyf.getUint8(p + 1)
        p += 2
      }
      let transform: [number, number, number, number] = [1, 0, 0, 1]
      const f2dot14 = (o: number) => glyf.getInt16(o) / 16384
      if (flags & HAVE_SCALE) {
        transform = [f2dot14(p), 0, 0, f2dot14(p)]
        p += 2
      } else if (flags & HAVE_XY_SCALE) {
        transform = [f2dot14(p), 0, 0, f2dot14(p + 2)]
        p += 4
      } else if (flags & HAVE_2X2) {
        transform = [f2dot14(p), f2dot14(p + 2), f2dot14(p + 4), f2dot14(p + 6)]
        p += 8
      }
      components.push({ glyph: child, flags, arg1, arg2, transform })
      if (p > end) throw new FontFormatError('glyf 组合字形数据越界')
    } while (flags & MORE)
    let instructions: Uint8Array = new Uint8Array(0)
    if (flags & HAVE_INSTRUCTIONS && p + 2 <= end) {
      const n = glyf.getUint16(p)
      instructions = glyfBytes.subarray(p + 2, Math.min(end, p + 2 + n))
    }
    return { kind: 'composite', components, instructions }
  }

  const data = (g: number): GlyphData | null => {
    const r = range(g)
    if (r === null) return null
    const [at, end] = r
    const contours = glyf.getInt16(at)
    return contours >= 0 ? simple(at, end, contours) : composite(at, end)
  }

  const points = (g: number, depth: number): Point[][] => {
    if (depth > MAX_DEPTH) throw new FontFormatError('组合字形嵌套过深')
    const d = data(g)
    if (d === null) return []
    if (d.kind === 'simple') {
      const out: Point[][] = []
      let first = 0
      for (const last of d.ends) {
        const c: Point[] = []
        for (let i = first; i <= last; i++)
          c.push({ x: d.xs[i]!, y: d.ys[i]!, on: d.onCurve[i] !== 0 })
        out.push(c)
        first = last + 1
      }
      return out
    }
    const out: Point[][] = []
    for (const k of d.components) {
      const xy = (k.flags & ARGS_ARE_XY) !== 0
      const dx = xy ? k.arg1 : 0
      const dy = xy ? k.arg2 : 0
      const [a, b, c, e] = k.transform
      for (const contour of points(k.glyph, depth + 1)) {
        out.push(
          contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + e * q.y + dy, on: q.on })),
        )
      }
    }
    return out
  }

  return {
    unitsPerEm,
    numGlyphs,
    advance: (g) =>
      g < 0 || g >= numGlyphs ? 0 : hmtx.getUint16(4 * Math.min(g, metricCount - 1)),
    leftSideBearing: (g) => {
      if (g < 0 || g >= numGlyphs) return 0
      if (g < metricCount) return hmtx.getInt16(4 * g + 2)
      const at = 4 * metricCount + 2 * (g - metricCount)
      return at + 2 <= hmtxBytes.byteLength ? hmtx.getInt16(at) : 0
    },
    bounds: (g) => {
      const r = range(g)
      if (r === null) return null
      const at = r[0]
      return {
        xMin: glyf.getInt16(at + 2),
        yMin: glyf.getInt16(at + 4),
        xMax: glyf.getInt16(at + 6),
        yMax: glyf.getInt16(at + 8),
      }
    },
    outline: (g) => toCommands(points(g, 0)),
    data,
  }
}

/** TrueType 轮廓转为路径命令：两个相邻控制点之间补隐含落点，以控制点开头的轮廓从隐含落点或末尾落点起笔。 */
function toCommands(contours: readonly Point[][]): OutlineCommand[] {
  const out: OutlineCommand[] = []
  for (const c of contours) {
    const n = c.length
    if (n === 0) continue
    const startIndex = c.findIndex((q) => q.on)
    let start: Point
    let order: Point[]
    if (startIndex >= 0) {
      start = c[startIndex]!
      order = [...c.slice(startIndex + 1), ...c.slice(0, startIndex + 1)]
    } else {
      start = { x: (c[0]!.x + c[1 % n]!.x) / 2, y: (c[0]!.y + c[1 % n]!.y) / 2, on: true }
      order = [...c.slice(1), c[0]!, start]
    }
    out.push({ op: 'M', x: start.x, y: start.y })
    let control: Point | null = null
    for (const q of order) {
      if (q.on) {
        if (control) out.push({ op: 'Q', cx: control.x, cy: control.y, x: q.x, y: q.y })
        else out.push({ op: 'L', x: q.x, y: q.y })
        control = null
      } else {
        if (control) {
          const mx = (control.x + q.x) / 2
          const my = (control.y + q.y) / 2
          out.push({ op: 'Q', cx: control.x, cy: control.y, x: mx, y: my })
        }
        control = q
      }
    }
    if (control) out.push({ op: 'Q', cx: control.x, cy: control.y, x: start.x, y: start.y })
    out.push({ op: 'Z' })
  }
  return out
}
