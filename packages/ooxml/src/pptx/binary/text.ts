/**
 * .ppt 的文字：形状客户文本框中的文字记录（占位符经 OutlineTextRefAtom 引用 SlideListWithText 中的文字），
 * 换算为 DrawingML 的文字规格后由 `resolveTextBody` 解决为 `TextBody`。
 *
 * - 一组文字记录以 TextHeaderAtom（文字类型）开始，文字取 TextCharsAtom（UTF-16）或 TextBytesAtom（每字节为一个码元的低 8 位）。
 *   段落以 U+000D 分隔，U+000B 为换行；StyleTextPropAtom 先列段落属性段、后列字符属性段，各段的字符数之和为文字长度加 1
 *   （末段落的结束符）。段落属性段以段落为单位，含缩进层级。
 * - 样式链（优先级从高到低）：字符与段落属性段、TextRulerAtom（各层级的左边距与首行缩进、制表位），其下按母版是否带
 *   RoundTrip 文字样式（`TextScope.drawingml`）分两种，同一份文件只用其中一种：
 *   - 没有：母版中该文字类型的 TextMasterStyleAtom、其基础类型（居中正文、半正文、四分之一正文为正文，居中标题为标题）、
 *     文档的缺省样式（DocumentTextInfoContainer 中的 TextMasterStyleAtom 与 TextCFExceptionAtom、TextPFExceptionAtom）。
 *   - 有：显式层之下为母版中派生类型（居中正文、居中标题、半正文、四分之一正文）的 TextMasterStyleAtom，再经 DrawingML 的
 *     继承链求值：标题与正文类型（含派生类型）取 RoundTrip 文字样式的标题与正文样式，占位符另取母版的同类占位符；其他类型
 *     取 `defaultTextStyle`（文档的缺省样式，`documentTextStyle`）。母版中正文、标题与其他类型的 TextMasterStyleAtom 不参与。
 *     WPS 演示实测（zju-ppt-009 原地改写的核对文件）：母版中正文、标题与其他类型的 TextMasterStyleAtom 改为不同的字号、颜色、
 *     对齐、行距、段前、左边距与项目符号后，占位符文字不变；半正文的字号随之改变；文档的 TextMasterStyleAtom 改变后
 *     其他类型的文字随之改变。不是占位符的正文类型文字（zju-ppt-021 第 11 页）显示正文样式的项目符号。
 *   各层只记录出现的字段。DrawingML 的首行缩进相对左边距；显式层只给出左边距与首行缩进之一时，另一个取继承链的
 *   绝对位置（WPS 演示实测：zju-ppt-000 的正文段落只写出左边距 0，母版的首行在 0、其余行在 0.375 英寸，WPS 首行在 0）。
 *   显式层给出项目符号字符而没有给出是否显示时，按继承链是否显示项目符号（zju-ppt-021 第 34 页的「❖」「✓」）；显式层要求
 *   显示项目符号而没有给出字符、继承链又不显示时，字符为「•」（U+2022，WPS 演示实测：zju-ppt-001 第 65 页其他类型的文本框）。
 * - 单位：边距与缩进为主单位（乘 `EMU_PER_MASTER`）；行距与段前段后为非负时是行高的百分数，为负时是主单位的绝对值（÷8 为磅）；
 *   字号为磅；上下标偏移为百分数。DrawingML 的首行缩进相对左边距，换算为 `indent − leftMargin`。
 * - 段落的换行标志：`charWrap` 为东亚文字按字符换行（`eaLineBreak`），`wordWrap` 为西文按词换行（为假时西文可在词中换行，
 *   `latinLineBreak`），`overflow` 为标点溢出边界（`hangingPunctuation`）。WPS 演示实测：三者都为真的段落中西文不在词中换行、
 *   句末标点溢出右边界。
 * - 颜色（ColorIndexStruct）：第 4 字节为 0xFE 时取前 3 字节的 RGB，0–7 为配色方案序号。
 * - 字体序号指向 FontCollection 中的 FontEntityAtom（记录实例为序号）：`fontRef` 为西文字体，`oldEAFontRef` 为东亚字体，
 *   `symbolFontRef` 为符号字体；西文字体的字符集为 FontEntityAtom 的 `lfCharSet`（按有符号字节记录）。
 * - 字段：元字符记录所指位置的字符（文件中为「*」）为字段，文字为空串（页码为幻灯片编号）：SlideNumberMCAtom 为页码；
 *   DateTimeMCAtom 为第 4 字节的格式序号加 1 的日期字段（序号 0 为 `datetime1`）；GenericDateMCAtom 的格式取所在幻灯片的
 *   HeadersFootersAtom（`TextScope.date`），显示当天日期时为日期字段，否则为用户输入的日期文字；RTFDateTimeMCAtom 为
 *   `datetime`；HeaderMCAtom、FooterMCAtom 为页眉、页脚。日期字段与 pptx 相同按绘制时传入的日期显示（WPS 演示实测：
 *   经核对的 zju-ppt-021/022 各页为采集当天的「2026-11-3」）。页眉页脚的文字语料中没有，不读取。
 * - 语言：TextSpecialInfoAtom 中的语言标识，中日韩语言写入字段的 `lang`（与东亚文字共用的字符如引号按东亚字体排版，
 *   见 `../../drawingml/text/body.ts`）。WPS 演示实测：经核对的 12 份中 10 页因此上升、没有下降。
 * - 超链接：TxInteractiveInfoAtom 给出字符区间 [起点, 终点)，其前的 InteractiveInfo 中动作不为 0 时该区间为超链接（`link` 为目标，
 *   见 `TextScope.hyperlinks`），由 `resolveTextBody` 按超链接色与单下划线显示；动作为 0 的区间不是超链接（WPS 演示实测）。
 * - 自动编号：形状客户数据中 PP9 标签（ProgBinaryTag 名为 `___PPT9`）的 StyleTextProp9Atom 各项依次对应字符属性段的分组：
 *   CFStyle 的 `pp9rt`（第 10–13 位；没有该字段为另一种取值）与前一段不同时开始新的一组，第 k 组对应第 k 项，超出项数时取
 *   最后一项。段落取其起点所在字符属性段的项；该项 `fBulletHasAutoNumber` 为 1 且段落有项目符号时，项目符号为该项的编号方案与
 *   起始编号（没有方案时为 `arabicPeriod` 从 1 起）。不要按 `pp9rt` 的值作为项的序号：WPS 演示实测（zju-ppt-036 第 9 页原地
 *   改写，第 2 段的 `pp9rt` 由 1 改为 0）编号不变。真值：zju-ppt-010 第 27 页方案 1 为「A.」，zju-ppt-021 第 1 页方案 38
 *   为「一．」；zju-ppt-013 第 1 页 7 项对应 7 组字符属性段（6 个段落属性段）。编号按文字的字体绘制，不取段落属性中的项目符号
 *   字体（WPS 演示实测：zju-ppt-020 第 5 页项目符号字体为 Wingdings 2，编号「1.」按文字的黑体显示）；颜色与字号仍取段落
 *   属性。
 * - 能力边界：文字阴影与浮雕计入 `effect`。
 */

