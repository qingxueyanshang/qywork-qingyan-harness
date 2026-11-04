/**
 * .doc（Word 97–2003）解析入口：由 CFB 中的 `WordDocument` 流与表流得到与 docx 相同的 `DocxDocument`。由 `parseDocx` 在打开
 * ZIP 之前调用。
 *
 * - FIB 不是 Word 97 及以后的布局、表流或片段表缺失时为已损坏（`doc`）；`fEncrypted` 或 `fObfuscated` 为已加密。
 * - 正文为主文档文字（CP 0 至 `ccpText`）：段落以段落标记（0x0D）、单元格结束标记（0x07）或节的最后一个字符（0x0C）结束，
 *   其余位置的 0x0C 为分页符。段落属性取段落标记的 PAPX，字符属性取各字符的 CHPX，再依次应用所在片段的属性修改；
 *   样式继承、编号与段落属性的最终值沿用 docx 的 `Resolver` 与 `../parse/body.ts` 的块解决。
 * - 表格：段落属性带 `fInTable` 的段落属于表格，嵌套深度取 `itap`；单元格以 0x07（嵌套表格中为带 `fInnerTableCell` 的段落）
 *   结束，行以带 `fTtp`（嵌套表格中为 `fInnerTtp`）的段落结束，该段落带有这一行的表格属性，本身不显示。
 * - 域：0x13 开始、0x14 分隔、0x15 结束；只显示结果部分，域名取域代码的第一个词，计数与页码域的规则与 docx 的 `fldChar` 相同。
 * - 节：PlcfSed 给出各节的结束位置与 SEPX。
 * - 页眉页脚：页眉文字位于正文与脚注之后，PlcfHdd 给出其中各部分的起始位置（见 `headerStories`）。每个非空部分为一个部件
 *   （`DocxDocument.parts`），去掉末尾的保护段落标记后按所在节的版面解决；空部分沿用上一节同类的部件（`Section` 中为 `null`）。
 *   DOP 的 `fFacingPages` 为奇偶页不同。
 * - 嵌入式图片：图片字符（0x01）的 PICF 与图片见 `picture.ts`，图片字节按 PICF 的位置登记为图片部件，可否绘制按引用计数
 *   （与 docx 相同）；没有图片或格式不支持时只占对象框，计入 `picture`（嵌入对象计入 `ole`）。
 * - 浮动对象与文本框：锚点字符（0x08）的形状见 `drawing.ts`，记入所在段落的 `anchors`；没有对应形状的锚点字符计入 `drawing`。
 * - 未读取的内容计入能力边界：脚注、尾注、批注（按引用计数）。
 */

import { ZERO_RECT } from '../../drawingml/fill.ts'
import { countImage, drawableImage } from '../../drawingml/shape/resolve.ts'
import { MATH_SETTINGS_DEFAULTS } from '../../math/index.ts'
import type { Blip } from '../../officeart/blip.ts'
import type { ArtStyleContext } from '../../officeart/style.ts'
import type { CfbFile } from '../../zip/cfb.ts'
import type { DocxResult } from '../load.ts'
import type {
  Block,
  DocxDocument,
  InlineImage,
  MediaPart,
  PageBorders,
  PartRefs,
  Run,
  RunProps,
  Section,
  UnsupportedCounts,
  UnsupportedKind,
} from '../model.ts'
import {
  countParagraph,
  countRunEffects,
  dynamicField,
  type FirstContent,
  fieldNameOf,
  PAGE_FIELDS,
  type Pending,
  type PendingCell,
  type PendingParagraph,
  type PendingRow,
  type PendingTable,
  paragraphNumbering,
  resolveBlocks,
  withoutHyperlinkStyle,
} from '../parse/body.ts'
import type { PendingAnchor } from '../parse/drawing.ts'
import type { RawRunProps } from '../parse/properties.ts'
import type { Styles } from '../parse/styles.ts'
import { type ParagraphContext, Resolver, type TableLayer } from '../resolve/cascade.ts'
import { NumberingState } from '../resolve/numbering.ts'
import { tableStyleChain } from '../resolve/table.ts'
import {
  anchorOf,
  readArtContent,
  readBlips,
  readFspas,
  readTextboxes,
  shapePictures,
} from './drawing.ts'
import { FC, Plc, readFib } from './fib.ts'
import { type DocPicture, readPicture } from './picture.ts'
import {
  applyChp,
  applyPap,
  applySep,
  type ChpState,
  emptyChp,
  emptyPap,
  emptySep,
  type PapState,
  readSprms,
  type SepState,
  type Sprm,
  u16,
  u32,
} from './sprm.ts'
import { readFonts, readLists, readStyles } from './styles.ts'
import { readTap } from './table.ts'
import { type DocText, FkpIndex, type Piece, readPieces, readText } from './text.ts'

const TWIP = 20
const PARAGRAPH_MARK = 0x0d
const CELL_MARK = 0x07
const SECTION_MARK = 0x0c
const FIELD_BEGIN = 0x13
const FIELD_SEPARATOR = 0x14
const FIELD_END = 0x15
const SGC_CHARACTER = 2

const corrupt: DocxResult = { ok: false, failure: { kind: 'corrupt', reason: 'doc' } }

