/**
 * 属性继承：文档默认 → 表格样式（单元格中的段落）→ 段落样式（`basedOn` 链）→ 字符样式（`basedOn` 链）→ 直接格式，
 * 编号级别的段落属性插入其中。
 *
 * - 同一样式类型内沿 `basedOn` 链取最近的值；链中出现环时在重复处截断。
 * - 切换属性（`TOGGLES`）：直接格式给出时取其值；否则文档默认或表格样式为真时为真；否则对段落样式链与字符样式链各取一个值，
 *   按异或叠加（ISO/IEC 29500-1 §17.7.3）。两种样式之间的异或与直接格式的优先 WPS 实测一致，文档默认一项未实测。
 *   其余字段属性后者覆盖前者。
 * - 编号级别的段落属性：编号来自段落的直接格式时位于段落样式之后、直接格式之前；编号来自段落样式时位于段落样式之前
 *   （样式中的缩进优先于编号的缩进）。两种顺序均为 WPS 实测结果。
 * - 缩进逐项继承，同一层给出 `firstLine` 时清除继承的 `hanging`，反之亦然；`firstLineChars` 与 `hangingChars` 同理。
 *   给出 `line` 而未给出 `lineRule` 时行距规则为 `auto`，不继承上层的规则。
 * - 制表位按位置合并：`clear` 移除继承的同位置制表位，其余同位置的替换。
 */

import type { Alignment, LineSpacing } from '../../text/index.ts'
import type {
  Border,
  ParagraphProps,
  RunProps,
  Section,
  TabStop,
  UnsupportedKind,
} from '../model.ts'
import type { Level } from '../parse/numbering.ts'
import {
  type RawBorder,
  type RawIndent,
  type RawParaProps,
  type RawRunProps,
  type RawSpacing,
  type RawTab,
  TOGGLES,
} from '../parse/properties.ts'
import type { StyleDef, Styles } from '../parse/styles.ts'
import { type FontContext, fontName } from './fonts.ts'
import type { NumberingState } from './numbering.ts'

/** 未指定字号时的字号：WPS 打开没有字号设置的文档时为 10.5 磅（实测）。 */
const DEFAULT_SIZE = 10.5
/** HTML 自动段间距。 */
const AUTO_SPACING = 14

function mergeIndent(
  base: RawIndent | undefined,
  over: RawIndent | undefined,
): RawIndent | undefined {
  if (over === undefined) return base
  const out: RawIndent = { ...base, ...over }
  if (over.firstLine !== undefined && over.hanging === undefined) delete out.hanging
  if (over.hanging !== undefined && over.firstLine === undefined) delete out.firstLine
  if (over.firstLineChars !== undefined && over.hangingChars === undefined) delete out.hangingChars
  if (over.hangingChars !== undefined && over.firstLineChars === undefined)
    delete out.firstLineChars
  return out
}

function mergeSpacing(
  base: RawSpacing | undefined,
  over: RawSpacing | undefined,
): RawSpacing | undefined {
  if (over === undefined) return base
  const out: RawSpacing = { ...base, ...over }
  if (over.line !== undefined && over.lineRule === undefined) delete out.lineRule
  return out
}

function mergeTabs(
  base: readonly RawTab[] | undefined,
  over: readonly RawTab[] | undefined,
): readonly RawTab[] | undefined {
  if (over === undefined) return base
  const byPos = new Map<number, RawTab>()
  for (const t of base ?? []) byPos.set(t.pos, t)
  for (const t of over) {
    if (t.val === 'clear') byPos.delete(t.pos)
    else byPos.set(t.pos, t)
  }
  return [...byPos.values()].sort((a, b) => a.pos - b.pos)
}

export function mergePara(base: RawParaProps, over: RawParaProps): RawParaProps {
  const out: RawParaProps = { ...base, ...over }
  const ind = mergeIndent(base.ind, over.ind)
  if (ind !== undefined) out.ind = ind
  const spacing = mergeSpacing(base.spacing, over.spacing)
  if (spacing !== undefined) out.spacing = spacing
  const tabs = mergeTabs(base.tabs, over.tabs)
  if (tabs !== undefined) out.tabs = tabs
  return out
}

export function mergeRun(base: RawRunProps, over: RawRunProps): RawRunProps {
  return { ...base, ...over }
}

/** 单元格中的段落从表格样式（含条件格式）取得的一层属性。 */
export interface TableLayer {
  readonly pPr: RawParaProps
  readonly rPr: RawRunProps
}

