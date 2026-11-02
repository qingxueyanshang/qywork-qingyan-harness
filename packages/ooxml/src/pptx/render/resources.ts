/**
 * 绘制所需的图片与嵌入字体：从文件字节中读取（可在 Worker 中运行）。
 *
 * - 图片的引用来源：图片形状、形状与表格单元格的图片填充、文字的图片填充、背景、组合内的后代。
 *   解码由调用方完成（`../../drawingml/paint/picture.ts` 的 `decodePicture`：位图与图元文件）；无法绘制的图片已在解析时
 *   计入 `imageFormat`。
 * - 嵌入字体：部件为 EOT（含 MicroType Express 压缩与异或）时还原为 TrueType 或 CFF 字体字节，
 *   部件本身为 sfnt 时原样使用；两者都不是或还原失败的计入 `failed`。字体字节由调用方以 `typeface`
 *   为族名注册为 `FontFace`，并读取度量。
 */

import type { ShapeFill } from '../../drawingml/fill.ts'
import type { TextBody } from '../../drawingml/text/model.ts'
import { readEmbeddedOpenType } from '../../font/embedded/eot.ts'
import { FontFormatError, readFaces } from '../../font/sfnt.ts'
import { openPackage } from '../../opc/package.ts'
import type { EmbeddedFont, Shape, Slide } from '../model.ts'

function addFill(out: Set<string>, fill: ShapeFill | null): void {
  if (fill?.kind === 'picture' && fill.image.part !== null) out.add(fill.image.part)
}

function addText(out: Set<string>, text: TextBody): void {
  for (const p of text.paragraphs) for (const r of p.runs) addFill(out, r.style.fill)
}

function addShape(out: Set<string>, s: Shape): void {
  switch (s.kind) {
    case 'shape':
      addFill(out, s.fill)
      if (s.text !== null) addText(out, s.text)
      return
    case 'picture':
      addFill(out, s.fill)
      if (s.image.part !== null) out.add(s.image.part)
      return
    case 'group':
      for (const c of s.children) addShape(out, c)
      return
    case 'table':
      addFill(out, s.fill)
      for (const row of s.rows) {
        for (const cell of row.cells) {
          addFill(out, cell.fill)
          addText(out, cell.text)
        }
      }
      return
    default:
      return
  }
}

/** 幻灯片引用的图片部件名，按首次出现的顺序。 */
export function slideImages(slide: Slide): string[] {
  const out = new Set<string>()
  addFill(out, slide.background)
  for (const s of slide.shapes) addShape(out, s)
  return [...out]
}

export interface ImagePart {
  readonly bytes: Uint8Array
  /** 部件的内容类型；缺失时为空串。 */
  readonly contentType: string
}

/** 读取图片部件；包无法打开或部件不存在时该项不在结果中。 */
export async function readImages(
  data: Uint8Array<ArrayBuffer>,
  parts: readonly string[],
): Promise<Map<string, ImagePart>> {
  const out = new Map<string, ImagePart>()
  const opened = await openPackage(data)
  if (!opened.ok) return out
  const pkg = opened.value
  for (const part of parts) {
    const r = await pkg.bytes(part)
    if (!r.ok || r.value === null) continue
    out.set(part, { bytes: r.value, contentType: pkg.contentType(part) ?? '' })
  }
  return out
}

export interface EmbeddedFontFile {
  readonly typeface: string
  readonly bold: boolean
  readonly italic: boolean
  /** TrueType 或 CFF 字体字节。 */
  readonly bytes: Uint8Array
}

/** 字节本身是否为可读的 sfnt 字体。 */
function isSfnt(bytes: Uint8Array): boolean {
  try {
    readFaces(bytes)
    return true
  } catch (e) {
    if (e instanceof FontFormatError) return false
    throw e
  }
}

/**
 * 读取嵌入字体：`list` 取自 `presentation.embeddedFonts`，调用方可先去掉主机已有的字体以免无谓的解压
 * （中文字体还原后可达数十兆字节）。`failed` 为无法还原的部件。
 */
export async function readEmbeddedFonts(
  data: Uint8Array<ArrayBuffer>,
  list: readonly EmbeddedFont[],
): Promise<{ fonts: EmbeddedFontFile[]; failed: string[] }> {
  const fonts: EmbeddedFontFile[] = []
  const failed: string[] = []
  if (list.length === 0) return { fonts, failed }
  const opened = await openPackage(data)
  if (!opened.ok) return { fonts, failed: list.map((f) => f.part) }
  for (const f of list) {
    const r = await opened.value.bytes(f.part)
    if (!r.ok || r.value === null) {
      failed.push(f.part)
      continue
    }
    try {
      const bytes = isSfnt(r.value) ? r.value : readEmbeddedOpenType(r.value).font
      fonts.push({ typeface: f.typeface, bold: f.bold, italic: f.italic, bytes })
    } catch (e) {
      if (!(e instanceof FontFormatError)) throw e
      failed.push(f.part)
    }
  }
  return { fonts, failed }
}
