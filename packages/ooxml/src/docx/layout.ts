/**
 * 逐段排版：把段落的解决结果转换为 `layoutParagraph` 的输入。断行、对齐与行高的规则全部在 `../text/` 中。
 *
 * - `ParagraphLayouter` 在给定区域宽度（栏、单元格或文本框的文字区）中排版一段，可附带环绕查询；正文、单元格、
 *   文本框与页眉页脚共用。`layoutDocument` 排版正文的顶层段落，区域宽度为所在节第一栏的宽度。
 * - 可用宽度为区域宽度减去左右缩进；制表位与制表起点换算为相对左缩进的行坐标。
 * - 字体由调用方按字体名与字形提供（`FontSource.face`）。返回 `null` 的字体记入 `missingFonts`，按 `substitutes` 的替代字体
 *   排版，都没有时改用 `fallback`。请求粗体而返回的不是粗体字形时按仿粗体（`emboldened`）排版。
 * - 文档的数学字体主机没有时改用 Cambria Math（WPS 实测：数学字体为 STIX Math 的文档按 Cambria Math 排版与绘制）。
 * - 段前段后间距按 `contextualSpacing` 抵消（`contextSpacing`）：同一容器中相邻段落样式相同时，设置了该项的段落
 *   不留对应一侧的间距。段落上下边框占用的高度见 `borderExtents`，由调用方加在段前间距之后与最后一行之后，不与间距合并。
 * - 全部大写（`caps`）按大写字母排版；大小写转换改变字符数的字符保持原样，使片段的位置与字段文字一一对应。
 * - 分页符与分栏符按强制换行排版（一个字符换一个字符，位置不变），换页与换栏由分页处理。
 * - 嵌入式对象（图片、图表、文本框等）与行内公式的各段是 `../text/` 的行内对象（`InlineObject`），在段落文字中不占位置；
 *   行高与多倍行距的基数见 `../text/layout.ts` 的 `lineExtent`。
 * - 嵌入式对象：宽度与上沿为对象框（含 `effectExtent`），下沿为 0，底边位于所在行的基线（WPS 实测：30 磅固定行距中
 *   10 磅高的图片底边在行顶之下 24 磅，130 磅最小行距中 70 磅高的图片底边在行底，对齐网格时上下均分）；所在字段的基线
 *   提升使对象框与上下沿随之移动（30 磅图片下降 5 磅时与 10.5 磅文字同行行高 30 磅，提升 3 磅时 36.05 磅，独占一行时
 *   33 磅）；两侧可断（「abcd」与其后的图片之间、图片与其后的「abcdefghij」之间都断开）。
 * - 行内公式（`Run.math`）按 `../math/` 排版后按段（`MathSegment`）参与断行：每段的宽度为 `width`、至下一段起点的距离为
 *   `advance`，上下沿为该段所在行的上下沿（`lineAscent`、`lineDescent`）；第一段与其前的西文、最后一段与其后的西文之间
 *   不断开，与汉字之间可断，其后各段之前可断（WPS 实测）。
 * - 显示公式段落的行由 `layoutMathParagraph` 给出（断行与横向位置），不按段落的对齐方式与首行缩进。行高按 `lineBox`：
 *   上下沿为公式所在行的上下沿，多倍行距增加的部分按段落标记字体的单倍行高计，不对齐行网格（WPS 实测：10.5 磅三种公式
 *   在 1、1.15、1.5、2 倍行距下增加 (倍数 − 1) × 12.1 磅，段落标记为 16 磅时 × 18.4 磅；有行网格时行高不变）。
 * - 公式含未实现的结构或主机没有数学字体时不排版：行内公式宽度为 0、上下沿取其字段属性的字体，显示公式段落按空段落排版。
 */

import type { GlyphOutlines } from '../font/index.ts'
import {
  layoutMath,
  layoutMathParagraph,
  MATH_SETTINGS_DEFAULTS,
  type MathEnvironment,
  type MathFont,
  type MathJustification,
  type MathLayout,
  type MathParagraphResult,
  type MathRunStyle,
} from '../math/index.ts'
import {
  codePointSet,
  contentWidths,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  emboldened,
  faceExtent,
  fontSlot,
  type InlineObject,
  type LineArea,
  layoutParagraph,
  lineBox,
  type ParagraphRun,
  type ParagraphStyle,
  type RunFonts,
  type SlotContext,
  type TextBlock,
  type TextFace,
  type TextLine,
  type TextRun,
} from '../text/index.ts'
import { borderSpace } from './border.ts'
import type { Block, DocxDocument, InlineImage, Paragraph, RunMath, RunProps } from './model.ts'
import { type FontUse, substitutes } from './resolve/fonts.ts'

