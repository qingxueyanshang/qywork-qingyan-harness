/**
 * EMF 读取：文件头给出图片框（`rclFrame`，0.01 毫米）与参考设备的像素数和毫米数，图片框换算到参考设备像素。
 *
 * - 对象按记录中的编号存取；`0x80000000` 起为库存对象（库存画刷与画笔按系统定义取值，库存字体计为不支持的字体）。
 * - 注释记录不影响绘制。EMF+ 记录位于注释中：文件头声明双格式（EMF+ Dual）时按其中的 EMF 记录绘制，
 *   只有 EMF+ 记录时计为不支持。
 * - 坐标为 32 位整数；名称以 16 结尾的记录为 16 位坐标。
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
import { wmfBrush } from './wmf.ts'

const EMF_SIGNATURE = 0x464d4520
const EMF_PLUS = 0x2b464d45

type EmfObject =
  | { readonly kind: 'pen'; readonly pen: Pen }
  | { readonly kind: 'brush'; readonly brush: Brush }
  | { readonly kind: 'font'; readonly font: FontObject }

const NAMES: Readonly<Record<number, string>> = {
  15: 'SETPIXELV',
  23: 'SETCOLORADJUSTMENT',
  26: 'OFFSETCLIPRGN',
  28: 'SETMETARGN',
  31: 'SCALEVIEWPORTEXTEX',
  32: 'SCALEWINDOWEXTEX',
  41: 'ANGLEARC',
  44: 'ROUNDRECT',
  45: 'ARC',
  46: 'CHORD',
  47: 'PIE',
  49: 'CREATEPALETTE',
  50: 'SETPALETTEENTRIES',
  51: 'RESIZEPALETTE',
  53: 'EXTFLOODFILL',
  55: 'ARCTO',
  56: 'POLYDRAW',
  66: 'WIDENPATH',
  71: 'FILLRGN',
  72: 'FRAMERGN',
  73: 'INVERTRGN',
  74: 'PAINTRGN',
  78: 'MASKBLT',
  79: 'PLGBLT',
  80: 'SETDIBITSTODEVICE',
  92: 'POLYDRAW16',
  93: 'CREATEMONOBRUSH',
  94: 'CREATEDIBPATTERNBRUSHPT',
  96: 'POLYTEXTOUTA',
  97: 'POLYTEXTOUTW',
  99: 'CREATECOLORSPACE',
  100: 'SETCOLORSPACE',
  101: 'DELETECOLORSPACE',
  102: 'GLSRECORD',
  103: 'GLSBOUNDEDRECORD',
  104: 'PIXELFORMAT',
  105: 'DRAWESCAPE',
  106: 'EXTESCAPE',
  108: 'SMALLTEXTOUT',
  109: 'FORCEUFIMAPPING',
  110: 'NAMEDESCAPE',
  111: 'COLORCORRECTPALETTE',
  112: 'SETICMPROFILEA',
  113: 'SETICMPROFILEW',
  116: 'TRANSPARENTBLT',
  118: 'GRADIENTFILL',
  119: 'SETLINKEDUFIS',
  121: 'COLORMATCHTOTARGETW',
  122: 'CREATECOLORSPACEW',
}

/** 库存画刷、画笔（`GetStockObject` 的编号）。 */
const STOCK_BRUSHES: Readonly<Record<number, Brush>> = {
  0: { kind: 'solid', color: { r: 255, g: 255, b: 255 } },
  1: { kind: 'solid', color: { r: 192, g: 192, b: 192 } },
  2: { kind: 'solid', color: { r: 128, g: 128, b: 128 } },
  3: { kind: 'solid', color: { r: 64, g: 64, b: 64 } },
  4: { kind: 'solid', color: { r: 0, g: 0, b: 0 } },
  5: { kind: 'null' },
}

function stockPen(color: Rgb, style: Pen['style']): Pen {
  return { style, width: 0, cosmetic: true, color, cap: 'round', join: 'round' }
}

const STOCK_PENS: Readonly<Record<number, Pen>> = {
  6: stockPen({ r: 255, g: 255, b: 255 }, 'solid'),
  7: stockPen({ r: 0, g: 0, b: 0 }, 'solid'),
  8: stockPen({ r: 0, g: 0, b: 0 }, 'null'),
}

