/**
 * 段落排版：把一段文字的若干字段排成带坐标的行与片段，供 Canvas 绘制。长度单位为磅。
 *
 * - 坐标原点为段落左缩进处与段落顶部，x 向右、y 向下。宽度只取自字体文件，不调用平台测量。
 * - 不处理段前段后间距与分页：调用方按 `height` 累加段落。浮动对象的环绕由调用方经 `lineArea` 按行给出可用区段。
 * - 断行为逐行贪心：超出行宽的字符先判断能否压缩标点容纳（`compressPunctuation`），再判断能否悬挂，
 *   再回退到最近的断点，没有断点时在超出处强制断开。
 * - 两端对齐的余量平均分配到可伸缩的字间：空格之后，以及任一侧字符使用东亚字体（`eastAsia`）的字间；
 *   西文字母之间不分配，行内最后一个制表符之前不分配，末行不分配。分散对齐分配到全部字间，含末行。
 *   `wordWrap` 关闭时空格是普通字符，余量分配到全部字间（末行不分配）。
 * - 汉字与基本拉丁字母或数字相邻时，在前一字之后加前一字字体平均字宽（`xAvgCharWidth`）的一半；
 *   `balanceSingleByte` 开启时改为前一字字号的四分之一。
 */

import type { FontMetrics } from '../font/metrics.ts'
import type { VerticalMetrics } from '../font/vertical.ts'
import { type BreakRules, canBreakBetween, HANGING_PUNCTUATION } from './breaking.ts'
import {
  DEFAULT_SLOT_CONTEXT,
  type FontSlot,
  fontSlot,
  isEastAsian,
  isIdeographic,
  type SlotContext,
} from './classify.ts'
import {
  type FaceExtent,
  faceExtent,
  type LineBox,
  type LineSpacing,
  lineBox,
} from './line-height.ts'
import { acceptsCompression, adjacentSqueeze, COMPRESSIBLE, OPENING } from './punctuation.ts'

export interface TextFace {
  readonly metrics: FontMetrics
  readonly vertical: VerticalMetrics
}

/**
 * 仿粗体：字体没有粗体字形、按常规字形加粗显示时，每个字形的步进增加字号的 1/256。
 * WPS 实测宋体、黑体、楷体、仿宋 9.5–30 磅的加粗步进均如此；四者 unitsPerEm 均为 256，其他 unitsPerEm 的字体未验证。
 */
export function emboldened(face: TextFace): TextFace {
  const m = face.metrics
  return {
    vertical: face.vertical,
    metrics: { ...m, advance: (codePoint, size) => m.advance(codePoint, size) + size / 256 },
  }
}

/**
 * 字段的四种字体。DrawingML 的 `latin` 同时作为 `ascii` 与 `hAnsi`。
 * `eastAsia` 为 Times New Roman 时照常使用，不改用 `ascii`（WPS 不按字体名特殊处理）。
 */
export interface RunFonts {
  readonly ascii: TextFace
  readonly hAnsi: TextFace
  readonly eastAsia: TextFace
  readonly cs: TextFace
}

export interface TextRun {
  /** `\n` 为强制换行，`\t` 为制表符。 */
  readonly text: string
  readonly fonts: RunFonts
  /** 字号（磅）。 */
  readonly size: number
  /** 缺省为 `DEFAULT_SLOT_CONTEXT`。 */
  readonly slots?: SlotContext
  /**
   * 列表编号字段，只能是第一个字段，文字为编号与后缀。`align` 为编号相对首行起点的对齐：居中与右对齐时编号向左伸出。
   * 悬挂缩进的首行中，编号后缀制表符在隐含制表位与默认制表位中取较近者；其他制表符优先取隐含制表位（WPS 实测）。
   */
  readonly numbering?: { readonly align: 'left' | 'center' | 'right' }
  /** 字符间距（磅）：加在每个字符（含空格）的步进之后，计入行宽。缺省为 0。 */
  readonly spacing?: number
  /**
   * 上标或下标：每个字符的字号按其所用字体 `OS/2` 的上下标字号缩小，换算为缇后向下取整（WPS 实测：Times New Roman
   * 12 磅的上标为 7.75 磅），步进与中西文间距按缩小后的字号计算。行高仍按原字号计算。缺省为不缩小。
   */
  readonly script?: 'superscript' | 'subscript'
  /** 基线提升（磅，向下为负）：行高的上沿加上提升量、下沿减去提升量。缺省为 0。 */
  readonly raise?: number
  /**
   * 字距调整的最小字号（磅）：字号不小于该值时与相邻的同样开启的字段之间做相邻标点压缩（见 `punctuation.ts`）。
   * 缺省或 0 为不调整。西文字偶的字距调整未实现。
   */
  readonly kern?: number
  /**
   * 字段的东亚语言（BCP 47 标签）。以 `zh` 开头或未提供时本字段的标点可以悬挂在行尾，其余（含空串）不悬挂：
   * WPS 对没有 `w:lang/@w:eastAsia` 的文字不悬挂（实测）。
   */
  readonly eastAsiaLanguage?: string
}