export interface FontMatch {
  readonly face: TextFace
  /** 返回的是粗体字形；请求粗体而该项为 `false` 时按仿粗体排版。 */
  readonly bold: boolean
}

export interface FontSource {
  /** 按字体名与字形取得最接近的字体；主机没有该字体时返回 `null`。 */
  face(name: string, bold: boolean, italic: boolean): FontMatch | null
  /** 按字体名取得数学字体（带 `MATH` 表）；主机没有该字体或该字体不是数学字体时返回 `null`。 */
  math(name: string): MathFont<TextFace> | null
  /** `face` 或 `fallback` 返回的字形的 TrueType 轮廓；其他字形与没有轮廓的字体为 `null`。 */
  outlines(face: TextFace): GlyphOutlines | null
  /** 缺少字形与缺少字体（没有可用的替代字体）时使用的字体（常规字形）。 */
  readonly fallback: TextFace
}

export interface ParagraphLayout {
  /** 所在容器（正文或单元格、文本框、页眉页脚的内容）中的块下标。 */
  readonly block: number
  /** 左缩进处距区域左边的距离；`text` 的坐标以此为原点。 */
  readonly left: number
  readonly width: number
  readonly spaceBefore: number
  readonly spaceAfter: number
  /** 上边框与下边框占用的高度（见 `borderExtents`）。 */
  readonly borderTop: number
  readonly borderBottom: number
  readonly text: TextBlock
  /**
   * `TextFragment.run` 对应的 `Paragraph.runs` 下标，编号字段为 -1。行内对象的字段为其位置：公式为其字段，嵌入式对象为
   * `InlineImage.run`。
   */
  readonly runs: readonly number[]
  /** 含嵌入式对象的行中对象框的高度（行号 → 高度）：分页判定可容纳时代替该行的文字部分。 */
  readonly objects: ReadonlyMap<number, number>
  /**
   * 对齐行网格的多倍行距（倍数大于 1）段落中，不含嵌入式对象的各行文字底边距该行文字部分顶边（不含环绕下移）的距离
   * （行号 → 距离）；其余段落为空。分页判定可容纳时代替该行的行高（见 `page/paginate.ts` 的 `lineNeed`）。
   */
  readonly gridBottoms: ReadonlyMap<number, number>
  /** 嵌入式对象的位置，与 `Paragraph.images` 一一对应。 */
  readonly images: readonly LineImage[]
  /** 段落中的公式，按行与出现顺序。 */
  readonly formulas: readonly LineFormula[]
}

export interface LineImage {
  readonly line: number
  /** 对象框的左端（行坐标）与底边（段落坐标：所在行的基线减去基线提升）。 */
  readonly x: number
  readonly baseline: number
}

export interface LineFormula {
  readonly line: number
  /** 左端（行坐标，与 `TextFragment.x` 相同）与基线（段落坐标）。 */
  readonly x: number
  readonly baseline: number
  /** 字形的字体为排版所用的 `TextFace`；公式含未实现的结构或主机没有数学字体时为 `null`，不绘制。 */
  readonly layout: MathLayout<TextFace> | null
}

export interface DocumentLayout {
  readonly paragraphs: readonly ParagraphLayout[]
  /** `face` 返回 `null` 的字体名，按首次出现的顺序。 */
  readonly missingFonts: readonly string[]
}

/** 环绕查询：`top`、`height` 为段落坐标，返回的区段横坐标相对区域左边。 */
export type AreaQuery = (top: number, height: number) => LineArea

const PAGE_OR_COLUMN_BREAK = /[\f\v]/g

/** 计算内容宽度时的可用宽度：大于任何段落的自然宽度。 */
const UNWRAPPED = 1e6

/**
 * 缺字形时按码位改用的字体（WPS 实测，构造文档 w9-fb、w9-fbcp、w9-fbcp2）：U+1F300–U+1F64F、U+1F680–U+1F6FF、
 * U+1F900–U+1F9FF 中的字符改用 Segoe UI Emoji，按其宽度与上下沿排版（12 磅宋体字段中的「🔹」行高 16.4 磅，对齐 15.6 磅网格的
 * 1.5 倍行距占两格）；同在补充平面的 U+1F000–U+1F2FF、U+1F650–U+1F67F、U+1F700–U+1F8FF 与 U+1FA00 起的字符不改用，
 * Segoe UI Emoji 有字形的「🀄」「🅰」「🩰」也是如此。其余字符改用 `FontSource.fallback`。
 */
