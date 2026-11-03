/**
 * 文本框排版与绘制：把已解决样式的段落转换为 `../../text/` 的输入，再按行与片段绘制。长度单位为磅。
 *
 * - 断行与对齐由 `layoutParagraph` 完成，行高与基线再按宿主的规则换算（`hostBlock`）；本模块换算输入：
 *   - 行距 `spcPct` 为单倍行高的倍数（`proportional`），`spcPts` 为固定行高（`fixed`），与单倍行高之差按 `hostBlock`
 *     分配在文字上下；`normAutofit` 的 `lnSpcReduction` 从百分比行距中减去，`fontScale` 乘到字号上。
 *   - 段前段后的 `spcPts` 为磅值，`spcPct` 为该段首行（段后取末行）单倍行高（`singleLine`）的倍数，与行距无关；
 *     首段不加段前间距。实测（WPS 演示导出图，等线、宋体、Arial 12–24 磅，行距 100% 与 150%）：段前与此一致；
 *     段后为单倍行高的 1.03–1.12 倍（随字体不同，机制未查明）。
 *   - 制表位位置相对文本区域左边，换算为相对左缩进的行坐标；默认制表位从文本区域左边起排列。
 *   - 字符与编号项目符号作为编号字段：悬挂缩进（`indent` 小于 0）时其后加制表符，正文从左缩进处开始，项目符号到达或
 *     越过左缩进时紧接其后（`TextRun.numbering` 的 `indentTab`）。
 *     图片项目符号不进入排版模块：正文的首行起点按图片宽度换算（见 `layoutBody`），图片与底纹同时绘制。
 *   - 公式为行内对象（见 `math.ts`）。独占一行的 `m:oMath`（见 `standalone`）按显示样式排版，所在各行按 `m:jc` 平移
 *     （行内公式缺省为 `centerGroup`）；其余按行内样式排版，随段落对齐。
 * - `eaVert`：排版与 `vert` 相同（调用方旋转文本区域），绘制时东亚文字在字框中转回直立（见 `orientation`）。
 * - `wrap` 为假时不断行：按不限宽度排版后，各行在文本区域内按段落对齐方式整体平移。
 * - 字段 `slidenum` 显示 `TextSettings.slideNumber`（为 `null` 时与其余字段相同），其余字段显示文件中保存的文字。
 *   全部大写（`caps="all"`）按大写字母排版。字符间距（`spc`）乘以自动调整的字号缩放。
 * - 绘制：每个字逐个定位，与排版的步进一致；`FaceCache.glyphs` 不为 `null` 时按屏幕显示绘制（见 `drawGlyphs`），
 *   `FaceCache.clearType` 不为 `null` 时平滑字号以 ClearType 字形写入画布像素。
 *   不是纯色的文字填充（渐变、图片、图案）以每一行为填充范围：横向为该行内容（`TextLine.left` 起 `width` 宽），
 *   纵向为行高，在图层中以文字为遮罩覆盖。实测（WPS 演示导出图，宋体 40 磅的方块，线性渐变 0° 与 90°、
 *   路径渐变与图片拉伸填充）：每行的颜色变化都从行首到行尾、从行顶到行底，与行长、对齐、锚点、溢出与
 *   `spAutoFit` 无关，同一行的两个字段共用一个范围。文字的外部阴影与调用方传入的阴影一并按字形轮廓绘制。
 * - 文字的发光与映像（字段的 `effectLst`）：发光按字形图层膨胀后模糊（`../paint/effects.ts`），膨胀量随字号变化（见
 *   `textGlowRadius`）；映像逐行绘制，见 `paintBody`。
 * - 下划线与删除线的位置与粗细按字号的固定比例绘制，不读取字体的 `post` 表。
 */

import { fillBitmap } from '../../glyph/bitmap.ts'
import type { GlyphRun, PlacedGlyph } from '../../glyph/cleartype/index.ts'
import {
  type Alignment,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  faceExtent,
  type InlineObject,
  type LineBox,
  type LineSpacing,
  layoutParagraph,
  lineBox,
  type ParagraphRun,
  type ParagraphStyle,
  type TabStop,
  type TextBlock,
  type TextFace,
  type TextLine,
  type TextRun,
} from '../../text/index.ts'
import { type Color, colorToCss } from '../color.ts'
import type { ShapeFill } from '../fill.ts'
import {
  apply,
  type Matrix,
  multiply,
  type PaintContext,
  setMatrix,
  translation,
} from '../paint/context.ts'
import {
  type Glow,
  glowReach,
  glowSpread,
  paintGlow,
  paintReflection,
  type Reflection,
} from '../paint/effects.ts'
import { deviceScale, type PaintResources, paintFill, traceRect } from '../paint/fill.ts'
import { drawPicture, type PaintPicture, pictureSize } from '../paint/picture.ts'
import {
  type DeviceRect,
  drawLayer,
  drawLayerOnto,
  type OuterShadow,
  paintShadows,
} from '../paint/shadow.ts'
import { autoNumberText, symbolChar } from './bullet.ts'
import {
  type FaceCache,
  type PaintFace,
  type ScreenText,
  SINGLE_LINE,
  type TextClearType,
} from './fonts.ts'
import {
  displayAlignment,
  type FormulaPaint,
  formulaParts,
  paintFormula,
  type TextMathFonts,
} from './math.ts'
import type {
  BodyProperties,
  Bullet,
  Paragraph,
  Run,
  RunStyle,
  Spacing,
  TextBody,
} from './model.ts'

