/**
 * 图元文件的绘制：按设备上下文的状态执行 `MetaOp`，把图片框映射到目标矩形，绘制在调用方上下文的当前变换中。
 *
 * - 坐标换算：逻辑坐标经世界变换、窗口与视口（映射模式）到设备坐标，再由图片框映射到目标矩形。WMF 的设备坐标即目标坐标；
 *   EMF 的设备坐标为参考设备像素。
 * - 与 GDI 相同，换算到目标后的坐标取整到像素：填充的边界落在像素边缘，奇数宽度的线落在像素中心；矩形与椭圆不含右边与底边
 *   （空画笔时是否再小 1 像素见 `MetaOp` 的 `shrink`）。修饰画笔（cosmetic）为 1 像素，几何画笔的线宽按变换缩放，至少 1 像素。
 * - 位图一律平滑缩放，不按 `SetStretchBltMode` 区分，目标矩形按换算后的坐标绘制、不取整。WPS 实测（构造文档 7 张含位图的
 *   图元文件，含 `COLORONCOLOR` 放大 3 倍的渐变与 1 位棋盘格）：缩放均为平滑插值；区域 SSIM 之和为 5.95，按模式区分平滑并
 *   取整到像素时为 5.76，坐标加 0.5 像素时为 5.56。
 * - 文字逐字绘制：字号为 `lfHeight` 换算到目标后取整的 ppem，字的横坐标为参考点加前进宽度之和换算后取整；对齐方式按
 *   `TA_*`，背景模式为不透明时以背景色填充字符单元。字形由 `MetafileFonts` 绘制。
 * - 目标矩形之外不裁剪：调用方按需要裁剪（图片的裁剪区域由调用方处理）。
 */

import {
  apply,
  IDENTITY,
  type Matrix,
  multiply,
  type PaintContext,
  type PaintImage,
} from '../drawingml/paint/context.ts'
import type { Box, Brush, Font, Metafile, MetaOp, Pen, Point, Rgb } from './model.ts'

/** 绘制文字所用的字体。 */
export interface MetafileFace {
  /** ppem 下的像素上升与下降（`tmAscent`、`tmDescent`）。 */
  vertical(ppem: number): { readonly ascent: number; readonly descent: number }
  /** em 高度与字符单元高度之比：`lfHeight` 为正（单元高度）时按它换算为 em 高度。 */
  readonly emPerCell: number
  /** ppem 下字符的前进宽度（像素）：文字记录没有前进宽度时使用。 */
  advance(codePoint: number, ppem: number): number
  /** 以 `ctx.fillStyle` 在整数像素 (`x`, `baseline`) 处绘制一个字符。 */
  draw(ctx: PaintContext, text: string, x: number, baseline: number, ppem: number): void
}

export interface MetafileFonts {
  /** 按字体名与字形取得字体；主机没有该字体时由调用方返回回退字体。 */
  face(name: string, bold: boolean, italic: boolean): MetafileFace
}

