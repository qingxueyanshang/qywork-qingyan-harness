/**
 * pptx 候选截图的浏览器入口（由 `pptx-candidates.ts` 打包）：解析 pptx、以字节注册字体并读取度量与点阵、解码图片并绘制指定幻灯片。
 *
 * 页面向 `window` 暴露 `renderPage(id, slide, width, height, clearType, date)`（`clearType` 为采集时显示器的 ClearType 设置，
 * `date` 为日期字段显示的采集时间），返回画布尺寸；截图由 Node 驱动的 Playwright 完成。
 * 主机字体的族名取自 `/families`（WPS 演示的替代规则所用）；主机没有的字体取文件中的嵌入字体；缺少字体与缺少字形时使用宋体。
 * 本文件只声明用到的浏览器接口，不引入 DOM 类型库。
 */

import {
  type CreateCanvas,
  decodePicture,
  type ImageDecoder,
  type PaintCanvas,
  type PaintContext,
  type PaintImage,
  type PaintPicture,
} from '../../packages/ooxml/src/drawingml/index.ts'
import {
  type ClearTypeDisplay,
  type FieldDate,
  type Presentation,
  paintSlide,
  parsePptx,
  presentationFonts,
  readEmbeddedFonts,
  readImages,
  readSlideFace,
  type SlideContext,
  type SlideFace,
  SlideFontSet,
  slideImages,
} from '../../packages/ooxml/src/pptx/index.ts'
import type { HostFamilies } from '../../packages/ooxml/src/text/index.ts'

interface CanvasElement {
  width: number
  height: number
  style: { width: string; height: string }
  getContext(kind: '2d', options: { alpha: boolean; willReadFrequently: boolean }): SlideContext
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
declare class OffscreenCanvas implements PaintCanvas {
  constructor(width: number, height: number)
  readonly width: number
  readonly height: number
  getContext(kind: '2d'): PaintContext | null
}
declare function createImageBitmap(source: Blob | ImageData): Promise<PaintImage>
declare class ImageData {
  constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number)
}

const FALLBACK = '宋体'

interface FaceInfo {
  readonly id: string
  readonly bold: boolean
  readonly italic: boolean
}

const families = new Map<string, Promise<SlideFace[]>>()

/** 按字体名取得本机字体，以同一族名注册到页面并读取度量与点阵。主机上没有该字体时返回空数组。 */
function loadFamily(name: string): Promise<SlideFace[]> {
  let pending = families.get(name)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(`/font?name=${encodeURIComponent(name)}`)
      if (!res.ok) return []
      const list = (await res.json()) as FaceInfo[]
      const out: SlideFace[] = []
      for (const f of list) {
        const bytes = await (await fetch(`/font-face?id=${encodeURIComponent(f.id)}`)).arrayBuffer()
        const face = new FontFace(name, bytes, {
          weight: f.bold ? '700' : '400',
          style: f.italic ? 'italic' : 'normal',
        })
        await face.load()
        document.fonts.add(face)
        const font = readSlideFace(new Uint8Array(bytes), name, f.bold, f.italic)
        if (font !== null) out.push(font)
      }
      return out
    })()
    families.set(name, pending)
  }
  return pending
}

interface Doc {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly presentation: Presentation
  readonly fonts: SlideFontSet
}

const docs = new Map<string, Promise<Doc>>()

function loadDoc(id: string): Promise<Doc> {
  let pending = docs.get(id)
  if (!pending) {
    pending = (async () => {
      const bytes = new Uint8Array(
        await (await fetch(`/doc/${encodeURIComponent(id)}`)).arrayBuffer(),
      )
      const parsed = await parsePptx(bytes)
      if (!parsed.ok) throw new Error(`解析失败：${JSON.stringify(parsed.failure)}`)
      const presentation = parsed.value
      const families = (await (await fetch('/families')).json()) as HostFamilies
      const names = [...new Set([...presentationFonts(presentation, families), FALLBACK])]
      // 每个字体以文件中的字体名注册，族名与键相同。
      const loaded = new Map<string, SlideFace[]>()
      for (const name of names) loaded.set(name, await loadFamily(name))
      // 主机没有的字体取文件中的嵌入字体。
      const missing = presentation.embeddedFonts.filter((f) => !loaded.get(f.typeface)?.length)
      const embedded = await readEmbeddedFonts(bytes, missing)
      for (const part of embedded.failed) console.warn(`嵌入字体无法还原：${part}`)
      for (const f of embedded.fonts) {
        const face = new FontFace(f.typeface, f.bytes.slice().buffer, {
          weight: f.bold ? '700' : '400',
          style: f.italic ? 'italic' : 'normal',
        })
        // 与界面一致：浏览器拒绝的嵌入字体跳过，按缺失字体处理，不使整份文件失败。
        const ready = await face.load().catch(() => null)
        if (!ready) {
          console.warn(`嵌入字体无法加载：${f.typeface}`)
          continue
        }
        document.fonts.add(face)
        const font = readSlideFace(f.bytes, f.typeface, f.bold, f.italic)
        if (font === null) continue
        loaded.set(f.typeface, [...(loaded.get(f.typeface) ?? []), font])
      }
      const fonts = SlideFontSet.of(loaded, [FALLBACK], families)
      if (fonts === null) throw new Error('本机没有宋体')
      return { bytes, presentation, fonts }
    })()
    docs.set(id, pending)
  }
  return pending
}

const createCanvas: CreateCanvas = (width, height) =>
  new OffscreenCanvas(Math.max(1, width), Math.max(1, height))

const decoder: ImageDecoder = {
  file: (bytes, type) => createImageBitmap(new Blob([bytes], { type })),
  pixels: (width, height, data) => createImageBitmap(new ImageData(data, width, height)),
}

async function renderPage(
  id: string,
  slideNumber: number,
  width: number,
  height: number,
  clearType: ClearTypeDisplay | null,
  date: FieldDate,
): Promise<{ width: number; height: number }> {
  const { bytes, presentation, fonts } = await loadDoc(id)
  const slide = presentation.slides[slideNumber - 1]
  if (!slide) throw new Error(`没有第 ${slideNumber} 张幻灯片`)
  const parts = await readImages(bytes, slideImages(slide))
  const images = new Map<string, PaintPicture | null>()
  for (const [part, img] of parts)
    images.set(part, await decodePicture(img.bytes.slice(), img.contentType, decoder))
  const scale = width / (presentation.width / 9525)
  const canvas = document.getElementById('slide')
  canvas.width = width
  canvas.height = height
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  // ClearType 字形读写画布像素，见 `SlideContext`。画布元素在各页之间复用，绘制上下文的选项取第一页的设置。
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: clearType !== null })
  paintSlide(
    ctx,
    presentation,
    slide,
    { fonts, image: (part) => images.get(part) ?? null, createCanvas, clearType, date },
    scale,
  )
  return { width, height }
}

window.renderPage = renderPage
window.pageReady = true