export type Alignment = 'left' | 'center' | 'right' | 'both' | 'distribute'

export interface TabStop {
  /** 行坐标（相对左缩进）。 */
  readonly position: number
  readonly align: 'left' | 'center' | 'right'
}

export interface ParagraphStyle extends BreakRules {
  /** 可用宽度：版心或文本框宽度减去左右缩进。 */
  readonly width: number
  /** 首行相对其余各行的缩进；负值为悬挂缩进。 */
  readonly firstLineIndent: number
  readonly align: Alignment
  readonly lineSpacing: LineSpacing
  /** 行网格的行距（`docGrid` 为 `lines` 且段落对齐网格时），`null` 为不对齐网格。 */
  readonly gridPitch: number | null
  readonly overflowPunct: boolean
  /** 汉字与西文字母之间自动加间距。 */
  readonly autoSpaceDE: boolean
  /** 汉字与数字之间自动加间距。 */
  readonly autoSpaceDN: boolean
  /** 以强制换行结束的行参与两端对齐（`doNotExpandShiftReturn` 的反义）。 */
  readonly expandLineBreak: boolean
  /** 自定义制表位，按位置升序；默认制表位只在最后一个自定义制表位之后生效。 */
  readonly tabStops: readonly TabStop[]
  /** 默认制表位间距，从行坐标 `tabOrigin` 起排列（Word 中为左缩进的相反数）。 */
  readonly defaultTabStop: number
  readonly tabOrigin: number
  /**
   * 字段所选字体没有某字符的字形时改用的字体，`null` 为按所选字体的 `.notdef` 宽度排版。
   * 不改用字段的东亚字体：东亚字体为微软雅黑时，WPS 对 Times New Roman 缺少的「★」仍按宋体的宽度排版。
   * 该字体同样没有字形时按其 `.notdef` 宽度排版：宋体与 Times New Roman 都缺少的「⑳」与 U+F0B7，WPS 均按 1 em 排版。
   */
  readonly fallback: TextFace | null
  /**
   * 段落标记的字体与字号：只决定没有字符的行（空段落、段末强制换行之后）的行高，不参与其他行。
   * WordprocessingML 中取段落标记字符属性的 `hAnsi` 字体。
   */
  readonly mark: { readonly face: TextFace; readonly size: number }
  /** 行宽不足时压缩标点（WordprocessingML 的 `characterSpacingControl`）。缺省为 `false`。 */
  readonly compressPunctuation?: boolean
  /**
   * 单字节字符与双字节字符的宽度协调（`balanceSingleByteDoubleByteWidth`）：中西文间距改为前一字字号的四分之一；
   * 一侧为东亚字符的空格、以及 `wordWrap` 关闭时的全部空格宽度为字号的一半。缺省为 `false`。
   */
  readonly balanceSingleByte?: boolean
  /** 悬挂与压缩标点只用于两端对齐与分散对齐的段落。缺省为 `false`：各种对齐都悬挂与压缩。 */
  readonly justifiedPunctuation?: boolean
  /**
   * 环绕：按行查询可用的横向区段，`top` 与 `height` 为该行的行顶与预计行高（段落坐标）。缺省为整行 `[0, width]`。
   * 一行依次填入各区段，各区段分别对齐；按实际行高再查询一次，区段变化时该行按新区段重排。
   */
  readonly lineArea?: (top: number, height: number) => LineArea
}

/** 一行的可用区段（相对左缩进），`top` 不小于查询的行顶：大于时该行下移到 `top`。 */
export interface LineArea {
  readonly top: number
  readonly segments: readonly { readonly left: number; readonly width: number }[]
}