export const EMOJI_FALLBACK = 'Segoe UI Emoji'

/** 目录域结果以外的制表位前导符所用的字体（见 `ParagraphLayouter.leaderStyle`）。 */
export const LEADER_FONT = 'Times New Roman'

/** 前导符的字体与对齐：`end` 为整数个前导符与制表位的终点相接，否则自制表符的起点排起。 */
export interface LeaderStyle {
  readonly face: TextFace
  readonly end: boolean
}
const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
]

/** 字段东亚字体的用途（见 `substitutes`）。 */
function eastAsiaUse(p: RunProps): FontUse {
  return p.eastAsiaTheme ? 'themeEastAsia' : 'eastAsia'
}

/** 字体表中按中文字符集判断字体选择的 `w:charset`：GB2312 与 Big5。 */
const CHINESE_CHARSETS = new Set([0x86, 0x88])

/** 码位缺字形时改用 `EMOJI_FALLBACK`。 */
export function emojiFallback(cp: number): boolean {
  return EMOJI_RANGES.some(([from, to]) => cp >= from && cp <= to)
}

/** 行内公式的一段：行内对象与排版结果；不能排版的公式为一段，结果为 `null`。 */
interface FormulaSegment {
  readonly object: InlineObject
  readonly layout: MathLayout<TextFace> | null
}

/** 断行字段的来源：公式的一段，或 `Paragraph.images` 的下标；文字字段为 `null`。 */
type RunSource = { readonly formula: FormulaSegment } | { readonly image: number } | null

/** 排版结果中供绘制的部分：不含断行分段与行的位置。 */
function bare<F>(m: MathLayout<F>): MathLayout<F> {
  return {
    width: m.width,
    ascent: m.ascent,
    descent: m.descent,
    lineAscent: m.lineAscent,
    lineDescent: m.lineDescent,
    items: m.items,
  }
}

function objectBox(im: InlineImage): number {
  return im.height + im.effect.top + im.effect.bottom
}

function objectWidth(im: InlineImage): number {
  return im.width + im.effect.left + im.effect.right
}

/** 嵌入式对象的行内对象（见文件头）。 */
function imageObject(im: InlineImage): InlineObject {
  const width = objectWidth(im)
  return {
    advance: width,
    width,
    ascent: objectBox(im) + im.raise,
    descent: -im.raise,
    breaks: 'ideographic',
    breakBefore: false,
    textual: false,
  }
}

/** 显示公式段落的对齐方式；不是显示公式的段落为 `null`。 */
function displayOf(p: Paragraph): MathJustification | null {
  return p.runs[0]?.math?.display ?? null
}

/** 全部大写：大小写转换改变字符数的字符保持原样，使片段的起止位置对应字段文字。 */
export function upper(text: string): string {
  let out = ''
  for (const ch of text) {
    const u = ch.toUpperCase()
    out += u.length === ch.length ? u : ch
  }
  return out
}

/** 编号字段的文字（编号与后缀）。 */
export function numberingText(p: Paragraph): string {
  const n = p.numbering
  if (n === null) return ''
  return n.text + (n.suffix === 'tab' ? '\t' : n.suffix === 'space' ? ' ' : '')
}

/** 段落文字（编号字段与各字段依次相接）中位置 `position` 所在的行。 */
export function lineAt(lines: readonly TextLine[], position: number): number {
  for (let i = 0; i < lines.length; i++)
    if (position >= lines[i]!.start && position < lines[i]!.end) return i
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.start <= position) return i
  return 0
}

export interface BlockSpacing {
  readonly before: number
  readonly after: number
  readonly borderTop: number
  readonly borderBottom: number
}

const NO_SPACING: BlockSpacing = { before: 0, after: 0, borderTop: 0, borderBottom: 0 }

/** 段落四边中绘制的边框（不含 `none`）：相邻两段相同时合为一组。 */
function drawnBorders(p: Paragraph): string {
  const b = p.props.borders
  return (['top', 'bottom', 'left', 'right'] as const)
    .map((side) => {
      const x = b?.[side] ?? null
      return x === null || x.style === 'none' ? '' : `${x.style}/${x.width}/${x.color}/${x.space}`
    })
    .join('|')
}