/** 一段字符属性相同的文字：`chp` 为直接格式（CHPX 与片段的属性修改）。 */
interface RawRun {
  readonly start: number
  readonly end: number
  readonly chp: ChpState
}

/** 第一遍读出的段落：字符位置区间、段落属性、各段文字与段落标记的字符属性。 */
interface RawParagraph {
  readonly start: number
  /** 段落标记的位置；最后一段没有段落标记时为正文长度。 */
  readonly mark: number
  /** 段落标记为单元格结束标记（0x07）。 */
  readonly cell: boolean
  readonly pap: PapState
  readonly runs: readonly RawRun[]
  readonly markChp: ChpState
  readonly section: number
}

type RawBlock =
  | { readonly kind: 'paragraph'; readonly p: RawParagraph }
  | { readonly kind: 'table'; readonly rows: readonly RawRow[]; readonly section: number }

interface RawRow {
  /** 行结束段落中的表格属性；没有行结束段落时为空。 */
  readonly tap: readonly Sprm[]
  readonly cells: readonly (readonly RawBlock[])[]
}

export async function parseDoc(file: CfbFile): Promise<DocxResult> {
  const word = file.stream('WordDocument')
  const fib = word === null ? null : readFib(word)
  if (word === null || fib === null) return corrupt
  if (fib.encrypted) return { ok: false, failure: { kind: 'encrypted' } }
  const table = file.stream(fib.tableStream)
  if (table === null) return corrupt
  const clx = fib.pair(FC.clx)
  const pieces = readPieces(table, clx.fc, clx.lcb)
  if (pieces === null) return corrupt
  const ffn = fib.pair(FC.sttbfFfn)
  const fonts = readFonts(table, ffn.fc, ffn.lcb)
  const stshf = fib.pair(FC.stshf)
  const styles = readStyles(table, stshf.fc, stshf.lcb, fonts.names)
  const lists = readLists(table, fib.pair(FC.plfLst), fib.pair(FC.plfLfo), fonts.names)
  const L = fib.lengths
  const length = Math.min(L.text, pieces.length)
  const headerStart = L.text + L.footnote
  // 各部分文字依次为正文、脚注、页眉页脚、批注、尾注、文本框与页眉页脚中的文本框。
  const textboxStart = headerStart + L.header + L.comment + L.endnote
  const text = readText(
    word,
    pieces,
    Math.max(length, Math.min(textboxStart + L.textbox + L.headerTextbox, pieces.length)),
  )

  const unsupported: UnsupportedCounts = {}
  const count = (kind: UnsupportedKind, n = 1) => {
    unsupported[kind] = (unsupported[kind] ?? 0) + n
  }
  const references = (index: number, size: number, kind: UnsupportedKind) => {
    const pair = fib.pair(index)
    const n = new Plc(table, pair.fc, pair.lcb, size).count
    if (n > 0) count(kind, n)
  }
  references(FC.plcffndRef, 2, 'footnote')
  references(FC.plcfendRef, 2, 'endnote')
  references(FC.plcfandRef, 30, 'comment')

  const sections = readSections(word, table, fib.pair(FC.plcfSed), length, count)
  const dop = fib.pair(FC.dop)
  const settings = readDop(table.subarray(dop.fc, Math.min(table.length, dop.fc + dop.lcb)))
  const bte = (index: number, kind: 'chpx' | 'papx') => {
    const pair = fib.pair(index)
    return new FkpIndex(word, table, pair.fc, pair.lcb, kind)
  }
  const data = file.stream('Data')
  const reader = new TextReader(
    text,
    pieces.pieces,
    bte(FC.plcfBteChpx, 'chpx'),
    bte(FC.plcfBtePapx, 'papx'),
    data,
    fonts.names,
    sections.ends,
  )
  const mainText = reader.paragraphs(0, length, null)
  const stories = headerStories(table, fib.pair(FC.plcfHdd), sections.list.length).map((list, s) =>
    list.map((r) =>
      r === null ? null : reader.paragraphs(headerStart + r.start, headerStart + r.end - 1, s),
    ),
  )
  // 文本框文字：正文（0）与页眉页脚（1）的各文本框。
  const textboxes = [
    { at: textboxStart, pair: fib.pair(FC.plcftxbxTxt) },
    { at: textboxStart + L.textbox, pair: fib.pair(FC.plcfHdrtxbxTxt) },
  ].map(({ at, pair }) =>
    readTextboxes(table, pair).map((r) => reader.paragraphs(at + r.start, at + r.end, 0)),
  )
  const pictures = await readPictures(data, text.text, [
    ...mainText,
    ...stories.flat().flatMap((p) => p ?? []),
    ...textboxes.flat(2),
  ])
  const art = readArtContent(table, fib.pair(FC.dggInfo))
  const fspas = [readFspas(table, fib.pair(FC.plcSpaMom)), readFspas(table, fib.pair(FC.plcSpaHdr))]
  const blips = await readBlips(
    art.group,
    word,
    shapePictures(art.shapes.flatMap((m) => [...m.values()].map((e) => e.shape))),
  )

  const numbering = new NumberingState(lists, styles, () => count('numberFormat'))
  const resolver = new Resolver(styles, numbering, {
    scheme: null,
    eastAsiaLanguage: 'zh-CN',
    bidiLanguage: '',
  })
  const media: MediaPart[] = []
  const placed = new Map<string, number>()
  /** 图片部件：同一部件只登记一次，可否绘制按引用计数（与 docx 相同）。 */
  const register = (part: string, blip: Blip): number => {
    let index = placed.get(part)
    if (index === undefined) {
      index = media.length
      placed.set(part, index)
      media.push({ part, contentType: blip.contentType, bytes: blip.bytes.slice() })
    }
    countImage(drawableImage(blip.contentType, blip.bytes), { push: () => count('imageFormat') })
    return index
  }
  const source: PictureSource = (at) => {
    const pic = pictures.get(at) ?? null
    if (pic === null) return null
    const index = pic.blip === null ? -1 : register(`Data/${at}`, pic.blip)
    return { media: index, empty: pic.empty, width: pic.width, height: pic.height }
  }
  const style: ArtStyleContext = {
    scheme: [],
    picture(pib) {
      const blip = blips.get(pib) ?? null
      if (blip === null) return null
      const part = `BStore/${pib}`
      register(part, blip)
      return part
    },
    pattern: () => null,
    background: { kind: 'none' },
    found: { push: () => count('effect') },
  }
  /** 浮动对象：`label` 为正文（0）或页眉页脚（1），`cp` 为锚点字符在其文字中的位置。 */
  const drawings =
    (label: 0 | 1, story: boolean) =>
    (cp: number): PendingAnchor<Pending[]> | null => {
      const fspa = fspas[label]!.get(cp)
      const entry = fspa === undefined ? undefined : art.shapes[label]!.get(fspa.spid)
      if (fspa === undefined || entry === undefined) return null
      return anchorOf(fspa, entry, {
        style,
        count,
        textbox: (index) => {
          const raw = textboxes[label]![index - 1]
          if (raw === undefined) return null
          const builder = new BlockBuilder(
            resolver,
            styles,
            text.text,
            count,
            source,
            story,
            NO_DRAWINGS,
          )
          return buildBlocks(raw).map((b) => builder.block(b, null))
        },
      })
    }
  /** 按文档顺序得到待解决的块与所在节的下标（编号与域的状态依赖这一顺序）。 */
  const build = (raw: readonly RawParagraph[], story: boolean) => {
    const builder = new BlockBuilder(
      resolver,
      styles,
      text.text,
      count,
      source,
      story,
      story ? (cp) => drawings(1, true)(cp - headerStart) : drawings(0, false),
    )
    return buildBlocks(raw).map((b) => ({
      block: builder.block(b, null),
      section: Math.min(b.kind === 'paragraph' ? b.p.section : b.section, sections.list.length - 1),
    }))
  }
  const env = { count, story: false, gridInTables: settings.gridInTables }
  const body: Block[] = []
  const blocks = build(mainText, false)
  for (let i = 0; i < blocks.length; ) {
    const s = blocks[i]!.section
    let j = i
    while (j < blocks.length && blocks[j]!.section === s) j++
    const group = blocks.slice(i, j).map((b) => b.block)
    for (const b of resolveBlocks(group, s, sections.list[s]!, 'body', env)) body.push(b)
    i = j
  }
  const parts: Record<string, readonly Block[]> = {}
  const storyEnv = { ...env, story: true }
  const list = sections.list.map((section, s) => {
    const ids = (stories[s] ?? []).map((raw, j) => {
      if (raw == null) return null
      const id = `hdd/${s}/${j}`
      const group = build(raw, true).map((b) => b.block)
      parts[id] = resolveBlocks(group, s, section, 'body', storyEnv)
      return id
    })
    const ref = (k: number) => ids[k] ?? null
    const headers: PartRefs = { default: ref(1), first: ref(4), even: ref(0) }
    const footers: PartRefs = { default: ref(3), first: ref(5), even: ref(2) }
    return { ...section, headers, footers }
  })
  const value: DocxDocument = {
    sections: list,
    body,
    settings: {
      defaultTabStop: settings.defaultTabStop,
      expandLineBreak: settings.expandLineBreak,
      noLineBreakBefore: settings.noLineBreakBefore,
      noLineBreakAfter: settings.noLineBreakAfter,
      compressPunctuation: settings.compressPunctuation,
      balanceSingleByte: settings.balanceSingleByte,
      compatibilityMode: 0,
      evenAndOddHeaders: settings.facingPages,
      gridInTables: settings.gridInTables,
      math: MATH_SETTINGS_DEFAULTS,
    },
    fontTable: fonts.entries,
    embeddedFonts: [],
    unsupported,
    parts,
    media,
    background: null,
  }
  return { ok: true, value }
}

