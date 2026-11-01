/**
 * 测试夹具：记录绘制调用的 Canvas 2D 上下文与图层，供不依赖浏览器的绘制测试使用。
 */

import type { Matrix, PaintCanvas, PaintContext, PaintImage } from './context.ts'

export type Call = readonly [string, ...unknown[]]

/** 每个调用记录名称、参数，以及调用时的变换、`fillStyle`、`strokeStyle`、线宽、合成方式与字体。 */
export interface Recorded {
  readonly name: string
  readonly args: readonly unknown[]
  readonly matrix: Matrix
  readonly fillStyle: unknown
  readonly strokeStyle: unknown
  readonly lineWidth: number
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
  private readonly stack: Matrix[] = []

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({
      name,
      args,
      matrix: this.matrix,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      composite: this.globalCompositeOperation,
      font: this.font,
    })
  }

  named(name: string): Recorded[] {
    return this.calls.filter((c) => c.name === name)
  }

  save(): void {
    this.stack.push(this.matrix)
  }
  restore(): void {
    this.matrix = this.stack.pop() ?? this.matrix
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
