/**
 * .doc 的文件信息块（FIB）与表流中的 PLC 结构。
 *
 * - FIB 位于 `WordDocument` 流开头：`FibBase` 32 字节，其后 `fibRgW`、`fibRgLw`、`fibRgFcLcb` 各自以前置的计数给出长度。
 * - `FibBase.nFib` 在 Word 97 及以后的版本中为 0x00C1（真正的版本号在 `fibRgCswNew` 中），小于 0x00C0 的为 Word 6/95 的布局，
 *   不读取。
 * - 表流由 `fWhichTblStm` 选择：为 1 时是 `1Table`，否则是 `0Table`。
 * - 各结构的位置取 `fibRgFcLcb` 中的 (fc, lcb) 对，下标见 `FC`；越过 `fibRgFcLcb` 末尾的项按长度 0 处理。
 */

/** `fibRgFcLcb` 中各结构的下标。 */
export const FC = {
  stshf: 1,
  plcffndRef: 2,
  plcfandRef: 4,
  plcfSed: 6,
  plcfHdd: 11,
  plcfBteChpx: 12,
  plcfBtePapx: 13,
  sttbfFfn: 15,
  dop: 31,
  clx: 33,
  plcSpaMom: 40,
  plcSpaHdr: 41,
  plcfendRef: 46,
  dggInfo: 50,
  plcftxbxTxt: 56,
  plcfHdrtxbxTxt: 58,
  plfLst: 73,
  plfLfo: 74,
} as const

/** `fibRgLw` 中各文本部分的长度（字符数）。 */
export interface StoryLengths {
  readonly text: number
  readonly footnote: number
  readonly header: number
  readonly comment: number
  readonly endnote: number
  readonly textbox: number
  readonly headerTextbox: number
}

export interface Fib {
  /** 快速保存的文件（`fComplex`）：正文片段的顺序与文件中的顺序不同。 */
  readonly complex: boolean
  /** 已加密（`fEncrypted`）或经异或混淆（`fObfuscated`）。 */
  readonly encrypted: boolean
  readonly tableStream: '0Table' | '1Table'
  readonly lengths: StoryLengths
  /** 第 `index` 个 (fc, lcb) 对。 */
  pair(index: number): { readonly fc: number; readonly lcb: number }
}

const IDENT = 0xa5ec
const MIN_NFIB = 0x00c0

/** 文件信息块；不是 Word 97 及以后的布局或长度不足时返回 `null`。 */
export function readFib(stream: Uint8Array): Fib | null {
  if (stream.length < 34) return null
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  if (v.getUint16(0, true) !== IDENT || v.getUint16(2, true) < MIN_NFIB) return null
  const flags = v.getUint16(10, true)
  const csw = v.getUint16(32, true)
  const lwAt = 34 + csw * 2
  if (lwAt + 2 > stream.length) return null
  const cslw = v.getUint16(lwAt, true)
  const lw = (i: number) =>
    i < cslw && lwAt + 2 + i * 4 + 4 <= stream.length ? v.getInt32(lwAt + 2 + i * 4, true) : 0
  const fcAt = lwAt + 2 + cslw * 4
  if (fcAt + 2 > stream.length) return null
  const pairs = v.getUint16(fcAt, true)
  return {
    complex: (flags & 0x0004) !== 0,
    encrypted: (flags & 0x0100) !== 0 || (flags & 0x8000) !== 0,
    tableStream: flags & 0x0200 ? '1Table' : '0Table',
    lengths: {
      text: lw(3),
      footnote: lw(4),
      header: lw(5),
      comment: lw(7),
      endnote: lw(8),
      textbox: lw(9),
      headerTextbox: lw(10),
    },
    pair(index) {
      const p = fcAt + 2 + index * 8
      if (index >= pairs || p + 8 > stream.length) return { fc: 0, lcb: 0 }
      return { fc: v.getUint32(p, true), lcb: v.getUint32(p + 4, true) }
    },
  }
}

/**
 * PLC：`n + 1` 个 32 位位置（CP 或 FC）之后是 `n` 个长度为 `size` 的数据项，`n = (lcb - 4) / (4 + size)`。
 * 结构超出 `data` 或长度不符时为空。
 */
export class Plc {
  readonly count: number
  private readonly view: DataView

  constructor(
    data: Uint8Array,
    private readonly start: number,
    lcb: number,
    private readonly size: number,
  ) {
    const n = (lcb - 4) / (4 + size)
    const ok = lcb >= 4 && Number.isInteger(n) && start + lcb <= data.length
    this.count = ok ? n : 0
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  /** 第 `i` 个位置（`0 ≤ i ≤ count`）。 */
  position(i: number): number {
    return this.view.getUint32(this.start + i * 4, true)
  }

  /** 第 `i` 个数据项在 `data` 中的偏移。 */
  item(i: number): number {
    return this.start + (this.count + 1) * 4 + i * this.size
  }

  /** 位置区间 `[position(i), position(i + 1))` 包含 `p` 的下标；不在任何区间中时为 -1。 */
  find(p: number): number {
    let lo = 0
    let hi = this.count - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (p < this.position(mid)) hi = mid - 1
      else if (p >= this.position(mid + 1)) lo = mid + 1
      else return mid
    }
    return -1
  }
}