/**
 * PlcfHdd 是页眉文字中各部分的起始位置：前 6 个部分是脚注与尾注的分隔符，其后每节 6 个部分依次为偶数页页眉、奇数页页眉、
 * 偶数页页脚、奇数页页脚、首页页眉、首页页脚，最后两项是末尾位置。返回各节 6 个部分的字符区间（相对页眉文字开头），
 * 空部分与 PlcfHdd 中没有的节为 `null`。各部分以一个不显示的保护段落标记结束。
 */
function headerStories(
  table: Uint8Array,
  pair: { fc: number; lcb: number },
  sections: number,
): ({ readonly start: number; readonly end: number } | null)[][] {
  const n = pair.fc + pair.lcb <= table.length ? Math.floor(pair.lcb / 4) : 0
  const at = (k: number) => u32(table, pair.fc + k * 4)
  return Array.from({ length: sections }, (_, s) =>
    Array.from({ length: 6 }, (_, j) => {
      const k = 6 + s * 6 + j
      if (k + 2 >= n || at(k + 1) <= at(k)) return null
      return { start: at(k), end: at(k + 1) }
    }),
  )
}

/** 图片字符的图片，按 PICF 的位置；没有 `Data` 流时为空。 */
async function readPictures(
  data: Uint8Array | null,
  text: string,
  paragraphs: readonly RawParagraph[],
): Promise<Map<number, DocPicture | null>> {
  const out = new Map<number, DocPicture | null>()
  if (data === null) return out
  for (const p of paragraphs) {
    for (const run of p.runs) {
      const at = run.chp.picture
      if (!run.chp.special || at === null || out.has(at)) continue
      if (!text.slice(run.start, run.end).includes('\u0001')) continue
      out.set(at, await readPicture(data, at))
    }
  }
  return out
}

