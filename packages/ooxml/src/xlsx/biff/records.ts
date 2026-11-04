/**
 * BIFF8 记录与字符串的读取。
 *
 * - 记录为 2 字节类型、2 字节长度与数据，长度不超过 8224；超出流末尾的最后一条记录不计入（截断的流按其完整部分读取）。
 * - 字符串的字符按标志位第 0 位为 UTF-16LE（1）或每字符一个字节（0，即码位 0–255 的高字节省略）。
 * - 越界读取返回 0 或空串，不抛出：字段缺失按缺省值处理，由调用方按记录长度判断是否可用。
 */

export interface BiffRecord {
  readonly id: number
  readonly data: Uint8Array
  /** 记录头在流中的偏移。 */
  readonly offset: number
}

export const RT = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  BOUNDSHEET: 0x0085,
  WINDOW1: 0x003d,
  DATEMODE: 0x0022,
  FONT: 0x0031,
  FORMAT: 0x041e,
  XF: 0x00e0,
  XFEXT: 0x087d,
  STYLE: 0x0293,
  PALETTE: 0x0092,
  SST: 0x00fc,
  THEME: 0x0896,
  MSODRAWINGGROUP: 0x00eb,
  MSODRAWING: 0x00ec,
  OBJ: 0x005d,
  NOTE: 0x001c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  ROW: 0x0208,
  COLINFO: 0x007d,
  DEFCOLWIDTH: 0x0055,
  STANDARDWIDTH: 0x0099,
  DEFAULTROWHEIGHT: 0x0225,
  MERGECELLS: 0x00e5,
  WINDOW2: 0x023e,
  PANE: 0x0041,
  SCL: 0x00a0,
  WSBOOL: 0x0081,
  CONDFMT: 0x01b0,
  CF: 0x01b1,
  CF12: 0x087a,
  SUPBOOK: 0x01ae,
  EXTERNSHEET: 0x0017,
} as const

export function readRecords(stream: Uint8Array): BiffRecord[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const out: BiffRecord[] = []
  for (let p = 0; p + 4 <= stream.length; ) {
    const size = view.getUint16(p + 2, true)
    if (p + 4 + size > stream.length) break
    out.push({ id: view.getUint16(p, true), data: stream.subarray(p + 4, p + 4 + size), offset: p })
    p += 4 + size
  }
  return out
}

export class Bytes {
  private readonly view: DataView
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  get length(): number {
    return this.data.length
  }
  u8(p: number): number {
    return p + 1 <= this.data.length ? this.view.getUint8(p) : 0
  }
  u16(p: number): number {
    return p + 2 <= this.data.length ? this.view.getUint16(p, true) : 0
  }
  i16(p: number): number {
    return p + 2 <= this.data.length ? this.view.getInt16(p, true) : 0
  }
  u32(p: number): number {
    return p + 4 <= this.data.length ? this.view.getUint32(p, true) : 0
  }
  i32(p: number): number {
    return p + 4 <= this.data.length ? this.view.getInt32(p, true) : 0
  }
  f64(p: number): number {
    return p + 8 <= this.data.length ? this.view.getFloat64(p, true) : 0
  }
}

/** 自 `p` 起读取 `count` 个字符；`wide` 为真时每字符 2 字节。返回文字与结束位置。 */
export function readChars(
  b: Bytes,
  p: number,
  count: number,
  wide: boolean,
): { text: string; end: number } {
  const end = Math.min(p + count * (wide ? 2 : 1), b.length)
  let text = ''
  if (wide) for (let q = p; q + 2 <= end; q += 2) text += String.fromCharCode(b.u16(q))
  else for (let q = p; q < end; q++) text += String.fromCharCode(b.u8(q))
  return { text, end }
}

/** 1 字节长度的字符串（ShortXLUnicodeString）。 */
export function shortString(b: Bytes, p: number): { text: string; end: number } {
  return readChars(b, p + 2, b.u8(p), (b.u8(p + 1) & 1) === 1)
}

/** 2 字节长度的字符串（XLUnicodeString）。 */
export function unicodeString(b: Bytes, p: number): { text: string; end: number } {
  return readChars(b, p + 3, b.u16(p), (b.u8(p + 2) & 1) === 1)
}

/**
 * 记录与其后连续的 CONTINUE 记录：`parts[0]` 为记录本身的数据。字符串跨记录时，后一段的开头另有一个字节的
 * 字符宽度标志（见 `globals.ts` 中 SST 的读取），因此各段不能简单拼接。
 */
export function withContinues(
  list: readonly BiffRecord[],
  index: number,
): { parts: Uint8Array[]; next: number } {
  const parts = [list[index]!.data]
  let i = index + 1
  while (list[i]?.id === RT.CONTINUE) parts.push(list[i++]!.data)
  return { parts, next: i }
}