/** 库存字体的编号。 */
const STOCK_FONTS = new Set([10, 11, 12, 13, 14, 16, 17])

const SRCCOPY = 0x00cc0020
/** 目标不变（`D`）：不绘制。 */
const DSTCOPY = 0x00aa0029
const PATCOPY = 0x00f00021
const BLACKNESS = 0x00000042
const WHITENESS = 0x00ff0062

class Rec {
  readonly v: DataView
  constructor(
    readonly b: Uint8Array,
    readonly at: number,
    readonly size: number,
  ) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  /** 记录内偏移 `o` 处的值；越界时为 0。 */
  i32(o: number): number {
    return o + 4 <= this.size ? this.v.getInt32(this.at + o, true) : 0
  }
  u32(o: number): number {
    return o + 4 <= this.size ? this.v.getUint32(this.at + o, true) : 0
  }
  i16(o: number): number {
    return o + 2 <= this.size ? this.v.getInt16(this.at + o, true) : 0
  }
  f32(o: number): number {
    return o + 4 <= this.size ? this.v.getFloat32(this.at + o, true) : 0
  }
  bytes(o: number, n: number): Uint8Array {
    const start = Math.min(this.size, Math.max(0, o))
    return this.b.subarray(this.at + start, this.at + Math.min(this.size, start + n))
  }
  color(o: number): Rgb {
    const c = this.u32(o)
    return { r: c & 0xff, g: (c >> 8) & 0xff, b: (c >> 16) & 0xff }
  }
  box(o: number): Box {
    return {
      left: this.i32(o),
      top: this.i32(o + 4),
      right: this.i32(o + 8),
      bottom: this.i32(o + 12),
    }
  }
  point(o: number): Point {
    return { x: this.i32(o), y: this.i32(o + 4) }
  }
  points(o: number, n: number, small: boolean): Point[] {
    const out: Point[] = []
    const step = small ? 4 : 8
    for (let k = 0; k < n; k++) {
      const p = o + k * step
      out.push(small ? { x: this.i16(p), y: this.i16(p + 2) } : this.point(p))
    }
    return out
  }
  matrix(o: number) {
    return {
      a: this.f32(o),
      b: this.f32(o + 4),
      c: this.f32(o + 8),
      d: this.f32(o + 12),
      e: this.f32(o + 16),
      f: this.f32(o + 20),
    }
  }
}

export function isEmf(b: Uint8Array): boolean {
  if (b.length < 88) return false
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return v.getUint32(0, true) === 1 && v.getUint32(40, true) === EMF_SIGNATURE
}

export function readEmf(b: Uint8Array): Metafile {
  const out = new Builder()
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const frame100 = {
    left: v.getInt32(24, true),
    top: v.getInt32(28, true),
    right: v.getInt32(32, true),
    bottom: v.getInt32(36, true),
  }
  const devicePx = { x: v.getInt32(72, true), y: v.getInt32(76, true) }
  const deviceMm = { x: v.getInt32(80, true), y: v.getInt32(84, true) }
  const empty: Box = { left: 0, top: 0, right: 0, bottom: 0 }
  if (devicePx.x <= 0 || devicePx.y <= 0 || deviceMm.x <= 0 || deviceMm.y <= 0) {
    out.unsupported('header')
    return out.finish('emf', empty, null, NO_SIZE)
  }
  const device = { x: devicePx.x / deviceMm.x, y: devicePx.y / deviceMm.y }
  const frame: Box = {
    left: (frame100.left * device.x) / 100,
    top: (frame100.top * device.y) / 100,
    right: (frame100.right * device.x) / 100,
    bottom: (frame100.bottom * device.y) / 100,
  }
  if (frame.right === frame.left || frame.bottom === frame.top) {
    out.unsupported('header')
    return out.finish('emf', frame, device, NO_SIZE)
  }
  const objects = new Map<number, EmfObject>()
  let off = v.getUint32(4, true)
  let ended = false
  while (off + 8 <= b.length) {
    const type = v.getUint32(off, true)
    const size = v.getUint32(off + 4, true)
    if (size < 8 || off + size > b.length || size % 4 !== 0) break
    const r = new Rec(b, off, size)
    off += size
    if (type === 14) {
      ended = true
      break
    }
    record(type, r, out, objects)
  }
  if (!ended) out.unsupported('truncated')
  const size = {
    width: (Math.abs(frame100.right - frame100.left) * 96) / 2540,
    height: (Math.abs(frame100.bottom - frame100.top) * 96) / 2540,
  }
  return out.finish('emf', frame, device, size)
}