/** 锚点字符（0x08）的浮动对象，参数为其字符位置；没有对应的形状时为 `null`。 */
type DrawingSource = (cp: number) => PendingAnchor<Pending[]> | null

/** 文本框中没有浮动对象。 */
const NO_DRAWINGS: DrawingSource = () => null

/**
 * 图片字符的对象框与图片部件（`media` 为 -1 时没有可用的图片，`empty` 为真时没有图片数据）；没有 PICF 时为 `null`。
 */
type PictureSource = (at: number) => {
  readonly media: number
  readonly empty: boolean
  readonly width: number
  readonly height: number
} | null

interface DopSettings {
  readonly defaultTabStop: number
  readonly expandLineBreak: boolean
  readonly noLineBreakBefore: string | null
  readonly noLineBreakAfter: string | null
  readonly compressPunctuation: boolean
  readonly balanceSingleByte: boolean
  readonly gridInTables: boolean
  readonly facingPages: boolean
}

/** DOP 中各项的位置：缺省制表位间距、兼容选项（Word 97 起）、DOPTYPOGRAPHY、Word 2000 起的第二组兼容选项。 */
const DOP = { tab: 0x0a, copts: 0x54, typography: 0x5a, copts2: 0x200 } as const

/**
 * DOP：奇偶页不同（第 0 字节的 `fFacingPages`），缺省制表位间距（`dxaTab`），中文版式（DOPTYPOGRAPHY：压缩标点，自定义的行首与
 * 行尾禁则字符），兼容选项。
 * 兼容选项的位为 1 时是西文版本的缺省行为，与 docx 中同名设置的方向相反：`fExpShRtn` 为 0 时以换行结束的行不参与两端对齐
 * （`doNotExpandShiftReturn`），`fDntBlnSbDbWid` 为 0 时协调中西文宽度（`balanceSingleByteDoubleByteWidth`），
 * `fDontAdjustLineHeightInTable` 为 0 时表格中的段落对齐行网格（`adjustLineHeightInTable`）。
 * DOP 较短而缺少的项取 docx 的缺省值。
 */
function readDop(d: Uint8Array): DopSettings {
  const has = (at: number, size: number) => at + size <= d.length
  const typo = has(DOP.typography, 2) ? u16(d, DOP.typography) : 0
  const custom = ((typo >> 3) & 3) === 2
  const punct = (n: number, at: number, max: number) => {
    const size = Math.min(n, max)
    if (!has(at, size * 2)) return null
    let s = ''
    for (let i = 0; i < size; i++) s += String.fromCharCode(u16(d, at + i * 2))
    return s
  }
  const copts = has(DOP.copts, 4) ? u32(d, DOP.copts) : null
  return {
    defaultTabStop: ((has(DOP.tab, 2) ? u16(d, DOP.tab) : 0) || 720) / TWIP,
    expandLineBreak: copts === null || (copts & 0x2000) !== 0,
    noLineBreakBefore: custom ? punct(u16(d, DOP.typography + 2), DOP.typography + 6, 101) : null,
    noLineBreakAfter: custom ? punct(u16(d, DOP.typography + 4), DOP.typography + 208, 51) : null,
    compressPunctuation: ((typo >> 1) & 3) !== 0,
    balanceSingleByte: copts !== null && (copts & 0x8000) === 0,
    gridInTables: has(DOP.copts2, 4) && (u32(d, DOP.copts2) & 0x08) === 0,
    facingPages: has(0, 1) && (d[0]! & 1) !== 0,
  }
}

const SECTION_STARTS: readonly Section['start'][] = [
  'continuous',
  'nextColumn',
  'nextPage',
  'evenPage',
  'oddPage',
]
const GRID_TYPES: readonly Section['gridType'][] = [
  'default',
  'linesAndChars',
  'lines',
  'snapToChars',
]
/** 页码格式代码到 `ST_NumberFormat`：只列出页码可选的几种，其余按十进制。 */
const PAGE_NUMBER_FORMATS = ['decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter']
const NO_PARTS = { default: null, first: null, even: null } as const