/** 图片框映射到的矩形（调用方上下文的坐标）。 */
export interface MetafileTarget {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Segment {
  readonly kind: 'line' | 'bezier'
  readonly points: readonly Point[]
}

interface Figure {
  readonly start: Point
  readonly segments: Segment[]
  closed: boolean
  /** 坐标取整到像素：椭圆由已取整的外接矩形生成，不再取整。 */
  readonly snap: boolean
}

type Clip =
  | { readonly kind: 'rects'; readonly boxes: readonly Box[] }
  | { readonly kind: 'exclude'; readonly box: Box }
  | { readonly kind: 'path'; readonly figures: readonly Figure[]; readonly evenOdd: boolean }

interface State {
  mapMode: number
  winOrg: Point
  winExt: Point
  vpOrg: Point
  vpExt: Point
  world: Matrix
  pen: Pen
  brush: Brush
  font: Font | null
  textColor: Rgb
  bkColor: Rgb
  bkOpaque: boolean
  align: number
  evenOdd: boolean
  miterLimit: number
  pos: Point
  clip: readonly Clip[]
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 }
const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/** 度量映射模式下每毫米的逻辑单位数（`MM_LOMETRIC` 至 `MM_TWIPS`）。 */
const UNITS_PER_MM: Readonly<Record<number, number>> = {
  2: 10,
  3: 100,
  4: 100 / 25.4,
  5: 1000 / 25.4,
  6: 1440 / 25.4,
}

const TA_RIGHT = 2
const TA_CENTER = 6
const TA_BOTTOM = 8
const TA_BASELINE = 24

/** ELLIPSE 的三次曲线近似：四分之一圆弧的控制点比例。 */
const KAPPA = 0.5522847498

function css(c: Rgb): string {
  return `rgb(${c.r},${c.g},${c.b})`
}

function initial(mf: Metafile, target: MetafileTarget): State {
  const wmf = mf.kind === 'wmf'
  const f = mf.frame
  return {
    mapMode: wmf ? 8 : 1,
    winOrg: wmf ? { x: f.left, y: f.top } : { x: 0, y: 0 },
    winExt: wmf ? { x: f.right - f.left, y: f.bottom - f.top } : { x: 1, y: 1 },
    vpOrg: wmf ? { x: target.x, y: target.y } : { x: 0, y: 0 },
    vpExt: wmf ? { x: target.width, y: target.height } : { x: 1, y: 1 },
    world: IDENTITY,
    pen: { style: 'solid', width: 0, cosmetic: true, color: BLACK, cap: 'round', join: 'round' },
    brush: { kind: 'solid', color: WHITE },
    font: null,
    textColor: BLACK,
    bkColor: WHITE,
    bkOpaque: true,
    align: 0,
    evenOdd: true,
    miterLimit: 10,
    pos: { x: 0, y: 0 },
    clip: [],
  }
}

class Player {
  private s: State
  private readonly stack: State[] = []
  private path: Figure[] | null = null
  private inPath = false
  /** 设备坐标到目标坐标。 */
  private readonly base: Matrix

  constructor(
    private readonly ctx: PaintContext,
    private readonly mf: Metafile,
    private readonly images: readonly PaintImage[],
    target: MetafileTarget,
    private readonly fonts: MetafileFonts,
  ) {
    this.s = initial(mf, target)
    const f = mf.frame
    if (mf.kind === 'wmf') this.base = IDENTITY
    else {
      const sx = target.width / (f.right - f.left)
      const sy = target.height / (f.bottom - f.top)
      this.base = { a: sx, b: 0, c: 0, d: sy, e: target.x - f.left * sx, f: target.y - f.top * sy }
    }
  }

  /** 页面空间（世界变换之后）到设备坐标。 */
  private page(): Matrix {
    const s = this.s
    let sx = 1
    let sy = 1
    const metric = UNITS_PER_MM[s.mapMode]
    if (metric !== undefined && this.mf.device !== null) {
      sx = this.mf.device.x / metric
      sy = -this.mf.device.y / metric
    } else if (s.mapMode === 7 || s.mapMode === 8) {
      sx = s.winExt.x === 0 ? 1 : s.vpExt.x / s.winExt.x
      sy = s.winExt.y === 0 ? 1 : s.vpExt.y / s.winExt.y
      if (s.mapMode === 7) {
        const k = Math.min(Math.abs(sx), Math.abs(sy))
        sx = Math.sign(sx) * k
        sy = Math.sign(sy) * k
      }
    }
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: s.vpOrg.x - s.winOrg.x * sx,
      f: s.vpOrg.y - s.winOrg.y * sy,
    }
  }

  /** 逻辑坐标到目标坐标。 */
  private matrix(): Matrix {
    return multiply(this.base, multiply(this.page(), this.s.world))
  }

  private out(p: Point, m = this.matrix()): Point {
    return apply(m, p.x, p.y)
  }

  run(): void {
    for (const op of this.mf.ops) this.exec(op)
  }