/** `EXTCREATEPEN` 的画笔：只支持实线与空画笔、实色画刷。 */
function extPen(r: Rec): Pen | string {
  const style = r.u32(28)
  const width = r.u32(32)
  const brushStyle = r.u32(36)
  const kind = style & 0x0f
  if (kind !== 0 && kind !== 5) return `pen:style${kind}`
  if (brushStyle !== 0 && kind !== 5) return `pen:brush${brushStyle}`
  const geometric = (style & 0x00010000) !== 0
  const cap = style & 0x0f00
  const join = style & 0xf000
  return {
    style: kind === 5 ? 'null' : 'solid',
    width: geometric ? width : 0,
    cosmetic: !geometric || width === 0,
    color: r.color(40),
    cap: cap === 0x0100 ? 'square' : cap === 0x0200 ? 'butt' : 'round',
    join: join === 0x1000 ? 'bevel' : join === 0x2000 ? 'miter' : 'round',
  }
}

function logPen(r: Rec): Pen | string {
  const style = r.u32(12)
  const kind = style & 0x0f
  if (kind !== 0 && kind !== 5) return `pen:style${kind}`
  const width = r.i32(16)
  return {
    style: kind === 5 ? 'null' : 'solid',
    width: Math.abs(width),
    cosmetic: width === 0,
    color: r.color(24),
    cap: 'round',
    join: 'round',
  }
}

/** `LOGFONTW` 位于记录偏移 12 处。 */
function logFont(r: Rec): FontObject {
  const bytes = r.bytes(12, 28)
  const name = r.bytes(40, 64)
  let face = ''
  for (let k = 0; k + 1 < name.length; k += 2) {
    const c = name[k]! | (name[k + 1]! << 8)
    if (c === 0) break
    face += String.fromCharCode(c)
  }
  return fontObject(
    { height: r.i32(12), weight: r.i32(28), italic: bytes[20] !== 0, face },
    {
      width: r.i32(16),
      escapement: r.i32(20),
      orientation: r.i32(24),
      underline: bytes[21] !== 0,
      strikeOut: bytes[22] !== 0,
      charset: bytes[23] ?? 0,
    },
  )
}

/** EMF+ 注释中的记录：遇到文件头时返回是否为双格式。 */
function plusDual(r: Rec): boolean | null {
  const end = 12 + r.u32(8)
  let p = 16
  while (p + 12 <= Math.min(end, r.size)) {
    const type = r.u32(p) & 0xffff
    const flags = r.u32(p) >>> 16
    const size = r.u32(p + 4)
    if (type === 0x4001) return (flags & 1) !== 0
    if (size < 12) return null
    p += size
  }
  return null
}

