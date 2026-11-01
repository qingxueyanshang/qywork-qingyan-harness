/**
 * DrawingML 文本：`txBody`、`bodyPr`、列表样式（`lstStyle`、母版 `txStyles`、`defaultTextStyle`）、段落与字段属性。
 *
 * - 读取结果只记录文档中出现的字段（规格），继承在 `resolve.ts` 中逐级解决。
 * - 单位：字号、字距、`spcPts` 换算为磅；边距、缩进、制表位为 EMU；百分比为小数。
 * - `buClrTx`、`buSzTx`、`buFontTx`（跟随文字）分别记为 `bulletColor`、`bulletSize`、`bulletFont` 的 `null`。
 * - 列表样式只读 `lvl1pPr`–`lvl9pPr`，不读 `defPPr`：WPS 不使用任何层级的 `defPPr`（实测形状 `lstStyle` 与
 *   `defaultTextStyle` 中的 `defPPr` 字号均不生效）。
 */

import type { Relationships } from '../../opc/package.ts'
import { bool, eachChild, int, num, readText, relAttr, type Scanner, skip } from '../../opc/read.ts'
import { type ColorSpec, isColorElement, parsePercentage, readColor } from '../color.ts'
import {
  type EffectSpec,
  type FillSpec,
  isFillElement,
  type LineSpec,
  readEffects,
  readFill,
  readLine,
  readThreeD,
} from '../fill.ts'
import type { FindingSink } from '../shape/model.ts'
import type { Autofit, Spacing } from './model.ts'

export type BulletSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'number'; readonly scheme: string; readonly startAt: number }
  | { readonly kind: 'picture'; readonly part: string | null }

export interface TabStop {
  readonly position: number
  /** `l`、`ctr`、`r`、`dec`。 */
  readonly align: string
}

export interface RunSpec {
  readonly size?: number
  readonly bold?: boolean
  readonly italic?: boolean
  /** `ST_TextUnderlineType`，如 `none`、`sng`、`dbl`。 */
  readonly underline?: string
  /** `noStrike`、`sngStrike`、`dblStrike`。 */
  readonly strike?: string
  /** 上下标偏移，正值为上标。 */
  readonly baseline?: number
  /** `none`、`small`、`all`。 */
  readonly caps?: string
  readonly spacing?: number
  readonly kern?: number
  /** 字体名原文，主题字体为 `+mj-lt`、`+mn-ea` 等形式。 */
  readonly latin?: string
  readonly ea?: string
  readonly cs?: string
  readonly sym?: string
  readonly fill?: FillSpec
  readonly highlight?: ColorSpec | null
  readonly outline?: LineSpec
  readonly effects?: readonly EffectSpec[]
  readonly lang?: string
  readonly altLang?: string
}

export interface ParagraphSpec {
  readonly marginLeft?: number
  readonly marginRight?: number
  readonly indent?: number
  /** `l`、`ctr`、`r`、`just`、`justLow`、`dist`、`thaiDist`。 */
  readonly align?: string
  readonly defaultTabSize?: number
  readonly rtl?: boolean
  readonly eaLineBreak?: boolean
  readonly latinLineBreak?: boolean
  readonly hangingPunctuation?: boolean
  /** `auto`、`t`、`ctr`、`base`、`b`。 */
  readonly fontAlign?: string
  readonly lineSpacing?: Spacing
  readonly spaceBefore?: Spacing
  readonly spaceAfter?: Spacing
  readonly bullet?: BulletSpec
  readonly bulletColor?: ColorSpec | null
  /** 百分比相对文字字号。 */
  readonly bulletSize?: Spacing | null
  readonly bulletFont?: string | null
  readonly tabs?: readonly TabStop[]
  /** `defRPr`。 */
  readonly run?: RunSpec
}

/** `levels` 固定 9 项，对应 `lvl1pPr`–`lvl9pPr`。 */
export interface ListStyleSpec {
  readonly levels: readonly (ParagraphSpec | null)[]
}