/** 节：各节的结束字符位置与版面；没有 PlcfSed 时全文为一节，按标准节属性。 */
function readSections(
  word: Uint8Array,
  table: Uint8Array,
  pair: { fc: number; lcb: number },
  length: number,
  count: (kind: UnsupportedKind) => void,
): { list: Section[]; ends: number[] } {
  const plc = new Plc(table, pair.fc, pair.lcb, 12)
  const list: Section[] = []
  const ends: number[] = []
  for (let i = 0; i < plc.count; i++) {
    const fc = u32(table, plc.item(i) + 2)
    const st = emptySep()
    if (fc !== 0xffffffff && fc + 2 <= word.length) {
      const size = u16(word, fc)
      for (const s of readSprms(word.subarray(fc + 2, Math.min(word.length, fc + 2 + size))))
        applySep(s, st)
    }
    list.push(sectionOf(st, count))
    ends.push(plc.position(i + 1))
  }
  if (list.length === 0) {
    list.push(sectionOf(emptySep(), count))
    ends.push(length)
  }
  return { list, ends }
}

function sectionOf(st: SepState, count: (kind: UnsupportedKind) => void): Section {
  const text = (st.pageWidth - st.left - st.right - st.gutter) / TWIP
  const n = Math.max(1, st.columns)
  let columns: { width: number; space: number }[]
  if (!st.evenlySpaced && st.columnWidths.size > 0) {
    columns = Array.from({ length: n }, (_, i) => ({
      width: (st.columnWidths.get(i) ?? 0) / TWIP,
      space: i < n - 1 ? (st.columnSpacings.get(i) ?? 0) / TWIP : 0,
    }))
  } else {
    const space = st.columnSpace / TWIP
    const width = (text - (n - 1) * space) / n
    columns = Array.from({ length: n }, (_, i) => ({ width, space: i < n - 1 ? space : 0 }))
  }
  if (columns.length > 1) count('columns')
  const gridType = GRID_TYPES[st.gridType] ?? 'default'
  if (gridType === 'linesAndChars' || gridType === 'snapToChars') count('charGrid')
  if (st.lineNumbers) count('lineNumbers')
  if (st.textFlow !== 0) count('textDirection')
  return {
    pageWidth: st.pageWidth / TWIP,
    pageHeight: st.pageHeight / TWIP,
    marginTop: Math.abs(st.top) / TWIP,
    marginRight: st.right / TWIP,
    marginBottom: Math.abs(st.bottom) / TWIP,
    marginLeft: st.left / TWIP,
    header: st.header / TWIP,
    footer: st.footer / TWIP,
    gutter: st.gutter / TWIP,
    columns,
    gridType,
    linePitch: st.linePitch / TWIP,
    start: SECTION_STARTS[st.start] ?? 'nextPage',
    titlePage: st.titlePage,
    numberFormat: PAGE_NUMBER_FORMATS[st.numberFormat] ?? 'decimal',
    numberStart: st.restart ? st.numberStart : null,
    headers: NO_PARTS,
    footers: NO_PARTS,
    pageBorders: pageBorders(st, count),
  }
}

/** 页面边框：`sprmSPgbProp` 的低 3 位为显示范围，第 5–7 位为距离基准（1 为页面边缘，其余为正文）。 */
function pageBorders(st: SepState, count: (kind: UnsupportedKind) => void): PageBorders | null {
  const side = (b: SepState['borders']['top']) => {
    if (b == null) return null
    if (b.style !== 'art') return { ...b }
    count('artBorder')
    return { ...b, style: 'single' }
  }
  const display = st.borderOptions & 7
  const out: PageBorders = {
    top: side(st.borders.top),
    left: side(st.borders.left),
    bottom: side(st.borders.bottom),
    right: side(st.borders.right),
    offsetFrom: ((st.borderOptions >> 5) & 7) === 1 ? 'page' : 'text',
    display: display === 1 ? 'firstPage' : display === 2 ? 'notFirstPage' : 'allPages',
  }
  return out.top || out.left || out.bottom || out.right ? out : null
}

/** 第一遍：按字符位置切分段落，取段落与字符的直接格式。 */
class TextReader {
  constructor(
    private readonly text: DocText,
    private readonly pieces: readonly Piece[],
    private readonly chpx: FkpIndex,
    private readonly papx: FkpIndex,
    private readonly data: Uint8Array | null,
    private readonly fonts: readonly string[],
    private readonly sectionEnds: readonly number[],
  ) {}

  /**
   * 字符区间 `[from, to)` 中的段落。`section` 为 `null` 时按正文中各节的结束位置确定所在节，否则全部属于该节
   * （页眉页脚的部分）。
   */
  paragraphs(from: number, to: number, section: number | null): RawParagraph[] {
    const out: RawParagraph[] = []
    const s = this.text.text
    const ends = new Set(this.sectionEnds)
    let index = 0
    let start = from
    const current = (cp: number) => {
      if (section !== null) return section
      while (index < this.sectionEnds.length - 1 && cp >= this.sectionEnds[index]!) index++
      return index
    }
    for (let cp = from; cp < to; cp++) {
      const at = current(cp)
      const c = s.charCodeAt(cp)
      if (c === PARAGRAPH_MARK || c === CELL_MARK || (c === SECTION_MARK && ends.has(cp + 1))) {
        out.push(this.paragraph(start, cp, c === CELL_MARK, at, true))
        start = cp + 1
      }
    }
    if (start < to) out.push(this.paragraph(start, to, false, current(to - 1), false))
    return out
  }

