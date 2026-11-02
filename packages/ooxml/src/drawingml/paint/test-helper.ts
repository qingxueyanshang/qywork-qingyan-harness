/**
 * 测试夹具：记录绘制调用的 Canvas 2D 上下文与图层，供不依赖浏览器的绘制测试使用。
 */

import type { Matrix, PaintCanvas, PaintContext, PaintImage } from './context.ts'

export type Call = readonly [string, ...unknown[]]

/** 每个调用记录名称、参数，以及调用时的变换、`fillStyle`、`strokeStyle`、线宽、不透明度、合成方式与字体。 */
export interface Recorded {
  readonly name: string
  readonly args: readonly unknown[]
  readonly matrix: Matrix
  readonly fillStyle: unknown
  readonly strokeStyle: unknown
  readonly lineWidth: number
  readonly alpha: number
  readonly composite: string
  readonly font: string
}

export class RecordingContext implements PaintContext {
  fillStyle: unknown = '#000'
  strokeStyle: unknown = '#000'
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  miterLimit = 10
  lineDashOffset = 0
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  shadowColor = 'rgba(0,0,0,0)'
  shadowBlur = 0
  shadowOffsetX = 0
  shadowOffsetY = 0
  imageSmoothingEnabled = true
  fontKerning = 'auto'
  matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  dash: number[] = []
  readonly calls: Recorded[] = []
  private readonly stack: { matrix: Matrix; alpha: number }[] = []

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({
      name,
      args,
      matrix: this.matrix,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      font: this.font,
    })
  }

  named(name: string): Recorded[] {
    return this.calls.filter((c) => c.name === name)
  }

  save(): void {
    this.stack.push({ matrix: this.matrix, alpha: this.globalAlpha })
  }
  restore(): void {
    const top = this.stack.pop()
    if (top === undefined) return
    this.matrix = top.matrix
    this.globalAlpha = top.alpha
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = { a, b, c, d, e, f }
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.matrix
    this.matrix = {
      a: m.a * a + m.c * b,
      b: m.b * a + m.d * b,
      c: m.a * c + m.c * d,
      d: m.b * c + m.d * d,
      e: m.a * e + m.c * f + m.e,
      f: m.b * e + m.d * f + m.f,
    }
  }
  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y)
  }
  rotate(angle: number): void {
    this.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0)
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0)
  }
  setLineDash(segments: number[]): void {
    this.dash = segments
    this.record('setLineDash', [segments])
  }
  beginPath(): void {
    this.record('beginPath', [])
  }
  closePath(): void {
    this.record('closePath', [])
  }
  moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y])
  }
  lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y])
  }
  quadraticCurveTo(...args: number[]): void {
    this.record('quadraticCurveTo', args)
  }
  bezierCurveTo(...args: number[]): void {
    this.record('bezierCurveTo', args)
  }
  ellipse(...args: unknown[]): void {
    this.record('ellipse', args)
  }
  rect(...args: number[]): void {
    this.record('rect', args)
  }
  fill(rule?: string): void {
    this.record('fill', rule === undefined ? [] : [rule])
  }
  stroke(): void {
    this.record('stroke', [])
  }
  clip(): void {
    this.record('clip', [])
  }
  fillRect(...args: number[]): void {
    this.record('fillRect', args)
  }
  clearRect(...args: number[]): void {
    this.record('clearRect', args)
  }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', [text, x, y])
  }
  strokeText(text: string, x: number, y: number): void {
    this.record('strokeText', [text, x, y])
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    const g = { kind: 'linear', points: [x0, y0, x1, y1], stops: [] as [number, string][] }
    return Object.assign(g, {
      addColorStop: (o: number, c: string) => {
        g.stops.push([o, c])
      },
    })
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
    const g = { kind: 'radial', points: [x0, y0, r0, x1, y1, r1], stops: [] as [number, string][] }
    return Object.assign(g, {
      addColorStop: (o: number, c: string) => {
        g.stops.push([o, c])
      },
    })
  }
  createPattern(image: PaintImage, repetition: string) {
    const p = { kind: 'pattern', image, repetition, transform: null as unknown }
    return Object.assign(p, {
      setTransform: (t: unknown) => {
        p.transform = t
      },
    })
  }
  drawImage(image: PaintImage, ...args: number[]): void {
    this.record('drawImage', [image, ...args])
  }
}

export class RecordingCanvas implements PaintCanvas {
  readonly context = new RecordingContext()
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(): PaintContext {
    return this.context
  }
}

/** 记录全部创建的图层。 */
export function canvasFactory(): {
  create: (w: number, h: number) => RecordingCanvas
  created: RecordingCanvas[]
} {
  const created: RecordingCanvas[] = []
  return {
    create: (w, h) => {
      const c = new RecordingCanvas(w, h)
      created.push(c)
      return c
    },
    created,
  }
}

/**
 * 可放置 WMF（图片框 0–100 × 0–50，每英寸 `inch` 单位）：`records` 为 [函数号, ...16 位参数]，末尾自动加 EOF。
 */
export function placeableWmf(
  records: readonly (readonly number[])[],
  inch = 96,
): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  const u16 = (...v: number[]) => {
    for (const x of v) out.push(x & 0xff, (x >> 8) & 0xff)
  }
  const u32 = (x: number) => u16(x & 0xffff, x >>> 16)
  u32(0x9ac6cdd7)
  u16(0, 0, 0, 100, 50, inch)
  u32(0)
  u16(0, 1, 9, 0x0300)
  u32(0)
  u16(4)
  u32(0)
  u16(0)
  for (const [fn, ...params] of [...records, [0]]) {
    u32(3 + params.length)
    u16(fn!, ...params)
  }
  return new Uint8Array(out)
}

/** 红色画刷的矩形 (10, 10)–(90, 40)，没有文字记录。 */
export const RED_RECT_WMF = placeableWmf([
  [0x02fc, 0, 0x00ff, 0, 0],
  [0x012d, 0],
  [0x041b, 40, 90, 10, 10],
])