/** `width`、`fallback` 与 `mark` 之外各项的缺省值，与 WordprocessingML 中省略相应元素时的含义一致。 */
export const PARAGRAPH_DEFAULTS: Omit<ParagraphStyle, 'width' | 'fallback' | 'mark'> = {
  firstLineIndent: 0,
  align: 'left',
  lineSpacing: { rule: 'multiple', value: 1 },
  gridPitch: null,
  kinsoku: true,
  wordWrap: true,
  overflowPunct: true,
  autoSpaceDE: true,
  autoSpaceDN: true,
  expandLineBreak: true,
  tabStops: [],
  defaultTabStop: 36,
  tabOrigin: 0,
  noLineBreakBefore: new Set(),
  noLineBreakAfter: new Set(),
}

export interface TextFragment {
  /** 字段序号。 */
  readonly run: number
  /** 字段文字中的起止位置（UTF-16 码元，不含终点）。 */
  readonly start: number
  readonly end: number
  /** 实际使用的字体：字段按码位选择的字体，缺字形时为 `fallback`。 */
  readonly face: TextFace
  /** 字号；上下标为缩小后的字号。 */
  readonly size: number
  /** 首字左端。 */
  readonly x: number
  /** 本片段的基线：行基线减去基线提升与上下标偏移。 */
  readonly baseline: number
  /** 每个码位的步进，含两端对齐与中西文间距的增量；长度等于片段的码位数。 */
  readonly advances: readonly number[]
  /** 每个码位的字形相对其占位左端的水平偏移：左侧被压缩的开启类标点为负，其余为 0。 */
  readonly offsets: readonly number[]
}

export interface TextLine {
  /** 段落文字（各字段依次相接）中的起止位置，含行尾空格、制表符与强制换行。 */
  readonly start: number
  readonly end: number
  readonly top: number
  readonly height: number
  readonly baseline: number
  /** 首字左端，含首行缩进与对齐偏移。 */
  readonly left: number
  /** 内容宽度：不含行尾空格，含对齐增量。 */
  readonly width: number
  /**
   * 对齐的范围：第一个区段中内容的起点（含首行缩进，不含对齐偏移）与区段的右端。行中的其他内容（如嵌入式对象）
   * 按对齐方式放在这一范围内；不要从 `left` 起对齐，`left` 已含对齐偏移，空行居中时 `left` 位于范围中点。
   */
  readonly origin: number
  readonly limit: number
  /** 制表符与强制换行不生成片段。 */
  readonly fragments: readonly TextFragment[]
  readonly forcedBreak: boolean
  /** 环绕使行下移的距离：计入 `height`，位于行内容之上。没有下移时省略。 */
  readonly skip?: number
}

export interface TextBlock {
  readonly lines: readonly TextLine[]
  readonly height: number
}

const TEXT = 0
const SPACE = 1
const TAB = 2
const BREAK = 3

/** 放置判定的容差：宽度由浮点累加得到，恰好排满一行时不因舍入误差移到下一行。 */
const EPSILON = 1e-6
/** 中西文间距的西文一侧：基本拉丁字母与数字。带附加符号的拉丁字母（如 `ā`）、希腊字母与汉字之间不加间距。 */
const LETTER = /[A-Za-z]/
const DIGIT = /[0-9]/

interface Unit {
  readonly run: number
  readonly offset: number
  readonly length: number
  /** 段落文字中的位置。 */
  readonly position: number
  readonly cp: number
  readonly kind: number
  readonly face: TextFace
  readonly slot: FontSlot
  /** 排版字号：上下标为缩小后的字号。 */
  readonly size: number
  /** 行高所用的字号：字段的原字号。 */
  readonly extentSize: number
  readonly raise: number
  /** 绘制时基线的上移量：基线提升加上下标偏移。 */
  readonly rise: number
  /** 字形步进，不含字符间距。 */
  readonly glyph: number
  readonly spacing: number
  readonly advance: number
  /** 字距调整开启（字号不小于字段的最小字号）。 */
  readonly kern: boolean
  readonly hanging: boolean
  readonly ideographic: boolean
  /** 中西文间距中的西文一侧：0 不是，1 字母，2 数字。 */
  readonly western: number
}

