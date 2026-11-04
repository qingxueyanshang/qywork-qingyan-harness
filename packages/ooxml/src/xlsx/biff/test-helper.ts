/**
 * 测试夹具：按记录生成 .xls（CFB 中的 BIFF8 `Workbook` 流）。
 *
 * - `buildXls` 写出全局子流（BOF、给定的全局记录、BOUNDSHEET、EOF）与各工作表子流，BOUNDSHEET 的子流位置按布局回填。
 * - 字体、XF 等记录体由 `font`、`xf` 等函数按字段生成；未给出的字段取缺省值。
 * - `encrypt` 按缺省密码以 RC4 加密已生成的流，供解密测试使用。
 */

import { buildCfb } from '../../zip/test-helper.ts'
import { md5, rc4 } from './crypto.ts'

export function rec(id: number, body: Uint8Array | number[] = []): Uint8Array {
  const data = body instanceof Uint8Array ? body : Uint8Array.from(body)
  const out = new Uint8Array(4 + data.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, id, true)
  view.setUint16(2, data.length, true)
  out.set(data, 4)
  return out
}

/** 按 `[字节数, 值]` 依次写出小端整数；字节数 8 为双精度数。 */
export function fields(...items: [1 | 2 | 4 | 8, number][]): Uint8Array {
  const out = new Uint8Array(items.reduce((n, [size]) => n + size, 0))
  const view = new DataView(out.buffer)
  let p = 0
  for (const [size, value] of items) {
    if (size === 1) view.setUint8(p, value)
    else if (size === 2) view.setUint16(p, value, true)
    else if (size === 4) view.setUint32(p, value >>> 0, true)
    else view.setFloat64(p, value, true)
    p += size
  }
  return out
}

export function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** 字符串的字符部分：码位都不超过 255 时按单字节写出（标志 0），否则按 UTF-16LE（标志 1）。 */
export function chars(
  text: string,
  wide = [...text].some((c) => c.charCodeAt(0) > 255),
): Uint8Array {
  const out = new Uint8Array(text.length * (wide ? 2 : 1))
  const view = new DataView(out.buffer)
  for (let i = 0; i < text.length; i++) {
    if (wide) view.setUint16(i * 2, text.charCodeAt(i), true)
    else out[i] = text.charCodeAt(i)
  }
  return out
}

export function shortString(text: string): Uint8Array {
  const wide = [...text].some((c) => c.charCodeAt(0) > 255)
  return join(fields([1, text.length], [1, wide ? 1 : 0]), chars(text, wide))
}

export function unicodeString(text: string): Uint8Array {
  const wide = [...text].some((c) => c.charCodeAt(0) > 255)
  return join(fields([2, text.length], [1, wide ? 1 : 0]), chars(text, wide))
}

export const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  FILEPASS: 0x002f,
  BOUNDSHEET: 0x0085,
  WINDOW1: 0x003d,
  FONT: 0x0031,
  FORMAT: 0x041e,
  XF: 0x00e0,
  XFEXT: 0x087d,
  STYLE: 0x0293,
  PALETTE: 0x0092,
  SST: 0x00fc,
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
  NOTE: 0x001c,
  OBJ: 0x005d,
  CF: 0x01b1,
} as const

export function bof(type: number, version = 0x0600): Uint8Array {
  return rec(R.BOF, fields([2, version], [2, type], [2, 0], [2, 0], [4, 0], [4, 0]))
}

export function font(
  o: { name?: string; size?: number; bold?: boolean; italic?: boolean; color?: number } = {},
): Uint8Array {
  return rec(
    R.FONT,
    join(
      fields(
        [2, (o.size ?? 10) * 20],
        [2, o.italic ? 2 : 0],
        [2, o.color ?? 0x7fff],
        [2, o.bold ? 700 : 400],
        [2, 0],
        [1, 0],
        [1, 0],
        [1, 0],
        [1, 0],
      ),
      shortString(o.name ?? 'Arial'),
    ),
  )
}

export interface XfOptions {
  font?: number
  format?: number
  style?: boolean
  horizontal?: number
  vertical?: number
  wrap?: boolean
  /** 四边线型（左、右、上、下）与颜色序号。 */
  borders?: [number, number, number, number]
  borderColor?: number
  /** 图案编号与前景、背景色序号。 */
  fill?: [number, number, number]
}

export function xf(o: XfOptions = {}): Uint8Array {
  const [l, r, t, b] = o.borders ?? [0, 0, 0, 0]
  const c = o.borderColor ?? 64
  const [pattern, fg, bg] = o.fill ?? [0, 64, 65]
  return rec(
    R.XF,
    fields(
      [2, o.font ?? 0],
      [2, o.format ?? 0],
      [2, o.style ? 0xfff4 : 0],
      [1, (o.horizontal ?? 0) | (o.wrap ? 8 : 0) | ((o.vertical ?? 2) << 4)],
      [1, 0],
      [1, 0],
      [1, 0],
      [4, l | (r << 4) | (t << 8) | (b << 12) | (c << 16) | (c << 23)],
      [4, c | (c << 7) | (pattern << 26)],
      [2, fg | (bg << 7)],
    ),
  )
}

