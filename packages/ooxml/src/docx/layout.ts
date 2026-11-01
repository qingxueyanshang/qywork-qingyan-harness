/**
 * 逐段排版：把段落的解决结果转换为 `layoutParagraph` 的输入。断行、对齐与行高的规则全部在 `../text/` 中。
 *
 * - `ParagraphLayouter` 在给定区域宽度（栏、单元格或文本框的文字区）中排版一段，可附带环绕查询；正文、单元格、
 *   文本框与页眉页脚共用。`layoutDocument` 排版正文的顶层段落，区域宽度为所在节第一栏的宽度。
 * - 可用宽度为区域宽度减去左右缩进；制表位与制表起点换算为相对左缩进的行坐标。
 * - 字体由调用方按字体名与字形提供（`FontSource.face`）。返回 `null` 的字体改用 `fallback` 并记入 `missingFonts`，
 *   调用方可据此取得字体后重新排版。请求粗体而返回的不是粗体字形时按仿粗体（`emboldened`）排版。
 * - 段前段后间距按 `contextualSpacing` 抵消（`contextSpacing`）：同一容器中相邻段落样式相同时，设置了该项的段落
 *   不留对应一侧的间距。
 * - 全部大写（`caps`）按大写字母排版；大小写转换改变字符数的字符保持原样，使片段的位置与字段文字一一对应。
 * - 分页符与分栏符按强制换行排版（一个字符换一个字符，位置不变），换页与换栏由分页处理。
 * - 嵌入式对象（图片、图表、文本框等）：对象框高度（含 `effectExtent` 的上下范围）作为基线以上的高度参与行高计算，
 *   多倍行距增加的部分按段落标记字体的单倍行高计（WPS 实测：单倍行距时行高等于对象框高度；1.5 倍时为对象框高度加
 *   0.5 倍段落标记的单倍行高；对齐网格时向上取整到网格行距的整数倍）。独占一行时行高取对象行高，与文字同行时
 *   取两者中的较大者，增加部分在文字上方。
 */

import {
  canBreakBetween,
  codePointSet,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  emboldened,
  faceExtent,
  type LineArea,
  layoutParagraph,
  lineBox,
  type ParagraphStyle,
  type RunFonts,
  type TextBlock,
  type TextFace,
  type TextLine,
  type TextRun,
} from '../text/index.ts'
import type { Block, DocxDocument, InlineImage, Paragraph, RunProps } from './model.ts'

export interface FontMatch {
  readonly face: TextFace
  /** 返回的是粗体字形；请求粗体而该项为 `false` 时按仿粗体排版。 */
  readonly bold: boolean
}

export interface FontSource {
  /** 按字体名与字形取得最接近的字体；主机没有该字体时返回 `null`。 */
  face(name: string, bold: boolean, italic: boolean): FontMatch | null
  /** 缺少字形与缺少字体时使用的字体（常规字形）。 */
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
  readonly text: TextBlock
  /** `TextFragment.run` 对应的 `Paragraph.runs` 下标，编号字段为 -1。 */
  readonly runs: readonly number[]
  /** 含嵌入式对象的行中对象框的高度（行号 → 高度）：分页判定可容纳时代替该行的文字部分。 */
  readonly objects: ReadonlyMap<number, number>
  /** 嵌入式对象所在的行与是否独占该行，与 `Paragraph.images` 一一对应。 */
  readonly imageLines: readonly { readonly line: number; readonly alone: boolean }[]
}

export interface DocumentLayout {
  readonly paragraphs: readonly ParagraphLayout[]
  /** `face` 返回 `null` 的字体名，按首次出现的顺序。 */
  readonly missingFonts: readonly string[]
}

/** 环绕查询：`top`、`height` 为段落坐标，返回的区段横坐标相对区域左边。 */
export type AreaQuery = (top: number, height: number) => LineArea

const PAGE_OR_COLUMN_BREAK = /[\f\v]/g

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

