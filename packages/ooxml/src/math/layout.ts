/**
 * 公式排版：把公式树排成带坐标的字形、横线与轮廓字形，单位为磅，原点为公式左端的基线，y 向下。
 *
 * 规则以 OpenType `MATH` 表为准（常量、变体、斜体校正），以下各项按 WPS 12.1 屏幕显示（页面 EMF 与逐字坐标）实测：
 * - 上下标字号：原字号乘 `scriptPercentScaleDown`（二级乘 `scriptScriptPercentScaleDown`），按半磅向下取整。
 * - 上标只在根号内按紧缩移位（见 `Style.cramped`）；没有映射为数学字母的拉丁字符与东亚提示的希腊、西里尔字母按字段字体排版
 *   （见 `mathGlyphId`）。
 * - 显示公式中分数的分子分母不缩小字号，嵌套的分数按非显示参数移位；行内公式中分子分母缩小一级。
 * - 底式为结构时上下标按底式高度下降，为字段时只按其中按文字字体单倍行高排版的字符下降（见 `scripts`）；上下标同时存在且间隙小于 `subSuperscriptGapMin` 时，
 *   不足部分由上标上移与下标下移各分一半；上标不加斜体校正。
 * - 原子间距按左右原子的类别查表，数值为经验拟合（见 `THIN` 等常量）；分数为内部原子，n 元运算符（连同被积式）为大型运算符
 *   原子，两者与普通原子之间均加细间距。
 * - 重音字形取不宽于底式宽度的最宽变体，墨迹居中于底式宽度的中点；底式高于 `flattenedAccentBaseHeight` 时取扁平形式。
 * - 行内的 n 元运算符取原字形、不按轴居中，上下限按上下标放置。
 * - 括号与根号由 WPS 以字形轮廓绘制（`outline` 项），线性分数的斜线以画笔绘制（`slash` 项），其余字形为文字（`glyph` 项）。
 *   显示公式中根号的间隙见 `RADICAL_DISPLAY_GAP`；上下极限内容的横向偏移见 `hlist`。
 * - 括号的变体选择与同种括号嵌套见 `fence`；普通文字的上下沿见 `MathRunStyle.textFace`，行上下沿见 `MathLayout.lineAscent`。
 * - 结构自身字形（分数线、求和号、括号、根号）与移位常量的字号取结构的字符属性（见 `inherit`），不取参数中字段的字号。
 * - 同一段落中的多个 `m:oMath` 接成一个横向排列：相邻原子按类别加间距，与在同一个 `m:oMath` 中相同。
 * - 显示公式的断行与对齐见 `layoutMathParagraph`，行内公式的分段见 `layoutMath`。
 *
 * 遇到未实现的结构时返回 `unsupported`，不给出部分结果。
 */

import type { GlyphOutlines } from '../font/index.ts'
import { faceExtent, isEastAsian, type TextFace } from '../text/index.ts'
import { type AtomClass, atomClass, mathLetter } from './chars.ts'
import type {
  MathAccent,
  MathArg,
  MathBar,
  MathDelimiter,
  MathEquationArray,
  MathFraction,
  MathFunction,
  MathJustification,
  MathLimit,
  MathNary,
  MathNode,
  MathParagraph,
  MathRadical,
  MathRun,
  MathScripts,
  MathSettings,
  MathUnsupported,
  MathZone,
} from './model.ts'
import type { GlyphConstruction, MathConstantName, MathFont, MathTable } from './table.ts'

/** 一个字段（或结构）的字符属性解释结果。 */
export interface MathRunStyle<F> {
  /** 字号（磅），未经上下标缩小。 */
  readonly size: number
  readonly color: string
  readonly bold: boolean
  readonly italic: boolean
  /**
   * 不按数学字体排版的字符（见 `mathGlyphId`）所用的字体。字符的上下沿（上下标移位、行高与线性分数的斜线共用）见 `textExtent`；
   * `outlines` 为该字体的字形轮廓，字体没有 TrueType 轮廓时为 `null`，改取 `hhea` 的上下沿。`eastAsia` 为该字符按字段的
   * 字体选择规则落在东亚字体（WordprocessingML 的 `w:eastAsia`）。
   */
  textFace(codePoint: number): {
    readonly face: TextFace
    readonly font: F
    readonly outlines: GlyphOutlines | null
    readonly eastAsia: boolean
  }
}

export interface MathEnvironment<P, F> {
  readonly font: MathFont<F>
  /** `null` 为字段没有字符属性：取段落或文本框的缺省字符属性。 */
  style(props: P | null): MathRunStyle<F>
  readonly settings: MathSettings
}

export interface MathGlyph<F> {
  readonly kind: 'glyph'
  readonly x: number
  /** 基线。 */
  readonly y: number
  readonly size: number
  readonly glyph: number
  /** 可按文字绘制的字符；没有码位的变体字形为 `null`，按轮廓绘制。 */
  readonly text: string | null
  readonly font: F
  readonly color: string
  /** 普通文字的粗体、斜体（字体没有该字形时由绘制端合成）。数学字体的字形为 `false`。 */
  readonly bold: boolean
  readonly italic: boolean
}

/** 按字形轮廓填充的符号（括号、根号）：原点为字形原点，`size` 为字号。 */
export interface MathOutline<F> {
  readonly kind: 'outline'
  readonly x: number
  readonly y: number
  readonly size: number
  readonly glyph: number
  readonly font: F
  readonly color: string
}

/** 分数线：自 `x0` 至 `x1`、以 `y` 为中线、粗 `thickness` 的线，两端各延伸半个线宽（GDI 方头画笔）。 */
export interface MathRule {
  readonly kind: 'rule'
  readonly x0: number
  readonly x1: number
  readonly y: number
  readonly thickness: number
  readonly color: string
}

/** 填充矩形（上横线、下横线、根号横线）。 */
export interface MathRect {
  readonly kind: 'rect'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color: string
}

/** 线性分数的斜线：自左下端 (`x0`, `y0`) 至右上端 (`x1`, `y1`)、粗 `thickness` 的线（GDI 方头画笔）。 */
export interface MathSlash {
  readonly kind: 'slash'
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  readonly thickness: number
  readonly color: string
}

export type MathItem<F> = MathGlyph<F> | MathOutline<F> | MathRule | MathRect | MathSlash

export interface MathLayout<F> {
  readonly width: number
  /** 墨迹上沿在基线以上的距离。 */
  readonly ascent: number
  /** 墨迹下沿在基线以下的距离。 */
  readonly descent: number
  /**
   * 公式所在行的上沿与下沿（基线以上、以下的距离），调用方与行内文字的上下沿分别取较大者。WPS 实测（10.5 至 24 磅）：
   * 上沿取首个字符的字体上沿与内容上沿加 `MATH` 的 `mathLeading`（按首个字符的字号换算）中的较大者，下沿取该字体下沿与
   * 内容下沿中的较大者；只含公式的段落（显示公式）的行高即为两者之和，不计段落标记的行高。字体的上下沿为其单倍行高的
   * 上下沿（`faceExtent`）。内容的上下沿由各字符的上下沿（见 `MathRunStyle.textFace`）与结构排版得到，首个字符以外的字符的
   * 字体不计入。
   */
  readonly lineAscent: number
  readonly lineDescent: number
  readonly items: readonly MathItem<F>[]
}

/** 行内公式的一段：`width` 为本段内容的宽度，`advance` 为至下一段起点的距离（含运算符后的间距，在行尾时不占位置）。 */
export interface MathSegment<F> extends MathLayout<F> {
  readonly advance: number
}

export type MathResult<F> =
  | ({ readonly kind: 'layout'; readonly segments: readonly MathSegment<F>[] } & MathLayout<F>)
  | { readonly kind: 'unsupported'; readonly names: readonly string[] }

/** 显示公式的一行：`x` 为行左端相对可用宽度左端的距离（磅）。 */
export interface MathLine<F> extends MathLayout<F> {
  readonly x: number
}

export type MathParagraphResult<F> =
  | { readonly kind: 'layout'; readonly lines: readonly MathLine<F>[] }
  | { readonly kind: 'unsupported'; readonly names: readonly string[] }

/** 字号层级：0 为原字号，1 为上下标，2 为二级上下标。 */
type Level = 0 | 1 | 2