/**
 * 第 `i` 块段落的上下边框占用的高度（WPS 12.1 实测，构造文档 w6-border、w6-border2、w7-bdr、w7-bdrh1、w7-bdrh2）：
 * - 与上一段（下一段）绘制的边框相同时两段为一组，其间的下边框与上边框不占高度。
 * - 绘制的边框占 `space` 加线组宽度（`borderSpace`），上下两侧相同。
 * - `none` 带 `space` 的上边框不在组中时占 `space`：容器的第一段，或本段另有绘制的边框；
 *   `none` 带 `space` 的下边框占两倍 `space`，与相邻段落无关。左右两侧不占高度。
 */
function borderExtents(blocks: readonly Block[], i: number, p: Paragraph): BlockSpacing {
  const b = p.props.borders
  if (b === null) return NO_SPACING
  const own = drawnBorders(p)
  const grouped = (k: number) => {
    const q = blocks[k]
    return q !== undefined && q.kind === 'paragraph' && drawnBorders(q) === own
  }
  const top =
    b.top === null || grouped(i - 1)
      ? 0
      : b.top.style === 'none'
        ? b.top.space
        : b.top.space + borderSpace(b.top)
  const bottom =
    b.bottom === null
      ? 0
      : b.bottom.style === 'none'
        ? 2 * b.bottom.space
        : grouped(i + 1)
          ? 0
          : b.bottom.space + borderSpace(b.bottom)
  return { before: 0, after: 0, borderTop: top, borderBottom: bottom }
}

/** 同一容器中第 `i` 块段落的段前段后间距（已按 `contextualSpacing` 抵消）与上下边框占用的高度。 */
export function contextSpacing(blocks: readonly Block[], i: number): BlockSpacing {
  const p = blocks[i]
  if (p === undefined || p.kind !== 'paragraph') return NO_SPACING
  const same = (k: number) => {
    const b = blocks[k]
    return b !== undefined && b.kind === 'paragraph' && b.style === p.style
  }
  const q = p.props
  return {
    ...borderExtents(blocks, i, p),
    before: q.contextualSpacing && same(i - 1) ? 0 : q.before,
    after: q.contextualSpacing && same(i + 1) ? 0 : q.after,
  }
}

export class ParagraphLayouter {
  private readonly faces = new Map<string, TextFace>()
  private readonly missing = new Set<string>()
  private readonly chinese: Set<string>
  private readonly noBreakBefore: ReadonlySet<number>
  private readonly noBreakAfter: ReadonlySet<number>
  private readonly formulaCache = new WeakMap<RunMath, readonly FormulaSegment[]>()
  /** 显示公式段落的排版结果：按段落第一个公式与可用宽度。 */
  private readonly displayCache = new WeakMap<
    RunMath,
    Map<number, MathParagraphResult<TextFace> | null>
  >()
  private mathFont: MathFont<TextFace> | null | undefined
  private emoji: TextFace | null | undefined

  constructor(
    private readonly doc: DocxDocument,
    private readonly source: FontSource,
  ) {
    this.chinese = new Set()
    for (const [name, entry] of doc.fontTable)
      if (entry.charset !== null && CHINESE_CHARSETS.has(entry.charset)) this.chinese.add(name)
    const s = doc.settings
    this.noBreakBefore =
      s.noLineBreakBefore === null
        ? DEFAULT_NO_LINE_BREAK_BEFORE
        : codePointSet(s.noLineBreakBefore)
    this.noBreakAfter =
      s.noLineBreakAfter === null ? DEFAULT_NO_LINE_BREAK_AFTER : codePointSet(s.noLineBreakAfter)
  }

  /** `face` 返回 `null` 的字体名。 */
  get missingFonts(): readonly string[] {
    return [...this.missing]
  }

  /** `use` 为该字体在字段中的用途，决定主机没有该字体时的替代（见 `substitutes`）。 */
  face(name: string, bold: boolean, italic: boolean, use: FontUse = 'other'): TextFace {
    const key = `${name}\u0000${bold ? 1 : 0}${italic ? 1 : 0}${use}`
    let f = this.faces.get(key)
    if (f === undefined) {
      let found = this.source.face(name, bold, italic)
      if (found === null) {
        this.missing.add(name)
        found = this.substitute(name, bold, italic, use)
      }
      const base = found?.face ?? this.source.fallback
      f = bold && found?.bold !== true ? emboldened(base) : base
      this.faces.set(key, f)
    }
    return f
  }

