/**
 * 公式校准的浏览器入口（由 `math-calibrate.ts` 打包）：注册字体，按任务以 WPS 页面图为底、涂白各公式区域后画出本方的公式。
 *
 * 页面向 `window` 暴露 `renderMathPage(index)`（返回画布尺寸，没有该页时为 `null`）；截图由 `math-shoot.mjs` 完成。
 * 任务（`/jobs`）中每个公式给出排版结果与磅坐标原点；字体经 `/font-file?name=` 取得字节，族名与校准脚本的字体引用相同。
 */

import {
  type GlyphOutlines,
  readFaces,
  readGlyphOutlines,
} from '../../packages/ooxml/src/font/index.ts'
import { type MathCanvas, type MathLayout, paintMath } from '../../packages/ooxml/src/math/index.ts'

interface CanvasElement {
  width: number
  height: number
  style: { width: string; height: string }
  getContext(
    kind: '2d',
    options: { alpha: boolean },
  ): MathCanvas & {
    drawImage(image: unknown, x: number, y: number): void
    textAlign: string
    textBaseline: string
    fontKerning?: string
  }
}

declare const document: {
  getElementById(id: string): CanvasElement
  fonts: { add(face: unknown): void }
}
declare const window: Record<string, unknown>
declare function createImageBitmap(blob: Blob): Promise<unknown>
declare class FontFace {
  constructor(family: string, source: ArrayBuffer, descriptors: { weight: string; style: string })
  load(): Promise<unknown>
}

interface PageJob {
  readonly width: number
  readonly height: number
  readonly background: string
  readonly erase: readonly (readonly [number, number, number, number])[]
  readonly formulas: readonly {
    readonly x: number
    readonly baseline: number
    readonly layout: MathLayout<string>
  }[]
}

/** 族名、字体文件键与字重、字形；Times New Roman 另注册粗体、斜体与粗斜体，键为「族名/序号」。 */
const FACES: [string, string, string, string][] = [
  ['Cambria Math', 'Cambria Math', '400', 'normal'],
  ['宋体', '宋体', '400', 'normal'],
  ['Times New Roman', 'Times New Roman', '400', 'normal'],
  ['Times New Roman', 'Times New Roman/1', '700', 'normal'],
  ['Times New Roman', 'Times New Roman/2', '400', 'italic'],
  ['Times New Roman', 'Times New Roman/3', '700', 'italic'],
]
const outlines = new Map<string, GlyphOutlines | null>()

async function setup(): Promise<PageJob[]> {
  for (const [family, key, weight, style] of FACES) {
    const bytes = await (await fetch(`/font-file?name=${encodeURIComponent(key)}`)).arrayBuffer()
    const face = new FontFace(family, bytes, { weight, style })
    await face.load()
    document.fonts.add(face)
    const data = new Uint8Array(bytes)
    if (key === family) outlines.set(family, readGlyphOutlines(data, readFaces(data)[0]!))
  }
  return (await (await fetch('/jobs')).json()) as PageJob[]
}

const ready = setup()

async function renderMathPage(index: number): Promise<{ width: number; height: number } | null> {
  const jobs = await ready
  const job = jobs[index]
  if (!job) return null
  const canvas = document.getElementById('page')
  canvas.width = job.width
  canvas.height = job.height
  canvas.style.width = `${job.width}px`
  canvas.style.height = `${job.height}px`
  const ctx = canvas.getContext('2d', { alpha: false })
  const blob = await (await fetch(job.background)).blob()
  ctx.drawImage(await createImageBitmap(blob), 0, 0)
  ctx.fillStyle = '#ffffff'
  for (const [x0, y0, x1, y1] of job.erase) ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
  for (const f of job.formulas) {
    paintMath(ctx, f.layout, f.x, f.baseline, {
      family: (font) => font,
      outlines: (font) => outlines.get(font) ?? null,
    })
  }
  return { width: job.width, height: job.height }
}

window.renderMathPage = renderMathPage
ready.then(() => {
  window.pageReady = true
})