interface Style {
  /** 按显示公式的参数排版（分数移位、根号间隙、n 元运算符变体）。只有显示公式的最外层为真。 */
  readonly display: boolean
  readonly level: Level
  /**
   * 上标按 `superscriptShiftUpCramped` 上移。只有根号内为真：WPS 实测（12 至 48 磅）分母、下标、重音与上横线的底式、
   * n 元运算符下限与下极限中的上标均按 `superscriptShiftUp`。
   */
  readonly cramped: boolean
  /** 二元运算符、关系符与标点前后不加间距（同上下标层级）：WPS 实测线性分数的分子分母中如此。 */
  readonly tight: boolean
}

/** 公式首个字符的字体上下沿（行上下沿的下限）与 `mathLeading`，单位为磅。 */
interface Extent {
  readonly ascent: number
  readonly descent: number
  readonly leading: number
}

/** 首个节点为结构时按此西文字符选取其字符属性中的字体（`MathRunStyle.textFace` 的参数）。 */
const LATIN = 0x78

/** 断行位置：本行内容止于 `end`，下一行自 `start` 起；两者之间为运算符一侧的间距，断行后不显示。 */
interface Break {
  readonly end: number
  readonly start: number
  readonly relation: boolean
}

/** 一个原子的横向范围与墨迹上下沿：断行后每行的上下沿取与该行相交的原子。 */
interface Span {
  readonly x0: number
  readonly x1: number
  readonly height: number
  readonly depth: number
}

interface Box<F> {
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly items: readonly MathItem<F>[]
  /** 单个字形时的斜体校正。 */
  readonly italic: number
  readonly cls: AtomClass
  /** 可断行的位置：只有横向排列（`hlist`）及包含它的单项括号、n 元运算符带有，其余结构不可在内部断行。 */
  readonly breaks?: readonly Break[]
  /** `hlist` 的各原子。 */
  readonly spans?: readonly Span[]
  /** 括号：左括号字符与其盒子所取变体的序号（见 `fence`）。 */
  readonly fence?: { readonly char: string; readonly level: number }
  /** `hlist` 中各括号原子的 `fence`。 */
  readonly fences?: readonly { readonly char: string; readonly level: number }[]
  /**
   * 作上下标的底式时计算下降所用的上下沿（见 `scripts`）：括号与重音的内容恰为一个结构时取内容的，括号的内容为字段时取其
   * `text`，否则为 `null`（不下降）；其余结构没有该项，取盒子本身的。
   */
  readonly core?: { readonly height: number; readonly depth: number } | null
  /**
   * 按文字字体单倍行高排版的字符（见 `textExtent`）的上下沿：字段中这类字符的最大值，横向排列取其中各字段的最大值，
   * 结构不带该项。作上下标的底式时按其下降（见 `scripts`）。
   */
  readonly text?: { readonly height: number; readonly depth: number }
  /** 上下极限（`m:limLow`、`m:limUpp`）：在横向排列中内容右移，见 `hlist`。 */
  readonly limit?: boolean
}

/** 去掉断行位置：内容不可在内部断行的结构（`m:box`、方程组）。 */
function sealed<F>(b: Box<F>, cls: AtomClass): Box<F> {
  return { width: b.width, height: b.height, depth: b.depth, items: b.items, italic: b.italic, cls }
}

/** 可作断行处的原子：二元运算符与关系符，其另一侧须为运算对象（不是运算符、标点或括号）。 */
const OPERATORS = new Set<AtomClass>(['bin', 'rel'])
const NOT_OPERAND = new Set<AtomClass>(['bin', 'rel', 'open', 'close', 'punct'])

class Unsupported extends Error {
  constructor(readonly names: string[]) {
    super(`未实现的公式结构：${names.join('、')}`)
  }
}

const EMPTY_BOX: Box<never> = { width: 0, height: 0, depth: 0, items: [], italic: 0, cls: 'ord' }

/**
 * 数学字体中没有字形的全角形式（U+FF00 至 U+FFEF）定界符：左侧按「(」、右侧按「)」的字形绘制。WPS 实测（Cambria Math，
 * 10.5 磅）：「（」「）」「［」「］」「｛」「｝」「｜」与半角圆括号的字形、伸展与宽度相同；「〈」「《」「「」「【」等
 * 不在该区的括号不按此绘制。
 */
function fenceSubstitute(ch: string, side: 'open' | 'close' | 'separator'): string | null {
  const cp = ch.codePointAt(0)!
  if (side === 'separator' || cp < 0xff00 || cp > 0xffef) return null
  return side === 'open' ? '(' : ')'
}

/** 原子间距（em），经验拟合：WPS 逐字横坐标在 12 至 96 磅下的结果。 */
const THIN = 0.17
const MEDIUM = 0.2255
const THICK = 0.2803
/** 函数名与自变量之间（em），经验拟合。 */
const FUNCTION_SPACE = 0.1646
/** 重音墨迹下沿与底字墨迹上沿的间隙（em），经验拟合。 */
const ACCENT_GAP = 0.08
/** n 元运算符下限墨迹上沿与运算符墨迹下沿的间隙（em），经验拟合；不取 `lowerLimitBaselineDropMin`。 */
const LOWER_LIMIT_GAP = 0.146
/**
 * 显示公式中根号的最小间隙（em，按根号字号），变体选择与字形纵向居中共用；不取 `radicalDisplayStyleVerticalGap`（0.168 em）。
 * 经验拟合：WPS 24 至 72 磅的页面 EMF 中根号字形与横线比按 0.168 em 排版低约 0.02 em，行高相应减小；根号字号 10.5 磅、
 * 内容 12 至 25 磅的 41 例所取变体与 WPS 一致（按 0.168 em 为 35 例）。
 */
const RADICAL_DISPLAY_GAP = 0.127
/**
 * 括号伸展：取高度不小于内容（按轴对称）高度此倍数的第一个变体（经验拟合：圆括号与方括号在 12 至 48 磅下，
 * 倍数落在 0.8155 与 0.8239 之间）。同种括号嵌套与基本字形的规则见 `fence`。
 */
const FENCE_FACTOR = 0.82
/** n 元运算符 `grow`：取高度不小于被积式（按轴对称）高度此倍数的变体（经验拟合，两例在 0.834 与 0.992 之间）。 */
const GROW_FACTOR = 0.9
/**
 * 分子或分母恰为一个分数时，该分数两侧各留的空白（em，按其字号），分数线不延伸到空白中：WPS 实测外层分数线
 * 比内层分数宽 0.09 至 0.125 em（12 与 24 磅，经验拟合）。分子分母中分数与其他原子并列时不留。
 */
const NESTED_FRACTION_PAD = 0.11
/** 显示公式的 n 元运算符：取高度不小于原字形此倍数的第一个变体（WPS 实测 ∑∏∫∬ 均取第三个变体，倍数在 1.25 与 1.99 之间）。 */
const DISPLAY_OPERATOR_FACTOR = 1.5
/**
 * 线性分数（em，按分数字号）：分子前进宽度末端至分母起点的距离、斜线的横向跨度与线宽。经验拟合：WPS 10.5 至 48 磅
 * 的逐字横坐标与页面 EMF 折线，距离在 0.573 与 0.581 之间，跨度在 0.40 与 0.45 之间（端点取整到像素），线宽在 0.0700 与
 * 0.0719 之间（EMF 画笔宽度取整到缇）。斜线居中于该距离。
 */
const LINEAR_GAP = 0.577
/**
 * 显示公式断行时关系符优先的条件：断开后本行宽度不小于可用宽度的此倍数。经验拟合：WPS 实测 18% 及以上的行在关系符处
 * 断开，12% 与 1.5% 的行不断开（12 与 24 磅）。
 */
const RELATION_BREAK_MIN = 0.15
const LINEAR_SPAN = 0.429
const LINEAR_RULE = 0.0715

const CLASSES: readonly AtomClass[] = ['ord', 'op', 'bin', 'rel', 'open', 'close', 'punct', 'inner']
/**
 * 原子间距表：行为左侧原子、列为右侧原子，顺序同 `CLASSES`。数字 1 为 `THIN`，小写 a、b、c 为 `THIN`、`MEDIUM`、`THICK`
 * 但只在原字号层级（不在上下标中）加，0 为不加。二元运算符一列与一行按 WPS 实测：关系符与其后的二元运算符之间不加，
 * 标点、左括号与其后的二元运算符之间加 `MEDIUM`（标点自身之后的间距不再加）。
 */