export interface BodySpec {
  readonly rotation?: number
  /** `horz`、`vert`、`vert270`、`wordArtVert`、`eaVert`、`mongolianVert`、`wordArtVertRtl`。 */
  readonly vertical?: string
  readonly wrap?: boolean
  readonly insetLeft?: number
  readonly insetTop?: number
  readonly insetRight?: number
  readonly insetBottom?: number
  /** `t`、`ctr`、`b`、`just`、`dist`。 */
  readonly anchor?: string
  readonly anchorCenter?: boolean
  readonly columns?: number
  readonly columnSpacing?: number
  readonly rtlColumns?: boolean
  readonly upright?: boolean
  readonly verticalOverflow?: string
  readonly horizontalOverflow?: string
  readonly autofit?: Autofit
}

export type RawRun =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly props: RunSpec
      readonly link: string | null
    }
  | { readonly kind: 'break'; readonly props: RunSpec }
  | {
      readonly kind: 'field'
      /** `slidenum`、`datetime`、`datetime1` 等。 */
      readonly type: string
      readonly text: string
      readonly props: RunSpec
      readonly link: string | null
    }

export interface RawParagraph {
  readonly level: number
  readonly props: ParagraphSpec
  readonly runs: readonly RawRun[]
  readonly end: RunSpec | null
}

export interface RawTextBody {
  readonly body: BodySpec
  readonly listStyle: ListStyleSpec | null
  readonly paragraphs: readonly RawParagraph[]
}