  private exec(o: MetaOp): void {
    const s = this.s
    switch (o.op) {
      case 'save':
        this.stack.push({ ...s })
        return
      case 'restore': {
        const depth = o.index < 0 ? this.stack.length + o.index : o.index - 1
        if (depth < 0 || depth >= this.stack.length) return
        this.s = this.stack[depth]!
        this.stack.length = depth
        return
      }
      case 'mapMode':
        s.mapMode = o.mode
        return
      case 'windowOrg':
        s.winOrg = { x: o.x, y: o.y }
        return
      case 'windowExt':
        s.winExt = { x: o.x, y: o.y }
        return
      case 'viewportOrg':
        s.vpOrg = { x: o.x, y: o.y }
        return
      case 'viewportExt':
        s.vpExt = { x: o.x, y: o.y }
        return
      case 'world':
        s.world =
          o.mode === 'set'
            ? o.matrix
            : o.mode === 'identity'
              ? IDENTITY
              : o.mode === 'left'
                ? multiply(s.world, o.matrix)
                : multiply(o.matrix, s.world)
        return
      case 'pen':
        s.pen = o.pen
        return
      case 'brush':
        s.brush = o.brush
        return
      case 'font':
        s.font = o.font
        return
      case 'textColor':
        s.textColor = o.color
        return
      case 'bkColor':
        s.bkColor = o.color
        return
      case 'bkMode':
        s.bkOpaque = o.opaque
        return
      case 'textAlign':
        s.align = o.align
        return
      case 'fillMode':
        s.evenOdd = o.evenOdd
        return
      case 'miterLimit':
        s.miterLimit = o.limit
        return
      case 'moveTo':
        s.pos = o.p
        if (this.inPath)
          this.path!.push({ start: this.out(o.p), segments: [], closed: false, snap: true })
        return
      case 'lineTo':
        this.figure([s.pos, o.p], false, true, false)
        s.pos = o.p
        return
      case 'polyline':
        this.figure(o.points, false, false, false)
        return
      case 'polylineTo':
        this.figure([s.pos, ...o.points], false, true, false)
        s.pos = o.points.at(-1) ?? s.pos
        return
      case 'polygon':
        this.figure(o.points, false, false, true)
        return
      case 'bezier':
        this.figure(o.points, true, false, false)
        return
      case 'bezierTo':
        this.figure([s.pos, ...o.points], true, true, false)
        s.pos = o.points.at(-1) ?? s.pos
        return
      case 'polyPolygon':
      case 'polyPolyline': {
        const closed = o.op === 'polyPolygon'
        const m = this.matrix()
        const figures = o.polys
          .filter((p) => p.length > 0)
          .map((p) =>
            polyFigure(
              p.map((q) => this.out(q, m)),
              false,
              closed,
            ),
          )
        if (this.inPath) this.path!.push(...figures)
        else this.paint(figures, closed, true)
        return
      }
      case 'rectangle':
      case 'ellipse':
        this.box(o.box, o.op === 'ellipse', o.shrink)
        return
      case 'patBlt':
        this.patBlt(o.box, o.fill)
        return
      case 'bitmap':
        this.bitmap(o)
        return
      case 'text':
        this.text(o)
        return
      case 'beginPath':
        this.path = []
        this.inPath = true
        return
      case 'endPath':
        this.inPath = false
        return
      case 'abortPath':
        this.path = null
        this.inPath = false
        return
      case 'closeFigure': {
        const last = this.path?.at(-1)
        if (last) last.closed = true
        return
      }
      case 'fillPath':
      case 'strokePath':
      case 'strokeFillPath': {
        const figures = this.path ?? []
        this.path = null
        this.inPath = false
        const fill = o.op !== 'strokePath'
        if (fill) for (const f of figures) f.closed = true
        this.paint(figures, fill, o.op !== 'fillPath')
        return
      }
      case 'clipPath': {
        const figures = this.path ?? []
        this.path = null
        this.inPath = false
        const item: Clip = { kind: 'path', figures, evenOdd: s.evenOdd }
        s.clip = o.mode === 'copy' ? [item] : [...s.clip, item]
        return
      }
      case 'clipRect': {
        const box = this.pixelBox(o.box)
        const item: Clip = o.exclude ? { kind: 'exclude', box } : { kind: 'rects', boxes: [box] }
        s.clip = [...s.clip, item]
        return
      }
      case 'clipRegion': {
        if (o.rects === null) {
          s.clip = []
          return
        }
        const boxes = o.rects.map((r) => this.pixelBox(r, this.base))
        const item: Clip = { kind: 'rects', boxes }
        s.clip = o.mode === 'copy' ? [item] : [...s.clip, item]
        return
      }
    }
  }

