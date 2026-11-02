/**
 * 排版与绘制共用的字体集：排版宽度只取自字体文件，绘制以 `family` 引用调用方注册的同名 `FontFace`。
 *
 * - `source` 交给 `layoutDocument`。请求粗体而字体没有粗体字形时，返回已按仿粗体换算（`emboldened`）的字形并标为粗体，
 *   使排版结果中的每个 `TextFace` 都是本字体集登记过的对象，分页时可由 `ref` 找回字体与字形。
 * - 主机没有的字体由 `layoutDocument` 改用 `fallback` 并记入 `missingFonts`。
 * - 带 `MATH` 表与 TrueType 轮廓的字体另读取为数学字体（`DocxFace.math`），供公式排版（`source.math`）与按轮廓绘制；
 *   公式中的普通文字按其字体的轮廓取墨迹（`source.outlines`）。
 * - `blockFonts` 列出段落用到的字体名，含公式中的字符属性与数学字体（文档所需的全部字体名见 `requiredFonts`）。
 */

import {
  type EmbeddedBitmaps,
  type GlyphOutlines,
  type PixelVerticalMetrics,
  readEmbeddedBitmaps,
  readFaces,
  readGlyphOutlines,
  readHead,
  readMetrics,
  readPixelAdvances,
  readPixelVerticalMetrics,
  readVerticalMetrics,
  tableBytes,
} from '../../font/index.ts'
import { type MathArg, type MathFont, readMathFont } from '../../math/index.ts'
import { emboldened, type TextFace } from '../../text/index.ts'
import { EMOJI_FALLBACK, emojiFallback, type FontMatch, type FontSource } from '../layout.ts'
import type { Block, RunProps } from '../model.ts'
import type { FaceRef } from '../page/model.ts'

export interface DocxFace {
  /** CSS 族名，与调用方注册的 `FontFace` 族名相同。 */
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  readonly text: TextFace
  /** ppem 下的纵向度量，与 GDI `GetTextMetrics` 一致。 */
  readonly pixelVertical: (ppem: number) => PixelVerticalMetrics
  /** ppem 下的整数前进宽度；字体表无法确定时为 `null`。 */
  readonly pixelAdvance: (codePoint: number, ppem: number) => number | null
  /** 内嵌点阵；字体没有点阵时为 `null`。 */
  readonly bitmaps: EmbeddedBitmaps | null
  /** TrueType 字形轮廓；CFF 轮廓的字体为 `null`。 */
  readonly outlines: GlyphOutlines | null
  /** 数学字体：`font` 为本字体的 `text`。字体没有 `MATH` 表或没有 TrueType 轮廓时为 `null`。 */
  readonly math: MathFont<TextFace> | null
}

/** 读取字体文件（或 TTC 中的第 `index` 个字体）。结构不完整时抛出 `FontFormatError`。 */
export function loadDocxFace(bytes: Uint8Array, family: string, index = 0): DocxFace {
  const face = readFaces(bytes)[index]
  if (!face) throw new RangeError(`字体文件中没有第 ${index} 个字体`)
  const head = readHead(tableBytes(bytes, face, 'head'))
  const text: TextFace = {
    metrics: readMetrics(bytes, face),
    vertical: readVerticalMetrics(bytes, face),
  }
  return {
    family,
    bold: head.bold,
    italic: head.italic,
    text,
    pixelVertical: readPixelVerticalMetrics(bytes, face),
    pixelAdvance: readPixelAdvances(bytes, face),
    bitmaps: readEmbeddedBitmaps(bytes, face),
    outlines: readGlyphOutlines(bytes, face),
    math: readMathFont(bytes, index, text),
  }
}

function key(name: string): string {
  return name.trim().toLowerCase()
}

function addRunFonts(out: Set<string>, p: RunProps): void {
  out.add(p.fonts.ascii)
  out.add(p.fonts.hAnsi)
  out.add(p.fonts.eastAsia)
  out.add(p.fonts.cs)
}

/** 公式中的字符属性（字段与结构的 `ctrlPr`）用到的字体名。 */
function addMathFonts(out: Set<string>, nodes: MathArg<RunProps>): void {
  for (const n of nodes) {
    if (n.kind === 'unsupported') continue
    if (n.props !== null) addRunFonts(out, n.props)
    switch (n.kind) {
      case 'run':
        break
      case 'f':
        addMathFonts(out, n.num)
        addMathFonts(out, n.den)
        break
      case 'sSup':
      case 'sSub':
      case 'sSubSup':
        addMathFonts(out, n.base)
        addMathFonts(out, n.sub)
        addMathFonts(out, n.sup)
        break
      case 'rad':
        addMathFonts(out, n.degree)
        addMathFonts(out, n.base)
        break
      case 'nary':
        addMathFonts(out, n.sub)
        addMathFonts(out, n.sup)
        addMathFonts(out, n.base)
        break
      case 'd':
        for (const a of n.items) addMathFonts(out, a)
        break
      case 'eqArr':
        for (const a of n.rows) addMathFonts(out, a)
        break
      case 'func':
        addMathFonts(out, n.name)
        addMathFonts(out, n.base)
        break
      case 'limLow':
      case 'limUpp':
        addMathFonts(out, n.base)
        addMathFonts(out, n.limit)
        break
      case 'acc':
      case 'bar':
      case 'box':
        addMathFonts(out, n.base)
        break
    }
  }
}