function record(type: number, r: Rec, out: Builder, objects: Map<number, EmfObject>): void {
  switch (type) {
    case 70: {
      if (r.size >= 16 && r.u32(12) === EMF_PLUS && plusDual(r) === false) out.unsupported('EMF+')
      return
    }
    case 9:
    case 10:
    case 11:
    case 12: {
      const op = (['windowExt', 'windowOrg', 'viewportExt', 'viewportOrg'] as const)[type - 9]!
      const p = r.point(8)
      out.op({ op, x: p.x, y: p.y })
      return
    }
    case 17: {
      const mode = r.u32(8)
      if (mode >= 1 && mode <= 8) out.op({ op: 'mapMode', mode })
      else out.unsupported(`SETMAPMODE:${mode}`)
      return
    }
    case 13: // SETBRUSHORGEX：只影响图案画刷（未实现）。
    case 16: // SETMAPPERFLAGS：只影响字体匹配的纵横比。
    case 57: // SETARCDIRECTION：只影响弧线（未实现）。
    case 65: // FLATTENPATH：曲线按原样绘制。
    case 98: // SETICMMODE：颜色管理不影响屏幕显示。
    case 21: // SETSTRETCHBLTMODE：位图一律平滑缩放（见 `play.ts`）。
      return
    case 115:
      if (r.u32(8) !== 0) out.unsupported('SETLAYOUT')
      return
    case 18:
      out.op({ op: 'bkMode', opaque: r.u32(8) === 2 })
      return
    case 19:
      out.op({ op: 'fillMode', evenOdd: r.u32(8) !== 2 })
      return
    case 20:
      if (r.u32(8) !== 13) out.unsupported(`SETROP2:${r.u32(8)}`)
      return
    case 22: {
      const align = r.u32(8)
      if (align & 0x0101) out.unsupported('SETTEXTALIGN:updateCp')
      else out.op({ op: 'textAlign', align })
      return
    }
    case 24:
    case 25:
      out.op({ op: type === 24 ? 'textColor' : 'bkColor', color: r.color(8) })
      return
    case 27:
    case 54:
      out.op({ op: type === 27 ? 'moveTo' : 'lineTo', p: r.point(8) })
      return
    case 58:
      out.op({ op: 'miterLimit', limit: r.u32(8) })
      return
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 85:
    case 86:
    case 87:
    case 88:
    case 89: {
      const small = type >= 85
      const kind = (['bezier', 'polygon', 'polyline', 'bezierTo', 'polylineTo'] as const)[
        small ? type - 85 : type - 2
      ]!
      out.op({ op: kind, points: r.points(28, r.u32(24), small) })
      return
    }
    case 7:
    case 8:
    case 90:
    case 91: {
      const small = type >= 90
      const n = r.u32(24)
      const polys: Point[][] = []
      let at = 32 + n * 4
      for (let k = 0; k < n; k++) {
        const count = r.u32(32 + k * 4)
        polys.push(r.points(at, count, small))
        at += count * (small ? 4 : 8)
      }
      const closed = type === 8 || type === 91
      out.op({ op: closed ? 'polyPolygon' : 'polyPolyline', polys })
      return
    }
    case 42:
    case 43:
      out.op({ op: type === 43 ? 'rectangle' : 'ellipse', box: r.box(8), shrink: false })
      return
    case 59:
    case 60:
    case 61:
    case 68: {
      const map = { 59: 'beginPath', 60: 'endPath', 61: 'closeFigure', 68: 'abortPath' } as const
      out.op({ op: map[type] })
      return
    }
    case 62:
    case 63:
    case 64: {
      const map = { 62: 'fillPath', 63: 'strokeFillPath', 64: 'strokePath' } as const
      out.op({ op: map[type] })
      return
    }
    case 67: {
      const mode = r.u32(8)
      if (mode === 5 || mode === 1) out.op({ op: 'clipPath', mode: mode === 5 ? 'copy' : 'and' })
      else out.unsupported(`SELECTCLIPPATH:${mode}`)
      return
    }
    case 29:
    case 30:
      out.op({ op: 'clipRect', box: r.box(8), exclude: type === 29 })
      return
    case 75: {
      const dataSize = r.u32(8)
      const mode = r.u32(12)
      if (mode !== 5 && mode !== 1) {
        out.unsupported(`EXTSELECTCLIPRGN:${mode}`)
        return
      }
      if (dataSize === 0) {
        if (mode === 5) out.op({ op: 'clipRegion', rects: null, mode: 'copy' })
        else out.unsupported('EXTSELECTCLIPRGN:empty')
        return
      }
      const count = r.u32(16 + 8)
      const rects: Box[] = []
      for (let k = 0; k < count; k++) rects.push(r.box(16 + 32 + k * 16))
      out.op({ op: 'clipRegion', rects, mode: mode === 5 ? 'copy' : 'and' })
      return
    }
    case 33:
      out.op({ op: 'save' })
      return
    case 34:
      out.op({ op: 'restore', index: r.i32(8) })
      return
    case 35:
      out.op({ op: 'world', mode: 'set', matrix: r.matrix(8) })
      return
    case 36: {
      const mode = r.u32(32)
      const map = { 1: 'identity', 2: 'left', 3: 'right', 4: 'set' } as const
      const m = map[mode as 1 | 2 | 3 | 4]
      if (m === undefined) out.unsupported(`MODIFYWORLDTRANSFORM:${mode}`)
      else out.op({ op: 'world', mode: m, matrix: r.matrix(8) })
      return
    }
    case 38:
    case 95: {
      const pen = type === 38 ? logPen(r) : extPen(r)
      if (typeof pen === 'string') {
        out.unsupported(pen)
        objects.delete(r.u32(8))
      } else objects.set(r.u32(8), { kind: 'pen', pen })
      return
    }
    case 39: {
      const brush = wmfBrush(r.u32(12), r.color(16))
      if (typeof brush === 'string') {
        out.unsupported(brush)
        objects.delete(r.u32(8))
      } else objects.set(r.u32(8), { kind: 'brush', brush })
      return
    }
    case 82:
      objects.set(r.u32(8), { kind: 'font', font: logFont(r) })
      return
    case 37: {
      const index = r.u32(8)
      if (index & 0x80000000) {
        const stock = index & 0x7fffffff
        const brush = STOCK_BRUSHES[stock]
        const pen = STOCK_PENS[stock]
        if (brush !== undefined) out.op({ op: 'brush', brush })
        else if (pen !== undefined) out.op({ op: 'pen', pen })
        else if (STOCK_FONTS.has(stock)) out.selectFont('stock')
        else if (stock !== 15) out.unsupported(`stock:${stock}`)
        return
      }
      const o = objects.get(index)
      if (o?.kind === 'pen') out.op({ op: 'pen', pen: o.pen })
      else if (o?.kind === 'brush') out.op({ op: 'brush', brush: o.brush })
      else if (o?.kind === 'font') out.selectFont(o.font)
      return
    }
    case 40:
      objects.delete(r.u32(8))
      return
    case 48: // SELECTPALETTE：库存调色板之外的调色板在创建时已计为不支持。
    case 52: // REALIZEPALETTE
      return
    case 76:
    case 77: {
      const stretch = type === 77
      const dest = { x: r.i32(24), y: r.i32(28), w: r.i32(32), h: r.i32(36) }
      const rop = r.u32(40)
      if (rop === DSTCOPY) return
      const box = { left: dest.x, top: dest.y, right: dest.x + dest.w, bottom: dest.y + dest.h }
      if (r.u32(88) === 0) {
        const fill =
          rop === PATCOPY
            ? 'brush'
            : rop === BLACKNESS
              ? 'black'
              : rop === WHITENESS
                ? 'white'
                : null
        if (fill === null) out.unsupported(`BITBLT:${rop.toString(16)}`)
        else out.op({ op: 'patBlt', box, fill })
        return
      }
      const m = r.matrix(52)
      if (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) {
        out.unsupported('BITBLT:sourceTransform')
        return
      }
      const src = {
        x: r.i32(44) + m.e,
        y: r.i32(48) + m.f,
        width: stretch ? r.i32(100) : dest.w,
        height: stretch ? r.i32(104) : dest.h,
      }
      blit(out, r, { rop, usage: r.u32(80), bmi: 84, alpha: false }, box, src, 1)
      return
    }
    case 81: {
      const dest = { x: r.i32(24), y: r.i32(28), w: r.i32(72), h: r.i32(76) }
      const box = { left: dest.x, top: dest.y, right: dest.x + dest.w, bottom: dest.y + dest.h }
      const src = { x: r.i32(32), y: r.i32(36), width: r.i32(40), height: r.i32(44) }
      blit(
        out,
        r,
        { rop: r.u32(68), usage: r.u32(64), bmi: 48, alpha: false, fromBottom: true },
        box,
        src,
        1,
      )
      return
    }
    case 114: {
      const dest = { x: r.i32(24), y: r.i32(28), w: r.i32(32), h: r.i32(36) }
      const blend = r.u32(40)
      const op = blend & 0xff
      const format = blend >>> 24
      if (op !== 0 || (format !== 0 && format !== 1)) {
        out.unsupported('ALPHABLEND:function')
        return
      }
      const m = r.matrix(52)
      if (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) {
        out.unsupported('ALPHABLEND:sourceTransform')
        return
      }
      const box = { left: dest.x, top: dest.y, right: dest.x + dest.w, bottom: dest.y + dest.h }
      const src = { x: r.i32(44) + m.e, y: r.i32(48) + m.f, width: r.i32(100), height: r.i32(104) }
      blit(
        out,
        r,
        { rop: SRCCOPY, usage: r.u32(80), bmi: 84, alpha: format === 1 },
        box,
        src,
        ((blend >>> 16) & 0xff) / 255,
      )
      return
    }
    case 83:
    case 84: {
      // EMRTEXT 位于偏移 36：参考点、字符数、字符串偏移、选项、矩形、前进宽度偏移。
      const options = r.u32(52)
      if (options & ~0x0006) {
        out.unsupported(`EXTTEXTOUT:options${options.toString(16)}`)
        return
      }
      const p = r.point(36)
      const n = r.u32(44)
      const strAt = r.u32(48)
      const rect = r.box(56)
      const dxAt = r.u32(72)
      const dx = dxAt === 0 ? null : Array.from({ length: n }, (_, k) => r.i32(dxAt + k * 4))
      const opaque = options & 2 ? rect : null
      const clip = options & 4 ? rect : null
      if (type === 84) {
        const raw = r.bytes(strAt, n * 2)
        let s = ''
        for (let k = 0; k + 1 < raw.length; k += 2)
          s += String.fromCharCode(raw[k]! | (raw[k + 1]! << 8))
        out.text(p, s, dx, opaque, clip)
        return
      }
      if (n === 0) {
        out.text(p, '', null, opaque, clip)
        return
      }
      const f = out.textFont()
      if (f === null) return
      const decoded = decodeAnsi(r.bytes(strAt, n), f.charset, dx)
      if (typeof decoded === 'string') out.unsupported(decoded)
      else out.text(p, decoded.text, decoded.dx, opaque, clip)
      return
    }
    case 120:
      if (r.i32(8) !== 0) out.unsupported('SETTEXTJUSTIFICATION')
      return
    default:
      out.unsupported(NAMES[type] ?? `EMR:${type}`)
  }
}

