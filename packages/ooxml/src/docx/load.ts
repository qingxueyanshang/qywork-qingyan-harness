/**
 * docx 解析入口：由文件字节得到 `DocxDocument`。纯函数，不依赖 DOM，可在 Worker 中运行。
 *
 * - 部件按关系定位：包关系的 `officeDocument` 为主文档，其关系给出样式、编号、设置、字体表与主题；
 *   缺少的部件按空部件处理。
 * - 主文档的内容类型不是 WordprocessingML 文档（含启用宏的文档与模板）或主文档不存在时返回 `corrupt('document')`；
 *   部件 XML 结构错误时返回 `corrupt('xml')`。ZIP 与 OPC 层的失败原样返回。
 * - `AlternateContent` 选择 WordprocessingML 2010 扩展、绘图形状、组合与画布的分支，使其中的对象按 DrawingML 计数。
 * - 各节引用的页眉页脚部件按引用它的第一节的版面解析；图片（嵌入式图片、浮动对象、页面背景）按所在部件的关系
 *   取得部件字节，同一部件只读取一次。部件不存在时该页眉页脚没有内容，图片的 `media` 为 -1。
 *   正文中引用浏览器无法解码的图片格式时每次引用计一次 `imageFormat`，与其他种类相同，页眉页脚不计数。
 * - 形状的颜色按主题与缺省颜色映射求值；没有主题部件时按空主题。
 * - 页面背景（颜色与整页图片）只在设置开启 `displayBackgroundShape` 时保留（WPS 实测：未开启时颜色与图片都不显示）。
 */

import { countImage } from '../drawingml/shape/resolve.ts'
import { EMPTY_THEME, parseTheme } from '../drawingml/theme.ts'
import {
  type OpcFailure,
  type OpcPackage,
  openPackage,
  type Relationships,
} from '../opc/package.ts'
import { PartScanner } from '../opc/scanner.ts'
import { XmlSyntaxError } from '../xml/index.ts'
import type { Block, DocxDocument, MediaPart, UnsupportedCounts, UnsupportedKind } from './model.ts'
import { type BodyEnv, BodyReader } from './parse/body.ts'
import { EMPTY_NUMBERING, readNumbering } from './parse/numbering.ts'
import { DEFAULT_SETTINGS, readChineseCharsetFonts, readSettings } from './parse/settings.ts'
import { EMPTY_STYLES, readStyles } from './parse/styles.ts'
import { Resolver } from './resolve/cascade.ts'
import { NumberingState } from './resolve/numbering.ts'

export type DocxFailure =
  | OpcFailure
  | { readonly kind: 'corrupt'; readonly reason: 'document' | 'xml' }

export type DocxResult =
  | { readonly ok: true; readonly value: DocxDocument }
  | { readonly ok: false; readonly failure: DocxFailure }

const DOCUMENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.ms-word.document.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
])

const SUPPORTED_NAMESPACES = [
  'http://schemas.microsoft.com/office/word/2010/wordml',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
]

class PartError extends Error {
  constructor(readonly failure: DocxFailure) {
    super(failure.kind)
  }
}

async function partText(pkg: OpcPackage, part: string | null): Promise<string | null> {
  if (part === null) return null
  const r = await pkg.text(part)
  if (!r.ok) throw new PartError(r.failure)
  return r.value
}

export async function parseDocx(data: Uint8Array<ArrayBuffer>): Promise<DocxResult> {
  const opened = await openPackage(data)
  if (!opened.ok) return opened
  try {
    return { ok: true, value: await parsePackage(opened.value) }
  } catch (e) {
    if (e instanceof PartError) return { ok: false, failure: e.failure }
    if (e instanceof XmlSyntaxError)
      return { ok: false, failure: { kind: 'corrupt', reason: 'xml' } }
    throw e
  }
}

