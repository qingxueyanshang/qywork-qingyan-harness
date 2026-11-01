/**
 * 文本框排版与绘制：把已解决样式的段落转换为 `../../text/` 的输入，再按行与片段绘制。长度单位为磅。
 *
 * - 断行、对齐、行高全部由 `layoutParagraph` 完成；本模块只换算输入：
 *   - 行距 `spcPct` 为单倍行高的倍数（`proportional`），`spcPts` 为固定行高（`fixed`），与单倍行高之差都在文字上方
 *     （实测：对照 WPS 导出图，百分比行距 1.18 的 54 磅多行文字与 25 磅固定行距的 16、18 磅文字）；
 *     `normAutofit` 的 `lnSpcReduction` 从百分比行距中减去，`fontScale` 乘到字号上。
 *     `FaceCache.screen` 不为 `null` 时行高与基线另按 `screenBlock` 换算。
 *   - 段前段后的 `spcPts` 为磅值，`spcPct` 为该段首行（段后取末行）行高的倍数；首段不加段前间距。
 *   - 制表位位置相对文本区域左边，换算为相对左缩进的行坐标；默认制表位从文本区域左边起排列。
 *   - 项目符号作为编号字段：悬挂缩进（`indent` 小于 0）时其后加制表符，正文从左缩进处开始。
 * - `wrap` 为假时不断行：按不限宽度排版后，各行在文本区域内按段落对齐方式整体平移。
 * - 字段 `slidenum` 显示 `TextSettings.slideNumber`（为 `null` 时与其余字段相同），其余字段显示文件中保存的文字。
 *   全部大写（`caps="all"`）按大写字母排版。字符间距（`spc`）乘以自动调整的字号缩放。
 * - 绘制：每个字逐个定位，与排版的步进一致；屏幕显示规则见 `drawGlyphs`。不是纯色的文字填充（渐变、图片、图案）以文本区域为填充范围，
 *   在图层中以文字为遮罩覆盖。文字的外部阴影与调用方传入的阴影一并按字形轮廓绘制。
 * - 下划线与删除线的位置与粗细按字号的固定比例绘制，不读取字体的 `post` 表。
 */

import { fillBitmap } from '../../glyph/bitmap.ts'
import {
  type Alignment,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  faceExtent,
  type LineSpacing,
  layoutParagraph,
  lineBox,
  type ParagraphStyle,
  type TabStop,
  type TextBlock,
  type TextRun,
} from '../../text/index.ts'
import { type Color, colorToCss } from '../color.ts'
import type { ShapeFill } from '../fill.ts'
import { apply, type Matrix, multiply, type PaintContext, setMatrix } from '../paint/context.ts'
import { deviceScale, type PaintResources, paintFill, traceRect } from '../paint/fill.ts'
import {
  type DeviceRect,
  drawLayer,
  drawLayerOnto,
  type OuterShadow,
  paintShadows,
} from '../paint/shadow.ts'
import { autoNumberText, symbolChar } from './bullet.ts'
import type { FaceCache, PaintFace, ScreenText } from './fonts.ts'
import type { BodyProperties, Paragraph, Run, RunStyle, Spacing, TextBody } from './model.ts'

const EMU_PER_PT = 12700
/** 不断行时的排版宽度。 */
const UNBOUNDED = 1e7
const EAST_ASIAN_LANG = /^(zh|ja|ko)(-|$)/i

export interface RunPaint {
  /** 项目符号为 `null`。 */
  readonly style: RunStyle | null
  readonly fill: ShapeFill
  /** 排版时的字段文字（项目符号含其后的制表符）。 */
  readonly text: string
}

export interface ParagraphLayout {
  readonly block: TextBlock
  /** 按 `TextFragment.run` 下标。 */
  readonly runs: readonly RunPaint[]
  /** 左缩进处在文本区域中的横坐标。 */
  readonly x: number
  /** 段落顶部（段前间距之后）在文本区域中的纵坐标。 */
  readonly y: number
  /** 各行的横向平移（不断行时按对齐方式计算，否则为 0）。 */
  readonly shifts: readonly number[]
}

