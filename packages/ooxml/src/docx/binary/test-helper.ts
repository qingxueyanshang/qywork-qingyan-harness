/**
 * 测试夹具：按段落与字段生成 .doc（`WordDocument`、`1Table` 与可选的 `Data` 流，经 `../../zip/test-helper.ts` 装入 CFB）。
 *
 * - 文字自 `WordDocument` 第 1024 字节起，正文之后为页眉页脚文字，CHPX 与 PAPX 各占一页 FKP；`pieces` 给出时按其顺序
 *   把各段字符写入流中（快速保存的文件），否则全文为一个未压缩的片段。
 * - 样式表、字体表、节、编号与 DOP 按给定的字节写入表流；未给出时样式表只有 Normal 与 Default Paragraph Font。
 */

import { buildCfb } from '../../zip/test-helper.ts'

export function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function le16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff]
}

export function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

export function utf16(s: string): number[] {
  return [...s].flatMap((c) => le16(c.charCodeAt(0)))
}

/** 一个 sprm：操作码与操作数（变长 sprm 的长度字节由调用方写入操作数）。 */
export function sprm(op: number, ...operand: number[]): number[] {
  return [...le16(op), ...operand]
}

export interface Run {
  readonly text: string
  /** CHPX 的 sprm 序列。 */
  readonly chpx?: number[]
}

export interface Para {
  readonly runs: readonly Run[]
  /** 段落样式（istd）。 */
  readonly istd?: number
  /** PAPX 的 sprm 序列（不含 istd）。 */
  readonly papx?: number[]
  /** 段落结束字符：缺省为 0x0D。 */
  readonly mark?: string
  /** 段落标记的 CHPX。 */
  readonly markChpx?: number[]
}

/** 一个样式（STD）：`upx` 为各组差异，段落差异的前两个字节为 istd。 */
export interface Std {
  readonly istd: number
  readonly sti: number
  /** 1 段落、2 字符、3 表格。 */
  readonly stk: number
  readonly base: number
  readonly name: string
  readonly upx: readonly number[][]
}

export interface DocOptions {
  readonly paragraphs: readonly Para[]
  /** 片段：字符位置区间与是否压缩，按写入流中的顺序列出；须覆盖全文。 */
  readonly pieces?: readonly {
    readonly start: number
    readonly end: number
    readonly compressed?: boolean
  }[]
  readonly styles?: readonly Std[]
  readonly fonts?: readonly string[]
  /** 各节：结束字符位置（不含）与 SEPX 的 sprm 序列。 */
  readonly sections?: readonly { readonly end: number; readonly sepx: number[] }[]
  /** PlfLst 与 PlfLfo 的字节。 */
  readonly lists?: { readonly lst: number[]; readonly lfo: number[] }
  readonly dop?: number[]
  readonly encrypted?: boolean
  /**
   * 页眉页脚文字：段落接在正文之后，`stories` 为 PlcfHdd 中各部分的起始位置（相对页眉文字开头；前 6 个为分隔符，
   * 其后每节 6 个，最后两项为末尾位置）。
   */
  readonly header?: { readonly paragraphs: readonly Para[]; readonly stories: readonly number[] }
  /** `Data` 流的字节。 */
  readonly data?: Uint8Array
  /** 文本框文字：段落接在页眉页脚文字之后，`stories` 为 PlcftxbxTxt 中各项的起始位置与末尾位置，`lids` 为各项的形状编号。 */
  readonly textbox?: {
    readonly paragraphs: readonly Para[]
    readonly stories: readonly number[]
    readonly lids: readonly number[]
  }
  /** OfficeArtContent（DggInfo）的字节与 PlcSpaMom 的各项（锚点字符位置、形状编号、对象框四边与标志）。 */
  readonly art?: {
    readonly content: number[]
    readonly anchors: readonly {
      readonly cp: number
      readonly spid: number
      readonly rect: readonly [number, number, number, number]
      readonly flags: number
    }[]
  }
}

const TEXT_AT = 1024
const PAGE = 512
const NORMAL: Std = {
  istd: 0,
  sti: 0,
  stk: 1,
  base: 0x0fff,
  name: 'Normal',
  upx: [le16(0), []],
}
const DEFAULT_FONT: Std = {
  istd: 10,
  sti: 65,
  stk: 2,
  base: 0x0fff,
  name: 'Default Paragraph Font',
  upx: [[]],
}

function std(s: Std): number[] {
  const base = [
    ...le16(s.sti & 0x0fff),
    ...le16((s.stk & 0x0f) | (s.base << 4)),
    ...le16((s.upx.length & 0x0f) | (s.istd << 4)),
    ...le16(0),
    ...le16(0),
  ]
  const name = [...le16(s.name.length), ...utf16(s.name), 0, 0]
  const out = [...base, ...name]
  for (const u of s.upx) {
    if (out.length % 2 === 1) out.push(0)
    out.push(...le16(u.length), ...u)
  }
  return out
}