  /**
   * `closed` 为假时 `mark` 是区间末尾而不是段落标记：段落属性取最后一个字符处的 PAPX、不取片段的属性修改，段落标记没有
   * 直接格式。
   */
  private paragraph(
    start: number,
    mark: number,
    cell: boolean,
    section: number,
    closed: boolean,
  ): RawParagraph {
    const fc = (closed ? this.text.fc[mark] : undefined) ?? this.text.fc[mark - 1] ?? -1
    const bytes = this.papx.at(fc).bytes
    const istd = bytes.length >= 2 ? u16(bytes) : 0
    let pap = emptyPap(istd)
    for (const sp of readSprms(bytes.subarray(2))) applyPap(sp, pap)
    const huge = pap.huge
    if (huge !== null && this.data !== null && huge + 2 <= this.data.length) {
      pap = emptyPap(istd)
      const end = Math.min(this.data.length, huge + 2 + u16(this.data, huge))
      for (const sp of readSprms(this.data.subarray(huge + 2, end))) applyPap(sp, pap)
    }
    if (closed)
      for (const sp of this.prm(mark)) if (((sp.op >> 10) & 7) !== SGC_CHARACTER) applyPap(sp, pap)
    const runs: RawRun[] = []
    let runStart = start
    let key = ''
    for (let cp = start; cp < mark; cp++) {
      const k = this.key(cp)
      if (cp > start && k !== key) {
        runs.push({ start: runStart, end: cp, chp: this.chp(runStart) })
        runStart = cp
      }
      key = k
    }
    if (mark > runStart) runs.push({ start: runStart, end: mark, chp: this.chp(runStart) })
    return { start, mark, cell, pap, runs, markChp: closed ? this.chp(mark) : emptyChp(), section }
  }

  private prm(cp: number): Sprm[] {
    const prm = this.pieces[this.text.piece[cp] ?? -1]?.prm
    return prm ? readSprms(prm) : []
  }

  /** 字符属性的来源：CHPX 与所在片段。来源相同的字符直接格式相同。 */
  private key(cp: number): string {
    return `${this.chpx.at(this.text.fc[cp] ?? -1).key}:${this.text.piece[cp]}`
  }

  private chp(cp: number): ChpState {
    const st = emptyChp()
    const fc = this.text.fc[cp]
    if (fc === undefined) return st
    for (const sp of readSprms(this.chpx.at(fc).bytes)) applyChp(sp, st, this.fonts)
    for (const sp of this.prm(cp))
      if (((sp.op >> 10) & 7) === SGC_CHARACTER) applyChp(sp, st, this.fonts)
    return st
  }
}

/** 段落在表格中的嵌套深度。 */
function depthOf(p: RawParagraph): number {
  return p.pap.itap ?? (p.pap.inTable ? 1 : 0)
}

/**
 * 第二遍：按嵌套深度把段落组织为正文、表格、行与单元格。相邻的表格行属于同一表格；缺少行结束段落的行没有表格属性。
 */
function buildBlocks(paragraphs: readonly RawParagraph[]): RawBlock[] {
  let i = 0
  const rowEnd = (p: RawParagraph, depth: number) => (depth > 1 ? p.pap.innerTtp : p.pap.ttp)
  const cellEnd = (p: RawParagraph, depth: number) => (depth > 1 ? p.pap.innerCell : p.cell)
  const blocks = (depth: number, cell: boolean): RawBlock[] => {
    const out: RawBlock[] = []
    while (i < paragraphs.length) {
      const p = paragraphs[i]!
      const d = depthOf(p)
      if (d < depth || (cell && d === depth && rowEnd(p, depth))) break
      if (d > depth) {
        out.push(tableAt(depth + 1))
        continue
      }
      i++
      out.push({ kind: 'paragraph', p })
      if (cell && cellEnd(p, depth)) break
    }
    return out
  }
  const tableAt = (depth: number): RawBlock => {
    const rows: RawRow[] = []
    const section = paragraphs[i]!.section
    while (i < paragraphs.length && depthOf(paragraphs[i]!) >= depth) {
      const cells: RawBlock[][] = []
      let tap: readonly Sprm[] = []
      while (i < paragraphs.length && depthOf(paragraphs[i]!) >= depth) {
        const p = paragraphs[i]!
        if (depthOf(p) === depth && rowEnd(p, depth)) {
          tap = p.pap.tap
          i++
          break
        }
        const before = i
        cells.push(blocks(depth, true))
        if (i === before) i++
      }
      rows.push({ tap, cells })
    }
    return { kind: 'table', rows, section }
  }
  return blocks(0, false)
}

interface Field {
  result: boolean
  instr: string
  /** 结果部分已有显示的文字。 */
  shown: boolean
}