/** 同一容器中第 `i` 块段落的段前段后间距，已按 `contextualSpacing` 抵消。 */
export function contextSpacing(
  blocks: readonly Block[],
  i: number,
): { before: number; after: number } {
  const p = blocks[i]
  if (p === undefined || p.kind !== 'paragraph') return { before: 0, after: 0 }
  const same = (k: number) => {
    const b = blocks[k]
    return b !== undefined && b.kind === 'paragraph' && b.style === p.style
  }
  const q = p.props
  return {
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

  constructor(
    private readonly doc: DocxDocument,
    private readonly source: FontSource,
  ) {
    this.chinese = new Set(doc.chineseCharsetFonts)
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

  face(name: string, bold: boolean, italic: boolean): TextFace {
    const key = `${name}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
    let f = this.faces.get(key)
    if (f === undefined) {
      const found = this.source.face(name, bold, italic)
      if (found === null) this.missing.add(name)
      const base = found?.face ?? this.source.fallback
      f = bold && found?.bold !== true ? emboldened(base) : base
      this.faces.set(key, f)
    }
    return f
  }

  private textRun(text: string, p: RunProps): TextRun {
    const fonts: RunFonts = {
      ascii: this.face(p.fonts.ascii, p.bold, p.italic),
      hAnsi: this.face(p.fonts.hAnsi, p.bold, p.italic),
      eastAsia: this.face(p.fonts.eastAsia, p.bold, p.italic),
      cs: this.face(p.fonts.cs, p.boldCs, p.italicCs),
    }
    const run: TextRun = {
      text: (p.caps ? upper(text) : text).replace(PAGE_OR_COLUMN_BREAK, '\n'),
      fonts,
      size: p.complexScript ? p.sizeCs : p.size,
      slots: {
        eastAsiaHint: p.hint === 'eastAsia',
        complexScript: p.complexScript,
        chineseCharset: this.chinese.has(p.fonts.eastAsia),
      },
      spacing: p.spacing,
      raise: p.position,
      kern: p.kern,
      eastAsiaLanguage: p.eastAsiaLanguage,
    }
    return p.vertAlign === 'baseline' ? run : { ...run, script: p.vertAlign }
  }

  /**
   * 在宽度为 `region` 的区域中排版一段。`block` 记录在结果中；`area` 为环绕查询（区段横坐标相对区域左边），
   * 不给出时每行为整个可用宽度。
   */
  layout(
    p: Paragraph,
    block: number,
    region: number,
    spacing: { readonly before: number; readonly after: number },
    area?: AreaQuery,
  ): ParagraphLayout {
    const section = this.doc.sections[p.section]!
    const s = this.doc.settings
    const props = p.props
    const width = region - props.left - props.right
    const runs: TextRun[] = []
    const map: number[] = []
    const n = p.numbering
    if (n !== null) {
      const text = numberingText(p)
      if (text !== '') {
        runs.push({ ...this.textRun(text, n.props), numbering: { align: n.align } })
        map.push(-1)
      }
    }
    p.runs.forEach((r, i) => {
      runs.push(this.textRun(r.text, r.props))
      map.push(i)
    })
    const gridPitch = props.snapToGrid && section.linePitch > 0 ? section.linePitch : null
    const mark = this.face(p.mark.fonts.hAnsi, p.mark.bold, p.mark.italic)
    const style: ParagraphStyle = {
      width,
      firstLineIndent: props.firstLine,
      align: props.align,
      lineSpacing: props.lineSpacing,
      gridPitch,
      kinsoku: props.kinsoku,
      wordWrap: props.wordWrap,
      overflowPunct: props.overflowPunct,
      autoSpaceDE: props.autoSpaceDE,
      autoSpaceDN: props.autoSpaceDN,
      expandLineBreak: s.expandLineBreak,
      tabStops: props.tabs.map((t) => ({ position: t.position - props.left, align: t.align })),
      defaultTabStop: s.defaultTabStop,
      tabOrigin: -props.left,
      noLineBreakBefore: this.noBreakBefore,
      noLineBreakAfter: this.noBreakAfter,
      fallback: this.source.fallback,
      mark: { face: mark, size: p.mark.size },
      compressPunctuation: s.compressPunctuation,
      balanceSingleByte: s.balanceSingleByte,
      // WPS 实测：兼容模式 15 时只有两端对齐与分散对齐的段落悬挂与压缩标点，14 时各种对齐都悬挂。
      justifiedPunctuation: s.compatibilityMode >= 15,
    }
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
    const text = layoutParagraph(runs, lineArea === undefined ? style : { ...style, lineArea })
    const objects = withObjectLines(
      p,
      text,
      faceExtent(mark.vertical, p.mark.size).single,
      gridPitch,
    )
    return {
      block,
      left: props.left,
      width,
      spaceBefore: spacing.before,
      spaceAfter: spacing.after,
      text: objects.text,
      runs: map,
      objects: objects.boxes,
      imageLines: objects.where,
    }
  }

  /**
   * 段落的内容宽度（含左右缩进）：`wide` 为真时为不断行的宽度，否则为最长的不可断开部分的宽度
   * （断点规则同 `canBreakBetween`，空格处可断）。
   */
  contentWidth(p: Paragraph, wide: boolean): number {
    const lay = this.layout(p, 0, p.props.left + p.props.right + 1e6, { before: 0, after: 0 })
    const side = p.props.left + p.props.right
    if (wide) {
      let w = 0
      for (const line of lay.text.lines) w = Math.max(w, line.left + line.width)
      return w + side
    }
    const rules = {
      kinsoku: p.props.kinsoku,
      wordWrap: p.props.wordWrap,
      noLineBreakBefore: this.noBreakBefore,
      noLineBreakAfter: this.noBreakAfter,
    }
    let best = 0
    for (const line of lay.text.lines) {
      let cur = line === lay.text.lines[0] ? Math.max(0, line.left) : 0
      let prev = -1
      for (const f of line.fragments) {
        const src = lay.runs[f.run]!
        const text = src < 0 ? numberingText(p) : p.runs[src]!.text
        let k = 0
        for (const ch of text.slice(f.start, f.end)) {
          const cp = ch.codePointAt(0)!
          const adv = f.advances[k++] ?? 0
          if (cp === 0x20) {
            best = Math.max(best, cur)
            cur = 0
            prev = cp
            continue
          }
          if (prev >= 0 && prev !== 0x20 && canBreakBetween(prev, cp, rules)) {
            best = Math.max(best, cur)
            cur = 0
          }
          cur += adv
          prev = cp
        }
      }
      best = Math.max(best, cur)
    }
    return best + side
  }
}

function objectBox(im: InlineImage): number {
  return im.height + im.effect.top + im.effect.bottom
}

/** 含嵌入式对象的行按对象框加高（见文件头）。 */
function withObjectLines(
  p: Paragraph,
  text: TextBlock,
  markSingle: number,
  gridPitch: number | null,
): {
  text: TextBlock
  boxes: ReadonlyMap<number, number>
  where: { line: number; alone: boolean }[]
} {
  const images = p.images
  if (images.length === 0) return { text, boxes: new Map(), where: [] }
  const full = numberingText(p) + p.runs.map((r) => r.text).join('')
  const shift = numberingText(p).length
  const where = images.map((im) => {
    const line = lineAt(text.lines, im.offset + shift)
    const l = text.lines[line]!
    return { line, alone: full.slice(l.start, l.end).trim() === '' }
  })
  const heights = new Map<number, { box: number; alone: boolean }>()
  where.forEach((w, i) => {
    const prev = heights.get(w.line)
    heights.set(w.line, { box: Math.max(prev?.box ?? 0, objectBox(images[i]!)), alone: w.alone })
  })
  let total = 0
  const lines = text.lines.map((line, i) => {
    const o = heights.get(i)
    const top = total
    if (o === undefined) {
      total += line.height
      return line.top === top ? line : shiftLine(line, top - line.top)
    }
    const h = lineBox(
      [{ ascent: o.box, descent: 0, single: markSingle }],
      p.props.lineSpacing,
      gridPitch,
    ).height
    const height = (line.skip ?? 0) + (o.alone ? h : Math.max(line.height - (line.skip ?? 0), h))
    total += height
    return { ...shiftLine(line, top - line.top + height - line.height), top, height }
  })
  return {
    text: { lines, height: total },
    boxes: new Map([...heights].map(([line, o]) => [line, o.box])),
    where,
  }
}

/** 行整体下移 `dy`（基线与片段同移）。 */
function shiftLine(line: TextLine, dy: number): TextLine {
  if (dy === 0) return line
  return {
    ...line,
    top: line.top + dy,
    baseline: line.baseline + dy,
    fragments: line.fragments.map((f) => ({ ...f, baseline: f.baseline + dy })),
  }
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