function styleSheet(styles: readonly Std[]): number[] {
  const count = Math.max(...styles.map((s) => s.istd)) + 1
  const stshi = [...le16(count), ...le16(10), ...le16(1), ...le16(0), ...le16(0), ...le16(0)]
  stshi.push(...le16(0), ...le16(1), ...le16(0), ...le16(0))
  const out = [...le16(stshi.length), ...stshi]
  for (let i = 0; i < count; i++) {
    const s = styles.find((x) => x.istd === i)
    const body = s === undefined ? [] : std(s)
    out.push(...le16(body.length), ...body)
  }
  return out
}

function fontTable(fonts: readonly string[]): number[] {
  const out = [...le16(fonts.length), ...le16(0)]
  for (const name of fonts) {
    const ffn = [0x16, ...le16(400), 0x86, 0, ...new Array(10).fill(0), ...new Array(24).fill(0)]
    ffn.push(...utf16(name), 0, 0)
    out.push(ffn.length, ...ffn)
  }
  return out
}

/**
 * 一页 FKP：`entries` 为各项的起止 FC 与内容。CHPX 的内容前写长度字节；PAPX 的内容（含 istd）前写字数 `cb`，
 * 内容长度为 `2 * cb - 1`，不足处补 0。
 */
function fkp(
  entries: readonly { fc: number; end: number; data: number[] }[],
  papx: boolean,
): Uint8Array {
  const page = new Uint8Array(PAGE)
  const v = new DataView(page.buffer)
  const n = entries.length
  entries.forEach((e, i) => {
    v.setUint32(i * 4, e.fc, true)
  })
  v.setUint32(n * 4, entries[n - 1]?.end ?? 0, true)
  let top = PAGE - 1
  entries.forEach((e, i) => {
    const cb = Math.ceil((e.data.length + 1) / 2)
    const body = papx ? [cb, ...e.data] : [e.data.length, ...e.data]
    while (papx && body.length < 2 * cb) body.push(0)
    top -= body.length
    if (top % 2 === 1) top--
    page.set(body, top)
    page[(n + 1) * 4 + i * (papx ? 13 : 1)] = top / 2
  })
  page[PAGE - 1] = n
  return page
}