export interface TextContext {
  readonly rels: Relationships
  readonly found: FindingSink
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const LEVEL_ELEMENTS = new Map(
  Array.from({ length: 9 }, (_, i) => [`lvl${i + 1}pPr`, i] as [string, number]),
)

function readSpacing(x: Scanner): Spacing | undefined {
  let out: Spacing | undefined
  eachChild(x, (local) => {
    if (local === 'spcPct') {
      const v = parsePercentage(x.attr('val'))
      if (v !== null) out = { unit: 'percent', value: v }
    } else if (local === 'spcPts') {
      const v = num(x, 'val')
      if (v !== null) out = { unit: 'points', value: v / 100 }
    }
  })
  return out
}

function readColorChild(x: Scanner): ColorSpec | null {
  let color: ColorSpec | null = null
  let found = false
  eachChild(x, (local) => {
    if (found || !isColorElement(local)) return
    found = true
    color = readColor(x)
  })
  return color
}

function readLink(x: Scanner, rels: Relationships): string | null {
  const id = relAttr(x, 'id')
  if (id === null || id === '') return null
  const r = rels.byId(id)
  if (r === null) return null
  return r.external ? r.target : r.part
}

/**
 * 在 `rPr`、`defRPr` 或 `endParaRPr` 的开始标签处调用。`hlinkClick` 的目标经 `link` 返回：
 * 它只属于该字段，不参与继承。
 */
export function readRunProps(x: Scanner, cx: TextContext): { props: RunSpec; link: string | null } {
  const out: Mutable<RunSpec> = {}
  let link: string | null = null
  const size = num(x, 'sz')
  if (size !== null) out.size = size / 100
  const b = bool(x, 'b')
  if (b !== null) out.bold = b
  const i = bool(x, 'i')
  if (i !== null) out.italic = i
  const u = x.attr('u')
  if (u !== null) out.underline = u
  const strike = x.attr('strike')
  if (strike !== null) out.strike = strike
  const baseline = parsePercentage(x.attr('baseline'))
  if (baseline !== null) out.baseline = baseline
  const cap = x.attr('cap')
  if (cap !== null) out.caps = cap
  const spc = num(x, 'spc')
  if (spc !== null) out.spacing = spc / 100
  const kern = num(x, 'kern')
  if (kern !== null) out.kern = kern / 100
  const lang = x.attr('lang')
  if (lang !== null) out.lang = lang
  const altLang = x.attr('altLang')
  if (altLang !== null) out.altLang = altLang
  eachChild(x, (local) => {
    if (isFillElement(local)) out.fill = readFill(x, cx.rels)
    else if (local === 'ln') out.outline = readLine(x, cx.rels)
    else if (local === 'effectLst') out.effects = readEffects(x)
    else if (local === 'effectDag') out.effects = [{ kind: 'other', name: 'effectDag' }]
    else if (local === 'highlight') out.highlight = readColorChild(x)
    else if (local === 'latin' || local === 'ea' || local === 'cs' || local === 'sym') {
      const typeface = x.attr('typeface')
      if (typeface !== null) out[local] = typeface
    } else if (local === 'hlinkClick') link = readLink(x, cx.rels)
  })
  return { props: out, link }
}

/** 在 `pPr` 或列表样式的 `lvlNpPr` 的开始标签处调用。 */
export function readParagraphProps(x: Scanner, cx: TextContext): ParagraphSpec {
  const out: Mutable<ParagraphSpec> = {}
  const marL = num(x, 'marL')
  if (marL !== null) out.marginLeft = marL
  const marR = num(x, 'marR')
  if (marR !== null) out.marginRight = marR
  const indent = num(x, 'indent')
  if (indent !== null) out.indent = indent
  const algn = x.attr('algn')
  if (algn !== null) out.align = algn
  const defTab = num(x, 'defTabSz')
  if (defTab !== null) out.defaultTabSize = defTab
  const rtl = bool(x, 'rtl')
  if (rtl !== null) out.rtl = rtl
  const ea = bool(x, 'eaLnBrk')
  if (ea !== null) out.eaLineBreak = ea
  const latin = bool(x, 'latinLnBrk')
  if (latin !== null) out.latinLineBreak = latin
  const hanging = bool(x, 'hangingPunct')
  if (hanging !== null) out.hangingPunctuation = hanging
  const fontAlgn = x.attr('fontAlgn')
  if (fontAlgn !== null) out.fontAlign = fontAlgn
  eachChild(x, (local) => {
    switch (local) {
      case 'lnSpc':
      case 'spcBef':
      case 'spcAft': {
        const s = readSpacing(x)
        if (s === undefined) return
        if (local === 'lnSpc') out.lineSpacing = s
        else if (local === 'spcBef') out.spaceBefore = s
        else out.spaceAfter = s
        return
      }
      case 'buClrTx':
        out.bulletColor = null
        return
      case 'buClr':
        out.bulletColor = readColorChild(x)
        return
      case 'buSzTx':
        out.bulletSize = null
        return
      case 'buSzPct': {
        const v = parsePercentage(x.attr('val'))
        if (v !== null) out.bulletSize = { unit: 'percent', value: v }
        return
      }
      case 'buSzPts': {
        const v = num(x, 'val')
        if (v !== null) out.bulletSize = { unit: 'points', value: v / 100 }
        return
      }
      case 'buFontTx':
        out.bulletFont = null
        return
      case 'buFont':
        out.bulletFont = x.attr('typeface') ?? ''
        return
      case 'buNone':
        out.bullet = { kind: 'none' }
        return
      case 'buChar':
        out.bullet = { kind: 'char', char: x.attr('char') ?? '' }
        return
      case 'buAutoNum':
        out.bullet = {
          kind: 'number',
          scheme: x.attr('type') ?? 'arabicPeriod',
          startAt: int(x, 'startAt', 1),
        }
        return
      case 'buBlip': {
        let part: string | null = null
        eachChild(x, (blip) => {
          if (blip !== 'blip') return
          const embed = relAttr(x, 'embed')
          const r = embed === null ? null : cx.rels.byId(embed)
          part = r !== null && !r.external ? r.part : null
        })
        out.bullet = { kind: 'picture', part }
        return
      }
      case 'tabLst': {
        const tabs: TabStop[] = []
        eachChild(x, (tab) => {
          if (tab === 'tab') tabs.push({ position: int(x, 'pos', 0), align: x.attr('algn') ?? 'l' })
        })
        out.tabs = tabs
        return
      }
      case 'defRPr':
        out.run = readRunProps(x, cx).props
        return
    }
  })
  return out
}

/** 在列表样式元素（`lstStyle`、`titleStyle`、`defaultTextStyle` 等）的开始标签处调用。 */
export function readListStyle(x: Scanner, cx: TextContext): ListStyleSpec {
  const levels: (ParagraphSpec | null)[] = Array.from({ length: 9 }, () => null)
  eachChild(x, (local) => {
    const level = LEVEL_ELEMENTS.get(local)
    if (level !== undefined) levels[level] = readParagraphProps(x, cx)
  })
  return { levels }
}

/** 在 `bodyPr` 的开始标签处调用。 */
export function readBodyProps(x: Scanner, cx: TextContext): BodySpec {
  const out: Mutable<BodySpec> = {}
  const rot = num(x, 'rot')
  if (rot !== null) out.rotation = rot / 60000
  const vert = x.attr('vert')
  if (vert !== null) out.vertical = vert
  const wrap = x.attr('wrap')
  if (wrap !== null) out.wrap = wrap !== 'none'
  for (const [name, key] of [
    ['lIns', 'insetLeft'],
    ['tIns', 'insetTop'],
    ['rIns', 'insetRight'],
    ['bIns', 'insetBottom'],
    ['spcCol', 'columnSpacing'],
    ['numCol', 'columns'],
  ] as const) {
    const v = num(x, name)
    if (v !== null) out[key] = v
  }
  const anchor = x.attr('anchor')
  if (anchor !== null) out.anchor = anchor
  const anchorCtr = bool(x, 'anchorCtr')
  if (anchorCtr !== null) out.anchorCenter = anchorCtr
  const rtlCol = bool(x, 'rtlCol')
  if (rtlCol !== null) out.rtlColumns = rtlCol
  const upright = bool(x, 'upright')
  if (upright !== null) out.upright = upright
  const vo = x.attr('vertOverflow')
  if (vo !== null) out.verticalOverflow = vo
  const ho = x.attr('horzOverflow')
  if (ho !== null) out.horizontalOverflow = ho
  eachChild(x, (local) => {
    if (local === 'noAutofit') out.autofit = { kind: 'none' }
    else if (local === 'spAutoFit') out.autofit = { kind: 'shape' }
    else if (local === 'normAutofit') {
      out.autofit = {
        kind: 'normal',
        fontScale: parsePercentage(x.attr('fontScale')) ?? 1,
        lineSpacingReduction: parsePercentage(x.attr('lnSpcReduction')) ?? 0,
      }
    } else if (local === 'prstTxWarp') {
      if ((x.attr('prst') ?? 'textNoShape') !== 'textNoShape') cx.found.push('textWarp')
    } else if ((local === 'scene3d' || local === 'sp3d') && readThreeD(x)) {
      cx.found.push('effect3d')
    }
  })
  return out
}

function readParagraph(x: Scanner, cx: TextContext): RawParagraph {
  let level = 0
  let props: ParagraphSpec = {}
  const runs: RawRun[] = []
  let end: RunSpec | null = null
  eachChild(x, (local) => {
    if (local === 'pPr') {
      level = Math.min(8, Math.max(0, int(x, 'lvl', 0)))
      props = readParagraphProps(x, cx)
    } else if (local === 'r' || local === 'fld') {
      const type = local === 'fld' ? (x.attr('type') ?? '') : ''
      let run: RunSpec = {}
      let link: string | null = null
      let text = ''
      eachChild(x, (child) => {
        if (child === 'rPr') ({ props: run, link } = readRunProps(x, cx))
        else if (child === 't') text += readText(x)
      })
      runs.push(
        local === 'fld'
          ? { kind: 'field', type, text, props: run, link }
          : { kind: 'text', text, props: run, link },
      )
    } else if (local === 'br') {
      let run: RunSpec = {}
      eachChild(x, (child) => {
        if (child === 'rPr') run = readRunProps(x, cx).props
      })
      runs.push({ kind: 'break', props: run })
    } else if (local === 'endParaRPr') {
      end = readRunProps(x, cx).props
    }
  })
  return { level, props, runs, end }
}

/** 在 `txBody`（或表格单元格的同类元素）的开始标签处调用。 */
export function readTextBody(x: Scanner, cx: TextContext): RawTextBody {
  let body: BodySpec = {}
  let listStyle: ListStyleSpec | null = null
  const paragraphs: RawParagraph[] = []
  eachChild(x, (local) => {
    if (local === 'bodyPr') body = readBodyProps(x, cx)
    else if (local === 'lstStyle') listStyle = readListStyle(x, cx)
    else if (local === 'p') paragraphs.push(readParagraph(x, cx))
    else skip(x)
  })
  return { body, listStyle, paragraphs }
}