export interface BodyLayout {
  readonly paragraphs: readonly ParagraphLayout[]
  /** 内容高度：首段顶部到末段底部，含段间距。 */
  readonly height: number
}

export interface TextSettings {
  readonly faces: FaceCache
  /** 幻灯片编号；不在幻灯片上的文字为 `null`。 */
  readonly slideNumber: number | null
}

const ALIGN: Readonly<Record<string, Alignment>> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'both',
  justLow: 'both',
  dist: 'distribute',
  thaiDist: 'distribute',
}

/** 小数点对齐不在排版模块的能力内，按右对齐排版。 */
const TAB_ALIGN: Readonly<Record<string, TabStop['align']>> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  dec: 'right',
}

function upper(text: string): string {
  let out = ''
  for (const ch of text) {
    const u = ch.toUpperCase()
    out += u.length === ch.length ? u : ch
  }
  return out
}

function runText(run: Run, slideNumber: number | null): string {
  if (run.kind === 'break') return '\n'
  const text =
    run.kind === 'field' && run.field === 'slidenum' && slideNumber !== null
      ? String(slideNumber)
      : run.text
  return run.style.caps === 'all' ? upper(text) : text
}

function textRun(text: string, style: RunStyle, scale: number, faces: FaceCache): TextRun {
  const face = (name: string) => faces.get(name, style.bold, style.italic).face
  const latin = faces.latin(style.latin, style.bold, style.italic).face
  const run: TextRun = {
    text,
    fonts: { ascii: latin, hAnsi: latin, eastAsia: face(style.ea), cs: face(style.cs) },
    size: style.size * scale,
    slots: {
      eastAsiaHint: EAST_ASIAN_LANG.test(style.lang),
      complexScript: false,
      chineseCharset: false,
    },
  }
  return style.spacing === 0 ? run : { ...run, spacing: style.spacing * scale }
}

/** 自动调整的缩放：`fontScale` 与 `lnSpcReduction`。 */
export function autofitScale(body: BodyProperties): { font: number; lineReduction: number } {
  const a = body.autofit
  return a.kind === 'normal'
    ? { font: a.fontScale, lineReduction: a.lineSpacingReduction }
    : { font: 1, lineReduction: 0 }
}

/** 段落行距换算为排版模块的行距规则。 */
export function lineSpacing(spacing: Spacing, reduction: number): LineSpacing {
  if (spacing.unit === 'points') return { rule: 'fixed', value: spacing.value }
  return { rule: 'proportional', value: Math.max(0, spacing.value - reduction) }
}

/** 段前段后间距（磅）：百分比相对 `lineHeight`。 */
export function paragraphSpace(spacing: Spacing, lineHeight: number): number {
  return spacing.unit === 'points' ? spacing.value : spacing.value * lineHeight
}

/** 一段的字段：项目符号（若有）在前。 */
function paragraphRuns(
  p: Paragraph,
  scale: number,
  settings: TextSettings,
): { runs: TextRun[]; paints: RunPaint[] } {
  const runs: TextRun[] = []
  const paints: RunPaint[] = []
  const first = p.runs.find((r) => r.kind !== 'break')?.style ?? p.end
  const b = p.bullet
  const tab = p.indent < 0 ? '\t' : ''
  if (b.kind === 'picture' && tab !== '') {
    // 图片项目符号不绘制（计入 `pictureBullet`），只保留正文的起点。
    runs.push({ ...textRun(tab, first, scale, settings.faces), numbering: { align: 'left' } })
    paints.push({ style: null, fill: { kind: 'none' }, text: tab })
  } else if (b.kind === 'char' || b.kind === 'number') {
    const face = settings.faces.get(b.font === '' ? first.latin : b.font, false, false)
    const mark =
      b.kind === 'char' ? symbolChar(b.char, face.face) : autoNumberText(b.scheme, b.number)
    const text = mark + tab
    runs.push({
      text,
      fonts: { ascii: face.face, hAnsi: face.face, eastAsia: face.face, cs: face.face },
      size: b.size * scale,
      numbering: { align: 'left' },
    })
    paints.push({ style: null, fill: b.color, text })
  }
  for (const r of p.runs) {
    const text = runText(r, settings.slideNumber)
    if (text === '') continue
    runs.push(textRun(text, r.style, scale, settings.faces))
    paints.push({ style: r.style, fill: r.style.fill, text })
  }
  return { runs, paints }
}