/** 上下标字号：原字号乘 `OS/2` 的上下标字号比例，换算为缇后向下取整。 */
function scriptSize(face: TextFace, size: number, script: 'superscript' | 'subscript'): number {
  const v = face.vertical
  const units = script === 'superscript' ? v.superscriptSize : v.subscriptSize
  return Math.floor((size * 20 * units) / v.unitsPerEm + EPSILON) / 20
}

/** 上下标基线的上移量：`OS/2` 的偏移按原字号换算，下标向下。只影响绘制位置，未与 WPS 的绘制结果核对。 */
function scriptRise(face: TextFace, size: number, script: 'superscript' | 'subscript'): number {
  const v = face.vertical
  const offset = script === 'superscript' ? v.superscriptOffset : -v.subscriptOffset
  return (offset * size) / v.unitsPerEm
}

function buildUnits(runs: readonly TextRun[], fallback: TextFace | null): Unit[] {
  const units: Unit[] = []
  let position = 0
  runs.forEach((r, run) => {
    const ctx = r.slots ?? DEFAULT_SLOT_CONTEXT
    const spacing = r.spacing ?? 0
    const raise = r.raise ?? 0
    const kern = (r.kern ?? 0) > 0 && r.size >= r.kern!
    const hanging = r.eastAsiaLanguage === undefined || r.eastAsiaLanguage.startsWith('zh')
    let offset = 0
    for (const ch of r.text) {
      const cp = ch.codePointAt(0)!
      const kind = cp === 0x0a ? BREAK : cp === 0x09 ? TAB : cp === 0x20 ? SPACE : TEXT
      const slot = fontSlot(cp, ctx)
      let face = r.fonts[slot]
      if (kind === TEXT && fallback && face.metrics.glyphId(cp) === 0) face = fallback
      const western = kind !== TEXT ? 0 : LETTER.test(ch) ? 1 : DIGIT.test(ch) ? 2 : 0
      const size = r.script === undefined ? r.size : scriptSize(face, r.size, r.script)
      const glyph = kind === TEXT || kind === SPACE ? face.metrics.advance(cp, size) : 0
      units.push({
        run,
        offset,
        length: ch.length,
        position: position + offset,
        cp,
        kind,
        face,
        slot,
        size,
        extentSize: r.size,
        raise,
        rise: raise + (r.script === undefined ? 0 : scriptRise(face, r.size, r.script)),
        glyph,
        spacing,
        advance: kind === TEXT || kind === SPACE ? glyph + spacing : 0,
        kern,
        hanging,
        ideographic: isIdeographic(cp),
        western,
      })
      offset += ch.length
    }
    position += r.text.length
  })
  return units
}

interface RawLine {
  start: number
  end: number
  forced: boolean
  /** 行尾标点悬挂在行宽之外。 */
  hung: boolean
  /** 首字的起点与区段的右端（行坐标）。 */
  x0: number
  limit: number
}

type Segments = LineArea['segments']

function sameArea(a: LineArea, b: LineArea): boolean {
  if (Math.abs(a.top - b.top) > EPSILON || a.segments.length !== b.segments.length) return false
  return a.segments.every(
    (g, k) =>
      Math.abs(g.left - b.segments[k]!.left) <= EPSILON &&
      Math.abs(g.width - b.segments[k]!.width) <= EPSILON,
  )
}

interface Pending {
  run: number
  start: number
  end: number
  face: TextFace
  size: number
  rise: number
  x: number
  advances: number[]
  offsets: number[]
}