/** 第三遍：按文档顺序解决段落与字段属性、生成编号，得到 `../parse/body.ts` 的待解决块。 */
class BlockBuilder {
  private readonly fields: Field[] = []

  /** `story`：页眉页脚的部分（页码域由分页按页生成，不计入 `dynamicField`）。 */
  constructor(
    private readonly resolver: Resolver,
    private readonly styles: Styles,
    private readonly text: string,
    private readonly count: (kind: UnsupportedKind) => void,
    private readonly pictures: PictureSource,
    private readonly story: boolean,
    private readonly drawings: DrawingSource,
  ) {}

  block(b: RawBlock, layer: TableLayer | null): Pending {
    if (b.kind === 'paragraph') return { kind: 'paragraph', p: this.paragraph(b.p, layer) }
    return { kind: 'table', t: this.table(b.rows) }
  }

  private table(rows: readonly RawRow[]): PendingTable {
    const first = rows.find((r) => r.tap.length > 0)?.tap ?? []
    const styleId = readTap(first, {}).table.style ?? this.styles.defaultTableStyle
    const chain = tableStyleChain(this.styles, styleId)
    const layer: TableLayer = { pPr: chain.whole.pPr, rPr: chain.whole.rPr }
    const taps = rows.map((r) => readTap(r.tap, chain.whole.tblPr))
    // 横向合并的后续单元格并入其前的单元格。
    const merged = taps.map((tap) => {
      const out: { left: number; right: number; index: number; tap: (typeof tap.cells)[number] }[] =
        []
      tap.cells.forEach((c, index) => {
        const prev = out[out.length - 1]
        if (c.merged && prev !== undefined) prev.right = c.right
        else out.push({ left: c.left, right: c.right, index, tap: c })
        if (c.textFlow) this.count('textDirection')
        if (c.fitText) this.count('fitText')
      })
      return out
    })
    const bounds = [...new Set(merged.flatMap((cells) => cells.flatMap((c) => [c.left, c.right])))]
    bounds.sort((a, b) => a - b)
    const column = (x: number) => Math.max(0, bounds.indexOf(x))
    const grid = bounds.slice(1).map((x, k) => (x - bounds[k]!) / TWIP)
    const pendingRows: PendingRow[] = rows.map((row, r) => {
      const cells = merged[r]!
      const firstCell = cells[0]
      const pending: PendingCell[] = []
      let content = 0
      for (const [k, c] of cells.entries()) {
        const blocks: Pending[] = []
        const end = k + 1 < cells.length ? cells[k + 1]!.index : Number.POSITIVE_INFINITY
        // 合并到本单元格的各单元格的内容依次并入。
        while (content < row.cells.length && content < end) {
          for (const b of row.cells[content]!) blocks.push(this.block(b, layer))
          content++
        }
        pending.push({
          props: { ...c.tap.props, span: Math.max(1, column(c.right) - column(c.left)) },
          format: null,
          content: blocks,
        })
      }
      // 内容多于表格属性中的单元格时，其余内容各为一个单元格。
      while (content < row.cells.length) {
        pending.push({
          props: {},
          format: null,
          content: row.cells[content]!.map((b) => this.block(b, layer)),
        })
        content++
      }
      return {
        props: {
          ...taps[r]!.row,
          gridBefore: firstCell === undefined ? 0 : column(firstCell.left),
        },
        cells: pending,
      }
    })
    return { props: taps[0]?.table ?? {}, chain, grid, rows: pendingRows }
  }

  private hidden(): boolean {
    return this.fields.some((f) => !f.result)
  }

  private fieldName(): string | null {
    const f = this.fields.at(-1)
    return f === undefined || !f.result ? null : fieldNameOf(f.instr)
  }

  /** 直接格式：目录域结果中去掉超链接字符样式，操作数为 128、129 的切换属性按样式求值。 */
  private direct(ctx: ParagraphContext, chp: ChpState): RawRunProps {
    let raw: RawRunProps = { ...chp.props }
    if (this.fields.some((f) => f.result && fieldNameOf(f.instr) === 'TOC'))
      raw = withoutHyperlinkStyle(raw, this.styles)
    if (chp.relative.size === 0) return raw
    const styled = this.resolver.effectiveRun(ctx, raw)
    for (const [k, negate] of chp.relative) raw[k] = negate !== (styled[k] === true)
    return raw
  }