const SPACING = [
  '01bc000a',
  '11bc000a',
  'bb00b00b',
  'cc00c00c',
  '00b00000',
  '01bc000a',
  'aabaaaaa',
  'a1bca0aa',
]

function spaceBetween(left: AtomClass, right: AtomClass, style: Style): number {
  const code = SPACING[CLASSES.indexOf(left)]![CLASSES.indexOf(right)]!
  const full = style.level === 0 && !style.tight
  switch (code) {
    case '1':
      return THIN
    case 'a':
      return full ? THIN : 0
    case 'b':
      return full ? MEDIUM : 0
    case 'c':
      return full ? THICK : 0
    default:
      return 0
  }
}

function shift<F>(items: readonly MathItem<F>[], dx: number, dy: number): MathItem<F>[] {
  if (dx === 0 && dy === 0) return [...items]
  return items.map((it) => {
    if (it.kind === 'rule') return { ...it, x0: it.x0 + dx, x1: it.x1 + dx, y: it.y + dy }
    if (it.kind === 'slash')
      return { ...it, x0: it.x0 + dx, x1: it.x1 + dx, y0: it.y0 + dy, y1: it.y1 + dy }
    return { ...it, x: it.x + dx, y: it.y + dy }
  })
}

function scriptStyle(s: Style): Style {
  return { ...s, display: false, level: Math.min(2, s.level + 1) as Level }
}

function cramp(s: Style): Style {
  return { ...s, cramped: true }
}

/** 积分类运算符：上下限的缺省位置取 `intLim`。 */
const INTEGRALS = new Set(['∫', '∬', '∭', '∮', '∯', '∰'])

/** 结构的各参数，按 OMML 中的元素顺序。 */
function argsOf<P>(n: Exclude<MathNode<P>, MathRun<P> | MathUnsupported>): readonly MathArg<P>[] {
  switch (n.kind) {
    case 'f':
      return [n.num, n.den]
    case 'sSup':
      return [n.base, n.sup]
    case 'sSub':
      return [n.base, n.sub]
    case 'sSubSup':
      return [n.base, n.sub, n.sup]
    case 'rad':
      return [n.degree, n.base]
    case 'nary':
      return [n.sub, n.sup, n.base]
    case 'd':
      return n.items
    case 'eqArr':
      return n.rows
    case 'func':
      return [n.name, n.base]
    case 'limLow':
    case 'limUpp':
      return [n.base, n.limit]
    case 'acc':
    case 'bar':
    case 'box':
      return [n.base]
  }
}

/**
 * 各结构的字符属性记入 `out`：`ctrlPr`，没有时取文档顺序中前一个字段的字符属性，公式开头为缺省字符属性（`null`）。
 * WPS 实测（缺省 10.5 磅、字段 11 至 24 磅）：没有 `ctrlPr` 的分数在公式开头时分数线、移位与行高按 10.5 磅，
 * 跟在 24 磅的字段之后时按 24 磅。返回最后一个字段的字符属性。
 */
function inherit<P>(nodes: MathArg<P>, prev: P | null, out: Map<MathNode<P>, P | null>): P | null {
  let last = prev
  for (const n of nodes) {
    if (n.kind === 'run') last = n.props
    else if (n.kind !== 'unsupported') {
      out.set(n, n.props ?? last)
      for (const a of argsOf(n)) last = inherit(a, last, out)
    }
  }
  return last
}

class Engine<P, F> {
  private readonly table: MathTable
  private readonly upem: number
  /** 各结构的字符属性（见 `inherit`），由 `line` 写入。 */
  private readonly control = new Map<MathNode<P>, P | null>()

  constructor(
    readonly env: MathEnvironment<P, F>,
    /** 显示公式中分数的分子分母不缩小字号（WPS 实测），行内公式中缩小一级。 */
    private readonly displayFormula: boolean,
    /** 断行时运算符移到下一行行首（`before`）还是留在本行行尾（`after`）。 */
    private readonly breakAt: 'before' | 'after',
  ) {
    this.table = env.font.table
    this.upem = env.font.outlines.unitsPerEm
  }

  /** 层级下的字号：原字号乘 `MATH` 的缩小百分比，按半磅向下取整（WPS 实测 8 至 72 磅）。 */
  size(base: number, level: Level): number {
    if (level === 0) return base
    const c = this.table.constants
    const pct = level === 1 ? c.scriptPercentScaleDown : c.scriptScriptPercentScaleDown
    return Math.floor((base * pct * 2) / 100 + 1e-9) / 2
  }

  k(name: MathConstantName, size: number): number {
    return (this.table.constants[name] * size) / this.upem
  }

  units(v: number, size: number): number {
    return (v * size) / this.upem
  }

  /** 字符属性在当前层级下的字号。 */
  private sizeOf(props: P | null, style: Style): number {
    return this.size(this.env.style(props).size, style.level)
  }

  /** 结构的字符属性（见 `inherit`），决定结构自身字形（求和号、括号、分数线）的字号与颜色。 */
  private own(n: MathNode<P>): P | null {
    return this.control.get(n) ?? null
  }

  private color(n: MathNode<P>): string {
    return this.env.style(this.own(n)).color
  }

  /** 段落中的各 `m:oMath` 接成一个横向排列（WPS 实测，相邻原子按类别加间距）。 */
  line(zones: readonly MathZone<P>[]): { box: Box<F>; base: Extent } {
    const nodes = zones.flatMap((z) => z.nodes)
    inherit(nodes, null, this.control)
    const style: Style = { display: this.displayFormula, level: 0, cramped: false, tight: false }
    return { box: this.list(nodes, style), base: this.base(nodes) }
  }

  /**
   * 首个字符的字体在其字号下的上下沿与 `mathLeading`（见 `MathLayout.lineAscent`）。首个节点为字段时取其第一个字符：
   * 按数学字体排版的字符（见 `mathGlyphId`）取数学字体，其余字符取其文字字体；为结构时取结构的字符属性（见 `inherit`），
   * 字体按西文字符选取。WPS 实测（10.5 至 24 磅）：首个字段为 Times New Roman 的普通文字时行高为其单倍行高，其后的数学字体字符不使行高增加到
   * 数学字体的上下沿；`ctrlPr` 为 Times New Roman 或没有 `ctrlPr` 的结构在前时同样如此。
   */
  private base(nodes: MathArg<P>): Extent {
    const first = nodes[0]
    const props = first === undefined ? null : first.kind === 'run' ? first.props : this.own(first)
    let cp = LATIN
    let math = false
    if (first?.kind === 'run' && first.text !== '') {
      cp = first.text.codePointAt(0)!
      math = this.mathGlyphId(first, cp) !== 0
    }
    const st = this.env.style(props)
    const v = math ? this.env.font.face.vertical : st.textFace(cp).face.vertical
    const e = faceExtent(v, st.size)
    return { ascent: e.ascent, descent: e.descent, leading: this.k('mathLeading', st.size) }
  }

  /** 排版结果与行上下沿（见 `MathLayout.lineAscent`）。 */
  layout(
    width: number,
    height: number,
    depth: number,
    items: readonly MathItem<F>[],
    base: Extent,
  ): MathLayout<F> {
    return {
      width,
      ascent: height,
      descent: depth,
      lineAscent: Math.max(base.ascent, height + base.leading),
      lineDescent: Math.max(base.descent, depth),
      items,
    }
  }

  /**
   * 自 `start` 至 `end` 的一段：原点落在 [`start`, `next`) 中的项平移到以 `start` 为原点；上下沿取与 [`start`, `end`]
   * 相交的原子（断在括号或 n 元运算符内部时为其内部的原子，括号两侧的字形各计入所在的行）。
   */
  slice(box: Box<F>, start: number, end: number, next: number, base: Extent): MathLayout<F> {
    const eps = 1e-6
    const items = box.items.filter((it) => {
      const x = it.kind === 'rule' || it.kind === 'slash' ? it.x0 : it.x
      return x >= start - eps && x < next - eps
    })
    let height = 0
    let depth = 0
    for (const p of box.spans ?? []) {
      if (p.x1 < start + eps || p.x0 > end - eps) continue
      height = Math.max(height, p.height)
      depth = Math.max(depth, p.depth)
    }
    return this.layout(end - start, height, depth, shift(items, -start, 0), base)
  }