export function layoutParagraph(runs: readonly TextRun[], style: ParagraphStyle): TextBlock {
  const units = buildUnits(runs, style.fallback)
  const faceIds = new Map<TextFace, number>()
  const faceIndex = (f: TextFace): number => {
    let id = faceIds.get(f)
    if (id === undefined) {
      id = faceIds.size
      faceIds.set(f, id)
    }
    return id
  }
  const n = units.length
  const balance = style.balanceSingleByte === true
  const punctuationAligned =
    style.justifiedPunctuation !== true || style.align === 'both' || style.align === 'distribute'
  const compress = style.compressPunctuation === true && punctuationAligned
  /** 字符的自然宽度：字形步进减去相邻标点压缩，加字符间距；制表符与强制换行为 0。 */
  const base = new Float64Array(n)
  /** 相邻标点压缩去掉的左侧与右侧宽度。 */
  const trimLeft = new Float64Array(n)
  const trimRight = new Float64Array(n)
  /** 压缩标点设置下还能压缩的宽度。 */
  const capacity = new Float64Array(n)
  const eastAsianAt = (j: number) => units[j] !== undefined && isEastAsian(units[j]!.cp)
  for (let k = 0; k < n; k++) {
    const u = units[k]!
    let glyph = u.glyph
    if (
      balance &&
      u.kind === SPACE &&
      (!style.wordWrap || eastAsianAt(k - 1) || eastAsianAt(k + 1))
    )
      glyph = u.size / 2
    base[k] = u.kind === TEXT || u.kind === SPACE ? glyph + u.spacing : 0
    const next = units[k + 1]
    if (next !== undefined && u.kern && next.kern) {
      const side = adjacentSqueeze(u.cp, next.cp)
      if (side === 'first') trimRight[k] = u.glyph / 2
      else if (side === 'second') trimLeft[k + 1] = next.glyph / 2
    }
  }
  for (let k = 0; k < n; k++) {
    base[k] = base[k]! - trimLeft[k]! - trimRight[k]!
    if (compress && COMPRESSIBLE.has(units[k]!.cp))
      capacity[k] = Math.max(0, units[k]!.glyph / 2 - trimLeft[k]! - trimRight[k]!)
  }
  /** 字符本身的宽度（制表符为跳到制表位的距离）。 */
  const widths = new Float64Array(n)
  /** 与同一行前一字符之间的中西文间距。 */
  const gaps = new Float64Array(n)

  const numbering = runs[0]?.numbering
  const autoSpace = (a: Unit, b: Unit): number => {
    // 编号与正文之间不加中西文间距（WPS 实测：「第一章」后紧接数字时不加）。
    if (a.ideographic === b.ideographic || (numbering !== undefined && a.run === 0 && b.run !== 0))
      return 0
    const western = a.ideographic ? b.western : a.western
    if (western === 0 || !(western === 1 ? style.autoSpaceDE : style.autoSpaceDN)) return 0
    // 前一字有字符间距时间距增加其一半（WPS 实测：间距 1 磅时宋体 12 磅汉字之后为 3.5 磅）。
    const width = balance
      ? a.size / 2
      : (a.face.vertical.averageWidth * a.size) / a.face.vertical.unitsPerEm
    return (width + a.spacing) / 2
  }

  const canBreakBefore = (i: number): boolean => {
    const a = units[i - 1]!
    const b = units[i]!
    return canBreakBetween(a.cp, b.cp, style)
  }

  /** `from` 起直到下一个制表符、强制换行或段末的自然宽度。 */
  const segmentWidth = (from: number): number => {
    let w = 0
    for (let k = from; k < n; k++) {
      const u = units[k]!
      if (u.kind === TAB || u.kind === BREAK) break
      w += base[k]! + (k > from ? autoSpace(units[k - 1]!, u) : 0)
    }
    return w
  }

  /** 编号向左伸出首行起点的距离：编号文字（不含后缀）宽度的全部或一半。 */
  let numberShift = 0
  if (numbering !== undefined && numbering.align !== 'left') {
    let w = 0
    let trailing = 0
    for (let k = 0; k < n; k++) {
      const u = units[k]!
      if (u.run !== 0 || u.kind === TAB || u.kind === BREAK) break
      w += base[k]!
      trailing = u.kind === SPACE ? trailing + base[k]! : 0
    }
    numberShift = numbering.align === 'right' ? w - trailing : (w - trailing) / 2
  }
  const firstStart = style.firstLineIndent - numberShift

  const lastCustom = style.tabStops.at(-1)?.position ?? Number.NEGATIVE_INFINITY
  const defaultStop = (x: number): TabStop => {
    const d = style.defaultTabStop
    const from = Math.max(x, lastCustom)
    const k = Math.floor((from - style.tabOrigin) / d + EPSILON) + 1
    return { position: style.tabOrigin + k * d, align: 'left' }
  }
  const tabAdvance = (x: number, i: number, firstLine: boolean): number => {
    let stop: TabStop | undefined = style.tabStops.find((t) => t.position > x + EPSILON)
    // 悬挂缩进的首行，左缩进处是一个隐含的左对齐制表位。
    if (firstLine && style.firstLineIndent < 0 && x < -EPSILON && (!stop || stop.position > 0)) {
      const listTab = numbering !== undefined && units[i]!.run === 0
      const d = listTab && !stop ? defaultStop(x) : null
      stop = d !== null && d.position < 0 ? d : { position: 0, align: 'left' }
    }
    stop ??= defaultStop(x)
    if (stop.align === 'left') return stop.position - x
    const seg = segmentWidth(i + 1)
    const target = stop.align === 'right' ? stop.position - seg : stop.position - seg / 2
    return Math.max(0, target - x)
  }

  const hangable = (i: number): boolean => {
    const u = units[i]!
    if (!style.overflowPunct || !u.hanging || !punctuationAligned) return false
    if (!HANGING_PUNCTUATION.has(u.cp)) return false
    const next = units[i + 1]
    return !next || next.kind === SPACE || next.kind === BREAK || canBreakBefore(i + 1)
  }

  /** 行首的开启类标点不压缩。 */
  const squeezable = (k: number, s: number): boolean =>
    capacity[k]! > 0 && !(k === s && OPENING.has(units[k]!.cp))

  /** 行尾标点：可压缩且可以位于行尾，行宽不足时先压缩它。 */
  const lineEnd = (k: number): boolean =>
    capacity[k]! > 0 &&
    !OPENING.has(units[k]!.cp) &&
    !(style.kinsoku && style.noLineBreakAfter.has(units[k]!.cp))

  /**
   * 压缩 `[s, i]` 中的标点能否容纳第 `i` 个字符造成的超出量。行尾标点只需容量足够，
   * 其他字符还须满足 `acceptsCompression`；`slack` 为不容纳它、在最近的断点断行时该行的剩余宽度。
   */
  const fitsByCompression = (s: number, i: number, overflow: number, slack: number): boolean => {
    let rest = overflow
    const end = lineEnd(i)
    if (end) rest -= capacity[i]!
    if (rest <= EPSILON) return true
    let total = 0
    let count = 0
    for (let k = s; k < i; k++) {
      if (!squeezable(k, s)) continue
      total += capacity[k]!
      count++
    }
    if (count === 0 || total + EPSILON < rest) return false
    return end || acceptsCompression(rest, count, slack)
  }

  /** 自 `s` 起在 `[x0, limit]` 中断出一段。 */
  const breakSegment = (s: number, x0: number, limit: number, firstLine: boolean): RawLine => {
    let i = s
    let x = x0
    let breakAt = -1
    let end = n
    let forced = false
    let hung = false
    /** 各字符之前的行宽，用于求在断点断行时的剩余宽度。 */
    const before: number[] = []
    while (i < n) {
      const u = units[i]!
      if (u.kind === BREAK) {
        gaps[i] = 0
        widths[i] = 0
        end = i + 1
        forced = true
        break
      }
      if (i > s && canBreakBefore(i)) breakAt = i
      before[i - s] = x
      const gap = i > s ? autoSpace(units[i - 1]!, u) : 0
      const w = u.kind === TAB ? tabAdvance(x + gap, i, firstLine) : base[i]!
      gaps[i] = gap
      widths[i] = w
      const overflow = x + gap + w - limit
      // `wordWrap` 开启时行尾空格越过行宽，不参与对齐。
      if (
        i === s ||
        (u.kind === SPACE && style.wordWrap) ||
        overflow <= EPSILON ||
        (compress &&
          fitsByCompression(s, i, overflow, limit - (breakAt > s ? before[breakAt - s]! : x)))
      ) {
        x += gap + w
        i++
        continue
      }
      if (hangable(i)) {
        end = i + 1
        hung = true
      } else if (breakAt > s) end = breakAt
      else end = i
      break
    }
    return { start: s, end, forced, hung, x0, limit }
  }

  /** 自 `s` 起把一行依次填入各区段；`s` 为段末时得到一个空段（空段落或段末强制换行之后的一行）。 */
  const breakRow = (s: number, firstLine: boolean, segments: Segments): RawLine[] => {
    const parts: RawLine[] = []
    let i = s
    segments.forEach((g, k) => {
      if (parts.length > 0 && (i >= n || parts[parts.length - 1]!.forced)) return
      const first = firstLine && k === 0
      const x0 = g.left + (first ? firstStart : 0)
      if (i >= n) {
        parts.push({ start: n, end: n, forced: false, hung: false, x0, limit: g.left + g.width })
        return
      }
      const part = breakSegment(i, x0, g.left + g.width, first)
      parts.push(part)
      i = part.end
    })
    return parts
  }

  const areaAt = (top: number, height: number): LineArea =>
    style.lineArea?.(top, height) ?? { top, segments: [{ left: 0, width: style.width }] }
  const boxOf = (parts: readonly RawLine[]): LineBox => {
    const extents: FaceExtent[] = []
    for (const part of parts) extents.push(...lineExtents(part))
    return lineBox(parts.length > 1 ? dedupe(extents) : extents, style.lineSpacing, style.gridPitch)
  }

  const rows: { parts: RawLine[]; top: number; skip: number; box: LineBox }[] = []
  let i = 0
  let top = 0
  let estimate = 0
  for (;;) {
    const firstLine = rows.length === 0
    let area = areaAt(top, estimate)
    let parts = breakRow(i, firstLine, area.segments)
    let box = boxOf(parts)
    if (style.lineArea !== undefined && Math.abs(box.height - estimate) > EPSILON) {
      const again = areaAt(top, box.height)
      if (!sameArea(again, area)) {
        area = again
        parts = breakRow(i, firstLine, area.segments)
        box = boxOf(parts)
      }
    }
    const skip = Math.max(0, area.top - top)
    rows.push({ parts, top, skip, box })
    const last = parts[parts.length - 1]!
    top += skip + box.height
    estimate = box.height
    i = last.end
    if (last.start === n || (i >= n && !last.forced)) break
  }

  const lines: TextLine[] = []
  rows.forEach((row, index) => {
    const lastRow = index === rows.length - 1
    const height = row.skip + row.box.height
    const baseline = row.top + row.skip + row.box.baseline
    const fragments: TextFragment[] = []
    let width = 0
    let left = 0
    row.parts.forEach((part, k) => {
      const laid = placeLine(part, lastRow && k === row.parts.length - 1)
      if (k === 0) left = laid.left
      width += laid.width
      for (const { rise, ...f } of laid.fragments)
        fragments.push({ ...f, baseline: baseline - rise })
    })
    const first = row.parts[0]!
    const last = row.parts[row.parts.length - 1]!
    const line: TextLine = {
      start: first.start < n ? units[first.start]!.position : totalLength(runs),
      end: last.end < n ? units[last.end]!.position : totalLength(runs),
      top: row.top,
      height,
      baseline,
      left,
      width,
      origin: first.x0,
      limit: first.limit,
      fragments,
      forcedBreak: last.forced,
    }
    lines.push(row.skip > 0 ? { ...line, skip: row.skip } : line)
  })
  return { lines, height: top }

  /** 多个区段的行中同一字体与字号只计一次。 */
  function dedupe(extents: FaceExtent[]): FaceExtent[] {
    return extents.filter(
      (e, k) =>
        extents.findIndex(
          (o) => o.ascent === e.ascent && o.descent === e.descent && o.single === e.single,
        ) === k,
    )
  }

  function lineExtents(line: RawLine): FaceExtent[] {
    const out: FaceExtent[] = []
    const seen = new Set<string>()
    const add = (face: TextFace, size: number, raise: number, key: string) => {
      if (seen.has(key)) return
      seen.add(key)
      const e = faceExtent(face.vertical, size)
      out.push(raise === 0 ? e : { ...e, ascent: e.ascent + raise, descent: e.descent - raise })
    }
    // 空格与强制换行不参与行高：等线的空格夹在宋体汉字之间时，WPS 按宋体一种字体计算该行行高；9 磅文字中
    // 11 磅或 20 磅字段的换行符不改变行高（WPS 实测）。行中只有空格或换行符时才按它们计算。
    for (const pass of [[TEXT, TAB], [SPACE], [BREAK]]) {
      for (let k = line.start; k < line.end; k++) {
        const u = units[k]!
        if (pass.includes(u.kind))
          add(u.face, u.extentSize, u.raise, `${faceIndex(u.face)}:${u.extentSize}:${u.raise}`)
      }
      if (out.length > 0) return out
    }
    add(style.mark.face, style.mark.size, 0, 'mark')
    return out
  }

  /**
   * 压缩标点：行尾标点先压缩，不足部分平均分配到行内其余可压缩的标点（各自不超过容量）。
   * 返回各字符的压缩量（下标相对行首）。
   */
  function squeezeLine(s: number, contentEnd: number, overflow: number): Float64Array {
    const out = new Float64Array(Math.max(0, contentEnd - s))
    let rest = overflow
    const last = contentEnd - 1
    if (last >= s && lineEnd(last)) {
      out[last - s] = Math.min(rest, capacity[last]!)
      rest -= out[last - s]!
    }
    let pool: number[] = []
    for (let k = s; k < contentEnd; k++) if (out[k - s] === 0 && squeezable(k, s)) pool.push(k)
    while (rest > EPSILON && pool.length > 0) {
      const share = rest / pool.length
      const next: number[] = []
      for (const k of pool) {
        const take = Math.min(share, capacity[k]! - out[k - s]!)
        out[k - s] = out[k - s]! + take
        rest -= take
        if (capacity[k]! - out[k - s]! > EPSILON) next.push(k)
      }
      pool = next
    }
    return out
  }

  function placeLine(line: RawLine, last: boolean) {
    const { start: s, end: e, x0 } = line
    // `wordWrap` 关闭时行尾空格占行宽，计入内容。
    let contentEnd = e
    while (
      contentEnd > s &&
      units[contentEnd - 1]!.kind !== TEXT &&
      units[contentEnd - 1]!.kind !== TAB &&
      !(units[contentEnd - 1]!.kind === SPACE && !style.wordWrap)
    ) {
      contentEnd--
    }
    const adv = new Float64Array(Math.max(0, e - s))
    for (let k = s; k < e; k++) adv[k - s] = widths[k]! + (k + 1 < e ? gaps[k + 1]! : 0)
    let natural = 0
    for (let k = s; k < contentEnd; k++) natural += adv[k - s]!

    const avail = line.limit - x0
    const squeezed =
      compress && !line.hung && natural > avail + EPSILON
        ? squeezeLine(s, contentEnd, natural - avail)
        : null
    if (squeezed !== null) {
      for (let k = s; k < contentEnd; k++) {
        adv[k - s] = adv[k - s]! - squeezed[k - s]!
        natural -= squeezed[k - s]!
      }
    }
    // 悬挂标点使内容宽于可用宽度时，居中与右对齐不向左移出行首。
    const extra = avail - natural
    const room = Math.max(0, extra)
    let shift = 0
    const justify =
      style.align === 'distribute' ||
      (style.align === 'both' && !last && (!line.forced || style.expandLineBreak))
    if (justify && extra > EPSILON) {
      let from = s
      for (let k = s; k < contentEnd; k++) if (units[k]!.kind === TAB) from = k + 1
      const slots: number[] = []
      for (let k = from; k + 1 < contentEnd; k++) {
        const a = units[k]!
        const b = units[k + 1]!
        if (
          style.align === 'distribute' ||
          !style.wordWrap ||
          a.kind === SPACE ||
          a.slot === 'eastAsia' ||
          b.slot === 'eastAsia'
        ) {
          slots.push(k)
        }
      }
      if (slots.length > 0) {
        const share = extra / slots.length
        for (const k of slots) adv[k - s] = adv[k - s]! + share
        natural = avail
      } else if (style.align === 'distribute') {
        shift = room / 2
      }
    } else if (style.align === 'right') {
      shift = room
    } else if (style.align === 'center') {
      shift = room / 2
    }

    const fragments: Pending[] = []
    let x = x0 + shift
    let current: Pending | null = null
    const flush = () => {
      if (current) fragments.push(current)
      current = null
    }
    for (let k = s; k < e; k++) {
      const u = units[k]!
      const a = adv[k - s]!
      const squeeze = squeezed !== null && k < contentEnd ? squeezed[k - s]! : 0
      // 不要写成 `-(trimLeft[k] + squeeze)`：两者为 0 时得到 -0。
      const offset = OPENING.has(u.cp) ? 0 - trimLeft[k]! - squeeze : 0
      const c = current as Pending | null
      if (u.kind === TAB || u.kind === BREAK) {
        flush()
      } else if (c && c.run === u.run && c.face === u.face) {
        c.advances.push(a)
        c.offsets.push(offset)
        c.end = u.offset + u.length
      } else {
        flush()
        current = {
          run: u.run,
          start: u.offset,
          end: u.offset + u.length,
          face: u.face,
          size: u.size,
          rise: u.rise,
          x,
          advances: [a],
          offsets: [offset],
        }
      }
      x += a
    }
    flush()
    return { left: x0 + shift, width: natural, fragments }
  }
}

function totalLength(runs: readonly TextRun[]): number {
  let n = 0
  for (const r of runs) n += r.text.length
  return n
}