/** 段落的继承结果：已合并的段落属性与供字段解决使用的段落样式。 */
export interface ParagraphContext {
  readonly style: string
  readonly pPr: RawParaProps
  /** 段落样式链的字段属性（不含文档默认）。 */
  readonly styleRun: RawRunProps
  /** 表格样式的字段属性；不在表格中时为空。 */
  readonly tableRun: RawRunProps
  /** 段落样式链（含文档默认）的字号：左右缩进的字符单位。 */
  readonly styleSize: number
  /** 缺省段落样式（含文档默认）的字号：计算内容宽度时首行与悬挂缩进的字符单位（见 `ParagraphProps.contentIndent`）。 */
  readonly defaultStyleSize: number
  readonly numbering: { readonly numId: number; readonly ilvl: number } | null
}

export class Resolver {
  private readonly chains = new Map<string, { pPr: RawParaProps; rPr: RawRunProps }>()

  constructor(
    private readonly styles: Styles,
    readonly numbering: NumberingState,
    private readonly fonts: FontContext,
  ) {}

  private styleOf(id: string | undefined, type: StyleDef['type']): StyleDef | null {
    const s = id === undefined ? undefined : this.styles.byId.get(id)
    return s !== undefined && s.type === type ? s : null
  }

  /** 样式链自根至该样式依次合并的结果；样式不存在时为空。 */
  private chain(id: string | null): { pPr: RawParaProps; rPr: RawRunProps } {
    if (id === null) return { pPr: {}, rPr: {} }
    const cached = this.chains.get(id)
    if (cached !== undefined) return cached
    const list: StyleDef[] = []
    const seen = new Set<string>()
    for (let s = this.styles.byId.get(id); s !== undefined && !seen.has(s.id); ) {
      seen.add(s.id)
      list.unshift(s)
      const base = s.basedOn === null ? undefined : this.styles.byId.get(s.basedOn)
      s = base !== undefined && base.type === s.type ? base : undefined
    }
    let pPr: RawParaProps = {}
    let rPr: RawRunProps = {}
    for (const s of list) {
      pPr = mergePara(pPr, s.pPr)
      rPr = mergeRun(rPr, s.rPr)
    }
    const result = { pPr, rPr }
    this.chains.set(id, result)
    return result
  }

  /** `table` 为单元格中段落的表格样式层。 */
  paragraph(direct: RawParaProps, table: TableLayer | null = null): ParagraphContext {
    const style =
      this.styleOf(direct.style, 'paragraph')?.id ?? this.styles.defaultParagraphStyle ?? ''
    const chain = this.chain(style === '' ? null : style)
    const numId = direct.numId ?? chain.pPr.numId
    let numbering: ParagraphContext['numbering'] = null
    let level: Level | null = null
    if (numId !== undefined && numId !== 0) {
      const ilvl =
        direct.ilvl ??
        chain.pPr.ilvl ??
        (direct.numId === undefined ? this.numbering.levelOfStyle(numId, style) : null) ??
        0
      level = this.numbering.level(numId, ilvl)
      if (level !== null) numbering = { numId, ilvl }
    }
    let pPr = this.styles.defaultParagraph
    if (table !== null) pPr = mergePara(pPr, table.pPr)
    if (level !== null && direct.numId === undefined) {
      pPr = mergePara(mergePara(pPr, level.pPr), chain.pPr)
    } else {
      pPr = mergePara(pPr, chain.pPr)
      if (level !== null) pPr = mergePara(pPr, level.pPr)
    }
    pPr = mergePara(pPr, direct)
    const tableRun = table?.rPr ?? {}
    const styleSize = chain.rPr.size ?? tableRun.size ?? this.styles.defaultRun.size ?? DEFAULT_SIZE
    const defaultStyleSize =
      this.chain(this.styles.defaultParagraphStyle).rPr.size ??
      this.styles.defaultRun.size ??
      DEFAULT_SIZE
    return { style, pPr, styleRun: chain.rPr, tableRun, styleSize, defaultStyleSize, numbering }
  }