  /** 一个参数：逐个原子排列并按类别加间距，间距按参数中第一个字段的字号。 */
  private list(nodes: MathArg<P>, style: Style): Box<F> {
    const atoms: Box<F>[] = []
    for (const n of nodes) {
      if (n.kind === 'run') atoms.push(...this.run(n, style))
      else atoms.push(this.node(n, style))
    }
    return this.hlist(atoms, style, this.sizeOf(firstRun(nodes)?.props ?? null, style))
  }

  /**
   * 横向排列。参数开头或末尾的二元运算符按普通字符处理（一元运算符）；跟在关系符、标点、左括号之后的二元运算符
   * 仍按二元运算符计间距（WPS 实测，间距见 `SPACING`）。`em` 为间距所用的字号。
   * 上下极限的内容右移其前后两处间距之和的四分之一，宽度与其后原子的位置不变；标点之后的间距不计入。WPS 实测（24 与 48 磅，
   * 前后为二元运算符、关系符、分数、标点、普通字符与公式两端）：偏移在 1 像素以内。
   */
  private hlist(atoms: readonly Box<F>[], style: Style, em: number): Box<F> {
    if (atoms.length === 0) return EMPTY_BOX
    const classes = atoms.map((a) => a.cls)
    if (classes[0] === 'bin') classes[0] = 'ord'
    if (classes[classes.length - 1] === 'bin') classes[classes.length - 1] = 'ord'
    const gaps = classes.map((c, i) => (i === 0 ? 0 : spaceBetween(classes[i - 1]!, c, style) * em))
    const items: MathItem<F>[] = []
    const breaks: Break[] = []
    const spans: Span[] = []
    const fences = atoms.flatMap((a) => (a.fence ? [a.fence] : []))
    let x = 0
    let height = 0
    let depth = 0
    /** `Box.text` 的上下沿；没有这类字符时 `textHeight` 为 -1。 */
    let textHeight = -1
    let textDepth = 0
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i]!
      if (a.text !== undefined) {
        textHeight = Math.max(textHeight, a.text.height)
        textDepth = Math.max(textDepth, a.text.depth)
      }
      if (i > 0) {
        const gap = gaps[i]!
        const [op, other] =
          this.breakAt === 'before'
            ? [classes[i]!, classes[i - 1]!]
            : [classes[i - 1]!, classes[i]!]
        if (OPERATORS.has(op) && !NOT_OPERAND.has(other))
          breaks.push({
            end: x,
            start: x + gap,
            relation: op === 'rel',
          })
        x += gap
      }
      const lift = a.limit
        ? ((classes[i - 1] === 'punct' ? 0 : gaps[i]!) + (gaps[i + 1] ?? 0)) / 4
        : 0
      items.push(...shift(a.items, x + lift, 0))
      for (const b of a.breaks ?? []) breaks.push({ ...b, end: b.end + x, start: b.start + x })
      // 可在内部断行的原子（括号、n 元运算符）记其内部的各原子，断行后每行只计与之相交的部分。
      if (a.breaks?.length && a.spans)
        for (const q of a.spans) spans.push({ ...q, x0: q.x0 + x, x1: q.x1 + x })
      else spans.push({ x0: x, x1: x + a.width, height: a.height, depth: a.depth })
      x += a.width
      height = Math.max(height, a.height)
      depth = Math.max(depth, a.depth)
    }
    const only = atoms.length === 1 ? atoms[0]! : null
    return {
      width: x,
      height,
      depth,
      items,
      italic: only?.italic ?? 0,
      cls: only?.cls ?? 'ord',
      breaks,
      spans,
      fences,
      ...(only?.core !== undefined ? { core: only.core } : {}),
      ...(textHeight < 0 ? {} : { text: { height: textHeight, depth: textDepth } }),
    }
  }

  private node(n: Exclude<MathNode<P>, MathRun<P>>, style: Style): Box<F> {
    switch (n.kind) {
      case 'f':
        return this.fraction(n, style)
      case 'sSup':
      case 'sSub':
      case 'sSubSup':
        return this.scripts(n, style)
      case 'rad':
        return this.radical(n, style)
      case 'nary':
        return this.nary(n, style)
      case 'd':
        return this.delimiter(n, style)
      case 'eqArr':
        return this.equationArray(n, style)
      case 'func':
        return this.func(n, style)
      case 'acc':
        return this.accent(n, style)
      case 'bar':
        return this.bar(n, style)
      case 'box':
        return sealed(this.list(n.base, style), 'ord')
      case 'limLow':
      case 'limUpp':
        return this.limit(n, style)
      case 'unsupported':
        throw new Unsupported([n.name])
    }
  }

  /**
   * 字符在数学字体中的字形编号（按 `m:sty`、`m:scr` 映射为数学字母后）；按字段字体排版的字符为 0：普通文字、数学字体缺字的字符，
   * 以及没有映射为数学字母的 ASCII 字符与 Latin-1 字母（`plainLatin`）、落在东亚字体中的希腊与西里尔字母（`eastAsianText`）。
   * WPS 实测（24 磅，字段字体为 Times New Roman、Arial、Calibri、宋体、缺失字体与未指定）：`m:sty="p"` 的字母、数字、`=`、`+`、
   * `(` 与 `é`，以及 `m:sty` 缺省或为 `i` 时的数字、`=`、`+`、`(` 按字段字体绘制，行高取该字体；`m:sty` 为 `b` 时的数字、缺省时的
   * 字母（映射为数学字母）与 `α`、`∑`、`·`、`×` 取数学字体。
   */
  private mathGlyphId(r: MathRun<P>, cp: number): number {
    if (r.normal) return 0
    const mapped = mathLetter(cp, r.style, r.script)
    if (mapped === cp && (plainLatin(cp) || this.eastAsianText(r.props, cp))) return 0
    return this.env.font.face.metrics.glyphId(mapped)
  }

  /** 字符为希腊或西里尔字母且按字段的字体选择规则落在东亚字体中（见 `eastAsianLetter`）。 */
  private eastAsianText(props: P | null, cp: number): boolean {
    return eastAsianLetter(cp) && this.env.style(props).textFace(cp).eastAsia
  }

  /** 字段：每个字符一个原子。不按数学字体排版的字符（见 `mathGlyphId`）按字符属性的字体排版，上下沿见 `textExtent`。 */
  private run(r: MathRun<P>, style: Style): Box<F>[] {
    const st = this.env.style(r.props)
    const size = this.size(st.size, style.level)
    const out: Box<F>[] = []
    for (const ch of r.text) {
      const cp = ch.codePointAt(0)!
      const gid = this.mathGlyphId(r, cp)
      const cls: AtomClass = r.normal || r.literal ? 'ord' : atomClass(cp)
      if (gid !== 0) {
        const text = String.fromCodePoint(mathLetter(cp, r.style, r.script))
        out.push(this.mathGlyph(gid, text, size, st.color, cls))
        continue
      }
      const t = st.textFace(cp)
      const glyph = t.face.metrics.glyphId(cp)
      const lineExtent = isEastAsian(cp) || (t.eastAsia && eastAsianLetter(cp))
      const { height, depth } = this.textExtent(lineExtent, t.face, t.outlines, glyph, size)
      out.push({
        width: t.face.metrics.advance(cp, size),
        height,
        depth,
        ...(lineExtent ? { text: { height, depth } } : {}),
        items: [
          {
            kind: 'glyph',
            x: 0,
            y: 0,
            size,
            glyph,
            text: ch,
            font: t.font,
            color: st.color,
            bold: r.normal && st.bold,
            italic: r.normal && st.italic,
          },
        ],
        italic: 0,
        cls,
      })
    }
    return out
  }

  /**
   * 按文字字体排版的字符的上下沿：`line` 为真的字符（东亚字符与落在东亚字体中的希腊、西里尔字母）取该字体的单倍行高上下沿，
   * 其余字符取字形墨迹，字体没有轮廓时取 `hhea` 的上下沿。WPS 实测（10.5 至 24 磅，宋体、黑体、微软雅黑）：含全角括号或汉字的
   * 显示公式行高为该字体单倍行高加 `mathLeading`，汉字作下标时的移位按该字体的上沿；同一字体中的西文字符不使行高增加。
   */
  private textExtent(
    line: boolean,
    face: TextFace,
    outlines: GlyphOutlines | null,
    glyph: number,
    size: number,
  ): { height: number; depth: number } {
    if (line) {
      const e = faceExtent(face.vertical, size)
      return { height: e.ascent, depth: e.descent }
    }
    if (outlines === null) {
      const v = face.vertical
      return {
        height: (v.hheaAscender * size) / v.unitsPerEm,
        depth: (-v.hheaDescender * size) / v.unitsPerEm,
      }
    }
    const b = outlines.bounds(glyph)
    const em = size / outlines.unitsPerEm
    return {
      height: b === null ? 0 : Math.max(0, b.yMax) * em,
      depth: b === null ? 0 : Math.max(0, -b.yMin) * em,
    }
  }

  /** 数学字体中的单个字形；`text` 为 `null` 时按轮廓绘制。 */
  private mathGlyph(
    gid: number,
    text: string | null,
    size: number,
    color: string,
    cls: AtomClass,
  ): Box<F> {
    const o = this.env.font.outlines
    const b = o.bounds(gid)
    // 墨迹整体位于基线以上的字形（如减号、撇号）深度为 0，不取负值。
    return {
      width: this.units(o.advance(gid), size),
      height: b === null ? 0 : this.units(Math.max(0, b.yMax), size),
      depth: b === null ? 0 : this.units(Math.max(0, -b.yMin), size),
      items: [
        {
          kind: 'glyph',
          x: 0,
          y: 0,
          size,
          glyph: gid,
          text,
          font: this.env.font.font,
          color,
          bold: false,
          italic: false,
        },
      ],
      italic: this.units(this.table.italicCorrection(gid), size),
      cls,
    }
  }

  /** 字符在数学字体中的字形编号；没有时为 0。 */
  private glyphOf(ch: string): number {
    return this.env.font.face.metrics.glyphId(ch.codePointAt(0)!)
  }

  private fraction(n: MathFraction<P>, style: Style): Box<F> {
    if (n.type === 'skw') throw new Unsupported(['f/skw'])
    if (n.type === 'lin') return this.linear(n, style)
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    const display = style.display && !this.env.settings.smallFraction
    const inner: Style = {
      ...style,
      display: false,
      level: this.displayFormula ? style.level : (Math.min(2, style.level + 1) as Level),
    }
    const num = this.padded(n.num, this.list(n.num, inner), inner)
    const den = this.padded(n.den, this.list(n.den, inner), inner)
    const axis = this.k('axisHeight', size)
    // 无分数线的分数与有分数线的分数移位相同（WPS 实测），不取 `stack*` 常量。
    let up: number
    let down: number
    {
      const t = this.k('fractionRuleThickness', size)
      up = this.k(
        display ? 'fractionNumeratorDisplayStyleShiftUp' : 'fractionNumeratorShiftUp',
        size,
      )
      down = this.k(
        display ? 'fractionDenominatorDisplayStyleShiftDown' : 'fractionDenominatorShiftDown',
        size,
      )
      const numGap = this.k(
        display ? 'fractionNumDisplayStyleGapMin' : 'fractionNumeratorGapMin',
        size,
      )
      const denGap = this.k(
        display ? 'fractionDenomDisplayStyleGapMin' : 'fractionDenominatorGapMin',
        size,
      )
      if (up - num.depth - (axis + t / 2) < numGap) up = numGap + axis + t / 2 + num.depth
      if (axis - t / 2 - (den.height - down) < denGap) down = denGap - axis + t / 2 + den.height
    }
    const width = Math.max(num.width, den.width)
    const items: MathItem<F>[] = [
      ...shift(num.items, (width - num.width) / 2, -up),
      ...shift(den.items, (width - den.width) / 2, down),
    ]
    if (n.type === 'bar') {
      items.push({
        kind: 'rule',
        x0: 0,
        x1: width,
        y: -axis,
        thickness: this.k('fractionRuleThickness', size),
        color,
      })
    }
    return {
      width,
      height: up + num.height,
      depth: down + den.depth,
      items,
      italic: 0,
      cls: 'inner',
    }
  }

  /**
   * 线性分数：分子与分母按所在位置的字号排在同一基线上，中间隔 `LINEAR_GAP`；斜线自分子分母墨迹下沿（左端）至墨迹上沿
   * （右端），WPS 实测斜线不是字形，斜率随内容高度变化。分子分母中的运算符不加间距、其中的分数按非显示参数移位（WPS 实测）。
   */
  private linear(n: MathFraction<P>, style: Style): Box<F> {
    const size = this.sizeOf(this.own(n), style)
    const inner: Style = { ...style, display: false, tight: true }
    const num = this.list(n.num, inner)
    const den = this.list(n.den, inner)
    const gap = LINEAR_GAP * size
    const mid = num.width + gap / 2
    const half = (LINEAR_SPAN * size) / 2
    const height = Math.max(num.height, den.height)
    const depth = Math.max(num.depth, den.depth)
    const t = LINEAR_RULE * size
    return {
      width: num.width + gap + den.width,
      height: height + t / 2,
      depth: depth + t / 2,
      items: [
        ...num.items,
        {
          kind: 'slash',
          x0: mid - half,
          y0: depth,
          x1: mid + half,
          y1: -height,
          thickness: t,
          color: this.color(n),
        },
        ...shift(den.items, num.width + gap, 0),
      ],
      italic: 0,
      cls: 'inner',
    }
  }

  /** 分子或分母恰为一个分数时两侧留空白（`NESTED_FRACTION_PAD`）。 */
  private padded(arg: MathArg<P>, box: Box<F>, style: Style): Box<F> {
    const only = arg.length === 1 ? arg[0]! : null
    if (only === null || only.kind !== 'f') return box
    const pad = NESTED_FRACTION_PAD * this.sizeOf(this.own(only), style)
    return { ...box, width: box.width + 2 * pad, items: shift(box.items, pad, 0) }
  }

  /** 上下标的移位：上标不低于 `superscriptShiftUp`，下标不高于 `subscriptShiftDown`；`drop` 为底式下降所用的上下沿（见 `scripts`）。 */
  private scriptShifts(
    sup: Box<F> | null,
    sub: Box<F> | null,
    size: number,
    style: Style,
    drop: { height: number; depth: number } | null,
  ): { up: number; down: number } {
    let up = 0
    let down = 0
    if (sup !== null)
      up = Math.max(
        this.k(style.cramped ? 'superscriptShiftUpCramped' : 'superscriptShiftUp', size),
        drop === null ? 0 : drop.height - this.k('superscriptBaselineDropMax', size),
        sup.depth + this.k('superscriptBottomMin', size),
      )
    if (sub !== null)
      down = Math.max(
        this.k('subscriptShiftDown', size),
        drop === null ? 0 : drop.depth + this.k('subscriptBaselineDropMin', size),
        sup === null ? sub.height - this.k('subscriptTopMax', size) : 0,
      )
    if (sup !== null && sub !== null) {
      const gap = up - sup.depth - (sub.height - down)
      const min = this.k('subSuperscriptGapMin', size)
      if (gap < min) {
        up += (min - gap) / 2
        down += (min - gap) / 2
      }
    }
    return { up, down }
  }

  /**
   * 上下标。底式恰为一个结构（不是字段）时移位按底式的上下沿下降（`superscriptBaselineDropMax`、
   * `subscriptBaselineDropMin`）；括号与重音只在其内容恰为一个结构时下降，按内容的上下沿；底式为字段时只按其中按文字字体
   * 单倍行高排版的字符（`Box.text`）下降，西文字符不下降。
   * WPS 实测（10.5 至 24 磅）：分数、根号、上横线、括住分数的括号作底式时上下标随之移位，括住字段的括号（x 与 a+b）、
   * 字母上的重音、多字字段不移位；10.5 与 12 磅的「汉」「（1+i）」与括住「汉」的括号作底式时，上标按宋体单倍行高的上沿、
   * 下标按其下沿下降（10.5 磅时上标移位 8.25 磅、下标 4.5 磅，误差为 1 像素）。
   */
  private scripts(n: MathScripts<P>, style: Style): Box<F> {
    const base = this.list(n.base, style)
    const size = this.sizeOf(this.own(n), style)
    const s = scriptStyle(style)
    const sup = n.kind === 'sSub' ? null : this.list(n.sup, s)
    const sub = n.kind === 'sSup' ? null : this.list(n.sub, s)
    const drop = single(n.base) ? (base.core === undefined ? base : base.core) : (base.text ?? null)
    const { up, down } = this.scriptShifts(sup, sub, size, style, drop)
    const x = base.width
    const items: MathItem<F>[] = [...base.items]
    let width = x
    let height = base.height
    let depth = base.depth
    if (sup !== null) {
      items.push(...shift(sup.items, x, -up))
      width = Math.max(width, x + sup.width)
      height = Math.max(height, up + sup.height)
    }
    if (sub !== null) {
      items.push(...shift(sub.items, x, down))
      width = Math.max(width, x + sub.width)
      depth = Math.max(depth, down + sub.depth)
    }
    return {
      width: width + this.k('spaceAfterScript', size),
      height,
      depth,
      items,
      italic: 0,
      cls: base.cls,
    }
  }

  /** 纵向伸展：变体中第一个不小于 `target`（磅）的；都不够时取最大的变体，有拼装时不支持（拼装未实现）。 */
  private stretch(gid: number, target: number, size: number): number {
    const c: GlyphConstruction | null = this.table.vertical(gid)
    if (c === null || c.variants.length === 0) return gid
    const t = (target * this.upem) / size
    for (const v of c.variants) if (v.advance >= t) return v.glyph
    if (c.assembly !== null) throw new Unsupported(['assembly'])
    return c.variants[c.variants.length - 1]!.glyph
  }

  /** 原字形在伸展方向上的尺寸（磅）：变体表第一项的尺寸，没有变体表时为墨迹高度。 */
  private naturalHeight(gid: number, size: number): number {
    const first = this.table.vertical(gid)?.variants[0]
    if (first !== undefined) return this.units(first.advance, size)
    const b = this.env.font.outlines.bounds(gid)
    return b === null ? 0 : this.units(b.yMax - b.yMin, size)
  }

  /** 按轴对称覆盖盒的高度（磅）。 */
  private symmetricHeight(box: Box<F>, size: number): number {
    const axis = this.k('axisHeight', size)
    return 2 * Math.max(box.height - axis, box.depth + axis)
  }

  private radical(n: MathRadical<P>, style: Style): Box<F> {
    const base = this.list(n.base, cramp(style))
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    const t = this.k('radicalRuleThickness', size)
    let gap = style.display ? RADICAL_DISPLAY_GAP * size : this.k('radicalVerticalGap', size)
    const gid = this.stretch(this.glyphOf('√'), base.height + base.depth + gap + t, size)
    const o = this.env.font.outlines
    const b = o.bounds(gid)
    if (b === null) throw new Unsupported(['rad/glyph'])
    const gh = this.units(b.yMax, size)
    const gd = this.units(-b.yMin, size)
    const excess = gh + gd - t - (base.height + base.depth + gap)
    if (excess > 0) gap += excess / 2
    const top = base.height + gap + t
    const rise = top - gh
    const sign = this.units(o.advance(gid), size)
    const items: MathItem<F>[] = []
    let x = 0
    let height = top + this.k('radicalExtraAscender', size)
    if (!n.hideDegree && n.degree.length > 0) {
      const deg = this.list(n.degree, { ...style, display: false, level: 2, cramped: false })
      const before = this.k('radicalKernBeforeDegree', size)
      const after = this.k('radicalKernAfterDegree', size)
      const bottom =
        (this.table.constants.radicalDegreeBottomRaisePercent / 100) * (gh + gd) - gd + rise
      items.push(...shift(deg.items, before, -(bottom + deg.depth)))
      x = Math.max(0, before + deg.width + after)
      height = Math.max(height, bottom + deg.depth + deg.height)
    }
    items.push({ kind: 'outline', x, y: -rise, size, glyph: gid, font: this.env.font.font, color })
    // 横线自根号字形顶部的右端向右延伸到被开方式末端；与字形重叠的部分不影响填充结果。
    const barLeft = x + Math.min(sign, this.units(b.xMax, size)) - t
    items.push({
      kind: 'rect',
      x: barLeft,
      y: -top,
      width: x + sign + base.width - barLeft,
      height: t,
      color,
    })
    items.push(...shift(base.items, x + sign, 0))
    return {
      width: x + sign + base.width,
      height,
      depth: Math.max(base.depth, gd - rise),
      items,
      italic: 0,
      cls: 'ord',
    }
  }

  private nary(n: MathNary<P>, style: Style): Box<F> {
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    const limits =
      n.limits ??
      (INTEGRALS.has(n.char) ? this.env.settings.integralLimits : this.env.settings.naryLimits)
    const body = this.list(n.base, style)
    let op: Box<F> = EMPTY_BOX
    let kern = 0
    if (n.char !== '') {
      const base = this.glyphOf(n.char)
      if (base === 0) throw new Unsupported(['nary/chr'])
      let target = style.display ? DISPLAY_OPERATOR_FACTOR * this.naturalHeight(base, size) : 0
      if (n.grow) target = Math.max(target, GROW_FACTOR * this.symmetricHeight(body, size))
      const gid = target > 0 ? this.stretch(base, target, size) : base
      op = this.mathGlyph(gid, gid === base ? n.char : null, size, color, 'op')
      // 下标左移量取原字形的斜体校正：WPS 实测显示积分号的变体同样按原字形左移。
      kern = this.units(this.table.italicCorrection(base), size)
    }
    const s = scriptStyle(style)
    const sup = n.hideSup ? null : this.list(n.sup, s)
    const sub = n.hideSub ? null : this.list(n.sub, s)
    const head =
      limits === 'undOvr' && style.display
        ? this.limits(op, sup, sub, size)
        : this.attach(op, sup, sub, size, style, kern)
    // 整体为大型运算符原子：WPS 实测与两侧的普通字符之间各加细间距。
    return { ...this.hlist([head, body], style, size), cls: 'op' }
  }

  /** 上下限位于运算符正上方与正下方，居中对齐。 */
  private limits(op: Box<F>, sup: Box<F> | null, sub: Box<F> | null, size: number): Box<F> {
    const width = Math.max(op.width, sup?.width ?? 0, sub?.width ?? 0)
    const items: MathItem<F>[] = [...shift(op.items, (width - op.width) / 2, 0)]
    let height = op.height
    let depth = op.depth
    if (sup !== null) {
      const rise =
        op.height +
        Math.max(
          this.k('upperLimitGapMin', size) + sup.depth,
          this.k('upperLimitBaselineRiseMin', size),
        )
      items.push(...shift(sup.items, (width - sup.width) / 2 + op.italic / 2, -rise))
      height = rise + sup.height
    }
    if (sub !== null) {
      const drop = op.depth + LOWER_LIMIT_GAP * size + sub.height
      items.push(...shift(sub.items, (width - sub.width) / 2 - op.italic / 2, drop))
      depth = drop + sub.depth
    }
    return { width, height, depth, items, italic: 0, cls: 'op' }
  }

  /** 上下限按上下标放在运算符右侧：上限不加斜体校正，下限左移 `kern`；移位按运算符高度下降。 */
  private attach(
    op: Box<F>,
    sup: Box<F> | null,
    sub: Box<F> | null,
    size: number,
    style: Style,
    kern: number,
  ): Box<F> {
    const { up, down } = this.scriptShifts(sup, sub, size, style, op)
    const items: MathItem<F>[] = [...op.items]
    let width = op.width
    let height = op.height
    let depth = op.depth
    if (sup !== null) {
      items.push(...shift(sup.items, op.width, -up))
      width = Math.max(width, op.width + sup.width)
      height = Math.max(height, up + sup.height)
    }
    if (sub !== null) {
      items.push(...shift(sub.items, op.width - kern, down))
      width = Math.max(width, op.width - kern + sub.width)
      depth = Math.max(depth, down + sub.depth)
    }
    return { width, height, depth, items, italic: 0, cls: 'op' }
  }

  /**
   * 按轴居中的括号字形；`grow` 时按内容伸展，且变体序号大于 `above`（内容中同种括号的序号，没有时为 -1）。
   * WPS 实测（12 与 24 磅）：
   * - 同种括号套同种括号时外层取更大的变体，不同种的不受影响；
   * - 取基本字形而内容墨迹上沿高出字形时，绘制基本字形，括号的盒子（上下沿与外层括号所见的序号）取下一个变体。
   */
  private fence(
    ch: string,
    side: 'open' | 'close' | 'separator',
    height: number,
    depth: number,
    size: number,
    color: string,
    grow: boolean,
    above: number,
  ): Box<F> {
    if (ch === '') return EMPTY_BOX
    const substitute = fenceSubstitute(ch, side)
    const base = this.glyphOf(ch) || (substitute === null ? 0 : this.glyphOf(substitute))
    if (base === 0) throw new Unsupported([`d/${ch}`])
    const axis = this.k('axisHeight', size)
    const variants = grow ? (this.table.vertical(base)?.variants ?? []) : []
    let level = 0
    if (variants.length > 0) {
      const target = (FENCE_FACTOR * 2 * Math.max(height - axis, depth + axis) * this.upem) / size
      level = variants.findIndex((v, i) => i > above && v.advance >= target)
      if (level < 0) {
        if (this.table.vertical(base)?.assembly) throw new Unsupported(['assembly'])
        level = variants.length - 1
      }
    }
    const gid = variants[level]?.glyph ?? base
    const o = this.env.font.outlines
    const b = o.bounds(gid)
    if (b === null) throw new Unsupported([`d/${ch}`])
    const gh = this.units(b.yMax, size)
    const gd = this.units(-b.yMin, size)
    const rise = axis - (gh - gd) / 2
    let top = gh + rise
    let bottom = gd - rise
    if (level === 0 && variants.length > 1 && height > top) {
      const half = this.units(variants[1]!.advance, size) / 2
      top = axis + half
      bottom = half - axis
      level = 1
    }
    return {
      width: this.units(o.advance(gid), size),
      height: top,
      depth: bottom,
      items: [
        { kind: 'outline', x: 0, y: -rise, size, glyph: gid, font: this.env.font.font, color },
      ],
      italic: 0,
      cls: 'ord',
      fence: { char: ch, level },
    }
  }

  private delimiter(n: MathDelimiter<P>, style: Style): Box<F> {
    if (n.shape === 'match') throw new Unsupported(['d/shp'])
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    const parts = n.items.map((it) => this.list(it, style))
    const height = Math.max(0, ...parts.map((p) => p.height))
    const depth = Math.max(0, ...parts.map((p) => p.depth))
    const above = Math.max(
      -1,
      ...parts.flatMap((p) =>
        (p.fences ?? []).filter((f) => f.char === n.open).map((f) => f.level),
      ),
    )
    const fence = (ch: string, side: 'open' | 'close' | 'separator') =>
      this.fence(ch, side, height, depth, size, color, n.grow, above)
    const left = fence(n.open, 'open')
    const seq: Box<F>[] = [left]
    parts.forEach((p, i) => {
      if (i > 0) seq.push(fence(n.separator, 'separator'))
      seq.push(p)
    })
    seq.push(fence(n.close, 'close'))
    // 只有一项时括号整体取内容的类别（WPS 实测相邻的两个括住分数的括号之间加细间距，括住字母的不加），且可在括号内断行。
    const only = parts.length === 1 ? parts[0]! : null
    const open = seq[0]!.width
    const right = seq[seq.length - 1]!
    const row = this.row(seq)
    const span = (b: Box<F>, x0: number): Span => ({
      x0,
      x1: x0 + b.width,
      height: b.height,
      depth: b.depth,
    })
    return {
      ...row,
      cls: only?.cls ?? 'ord',
      breaks: (only?.breaks ?? []).map((b) => ({ ...b, end: b.end + open, start: b.start + open })),
      spans: [
        span(left, 0),
        ...(only?.spans ?? []).map((q) => ({ ...q, x0: q.x0 + open, x1: q.x1 + open })),
        span(right, row.width - right.width),
      ],
      ...(left.fence ? { fence: left.fence } : {}),
      core: n.items.length === 1 && single(n.items[0]!) ? { height, depth } : (only?.text ?? null),
    }
  }

  /** 无间距的横向拼接。 */
  private row(boxes: readonly Box<F>[]): Box<F> {
    const items: MathItem<F>[] = []
    let x = 0
    let height = 0
    let depth = 0
    for (const b of boxes) {
      items.push(...shift(b.items, x, 0))
      x += b.width
      height = Math.max(height, b.height)
      depth = Math.max(depth, b.depth)
    }
    return { width: x, height, depth, items, italic: 0, cls: 'ord' }
  }

  private equationArray(n: MathEquationArray<P>, style: Style): Box<F> {
    if (n.rows.length !== 1) throw new Unsupported(['eqArr/rows'])
    return sealed(this.list(n.rows[0]!, style), 'ord')
  }

  private func(n: MathFunction<P>, style: Style): Box<F> {
    const name = this.list(n.name, style)
    const body = this.list(n.base, style)
    const size = this.sizeOf(this.own(n), style)
    const gap = { ...EMPTY_BOX, width: FUNCTION_SPACE * size }
    return { ...this.row([name, gap, body]), cls: 'ord' }
  }

  /**
   * 重音：取不宽于底式宽度的最宽横向变体，墨迹中心对齐底式宽度的中点（WPS 实测，不取上方重音附着点）；底式高于
   * `flattenedAccentBaseHeight` 时取该变体的扁平形式。WPS 实测（Cambria Math 12 与 24 磅，页面 EMF 字形编号）：y、p、ℎ 取
   * 第一个变体，V、A 取第二个，Δπ、xyz 与 x² 取第三个；ℎ、V、A、Δπ、x² 为扁平形式。不要按底式的墨迹宽度选取：x² 的墨迹
   * 窄于第三个变体。
   */
  private accent(n: MathAccent<P>, style: Style): Box<F> {
    const base = this.list(n.base, style)
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    const gid0 = this.glyphOf(n.char)
    if (gid0 === 0) throw new Unsupported(['acc/chr'])
    let gid = gid0
    const c = this.table.horizontal(gid0)
    if (c !== null)
      for (const v of c.variants) if (this.units(v.advance, size) <= base.width) gid = v.glyph
    if (base.height > this.k('flattenedAccentBaseHeight', size))
      gid = this.env.font.flattenedAccent(gid)
    const b = this.env.font.outlines.bounds(gid)
    if (b === null) throw new Unsupported(['acc/glyph'])
    const rise = base.height + ACCENT_GAP * size - this.units(b.yMin, size)
    const x = base.width / 2 - this.units((b.xMin + b.xMax) / 2, size)
    const accent: MathGlyph<F> = {
      kind: 'glyph',
      x,
      y: -rise,
      size,
      glyph: gid,
      text: gid === gid0 ? n.char : null,
      font: this.env.font.font,
      color,
      bold: false,
      italic: false,
    }
    return {
      width: base.width,
      height: Math.max(base.height, rise + this.units(b.yMax, size)),
      depth: base.depth,
      items: [...base.items, accent],
      italic: base.italic,
      cls: 'ord',
      core: single(n.base) ? { height: base.height, depth: base.depth } : null,
    }
  }

  private bar(n: MathBar<P>, style: Style): Box<F> {
    const top = n.position === 'top'
    const base = this.list(n.base, style)
    const size = this.sizeOf(this.own(n), style)
    const color = this.color(n)
    if (top) {
      const t = this.k('overbarRuleThickness', size)
      const y = base.height + this.k('overbarVerticalGap', size)
      return {
        width: base.width,
        height: y + t + this.k('overbarExtraAscender', size),
        depth: base.depth,
        items: [
          ...base.items,
          { kind: 'rect', x: 0, y: -(y + t), width: base.width, height: t, color },
        ],
        italic: 0,
        cls: 'ord',
      }
    }
    const t = this.k('underbarRuleThickness', size)
    const y = base.depth + this.k('underbarVerticalGap', size)
    return {
      width: base.width,
      height: base.height,
      depth: y + t + this.k('underbarExtraDescender', size),
      items: [...base.items, { kind: 'rect', x: 0, y, width: base.width, height: t, color }],
      italic: 0,
      cls: 'ord',
    }
  }

  /** 上下极限：极限按上下标层级居中放在底式正下方（或正上方）；整体为普通原子（WPS 实测其后不加间距）。 */
  private limit(n: MathLimit<P>, style: Style): Box<F> {
    const base = this.list(n.base, style)
    const size = this.sizeOf(this.own(n), style)
    const s = scriptStyle(style)
    const lim = this.list(n.limit, s)
    const width = Math.max(base.width, lim.width)
    const items: MathItem<F>[] = [...shift(base.items, (width - base.width) / 2, 0)]
    if (n.kind === 'limLow') {
      const drop =
        base.depth +
        Math.max(
          this.k('lowerLimitGapMin', size) + lim.height,
          this.k('lowerLimitBaselineDropMin', size),
        )
      items.push(...shift(lim.items, (width - lim.width) / 2, drop))
      return {
        width,
        height: base.height,
        depth: drop + lim.depth,
        items,
        italic: 0,
        cls: 'ord',
        limit: true,
      }
    }
    const rise =
      base.height +
      Math.max(
        this.k('upperLimitGapMin', size) + lim.depth,
        this.k('upperLimitBaselineRiseMin', size),
      )
    items.push(...shift(lim.items, (width - lim.width) / 2, -rise))
    return {
      width,
      height: rise + lim.height,
      depth: base.depth,
      items,
      italic: 0,
      cls: 'ord',
      limit: true,
    }
  }
}