  /**
   * 制表位前导符的绘制方式：`tab` 为制表符的字体（`LineLeader.face`），`props` 与 `field` 为制表符所在的字段；字号、粗体与
   * 斜体取该字段。目录域结果中字体为 `tab`，整数个前导符与制表位的终点相接；其余为 `LEADER_FONT`，自制表符的起点排起。
   * WPS 实测（构造文档 w13 l1、m1–m4、n1 与语料目录页）：目录域以外，制表符字段为黑体、Arial、Courier New、微软雅黑、
   * Segoe Print 等，或文档缺省字体、缺省段落样式、段落样式与字符样式另设字体时，前导符都为 Times New Roman，第一个点
   * 位于制表符起点，余量留在页码之前；目录域结果中制表符字段为 Arial 时为 Arial，最后一个点止于页码左端。
   */
  leaderStyle(tab: TextFace, props: RunProps, field: string | null): LeaderStyle {
    if (field === 'TOC') return { face: tab, end: true }
    return { face: this.face(LEADER_FONT, props.bold, props.italic), end: false }
  }

  /** 第一个主机有且含所需代码页的替代字体；都没有时为 `null`。 */
  private substitute(name: string, bold: boolean, italic: boolean, use: FontUse): FontMatch | null {
    for (const c of substitutes(name, use, this.doc.fontTable)) {
      const found = this.source.face(c.name, bold, italic)
      if (found !== null && ((found.face.vertical.codePages ?? 0) & c.codePages) === c.codePages)
        return found
    }
    return null
  }

  /** 缺字形时改用的字体（见 `EMOJI_FALLBACK`）：主机没有该字体或其中也没有该字形时为 `FontSource.fallback`。 */
  private glyphFallback(cp: number): TextFace {
    if (emojiFallback(cp)) {
      if (this.emoji === undefined)
        this.emoji = this.source.face(EMOJI_FALLBACK, false, false)?.face ?? null
      if (this.emoji !== null && this.emoji.metrics.glyphId(cp) !== 0) return this.emoji
    }
    return this.source.fallback
  }

  private slots(p: RunProps): SlotContext {
    return {
      eastAsiaHint: p.hint === 'eastAsia',
      complexScript: p.complexScript,
      chineseCharset: this.chinese.has(p.fonts.eastAsia),
    }
  }

  private textRun(text: string, p: RunProps): TextRun {
    const fonts: RunFonts = {
      ascii: this.face(p.fonts.ascii, p.bold, p.italic),
      hAnsi: this.face(p.fonts.hAnsi, p.bold, p.italic),
      eastAsia: this.face(p.fonts.eastAsia, p.bold, p.italic, eastAsiaUse(p)),
      cs: this.face(p.fonts.cs, p.boldCs, p.italicCs),
    }
    const run: TextRun = {
      text: (p.caps ? upper(text) : text).replace(PAGE_OR_COLUMN_BREAK, '\n'),
      fonts,
      size: p.complexScript ? p.sizeCs : p.size,
      slots: this.slots(p),
      spacing: p.spacing,
      raise: p.position,
      kern: p.kern,
      eastAsiaLanguage: p.eastAsiaLanguage,
    }
    return p.vertAlign === 'baseline' ? run : { ...run, script: p.vertAlign }
  }

  /** 公式字段的字符属性：普通文字与数学字体缺字的字符按字段的字体（缺字时为 `fallback`）排版。 */
  private mathStyle(p: RunProps): MathRunStyle<TextFace> {
    const slots = this.slots(p)
    return {
      size: p.size,
      color: p.color ?? '#000000',
      bold: p.bold,
      italic: p.italic,
      textFace: (cp) => {
        const slot = fontSlot(cp, slots)
        const eastAsia = slot === 'eastAsia'
        let face = this.face(p.fonts[slot], p.bold, p.italic, eastAsia ? eastAsiaUse(p) : 'other')
        if (face.metrics.glyphId(cp) === 0) face = this.glyphFallback(cp)
        return { face, font: face, outlines: this.source.outlines(face), eastAsia }
      },
    }
  }