import type { Color, ColorContext, ColorScheme } from '../../drawingml/color.ts'
import type { Spacing, TextBody } from '../../drawingml/text/model.ts'
import type {
  BodySpec,
  ListStyleSpec,
  ParagraphSpec,
  RawParagraph,
  RawRun,
  RawTextBody,
  RunSpec,
  TabStop,
} from '../../drawingml/text/read.ts'
import { resolveTextBody } from '../../drawingml/text/resolve.ts'
import { EMPTY_THEME } from '../../drawingml/theme.ts'
import { type ArtProperties, type ArtRecord, readArtRecords } from '../../officeart/records.ts'
import { languageTag } from '../../text/index.ts'
import type { Placeholder, UnsupportedKind } from '../model.ts'
import type { ShapeResolver } from '../resolve/shape.ts'
import { child, children, EMU_PER_MASTER, Fields, RT } from './records.ts'

const TEXT_CF_EXCEPTION_ATOM = 0x0fa4
const TEXT_PF_EXCEPTION_ATOM = 0x0fa5
const TEXT_RULER_ATOM = 0x0fa6
const STYLE_TEXT_PROP9_ATOM = 0x0fac
const PROG_BINARY_TAG = 0x138a
const BINARY_TAG_DATA = 0x138b
const PP9_TAG = '___PPT9'
/** 元字符记录的类型对应的字段类型（DateTimeMCAtom 与 GenericDateMCAtom 见 `fieldOf`）。 */
const META_FIELDS: ReadonlyMap<number, string> = new Map([
  [0x0fd8, 'slidenum'],
  [0x1015, 'datetime'],
  [0x0ff9, 'header'],
  [0x0ffa, 'footer'],
])
const DATE_TIME_MC_ATOM = 0x0ff7
const GENERIC_DATE_MC_ATOM = 0x0ff8
const HEADERS_FOOTERS_ATOM = 0x0fda
const HAS_TODAY_DATE = 0x2

/** GenericDateMCAtom 显示的内容：日期字段的类型，或用户输入的日期文字。 */
export type GenericDate = { readonly field: string } | { readonly text: string }

/**
 * HeadersFootersContainer 给出的 GenericDateMCAtom 的内容：HeadersFootersAtom 的 `fHasTodayDate` 为真时为第 0 字节的格式序号
 * 加 1 的日期字段，否则为实例 0 的 CString（没有时为空串）。没有容器时为 `datetime1`。
 */
export function genericDate(container: ArtRecord | null): GenericDate {
  const atom = container === null ? null : child(container, HEADERS_FOOTERS_ATOM)
  if (container === null || atom === null) return { field: 'datetime1' }
  const f = new Fields(atom.data)
  if (f.u16(2) & HAS_TODAY_DATE) return { field: `datetime${f.i16(0) + 1}` }
  const user = child(container, RT.CSTRING, 0)
  return { text: user === null ? '' : utf16z(user.data, user.data.length) }
}

/** 文字类型的基础类型：居中正文、半正文、四分之一正文为正文（1），居中标题为标题（0）。 */
const BASE_TYPE: Readonly<Record<number, number>> = { 5: 1, 6: 0, 7: 1, 8: 1 }

/** 文字类型（含基础类型）对应的 DrawingML 母版文字样式类别；其余类型为 `other`。 */
function styleKind(type: number): 'title' | 'body' | 'other' {
  const t = BASE_TYPE[type] ?? type
  return t === 0 ? 'title' : t === 1 ? 'body' : 'other'
}

export interface FontEntity {
  readonly name: string
  /** `lfCharSet`。 */
  readonly charset: number
}