  /** 逻辑坐标的矩形换算到目标并取整（左上、右下按坐标大小排序）。 */
  private pixelBox(b: Box, m = this.matrix()): Box {
    const p = apply(m, b.left, b.top)
    const q = apply(m, b.right, b.bottom)
    return {
      left: Math.round(Math.min(p.x, q.x)),
      top: Math.round(Math.min(p.y, q.y)),
      right: Math.round(Math.max(p.x, q.x)),
      bottom: Math.round(Math.max(p.y, q.y)),
    }
  }

  /**
   * 折线、多边形与三次曲线（`POLYBEZIER`）：`continued` 为真时第一个点是当前位置，`closed` 为真时填充并闭合。
   * 路径中，`continued` 的图形在当前位置是上一个图形的终点时接在其后，否则自当前位置开始新的图形；
   * 其余图形各自开始新的图形，不改变当前位置。
   */
  private figure(points: readonly Point[], bezier: boolean, continued: boolean, closed: boolean) {
    if (points.length === 0) return
    const m = this.matrix()
    const pts = points.map((p) => this.out(p, m))
    if (this.inPath) {
      const last = this.path!.at(-1)
      const end = last?.segments.at(-1)?.points.at(-1) ?? last?.start
      const joins =
        continued &&
        last !== undefined &&
        !last.closed &&
        end!.x === pts[0]!.x &&
        end!.y === pts[0]!.y
      if (joins) last.segments.push(...segments(pts.slice(1), bezier))
      else this.path!.push(polyFigure(pts, bezier, closed))
      return
    }
    this.paint([polyFigure(pts, bezier, closed)], closed, true)
  }

  private box(b: Box, ellipse: boolean, shrinkNullPen: boolean): void {
    const m = this.matrix()
    if (this.inPath) {
      const corners = boxCorners(b).map((p) => this.out(p, m))
      this.path!.push(
        ellipse ? ellipseFigure(b, (p) => this.out(p, m)) : polyFigure(corners, false, true),
      )
      return
    }
    const r = this.pixelBox(b, m)
    const pen = this.penWidth(m)
    const shrink = pen === 0 && shrinkNullPen ? 1 : 0
    const inner: Box = {
      left: r.left,
      top: r.top,
      right: r.right - shrink,
      bottom: r.bottom - shrink,
    }
    const traceBox = (box: Box) =>
      ellipse ? ellipseFigure(box, (p) => p) : polyFigure(boxCorners(box), false, true)
    const ctx = this.ctx
    ctx.save()
    this.applyClip()
    if (this.s.brush.kind === 'solid' && inner.right > inner.left && inner.bottom > inner.top) {
      ctx.beginPath()
      trace(ctx, [traceBox(inner)], 0)
      ctx.fillStyle = css(this.s.brush.color)
      ctx.fill()
    }
    if (pen > 0) {
      const off = pen % 2 === 1 ? 0.5 : 0
      const outline: Box = { left: r.left, top: r.top, right: r.right - 1, bottom: r.bottom - 1 }
      ctx.beginPath()
      trace(ctx, [traceBox(outline)], off)
      this.stroke(pen)
    }
    ctx.restore()
  }

  /** 当前画笔在目标中的线宽（像素）；空画笔为 0。 */
  private penWidth(m: Matrix): number {
    const pen = this.s.pen
    if (pen.style === 'null') return 0
    if (pen.cosmetic) return 1
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
    return Math.max(1, Math.round(pen.width * scale))
  }

  private stroke(width: number): void {
    const ctx = this.ctx
    const pen = this.s.pen
    ctx.lineWidth = width
    ctx.lineCap = pen.cosmetic ? 'butt' : pen.cap
    ctx.lineJoin = pen.cosmetic ? 'miter' : pen.join
    ctx.miterLimit = this.s.miterLimit
    ctx.setLineDash([])
    ctx.strokeStyle = css(pen.color)
    ctx.stroke()
  }

