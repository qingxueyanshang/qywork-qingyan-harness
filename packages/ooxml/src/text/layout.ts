/**
 * 段落排版：把一段文字的若干字段排成带坐标的行与片段，供 Canvas 绘制。长度单位为磅。
 *
 * - 坐标原点为段落左缩进处与段落顶部，x 向右、y 向下。宽度只取自字体文件，不调用平台测量。
 * - 不处理段前段后间距与分页：调用方按 `height` 累加段落。浮动对象的环绕由调用方经 `lineArea` 按行给出可用区段。
 * - 断行为逐行贪心：超出行宽的字符连同其后不能断开的字符，先判断能否压缩标点容纳或悬挂最后一字
 *   （`compressPunctuation`，见 `fitByCompression`），不压缩标点时只判断能否悬挂，
 *   再回退到最近的断点，没有断点时在超出处强制断开。
 * - 两端对齐的余量平均分配到可伸缩的字间：空格与不换行空格（U+00A0，不是断行位置）之后，以及任一侧字符使用东亚字体
 *   （`eastAsia`）的字间（WPS 实测，构造文档 w16 nb：不换行空格与空格的伸展量相同）；
 *   西文字母之间不分配，行内最后一个制表符之前不分配，末行不分配。分散对齐分配到全部字间，含末行。
 *   `wordWrap` 关闭时空格是普通字符，余量分配到全部字间（末行不分配）。
 * - 汉字与基本拉丁字母或数字相邻时，在前一字之后加前一字字体平均字宽（`xAvgCharWidth`）的一半；
 *   `balanceSingleByte` 开启时改为前一字字号的四分之一。
 * - 行内对象（`ObjectRun`：公式的一段、嵌入式对象）是一个不可断开的单元，参与断行、对齐与行高，不生成片段
 *   （位置见 `TextLine.objects`），在段落文字中不占位置，与相邻字符之间不加中西文间距。两端对齐把对象当作不使用东亚
 *   字体的字符：对象与东亚字符之间、空格与对象之间分配余量，两个对象之间、对象与西文字符之间不分配。
 * - 行高的取法见 `lineExtent`。
 */

import type { FontMetrics } from '../font/metrics.ts'
import type { VerticalMetrics } from '../font/vertical.ts'
import {
  type BreakRules,
  type BreakUnit,
  canBreakBetween,
  canBreakForWidth,
  HANGING_PUNCTUATION,
} from './breaking.ts'
import {
  DEFAULT_SLOT_CONTEXT,
  type FontSlot,
  fontSlot,
  isEastAsian,
  isIdeographic,
  type SlotContext,
} from './classify.ts'
import {
  extentBox,
  type FaceExtent,
  faceExtent,
  type LineBox,
  type LineExtent,
  type LineSpacing,
} from './line-height.ts'
import {
  acceptsCompression,
  acceptsCompressionBelow15,
  adjacentSqueeze,
  COMPRESSIBLE,
  OPENING,
  SLOT_STRETCH,
} from './punctuation.ts'

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
   * 字距调整的最小字号（磅）：字号不小于该值时，与相邻的同样开启的字（含相邻字段中的字）之间做字距调整（见 `measure`）与
   * 相邻标点压缩（见 `punctuation.ts`）。缺省或 0 为不调整。
   */
  readonly kern?: number
  /**
   * 字段的东亚语言（BCP 47 标签）。以 `zh` 开头或未提供时本字段的标点可以悬挂在行尾，其余（含空串）不悬挂：
   * WPS 对没有 `w:lang/@w:eastAsia` 的文字不悬挂（实测）。
   */
  readonly eastAsiaLanguage?: string
}

/** 行内对象的度量与断行性质。长度单位为磅。 */
export interface InlineObject {
  /** 至下一单元起点的距离。 */
  readonly advance: number
  /** 位于行尾时计入内容宽度与对齐的宽度：`advance` 中不含其后间距的部分，判断能否排入本行也按它。 */
  readonly width: number
  /** 基线以上与以下的高度，与行内文字的上下沿分别取较大者。 */
  readonly ascent: number
  readonly descent: number
  /** 与相邻字符之间的断行按哪一类判定，见 `BreakUnit`。 */
  readonly breaks: 'ideographic' | 'western'
  /** 与前一单元之间总可断：公式中运算符之后的一段（WPS 实测：行内公式在运算符之后断开）。 */
  readonly breakBefore: boolean
  /** 由字符组成（公式）：所在行按有文字的行计算行高，不计段落标记（见 `lineExtent`）。 */
  readonly textual: boolean
}