/** ASCII 字符与 Latin-1 补充中的字母（U+00C0–U+00FF，不含 `×`、`÷`）。 */
function plainLatin(cp: number): boolean {
  return cp < 0x80 || (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7)
}

/**
 * 希腊字母与西里尔字母（U+0370–U+04FF）：落在东亚字体中时按该字体绘制、取其单倍行高上下沿。WPS 实测（构造文档 24 磅显示公式与
 * 10 磅行内公式，东亚字体为宋体、微软雅黑、等线，西文字体为 Times New Roman、Arial）：东亚提示的数学字段与普通文字中，
 * α β γ Α Ω μ π а 均如此，与字体的字形宽度无关；`·`、`“`、`×`、`→`、`∑` 等不按行高计（数学字段中取数学字体）。
 * 同样按东亚行高计的 `∞`、`①`、`Ⅰ`、`‰`、`′`、`※`、`℃`、`№`、`★`、`■`、`─` 未列入。
 */
function eastAsianLetter(cp: number): boolean {
  return cp >= 0x370 && cp <= 0x4ff
}

/** 参数恰为一个结构（不是字段）。 */
function single<P>(arg: MathArg<P>): boolean {
  return arg.length === 1 && arg[0]!.kind !== 'run'
}

function firstRun<P>(nodes: MathArg<P>): MathRun<P> | null {
  for (const n of nodes) {
    if (n.kind === 'run') return n
    if (n.kind === 'unsupported') continue
    const inner =
      n.kind === 'f'
        ? n.num
        : n.kind === 'd'
          ? (n.items[0] ?? [])
          : n.kind === 'eqArr'
            ? (n.rows[0] ?? [])
            : n.kind === 'func'
              ? n.name
              : n.base
    const r = firstRun(inner)
    if (r !== null) return r
  }
  return null
}