  /** 公式的排版环境：没有字符属性的部分取 `props`；主机既没有文档的数学字体也没有 Cambria Math 时为 `null`。 */
  private mathEnvironment(props: RunProps): MathEnvironment<RunProps, TextFace> | null {
    if (this.mathFont === undefined)
      this.mathFont =
        this.source.math(this.doc.settings.math.font) ??
        this.source.math(MATH_SETTINGS_DEFAULTS.font)
    const font = this.mathFont
    if (font === null) return null
    const styles = new Map<RunProps, MathRunStyle<TextFace>>()
    const style = (p: RunProps | null) => {
      const key = p ?? props
      let st = styles.get(key)
      if (st === undefined) {
        st = this.mathStyle(key)
        styles.set(key, st)
      }
      return st
    }
    return { font, settings: this.doc.settings.math, style }
  }

  /** 行内公式的各段，按公式缓存。 */
  private formula(math: RunMath, props: RunProps): readonly FormulaSegment[] {
    const cached = this.formulaCache.get(math)
    if (cached !== undefined) return cached
    const env = this.mathEnvironment(props)
    const result = env === null ? null : layoutMath(math.zone, env, false)
    const out =
      result !== null && result.kind === 'layout'
        ? result.segments.map(
            (g, k): FormulaSegment => ({
              object: {
                advance: g.advance,
                width: g.width,
                ascent: g.lineAscent,
                descent: g.lineDescent,
                breaks: 'western',
                breakBefore: k > 0,
                textual: true,
              },
              layout: bare(g),
            }),
          )
        : [this.hiddenFormula(props)]
    this.formulaCache.set(math, out)
    return out
  }

  /** 未排版的公式：宽度为 0，上下沿取字段属性的字体。 */
  private hiddenFormula(props: RunProps): FormulaSegment {
    const face = this.face(props.fonts.hAnsi, props.bold, props.italic)
    const e = faceExtent(face.vertical, props.size)
    const object: InlineObject = {
      advance: 0,
      width: 0,
      ascent: e.ascent,
      descent: e.descent,
      breaks: 'western',
      breakBefore: false,
      textual: true,
    }
    return { object, layout: null }
  }

  /** 显示公式段落的排版结果，按段落与可用宽度缓存；主机没有数学字体时为 `null`。 */
  private displayResult(
    p: Paragraph,
    justification: MathJustification,
    width: number,
  ): MathParagraphResult<TextFace> | null {
    const first = p.runs[0]!
    const key = first.math!
    let byWidth = this.displayCache.get(key)
    if (byWidth === undefined) {
      byWidth = new Map()
      this.displayCache.set(key, byWidth)
    }
    if (byWidth.has(width)) return byWidth.get(width)!
    const env = this.mathEnvironment(first.props)
    const zones = p.runs.map((r) => r.math!.zone)
    const result = env === null ? null : layoutMathParagraph({ justification, zones }, env, width)
    byWidth.set(width, result)
    return result
  }

  /** 显示公式段落的行（见文件头）；公式不能排版时为 `null`。 */
  private displayLines(
    p: Paragraph,
    justification: MathJustification,
    width: number,
    markSingle: number,
  ): { text: TextBlock; formulas: LineFormula[] } | null {
    const result = this.displayResult(p, justification, width)
    if (result === null || result.kind !== 'layout') return null
    const end = p.runs.reduce((n, r) => n + r.text.length, 0)
    const lines: TextLine[] = []
    const formulas: LineFormula[] = []
    let top = 0
    result.lines.forEach((l, k) => {
      const box = lineBox(
        [{ ascent: l.lineAscent, descent: l.lineDescent, single: markSingle }],
        p.props.lineSpacing,
        null,
      )
      const baseline = top + box.baseline
      lines.push({
        start: k === 0 ? 0 : end,
        end,
        top,
        height: box.height,
        baseline,
        left: l.x,
        width: l.width,
        origin: 0,
        limit: width,
        fragments: [],
        leaders: [],
        objects: [],
        forcedBreak: false,
      })
      formulas.push({ line: k, x: l.x, baseline, layout: bare(l) })
      top += box.height
    })
    return { text: { lines, height: top }, formulas }
  }

