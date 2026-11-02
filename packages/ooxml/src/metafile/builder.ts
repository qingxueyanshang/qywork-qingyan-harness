/**
 * WMF 与 EMF 读取共用的命令收集：记录绘制命令、解码位图，并追踪读取到某条记录时选入的字体、世界变换是否含旋转与路径状态，
 * 使文字记录在读取时即可判定是否可绘制（字体参数、字符集、方向）。
 *
 * - 选入的字体与旋转状态随 `SaveDC`、`RestoreDC` 入栈出栈，规则与设备上下文相同（`restore` 的参数含义见 `MetaOp`）。
 * - 未选入字体或选入库存字体时绘制文字计为不支持：库存字体的字形由系统决定。旋转或倾斜的文字、路径中的文字同样计为不支持。
 */

import { decodeDib, type Pixels } from './dib.ts'
import type { Box, Font, Metafile, MetaOp, PixelRect, Point } from './model.ts'

/** 字体对象：`issue` 为第一个未实现的参数取值，只在用它绘制文字时计入不支持。 */
export interface FontObject {
  readonly font: Font
  readonly charset: number
  readonly issue: string | null
}

type Selected = FontObject | 'stock' | null

interface Tracked {
  readonly font: Selected
  readonly rotated: boolean
}

/** LOGFONT 的参数：宽度、角度、下划线、删除线未实现。 */
export function fontObject(
  font: Font,
  p: {
    readonly width: number
    readonly escapement: number
    readonly orientation: number
    readonly underline: boolean
    readonly strikeOut: boolean
    readonly charset: number
  },
): FontObject {
  const issue =
    p.width !== 0
      ? 'font:width'
      : p.escapement !== 0 || p.orientation !== 0
        ? 'font:escapement'
        : p.underline
          ? 'font:underline'
          : p.strikeOut
            ? 'font:strikeOut'
            : font.height === 0
              ? 'font:defaultHeight'
              : null
  return { font, charset: p.charset, issue }
}

/** 单字节与双字节字符集到 `TextDecoder` 编码名；`null` 为未实现的字符集。 */
const CHARSETS: Readonly<Record<number, string>> = {
  0: 'windows-1252',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
}

/**
 * 按编码名构造解码器：Bun 的类型声明只列出三种编码，运行时（Bun 与浏览器）支持编码标准中的全部编码。
 */
function legacyDecoder(name: string): TextDecoder {
  return new TextDecoder(name as 'utf-8')
}

/** 双字节字符集的前导字节。 */
function leadByte(charset: number, b: number): boolean {
  if (charset === 128) return (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)
  if (charset === 129 || charset === 134 || charset === 136) return b >= 0x81 && b <= 0xfe
  return false
}

/**
 * 按字体的字符集解码 8 位字符串。`dx` 为逐字节的前进宽度时，双字节字符取两字节之和。
 * `DEFAULT_CHARSET` 与 `OEM_CHARSET` 依赖系统代码页：只接受 ASCII 字节。
 */
export function decodeAnsi(
  bytes: Uint8Array,
  charset: number,
  dx: readonly number[] | null,
): { text: string; dx: number[] | null } | string {
  const ascii = bytes.every((b) => b < 0x80)
  const name =
    CHARSETS[charset] ?? (ascii && (charset === 1 || charset === 255) ? 'windows-1252' : null)
  if (name === null) return `text:charset${charset}`
  const decoder = legacyDecoder(name)
  let text = ''
  const out: number[] = []
  for (let i = 0; i < bytes.length; ) {
    const n = leadByte(charset, bytes[i]!) && i + 1 < bytes.length ? 2 : 1
    text += decoder.decode(bytes.subarray(i, i + n))
    if (dx !== null) out.push((dx[i] ?? 0) + (n === 2 ? (dx[i + 1] ?? 0) : 0))
    i += n
  }
  return { text, dx: dx === null ? null : out }
}

export class Builder {
  readonly ops: MetaOp[] = []
  private readonly bitmaps: Pixels[] = []
  private readonly fontNames = new Set<string>()
  private readonly missing = new Set<string>()
  private font: Selected = null
  /** 世界变换含旋转或倾斜。 */
  private rotated = false
  private readonly saved: Tracked[] = []
  private inPath = false

  unsupported(name: string): void {
    this.missing.add(name)
  }

  get supported(): boolean {
    return this.missing.size === 0
  }

  op(o: MetaOp): void {
    if (o.op === 'bitmap' && !this.inside(o.bitmap, o.src)) {
      this.unsupported('bitmap:sourceRect')
      return
    }
    this.ops.push(o)
    switch (o.op) {
      case 'save':
        this.saved.push({ font: this.font, rotated: this.rotated })
        return
      case 'restore': {
        const depth = o.index < 0 ? this.saved.length + o.index : o.index - 1
        if (depth < 0 || depth >= this.saved.length) return
        const t = this.saved[depth]!
        this.font = t.font
        this.rotated = t.rotated
        this.saved.length = depth
        return
      }
      case 'world': {
        const turned = o.matrix.b !== 0 || o.matrix.c !== 0
        this.rotated =
          o.mode === 'identity' ? false : o.mode === 'set' ? turned : this.rotated || turned
        return
      }
      case 'beginPath':
        this.inPath = true
        return
      case 'endPath':
      case 'abortPath':
        this.inPath = false
        return
      default:
        return
    }
  }

  selectFont(f: FontObject | 'stock'): void {
    this.font = f
    if (f !== 'stock') this.op({ op: 'font', font: f.font })
  }

  /** 当前字体可用于绘制文字时返回它，否则记录原因并返回 `null`。 */
  textFont(): FontObject | null {
    const f = this.font
    if (f === null || f === 'stock') {
      this.unsupported('text:stockFont')
      return null
    }
    if (f.issue !== null) {
      this.unsupported(f.issue)
      return null
    }
    if (this.inPath) {
      this.unsupported('text:path')
      return null
    }
    if (this.rotated) {
      this.unsupported('text:rotated')
      return null
    }
    return f
  }

  /** 文字记录；没有字符时只填充 `opaque`，不需要字体。 */
  text(p: Point, text: string, dx: readonly number[] | null, opaque: Box | null, clip: Box | null) {
    if (text !== '') {
      const f = this.textFont()
      if (f === null) return
      if (text.trim() !== '') this.fontNames.add(f.font.face)
    }
    this.op({ op: 'text', p, text, dx, opaque, clip })
  }

  /** 源矩形在位图之内且宽高为正。 */
  private inside(index: number, r: PixelRect): boolean {
    const px = this.bitmaps[index]
    return (
      px !== undefined &&
      r.width > 0 &&
      r.height > 0 &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.x + r.width <= px.width &&
      r.y + r.height <= px.height
    )
  }

  /** 解码位图并登记，返回下标；格式不支持时记录原因并返回 `null`。 */
  bitmap(bmi: Uint8Array, bits: Uint8Array, alpha: boolean): number | null {
    const pixels = decodeDib(bmi, bits, alpha)
    if (pixels === null) {
      this.unsupported('bitmap:format')
      return null
    }
    this.bitmaps.push(pixels)
    return this.bitmaps.length - 1
  }

  finish(
    kind: Metafile['kind'],
    frame: Box,
    device: Point | null,
    size: Metafile['size'],
  ): Metafile {
    return {
      kind,
      frame,
      device,
      size,
      ops: this.ops,
      bitmaps: this.bitmaps,
      fonts: [...this.fontNames],
      unsupported: [...this.missing],
    }
  }
}