function paragraphStyle(
  p: Paragraph,
  width: number,
  wrap: boolean,
  scale: { font: number; lineReduction: number },
  faces: FaceCache,
): ParagraphStyle {
  const marL = p.marginLeft / EMU_PER_PT
  const marR = p.marginRight / EMU_PER_PT
  const end = faces.get(p.end.latin, p.end.bold, p.end.italic)
  return {
    width: wrap ? width - marL - marR : UNBOUNDED,
    firstLineIndent: p.indent / EMU_PER_PT,
    align: wrap ? (ALIGN[p.align] ?? 'left') : 'left',
    lineSpacing: lineSpacing(p.lineSpacing, scale.lineReduction),
    gridPitch: null,
    kinsoku: p.eaLineBreak,
    wordWrap: !p.latinLineBreak,
    noLineBreakBefore: DEFAULT_NO_LINE_BREAK_BEFORE,
    noLineBreakAfter: DEFAULT_NO_LINE_BREAK_AFTER,
    overflowPunct: p.hangingPunctuation,
    autoSpaceDE: false,
    autoSpaceDN: false,
    expandLineBreak: false,
    tabStops: p.tabs.map((t) => ({
      position: t.position / EMU_PER_PT - marL,
      align: TAB_ALIGN[t.align] ?? 'left',
    })),
    defaultTabStop: p.defaultTabSize / EMU_PER_PT,
    tabOrigin: -marL,
    fallback: faces.fallback.face,
    mark: { face: end.face, size: p.end.size * scale.font },
  }
}

/** 不断行时各行在可用宽度内的平移。 */
function alignShift(align: string, avail: number, lineRight: number): number {
  const a = ALIGN[align] ?? 'left'
  if (a === 'center') return (avail - lineRight) / 2
  if (a === 'right') return avail - lineRight
  return 0
}

/**
 * 屏幕显示时行高与单倍行高之差加在文字上方的比例。经验拟合（机制未查明）：WPS 表格形状文字，宋体与 Arial 11、12 磅，
 * 百分比 80%–200%，固定 20、30 磅。不要改为 1（排版模块的做法，150% 时首行低约 3 像素），也不要改为按
 * `行高 / 单倍行高` 缩放基线（200% 时首行高约 1 像素）。
 */
const SCREEN_EXTRA_ABOVE = 0.76

/**
 * 屏幕显示（`FaceCache.screen`）的行高与基线，WPS 表格形状文字实测：
 * - 单倍行高按字号的整数部分计算（10.5 磅与 10 磅行距相同；宋体 9–14.5 磅以 0.25 磅步进）。基线与单倍行高中线的
 *   距离仍按实际字号，即基线比按实际字号排版时上移两种单倍行高之差的一半（6 种字体的 10.5 磅，宋体与 Arial 6.5–13.5 磅）。
 * - 行高与单倍行高之差的 `SCREEN_EXTRA_ABOVE` 加在文字上方。
 * 没有片段的行（空段落）保持原行高与基线。
 */