  private paragraph(p: RawParagraph, layer: TableLayer | null): PendingParagraph {
    const r = this.resolver
    const ctx = r.paragraph(p.pap.props, layer)
    const runs: Run[] = []
    const images: InlineImage[] = []
    const anchors: PendingParagraph['anchors'][number][] = []
    /** 已输出的文字长度：浮动对象在段落文字中的位置。 */
    let length = 0
    let first: FirstContent | null = null
    const note = (props: RunProps, object: boolean) => {
      first ??= { props, object }
    }
    let last: Run | null = null
    const push = (text: string, props: RunProps) => {
      const field = this.fieldName()
      const f = this.fields.at(-1)
      if (f !== undefined) f.shown = true
      length += text.length
      if (last !== null && last.props === props && last.field === field) {
        last = { text: last.text + text, props, field }
        runs[runs.length - 1] = last
        return
      }
      last = { text, props, field }
      runs.push(last)
    }
    const cell = layer !== null
    for (const run of p.runs) {
      let eff: RawRunProps | null = null
      let props: RunProps | null = null
      let counted = false
      const resolved = () => {
        eff ??= r.effectiveRun(ctx, this.direct(ctx, run.chp))
        props ??= r.runProps(eff)
        return { eff, props }
      }
      if (run.chp.deleted || run.chp.inserted) this.count('revision')
      for (let cp = run.start; cp < run.end; cp++) {
        const c = this.text.charCodeAt(cp)
        if (c === FIELD_BEGIN) {
          this.fields.push({ result: false, instr: '', shown: false })
          continue
        }
        if (c === FIELD_SEPARATOR) {
          const f = this.fields.at(-1)
          if (f !== undefined && !f.result) {
            f.result = true
            if (!this.hidden() && dynamicField(f.instr, this.story)) this.count('dynamicField')
          }
          continue
        }
        if (c === FIELD_END) {
          const f = this.fields.pop()
          if (f !== undefined && !this.hidden() && !f.shown) {
            const name = fieldNameOf(f.instr)
            if (PAGE_FIELDS.has(name)) {
              const placeholder = r.runProps(r.effectiveRun(ctx, {}))
              note(placeholder, false)
              runs.push({ text: '', props: placeholder, field: name })
              last = null
            }
          }
          continue
        }
        if (this.hidden()) {
          const f = this.fields.at(-1)
          if (f !== undefined && !f.result) f.instr += String.fromCharCode(c)
          continue
        }
        if (run.chp.deleted) continue
        const shown = this.character(c, run.chp, cell)
        if (shown === null) continue
        const own = resolved()
        if (shown === '') {
          note(own.props, true)
          if (c === 0x01) {
            const image = this.picture(run.chp, own.eff.vanish === true, runs.length, own.props)
            if (image !== null) images.push(image)
          } else if (c === 0x08) {
            const anchor = this.drawings(cp)
            if (anchor === null) this.count('drawing')
            else if (own.eff.vanish !== true) anchors.push({ offset: length, anchor })
          }
          last = null
          continue
        }
        note(own.props, false)
        if (own.eff.vanish === true) continue
        if (!counted) {
          counted = true
          countRunEffects(own.eff, this.count)
        }
        const symbol = run.chp.symbol
        if (symbol !== null && c === 0x28) {
          const font = { name: symbol.font }
          const props = r.runProps({
            ...own.eff,
            ascii: font,
            hAnsi: font,
            eastAsia: font,
            cs: font,
          })
          push(String.fromCharCode(symbol.char), props)
        } else push(shown, own.props)
      }
    }
    const markRaw = r.effectiveRun(ctx, this.direct(ctx, p.markChp))
    const numbering = paragraphNumbering(r, ctx, markRaw)
    countParagraph(ctx.pPr, this.count)
    return {
      ctx,
      runs,
      mark: r.runProps(markRaw),
      hiddenMark: !p.cell && markRaw.vanish === true,
      numbering,
      first,
      images,
      anchors,
    }
  }

  /**
   * 图片字符（0x01）：对象框取 PICF 的显示尺寸，`run` 为其后第一个字段的下标。与 docx 的嵌入式对象相同，字段隐藏、没有 PICF
   * 或图片无法读取时计数（嵌入对象计入 `ole`，其余计入 `picture`），隐藏时不占位置；没有图片数据的只占对象框，不计数。
   */
  private picture(
    chp: ChpState,
    vanish: boolean,
    run: number,
    props: RunProps,
  ): InlineImage | null {
    const kind: UnsupportedKind =
      chp.ole || this.fields.some((f) => fieldNameOf(f.instr) === 'EMBED') ? 'ole' : 'picture'
    const pic = vanish || chp.picture === null ? null : this.pictures(chp.picture)
    if (pic === null || (pic.media < 0 && !pic.empty)) this.count(kind)
    if (pic === null) return null
    return {
      run,
      raise: props.position,
      media: pic.media,
      graphic: null,
      width: pic.width,
      height: pic.height,
      effect: { left: 0, top: 0, right: 0, bottom: 0 },
      crop: ZERO_RECT,
    }
  }

  /**
   * 字符的显示文字：`null` 为不显示，空串为对象（嵌入式图片与嵌入对象见 `picture`，浮动对象见 `drawing.ts`）。
   * 0x0B 为换行，0x0C 为分页符、0x0E 为分栏符（单元格中都不显示），0x1E 为不间断连字符，0x1F 为可选连字符（不显示，计数）。
   */
  private character(c: number, chp: ChpState, cell: boolean): string | null {
    if (chp.special) {
      if (c === 0x01 || c === 0x08) return ''
      if (c < 0x20) return null
    }
    switch (c) {
      case 0x09:
        return '\t'
      case 0x0b:
        return '\n'
      case 0x0c:
        return cell ? null : '\f'
      case 0x0e:
        return cell ? null : '\v'
      case 0x1e:
        return '‑'
      case 0x1f:
        this.count('softHyphen')
        return null
    }
    return c < 0x20 ? null : String.fromCharCode(c)
  }
}
