/**
 * 排版与绘制共用的字体集：排版宽度只取自字体文件，绘制以 `family` 引用调用方注册的同名 `FontFace`。
 *
 * - `source` 交给 `layoutDocument`。请求粗体而字体没有粗体字形时，返回已按仿粗体换算（`emboldened`）的字形并标为粗体，
 *   使排版结果中的每个 `TextFace` 都是本字体集登记过的对象，分页时可由 `ref` 找回字体与字形。
 * - 主机没有的字体由 `layoutDocument` 改用 `fallback` 并记入 `missingFonts`。
 * - `blockFonts` 列出段落用到的字体名（文档所需的全部字体名见 `requiredFonts`）。
 */

import {
  type EmbeddedBitmaps,
  type PixelVerticalMetrics,
  readEmbeddedBitmaps,
  readFaces,
  readHead,
  readMetrics,
  readPixelAdvances,
  readPixelVerticalMetrics,
  readVerticalMetrics,
  tableBytes,
} from '../../font/index.ts'
import { emboldened, type TextFace } from '../../text/index.ts'
import type { FontMatch, FontSource } from '../layout.ts'
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
}

/** 读取字体文件（或 TTC 中的第 `index` 个字体）。结构不完整时抛出 `FontFormatError`。 */
export function loadDocxFace(bytes: Uint8Array, family: string, index = 0): DocxFace {
  const face = readFaces(bytes)[index]
  if (!face) throw new RangeError(`字体文件中没有第 ${index} 个字体`)
  const head = readHead(tableBytes(bytes, face, 'head'))
  return {
    family,
    bold: head.bold,
    italic: head.italic,
    text: { metrics: readMetrics(bytes, face), vertical: readVerticalMetrics(bytes, face) },
    pixelVertical: readPixelVerticalMetrics(bytes, face),
    pixelAdvance: readPixelAdvances(bytes, face),
    bitmaps: readEmbeddedBitmaps(bytes, face),
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

/** 块中字段、段落标记与编号用到的字体名。 */
export function blockFonts(blocks: readonly Block[], out: Set<string> = new Set()): Set<string> {
  for (const b of blocks) {
    if (b.kind !== 'paragraph') continue
    addRunFonts(out, b.mark)
    if (b.numbering !== null) addRunFonts(out, b.numbering.props)
    for (const r of b.runs) addRunFonts(out, r.props)
  }
  return out
}

export class DocxFonts {
  private readonly byName = new Map<string, DocxFace[]>()
  private readonly matches = new Map<string, FontMatch | null>()
  private readonly refIndex = new Map<TextFace, number>()
  private readonly refList: FaceRef[] = []
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

  /** 按登记的族名与字形取得绘制用的字体。 */
  draw(ref: FaceRef): DocxFace | null {
    const list = this.byName.get(key(ref.family))
    return list?.find((f) => f.bold === ref.bold && f.italic === ref.italic) ?? null
  }
}