function screenBlock(block: TextBlock, spacing: LineSpacing): TextBlock {
  let top = block.lines[0]?.top ?? 0
  const start = top
  const lines = block.lines.map((line) => {
    if (line.fragments.length === 0) {
      const out = { ...line, top, baseline: line.baseline + top - line.top }
      top += line.height
      return out
    }
    let size = 0
    for (const f of line.fragments) size = Math.max(size, f.size)
    const k = size >= 1 ? Math.floor(size) / size : 1
    const extents = line.fragments.map((f) => faceExtent(f.face.vertical, f.size))
    const single = lineBox(extents, { rule: 'proportional', value: 1 }, null)
    const singleHeight = single.height * k
    // `lineSpacing` 只产生 `fixed` 与 `proportional` 两种规则。
    const height = spacing.rule === 'fixed' ? spacing.value : spacing.value * singleHeight
    const baseline =
      top +
      single.baseline -
      (single.height - singleHeight) / 2 +
      SCREEN_EXTRA_ABOVE * (height - singleHeight)
    const delta = baseline - line.baseline
    const out = {
      ...line,
      top,
      height,
      baseline,
      fragments: line.fragments.map((f) => ({ ...f, baseline: f.baseline + delta })),
    }
    top += height
    return out
  })
  return { lines, height: top - start }
}

/** 排版整个文本框：`width` 为文本区域宽度（文本框宽度减去左右边距）。 */
export function layoutBody(text: TextBody, width: number, settings: TextSettings): BodyLayout {
  const scale = autofitScale(text.body)
  const wrap = text.body.wrap
  const paragraphs: ParagraphLayout[] = []
  let y = 0
  text.paragraphs.forEach((p, index) => {
    const { runs, paints } = paragraphRuns(p, scale.font, settings)
    const style = paragraphStyle(p, width, wrap, scale, settings.faces)
    const laid = layoutParagraph(runs, style)
    const block = settings.faces.screen === null ? laid : screenBlock(laid, style.lineSpacing)
    const firstLine = block.lines[0]?.height ?? 0
    const lastLine = block.lines.at(-1)?.height ?? 0
    if (index > 0) y += paragraphSpace(p.spaceBefore, firstLine)
    const marL = p.marginLeft / EMU_PER_PT
    const avail = width - marL - p.marginRight / EMU_PER_PT
    const shifts = block.lines.map((l) => (wrap ? 0 : alignShift(p.align, avail, l.left + l.width)))
    paragraphs.push({ block, runs: paints, x: marL, y, shifts })
    y += block.height + paragraphSpace(p.spaceAfter, lastLine)
  })
  return { paragraphs, height: y }
}

interface Glyph {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly size: number
  readonly face: PaintFace
  readonly paint: RunPaint
}

interface Band {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color: string
}

function fontString(face: PaintFace, size: number): string {
  const family = `"${face.family.replace(/["\\]/g, '')}"`
  return `${face.italic ? 'italic ' : ''}${face.bold ? 'bold ' : ''}${size}px ${family}`
}

/** 填充的代表颜色：下划线、删除线与文字轮廓使用。 */
function representative(fill: ShapeFill): Color | null {
  if (fill.kind === 'solid') return fill.color
  if (fill.kind === 'gradient') return fill.stops[0]?.color ?? null
  if (fill.kind === 'pattern') return fill.foreground
  return null
}

function collect(
  layout: BodyLayout,
  faces: FaceCache,
): { glyphs: Glyph[]; lines: Band[]; highlights: Band[] } {
  const glyphs: Glyph[] = []
  const lines: Band[] = []
  const highlights: Band[] = []
  for (const p of layout.paragraphs) {
    p.block.lines.forEach((line, li) => {
      const shift = p.shifts[li] ?? 0
      for (const f of line.fragments) {
        const paint = p.runs[f.run]
        if (paint === undefined) continue
        const style = paint.style
        const face = faces.of(f.face)
        const rise = style === null ? 0 : style.baseline * f.size
        const y = p.y + f.baseline - rise
        const x0 = p.x + f.x + shift
        let x = x0
        let k = 0
        for (const ch of paint.text.slice(f.start, f.end)) {
          if (ch !== '\t' && ch !== '\n' && ch !== ' ')
            glyphs.push({ text: ch, x, y, size: f.size, face, paint })
          x += f.advances[k] ?? 0
          k++
        }
        if (style === null) continue
        const width = x - x0
        if (style.highlight !== null) {
          const color = colorToCss(style.highlight)
          highlights.push({ x: x0, y: p.y + line.top, width, height: line.height, color })
        }
        const c = representative(paint.fill)
        if (c === null) continue
        const thickness = Math.max(f.size / 18, 0.5)
        const color = colorToCss(c)
        if (style.underline !== 'none')
          lines.push({ x: x0, y: y + f.size * 0.12, width, height: thickness, color })
        if (style.strike !== 'noStrike')
          lines.push({ x: x0, y: y - f.size * 0.3, width, height: thickness, color })
      }
    })
  }
  return { glyphs, lines, highlights }
}