function attempt<T>(run: () => T): T | { readonly kind: 'unsupported'; readonly names: string[] } {
  try {
    return run()
  } catch (e) {
    if (e instanceof Unsupported) return { kind: 'unsupported', names: e.names }
    throw e
  }
}

/**
 * 排版一个 `m:oMath`，不断行。`display` 为真时按显示公式排版。WPS 实测：`m:oMathPara` 所在段落另有文字时按行内公式显示；
 * 段落中只有一个 `m:oMath`（不在 `m:oMathPara` 中）、没有其他文字时按显示公式显示，此时调用方改用 `layoutMathParagraph`。
 *
 * `segments` 为行内断行用的分段：依次相接即为整个公式，调用方的文字断行可在任意两段之间换行。WPS 实测行内公式在二元运算符
 * 与关系符之后断开（不受 `m:brkBin` 影响），运算符留在本行行尾，其后的间距不占位置。
 */
export function layoutMath<P, F>(
  zone: MathZone<P>,
  env: MathEnvironment<P, F>,
  display: boolean,
): MathResult<F> {
  return attempt(() => {
    const engine = new Engine(env, display, display ? env.settings.breakBinary : 'after')
    const { box, base } = engine.line([zone])
    const segments: MathSegment<F>[] = []
    let from = 0
    for (const b of [...(box.breaks ?? [])].sort((p, q) => p.start - q.start)) {
      segments.push({ ...engine.slice(box, from, b.end, b.start, base), advance: b.start - from })
      from = b.start
    }
    const rest = engine.slice(box, from, box.width, Number.POSITIVE_INFINITY, base)
    segments.push({ ...rest, advance: rest.width })
    return {
      kind: 'layout' as const,
      ...engine.layout(box.width, box.height, box.depth, box.items, base),
      segments,
    }
  })
}