/** 15 个样式 XF 与 1 个缺省单元格 XF（XF 15），其后为 `cells`。 */
export function xfTable(...cells: XfOptions[]): Uint8Array[] {
  return [
    ...Array.from({ length: 15 }, () => xf({ style: true })),
    xf(),
    ...cells.map((o) => xf(o)),
  ]
}

/** 常规样式（内置样式 0）指向 XF 0。 */
export const NORMAL_STYLE = rec(R.STYLE, fields([2, 0x8000], [1, 0], [1, 0xff]))

export function sst(...strings: string[]): Uint8Array {
  return rec(
    R.SST,
    join(fields([4, strings.length], [4, strings.length]), ...strings.map(unicodeString)),
  )
}

export function cell(id: number, row: number, col: number, xfIndex: number, ...rest: Uint8Array[]) {
  return rec(id, join(fields([2, row], [2, col], [2, xfIndex]), ...rest))
}

export interface SheetSpec {
  name: string
  /** 0 可见、1 隐藏、2 深度隐藏。 */
  state?: number
  /** BOUNDSHEET 的 `dt`。 */
  type?: number
  /** 子流 BOF 的 `dt`，缺省为工作表 0x0010。 */
  bofType?: number
  records: Uint8Array[]
}

export function workbookStream(globals: Uint8Array[], sheets: SheetSpec[]): Uint8Array {
  const boundsheets = sheets.map((s) =>
    rec(
      R.BOUNDSHEET,
      join(fields([4, 0], [1, s.state ?? 0], [1, s.type ?? 0]), shortString(s.name)),
    ),
  )
  const head = join(bof(0x0005), ...globals, ...boundsheets, rec(R.EOF))
  const bodies = sheets.map((s) => join(bof(s.bofType ?? 0x0010), ...s.records, rec(R.EOF)))
  const stream = join(head, ...bodies)
  const view = new DataView(stream.buffer)
  let offset = head.length
  let p = head.length - 4 - boundsheets.reduce((n, b) => n + b.length, 0)
  for (const [i, b] of boundsheets.entries()) {
    view.setUint32(p + 4, offset, true)
    p += b.length
    offset += bodies[i]!.length
  }
  return stream
}

export function buildXls(globals: Uint8Array[], sheets: SheetSpec[]): Uint8Array<ArrayBuffer> {
  return buildCfb({ Workbook: workbookStream(globals, sheets) })
}

const PASSWORD = 'VelvetSweatshop'

/**
 * 在 `stream` 的首个 BOF 之后插入 FILEPASS 并以 RC4 加密（BOUNDSHEET 的子流位置随之后移）。
 * `password` 不是缺省密码时得到的文件不能以缺省密码解开。
 */
export function encrypt(stream: Uint8Array, password = PASSWORD): Uint8Array {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i * 13 + 1)
  const pw = new Uint8Array(password.length * 2)
  for (let i = 0; i < password.length; i++) pw[i * 2] = password.charCodeAt(i)
  const h0 = md5(pw).subarray(0, 5)
  const repeated = new Uint8Array(21 * 16)
  for (let i = 0; i < 16; i++) repeated.set(join(h0, salt), i * 21)
  const h1 = md5(repeated).subarray(0, 5)
  const keyOf = (block: number) => md5(join(h1, fields([4, block])))
  const verifier = Uint8Array.from({ length: 16 }, (_, i) => i + 100)
  const check = rc4(keyOf(0), 32)
  const plain = join(verifier, md5(verifier))
  const filepass = rec(
    R.FILEPASS,
    join(
      fields([2, 1], [2, 1], [2, 1]),
      salt,
      plain.map((v, i) => v ^ check[i]!),
    ),
  )

  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const first = 4 + view.getUint16(2, true)
  const out = join(stream.subarray(0, first), filepass, stream.subarray(first))
  const ov = new DataView(out.buffer)
  const plainIds = new Set<number>([R.BOF, R.FILEPASS])
  let ks: Uint8Array = new Uint8Array(0)
  let current = -1
  for (let p = 0; p + 4 <= out.length; ) {
    const id = ov.getUint16(p, true)
    const size = ov.getUint16(p + 2, true)
    if (id === R.BOUNDSHEET) ov.setUint32(p + 4, ov.getUint32(p + 4, true) + filepass.length, true)
    if (p >= first + filepass.length && !plainIds.has(id)) {
      for (let q = id === R.BOUNDSHEET ? p + 8 : p + 4; q < p + 4 + size; q++) {
        const block = Math.floor(q / 1024)
        if (block !== current) {
          current = block
          ks = rc4(keyOf(block), 1024)
        }
        out[q] = out[q]! ^ ks[q % 1024]!
      }
    }
    p += 4 + size
  }
  return out
}
