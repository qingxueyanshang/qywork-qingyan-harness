/**
 * WMF 读取：可放置文件头（`0x9AC6CDD7`）给出图片框（逻辑坐标的边界）与每英寸的逻辑单位数，其后为标准文件头与记录。
 *
 * - 没有可放置文件头的 WMF 没有图片框，计为不支持。
 * - 对象表按标准规则分配：新建的对象放入编号最小的空位，删除后空位可再用；选入时按编号取对象。
 * - 映射：播放时窗口初值为图片框，视口为目标矩形，映射模式为 `MM_ANISOTROPIC`；记录可修改窗口的原点与范围、
 *   在 `MM_ANISOTROPIC` 与 `MM_ISOTROPIC` 之间切换。修改视口与其他映射模式未实现。
 * - `SELECTCLIPREGION` 引用的对象不是区域时取消裁剪（区域对象未实现）。
 * - 参数为 16 位；多数记录的坐标参数 y 在前，按各记录的格式读取。
 */

import { Builder, decodeAnsi, type FontObject, fontObject } from './builder.ts'
import {
  type Box,
  type Brush,
  type Metafile,
  NO_SIZE,
  type Pen,
  type Point,
  type Rgb,
} from './model.ts'

const PLACEABLE_KEY = 0x9ac6cdd7

type WmfObject =
  | { readonly kind: 'pen'; readonly pen: Pen }
  | { readonly kind: 'brush'; readonly brush: Brush }
  | { readonly kind: 'font'; readonly font: FontObject }
  | { readonly kind: 'other' }

/** 记录名，用于不支持的记录的登记。 */
const NAMES: Readonly<Record<number, string>> = {
  53: 'REALIZEPALETTE',
  55: 'SETPALENTRIES',
  313: 'RESIZEPALETTE',
  329: 'SETLAYOUT',
  529: 'OFFSETVIEWPORTORG',
  527: 'OFFSETWINDOWORG',
  544: 'OFFSETCLIPRGN',
  552: 'FILLREGION',
  561: 'SETMAPPERFLAGS',
  1040: 'SCALEWINDOWEXT',
  1042: 'SCALEVIEWPORTEXT',
  1049: 'FLOODFILL',
  1065: 'FRAMEREGION',
  1078: 'ANIMATEPALETTE',
  1352: 'EXTFLOODFILL',
  1055: 'SETPIXEL',
  1564: 'ROUNDRECT',
  2074: 'PIE',
  2851: 'STRETCHBLT',
  298: 'INVERTREGION',
  299: 'PAINTREGION',
  2071: 'ARC',
  2096: 'CHORD',
  2338: 'BITBLT',
  3379: 'SETDIBTODEV',
}

class Params {
  private readonly v: DataView
  constructor(
    private readonly b: Uint8Array,
    /** 参数在 `b` 中的起点与终点（字节）。 */
    readonly start: number,
    readonly end: number,
  ) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  /** 第 `i` 个 16 位有符号参数。 */
  s(i: number): number {
    return this.start + i * 2 + 2 <= this.end ? this.v.getInt16(this.start + i * 2, true) : 0
  }
  u(i: number): number {
    return this.start + i * 2 + 2 <= this.end ? this.v.getUint16(this.start + i * 2, true) : 0
  }
  u32(i: number): number {
    return this.start + i * 2 + 4 <= this.end ? this.v.getUint32(this.start + i * 2, true) : 0
  }
  get words(): number {
    return (this.end - this.start) >> 1
  }
  bytes(i: number, n: number): Uint8Array {
    const at = this.start + i * 2
    return this.b.subarray(at, Math.min(this.end, at + n))
  }
  color(i: number): Rgb {
    const c = this.u32(i)
    return { r: c & 0xff, g: (c >> 8) & 0xff, b: (c >> 16) & 0xff }
  }
  /** 第 `i` 个参数起为 `bottom, right, top, left`。 */
  box(i: number): Box {
    return { bottom: this.s(i), right: this.s(i + 1), top: this.s(i + 2), left: this.s(i + 3) }
  }
  points(i: number, n: number): Point[] {
    const out: Point[] = []
    for (let k = 0; k < n; k++) out.push({ x: this.s(i + 2 * k), y: this.s(i + 2 * k + 1) })
    return out
  }
}