/** 块中字段、段落标记、编号与公式用到的字体名；有公式时含数学字体 `mathFont`。 */
export function blockFonts(
  blocks: readonly Block[],
  mathFont: string,
  out: Set<string> = new Set(),
): Set<string> {
  for (const b of blocks) {
    if (b.kind !== 'paragraph') continue
    addRunFonts(out, b.mark)
    if (b.numbering !== null) addRunFonts(out, b.numbering.props)
    for (const r of b.runs) {
      addRunFonts(out, r.props)
      for (const ch of r.text) if (emojiFallback(ch.codePointAt(0)!)) out.add(EMOJI_FALLBACK)
      if (r.math === undefined) continue
      out.add(mathFont)
      addMathFonts(out, r.math.zone.nodes)
    }
  }
  return out
}

export class DocxFonts {
  private readonly byName = new Map<string, DocxFace[]>()
  private readonly matches = new Map<string, FontMatch | null>()
  private readonly refIndex = new Map<TextFace, number>()
  private readonly refList: FaceRef[] = []
  /** 已登记字形所属的字体。 */
  private readonly owners = new Map<TextFace, DocxFace>()
  private readonly fallbackFace: DocxFace
  readonly source: FontSource

  /** `fallback` 为缺字与缺少字体时使用的字体（常规字形），须在 `faces` 中。 */
  constructor(faces: readonly DocxFace[], fallback: string) {
    for (const f of faces) {
      const list = this.byName.get(key(f.family)) ?? []
      list.push(f)
      this.byName.set(key(f.family), list)
    }
    const fb = this.pick(fallback, false, false)
    if (fb === null) throw new RangeError(`字体集中没有回退字体：${fallback}`)
    this.fallbackFace = fb
    this.register(fb.text, fb, false, false)
    this.source = {
      face: (name, bold, italic) => this.match(name, bold, italic),
      math: (name) => this.mathFont(name),
      outlines: (face) => this.owners.get(face)?.outlines ?? null,
      fallback: fb.text,
    }
  }

  private pick(name: string, bold: boolean, italic: boolean): DocxFace | null {
    const list = this.byName.get(key(name))
    if (!list || list.length === 0) return null
    return (
      list.find((f) => f.bold === bold && f.italic === italic) ??
      list.find((f) => f.bold === bold) ??
      list.find((f) => !f.bold && !f.italic) ??
      list[0]!
    )
  }

  private register(text: TextFace, f: DocxFace, bold: boolean, italic: boolean): void {
    this.refIndex.set(text, this.refList.length)
    this.owners.set(text, f)
    this.refList.push({
      family: f.family,
      bold: f.bold,
      italic: f.italic,
      syntheticBold: bold && !f.bold,
      syntheticItalic: italic && !f.italic,
    })
  }

  private match(name: string, bold: boolean, italic: boolean): FontMatch | null {
    const id = `${key(name)}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
    const cached = this.matches.get(id)
    if (cached !== undefined) return cached
    const f = this.pick(name, bold, italic)
    let m: FontMatch | null = null
    if (f !== null) {
      // 合成字形各用一个新的 `TextFace` 对象，使 `ref` 能按对象区分合成与否；度量与原字形相同（仿粗体除外）。
      const syntheticBold = bold && !f.bold
      const syntheticItalic = italic && !f.italic
      let text = f.text
      if (syntheticBold) text = emboldened(text)
      else if (syntheticItalic) text = { metrics: text.metrics, vertical: text.vertical }
      if (syntheticBold || syntheticItalic) this.register(text, f, bold, italic)
      else if (!this.refIndex.has(text)) this.register(text, f, false, false)
      // 已按仿粗体换算的字形标为粗体，`layoutDocument` 不再换算一次。
      m = { face: text, bold: bold || f.bold }
    }
    this.matches.set(id, m)
    return m
  }

  /** 字体名对应的常规字形的数学字体，登记其字形后返回。 */
  private mathFont(name: string): MathFont<TextFace> | null {
    const f = this.pick(name, false, false)
    if (f === null || f.math === null) return null
    if (!this.refIndex.has(f.text)) this.register(f.text, f, false, false)
    return f.math
  }

  /** 缺字与缺少字体时使用的字体。 */
  get fallback(): DocxFace {
    return this.fallbackFace
  }

  /** 已登记的字形，供分页结果引用。 */
  get refs(): readonly FaceRef[] {
    return this.refList
  }

  /**
   * 排版结果中字形的登记序号。未登记的字形只可能是 `layoutDocument` 对缺少的字体在请求粗体时
   * 由回退字体换算的仿粗体，按回退字体的仿粗体登记。
   */
  ref(face: TextFace): number {
    const known = this.refIndex.get(face)
    if (known !== undefined) return known
    this.register(face, this.fallbackFace, true, false)
    return this.refList.length - 1
  }

  /**
   * 按字体名与字形取得字体文件本身的字形（与排版的选取规则相同，不合成），登记后返回序号；主机没有该字体时为 `null`。
   * 供图表与 SmartArt 的文字按字体名取字体（`GraphicFonts`），仿粗体由其文字排版自行处理。
   */
  named(name: string, bold: boolean, italic: boolean): number | null {
    const f = this.pick(name, bold, italic)
    if (f === null) return null
    if (!this.refIndex.has(f.text)) this.register(f.text, f, false, false)
    return this.refIndex.get(f.text)!
  }

  /** 按登记的族名与字形取得绘制用的字体。 */
  draw(ref: FaceRef): DocxFace | null {
    const list = this.byName.get(key(ref.family))
    return list?.find((f) => f.bold === ref.bold && f.italic === ref.italic) ?? null
  }
}