const EMU_PER_PT = 12700
const EMU_PER_PX = 9525
const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 }
/** 不断行时的排版宽度。 */
const UNBOUNDED = 1e7
const EAST_ASIAN_LANG = /^(zh|ja|ko)(-|$)/i

export interface RunPaint {
  /** 项目符号为 `null`。 */
  readonly style: RunStyle | null
  readonly fill: ShapeFill
  /** 排版时的字段文字（项目符号含其后的制表符）；公式为空串。 */
  readonly text: string
  /** 公式的一段；其余字段与不绘制的公式为 `null`。 */
  readonly formula: FormulaPaint | null
}

/** 图片项目符号在文本区域中的位置与尺寸（磅）。 */
export interface PictureBulletBox {
  readonly part: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
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
  /** 图片项目符号；没有图片项目符号或图片无法绘制时为 `null`。 */
  readonly bullet: PictureBulletBox | null
}

export interface BodyLayout {
  readonly paragraphs: readonly ParagraphLayout[]
  /** 内容高度：首段顶部到末段底部，含段间距。 */
  readonly height: number
  /** 锚定居中与底端时内容高度另加的部分（磅，见 `anchorOverhang`）；屏幕显示的排版为 0。 */
  readonly overhang: number
  /** 东亚文字直立（`eaVert`）：调用方按 `vert` 旋转文本区域，东亚文字在各自的字框中转回直立（见 `orientation`）。 */
  readonly upright: boolean
}