/** 画笔样式的低 4 位、端点与连接。 */
function wmfPen(style: number, width: number, color: Rgb): Pen | string {
  const kind = style & 0x0f
  if (kind !== 0 && kind !== 5) return `pen:style${kind}`
  const cap = style & 0x0f00
  const join = style & 0xf000
  return {
    style: kind === 5 ? 'null' : 'solid',
    width: Math.abs(width),
    cosmetic: width === 0,
    color,
    cap: cap === 0x0100 ? 'square' : cap === 0x0200 ? 'butt' : 'round',
    join: join === 0x1000 ? 'bevel' : join === 0x2000 ? 'miter' : 'round',
  }
}

export function wmfBrush(style: number, color: Rgb): Brush | string {
  if (style === 0) return { kind: 'solid', color }
  if (style === 1) return { kind: 'null' }
  return `brush:style${style}`
}

/** 字体名：按字体的字符集解码，取第一个空字符之前的部分。 */
function faceName(bytes: Uint8Array, charset: number): string {
  const end = bytes.indexOf(0)
  const raw = end < 0 ? bytes : bytes.subarray(0, end)
  const decoded = decodeAnsi(raw, charset, null)
  return typeof decoded === 'string' ? new TextDecoder('windows-1252').decode(raw) : decoded.text
}

/** 光栅操作：`SRCCOPY`、`PATCOPY`、`BLACKNESS`、`WHITENESS`。 */
const SRCCOPY = 0x00cc0020
const PATCOPY = 0x00f00021
const BLACKNESS = 0x00000042
const WHITENESS = 0x00ff0062

function patFill(rop: number): 'brush' | 'black' | 'white' | null {
  return rop === PATCOPY
    ? 'brush'
    : rop === BLACKNESS
      ? 'black'
      : rop === WHITENESS
        ? 'white'
        : null
}

/** 判断字节是否为 WMF（可放置文件头或标准文件头）。 */
export function isWmf(b: Uint8Array): boolean {
  if (b.length < 18) return false
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (v.getUint32(0, true) === PLACEABLE_KEY) return true
  const type = v.getUint16(0, true)
  const version = v.getUint16(4, true)
  return (
    (type === 1 || type === 2) &&
    v.getUint16(2, true) === 9 &&
    (version === 0x0100 || version === 0x0300)
  )
}

export function readWmf(b: Uint8Array): Metafile {
  const out = new Builder()
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const empty: Box = { left: 0, top: 0, right: 0, bottom: 0 }
  if (b.length < 22 || v.getUint32(0, true) !== PLACEABLE_KEY) {
    out.unsupported('header:nonPlaceable')
    return out.finish('wmf', empty, null, NO_SIZE)
  }
  const frame: Box = {
    left: v.getInt16(6, true),
    top: v.getInt16(8, true),
    right: v.getInt16(10, true),
    bottom: v.getInt16(12, true),
  }
  const headerWords = b.length >= 40 ? v.getUint16(24, true) : 0
  const objectCount = b.length >= 40 ? v.getUint16(32, true) : 0
  if (headerWords < 9 || frame.right === frame.left || frame.bottom === frame.top) {
    out.unsupported('header')
    return out.finish('wmf', frame, null, NO_SIZE)
  }
  const objects: (WmfObject | null)[] = new Array(objectCount).fill(null)
  const create = (o: WmfObject) => {
    const i = objects.indexOf(null)
    if (i < 0) out.unsupported('objectTable')
    else objects[i] = o
  }
  let off = 22 + headerWords * 2
  let ended = false
  while (off + 6 <= b.length) {
    const size = v.getUint32(off, true) * 2
    const fn = v.getUint16(off + 4, true)
    if (size < 6 || off + size > b.length) break
    const p = new Params(b, off + 6, off + size)
    off += size
    if (fn === 0x0000) {
      ended = true
      break
    }
    record(fn, p, out, objects, create)
  }
  if (!ended) out.unsupported('truncated')
  const inch = v.getUint16(14, true) || 1440
  const size = {
    width: (Math.abs(frame.right - frame.left) * 96) / inch,
    height: (Math.abs(frame.bottom - frame.top) * 96) / inch,
  }
  return out.finish('wmf', frame, null, size)
}