async function parsePackage(pkg: OpcPackage): Promise<DocxDocument> {
  const root = await pkg.relationships('/')
  if (!root.ok) throw new PartError(root.failure)
  const main = root.value.part('officeDocument')
  if (main === null || !DOCUMENT_TYPES.has(pkg.contentType(main) ?? '')) {
    throw new PartError({ kind: 'corrupt', reason: 'document' })
  }
  const xml = await partText(pkg, main)
  if (xml === null) throw new PartError({ kind: 'corrupt', reason: 'document' })
  const rels = await pkg.relationships(main)
  if (!rels.ok) throw new PartError(rels.failure)
  const part = (kind: string) => partText(pkg, rels.value.part(kind))

  const stylesXml = await part('styles')
  const styles = stylesXml === null ? EMPTY_STYLES : readStyles(new PartScanner(stylesXml))
  const numberingXml = await part('numbering')
  const numbering =
    numberingXml === null ? EMPTY_NUMBERING : readNumbering(new PartScanner(numberingXml))
  const settingsXml = await part('settings')
  const settings =
    settingsXml === null ? DEFAULT_SETTINGS : readSettings(new PartScanner(settingsXml))
  const fontTableXml = await part('fontTable')
  const chineseCharsetFonts =
    fontTableXml === null ? [] : readChineseCharsetFonts(new PartScanner(fontTableXml))
  const themeXml = await part('theme')
  const theme = themeXml === null ? null : parseTheme(themeXml)

  const unsupported: UnsupportedCounts = {}
  const count = (kind: UnsupportedKind) => {
    unsupported[kind] = (unsupported[kind] ?? 0) + 1
  }
  const state = new NumberingState(numbering, styles, () => count('numberFormat'))
  const resolver = new Resolver(styles, state, {
    scheme: theme?.fonts ?? null,
    eastAsiaLanguage: settings.eastAsiaLanguage,
    bidiLanguage: settings.bidiLanguage,
  })
  const mediaParts: string[] = []
  const media = (part: string): number => {
    if (!pkg.has(part)) return -1
    const known = mediaParts.indexOf(part)
    if (known >= 0) return known
    mediaParts.push(part)
    return mediaParts.length - 1
  }
  const env = (source: Relationships, found: (kind: UnsupportedKind) => void): BodyEnv => ({
    styles,
    rels: source,
    scope: {
      theme: theme ?? EMPTY_THEME,
      colors: { scheme: (theme ?? EMPTY_THEME).colors },
      found: { push: () => {} },
    },
    media: (part) => {
      const index = media(part)
      if (index >= 0) countImage(pkg.contentType(part) ?? '', { push: () => found('imageFormat') })
      return index
    },
    gridInTables: settings.adjustLineHeightInTable,
  })
  const scan = (text: string) => new PartScanner(text, SUPPORTED_NAMESPACES)
  const body = new BodyReader(scan(xml), resolver, count, env(rels.value, count)).read()
  const parts: Record<string, readonly Block[]> = {}
  for (const section of body.sections) {
    const { headers, footers } = section
    for (const id of [
      headers.default,
      headers.first,
      headers.even,
      footers.default,
      footers.first,
      footers.even,
    ]) {
      if (id === null || id in parts) continue
      const part = rels.value.byId(id)?.part ?? null
      const text = await partText(pkg, part)
      const partRels = part === null ? null : await pkg.relationships(part)
      if (partRels !== null && !partRels.ok) throw new PartError(partRels.failure)
      const quiet = () => {}
      parts[id] =
        text === null || partRels === null
          ? []
          : new BodyReader(scan(text), resolver, quiet, env(partRels.value, quiet)).readStory(
              section,
            )
    }
  }
  const mediaList: MediaPart[] = []
  for (const part of mediaParts) {
    const r = await pkg.bytes(part)
    if (!r.ok) throw new PartError(r.failure)
    mediaList.push({
      part,
      contentType: pkg.contentType(part) ?? '',
      bytes: r.value === null ? new Uint8Array(0) : new Uint8Array(r.value),
    })
  }
  return {
    sections: body.sections,
    body: body.body,
    settings: {
      defaultTabStop: settings.defaultTabStop / 20,
      expandLineBreak: !settings.doNotExpandShiftReturn,
      noLineBreakBefore: settings.noLineBreakBefore,
      noLineBreakAfter: settings.noLineBreakAfter,
      compressPunctuation: settings.compressPunctuation,
      balanceSingleByte: settings.balanceSingleByte,
      compatibilityMode: settings.compatibilityMode,
      evenAndOddHeaders: settings.evenAndOddHeaders,
      gridInTables: settings.adjustLineHeightInTable,
    },
    chineseCharsetFonts,
    unsupported,
    parts,
    media: mediaList,
    background: settings.displayBackgroundShape ? body.background : null,
  }
}