  /** 字段属性的合并结果，切换属性已解决为确定值。`direct` 中的 `rStyle` 指定字符样式。 */
  effectiveRun(para: ParagraphContext, direct: RawRunProps): RawRunProps {
    const charStyle =
      this.styleOf(direct.style, 'character')?.id ?? this.styles.defaultCharacterStyle
    const charRun = this.chain(charStyle).rPr
    const defaults = this.styles.defaultRun
    const base = mergeRun(defaults, para.tableRun)
    const out = mergeRun(mergeRun(mergeRun(base, para.styleRun), charRun), direct)
    for (const key of TOGGLES) {
      const own = direct[key]
      if (own !== undefined) out[key] = own
      else if (defaults[key] === true || para.tableRun[key] === true) out[key] = true
      else out[key] = (para.styleRun[key] === true) !== (charRun[key] === true)
    }
    return out
  }

  runProps(raw: RawRunProps): RunProps {
    const f = this.fonts
    return {
      fonts: {
        ascii: fontName(raw.ascii, 'ascii', f),
        hAnsi: fontName(raw.hAnsi, 'hAnsi', f),
        eastAsia: fontName(raw.eastAsia, 'eastAsia', f),
        cs: fontName(raw.cs, 'cs', f),
      },
      hint: raw.hint ?? 'default',
      complexScript: raw.complexScript === true || raw.rtl === true,
      size: raw.size ?? DEFAULT_SIZE,
      sizeCs: raw.sizeCs ?? DEFAULT_SIZE,
      bold: raw.b === true,
      boldCs: raw.bCs === true,
      italic: raw.i === true,
      italicCs: raw.iCs === true,
      caps: raw.caps === true,
      smallCaps: raw.smallCaps === true,
      strike: raw.strike === true,
      emboss: raw.emboss === true,
      imprint: raw.imprint === true,
      outline: raw.outline === true,
      shadow: raw.shadow === true,
      spacing: (raw.spacing ?? 0) / 20,
      vertAlign:
        raw.vertAlign === 'superscript' || raw.vertAlign === 'subscript'
          ? raw.vertAlign
          : 'baseline',
      position: (raw.position ?? 0) / 2,
      kern: (raw.kern ?? 0) / 2,
      eastAsiaLanguage: raw.eastAsiaLanguage ?? '',
      color: raw.color ?? null,
      underline:
        raw.underline === undefined || raw.underline.style === 'none' ? null : raw.underline,
      highlight: raw.highlight ?? null,
      shading: raw.shading ?? null,
      doubleStrike: raw.dstrike === true,
    }
  }
}

/** 边框的一边：`null` 与未给出均为无边框。 */
export function border(b: RawBorder | null | undefined): Border | null {
  return b == null ? null : { style: b.style, width: b.width, color: b.color, space: b.space }
}

/** 网格类型为 `default`（含没有 `docGrid`）时 `*Lines` 的一行为 12 磅。 */
const DEFAULT_LINE_UNIT = 12

const ALIGNMENTS: Readonly<Record<string, Alignment>> = {
  left: 'left',
  start: 'left',
  right: 'right',
  end: 'right',
  center: 'center',
  both: 'both',
  justify: 'both',
  lowKashida: 'both',
  mediumKashida: 'both',
  highKashida: 'both',
  distribute: 'distribute',
  thaiDistribute: 'distribute',
}

/**
 * 缩进（磅），按 WPS 实测规则：
 * - 首行：正的 `firstLineChars` 优先，其次 `hangingChars`（或负的 `firstLineChars`），最后按缇的 `hanging`、`firstLine`；
 *   `*Chars` 为 0 时视为未给出。
 * - 左缩进：给出 `leftChars` 或按字符的悬挂缩进时为 `leftChars` 加悬挂量（`left` 不生效）；否则按缇的 `left`。
 * - 字符单位：首行与悬挂取段落第一个字段的字号（`firstUnit`），左右取段落样式的字号（`sideUnit`）。
 */
function indents(
  ind: RawIndent,
  firstUnit: number,
  sideUnit: number,
): { left: number; right: number; firstLine: number } {
  const chars = (v: number | undefined, unit = firstUnit) => ((v ?? 0) / 100) * unit
  const firstChars = ind.firstLineChars ?? 0
  const hangChars = ind.hangingChars ?? 0
  let firstLine: number
  let charHanging = false
  if (firstChars > 0) firstLine = chars(firstChars)
  else if (hangChars > 0 || firstChars < 0) {
    firstLine = -chars(hangChars > 0 ? hangChars : -firstChars)
    charHanging = true
  } else if (ind.hanging !== undefined) {
    // 不要写成 `-ind.hanging`：`hanging` 为 0 时得到 -0。
    firstLine = (0 - ind.hanging) / 20
  } else firstLine = (ind.firstLine ?? 0) / 20
  const leftChars = ind.leftChars ?? 0
  const left =
    leftChars !== 0 || charHanging
      ? chars(leftChars, sideUnit) + Math.max(0, -firstLine)
      : (ind.left ?? 0) / 20
  const rightChars = ind.rightChars ?? 0
  const right = rightChars !== 0 ? chars(rightChars, sideUnit) : (ind.right ?? 0) / 20
  return { left, right, firstLine }
}