function record(
  fn: number,
  p: Params,
  out: Builder,
  objects: (WmfObject | null)[],
  create: (o: WmfObject) => void,
): void {
  switch (fn) {
    case 0x0626: // ESCAPE：只有注释（MFCOMMENT）不影响绘制。
      if (p.u(0) !== 15) out.unsupported(`ESCAPE:${p.u(0)}`)
      return
    case 0x020b:
      out.op({ op: 'windowOrg', x: p.s(1), y: p.s(0) })
      return
    case 0x020c:
      out.op({ op: 'windowExt', x: p.s(1), y: p.s(0) })
      return
    case 0x020d:
    case 0x020e:
      out.unsupported(fn === 0x020d ? 'SETVIEWPORTORG' : 'SETVIEWPORTEXT')
      return
    case 0x0103: {
      const mode = p.u(0)
      if (mode === 7 || mode === 8) out.op({ op: 'mapMode', mode })
      else out.unsupported(`SETMAPMODE:${mode}`)
      return
    }
    case 0x0102:
      out.op({ op: 'bkMode', opaque: p.u(0) === 2 })
      return
    case 0x0201:
      out.op({ op: 'bkColor', color: p.color(0) })
      return
    case 0x0209:
      out.op({ op: 'textColor', color: p.color(0) })
      return
    case 0x012e: {
      const align = p.u(0)
      if (align & 0x0101) out.unsupported('SETTEXTALIGN:updateCp')
      else out.op({ op: 'textAlign', align })
      return
    }
    case 0x0106:
      out.op({ op: 'fillMode', evenOdd: p.u(0) !== 2 })
      return
    case 0x0107: // SETSTRETCHBLTMODE：位图一律平滑缩放（见 `play.ts`）。
      return
    case 0x0104:
      if (p.u(0) !== 13) out.unsupported(`SETROP2:${p.u(0)}`)
      return
    case 0x0105: // SETRELABS：不影响绘制。
      return
    case 0x0108:
    case 0x020a:
      if (p.s(0) !== 0 || (fn === 0x020a && p.s(1) !== 0))
        out.unsupported(fn === 0x0108 ? 'SETTEXTCHAREXTRA' : 'SETTEXTJUSTIFICATION')
      return
    case 0x001e:
      out.op({ op: 'save' })
      return
    case 0x0127:
      out.op({ op: 'restore', index: p.s(0) })
      return
    case 0x0214:
      out.op({ op: 'moveTo', p: { x: p.s(1), y: p.s(0) } })
      return
    case 0x0213:
      out.op({ op: 'lineTo', p: { x: p.s(1), y: p.s(0) } })
      return
    case 0x0324:
    case 0x0325: {
      const n = p.u(0)
      out.op({ op: fn === 0x0324 ? 'polygon' : 'polyline', points: p.points(1, n) })
      return
    }
    case 0x0538: {
      const count = p.u(0)
      const polys: Point[][] = []
      let at = 1 + count
      for (let k = 0; k < count; k++) {
        const n = p.u(1 + k)
        polys.push(p.points(at, n))
        at += 2 * n
      }
      out.op({ op: 'polyPolygon', polys })
      return
    }
    case 0x041b:
    case 0x0418:
      out.op({ op: fn === 0x041b ? 'rectangle' : 'ellipse', box: p.box(0), shrink: true })
      return
    case 0x0415:
    case 0x0416:
      out.op({ op: 'clipRect', box: p.box(0), exclude: fn === 0x0415 })
      return
    case 0x012c: {
      const o = objects[p.u(0)]
      if (o?.kind === 'other') out.unsupported('SELECTCLIPREGION:region')
      else out.op({ op: 'clipRegion', rects: null, mode: 'copy' })
      return
    }
    case 0x061d: {
      const fill = patFill(p.u32(0))
      if (fill === null) {
        out.unsupported(`PATBLT:${p.u32(0).toString(16)}`)
        return
      }
      const x = p.s(5)
      const y = p.s(4)
      out.op({
        op: 'patBlt',
        box: { left: x, top: y, right: x + p.s(3), bottom: y + p.s(2) },
        fill,
      })
      return
    }
    case 0x0a32: {
      const y = p.s(0)
      const x = p.s(1)
      const count = p.u(2)
      const options = p.u(3)
      if (options & ~0x0006) {
        out.unsupported(`EXTTEXTOUT:options${options.toString(16)}`)
        return
      }
      const hasRect = (options & 0x0006) !== 0
      const rect = hasRect ? { left: p.s(4), top: p.s(5), right: p.s(6), bottom: p.s(7) } : null
      const strAt = hasRect ? 8 : 4
      const dxAt = strAt + ((count + 1) >> 1)
      const dx =
        p.words >= dxAt + count ? Array.from({ length: count }, (_, k) => p.s(dxAt + k)) : null
      text(
        out,
        { x, y },
        p.bytes(strAt, count),
        dx,
        options & 2 ? rect : null,
        options & 4 ? rect : null,
      )
      return
    }
    case 0x0521: {
      const count = p.u(0)
      const at = 1 + ((count + 1) >> 1)
      text(out, { x: p.s(at + 1), y: p.s(at) }, p.bytes(1, count), null, null, null)
      return
    }
    case 0x0f43: {
      // STRETCHDIB：源矩形按 DIB 的行序计（自下而上的位图自底边起算）。
      const rop = p.u32(0)
      if (p.u(2) !== 0) {
        out.unsupported('STRETCHDIB:palColors')
        return
      }
      bitmap(out, p, rop, 11, {
        src: { h: p.s(3), w: p.s(4), y: p.s(5), x: p.s(6) },
        dest: { h: p.s(7), w: p.s(8), y: p.s(9), x: p.s(10) },
        fromBottom: true,
      })
      return
    }
    case 0x0b41:
    case 0x0940: {
      // DIBSTRETCHBLT、DIBBITBLT：记录长度等于固定参数个数时没有位图，按光栅操作填充。
      const stretch = fn === 0x0b41
      const rop = p.u32(0)
      const fixed = stretch ? 10 : 8
      if (p.words <= fixed + 1) {
        const fill = patFill(rop)
        const base = 3
        const h = stretch ? p.s(base + 4) : p.s(base + 2)
        const w = stretch ? p.s(base + 5) : p.s(base + 3)
        const y = stretch ? p.s(base + 6) : p.s(base + 4)
        const x = stretch ? p.s(base + 7) : p.s(base + 5)
        if (fill === null)
          out.unsupported(`${stretch ? 'DIBSTRETCHBLT' : 'DIBBITBLT'}:${rop.toString(16)}`)
        else out.op({ op: 'patBlt', box: { left: x, top: y, right: x + w, bottom: y + h }, fill })
        return
      }
      if (stretch)
        bitmap(out, p, rop, 10, {
          src: { h: p.s(2), w: p.s(3), y: p.s(4), x: p.s(5) },
          dest: { h: p.s(6), w: p.s(7), y: p.s(8), x: p.s(9) },
          fromBottom: false,
        })
      else
        bitmap(out, p, rop, 8, {
          src: { y: p.s(2), x: p.s(3), h: p.s(4), w: p.s(5) },
          dest: { h: p.s(4), w: p.s(5), y: p.s(6), x: p.s(7) },
          fromBottom: false,
        })
      return
    }
    case 0x02fa: {
      const pen = wmfPen(p.u(0), p.s(1), p.color(3))
      if (typeof pen === 'string') {
        out.unsupported(pen)
        create({ kind: 'other' })
      } else create({ kind: 'pen', pen })
      return
    }
    case 0x02fc: {
      const brush = wmfBrush(p.u(0), p.color(1))
      if (typeof brush === 'string') {
        out.unsupported(brush)
        create({ kind: 'other' })
      } else create({ kind: 'brush', brush })
      return
    }
    case 0x02fb: {
      const bytes = p.bytes(0, 18)
      const charset = bytes[13] ?? 0
      const font = fontObject(
        {
          height: p.s(0),
          weight: p.s(4),
          italic: (bytes[10] ?? 0) !== 0,
          face: faceName(p.bytes(9, 32), charset),
        },
        {
          width: p.s(1),
          escapement: p.s(2),
          orientation: p.s(3),
          underline: (bytes[11] ?? 0) !== 0,
          strikeOut: (bytes[12] ?? 0) !== 0,
          charset,
        },
      )
      create({ kind: 'font', font })
      return
    }
    case 0x0142:
    case 0x01f9:
    case 0x00f7:
    case 0x06ff:
      out.unsupported(
        fn === 0x00f7 ? 'CREATEPALETTE' : fn === 0x06ff ? 'CREATEREGION' : 'CREATEPATTERNBRUSH',
      )
      create({ kind: 'other' })
      return
    case 0x012d: {
      const o = objects[p.u(0)]
      if (o?.kind === 'pen') out.op({ op: 'pen', pen: o.pen })
      else if (o?.kind === 'brush') out.op({ op: 'brush', brush: o.brush })
      else if (o?.kind === 'font') out.selectFont(o.font)
      return
    }
    case 0x01f0: {
      const i = p.u(0)
      if (i < objects.length) objects[i] = null
      return
    }
    case 0x0234: // SELECTPALETTE：调色板只影响调色板设备。
      return
    default:
      out.unsupported(NAMES[fn] ?? `0x${fn.toString(16).padStart(4, '0')}`)
  }
}