/**
 * 排版显示公式段落：其中的 `m:oMath` 依次排成一行，超出可用宽度时断行并对齐。`width` 为可用宽度（版心宽度减段落缩进），
 * 行的横坐标相对其左端并已计入 `m:lMargin`。段落中只有一个 `m:oMath`、没有其他文字时，调用方以它构成 `justification`
 * 为 `null` 的段落。WPS 实测（12 与 24 磅，`m:brkBin`、`m:wrapIndent`、`m:wrapRight` 与四种对齐）：
 * - 断行处为最外层与单项括号、n 元运算符被积式中的二元运算符与关系符；标点与普通字符之间不断开，没有断行处时整行超出。
 * - 逐行取不超出可用宽度的最后一个关系符处断开（该行不短于 `RELATION_BREAK_MIN`，`m:wrapRight` 时不限），没有时取不超出的
 *   最后一个断行处；都超出时取第一个。运算符留在行尾时，首行判断是否超出计入其后的间距，其余各行与对齐不计。
 * - 首行按对齐方式放置；首行以外的各行缩进 `m:wrapIndent`：`centerGroup` 时各行作为一组居中、相对首行缩进，其余对齐方式
 *   相对可用宽度左端缩进；`m:wrapRight` 时这些行靠右。超出可用宽度的行靠左。
 */