function lineSpacing(s: RawSpacing): LineSpacing {
  if (s.line === undefined) return { rule: 'multiple', value: 1 }
  if (s.lineRule === 'exact') return { rule: 'exact', value: Math.abs(s.line) / 20 }
  if (s.lineRule === 'atLeast') return { rule: 'atLeast', value: s.line / 20 }
  return { rule: 'multiple', value: s.line / 240 }
}

/**
 * 段落属性的最终值。`firstUnit` 为首行与悬挂缩进的字符单位（磅）。
 * - `*Lines` 不为 0 时取其值乘行单位，否则取按缇的值。行单位：所在节的网格类型不为 `default` 时为 `linePitch`，
 *   为 `default`（含没有 `docGrid`）时为 12 磅，与 `linePitch` 无关（WPS 实测：linePitch 为 360、312 与没有 `docGrid` 时
 *   `beforeLines="100"` 均为 12 磅，`lines` 与 `linesAndChars` 网格 360 时为 18 磅）。
 * - 未指定 `widowControl` 时为开启（WPS 实测：全文未指定的文档按孤行控制分页）。
 */
export function paragraphProps(
  ctx: ParagraphContext,
  section: Section,
  firstUnit: number,
  count: (kind: UnsupportedKind) => void,
): ParagraphProps {
  const p = ctx.pPr
  const s = p.spacing ?? {}
  const lineUnit = section.gridType === 'default' ? DEFAULT_LINE_UNIT : section.linePitch
  const spaceOf = (
    lines: number | undefined,
    twips: number | undefined,
    auto: boolean | undefined,
  ) => {
    if (auto === true) {
      count('autoSpacing')
      return AUTO_SPACING
    }
    return lines !== undefined && lines !== 0 ? (lines / 100) * lineUnit : (twips ?? 0) / 20
  }
  const tabs: TabStop[] = []
  for (const t of p.tabs ?? []) {
    if (t.leader !== null && t.leader !== 'none' && t.leader !== 'dot') count('tabLeader')
    if (t.val === 'bar') {
      count('barTab')
      continue
    }
    if (t.val === 'decimal') count('decimalTab')
    const align =
      t.val === 'center'
        ? 'center'
        : t.val === 'right' || t.val === 'end' || t.val === 'decimal'
          ? 'right'
          : 'left'
    tabs.push({ position: t.pos / 20, align, leader: t.leader === 'dot' ? '.' : null })
  }
  const content = indents(p.ind ?? {}, ctx.defaultStyleSize, ctx.styleSize)
  return {
    align: ALIGNMENTS[p.jc ?? 'left'] ?? 'left',
    ...indents(p.ind ?? {}, firstUnit, ctx.styleSize),
    contentIndent: { left: content.left, firstLine: content.firstLine },
    before: spaceOf(s.beforeLines, s.before, s.beforeAuto),
    after: spaceOf(s.afterLines, s.after, s.afterAuto),
    contextualSpacing: p.contextualSpacing === true,
    lineSpacing: lineSpacing(s),
    snapToGrid: p.snapToGrid !== false && section.gridType !== 'default',
    kinsoku: p.kinsoku !== false,
    wordWrap: p.wordWrap !== false,
    overflowPunct: p.overflowPunct !== false,
    autoSpaceDE: p.autoSpaceDE !== false,
    autoSpaceDN: p.autoSpaceDN !== false,
    tabs,
    keepNext: p.keepNext === true,
    keepLines: p.keepLines === true,
    widowControl: p.widowControl !== false,
    pageBreakBefore: p.pageBreakBefore === true,
    shading: p.shading ?? null,
    borders:
      p.borders === undefined
        ? null
        : {
            top: border(p.borders.top),
            bottom: border(p.borders.bottom),
            left: border(p.borders.left),
            right: border(p.borders.right),
          },
  }
}