function text(
  out: Builder,
  at: Point,
  bytes: Uint8Array,
  dx: readonly number[] | null,
  opaque: Box | null,
  clip: Box | null,
): void {
  if (bytes.length === 0) {
    out.text(at, '', null, opaque, clip)
    return
  }
  const f = out.textFont()
  if (f === null) return
  const decoded = decodeAnsi(bytes, f.charset, dx)
  if (typeof decoded === 'string') {
    out.unsupported(decoded)
    return
  }
  out.text(at, decoded.text, decoded.dx, opaque, clip)
}

interface Rect16 {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 带位图的光栅记录：`dib` 为位图头在参数中的起点（16 位参数的序号）。只支持 `SRCCOPY`。 */
function bitmap(
  out: Builder,
  p: Params,
  rop: number,
  dib: number,
  r: { readonly src: Rect16; readonly dest: Rect16; readonly fromBottom: boolean },
): void {
  if (rop !== SRCCOPY) {
    out.unsupported(`bitmap:rop${rop.toString(16)}`)
    return
  }
  const data = p.bytes(dib, p.end - p.start)
  if (data.length < 40) {
    out.unsupported('bitmap:format')
    return
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const headerSize = dv.getUint32(0, true)
  const bpp = headerSize === 12 ? dv.getUint16(10, true) : dv.getUint16(14, true)
  const used = headerSize === 12 ? 0 : dv.getUint32(32, true)
  const compression = headerSize === 12 ? 0 : dv.getUint32(16, true)
  const masks = compression === 3 && headerSize === 40 ? 3 : 0
  const colors = bpp <= 8 ? used || 2 ** bpp : masks + used
  const bmiSize = headerSize + colors * (headerSize === 12 ? 3 : 4)
  const index = out.bitmap(data.subarray(0, bmiSize), data.subarray(bmiSize), false)
  if (index === null) return
  const height = Math.abs(headerSize === 12 ? dv.getUint16(6, true) : dv.getInt32(8, true))
  const bottomUp = headerSize === 12 || dv.getInt32(8, true) > 0
  const sy = r.fromBottom && bottomUp ? height - r.src.y - r.src.h : r.src.y
  out.op({
    op: 'bitmap',
    dest: {
      left: r.dest.x,
      top: r.dest.y,
      right: r.dest.x + r.dest.w,
      bottom: r.dest.y + r.dest.h,
    },
    src: { x: r.src.x, y: sy, width: r.src.w, height: r.src.h },
    bitmap: index,
    alpha: 1,
  })
}