export function layoutMathParagraph<P, F>(
  paragraph: MathParagraph<P>,
  env: MathEnvironment<P, F>,
  width: number,
): MathParagraphResult<F> {
  return attempt(() => {
    const settings = env.settings
    const engine = new Engine(env, true, settings.breakBinary)
    const { box, base } = engine.line(paragraph.zones)
    const room = width - settings.leftMargin - settings.rightMargin
    const indent = settings.wrapRight ? 0 : settings.wrapIndent
    const breaks = [...(box.breaks ?? [])].sort((p, q) => p.start - q.start)
    const shortest = settings.wrapRight ? 0 : RELATION_BREAK_MIN
    const eps = 1e-6
    const cuts: { start: number; end: number; next: number }[] = []
    let from = 0
    for (;;) {
      const first = cuts.length === 0
      const avail = first ? room : room - indent
      // 运算符留在行尾时，首行按含其后间距的宽度判断是否超出，其余各行不含（WPS 实测）。
      const reach = (b: Break) => (first && settings.breakBinary === 'after' ? b.start : b.end)
      const ahead = breaks.filter((b) => b.start > from + eps)
      if (box.width - from <= avail + eps || ahead.length === 0) {
        cuts.push({ start: from, end: box.width, next: Number.POSITIVE_INFINITY })
        break
      }
      const fit = ahead.filter((b) => reach(b) - from <= avail + eps)
      const pick =
        fit.filter((b) => b.relation && reach(b) - from >= shortest * avail).at(-1) ??
        fit.at(-1) ??
        ahead[0]!
      cuts.push({ start: from, end: pick.end, next: pick.start })
      from = pick.start
    }
    const parts = cuts.map((c) => engine.slice(box, c.start, c.end, c.next, base))
    const xs = place(
      parts.map((l) => l.width),
      room,
      paragraph.justification ?? settings.defaultJustification,
      indent,
      settings.wrapRight,
    )
    return {
      kind: 'layout' as const,
      lines: parts.map((l, i) => ({ ...l, x: settings.leftMargin + xs[i]! })),
    }
  })
}

/** 各行左端相对可用宽度左端的距离，规则见 `layoutMathParagraph`。 */
function place(
  widths: readonly number[],
  room: number,
  justification: MathJustification,
  indent: number,
  wrapRight: boolean,
): number[] {
  const rest = (w: number, left: number, right: number) => (wrapRight ? right - w : left + indent)
  if (justification === 'centerGroup') {
    const group =
      wrapRight && widths.length > 1
        ? room
        : Math.max(widths[0]!, ...widths.slice(1).map((w) => w + indent))
    const left = Math.max(0, (room - group) / 2)
    return widths.map((w, i) => (i === 0 ? left : rest(w, left, left + group)))
  }
  const first =
    justification === 'left'
      ? 0
      : justification === 'right'
        ? room - widths[0]!
        : (room - widths[0]!) / 2
  return widths.map((w, i) => (i === 0 ? Math.max(0, first) : rest(w, 0, room)))
}
