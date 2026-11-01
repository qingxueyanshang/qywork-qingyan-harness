/**
 * 候选截图的浏览器入口（由 `xlsx-candidates.ts` 打包）：解析 xlsx、以字节注册字体、按真值清单的区域绘制到画布。
 *
 * 页面向 `window` 暴露 `renderPage(id, sheet, range)`，返回画布尺寸；截图由 Node 驱动的 Playwright 完成。
 * 本文件只声明用到的浏览器接口，不引入 DOM 类型库（`scripts` 的类型检查环境不含 DOM）。
 */

import type {
  CreateCanvas,
  PaintContext as LayerContext,
  PaintCanvas,
} from '../../packages/ooxml/src/drawingml/index.ts'
import {
  createScene,
  FontSet,
  fallbackFonts,
  type LoadedFace,
  loadFace,
  type PaintContext,
  type PaintImage,
  paintRegion,
  parseXlsx,
  type Workbook,
} from '../../packages/ooxml/src/xlsx/index.ts'

interface CanvasElement {
  width: number
  height: number
  style: { width: string; height: string }
  getContext(kind: '2d', options: { alpha: boolean }): PaintContext
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
declare function createImageBitmap(blob: Blob): Promise<PaintImage>
declare class OffscreenCanvas implements PaintCanvas {
  constructor(width: number, height: number)
  readonly width: number
  readonly height: number
  getContext(kind: '2d'): LayerContext | null
}

const createCanvas: CreateCanvas = (width, height) =>
  new OffscreenCanvas(Math.max(1, width), Math.max(1, height))

interface FaceInfo {
  readonly id: string
  readonly bold: boolean
  readonly italic: boolean
}

const loadedFamilies = new Map<string, Promise<LoadedFace[]>>()

/** 按字体名取得本机字体，以同一族名注册到页面并读取度量。主机上没有该字体时返回空数组。 */
function loadFamily(name: string): Promise<LoadedFace[]> {
  let pending = loadedFamilies.get(name)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(`/font?name=${encodeURIComponent(name)}`)
      if (!res.ok) return []
      const faces = (await res.json()) as FaceInfo[]
      const out: LoadedFace[] = []
      for (const f of faces) {
        const bytes = await (await fetch(`/font-face?id=${encodeURIComponent(f.id)}`)).arrayBuffer()
        const face = new FontFace(name, bytes, {
          weight: f.bold ? '700' : '400',
          style: f.italic ? 'italic' : 'normal',
        })
        await face.load()
        document.fonts.add(face)
        out.push(loadFace(new Uint8Array(bytes), name))
      }
      return out
    })()
    loadedFamilies.set(name, pending)
  }
  return pending
}

interface Doc {
  readonly workbook: Workbook
  readonly fonts: FontSet
}

const docs = new Map<string, Promise<Doc>>()

function loadDoc(id: string): Promise<Doc> {
  let pending = docs.get(id)
  if (!pending) {
    pending = (async () => {
      const bytes = new Uint8Array(
        await (await fetch(`/doc/${encodeURIComponent(id)}`)).arrayBuffer(),
      )
      const parsed = await parseXlsx(bytes)
      if (!parsed.ok) throw new Error(`解析失败：${JSON.stringify(parsed.failure)}`)
      const workbook = parsed.value
      const fallbacks = fallbackFonts(workbook)
      const names = [...new Set([...workbook.fontNames, ...fallbacks])]
      const faces = (await Promise.all(names.map(loadFamily))).flat()
      return { workbook, fonts: new FontSet(faces, fallbacks) }
    })()
    docs.set(id, pending)
  }
  return pending
}

function lastCell(range: string): { row: number; col: number } {
  const m = /([A-Z]+)(\d+)$/.exec(range)
  if (!m) throw new Error(`区域格式不正确：${range}`)
  let col = 0
  for (const ch of m[1]!) col = col * 26 + ch.charCodeAt(0) - 64
  return { row: Number(m[2]) - 1, col: col - 1 }
}

async function renderPage(
  id: string,
  sheetName: string,
  range: string,
): Promise<{ width: number; height: number }> {
  const { workbook, fonts } = await loadDoc(id)
  const sheet = workbook.sheets.find((s) => s.name === sheetName)
  if (!sheet) throw new Error(`没有工作表：${sheetName}`)
  const scene = createScene(workbook, sheet, fonts)
  const end = lastCell(range)
  const width = scene.geometry.cols.offset(end.col + 1)
  const height = scene.geometry.rows.offset(end.row + 1)
  const images = await Promise.all(
    sheet.images.map((img) =>
      createImageBitmap(new Blob([img.bytes.slice()], { type: img.contentType })).catch(() => null),
    ),
  )
  const canvas = document.getElementById('sheet')
  canvas.width = width + 1
  canvas.height = height + 1
  canvas.style.width = `${width + 1}px`
  canvas.style.height = `${height + 1}px`
  const ctx = canvas.getContext('2d', { alpha: false })
  paintRegion(ctx, scene, { x: 0, y: 0, width, height }, { images, createCanvas })
  return { width: width + 1, height: height + 1 }
}

window.renderPage = renderPage
window.pageReady = true