  /**
   * 在宽度为 `region` 的区域中排版一段。`block` 记录在结果中；`area` 为环绕查询（区段横坐标相对区域左边），
   * 不给出时每行为整个可用宽度。
   */
  layout(
    p: Paragraph,
    block: number,
    region: number,
    spacing: BlockSpacing,
    area?: AreaQuery,
  ): ParagraphLayout {
    const props = p.props
    const width = region - props.left - props.right
    const mark = this.face(p.mark.fonts.hAnsi, p.mark.bold, p.mark.italic)
    const markExtent = faceExtent(mark.vertical, p.mark.size)
    const display = displayOf(p)
    const shown = display === null ? null : this.displayLines(p, display, width, markExtent.single)
    const { runs, map, sources, style } = this.textInput(p, width, props, display !== null)
    const lineArea =
      area === undefined
        ? undefined
        : (top: number, height: number): LineArea => {
            const a = area(top, height)
            const segments: { left: number; width: number }[] = []
            for (const g of a.segments) {
              const left = Math.max(g.left, props.left) - props.left
              const right = Math.min(g.left + g.width, region - props.right) - props.left
              if (right - left > 0) segments.push({ left, width: right - left })
            }
            return { top: a.top, segments: segments.length > 0 ? segments : [{ left: 0, width }] }
          }
    const text =
      shown?.text ?? layoutParagraph(runs, lineArea === undefined ? style : { ...style, lineArea })
    const placed = placeObjects(p, text, sources)
    const ls = props.lineSpacing
    const gridBottoms =
      style.gridPitch !== null && ls.rule === 'multiple' && ls.value > 1
        ? textBottoms(text, placed, markExtent.descent)
        : NO_LINES
    return {
      block,
      left: props.left,
      width,
      spaceBefore: spacing.before,
      spaceAfter: spacing.after,
      borderTop: spacing.borderTop,
      borderBottom: spacing.borderBottom,
      text,
      runs: map,
      objects: placed.boxes,
      gridBottoms,
      images: placed.images,
      formulas: shown?.formulas ?? placed.formulas,
    }
  }

  /**
   * 段落的断行输入：字段、各字段的来源与段落格式。`width` 为可用宽度，缩进取 `indent`；`display` 为显示公式段落：
   * 公式字段按未排版的公式参与，不对齐行网格。
   */
  private textInput(
    p: Paragraph,
    width: number,
    indent: { readonly left: number; readonly firstLine: number },
    display: boolean,
  ): { runs: ParagraphRun[]; map: number[]; sources: RunSource[]; style: ParagraphStyle } {
    const section = this.doc.sections[p.section]!
    const s = this.doc.settings
    const props = p.props
    const runs: ParagraphRun[] = []
    const map: number[] = []
    const sources: RunSource[] = []
    const add = (run: ParagraphRun, source: number, from: RunSource) => {
      runs.push(run)
      map.push(source)
      sources.push(from)
    }
    const n = p.numbering
    if (n !== null) {
      const text = numberingText(p)
      if (text !== '')
        add({ ...this.textRun(text, n.props), numbering: { align: n.align } }, -1, null)
    }
    let image = 0
    /** 位于第 `run` 个字段之前的嵌入式对象。 */
    const imagesBefore = (run: number) => {
      for (; image < p.images.length && p.images[image]!.run <= run; image++)
        add({ object: imageObject(p.images[image]!) }, p.images[image]!.run, { image })
    }
    p.runs.forEach((r, i) => {
      imagesBefore(i)
      if (r.math === undefined) {
        add(this.textRun(r.text, r.props), i, null)
        return
      }
      const segments = display ? [this.hiddenFormula(r.props)] : this.formula(r.math, r.props)
      for (const formula of segments) add({ object: formula.object }, i, { formula })
    })
    imagesBefore(Number.POSITIVE_INFINITY)
    const gridPitch =
      !display && props.snapToGrid && section.linePitch > 0 ? section.linePitch : null
    const mark = this.face(p.mark.fonts.hAnsi, p.mark.bold, p.mark.italic)
    const style: ParagraphStyle = {
      width,
      firstLineIndent: indent.firstLine,
      align: props.align,
      lineSpacing: props.lineSpacing,
      gridPitch,
      kinsoku: props.kinsoku,
      wordWrap: props.wordWrap,
      overflowPunct: props.overflowPunct,
      autoSpaceDE: props.autoSpaceDE,
      autoSpaceDN: props.autoSpaceDN,
      expandLineBreak: s.expandLineBreak,
      tabStops: props.tabs.map((t) => ({
        position: t.position - indent.left,
        align: t.align,
        ...(t.leader === null ? {} : { leader: t.leader }),
      })),
      defaultTabStop: s.defaultTabStop,
      tabOrigin: -indent.left,
      noLineBreakBefore: this.noBreakBefore,
      noLineBreakAfter: this.noBreakAfter,
      fallback: (cp) => this.glyphFallback(cp),
      mark: { face: mark, size: p.mark.size },
      compressPunctuation: s.compressPunctuation,
      balanceSingleByte: s.balanceSingleByte,
      // WPS 实测：兼容模式 15 时只有两端对齐与分散对齐的段落悬挂与压缩标点，14 时各种对齐都悬挂。
      compatibilityMode: s.compatibilityMode,
    }
    return { runs, map, sources, style }
  }