export interface ObjectRun {
  readonly object: InlineObject
}

export type ParagraphRun = TextRun | ObjectRun

function isObject(r: ParagraphRun): r is ObjectRun {
  return 'object' in r
}

export type Alignment = 'left' | 'center' | 'right' | 'both' | 'distribute'

export interface TabStop {
  /** 行坐标（相对左缩进）。 */
  readonly position: number
  readonly align: 'left' | 'center' | 'right'
  /** 前导符：跳到本制表位的制表符以此字符填满（见 `TextLine.leaders`）。缺省为没有前导符。 */
  readonly leader?: string
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
   * 字段所选字体没有某字符的字形时改用的字体，按码位给出；`null` 为按所选字体的 `.notdef` 宽度排版。宽度与行高都按改用的
   * 字体计算。不改用字段的东亚字体：东亚字体为微软雅黑时，WPS 对 Times New Roman 缺少的「★」仍按宋体的宽度排版。
   * 该字体同样没有字形时按其 `.notdef` 宽度排版：宋体与 Times New Roman 都缺少的「⑳」与 U+F0B7，WPS 均按 1 em 排版；
   * 补充平面字符与 C0 控制字符改为 0.5 em（WPS 实测，构造文档 w10s：Times New Roman 10.5 磅字段中两种字体都缺少的「𝑥」与
   * U+001A 各占 5.25 磅）。
   */
  readonly fallback: (codePoint: number) => TextFace | null
  /**
   * 段落标记的字体与字号：计入没有文字的末行的行高，没有文字字体的行以其单倍行高为多倍行距的基数（见 `lineExtent`）。
   * WordprocessingML 中取段落标记字符属性的 `hAnsi` 字体。
   */
  readonly mark: { readonly face: TextFace; readonly size: number }
  /**
   * 单字节字符与双字节字符的宽度协调（`balanceSingleByteDoubleByteWidth`）：中西文间距改为前一字字号的四分之一；
   * 空格宽度为字号的一半，只有两侧都紧邻西文字符的单个空格保持字体宽度（WPS 实测：行首、行尾与连续的空格均为字号的一半）；
   * `wordWrap` 关闭时全部空格为字号的一半。缺省为 `false`。
   */
  readonly balanceSingleByte?: boolean
  /**
   * WordprocessingML 的兼容模式（`compatibilityMode`），决定标点规则：15 及以上时悬挂与压缩标点只用于两端对齐与分散对齐的
   * 段落，压缩按 `acceptsCompression` 判定；低于 15 或缺省（DrawingML）时各种对齐都悬挂与压缩，压缩量不超过越界字符
   * 字号的一半（`acceptsCompressionBelow15`）。
   */
  readonly compatibilityMode?: number
  /**
   * 环绕：按行查询可用的横向区段，`top` 与 `height` 为该行的行顶与预计行高（段落坐标），`final` 为该行是段落的最后一行。
   * 缺省为整行 `[0, width]`。一行依次填入各区段，各区段分别对齐；按实际行高再查询一次（最后一行同样再查询），区段变化时
   * 该行按新区段重排。
   */
  readonly lineArea?: (top: number, height: number, final: boolean) => LineArea
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
  /** 字体槽（`fontSlot`）：片段中的字属于同一槽，四种字体为同一字体时西文与东亚文字也分为不同片段。 */
  readonly slot: FontSlot
  /** 片段为一个被压缩的标点（相邻标点压缩或压缩标点使其窄于字形宽度）：这样的标点单独成为一个片段。 */
  readonly squeezed: boolean
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
  /** 内容宽度：不含行尾空格，含对齐增量；行尾的对象计 `InlineObject.width`。 */
  readonly width: number
  /**
   * 对齐的范围：第一个区段中内容的起点（含首行缩进，不含对齐偏移）与区段的右端。行中的其他内容（如嵌入式对象）
   * 按对齐方式放在这一范围内；不要从 `left` 起对齐，`left` 已含对齐偏移，空行居中时 `left` 位于范围中点。
   */
  readonly origin: number
  readonly limit: number
  /** 制表符、强制换行与行内对象不生成片段。 */
  readonly fragments: readonly TextFragment[]
  /** 行中有前导符的制表符，按出现顺序。 */
  readonly leaders: readonly LineLeader[]
  /** 行内对象，按出现顺序；对象的基线为行的基线。 */
  readonly objects: readonly LineObject[]
  readonly forcedBreak: boolean
  /** 环绕使行下移的距离：计入 `height`，位于行内容之上。没有下移时省略。 */
  readonly skip?: number
}