/**
 * 带位图的光栅记录：`bmi` 为 `offBmiSrc` 字段在记录中的偏移（其后依次为 `cbBmiSrc`、`offBitsSrc`、`cbBitsSrc`）。
 * `fromBottom` 为真时源矩形按 DIB 的行序计（自下而上的位图自底边起算）。
 */
function blit(
  out: Builder,
  r: Rec,
  f: {
    readonly rop: number
    readonly usage: number
    readonly bmi: number
    readonly alpha: boolean
    readonly fromBottom?: boolean
  },
  dest: Box,
  src: { x: number; y: number; width: number; height: number },
  alpha: number,
): void {
  if (f.rop !== SRCCOPY) {
    out.unsupported(`bitmap:rop${f.rop.toString(16)}`)
    return
  }
  if (f.usage !== 0) {
    out.unsupported('bitmap:palColors')
    return
  }
  const bmi = r.bytes(r.u32(f.bmi), r.u32(f.bmi + 4))
  const bits = r.bytes(r.u32(f.bmi + 8), r.u32(f.bmi + 12))
  const index = out.bitmap(bmi, bits, f.alpha)
  if (index === null) return
  const dv = new DataView(bmi.buffer, bmi.byteOffset, bmi.byteLength)
  const headerSize = dv.getUint32(0, true)
  const h = headerSize === 12 ? dv.getUint16(6, true) : dv.getInt32(8, true)
  const sy = f.fromBottom && h > 0 ? Math.abs(h) - src.y - src.height : src.y
  out.op({ op: 'bitmap', dest, src: { ...src, y: sy }, bitmap: index, alpha })
}