export interface TextSettings {
  readonly faces: FaceCache
  /** 幻灯片编号；不在幻灯片上的文字为 `null`。 */
  readonly slideNumber: number | null
  /**
   * 图片项目符号的图片（幻灯片的图片资源）。只有幻灯片上的文字提供：工作表与文档中的图片项目符号在解析时计入能力边界，
   * 不绘制。
   */
  readonly pictures?: (part: string) => PaintPicture | null
  /** 公式所用的字体。只有幻灯片上的文字提供：工作表与文档的 DrawingML 文字不读取公式。 */
  readonly math?: TextMathFonts
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

function runText(run: Exclude<Run, { kind: 'math' }>, slideNumber: number | null): string {
  if (run.kind === 'break') return '\n'
  const text =
    run.kind === 'field' && run.field === 'slidenum' && slideNumber !== null
      ? String(slideNumber)
      : run.text
  return run.style.caps === 'all' ? upper(text) : text
}

function textRun(text: string, style: RunStyle, scale: number, faces: FaceCache): TextRun {
  const face = (name: string) => faces.get(name, style.bold, style.italic).face
  const latin = (slot: 'ascii' | 'hAnsi') =>
    faces.latin(style.latin, style.latinCharset, style.bold, style.italic, slot).face
  const run: TextRun = {
    text,
    fonts: {
      ascii: latin('ascii'),
      hAnsi: latin('hAnsi'),
      eastAsia: face(style.ea),
      cs: face(style.cs),
    },
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
): { runs: ParagraphRun[]; paints: RunPaint[]; displays: (Alignment | null)[] } {
  const runs: ParagraphRun[] = []
  const paints: RunPaint[] = []
  /** 按字段下标：独占一行的公式的对齐，其余为 `null`。 */
  const displays: (Alignment | null)[] = []
  const first = p.runs.find((r) => r.kind !== 'break')?.style ?? p.end
  const b = p.bullet
  const tab = p.indent < 0 ? '\t' : ''
  if (b.kind === 'char' || b.kind === 'number') {
    const face = settings.faces.get(b.font === '' ? first.latin : b.font, false, false)
    const mark =
      b.kind === 'char' ? symbolChar(b.char, face.face) : autoNumberText(b.scheme, b.number)
    const text = mark + tab
    runs.push({
      text,
      fonts: { ascii: face.face, hAnsi: face.face, eastAsia: face.face, cs: face.face },
      size: b.size * scale,
      numbering: { align: 'left', indentTab: true },
    })
    paints.push({ style: null, fill: b.color, text, formula: null })
  }
  p.runs.forEach((r, i) => {
    if (r.kind === 'math') {
      r.zones.forEach((zone, k) => {
        if (k > 0) {
          runs.push(textRun('\n', r.style, scale, settings.faces))
          paints.push({ style: r.style, fill: r.style.fill, text: '\n', formula: null })
        }
        const alone = standalone(p, i, k)
        const parts = formulaParts(zone, alone, r.style, scale, settings.faces, settings.math)
        const display = alone ? displayAlignment(r.display ?? 'centerGroup') : null
        for (const part of parts) {
          runs.push({ object: part.object })
          paints.push({ style: r.style, fill: r.style.fill, text: '', formula: part.paint })
          displays[runs.length - 1] = display
        }
      })
      return
    }
    const text = runText(r, settings.slideNumber)
    if (text === '') return
    runs.push(textRun(text, r.style, scale, settings.faces))
    paints.push({ style: r.style, fill: r.style.fill, text, formula: null })
  })
  return { runs, paints, displays }
}

/** 字段排版后不占内容：没有文字的文字字段与编号字段。 */
function empty(r: Run): boolean {
  return (r.kind === 'text' || r.kind === 'field') && r.text === ''
}

/**
 * 第 `index` 个字段（公式）的第 `zone` 个 `m:oMath` 独占一行：之前紧接段首（没有项目符号）、强制换行或同一公式的上一个
 * `m:oMath`，之后紧接段末、强制换行或下一个 `m:oMath`；没有文字的字段不计。WPS 演示实测（构造文件与语料）：强制换行之后
 * 独占一行的行内公式按显示样式居中；项目符号之后的显示公式按行内样式紧接项目符号，同一 `m:oMathPara` 中其后的 `m:oMath`
 * 仍居中显示。
 */
function standalone(p: Paragraph, index: number, zone: number): boolean {
  const run = p.runs[index]
  if (run?.kind !== 'math') return false
  let before = zone > 0
  if (!before) {
    let k = index - 1
    while (k >= 0 && empty(p.runs[k]!)) k--
    before = k < 0 ? p.bullet.kind === 'none' : p.runs[k]!.kind === 'break'
  }
  let after = zone < run.zones.length - 1
  if (!after) {
    let k = index + 1
    while (k < p.runs.length && empty(p.runs[k]!)) k++
    after = k >= p.runs.length || p.runs[k]!.kind === 'break'
  }
  return before && after
}

/**
 * 只含独占一行的公式的行按其对齐方式的平移；其余行为 `null`。对齐范围为 `TextLine.origin` 至 `limit`，不断行时右端为
 * 可用宽度。
 */
function displayShift(
  line: TextLine,
  displays: readonly (Alignment | null)[],
  wrap: boolean,
  avail: number,
): number | null {
  if (line.fragments.length > 0 || line.objects.length === 0) return null
  const align = displays[line.objects[0]!.run] ?? null
  if (align === null || line.objects.some((o) => displays[o.run] !== align)) return null
  const start = line.origin
  const end = wrap ? line.limit : avail
  const target =
    align === 'left'
      ? start
      : align === 'right'
        ? end - line.width
        : start + (end - start - line.width) / 2
  return target - line.left
}

function paragraphStyle(
  p: Paragraph,
  width: number,
  wrap: boolean,
  scale: { font: number; lineReduction: number },
  faces: FaceCache,
  firstLineIndent: number,
): ParagraphStyle {
  const marL = p.marginLeft / EMU_PER_PT
  const marR = p.marginRight / EMU_PER_PT
  const end = faces.get(p.end.latin, p.end.bold, p.end.italic)
  return {
    width: wrap ? width - marL - marR : UNBOUNDED,
    firstLineIndent,
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
    fallback: () => faces.fallback.face,
    mark: { face: end.face, size: p.end.size * scale.font },
  }
}

/** 不断行时各行在可用宽度内的平移。 */
function alignShift(a: Alignment, avail: number, lineRight: number): number {
  if (a === 'center') return (avail - lineRight) / 2
  if (a === 'right') return avail - lineRight
  return 0
}

/**
 * 行高与单倍行高之差加在文字上方的比例（其余在文字下方）。演示文稿为字号与单倍行高之比：WPS 演示导出图中 6 种字体
 * 10–32 磅的 150%、80% 与 30 磅固定行距，首行比单倍行距下移（行高 − 单倍行高）÷ 1.2。不要改为 1（排版模块的做法，
 * 150% 时 16 磅首行低 2 像素）。
 */
const EXTRA_ABOVE = 1 / SINGLE_LINE
/**
 * 屏幕显示时代替 `EXTRA_ABOVE` 的比例。经验拟合（机制未查明）：WPS 表格形状文字，宋体与 Arial 11、12 磅，
 * 百分比 80%–200%，固定 20、30 磅。不要改为 1（150% 时首行低约 3 像素），也不要改为按
 * `行高 / 单倍行高` 缩放基线（200% 时首行高约 1 像素）。
 */
const SCREEN_EXTRA_ABOVE = 0.76

/** 一段的行高换算参数：段落结束符、是否屏幕显示、项目符号的字段下标（没有项目符号时为 `null`）、各字段中的行内对象。 */
interface LineContext {
  readonly mark: ParagraphStyle['mark']
  readonly screen: boolean
  readonly bullet: number | null
  readonly faces: FaceCache
  /** 按字段下标；不是行内对象的字段为 `null`。 */
  readonly objects: readonly (InlineObject | null)[]
}

/**
 * 不按屏幕显示排版时一行的基线距行顶的距离（单倍行距，磅）：各片段 win 上下沿（乘字号）的并集，以下沿最大的片段的
 * 纵向中心系数定位，即基线 = 系数 × 行内最大字号 + (最大上沿 − 最大下沿) / 2。只有一种字体时与 `lineFace` 换算的
 * 上沿相同。实测（WPS 演示导出图，44 磅一行，等线、黑体、宋体、楷体、微软雅黑与 Arial、Calibri、Times New Roman、
 * Georgia、Verdana、Segoe UI 两两同行）：30 组中 23 组两种字体的位置都一致，其余 7 组相差 1 像素。不要改为取各片段
 * 上沿的最大值：此时 10 组不一致，其中 6 组相差 2 像素（如等线与 Arial 同行时整行低 2 像素）。
 */
function mixedBaseline(
  parts: readonly { face: TextFace; size: number }[],
  context: LineContext,
): number {
  let size = 0
  let ascent = 0
  let descent = -1
  let center = 0
  for (const p of parts) {
    const m = context.faces.of(p.face).line
    size = Math.max(size, p.size)
    ascent = Math.max(ascent, m.ascent * p.size)
    if (m.descent * p.size > descent) {
      descent = m.descent * p.size
      center = m.center
    }
  }
  return center * size + (ascent - descent) / 2
}

/**
 * 一行按单倍行距的行高与基线（磅）：`natural` 取行内各片段的上下沿，`height` 为宿主的单倍行高。
 * - 项目符号不计入：WPS 演示导出图中 Arial、Wingdings、宋体的项目符号（字号 70%–150%）不改变行高与基线。
 * - 只有项目符号或没有片段的行取段落结束符；有行内对象（公式）时上沿与下沿分别取文字与对象的较大者，只有对象的行不计
 *   段落结束符。WPS 演示实测（24 磅宋体与 Cambria Math）：行内分数使所在行的基线下移、行高增加，下一行随之下移；
 *   只含显示分数或求和的行高为公式的上沿与下沿之和。
 * - `FaceCache.wholeSizeLine` 为真时单倍行高按行内最大字号的整数部分计算。实测：WPS 表格的形状文字 10.5 磅与 10 磅
 *   行距相同（宋体 9–14.5 磅以 0.25 磅步进）；WPS 表格图表的 10.5 磅多行标题（宋体、微软雅黑、Calibri、Arial）每行
 *   比按实际字号计算少 1 像素，WPS 演示与 WPS 文字中同样的图表按实际字号。
 */
function singleLine(
  line: TextLine,
  context: LineContext,
): { readonly natural: LineBox; readonly height: number } {
  const { mark, screen, bullet } = context
  const text = line.fragments.filter((f) => f.run !== bullet)
  const objects = line.objects.flatMap((o) => {
    const object = context.objects[o.run]
    return object === null || object === undefined ? [] : [object]
  })
  const parts = text.length > 0 ? text : objects.length > 0 ? [] : [mark]
  let size = 0
  for (const p of parts) size = Math.max(size, p.size)
  let natural: LineBox = { height: 0, baseline: 0 }
  if (parts.length > 0) {
    const extents = parts.map((p) => faceExtent(p.face.vertical, p.size))
    const box = lineBox(extents, { rule: 'proportional', value: 1 }, null)
    natural = screen ? box : { height: box.height, baseline: mixedBaseline(parts, context) }
  }
  if (objects.length > 0) {
    let ascent = natural.baseline
    let descent = natural.height - natural.baseline
    for (const o of objects) {
      ascent = Math.max(ascent, o.ascent)
      descent = Math.max(descent, o.descent)
    }
    natural = { height: ascent + descent, baseline: ascent }
  }
  const k = context.faces.wholeSizeLine && size >= 1 ? Math.floor(size) / size : 1
  return { natural, height: natural.height * k }
}

/**
 * 按宿主的规则换算行高与基线（排版模块把行高与单倍行高之差全部加在文字上方）：
 * - 行高与单倍行高（`singleLine`）之差的 `EXTRA_ABOVE`（屏幕显示为 `SCREEN_EXTRA_ABOVE`）加在文字上方。
 * - 单倍行高按整数字号计算时（`FaceCache.wholeSizeLine`）基线与单倍行高中线的距离仍按实际字号，即基线比按实际字号
 *   排版时上移两种单倍行高之差的一半（WPS 表格形状文字 6 种字体的 10.5 磅，宋体与 Arial 6.5–13.5 磅）。
 * 没有片段的行（空段落）保持原行高与基线。
 */
function hostBlock(block: TextBlock, spacing: LineSpacing, context: LineContext): TextBlock {
  const extraAbove = context.screen ? SCREEN_EXTRA_ABOVE : EXTRA_ABOVE
  let top = block.lines[0]?.top ?? 0
  const start = top
  const lines = block.lines.map((line) => {
    if (line.fragments.length === 0 && line.objects.length === 0) {
      const out = { ...line, top, baseline: line.baseline + top - line.top }
      top += line.height
      return out
    }
    const { natural: single, height: singleHeight } = singleLine(line, context)
    // `lineSpacing` 只产生 `fixed` 与 `proportional` 两种规则。
    const height = spacing.rule === 'fixed' ? spacing.value : spacing.value * singleHeight
    const baseline =
      top +
      single.baseline -
      (single.height - singleHeight) / 2 +
      extraAbove * (height - singleHeight)
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

/**
 * 首行按单倍行距的下沿超出首行行高的部分（磅）：各片段 `FaceLine.bottom` 乘字号的最大值减去行高，不小于 0；片段的取法
 * 同 `singleLine`（项目符号不计，没有片段时取段落结束符）。WPS 演示的文本框锚定居中与底端时，内容高度另加这一部分，
 * 文字仍从内容顶部排起；锚定顶端与表格单元格不受影响。实测（导出图，20 余种字体 20–80 磅单行与两行、行距 80%–150%、
 * 同一行两种字体与字号、首段为空段落）：底端锚定的位移与之相差不超过 1 像素，居中为其一半；只取决于首行，次行的字体
 * 不影响；行距减小时位移随之增大（下沿按单倍行距计）。
 */
function anchorOverhang(line: TextLine | undefined, context: LineContext): number {
  if (line === undefined) return 0
  const text = line.fragments.filter((f) => f.run !== context.bullet)
  const parts = text.length > 0 ? text : line.objects.length > 0 ? [] : [context.mark]
  let bottom = 0
  for (const p of parts) bottom = Math.max(bottom, context.faces.of(p.face).line.bottom * p.size)
  return Math.max(0, bottom - line.height)
}

/**
 * 图片项目符号的高度与项目符号字号之比；宽度按图片的宽高比。WPS 演示实测（Arial、宋体、微软雅黑、黑体、Calibri、
 * Times New Roman 12–60 磅，项目符号字号 50%–200%，宽高比 2:1、1:1、1:2）：高度误差不超过 1 像素。
 */
const BULLET_HEIGHT = 0.68

/**
 * 一行的纵向中心：基线之上 `(上沿 − 下沿) / 2`，上下沿取法同 `mixedBaseline`。图片项目符号的中心在首行的纵向中心
 * （WPS 演示实测：项目符号字号变化时图片中心不动，同一字号下微软雅黑的图片比 Arial 高 2 像素）。
 */
function lineMiddle(line: TextLine, faces: FaceCache): number {
  let ascent = 0
  let descent = 0
  for (const f of line.fragments) {
    const m = faces.of(f.face).line
    ascent = Math.max(ascent, m.ascent * f.size)
    descent = Math.max(descent, m.descent * f.size)
  }
  return line.baseline - (ascent - descent) / 2
}

/** 图片项目符号的尺寸（磅）；没有图片资源或图片无法绘制时为 `null`。 */
function bulletPicture(
  b: Extract<Bullet, { kind: 'picture' }>,
  scale: number,
  settings: TextSettings,
): { part: string; width: number; height: number } | null {
  const picture = b.part === null ? null : (settings.pictures?.(b.part) ?? null)
  if (b.part === null || picture === null) return null
  const size = pictureSize(picture)
  const height = BULLET_HEIGHT * b.size * scale
  const width = size.height > 0 ? (height * size.width) / size.height : height
  return { part: b.part, width, height }
}

/** 排版整个文本框：`width` 为文本区域宽度（文本框宽度减去左右边距）。 */
export function layoutBody(text: TextBody, width: number, settings: TextSettings): BodyLayout {
  const scale = autofitScale(text.body)
  const wrap = text.body.wrap
  const paragraphs: ParagraphLayout[] = []
  let y = 0
  let overhang = 0
  text.paragraphs.forEach((p, index) => {
    const { runs, paints, displays } = paragraphRuns(p, scale.font, settings)
    const indent = p.indent / EMU_PER_PT
    const picture =
      p.bullet.kind === 'picture' ? bulletPicture(p.bullet, scale.font, settings) : null
    // 图片项目符号放在悬挂缩进处（首行缩进为正时放在左缩进处），正文从悬挂缩进的制表位或首行缩进处开始，
    // 与图片重叠时紧接图片右侧（WPS 演示实测：缩进为 −96、−36、0、24 像素，图片宽 22、44 像素）。
    const bulletAt = Math.min(indent, 0)
    const start = picture === null ? indent : Math.max(indent, 0, bulletAt + picture.width)
    const style = paragraphStyle(p, width, wrap, scale, settings.faces, start)
    const laid = layoutParagraph(runs, style)
    const context: LineContext = {
      mark: style.mark,
      screen: settings.faces.screen !== null,
      bullet: paints[0]?.style === null ? 0 : null,
      faces: settings.faces,
      objects: runs.map((r) => ('object' in r ? r.object : null)),
    }
    const block = hostBlock(laid, style.lineSpacing, context)
    if (index === 0 && !context.screen) overhang = anchorOverhang(block.lines[0], context)
    const single = (line: TextLine | undefined) =>
      line === undefined ? 0 : singleLine(line, context).height
    const firstLine = single(block.lines[0])
    const lastLine = single(block.lines.at(-1))
    if (index > 0) y += paragraphSpace(p.spaceBefore, firstLine)
    const marL = p.marginLeft / EMU_PER_PT
    const avail = width - marL - p.marginRight / EMU_PER_PT
    const align = ALIGN[p.align] ?? 'left'
    const shifts = block.lines.map(
      (l) =>
        displayShift(l, displays, wrap, avail) ??
        (wrap ? 0 : alignShift(align, avail, l.left + l.width)),
    )
    const first = block.lines[0]
    let bullet: PictureBulletBox | null = null
    if (picture !== null && first !== undefined) {
      bullet = {
        part: picture.part,
        x: marL + first.left + (shifts[0] ?? 0) - (start - bulletAt),
        y: y + lineMiddle(first, settings.faces) - picture.height / 2,
        width: picture.width,
        height: picture.height,
      }
    }
    paragraphs.push({ block, runs: paints, x: marL, y, shifts, bullet })
    y += block.height + paragraphSpace(p.spaceAfter, lastLine)
  })
  return { paragraphs, height: y, overhang, upright: text.body.vertical === 'eaVert' }
}

/** 文本区域坐标中的矩形。 */
interface Area {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 竖排（`eaVert`）中字的方向：`flow` 随文字方向旋转（西文、数字、括号、破折号、长音符号等），`upright` 在字框中转回直立
 * （汉字、假名、谚文与全角字母），`raised` 直立并移到字框右上角（顿号、句号、全角逗号与句点）。WPS 演示实测（宋体、
 * 黑体、微软雅黑 20–32 磅）。
 */
type Orientation = 'flow' | 'upright' | 'raised'

/** 竖排中随文字方向旋转的东亚标点：括号、波浪线、长音符号、冒号、分号与全角连字符。 */
const FLOW_PUNCTUATION = new Set([
  0x3008, 0x3009, 0x300a, 0x300b, 0x300c, 0x300d, 0x300e, 0x300f, 0x3010, 0x3011, 0x3014, 0x3015,
  0x3016, 0x3017, 0x3018, 0x3019, 0x301a, 0x301b, 0x301c, 0x30fc, 0xff08, 0xff09, 0xff0d, 0xff1a,
  0xff1b, 0xff1c, 0xff1e, 0xff3b, 0xff3d, 0xff3f, 0xff5b, 0xff5c, 0xff5d, 0xff5e,
])
const RAISED_PUNCTUATION = new Set([0x3001, 0x3002, 0xff0c, 0xff0e])

/** 竖排中直立的码位范围（含两端）。 */
const UPRIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x2e80, 0x2fff],
  [0x3000, 0x30ff],
  [0x3100, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3ffff],
]

function orientation(ch: string): Orientation {
  const cp = ch.codePointAt(0)!
  if (RAISED_PUNCTUATION.has(cp)) return 'raised'
  if (FLOW_PUNCTUATION.has(cp)) return 'flow'
  return UPRIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 'upright' : 'flow'
}

/** 一行在文本区域中的范围与基线。 */
interface LineArea extends Area {
  readonly baseline: number
}

interface Glyph {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly size: number
  /** 排版的步进：直立的字以其字框中心转回直立。 */
  readonly advance: number
  readonly orient: Orientation
  readonly face: PaintFace
  readonly paint: RunPaint
  /** 所在行：非纯色填充的范围，映像的对称轴。 */
  readonly line: LineArea
}

/**
 * 顿号、句号等在直立字框中的位移（字号的倍数，向右、向上）。WPS 演示实测（宋体 24 磅）：顿号、句号相差不超过 1 像素，
 * 全角逗号与句点相差 3–4 像素。
 */
const RAISE = { x: 0.5, y: 0.5 }

/**
 * 在字的位置调用 `draw`：`flow` 的字在原位置；直立的字以字框中心（步进的中点、上下沿的中点）逆时针转 90°，
 * 当前变换在调用期间临时修改。
 */
function placeGlyph(ctx: PaintContext, g: Glyph, draw: (x: number, y: number) => void): void {
  if (g.orient === 'flow') {
    draw(g.x, g.y)
    return
  }
  const half = g.face.line.upright * g.size
  ctx.save()
  ctx.translate(g.x + g.advance / 2, g.y - half)
  ctx.rotate(-Math.PI / 2)
  const dx = g.orient === 'raised' ? RAISE.x * g.size : 0
  const dy = g.orient === 'raised' ? RAISE.y * g.size : 0
  draw(-g.advance / 2 + dx, half - dy)
  ctx.restore()
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

/** 公式在文本区域中的位置。 */
interface PlacedFormula {
  readonly formula: FormulaPaint
  readonly x: number
  readonly baseline: number
}

function collect(
  layout: BodyLayout,
  faces: FaceCache,
  upright: boolean,
): { glyphs: Glyph[]; lines: Band[]; highlights: Band[]; formulas: PlacedFormula[] } {
  const glyphs: Glyph[] = []
  const lines: Band[] = []
  const highlights: Band[] = []
  const formulas: PlacedFormula[] = []
  for (const p of layout.paragraphs) {
    p.block.lines.forEach((line, li) => {
      const shift = p.shifts[li] ?? 0
      for (const o of line.objects) {
        const formula = p.runs[o.run]?.formula ?? null
        if (formula !== null)
          formulas.push({ formula, x: p.x + o.x + shift, baseline: p.y + line.baseline })
      }
      const area: LineArea = {
        x: p.x + line.left + shift,
        y: p.y + line.top,
        width: line.width,
        height: line.height,
        baseline: p.y + line.baseline,
      }
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
          const advance = f.advances[k] ?? 0
          if (ch !== '\t' && ch !== '\n' && ch !== ' ') {
            const orient = upright ? orientation(ch) : 'flow'
            glyphs.push({ text: ch, x, y, size: f.size, advance, orient, face, paint, line: area })
          }
          x += advance
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
  return { glyphs, lines, highlights, formulas }
}

/** 按屏幕显示绘制：字形来源、文本区域到设备坐标的变换与画布尺寸（ClearType 字形裁到画布之内）。 */
interface ScreenTarget {
  readonly text: ScreenText
  readonly matrix: Matrix
  readonly clearType: TextClearType | null
  readonly canvas: { readonly width: number; readonly height: number }
}

/**
 * 逐字绘制。`screen` 不为 `null` 且 `matrix` 不含旋转与斜切时按屏幕显示绘制：基线取整到设备像素，
 * 有单色字形的字（`ScreenText.bitmap`：点阵、提示后的轮廓或倾斜的轮廓）画在取整后的设备坐标上；其余的字在
 * `screen.clearType` 不为 `null` 且填充为不透明纯色时以 ClearType 字形写入画布像素，同一字体、字号、颜色与基线的
 * 相邻字合为一段（GDI 把一段文字的覆盖相加后混合），这一批字收集完后交给 `TextClearType.paint`。旋转与斜切的文字、
 * 半透明的文字与没有 ClearType 字形的字以 `fillText` 绘制，在第一个这样的字之前混合暂存的字形段（`TextClearType.flush`）。
 */
function drawGlyphs(
  ctx: PaintContext,
  glyphs: readonly Glyph[],
  color: string | null,
  screen: ScreenTarget | null = null,
): void {
  const m = screen?.matrix
  const upright = m !== undefined && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0
  const runs: GlyphRun[] = []
  let placed: PlacedGlyph[] = []
  let runKey = ''
  let font = ''
  let flushed = false
  /** 直接画到画布上的字（`fillText`、点阵）之前，先混合暂存的 ClearType 字形段。 */
  const direct = () => {
    if (flushed) return
    screen?.clearType?.flush()
    flushed = true
  }
  for (const g of glyphs) {
    const f = fontString(g.face, g.size)
    if (f !== font) {
      ctx.font = f
      font = f
    }
    let css = color
    if (css === null) {
      const fill = g.paint.fill
      if (fill.kind !== 'solid') continue
      css = colorToCss(fill.color)
      ctx.fillStyle = css
    }
    if (!upright || g.orient !== 'flow') {
      direct()
      placeGlyph(ctx, g, (x, y) => ctx.fillText(g.text, x, y))
      continue
    }
    const baseline = Math.round(m.d * g.y + m.f)
    const x = Math.round(m.a * g.x + m.e)
    const codePoint = g.text.codePointAt(0)!
    const ppem = Math.round(g.size * m.d)
    const bitmap = screen!.text.bitmap(g.face, codePoint, ppem)
    if (bitmap !== null) {
      direct()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      fillBitmap(ctx, bitmap.glyph, x, baseline, bitmap.ascent, bitmap.descent)
      ctx.restore()
      continue
    }
    // `colorToCss` 只对不透明的颜色返回 `#rrggbb`。
    const smooth =
      screen!.clearType !== null && css.startsWith('#')
        ? screen!.clearType.glyph(g.face, codePoint, ppem)
        : null
    if (smooth === null) {
      direct()
      ctx.fillText(g.text, g.x, (baseline - m.f) / m.d)
      continue
    }
    const key = `${f}\u0000${css}\u0000${baseline}\u0000${smooth.ascent}\u0000${smooth.descent}`
    if (key !== runKey) {
      runKey = key
      placed = []
      const { width, height } = screen!.canvas
      runs.push({
        glyphs: placed,
        color: css,
        clip: {
          left: 0,
          top: Math.max(0, baseline - smooth.ascent),
          right: width,
          bottom: Math.min(height, baseline + smooth.descent),
        },
      })
    }
    placed.push({ glyph: smooth.glyph, x, baseline })
  }
  if (runs.length > 0) screen!.clearType!.paint(runs)
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
  /** 文本区域宽高（磅）：文字阴影的 `algn` 按此定位。 */
  readonly width: number
  readonly height: number
  /** 每个 96 dpi 像素对应的设备像素数。 */
  readonly scale: number
}

function shadowKey(s: OuterShadow): string {
  return JSON.stringify(s)
}

/**
 * 文字发光换算到形状发光的半径（设备像素）：半径乘 `(字号 / 72 磅)^0.7`，再按 `glowSpread` 取膨胀量。经验拟合（机制未查明）：
 * WPS 演示导出图中 Arial 12–144 磅、发光 2–24 磅的 18 组，按竖笔边缘的剖面与形状发光的剖面比对得到膨胀量，
 * 全部与本式一致；剖面的模糊与形状发光相同。不要按形状发光的半径直接换算：48 磅时 16 磅的发光宽 3 像素。
 */
function textGlowRadius(glow: Glow, size: number, scale: number): number {
  return (glow.radius / EMU_PER_PX) * scale * (size / 72) ** 0.7
}

/**
 * 文字映像的映像框底边在基线之下的距离（磅）：`dist` 不平移映像，而是把映像框（行顶到基线）向下延长
 * `dist × 字号 / 34.9`。WPS 演示实测（Arial 24 与 48 磅，`dist` 3–24 磅）：映像起点距基线为该值的两倍，渐变长度为
 * 行顶到基线的距离加该值，误差不超过 1 像素。
 */
function reflectionExtension(r: Reflection, size: number): number {
  return ((r.distance / EMU_PER_PT) * size) / 34.9
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
  // 文字方向在画布上水平向右（形状的旋转与 `eaVert` 的 90° 相抵）时按横排绘制，东亚文字不再转回。WPS 演示实测：
  // 旋转 270° 的 `eaVert` 文本框显示为横排的直立文字。
  const m = target.matrix
  const upright = layout.upright && !(Math.abs(m.b) < 1e-9 && m.a > 0)
  const { glyphs, lines, highlights, formulas } = collect(layout, faces, upright)
  const bullets = layout.paragraphs.flatMap((p) => (p.bullet === null ? [] : [p.bullet]))
  if (
    glyphs.length === 0 &&
    lines.length === 0 &&
    highlights.length === 0 &&
    bullets.length === 0 &&
    formulas.length === 0
  )
    return
  // 底纹、图片项目符号与阴影是非文字绘制，见 `TextClearType`。
  if (highlights.length > 0 || bullets.length > 0) faces.clearType?.flush()
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
  for (const b of bullets) {
    const picture = res.image(b.part)
    if (picture === null) continue
    const rect = { x: b.x, y: b.y, width: b.width, height: b.height }
    drawPicture(ctx, picture, NO_CROP, rect, target.matrix, 'high', res.metafileFonts)
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
  const glows = new Map<string, { glow: Glow; size: number; glyphs: Glyph[] }>()
  const reflections = new Map<string, { reflection: Reflection; line: LineArea; glyphs: Glyph[] }>()
  for (const g of glyphs) {
    for (const e of g.paint.style?.effects ?? []) {
      if (e.kind === 'glow') {
        const key = `${JSON.stringify(e)}\u0000${g.size}`
        const group = glows.get(key) ?? { glow: e, size: g.size, glyphs: [] }
        group.glyphs.push(g)
        glows.set(key, group)
      } else if (e.kind === 'reflection') {
        const key = `${JSON.stringify(e)}\u0000${g.line.y}\u0000${g.line.x}`
        const group = reflections.get(key) ?? { reflection: e, line: g.line, glyphs: [] }
        group.glyphs.push(g)
        reflections.set(key, group)
      }
    }
  }
  if (groups.size > 0 || glows.size > 0 || reflections.size > 0) faces.clearType?.flush()
  // 映像：逐行把带映像的字画到图层，映像框为行顶到基线（见 `reflectionExtension`），以框的底边为对称轴。
  for (const { reflection, line, glyphs: list } of reflections.values()) {
    const bounds = glyphBounds(list, target.matrix, canvas)
    if (bounds === null) continue
    const layer = drawLayer(bounds, res, (c, offset) => {
      setMatrix(c, multiply(offset, target.matrix))
      prepare(c)
      drawGlyphs(c, list, null)
    })
    if (layer === null) continue
    const size = Math.max(...list.map((g) => g.size))
    const height = line.baseline - line.y + reflectionExtension(reflection, size)
    paintReflection(
      ctx,
      layer,
      bounds,
      { ...reflection, distance: 0 },
      {
        matrix: multiply(target.matrix, translation(line.x, line.y)),
        width: line.width,
        height,
        scale: target.scale,
      },
      res,
    )
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
  for (const { glow, size, glyphs: list } of glows.values()) {
    const spread = glowSpread(textGlowRadius(glow, size, target.scale))
    const reach = glowReach(spread)
    const inner = glyphBounds(list, target.matrix, canvas)
    if (inner === null) continue
    const x0 = Math.max(0, inner.x - reach)
    const y0 = Math.max(0, inner.y - reach)
    const bounds: DeviceRect = {
      x: x0,
      y: y0,
      w: Math.min(canvas.width, inner.x + inner.w + reach) - x0,
      h: Math.min(canvas.height, inner.y + inner.h + reach) - y0,
    }
    const layer = drawLayer(bounds, res, (c, offset) => {
      setMatrix(c, multiply(offset, target.matrix))
      prepare(c)
      drawGlyphs(c, list, '#000')
    })
    if (layer !== null) paintGlow(ctx, layer, bounds, glow.color, spread, res)
  }

  ctx.save()
  setMatrix(ctx, target.matrix)
  prepare(ctx)
  drawGlyphs(
    ctx,
    glyphs,
    null,
    faces.glyphs === null
      ? null
      : {
          text: faces.glyphs,
          matrix: target.matrix,
          // 图层（阴影、三维效果、带阴影的组合）不是 `FaceCache.clearType` 的目标画布，见 `TextClearType`。
          clearType: faces.clearType?.target === ctx ? faces.clearType : null,
          canvas,
        },
  )
  ctx.restore()

  // 非纯色填充：按行与填充分组，字形作遮罩，以行为范围的填充覆盖其上。
  const fills = new Map<string, { fill: ShapeFill; area: Area; glyphs: Glyph[] }>()
  for (const g of glyphs) {
    const fill = g.paint.fill
    if (fill.kind === 'solid' || fill.kind === 'none') continue
    const key = `${JSON.stringify(fill)}\u0000${JSON.stringify(g.line)}`
    const group = fills.get(key) ?? { fill, area: g.line, glyphs: [] }
    group.glyphs.push(g)
    fills.set(key, group)
  }
  // 非纯色填充、轮廓与下划线画在文字之上，见 `TextClearType`。
  if (fills.size > 0 || lines.length > 0 || glyphs.some((g) => g.paint.style?.outline))
    faces.clearType?.flush()
  for (const { fill, area, glyphs: list } of fills.values()) {
    const bounds = glyphBounds(list, target.matrix, canvas)
    if (bounds === null) continue
    const layer = drawLayer(bounds, res, (c, offset) => {
      const m = multiply(offset, target.matrix)
      setMatrix(c, m)
      prepare(c)
      drawGlyphs(c, list, '#000')
      const cover = drawLayer(bounds, res, (f, o2) => {
        const fm = multiply(multiply(o2, target.matrix), translation(area.x, area.y))
        setMatrix(f, fm)
        const margin = Math.max(area.width, area.height, 1)
        paintFill(
          f,
          () => traceRect(f, area.width, area.height, margin),
          fill,
          { width: area.width, height: area.height, matrix: fm },
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
    placeGlyph(ctx, g, (x, y) => ctx.strokeText(g.text, x, y))
  }
  for (const l of lines) {
    ctx.fillStyle = l.color
    ctx.fillRect(l.x, l.y, l.width, l.height)
  }
  ctx.restore()
  // 公式按设备像素取整绘制（`paintFormula`），是非文字绘制，见 `TextClearType`。
  if (formulas.length > 0) faces.clearType?.flush()
  for (const f of formulas) paintFormula(ctx, f.formula, f.x, f.baseline, target.matrix)
}