/**
 * 逐字绘制。`screen` 不为 `null` 且 `matrix` 不含旋转与斜切时按屏幕显示绘制：基线取整到设备像素，
 * 有点阵的字形以点阵画在取整后的设备坐标上（`ScreenText.bitmap`）。
 */
function drawGlyphs(
  ctx: PaintContext,
  glyphs: readonly Glyph[],
  color: string | null,
  screen: { readonly text: ScreenText; readonly matrix: Matrix } | null = null,
): void {
  const m = screen?.matrix
  const upright = m !== undefined && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0
  let font = ''
  for (const g of glyphs) {
    const f = fontString(g.face, g.size)
    if (f !== font) {
      ctx.font = f
      font = f
    }
    if (color === null) {
      const fill = g.paint.fill
      if (fill.kind !== 'solid') continue
      ctx.fillStyle = colorToCss(fill.color)
    }
    if (!upright) {
      ctx.fillText(g.text, g.x, g.y)
      continue
    }
    const baseline = Math.round(m.d * g.y + m.f)
    const bitmap = screen!.text.bitmap(g.face, g.text.codePointAt(0)!, Math.round(g.size * m.d))
    if (bitmap === null) {
      ctx.fillText(g.text, g.x, (baseline - m.f) / m.d)
      continue
    }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const x = Math.round(m.a * g.x + m.e)
    fillBitmap(ctx, bitmap.glyph, x, baseline, bitmap.ascent, bitmap.descent)
    ctx.restore()
  }
}

function prepare(ctx: PaintContext): void {
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
}