/** 生成 .doc 的字节（CFB 复合文档）。 */
export function buildDoc(o: DocOptions): Uint8Array<ArrayBuffer> {
  const chars: { ch: string; chpx: number[] }[] = []
  const paraEnds: { end: number; data: number[] }[] = []
  const write = (paragraphs: readonly Para[]) => {
    for (const p of paragraphs) {
      for (const r of p.runs) for (const ch of r.text) chars.push({ ch, chpx: r.chpx ?? [] })
      chars.push({ ch: p.mark ?? '\r', chpx: p.markChpx ?? [] })
      paraEnds.push({ end: chars.length, data: [...le16(p.istd ?? 0), ...(p.papx ?? [])] })
    }
  }
  write(o.paragraphs)
  const textLength = chars.length
  write(o.header?.paragraphs ?? [])
  const headerLength = chars.length - textLength
  write(o.textbox?.paragraphs ?? [])
  const length = chars.length
  const pieces = o.pieces ?? [{ start: 0, end: length }]
  // 各字符在流中的位置（FC）：按片段的写入顺序依次排列。
  const fcs = new Array<number>(length).fill(0)
  const word: number[] = new Array(TEXT_AT).fill(0)
  const pcd: { start: number; end: number; fc: number; compressed: boolean }[] = []
  for (const pc of pieces) {
    const fc = word.length
    for (let cp = pc.start; cp < pc.end; cp++) {
      fcs[cp] = word.length
      const code = chars[cp]!.ch.charCodeAt(0)
      if (pc.compressed) word.push(code)
      else word.push(...le16(code))
    }
    pcd.push({ ...pc, compressed: pc.compressed === true, fc })
  }
  while (word.length % PAGE !== 0) word.push(0)
  // CHPX：相邻且 sprm 相同的字符合并为一项。
  const chpxEntries: { fc: number; end: number; data: number[] }[] = []
  for (let cp = 0; cp < length; cp++) {
    const step = pcd.find((p) => cp >= p.start && cp < p.end)?.compressed ? 1 : 2
    const last = chpxEntries[chpxEntries.length - 1]
    const data = chars[cp]!.chpx
    if (last !== undefined && last.end === fcs[cp] && last.data.join() === data.join())
      last.end += step
    else chpxEntries.push({ fc: fcs[cp]!, end: fcs[cp]! + step, data })
  }
  chpxEntries.sort((a, b) => a.fc - b.fc)
  const papxEntries: { fc: number; end: number; data: number[] }[] = []
  for (const p of paraEnds) {
    const markCp = p.end - 1
    const step = pcd.find((x) => markCp >= x.start && markCp < x.end)?.compressed ? 1 : 2
    papxEntries.push({ fc: fcs[markCp]!, end: fcs[markCp]! + step, data: p.data })
  }
  papxEntries.sort((a, b) => a.fc - b.fc)
  // 一页 FKP 中 FC 区间须连续：项之间的空隙以空属性补足。
  const fill = (entries: { fc: number; end: number; data: number[] }[]) => {
    const out: typeof entries = []
    for (const e of entries) {
      const prev = out[out.length - 1]
      if (prev !== undefined && prev.end < e.fc) out.push({ fc: prev.end, end: e.fc, data: [] })
      out.push(e)
    }
    return out
  }
  const chpxPage = word.length / PAGE
  word.push(...fkp(fill(chpxEntries), false))
  const papxPage = word.length / PAGE
  const papxFilled = fill(papxEntries).map((e) =>
    e.data.length === 0 ? { ...e, data: le16(0) } : e,
  )
  word.push(...fkp(papxFilled, true))
  const sepxAt: number[] = []
  for (const s of o.sections ?? []) {
    sepxAt.push(word.length)
    word.push(...le16(s.sepx.length), ...s.sepx)
  }

  const table: number[] = []
  const pairs = new Map<number, [number, number]>()
  const put = (index: number, data: number[]) => {
    pairs.set(index, [table.length, data.length])
    table.push(...data)
  }
  put(1, styleSheet(o.styles ?? [NORMAL, DEFAULT_FONT]))
  const sorted = [...pcd].sort((a, b) => a.start - b.start)
  const plcPcd = [
    ...sorted.flatMap((p) => le32(p.start)),
    ...le32(length),
    ...sorted.flatMap((p) => [
      0,
      0,
      ...le32(p.compressed ? (p.fc * 2) | 0x40000000 : p.fc),
      ...le16(0),
    ]),
  ]
  put(33, [2, ...le32(plcPcd.length), ...plcPcd])
  const bte = (entries: { fc: number; end: number }[], pn: number) => [
    ...le32(entries[0]?.fc ?? 0),
    ...le32(entries[entries.length - 1]?.end ?? 0),
    ...le32(pn),
  ]
  put(12, bte(fill(chpxEntries), chpxPage))
  put(13, bte(papxFilled, papxPage))
  put(15, fontTable(o.fonts ?? ['Times New Roman', '宋体', 'Arial']))
  if (o.sections !== undefined) {
    const cps = [0, ...o.sections.map((s) => s.end)]
    put(6, [
      ...cps.flatMap(le32),
      ...o.sections.flatMap((_, i) => [...le16(0), ...le32(sepxAt[i]!), ...le16(0), ...le32(0)]),
    ])
  }
  put(31, o.dop ?? [...new Array(10).fill(0), ...le16(420), ...new Array(500).fill(0)])
  if (o.header !== undefined) put(11, o.header.stories.flatMap(le32))
  if (o.textbox !== undefined) {
    const t = o.textbox
    put(56, [
      ...t.stories.flatMap(le32),
      ...t.lids.flatMap((lid) => [
        ...le32(1),
        ...le32(0),
        ...le16(0),
        ...le32(0),
        ...le32(lid),
        ...le32(0),
      ]),
    ])
  }
  if (o.art !== undefined) {
    put(50, o.art.content)
    const a = o.art.anchors
    put(40, [
      ...a.flatMap((x) => le32(x.cp)),
      ...le32(textLength),
      ...a.flatMap((x) => [...le32(x.spid), ...x.rect.flatMap(le32), ...le16(x.flags), ...le32(0)]),
    ])
  }
  if (o.lists !== undefined) {
    put(73, o.lists.lst)
    put(74, o.lists.lfo)
  }

  const fib = new Array(154 + 93 * 8).fill(0)
  const set16 = (at: number, v: number) => fib.splice(at, 2, ...le16(v))
  const set32 = (at: number, v: number) => fib.splice(at, 4, ...le32(v))
  set16(0, 0xa5ec)
  set16(2, 0xc1)
  const complex = o.pieces !== undefined ? 0x0004 : 0
  set16(10, complex | 0x0200 | (o.encrypted ? 0x0100 : 0))
  set16(32, 14)
  set16(62, 22)
  set32(64 + 12, textLength)
  set32(64 + 20, headerLength)
  set32(64 + 36, length - textLength - headerLength)
  set16(152, 93)
  for (const [index, [fc, lcb]] of pairs) {
    set32(154 + index * 8, fc)
    set32(158 + index * 8, lcb)
  }
  word.splice(0, fib.length, ...fib)
  return buildCfb({
    WordDocument: Uint8Array.from(word),
    '1Table': Uint8Array.from(table),
    ...(o.data === undefined ? {} : { Data: o.data }),
  })
}