/** 段落属性（TextPFException）：只含出现的字段，颜色为 ColorIndexStruct 原值。 */
interface Pf {
  hasBullet?: boolean
  bulletHasFont?: boolean
  bulletHasColor?: boolean
  bulletHasSize?: boolean
  bulletChar?: number
  bulletFont?: number
  bulletSize?: number
  bulletColor?: number
  align?: number
  lineSpacing?: number
  spaceBefore?: number
  spaceAfter?: number
  leftMargin?: number
  indent?: number
  defaultTabSize?: number
  tabs?: TabStop[]
  fontAlign?: number
  charWrap?: boolean
  wordWrap?: boolean
  overflow?: boolean
}

/** 字符属性（TextCFException）。 */
interface Cf {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  shadow?: boolean
  emboss?: boolean
  font?: number
  eaFont?: number
  symbolFont?: number
  size?: number
  color?: number
  position?: number
  /** StyleTextProp9Atom 的项序号。 */
  pp9rt?: number
}

/** 顺序读取记录数据；越界的字段为 0。 */
class Cursor {
  readonly f: Fields
  p: number
  constructor(data: Uint8Array, start = 0) {
    this.f = new Fields(data)
    this.p = start
  }
  u16(): number {
    const v = this.f.u16(this.p)
    this.p += 2
    return v
  }
  i16(): number {
    const v = this.f.i16(this.p)
    this.p += 2
    return v
  }
  u32(): number {
    const v = this.f.u32(this.p)
    this.p += 4
    return v
  }
  get done(): boolean {
    return this.p >= this.f.length
  }
}

const TAB_ALIGN = ['l', 'ctr', 'r', 'dec']

function readTabs(c: Cursor): TabStop[] {
  const count = c.u16()
  const out: TabStop[] = []
  for (let i = 0; i < count && !c.done; i++) {
    const position = c.i16() * EMU_PER_MASTER
    out.push({ position, align: TAB_ALIGN[c.u16()] ?? 'l' })
  }
  return out
}

function readPf(c: Cursor): Pf {
  const m = c.u32()
  const pf: Pf = {}
  if (m & 0x0f) {
    const flags = c.u16()
    if (m & 0x1) pf.hasBullet = (flags & 0x1) !== 0
    if (m & 0x2) pf.bulletHasFont = (flags & 0x2) !== 0
    if (m & 0x4) pf.bulletHasColor = (flags & 0x4) !== 0
    if (m & 0x8) pf.bulletHasSize = (flags & 0x8) !== 0
  }
  if (m & 0x80) pf.bulletChar = c.u16()
  if (m & 0x10) pf.bulletFont = c.u16()
  if (m & 0x40) pf.bulletSize = c.i16()
  if (m & 0x20) pf.bulletColor = c.u32()
  if (m & 0x800) pf.align = c.u16()
  if (m & 0x1000) pf.lineSpacing = c.i16()
  if (m & 0x2000) pf.spaceBefore = c.i16()
  if (m & 0x4000) pf.spaceAfter = c.i16()
  if (m & 0x100) pf.leftMargin = c.i16()
  if (m & 0x400) pf.indent = c.i16()
  if (m & 0x8000) pf.defaultTabSize = c.u16()
  if (m & 0x100000) pf.tabs = readTabs(c)
  if (m & 0x10000) pf.fontAlign = c.u16()
  if (m & 0xe0000) {
    const wrap = c.u16()
    if (m & 0x20000) pf.charWrap = (wrap & 0x1) !== 0
    if (m & 0x40000) pf.wordWrap = (wrap & 0x2) !== 0
    if (m & 0x80000) pf.overflow = (wrap & 0x4) !== 0
  }
  if (m & 0x200000) c.u16()
  return pf
}

function readCf(c: Cursor): Cf {
  const m = c.u32()
  const cf: Cf = {}
  if (m & 0xffff) {
    const style = c.u16()
    if (m & 0x1) cf.bold = (style & 0x1) !== 0
    if (m & 0x2) cf.italic = (style & 0x2) !== 0
    if (m & 0x4) cf.underline = (style & 0x4) !== 0
    if (m & 0x10) cf.shadow = (style & 0x10) !== 0
    if (m & 0x200) cf.emboss = (style & 0x200) !== 0
    if (m & 0x3c00) cf.pp9rt = (style >> 10) & 0xf
  }
  if (m & 0x10000) cf.font = c.u16()
  if (m & 0x200000) cf.eaFont = c.u16()
  if (m & 0x400000) c.u16()
  if (m & 0x800000) cf.symbolFont = c.u16()
  if (m & 0x20000) cf.size = c.u16()
  if (m & 0x40000) cf.color = c.u32()
  if (m & 0x80000) cf.position = c.i16()
  if (m & 0x100000) c.u32()
  if (m & 0x1000000) c.u16()
  if (m & 0x2000000) c.u16()
  if (m & 0x4000000) c.u32()
  return cf
}

interface StyleLevel {
  readonly pf: Pf
  readonly cf: Cf
}

/** 一种文字类型的各层级样式（下标为层级）。 */
type MasterStyle = readonly (StyleLevel | null)[]

/** TextMasterStyleAtom：实例为文字类型；实例不小于 5 时每个层级前有层级号。 */
function readMasterStyle(r: ArtRecord): MasterStyle {
  const c = new Cursor(r.data)
  const count = c.u16()
  const out: (StyleLevel | null)[] = []
  for (let i = 0; i < count && !c.done; i++) {
    const level = r.instance >= 5 ? c.u16() : i
    const pf = readPf(c)
    const cf = readCf(c)
    out[level] = { pf, cf }
  }
  return out
}

