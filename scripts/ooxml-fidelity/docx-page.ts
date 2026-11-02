/**
 * docx 候选截图的浏览器入口（由 `docx-candidates.ts` 打包）：解析 docx、以字节注册字体、分页并绘制指定页。
 *
 * 页面向 `window` 暴露 `renderPage(id, n, width, height, clearType)`（`n` 从 1 起，`clearType` 为采集时显示器的
 * ClearType 设置，返回本方总页数与该页统计）与 `pageCount(id)`；截图由 Node 驱动的 Playwright 完成。
 * 本文件只声明用到的浏览器接口，不引入 DOM 类型库。
 * 字体按 `requiredFonts` 的字体名取得，含公式所用的数学字体；主机字体的族名（`/families`）与界面相同，供前缀匹配。
 */

import {
  type DocumentPages,
  type DocxFace,
  DocxFonts,
  layoutPages,
  loadDocxFace,
  type Page,
  type PageClearType,
  type PageContext,
  type PageItem,
  paintPage,
  parseDocx,
  requiredFonts,
  SCREEN_SCALE,
} from '../../packages/ooxml/src/docx/index.ts'
import {
  decodePicture,
  type ImageDecoder,
  type PaintImage,
  type PaintPicture,
} from '../../packages/ooxml/src/drawingml/index.ts'
import type { HostFamilies } from '../../packages/ooxml/src/text/index.ts'

interface CanvasElement {
  width: number
  height: number
  style: { width: string; height: string }
  getContext(
    kind: '2d',
    options: { alpha: boolean; willReadFrequently: boolean },
  ): PageClearType['target']
}

declare const document: {
  getElementById(id: string): CanvasElement
  fonts: { add(face: unknown): void }
}
declare const window: Record<string, unknown>
declare class FontFace {
  constructor(family: string, source: ArrayBuffer, descriptors: { weight: string; style: string })
  load(): Promise<unknown>
}
declare function createImageBitmap(source: Blob | ImageData): Promise<PaintImage>
declare class ImageData {
  constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number)
}
declare class OffscreenCanvas {
  constructor(width: number, height: number)
  readonly width: number
  readonly height: number
  getContext(kind: '2d'): PageContext | null
}

interface FaceInfo {
  readonly id: string
  readonly bold: boolean
  readonly italic: boolean
}

/** 缺字与缺少字体时使用的字体，与 WPS 一致。 */
const FALLBACK = '宋体'

const loadedFamilies = new Map<string, Promise<DocxFace[]>>()

/** 按字体名取得本机字体，以同一族名注册到页面并读取度量。主机上没有该字体时返回空数组。 */
function loadFamily(name: string): Promise<DocxFace[]> {
  let pending = loadedFamilies.get(name)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(`/font?name=${encodeURIComponent(name)}`)
      if (!res.ok) return []
      const faces = (await res.json()) as FaceInfo[]
      const out: DocxFace[] = []
      for (const f of faces) {
        const bytes = await (await fetch(`/font-face?id=${encodeURIComponent(f.id)}`)).arrayBuffer()
        const face = new FontFace(name, bytes, {
          weight: f.bold ? '700' : '400',
          style: f.italic ? 'italic' : 'normal',
        })
        await face.load()
        document.fonts.add(face)
        out.push(loadDocxFace(new Uint8Array(bytes), name))
      }
      return out
    })()
    loadedFamilies.set(name, pending)
  }
  return pending
}

interface Doc {
  readonly pages: DocumentPages
  readonly fonts: DocxFonts
  readonly images: readonly (PaintPicture | null)[]
}

const docs = new Map<string, Promise<Doc>>()

function loadDoc(id: string): Promise<Doc> {
  let pending = docs.get(id)
  if (!pending) {
    pending = (async () => {
      const bytes = new Uint8Array(
        await (await fetch(`/doc/${encodeURIComponent(id)}`)).arrayBuffer(),
      )
      const parsed = await parseDocx(bytes)
      if (!parsed.ok) throw new Error(`解析失败：${JSON.stringify(parsed.failure)}`)
      const doc = parsed.value
      const host = (await (await fetch('/families')).json()) as HostFamilies
      const names = [...new Set([...requiredFonts(doc, host), FALLBACK])]
      const faces = (await Promise.all(names.map(loadFamily))).flat()
      const fonts = new DocxFonts(faces, FALLBACK)
      const { pages } = layoutPages(doc, fonts, host)
      const decoder: ImageDecoder = {
        file: (bytes, type) => createImageBitmap(new Blob([bytes.slice()], { type })),
        pixels: (width, height, data) => createImageBitmap(new ImageData(data, width, height)),
      }
      const images = await Promise.all(
        pages.images.map((im) => decodePicture(im.bytes, im.contentType, decoder)),
      )
      return { pages, fonts, images }
    })()
    docs.set(id, pending)
  }
  return pending
}

/** 本页的表格个数（含嵌套表格）。 */
function countTables(items: readonly PageItem[]): number {
  let n = 0
  for (const it of items) if (it.kind === 'table') n += 1 + countTables(it.items)
  return n
}

/**
 * 本页 `kind` 种对象（图表或 SmartArt）的个数：段落中的嵌入式对象（含表格中的）与浮动对象（不含组合内的）。
 */
function countGraphics(page: Page, kind: 'chart' | 'diagram'): number {
  const inItems = (items: readonly PageItem[]): number =>
    items.reduce(
      (n, it) =>
        n +
        (it.kind === 'table'
          ? inItems(it.items)
          : it.graphics.filter((g) => g.graphic.kind === kind).length),
      0,
    )
  let n = inItems(page.header) + inItems(page.body) + inItems(page.footer)
  for (const f of page.floats)
    n += f.texts.reduce((m, t) => m + inItems(t.items), 0) + (f.drawing?.kind === kind ? 1 : 0)
  return n
}

/** 本页绘制的公式个数（段落、表格与文本框中的）。 */
function countFormulas(page: Page): number {
  const inItems = (items: readonly PageItem[]): number =>
    items.reduce((n, it) => n + (it.kind === 'table' ? inItems(it.items) : it.formulas.length), 0)
  let n = inItems(page.header) + inItems(page.body) + inItems(page.footer)
  for (const f of page.floats) n += f.texts.reduce((m, t) => m + inItems(t.items), 0)
  return n
}

async function renderPage(
  id: string,
  n: number,
  width: number,
  height: number,
  clearType: PageClearType['display'] | null,
): Promise<{
  pages: number
  tables: number
  floating: number
  charts: number
  diagrams: number
  formulas: number
  hiddenMath: number
} | null> {
  const { pages, fonts, images } = await loadDoc(id)
  const page = pages.pages[n - 1]
  if (!page) return null
  const canvas = document.getElementById('page')
  canvas.width = width
  canvas.height = height
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  // ClearType 字形读写画布像素。画布元素在各页之间复用，绘制上下文的选项取第一页的设置。
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: clearType !== null })
  paintPage(
    ctx,
    page,
    { faces: pages.faces, draw: (ref) => fonts.draw(ref) },
    {
      images,
      parts: pages.images.map((im) => im.part),
      createCanvas: (w, h) => new OffscreenCanvas(w, h),
    },
    SCREEN_SCALE,
    clearType === null ? null : { display: clearType, target: ctx },
  )
  return {
    pages: pages.pages.length,
    tables: countTables(page.body),
    floating: page.floats.length,
    charts: countGraphics(page, 'chart'),
    diagrams: countGraphics(page, 'diagram'),
    formulas: countFormulas(page),
    hiddenMath: page.hiddenMath,
  }
}

window.renderPage = renderPage
window.pageReady = true