  /** 填充（按当前画刷与填充规则）并描边（按当前画笔）一组图形。 */
  private paint(figures: readonly Figure[], fill: boolean, stroke: boolean): void {
    if (figures.length === 0) return
    const ctx = this.ctx
    const s = this.s
    const pen = stroke ? this.penWidth(this.matrix()) : 0
    ctx.save()
    this.applyClip()
    if (fill && s.brush.kind === 'solid') {
      ctx.beginPath()
      trace(ctx, figures, 0, true)
      ctx.fillStyle = css(s.brush.color)
      ctx.fill(s.evenOdd ? 'evenodd' : 'nonzero')
    }
    if (pen > 0) {
      ctx.beginPath()
      trace(ctx, figures, pen % 2 === 1 ? 0.5 : 0)
      this.stroke(pen)
    }
    ctx.restore()
  }

  private patBlt(b: Box, fill: 'brush' | 'black' | 'white'): void {
    const color = fill === 'black' ? BLACK : fill === 'white' ? WHITE : null
    const brush = this.s.brush
    if (color === null && brush.kind !== 'solid') return
    const r = this.pixelBox(b)
    const ctx = this.ctx
    ctx.save()
    this.applyClip()
    ctx.fillStyle = css(color ?? (brush as { color: Rgb }).color)
    ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top)
    ctx.restore()
  }

  private bitmap(o: Extract<MetaOp, { op: 'bitmap' }>): void {
    const image = this.images[o.bitmap]
    if (image === undefined) return
    const ctx = this.ctx
    const m = this.matrix()
    ctx.save()
    this.applyClip()
    ctx.globalAlpha *= o.alpha
    ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    const { x, y, width, height } = o.src
    const d = o.dest
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
    // drawImage 的目标宽高须为正：逻辑坐标中宽高为负（镜像）时在变换中翻转。
    ctx.translate(d.left, d.top)
    ctx.scale(d.right < d.left ? -1 : 1, d.bottom < d.top ? -1 : 1)
    ctx.drawImage(
      image,
      x,
      y,
      width,
      height,
      0,
      0,
      Math.abs(d.right - d.left),
      Math.abs(d.bottom - d.top),
    )
    ctx.restore()
  }

  private text(o: Extract<MetaOp, { op: 'text' }>): void {
    const s = this.s
    const m = this.matrix()
    const ctx = this.ctx
    ctx.save()
    this.applyClip()
    if (o.opaque !== null) {
      const r = this.pixelBox(o.opaque, m)
      ctx.fillStyle = css(s.bkColor)
      ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }
    const font = s.font
    if (o.text === '' || font === null) {
      ctx.restore()
      return
    }
    if (o.clip !== null) {
      const r = this.pixelBox(o.clip, m)
      ctx.beginPath()
      ctx.rect(r.left, r.top, r.right - r.left, r.bottom - r.top)
      ctx.clip()
    }
    const scaleY = Math.abs(m.d)
    const face = this.fonts.face(font.face, font.weight >= 600, font.italic)
    const ppem = Math.round(
      font.height < 0 ? -font.height * scaleY : font.height * scaleY * face.emPerCell,
    )
    if (ppem <= 0) {
      ctx.restore()
      return
    }
    // 字符（UTF-16 代理对合为一个字符，前进宽度取两项之和）与各字距参考点的横向距离（目标像素）。
    const chars: { text: string; offset: number }[] = []
    let advance = 0
    for (let k = 0; k < o.text.length; k++) {
      const code = o.text.charCodeAt(k)
      const pair = code >= 0xd800 && code < 0xdc00 && k + 1 < o.text.length
      const ch = pair ? o.text.slice(k, k + 2) : o.text[k]!
      let w: number
      if (o.dx !== null) w = ((o.dx[k] ?? 0) + (pair ? (o.dx[k + 1] ?? 0) : 0)) * m.a
      else w = face.advance(ch.codePointAt(0)!, ppem)
      chars.push({ text: ch, offset: advance })
      advance += w
      if (pair) k++
    }
    const origin = this.out(o.p, m)
    const h = s.align & TA_CENTER
    const shift = h === TA_CENTER ? -advance / 2 : h === TA_RIGHT ? -advance : 0
    const v = face.vertical(ppem)
    const vertical = s.align & TA_BASELINE
    const baseline = Math.round(
      vertical === TA_BASELINE
        ? origin.y
        : vertical === TA_BOTTOM
          ? origin.y - v.descent
          : origin.y + v.ascent,
    )
    const x0 = origin.x + shift
    if (s.bkOpaque) {
      const left = Math.round(Math.min(x0, x0 + advance))
      const right = Math.round(Math.max(x0, x0 + advance))
      ctx.fillStyle = css(s.bkColor)
      ctx.fillRect(left, baseline - v.ascent, right - left, v.ascent + v.descent)
    }
    ctx.fillStyle = css(s.textColor)
    for (const c of chars) {
      if (c.text === ' ') continue
      face.draw(ctx, c.text, Math.round(x0 + c.offset), baseline, ppem)
    }
    ctx.restore()
  }

  private applyClip(): void {
    const ctx = this.ctx
    for (const c of this.s.clip) {
      ctx.beginPath()
      if (c.kind === 'rects') {
        for (const b of c.boxes) ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top)
        ctx.clip()
      } else if (c.kind === 'exclude') {
        const b = c.box
        ctx.rect(-1e6, -1e6, 2e6, 2e6)
        ctx.rect(b.left, b.top, b.right - b.left, b.bottom - b.top)
        ctx.clip('evenodd')
      } else {
        trace(ctx, c.figures, 0, true)
        ctx.clip(c.evenOdd ? 'evenodd' : 'nonzero')
      }
    }
  }
}