  /**
   * 段落的最小与最大内容宽度（含左右缩进，规则见 `../text/` 的 `contentWidths`），缩进取 `ParagraphProps.contentIndent`。
   * 显示公式段落两者都为不断行时最宽一行的宽度。没有内容的段落（含不能排版的显示公式）两者都为 0，不计缩进。
   */
  contentWidths(p: Paragraph): { readonly min: number; readonly max: number } {
    const props = p.props
    const indent = props.contentIndent
    const side = indent.left + props.right
    const display = displayOf(p)
    if (display !== null) {
      const mark = this.face(p.mark.fonts.hAnsi, p.mark.bold, p.mark.italic)
      const shown = this.displayLines(
        p,
        display,
        UNWRAPPED,
        faceExtent(mark.vertical, p.mark.size).single,
      )
      if (shown === null) return { min: 0, max: 0 }
      let w = 0
      for (const line of shown.text.lines) w = Math.max(w, line.width)
      return { min: w + side, max: w + side }
    }
    const { runs, style } = this.textInput(p, UNWRAPPED, indent, false)
    const w = contentWidths(runs, style)
    return w === null ? { min: 0, max: 0 } : { min: w.min + side, max: w.max + side }
  }
}

const NO_LINES: ReadonlyMap<number, number> = new Map()

interface PlacedObjects {
  readonly images: LineImage[]
  readonly formulas: LineFormula[]
  /** 含嵌入式对象的行中对象框的最大高度（行号 → 高度）。 */
  readonly boxes: Map<number, number>
  /** 含公式的行中公式下沿的最大值（行号 → 下沿）。 */
  readonly descents: Map<number, number>
}

/** 行内对象的位置：`sources` 为各断行字段的来源。 */
function placeObjects(p: Paragraph, text: TextBlock, sources: readonly RunSource[]): PlacedObjects {
  const out: PlacedObjects = { images: [], formulas: [], boxes: new Map(), descents: new Map() }
  text.lines.forEach((line, k) => {
    for (const o of line.objects) {
      const from = sources[o.run]
      if (from == null) continue
      if ('image' in from) {
        const im = p.images[from.image]!
        out.images[from.image] = { line: k, x: o.x, baseline: line.baseline - im.raise }
        out.boxes.set(k, Math.max(out.boxes.get(k) ?? 0, objectBox(im)))
        continue
      }
      const f = from.formula
      out.formulas.push({ line: k, x: o.x, baseline: line.baseline, layout: f.layout })
      out.descents.set(k, Math.max(out.descents.get(k) ?? 0, f.object.descent))
    }
  })
  return out
}

/**
 * 各行（不含嵌入式对象所在的行）文字底边距该行文字部分顶边的距离：基线加行内各字体与公式下沿的最大值，没有片段与公式的行
 * 取段落标记字体的下沿 `markDescent`。
 */
function textBottoms(
  text: TextBlock,
  placed: PlacedObjects,
  markDescent: number,
): Map<number, number> {
  const out = new Map<number, number>()
  text.lines.forEach((line, i) => {
    if (placed.boxes.has(i)) return
    const formula = placed.descents.get(i)
    let descent = formula ?? (line.fragments.length === 0 ? markDescent : 0)
    for (const f of line.fragments)
      descent = Math.max(descent, faceExtent(f.face.vertical, f.size).descent)
    out.set(i, line.baseline - line.top - (line.skip ?? 0) + descent)
  })
  return out
}

/** 正文顶层段落的排版：区域为所在节第一栏。 */
export function layoutDocument(doc: DocxDocument, source: FontSource): DocumentLayout {
  const layouter = new ParagraphLayouter(doc, source)
  const paragraphs: ParagraphLayout[] = []
  doc.body.forEach((p, block) => {
    if (p.kind !== 'paragraph') return
    const section = doc.sections[p.section]!
    paragraphs.push(
      layouter.layout(p, block, section.columns[0]!.width, contextSpacing(doc.body, block)),
    )
  })
  return { paragraphs, missingFonts: layouter.missingFonts }
}