/** 有前导符的制表符：所占的横向范围（行坐标）、前导符字符与制表符所用的字体与字号。 */
export interface LineLeader {
  /** 字段序号。 */
  readonly run: number
  readonly x: number
  readonly width: number
  readonly char: string
  readonly face: TextFace
  readonly size: number
}

export interface LineObject {
  /** 字段序号。 */
  readonly run: number
  /** 左端（行坐标）。 */
  readonly x: number
}

export interface TextBlock {
  readonly lines: readonly TextLine[]
  readonly height: number
}

const TEXT = 0
const SPACE = 1
const TAB = 2
const BREAK = 3
const NO_BREAK_SPACE = 0xa0
const OBJECT = 4

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
  /** 行内对象为 `null`。 */
  readonly face: TextFace | null
  readonly object: InlineObject | null
  /** 行内对象为 `cs`：不按东亚字体参与两端对齐与标点压缩。 */
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

function buildUnits(runs: readonly ParagraphRun[], fallback: ParagraphStyle['fallback']): Unit[] {
  const units: Unit[] = []
  let position = 0
  runs.forEach((r, run) => {
    if (isObject(r)) {
      units.push({
        run,
        offset: 0,
        length: 0,
        position,
        // 对象没有码位：-1 不属于任何字符集合。
        cp: -1,
        kind: OBJECT,
        face: null,
        object: r.object,
        slot: 'cs',
        size: 0,
        extentSize: 0,
        raise: 0,
        rise: 0,
        glyph: r.object.advance,
        spacing: 0,
        advance: r.object.advance,
        kern: false,
        hanging: false,
        ideographic: false,
        western: 0,
      })
      return
    }
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
      if (kind === TEXT && face.metrics.glyphId(cp) === 0) face = fallback(cp) ?? face
      const western = kind !== TEXT ? 0 : LETTER.test(ch) ? 1 : DIGIT.test(ch) ? 2 : 0
      const size = r.script === undefined ? r.size : scriptSize(face, r.size, r.script)
      const half = kind === TEXT && (cp > 0xffff || cp < 0x20) && face.metrics.glyphId(cp) === 0
      const glyph =
        kind === TEXT || kind === SPACE ? (half ? size / 2 : face.metrics.advance(cp, size)) : 0
      units.push({
        run,
        offset,
        length: ch.length,
        position: position + offset,
        cp,
        kind,
        face,
        object: null,
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
  slot: FontSlot
  squeezed: boolean
  size: number
  rise: number
  x: number
  advances: number[]
  offsets: number[]
}

/** 断行与内容宽度共用的度量。 */
interface Measured {
  readonly units: readonly Unit[]
  /** 字符的自然宽度：字形步进减去相邻标点压缩，加字符间距；制表符与强制换行为 0。 */
  readonly base: Float64Array
  /** 相邻标点压缩去掉的左侧与右侧宽度。 */
  readonly trimLeft: Float64Array
  readonly trimRight: Float64Array
  /** 西文字符：非东亚的文字字符，不含空格、制表符与换行。 */
  readonly westernAt: (j: number) => boolean
  /** 两个相邻单元之间的中西文间距。 */
  readonly autoSpace: (a: Unit, b: Unit) => number
}

function measure(runs: readonly ParagraphRun[], style: ParagraphStyle): Measured {
  const units = buildUnits(runs, style.fallback)
  const n = units.length
  const balance = style.balanceSingleByte === true
  const base = new Float64Array(n)
  const trimLeft = new Float64Array(n)
  const trimRight = new Float64Array(n)
  const westernAt = (j: number) =>
    units[j] !== undefined && units[j]!.kind === TEXT && !isEastAsian(units[j]!.cp)
  for (let k = 0; k < n; k++) {
    const u = units[k]!
    let glyph = u.glyph
    if (balance && u.kind === SPACE && (!style.wordWrap || !westernAt(k - 1) || !westernAt(k + 1)))
      glyph = u.size / 2
    base[k] =
      u.kind === OBJECT ? u.advance : u.kind === TEXT || u.kind === SPACE ? glyph + u.spacing : 0
    const next = units[k + 1]
    if (next !== undefined && u.kern && next.kern && u.face === next.face)
      base[k] = base[k]! + pairKerning(u, next)
    // 两字都使用东亚字体时才压缩：无东亚提示的「“”」使用西文字体，与相邻标点之间不压缩（WPS 实测）。
    if (
      next !== undefined &&
      u.kern &&
      next.kern &&
      u.slot === 'eastAsia' &&
      next.slot === 'eastAsia'
    ) {
      const side = adjacentSqueeze(u.cp, next.cp)
      if (side === 'first') trimRight[k] = u.glyph / 2
      else if (side === 'second') trimLeft[k + 1] = next.glyph / 2
    }
  }
  for (let k = 0; k < n; k++) base[k] = base[k]! - trimLeft[k]! - trimRight[k]!

  const head = runs[0]
  const numbering = head === undefined || isObject(head) ? undefined : head.numbering
  const autoSpace = (a: Unit, b: Unit): number => {
    // 编号与正文之间不加中西文间距（WPS 实测：「第一章」后紧接数字时不加）。
    if (a.ideographic === b.ideographic || (numbering !== undefined && a.run === 0 && b.run !== 0))
      return 0
    const western = a.ideographic ? b.western : a.western
    if (western === 0 || !(western === 1 ? style.autoSpaceDE : style.autoSpaceDN)) return 0
    // 前一字有字符间距时间距增加其一半（WPS 实测：间距 1 磅时宋体 12 磅汉字之后为 3.5 磅）。
    const v = a.face!.vertical
    const width = balance ? a.size / 2 : (v.averageWidth * a.size) / v.unitsPerEm
    return (width + a.spacing) / 2
  }
  return { units, base, trimLeft, trimRight, westernAt, autoSpace }
}

/**
 * 相邻两字（文字或空格，同一字体）的字距调整：前一字的步进加字体 `kern` 表的字偶值，按字段的原字号换算。WPS 实测（构造文档
 * k1：Times New Roman 7.5 至 24 磅「AV」等字偶）：12 磅「AV」收紧 1.55 磅；上标按原字号的字偶值收紧；字符间距另加；
 * 字体不同的两字之间、任一字未开启时不调整；只有 `GPOS` 字偶的字体（Georgia、等线）不调整。
 */
function pairKerning(a: Unit, b: Unit): number {
  if ((a.kind !== TEXT && a.kind !== SPACE) || (b.kind !== TEXT && b.kind !== SPACE)) return 0
  const m = a.face!.metrics
  const units = m.kerning?.(a.cp, b.cp) ?? 0
  return units === 0 ? 0 : (units * a.extentSize) / m.unitsPerEm
}

const breakUnit = (u: Unit): BreakUnit => (u.object === null ? u.cp : u.object.breaks)

/** 单元有宽度：文字、制表符或行内对象。 */
function visible(u: Unit): boolean {
  return u.kind === TEXT || u.kind === TAB || u.kind === OBJECT
}

/** 不断行的排版宽度：大于任何段落的自然宽度。 */
const UNWRAPPED = 1e6

/**
 * 段落的最小与最大内容宽度（自动调整布局的表格列宽，WPS 实测，构造文档 w10b、w10d）。长度相对左缩进处，不含左右缩进。
 * - 最大：不断行时各行（强制换行分隔）中最宽的一行，首行自首行起点计；按左对齐计算，不计两端对齐与分散对齐的增量。
 * - 最小：最长的不可断开部分，断点见 `canBreakForWidth`；空格（`wordWrap` 开启时）、制表符与强制换行处断开，部分的宽度
 *   不含其两侧的空格。第一部分自首行起点计（首行缩进 24 磅的「汉汉汉汉」为 36 磅；悬挂缩进时第一部分左移）。
 *   行内对象两侧按其断行类别判定，与 `layoutParagraph` 相同。
 * - 没有文字、制表符与行内对象的段落返回 `null`：其宽度不计首行缩进（WPS 实测：首行缩进 24 磅的空段落与无缩进时相同）。
 */
export function contentWidths(
  runs: readonly ParagraphRun[],
  style: ParagraphStyle,
): { readonly min: number; readonly max: number } | null {
  const { units, base, autoSpace } = measure(runs, style)
  if (!units.some(visible)) return null
  const { lineArea: _, ...rest } = style
  const wide = layoutParagraph(runs, { ...rest, width: UNWRAPPED, align: 'left' })
  let max = 0
  for (const line of wide.lines) max = Math.max(max, line.origin + line.width)
  let min = 0
  /** 当前部分的起点：第一部分为首行起点，其后为 0。 */
  let offset = style.firstLineIndent
  let cur = 0
  let open = false
  const close = () => {
    if (!open) return
    min = Math.max(min, offset + cur)
    offset = 0
    cur = 0
    open = false
  }
  units.forEach((u, k) => {
    if (u.kind === BREAK || u.kind === TAB || (u.kind === SPACE && style.wordWrap)) {
      close()
      if (u.kind === BREAK) offset = 0
      return
    }
    const prev = units[k - 1]
    if (
      open &&
      prev !== undefined &&
      (u.object?.breakBefore === true || canBreakForWidth(breakUnit(prev), breakUnit(u), style))
    )
      close()
    cur += (open && prev !== undefined ? autoSpace(prev, u) : 0) + base[k]!
    open = true
  })
  close()
  return { min, max }
}

export function layoutParagraph(runs: readonly ParagraphRun[], style: ParagraphStyle): TextBlock {
  const { units, base, trimLeft, trimRight, westernAt, autoSpace } = measure(runs, style)
  const n = units.length
  const mode15 = (style.compatibilityMode ?? 0) >= 15
  const punctuationAligned = !mode15 || style.align === 'both' || style.align === 'distribute'
  const compress = style.compressPunctuation === true && punctuationAligned
  /** 压缩标点设置下还能压缩的宽度。 */
  const capacity = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const u = units[k]!
    if (compress && u.slot === 'eastAsia' && COMPRESSIBLE.has(u.cp))
      capacity[k] = Math.max(0, u.glyph / 2 - trimLeft[k]! - trimRight[k]!)
  }
  /** 字符本身的宽度（制表符为跳到制表位的距离）。 */
  const widths = new Float64Array(n)
  /** 制表符所跳到的制表位的前导符。 */
  const leaderOf: (string | undefined)[] = []
  /** 与同一行前一字符之间的中西文间距。 */
  const gaps = new Float64Array(n)

  const head = runs[0]
  const numbering = head === undefined || isObject(head) ? undefined : head.numbering

  const canBreakBefore = (i: number): boolean => {
    const b = units[i]!
    if (b.object?.breakBefore === true) return true
    return canBreakBetween(breakUnit(units[i - 1]!), breakUnit(b), style)
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
    leaderOf[i] = stop.leader
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
   * 第 `k` 个字符与前一字符之间的字间在压缩判定中的伸展量（`gaps[k]` 已写入）：中西文间距为其宽度；
   * 隔开西文字符与东亚字符的空格之后为空格字号的四分之一；其余参与两端对齐的字间见 `SLOT_STRETCH`。
   */
  const stretchBefore = (k: number): number => {
    if (gaps[k]! > 0) return gaps[k]!
    const a = units[k - 1]!
    const b = units[k]!
    if (
      a.kind === SPACE &&
      ((westernAt(k - 2) && isEastAsian(b.cp)) ||
        (units[k - 2] !== undefined && isEastAsian(units[k - 2]!.cp) && westernAt(k)))
    )
      return a.size / 4
    const slot =
      style.align === 'distribute' ||
      !style.wordWrap ||
      a.kind === SPACE ||
      a.slot === 'eastAsia' ||
      b.slot === 'eastAsia'
    return slot ? a.size * SLOT_STRETCH : 0
  }

  /**
   * 压缩标点设置下，第 `i` 个字符越过行宽时，能否连同其后不能断开的字符（到下一个断点 `e` 为止）排入本行：
   * 压缩 `[s, e)` 中的标点容纳全部超出量；或者最后一字悬挂，其余部分压缩后不超出行宽。还须满足接受条件：
   * 兼容模式 15 及以上时为 `acceptsCompression`，否则为 `acceptsCompressionBelow15`。
   * 能排入时写入这些字符的间距、宽度与行宽，返回 `e` 与是否悬挂。
   * `x` 为第 `i` 个字符之前的行宽，`breakAt` 为第 `i` 个字符及之前最近的断点，不大于 `s` 时没有断点。
   */
  const fitByCompression = (
    s: number,
    i: number,
    x: number,
    limit: number,
    breakAt: number,
    before: number[],
  ): { end: number; hung: boolean } | null => {
    let e = i + 1
    while (e < n && units[e]!.kind === TEXT && !canBreakBefore(e)) e++
    const starts: number[] = []
    let right = x
    for (let k = i; k < e; k++) {
      gaps[k] = k > s ? autoSpace(units[k - 1]!, units[k]!) : 0
      widths[k] = base[k]!
      starts.push(right)
      right += gaps[k]! + base[k]!
    }
    const last = e - 1
    const overflow = right - limit
    /** 可压缩标点的容量与中西文间距的一半之和。 */
    let all = 0
    for (let k = s; k < e; k++) {
      if (squeezable(k, s)) all += capacity[k]!
      if (k > s) all += gaps[k]! / 2
    }
    const lastCapacity = squeezable(last, s) ? capacity[last]! : 0
    const tail = last > s && !canBreakBefore(last)
    /** 最后一字悬挂时其余部分超出行宽的量。 */
    const rest = starts[last - i]! - limit
    const squeezeAll = overflow <= all + EPSILON
    // 越界字符本身可悬挂时与禁则开关无关（禁则关闭时它之前也可断行）。
    const hang = (tail || last === i) && hangable(last) && rest <= all - lastCapacity + EPSILON
    let hung: boolean
    if (!mode15) {
      // 全部压缩时按越界字符本身的超出量（减去它自身的容量）判定，悬挂时按其余部分的压缩量判定。
      const size = units[i]!.size
      const own = starts[0]! + gaps[i]! + base[i]! - limit - (squeezable(i, s) ? capacity[i]! : 0)
      if (squeezeAll && acceptsCompressionBelow15(own, size)) hung = false
      else if (hang && acceptsCompressionBelow15(rest, size)) hung = true
      else return null
    } else if (!squeezeAll && !hang) return null
    else hung = !squeezeAll
    if (mode15 && breakAt > s) {
      // 两端对齐只作用于最后一个制表符之后，伸展量同样只计其后的字间。
      let from = s
      for (let k = s; k < breakAt; k++) if (units[k]!.kind === TAB) from = k + 1
      let stretch = 0
      for (let k = from + 1; k < breakAt; k++) stretch += stretchBefore(k)
      let shrink = tail ? base[last]! : 0
      for (let k = s; k < e; k++) {
        if (k !== last || !tail) shrink += squeezable(k, s) ? capacity[k]! : 0
        if (k > s) shrink += gaps[k]! / 2
      }
      if (!acceptsCompression(overflow, shrink, limit - before[breakAt - s]!, stretch)) return null
    }
    for (let k = i; k < e; k++) before[k - s] = starts[k - i]!
    return { end: e, hung }
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
      const overflow = x + gap + (u.object === null ? w : u.object.width) - limit
      // `wordWrap` 开启时行尾空格越过行宽，不参与对齐。
      if (i === s || (u.kind === SPACE && style.wordWrap) || overflow <= EPSILON) {
        x += gap + w
        i++
        continue
      }
      if (compress && u.kind === TEXT) {
        const fit = fitByCompression(s, i, x, limit, breakAt, before)
        if (fit !== null && !fit.hung) {
          for (let k = i; k < fit.end; k++) x += gaps[k]! + widths[k]!
          i = fit.end
          continue
        }
        if (fit !== null) {
          end = fit.end
          hung = true
        } else end = breakAt > s ? breakAt : i
        break
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

  const areaAt = (top: number, height: number, final: boolean): LineArea =>
    style.lineArea?.(top, height, final) ?? { top, segments: [{ left: 0, width: style.width }] }
  const markExtent = faceExtent(style.mark.face.vertical, style.mark.size)
  /** 段落的最后一行：其后没有字符，或是段末强制换行之后的空行。 */
  const isFinal = (parts: readonly RawLine[]): boolean => {
    const last = parts[parts.length - 1]!
    return last.start === n || (last.end >= n && !last.forced)
  }
  const boxOf = (parts: readonly RawLine[]): LineBox =>
    extentBox(lineExtent(parts, isFinal(parts)), style.lineSpacing, style.gridPitch)

  const rows: { parts: RawLine[]; top: number; skip: number; box: LineBox }[] = []
  let i = 0
  let top = 0
  let estimate = 0
  for (;;) {
    const firstLine = rows.length === 0
    let area = areaAt(top, estimate, false)
    let parts = breakRow(i, firstLine, area.segments)
    let box = boxOf(parts)
    const final = isFinal(parts)
    if (style.lineArea !== undefined && (Math.abs(box.height - estimate) > EPSILON || final)) {
      const again = areaAt(top, box.height, final)
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
    const objects: LineObject[] = []
    const leaders: LineLeader[] = []
    let width = 0
    let left = 0
    row.parts.forEach((part, k) => {
      const laid = placeLine(part, lastRow && k === row.parts.length - 1)
      if (k === 0) left = laid.left
      width += laid.width
      for (const { rise, ...f } of laid.fragments)
        fragments.push({ ...f, baseline: baseline - rise })
      objects.push(...laid.objects)
      leaders.push(...laid.leaders)
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
      leaders,
      objects,
      forcedBreak: last.forced,
    }
    lines.push(row.skip > 0 ? { ...line, skip: row.skip } : line)
  })
  return { lines, height: top }

  /**
   * 一行（含各区段）的纵向范围（WPS 实测，构造文档 w9-img、w9-obj、e-mark）。
   * - 有文字的行（含只有公式的行）：上下沿取文字、制表符与对象的最大值；空格与强制换行不计（等线的空格夹在宋体汉字
   *   之间时按宋体一种字体计算，9 磅文字中 11 磅或 20 磅字段的换行符不改变行高）；段落标记不计（只含公式的末行，段落
   *   标记为 24 磅时行高不变）。多倍行距的基数为文字字体单倍行高的最大值，不计对象（10.5 磅文字与 30 磅图片同行，
   *   1.5 倍行距行高 39.85 磅）；没有文字字体时为段落标记的单倍行高。
   * - 没有文字的行：制表符、空格、强制换行中取第一类，末行另计段落标记。没有对象时按它们的上下沿；有对象时对象的
   *   上下沿照常计入，它们的单倍行高为行高的下限，不足的部分加在对象上方（末行只有 11 磅图片时行高为段落标记 Times
   *   New Roman 10.5 磅的单倍行高 12.07 磅，图片底边位于行底；只有 70 磅图片时为 70 磅；只有制表符、段落标记为 24 磅
   *   宋体时为 31.15 磅）。多倍行距的基数为它们的单倍行高，都没有时为段落标记的单倍行高。
   */
  function lineExtent(parts: readonly RawLine[], final: boolean): LineExtent {
    let textual = false
    let objects = false
    let objectAscent = 0
    let objectDescent = 0
    for (const part of parts)
      for (let k = part.start; k < part.end; k++) {
        const u = units[k]!
        if (u.kind === TEXT) textual = true
        else if (u.object !== null) {
          objects = true
          textual ||= u.object.textual
          objectAscent = Math.max(objectAscent, u.object.ascent)
          objectDescent = Math.max(objectDescent, u.object.descent)
        }
      }
    let ascent = 0
    let descent = 0
    let base = 0
    let counted = false
    const add = (e: FaceExtent, raise: number) => {
      counted = true
      ascent = Math.max(ascent, e.ascent + raise)
      descent = Math.max(descent, e.descent - raise)
      base = Math.max(base, e.single)
    }
    const pass = (kinds: readonly number[]): boolean => {
      for (const part of parts)
        for (let k = part.start; k < part.end; k++) {
          const u = units[k]!
          if (kinds.includes(u.kind)) add(faceExtent(u.face!.vertical, u.extentSize), u.raise)
        }
      return counted
    }
    if (textual) {
      pass([TEXT, TAB])
      return {
        ascent: Math.max(ascent, objectAscent),
        descent: Math.max(descent, objectDescent),
        base: counted ? base : markExtent.single,
      }
    }
    if (!pass([TAB]) && !pass([SPACE])) pass([BREAK])
    if (final) add(markExtent, 0)
    if (!counted) return { ascent: objectAscent, descent: objectDescent, base: markExtent.single }
    if (!objects) return { ascent, descent, base }
    return {
      ascent: Math.max(objectAscent, ascent + descent - objectDescent),
      descent: objectDescent,
      base,
    }
  }

  /**
   * 压缩标点：行尾标点先压缩，不足部分平均分配到行内其余可压缩的标点（各自不超过容量），
   * 仍不足时平均收缩行内的中西文间距（各自至多收缩一半，WPS 实测）。
   * 返回各字符的压缩量（下标相对行首）；间距的收缩量计在间距之前的字符上。
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
    let spaced: number[] = []
    for (let k = s + 1; k < contentEnd; k++) if (gaps[k]! > 0) spaced.push(k)
    const shrunk = new Map<number, number>()
    while (rest > EPSILON && spaced.length > 0) {
      const share = rest / spaced.length
      const next: number[] = []
      for (const k of spaced) {
        const done = shrunk.get(k) ?? 0
        const take = Math.min(share, gaps[k]! / 2 - done)
        shrunk.set(k, done + take)
        out[k - 1 - s] = out[k - 1 - s]! + take
        rest -= take
        if (gaps[k]! / 2 - done - take > EPSILON) next.push(k)
      }
      spaced = next
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
      units[contentEnd - 1]!.kind !== OBJECT &&
      !(units[contentEnd - 1]!.kind === SPACE && !style.wordWrap)
    ) {
      contentEnd--
    }
    const adv = new Float64Array(Math.max(0, e - s))
    for (let k = s; k < e; k++) adv[k - s] = widths[k]! + (k + 1 < e ? gaps[k + 1]! : 0)
    let natural = 0
    for (let k = s; k < contentEnd; k++) natural += adv[k - s]!
    const tail = contentEnd > s ? units[contentEnd - 1]!.object : null
    if (tail !== null) natural += tail.width - widths[contentEnd - 1]!

    const avail = line.limit - x0
    // 悬挂的最后一字不压缩，其余部分超出可用宽度时压缩。
    const squeezeEnd = line.hung ? contentEnd - 1 : contentEnd
    const fitted = line.hung ? natural - adv[squeezeEnd - s]! : natural
    const squeezed =
      compress && fitted > avail + EPSILON ? squeezeLine(s, squeezeEnd, fitted - avail) : null
    if (squeezed !== null) {
      for (let k = s; k < squeezeEnd; k++) {
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
          a.cp === NO_BREAK_SPACE ||
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
    const objects: LineObject[] = []
    const leaders: LineLeader[] = []
    let x = x0 + shift
    let current: Pending | null = null
    const flush = () => {
      if (current) fragments.push(current)
      current = null
    }
    for (let k = s; k < e; k++) {
      const u = units[k]!
      const a = adv[k - s]!
      const squeeze = squeezed !== null && k < squeezeEnd ? squeezed[k - s]! : 0
      // 不要写成 `-(trimLeft[k] + squeeze)`：两者为 0 时得到 -0。
      const offset = OPENING.has(u.cp) ? 0 - trimLeft[k]! - squeeze : 0
      const tight =
        COMPRESSIBLE.has(u.cp) && (squeeze > EPSILON || trimLeft[k]! > 0 || trimRight[k]! > 0)
      const c = current as Pending | null
      if (u.kind === OBJECT) {
        flush()
        objects.push({ run: u.run, x })
      } else if (u.kind === TAB || u.kind === BREAK) {
        flush()
        const char = u.kind === TAB ? leaderOf[k] : undefined
        if (char !== undefined)
          leaders.push({ run: u.run, x, width: widths[k]!, char, face: u.face!, size: u.size })
      } else if (
        c &&
        c.run === u.run &&
        c.face === u.face &&
        c.slot === u.slot &&
        !c.squeezed &&
        !tight
      ) {
        c.advances.push(a)
        c.offsets.push(offset)
        c.end = u.offset + u.length
      } else {
        flush()
        current = {
          run: u.run,
          start: u.offset,
          end: u.offset + u.length,
          face: u.face!,
          slot: u.slot,
          squeezed: tight,
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
    return { left: x0 + shift, width: natural, fragments, objects, leaders }
  }
}

function totalLength(runs: readonly ParagraphRun[]): number {
  let n = 0
  for (const r of runs) if (!isObject(r)) n += r.text.length
  return n
}