function glyphBounds(
  glyphs: readonly Glyph[],
  matrix: Matrix,
  canvas: { width: number; height: number },
): DeviceRect | null {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const g of glyphs) {
    for (const [x, y] of [
      [g.x - g.size * 0.5, g.y - g.size * 1.2],
      [g.x + g.size * 1.5, g.y - g.size * 1.2],
      [g.x + g.size * 1.5, g.y + g.size * 0.5],
      [g.x - g.size * 0.5, g.y + g.size * 0.5],
    ] as const) {
      const p = apply(matrix, x, y)
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  }
  const left = Math.max(0, Math.floor(x0))
  const top = Math.max(0, Math.floor(y0))
  const right = Math.min(canvas.width, Math.ceil(x1))
  const bottom = Math.min(canvas.height, Math.ceil(y1))
  if (!(right > left && bottom > top)) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export interface TextTarget {
  /** 文本区域坐标（磅，原点为文本区域左上角）到设备坐标。 */
  readonly matrix: Matrix
  /** 文本区域宽高（磅）：文字的非纯色填充以此为范围。 */
  readonly width: number
  readonly height: number
  /** 每个 96 dpi 像素对应的设备像素数。 */
  readonly scale: number
}

function shadowKey(s: OuterShadow): string {
  return JSON.stringify(s)
}

/** 绘制排版结果。`shadows` 为作用于全部文字的外部阴影（形状没有填充与线条时，形状的阴影作用于文字）。 */
export function paintBody(
  ctx: PaintContext,
  layout: BodyLayout,
  target: TextTarget,
  faces: FaceCache,
  res: PaintResources,
  canvas: { width: number; height: number },
  shadows: readonly OuterShadow[],
): void {
  const { glyphs, lines, highlights } = collect(layout, faces)
  if (glyphs.length === 0 && lines.length === 0 && highlights.length === 0) return
  const frame = {
    matrix: target.matrix,
    width: target.width,
    height: target.height,
    scale: target.scale,
  }
  ctx.save()
  setMatrix(ctx, target.matrix)
  prepare(ctx)
  for (const h of highlights) {
    ctx.fillStyle = h.color
    ctx.fillRect(h.x, h.y, h.width, h.height)
  }
  ctx.restore()

  // 阴影：按阴影参数分组，每组的字形画到图层后只绘制阴影。
  const groups = new Map<string, { shadow: OuterShadow; glyphs: Glyph[] }>()
  for (const g of glyphs) {
    const own = g.paint.style?.effects ?? []
    for (const e of [...shadows, ...own]) {
      if (e.kind !== 'outerShadow') continue
      const key = shadowKey(e)
      const group = groups.get(key) ?? { shadow: e, glyphs: [] }
      group.glyphs.push(g)
      groups.set(key, group)
    }
  }
  for (const { shadow, glyphs: list } of groups.values()) {
    const bounds = glyphBounds(list, target.matrix, canvas)
    if (bounds === null) continue
    const layer = drawLayer(bounds, res, (c, offset) => {
      setMatrix(c, multiply(offset, target.matrix))
      prepare(c)
      c.fillStyle = '#000'
      drawGlyphs(c, list, '#000')
    })
    if (layer !== null) paintShadows(ctx, layer, bounds, [shadow], frame, canvas)
  }

  ctx.save()
  setMatrix(ctx, target.matrix)
  prepare(ctx)
  drawGlyphs(
    ctx,
    glyphs,
    null,
    faces.screen === null ? null : { text: faces.screen, matrix: target.matrix },
  )
  ctx.restore()

  // 非纯色填充：字形作遮罩，填充覆盖其上。
  const fills = new Map<string, { fill: ShapeFill; glyphs: Glyph[] }>()
  for (const g of glyphs) {
    const fill = g.paint.fill
    if (fill.kind === 'solid' || fill.kind === 'none') continue
    const key = JSON.stringify(fill)
    const group = fills.get(key) ?? { fill, glyphs: [] }
    group.glyphs.push(g)
    fills.set(key, group)
  }
  for (const { fill, glyphs: list } of fills.values()) {
    const bounds = glyphBounds(list, target.matrix, canvas)
    if (bounds === null) continue
    const layer = drawLayer(bounds, res, (c, offset) => {
      const m = multiply(offset, target.matrix)
      setMatrix(c, m)
      prepare(c)
      drawGlyphs(c, list, '#000')
      const cover = drawLayer(bounds, res, (f, o2) => {
        const fm = multiply(o2, target.matrix)
        setMatrix(f, fm)
        const margin = Math.max(target.width, target.height)
        paintFill(
          f,
          () => traceRect(f, target.width, target.height, margin),
          fill,
          { width: target.width, height: target.height, matrix: fm },
          res,
        )
      })
      if (cover === null) return
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.globalCompositeOperation = 'source-in'
      c.drawImage(cover, 0, 0)
    })
    if (layer !== null) drawLayerOnto(ctx, layer, bounds)
  }

  ctx.save()
  setMatrix(ctx, target.matrix)
  prepare(ctx)
  let font = ''
  for (const g of glyphs) {
    const outline = g.paint.style?.outline ?? null
    if (outline === null) continue
    const c = representative(outline.fill)
    if (c === null) continue
    const f = fontString(g.face, g.size)
    if (f !== font) {
      ctx.font = f
      font = f
    }
    const w = outline.width / EMU_PER_PT
    ctx.lineWidth = w > 0 ? w : 1 / deviceScale(target.matrix)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = colorToCss(c)
    ctx.strokeText(g.text, g.x, g.y)
  }
  for (const l of lines) {
    ctx.fillStyle = l.color
    ctx.fillRect(l.x, l.y, l.width, l.height)
  }
  ctx.restore()
}