/** 容器中各文字类型的 TextMasterStyleAtom。 */
export function readMasterStyles(container: ArtRecord): Map<number, MasterStyle> {
  const out = new Map<number, MasterStyle>()
  for (const r of children(container)) {
    if (r.type === RT.TEXT_MASTER_STYLE_ATOM) out.set(r.instance, readMasterStyle(r))
  }
  return out
}

/** 文档级的文字缺省：DocumentTextInfoContainer 中的字体表、TextMasterStyleAtom 与缺省的字符、段落属性。 */
export interface TextDefaults {
  readonly fonts: ReadonlyMap<number, FontEntity>
  readonly styles: ReadonlyMap<number, MasterStyle>
  readonly cf: Cf
  readonly pf: Pf
}

function utf16z(data: Uint8Array, length: number): string {
  let s = ''
  for (let i = 0; i + 1 < Math.min(length, data.length); i += 2) {
    const c = data[i]! | (data[i + 1]! << 8)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

export function readTextDefaults(doc: ArtRecord): TextDefaults {
  const env = child(doc, RT.ENVIRONMENT)
  const fonts = new Map<number, FontEntity>()
  const collection = env === null ? null : child(env, RT.FONT_COLLECTION)
  for (const r of collection === null ? [] : children(collection)) {
    if (r.type !== RT.FONT_ENTITY_ATOM) continue
    fonts.set(r.instance, { name: utf16z(r.data, 64), charset: r.data[64] ?? 0 })
  }
  const cfAtom = env === null ? null : child(env, TEXT_CF_EXCEPTION_ATOM)
  const pfAtom = env === null ? null : child(env, TEXT_PF_EXCEPTION_ATOM)
  return {
    fonts,
    styles: env === null ? new Map() : readMasterStyles(env),
    cf: cfAtom === null ? {} : readCf(new Cursor(cfAtom.data)),
    pf: pfAtom === null ? {} : readPf(new Cursor(pfAtom.data, 2)),
  }
}

/** 文字所在幻灯片的上下文。 */
export interface TextScope {
  readonly defaults: TextDefaults
  /** 母版（标题母版取其主母版）的各文字类型样式。 */
  readonly master: ReadonlyMap<number, MasterStyle>
  readonly scheme: readonly Color[]
  readonly slideNumber: number
  /** 超链接的目标，按编号（`PptDocument.hyperlinks`）。 */
  readonly hyperlinks: ReadonlyMap<number, string>
  readonly found: UnsupportedKind[]
  /** 母版带 RoundTrip 文字样式时为所在幻灯片的 DrawingML 求值器（见文件头的样式链），否则为 `null`。 */
  readonly drawingml: ShapeResolver | null
  /** GenericDateMCAtom 的内容（`genericDate`）。 */
  readonly date: GenericDate
}

/** 字体与颜色换算所用的上下文。 */
type SpecScope = Pick<TextScope, 'defaults' | 'scheme'>

function colorOf(value: number, scope: SpecScope): Color | null {
  const index = value >>> 24
  if (index === 0xfe) {
    return {
      r: (value & 0xff) / 255,
      g: ((value >> 8) & 0xff) / 255,
      b: ((value >> 16) & 0xff) / 255,
      a: 1,
    }
  }
  return scope.scheme[index] ?? null
}

function spacing(v: number): Spacing {
  return v >= 0 ? { unit: 'percent', value: v / 100 } : { unit: 'points', value: -v / 8 }
}

const ALIGN = ['l', 'ctr', 'r', 'just', 'dist', 'thaiDist', 'justLow']
const FONT_ALIGN = ['base', 't', 'ctr', 'b']

/**
 * 字符属性中出现的字段换算为字段规格。文字效果总是写为空：旧格式记录的文字阴影与浮雕计入 `effect`，不取继承链中的
 * DrawingML 文字效果（WPS 演示实测：zju-ppt-013 第 19 页 RoundTrip 正文样式带外部阴影，旧格式正文文字不显示阴影）。
 */
function runSpec(cf: Cf, scope: SpecScope): RunSpec {
  const out: { -readonly [K in keyof RunSpec]: RunSpec[K] } = { effects: [] }
  if (cf.bold !== undefined) out.bold = cf.bold
  if (cf.italic !== undefined) out.italic = cf.italic
  if (cf.underline !== undefined) out.underline = cf.underline ? 'sng' : 'none'
  if (cf.size !== undefined) out.size = cf.size
  if (cf.position !== undefined) out.baseline = cf.position / 100
  const font = (ref: number | undefined) =>
    ref === undefined ? undefined : scope.defaults.fonts.get(ref)
  const latin = font(cf.font)
  if (latin !== undefined) {
    out.latin = latin.name
    out.latinCharset = (latin.charset << 24) >> 24
  }
  const ea = font(cf.eaFont)
  if (ea !== undefined) out.ea = ea.name
  const sym = font(cf.symbolFont)
  if (sym !== undefined) out.sym = sym.name
  if (cf.color !== undefined) {
    const c = colorOf(cf.color, scope)
    if (c !== null) out.fill = { kind: 'solid', color: { kind: 'rgb', color: c, transforms: [] } }
  }
  return out
}

/** TextAutoNumberSchemeEnum 的取值（下标）对应的 DrawingML 编号方案。 */
const NUMBER_SCHEMES = [
  'alphaLcPeriod',
  'alphaUcPeriod',
  'arabicParenR',
  'arabicPeriod',
  'romanLcParenBoth',
  'romanLcParenR',
  'romanLcPeriod',
  'romanUcPeriod',
  'alphaLcParenBoth',
  'alphaLcParenR',
  'alphaUcParenBoth',
  'alphaUcParenR',
  'arabicParenBoth',
  'arabicPlain',
  'romanUcParenBoth',
  'romanUcParenR',
  'ea1ChsPlain',
  'ea1ChsPeriod',
  'circleNumDbPlain',
  'circleNumWdWhitePlain',
  'circleNumWdBlackPlain',
  'ea1ChtPlain',
  'ea1ChtPeriod',
  'arabic1Minus',
  'arabic2Minus',
  'hebrew2Minus',
  'ea1JpnKorPlain',
  'ea1JpnKorPeriod',
  'arabicDbPlain',
  'arabicDbPeriod',
  'thaiAlphaPeriod',
  'thaiAlphaParenR',
  'thaiAlphaParenBoth',
  'thaiNumPeriod',
  'thaiNumParenR',
  'thaiNumParenBoth',
  'hindiAlphaPeriod',
  'hindiNumPeriod',
  'ea1JpnChsDbPeriod',
  'hindiNumParenR',
  'hindiAlpha1Period',
]

/** 自动编号的方案与起始编号。 */
export interface AutoNumber {
  readonly scheme: string
  readonly startAt: number
}

/**
 * 形状客户数据中 PP9 标签的 StyleTextProp9Atom：各项的自动编号（`fBulletHasAutoNumber` 不为 1 时为 `null`）。
 * 没有该标签时为空数组。项的结构为 TextPFException9、TextCFException9 与 TextSIException。
 */
export function readTextProps9(clientData: readonly ArtRecord[]): (AutoNumber | null)[] {
  const tag = clientData
    .filter((r) => r.type === RT.PROG_TAGS)
    .flatMap(children)
    .find((t) => {
      const name = t.type === PROG_BINARY_TAG ? child(t, RT.CSTRING) : null
      return name !== null && utf16z(name.data, name.data.length) === PP9_TAG
    })
  const blob = tag === undefined ? null : child(tag, BINARY_TAG_DATA)
  const atom =
    blob === null
      ? undefined
      : readArtRecords(blob.data).find((r) => r.type === STYLE_TEXT_PROP9_ATOM)
  const out: (AutoNumber | null)[] = []
  if (atom === undefined) return out
  const c = new Cursor(atom.data)
  while (!c.done) {
    const m = c.u32()
    if (m & 0x800000) c.u16()
    const has = m & 0x2000000 ? c.u16() : 0
    const scheme = m & 0x1000000 ? c.u16() : null
    const start = m & 0x1000000 ? c.i16() : 1
    readCf(c)
    readSpecialInfo(c)
    out.push(
      has === 1 ? { scheme: NUMBER_SCHEMES[scheme ?? 3] ?? 'arabicPeriod', startAt: start } : null,
    )
  }
  return out
}

/**
 * 段落属性中出现的字段换算为段落规格。首行缩进需要左边距（换算为相对左边距的值）；有项目符号而没有符号字符时不写
 * 项目符号（取自继承链）；自动编号的项目符号字体跟随文字（见文件头）。
 */
function paragraphSpec(pf: Pf, scope: SpecScope, number: AutoNumber | null): ParagraphSpec {
  const out: { -readonly [K in keyof ParagraphSpec]: ParagraphSpec[K] } = {}
  if (pf.align !== undefined) out.align = ALIGN[pf.align] ?? 'l'
  if (pf.lineSpacing !== undefined) out.lineSpacing = spacing(pf.lineSpacing)
  if (pf.spaceBefore !== undefined) out.spaceBefore = spacing(pf.spaceBefore)
  if (pf.spaceAfter !== undefined) out.spaceAfter = spacing(pf.spaceAfter)
  if (pf.leftMargin !== undefined) {
    out.marginLeft = pf.leftMargin * EMU_PER_MASTER
    if (pf.indent !== undefined) out.indent = (pf.indent - pf.leftMargin) * EMU_PER_MASTER
  }
  if (pf.defaultTabSize !== undefined) out.defaultTabSize = pf.defaultTabSize * EMU_PER_MASTER
  if (pf.tabs !== undefined) out.tabs = pf.tabs
  if (pf.fontAlign !== undefined) out.fontAlign = FONT_ALIGN[pf.fontAlign] ?? 'auto'
  if (pf.charWrap !== undefined) out.eaLineBreak = pf.charWrap
  if (pf.wordWrap !== undefined) out.latinLineBreak = !pf.wordWrap
  if (pf.overflow !== undefined) out.hangingPunctuation = pf.overflow
  const numbered = pf.hasBullet === true && number !== null
  if (pf.hasBullet === false) out.bullet = { kind: 'none' }
  else if (numbered) out.bullet = { kind: 'number', ...number }
  else if (pf.hasBullet && pf.bulletChar !== undefined) {
    out.bullet = { kind: 'char', char: String.fromCharCode(pf.bulletChar) }
  }
  if (numbered) out.bulletFont = null
  else if (pf.bulletHasFont !== undefined) {
    const font =
      pf.bulletHasFont && pf.bulletFont !== undefined
        ? scope.defaults.fonts.get(pf.bulletFont)
        : undefined
    out.bulletFont = font?.name ?? null
  }
  if (pf.bulletHasColor !== undefined) {
    const color =
      pf.bulletHasColor && pf.bulletColor !== undefined ? colorOf(pf.bulletColor, scope) : null
    out.bulletColor = color === null ? null : { kind: 'rgb', color, transforms: [] }
  }
  if (pf.bulletHasSize !== undefined) {
    const size = pf.bulletHasSize ? (pf.bulletSize ?? 100) : 100
    out.bulletSize =
      size > 0 ? { unit: 'percent', value: size / 100 } : { unit: 'points', value: -size }
  }
  return out
}

/** 缺省的项目符号字符「•」。 */
const DEFAULT_BULLET_CHAR = 0x2022

/** TextMasterStyleAtom 之下的缺省：没有左边距、首行缩进与项目符号，项目符号的字体、颜色与字号跟随文字。 */
const DEFAULT_PF: Pf = {
  leftMargin: 0,
  indent: 0,
  hasBullet: false,
  bulletChar: DEFAULT_BULLET_CHAR,
  bulletHasFont: false,
  bulletHasColor: false,
  bulletHasSize: false,
}

/** 其他文字（类型 4）在文档缺省样式中的样式。 */
const OTHER_TYPE = 4

/**
 * 文档的缺省样式（DocumentTextInfoContainer 中其他文字的 TextMasterStyleAtom 与 TextCFExceptionAtom、
 * TextPFExceptionAtom）换算为 DrawingML 的 `defaultTextStyle`：母版带 RoundTrip 文字样式时，不是占位符的文字继承它。
 */
export function documentTextStyle(defaults: TextDefaults, scheme: readonly Color[]): ListStyleSpec {
  const scope = { defaults, scheme }
  const style = defaults.styles.get(OTHER_TYPE)
  return {
    levels: Array.from({ length: 9 }, (_, level) => {
      const l = style?.[Math.min(level, 4)]
      const pf: Pf = Object.assign({}, DEFAULT_PF, defaults.pf, l?.pf)
      return {
        ...paragraphSpec(pf, scope, null),
        run: runSpec(Object.assign({}, defaults.cf, l?.cf), scope),
      }
    }),
  }
}

/** TextRulerAtom：各层级（下标）的左边距与首行缩进、缺省制表位宽度与制表位，按段落属性的字段记录。 */
function readRuler(r: ArtRecord | undefined): Pf[] {
  if (r === undefined) return []
  const c = new Cursor(r.data)
  const m = c.u32()
  const common: Pf = {}
  if (m & 0x2) c.u16()
  if (m & 0x1) common.defaultTabSize = c.u16()
  if (m & 0x4) common.tabs = readTabs(c)
  const levels: Pf[] = []
  for (let i = 0; i < 5; i++) {
    const level: Pf = { ...common }
    if (m & (0x8 << i)) level.leftMargin = c.i16()
    if (m & (0x100 << i)) level.indent = c.i16()
    levels.push(level)
  }
  return levels
}

const ANCHORS: readonly [string, boolean][] = [
  ['t', false],
  ['ctr', false],
  ['b', false],
  ['t', true],
  ['ctr', true],
  ['b', true],
  ['t', false],
  ['b', false],
  ['t', true],
  ['b', true],
]
const VERTICAL: Readonly<Record<number, string>> = {
  1: 'vert',
  2: 'vert270',
  3: 'eaVert',
  5: 'eaVert',
}

function bodySpec(props: ArtProperties): BodySpec {
  const v = props.values
  const [anchor, anchorCenter] = ANCHORS[v.get(0x0087) ?? 0] ?? ['t', false]
  return {
    insetLeft: v.get(0x0081) ?? 91440,
    insetTop: v.get(0x0082) ?? 45720,
    insetRight: v.get(0x0083) ?? 91440,
    insetBottom: v.get(0x0084) ?? 45720,
    wrap: (v.get(0x0085) ?? 0) !== 2,
    anchor,
    anchorCenter,
    vertical: VERTICAL[v.get(0x0088) ?? 0] ?? 'horz',
  }
}

/** 配色方案映射为 DrawingML 的槽位：超链接取第 7 种颜色（强调与超链接）。 */
function colorContext(scheme: readonly Color[]): ColorContext {
  const at = (i: number) => scheme[i] ?? null
  const slots: ColorScheme = {
    dk1: at(1),
    lt1: at(0),
    dk2: at(3),
    lt2: at(2),
    accent1: at(4),
    accent2: at(5),
    accent3: at(6),
    accent4: at(7),
    accent5: null,
    accent6: null,
    hlink: at(6),
    folHlink: at(7),
  }
  return { scheme: slots }
}

interface StyleRun<T> {
  readonly start: number
  readonly end: number
  readonly value: T
}

/** 段落属性段（含缩进层级）与字符属性段：各段覆盖的字符区间 [start, end)。 */
function readStyleRuns(atom: ArtRecord | undefined, length: number) {
  const pfs: StyleRun<{ level: number; pf: Pf }>[] = []
  const cfs: StyleRun<Cf>[] = []
  if (atom === undefined) return { pfs, cfs }
  const c = new Cursor(atom.data)
  for (let total = 0; total < length + 1 && !c.done; ) {
    const count = Math.max(c.u32(), 1)
    const level = c.u16()
    pfs.push({ start: total, end: total + count, value: { level, pf: readPf(c) } })
    total += count
  }
  for (let total = 0; total < length + 1 && !c.done; ) {
    const count = Math.max(c.u32(), 1)
    cfs.push({ start: total, end: total + count, value: readCf(c) })
    total += count
  }
  return { pfs, cfs }
}

/** TextSIException：返回语言标识（没有时为 0），其余字段跳过。 */
function readSpecialInfo(c: Cursor): number {
  const m = c.u32()
  if (m & 0x1) c.u16()
  const lid = m & 0x2 ? c.u16() : 0
  if (m & 0x4) c.u16()
  if (m & 0x40) c.u16()
  if (m & 0x20) c.u32()
  if (m & 0x200) for (let n = c.u32(); n > 0 && !c.done; n--) c.u32()
  return lid
}

/** TextSpecialInfoAtom：各段覆盖的字符区间与语言标记。 */
function readLanguages(atom: ArtRecord | undefined, length: number): StyleRun<string>[] {
  const out: StyleRun<string>[] = []
  if (atom === undefined) return out
  const c = new Cursor(atom.data)
  for (let total = 0; total < length + 1 && !c.done; ) {
    const count = Math.max(c.u32(), 1)
    out.push({ start: total, end: total + count, value: languageTag(readSpecialInfo(c)) })
    total += count
  }
  return out
}

/** 超链接的字符区间：TxInteractiveInfoAtom 与其前的 InteractiveInfo（动作为 0 的不计）。 */
function readLinks(records: readonly ArtRecord[], scope: TextScope): StyleRun<string>[] {
  const out: StyleRun<string>[] = []
  records.forEach((r, i) => {
    const info = records[i - 1]
    if (r.type !== RT.TX_INTERACTIVE_INFO_ATOM || info?.type !== RT.INTERACTIVE_INFO) return
    const atom = new Fields(child(info, RT.INTERACTIVE_INFO_ATOM)?.data ?? new Uint8Array(0))
    if (atom.u8(8) === 0) return
    const range = new Fields(r.data)
    out.push({
      start: range.i32(0),
      end: range.i32(4),
      value: scope.hyperlinks.get(atom.u32(4)) ?? '',
    })
  })
  return out
}

/** 含第 `pos` 个字符的段；超出全部段时取最后一段，没有段时为 `null`。 */
function runAt<T>(runs: readonly StyleRun<T>[], pos: number): StyleRun<T> | null {
  return runs.find((r) => pos < r.end) ?? runs.at(-1) ?? null
}

/** 文字记录（TextCharsAtom 或 TextBytesAtom）中的文字；没有时为空串。 */
export function textOf(records: readonly ArtRecord[]): string {
  for (const r of records) {
    if (r.type === RT.TEXT_CHARS_ATOM) {
      let s = ''
      for (let i = 0; i + 1 < r.data.length; i += 2) {
        s += String.fromCharCode(r.data[i]! | (r.data[i + 1]! << 8))
      }
      return s
    }
    if (r.type === RT.TEXT_BYTES_ATOM) return String.fromCharCode(...r.data)
  }
  return ''
}

/**
 * 一组文字记录（以 TextHeaderAtom 开始）的文字；没有 TextHeaderAtom 时为 `null`。`props` 为形状的有效属性
 * （文本框的边距、锚定、换行与方向），`numbers` 为形状的 StyleTextProp9Atom 各项（`readTextProps9`），
 * `placeholder` 为形状的占位符（不是占位符时为 `null`）。
 */
export function readTextBody(
  records: readonly ArtRecord[],
  props: ArtProperties,
  scope: TextScope,
  numbers: readonly (AutoNumber | null)[],
  placeholder: Placeholder | null,
): TextBody | null {
  const header = records.find((r) => r.type === RT.TEXT_HEADER_ATOM)
  if (header === undefined) return null
  const type = new Fields(header.data).u32(0)
  const base = BASE_TYPE[type]
  const text = textOf(records)
  const { pfs, cfs } = readStyleRuns(
    records.find((r) => r.type === RT.STYLE_TEXT_PROP_ATOM),
    text.length,
  )
  const ruler = readRuler(records.find((r) => r.type === TEXT_RULER_ATOM))
  /** 元字符的位置对应的字段类型，或代替该字符的文字。 */
  const fields = new Map<number, GenericDate>()
  for (const r of records) {
    const f = new Fields(r.data)
    const type = META_FIELDS.get(r.type)
    if (type !== undefined) fields.set(f.i32(0), { field: type })
    else if (r.type === DATE_TIME_MC_ATOM) fields.set(f.i32(0), { field: `datetime${f.u8(4) + 1}` })
    else if (r.type === GENERIC_DATE_MC_ATOM) fields.set(f.i32(0), scope.date)
  }
  const links = readLinks(records, scope)
  const langs = readLanguages(
    records.find((r) => r.type === RT.TEXT_SPECIAL_INFO_ATOM),
    text.length,
  )
  const cutsLang = langs.map((l) => l.end)
  const linkAt = (pos: number) => links.find((l) => pos >= l.start && pos < l.end)?.value ?? null
  const cuts = links.flatMap((l) => [l.start, l.end])
  const { defaults, master, drawingml } = scope
  const docStyle =
    defaults.styles.get(type) ?? (base === undefined ? undefined : defaults.styles.get(base))
  const levelsOf = (level: number): (StyleLevel | null | undefined)[] =>
    drawingml === null
      ? [
          docStyle?.[level],
          base === undefined ? undefined : master.get(base)?.[level],
          master.get(type)?.[level],
        ]
      : base !== undefined
        ? [master.get(type)?.[level]]
        : []
  const bottomPf: Pf = drawingml === null ? { ...DEFAULT_PF, ...defaults.pf } : {}
  const bottomCf: Cf = drawingml === null ? defaults.cf : {}
  const body = bodySpec(props)
  /**
   * 继承链给出的段落属性（主单位，首行缩进为绝对位置），供显式层只给出一部分的字段补全：
   * - 左边距与首行缩进只给出其一时，另一个取继承链的绝对位置，不按继承链的相对缩进（左边距改变时首行随之移动，与旧格式
   *   记录的含义不同）；
   * - 给出项目符号字符而没有给出是否显示时，是否显示取继承链；要求显示而没有给出字符、继承链又不显示时，字符取缺省的「•」。
   */
  const inherited = (level: number): { leftMargin: number; indent: number; hasBullet: boolean } => {
    // 段落有文字时才求项目符号：以一个字符的段落求值。
    const probe: RawRun = { kind: 'text', text: '.', props: {}, link: null }
    const p =
      drawingml === null
        ? null
        : drawingml.slideText(
            { body, listStyle: null, paragraphs: [{ level, props: {}, runs: [probe], end: null }] },
            placeholder,
            styleKind(type),
          ).paragraphs[0]
    const left = (p?.marginLeft ?? 0) / EMU_PER_MASTER
    return {
      leftMargin: left,
      indent: left + (p?.indent ?? 0) / EMU_PER_MASTER,
      hasBullet: p !== undefined && p !== null && p.bullet.kind !== 'none',
    }
  }
  for (const r of cfs) if (r.value.shadow || r.value.emboss) scope.found.push('effect')
  /** 各字符属性段所在的 StyleTextProp9Atom 分组（见文件头）。 */
  const groups: number[] = []
  cfs.forEach((r, i) => {
    const previous = cfs[i - 1]
    groups.push(
      previous === undefined
        ? 0
        : groups[i - 1]! + (r.value.pp9rt === previous.value.pp9rt ? 0 : 1),
    )
  })

  const paragraphs: RawParagraph[] = []
  let start = 0
  for (const piece of text.split('\r')) {
    const end = start + piece.length
    const pfRun = runAt(pfs, start)
    const level = Math.min(pfRun?.value.level ?? 0, 4)
    const styles = levelsOf(level)
    const pf: Pf = Object.assign(
      {},
      bottomPf,
      ...styles.map((l) => l?.pf),
      ruler[level],
      pfRun?.value.pf,
    )
    const partial =
      (pf.leftMargin === undefined) !== (pf.indent === undefined) ||
      (pf.hasBullet === undefined && pf.bulletChar !== undefined) ||
      (pf.hasBullet === true && pf.bulletChar === undefined)
    if (partial) {
      const base = inherited(level)
      if ((pf.leftMargin === undefined) !== (pf.indent === undefined)) {
        pf.leftMargin ??= base.leftMargin
        pf.indent ??= base.indent
      }
      if (pf.bulletChar !== undefined) pf.hasBullet ??= base.hasBullet
      else if (pf.hasBullet && !base.hasBullet) pf.bulletChar = DEFAULT_BULLET_CHAR
    }
    const cfBase: Cf = Object.assign({}, bottomCf, ...styles.map((l) => l?.cf))
    const runSpecAt = (pos: number) => runSpec({ ...cfBase, ...runAt(cfs, pos)?.value }, scope)
    const runs: RawRun[] = []
    for (let pos = start; pos < end; ) {
      const cfRun = runAt(cfs, pos)
      const stop = Math.min(
        cfRun === null || cfRun.end <= pos ? end : Math.min(end, cfRun.end),
        ...cuts.filter((c) => c > pos),
        ...cutsLang.filter((c) => c > pos),
      )
      const lang = runAt(langs, pos)?.value ?? ''
      const spec = { ...runSpecAt(pos), ...(lang === '' ? {} : { lang }) }
      const link = linkAt(pos)
      let chunk = ''
      const flush = () => {
        if (chunk !== '') runs.push({ kind: 'text', text: chunk, props: spec, link })
        chunk = ''
      }
      for (let i = pos; i < stop; i++) {
        const ch = text[i]!
        if (ch === '\v') {
          flush()
          runs.push({ kind: 'break', props: spec })
        } else if (fields.has(i)) {
          const content = fields.get(i)!
          if ('text' in content) {
            chunk += content.text
            continue
          }
          flush()
          runs.push({
            kind: 'field',
            type: content.field,
            text: content.field === 'slidenum' ? String(scope.slideNumber) : '',
            props: spec,
            link,
          })
        } else {
          chunk += ch
        }
      }
      flush()
      pos = stop
    }
    const group =
      groups[
        Math.max(
          cfs.findIndex((r) => start < r.end),
          0,
        )
      ] ?? 0
    const number = numbers[Math.min(group, numbers.length - 1)] ?? null
    paragraphs.push({ level, props: paragraphSpec(pf, scope, number), runs, end: runSpecAt(end) })
    start = end + 1
  }
  const raw: RawTextBody = { body, listStyle: null, paragraphs }
  return drawingml === null
    ? resolveTextBody(raw, {
        theme: EMPTY_THEME,
        colors: colorContext(scope.scheme),
        listStyles: [],
        bodies: [],
      })
    : drawingml.slideText(raw, placeholder, styleKind(type))
}
