/**
 * 绘制 DrawingML 形状所需的 Canvas 2D 接口子集。浏览器的 `CanvasRenderingContext2D` 与
 * `OffscreenCanvasRenderingContext2D` 都满足；本包不引入 DOM 类型库，因此在此声明结构。
 *
 * - 图层（`PaintCanvas`）由调用方经 `createCanvas` 提供，用于阴影、复合线、图案与平铺图片：
 *   浏览器中传入 `(w, h) => new OffscreenCanvas(w, h)` 即可。
 */

/** 已解码的图片（`ImageBitmap`、`HTMLImageElement`、画布等），尺寸为像素。 */
export interface PaintImage {
  readonly width: number
  readonly height: number
}

export interface PaintGradient {
  addColorStop(offset: number, color: string): void
}

export interface PaintPattern {
  setTransform(transform: {
    a: number
    b: number
    c: number
    d: number
    e: number
    f: number
  }): void
}

export interface Matrix {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
}

export interface PaintContext {
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  miterLimit: number
  lineDashOffset: number
  font: string
  textAlign: string
  textBaseline: string
  globalAlpha: number
  globalCompositeOperation: string
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  imageSmoothingEnabled: boolean
  /** 图片缩放的插值质量（`low`、`medium`、`high`）；不支持该属性的上下文按其缺省质量绘制。 */
  imageSmoothingQuality?: string
  fontKerning?: string
  letterSpacing?: string
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  setLineDash(segments: number[]): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    anticlockwise: boolean,
  ): void
  rect(x: number, y: number, w: number, h: number): void
  fill(rule?: 'nonzero' | 'evenodd'): void
  stroke(): void
  clip(rule?: 'nonzero' | 'evenodd'): void
  fillRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): PaintGradient
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): PaintGradient
  createPattern(image: PaintImage, repetition: string): PaintPattern | null
  drawImage(image: PaintImage, dx: number, dy: number): void
  drawImage(image: PaintImage, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: PaintImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
}

/** 可作为图片绘制的图层。逐像素读写的图层以 `willReadFrequently` 取得上下文（CPU 光栅化）。 */
export interface PaintCanvas extends PaintImage {
  getContext(kind: '2d', options?: { readonly willReadFrequently: boolean }): PaintContext | null
}

export type CreateCanvas = (width: number, height: number) => PaintCanvas

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** `m · n`：先施加 `n`，再施加 `m`。 */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  }
}

export function translation(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

export function scaling(x: number, y: number): Matrix {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }
}

/** 顺时针（y 轴向下）旋转，弧度。 */
export function rotation(angle: number): Matrix {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c
  if (det === 0) return IDENTITY
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function setMatrix(ctx: PaintContext, m: Matrix): void {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
}