function boxCorners(b: Box): Point[] {
  return [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ]
}

function segments(points: readonly Point[], bezier: boolean): Segment[] {
  if (!bezier) return points.map((p) => ({ kind: 'line', points: [p] }))
  const out: Segment[] = []
  for (let k = 0; k + 2 < points.length; k += 3)
    out.push({ kind: 'bezier', points: [points[k]!, points[k + 1]!, points[k + 2]!] })
  return out
}

function polyFigure(points: readonly Point[], bezier: boolean, closed: boolean): Figure {
  return { start: points[0]!, segments: segments(points.slice(1), bezier), closed, snap: true }
}

/** 外接矩形 `b` 中的椭圆：四段三次曲线，`map` 换算控制点。 */
function ellipseFigure(b: Box, map: (p: Point) => Point): Figure {
  const cx = (b.left + b.right) / 2
  const cy = (b.top + b.bottom) / 2
  const rx = (b.right - b.left) / 2
  const ry = (b.bottom - b.top) / 2
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const p = (x: number, y: number) => map({ x, y })
  return {
    start: p(cx + rx, cy),
    segments: [
      { kind: 'bezier', points: [p(cx + rx, cy + ky), p(cx + kx, cy + ry), p(cx, cy + ry)] },
      { kind: 'bezier', points: [p(cx - kx, cy + ry), p(cx - rx, cy + ky), p(cx - rx, cy)] },
      { kind: 'bezier', points: [p(cx - rx, cy - ky), p(cx - kx, cy - ry), p(cx, cy - ry)] },
      { kind: 'bezier', points: [p(cx + kx, cy - ry), p(cx + rx, cy - ky), p(cx + rx, cy)] },
    ],
    closed: true,
    snap: false,
  }
}

/**
 * 在当前路径上描绘图形：坐标取整到像素后加 `offset`（奇数线宽的描边为 0.5）。`close` 为真时闭合全部图形（填充与裁剪）。
 */
function trace(ctx: PaintContext, figures: readonly Figure[], offset: number, close = false) {
  for (const f of figures) {
    const q = f.snap ? (v: number) => Math.round(v) + offset : (v: number) => v + offset
    ctx.moveTo(q(f.start.x), q(f.start.y))
    for (const s of f.segments) {
      const [a, b, c] = s.points
      if (s.kind === 'line') ctx.lineTo(q(a!.x), q(a!.y))
      else ctx.bezierCurveTo(q(a!.x), q(a!.y), q(b!.x), q(b!.y), q(c!.x), q(c!.y))
    }
    if (f.closed || close) ctx.closePath()
  }
}

/** 把图元文件的图片框映射到 `target` 并绘制。`images` 与 `mf.bitmaps` 一一对应。 */
export function playMetafile(
  ctx: PaintContext,
  mf: Metafile,
  images: readonly PaintImage[],
  target: MetafileTarget,
  fonts: MetafileFonts,
): void {
  if (mf.unsupported.length > 0 || target.width === 0 || target.height === 0) return
  ctx.save()
  new Player(ctx, mf, images, target, fonts).run()
  ctx.restore()
}
