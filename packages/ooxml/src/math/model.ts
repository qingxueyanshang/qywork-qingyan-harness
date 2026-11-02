/**
 * OMML 公式树。`P` 为字符属性（`w:rPr` 或 `a:rPr`）由调用方读取后的结果，本模块不解释其内容。
 *
 * - 参数（`m:e`、`m:num`、`m:sub` 等）为节点数组；空参数为空数组。
 * - 结构的 `props` 取自其 `m:ctrlPr`，决定结构自身字形（求和号、括号、分数线）的字号与颜色；没有时为 `null`。
 * - 属性缺省值按 ECMA-376 第 1 部分 22.1 节填入，「由文档设置决定」的项为 `null`（如 `nary` 的 `limLoc`）。
 */

export type MathArg<P> = readonly MathNode<P>[]

/** `m:sty`：p 正体、b 粗体、i 斜体、bi 粗斜体。缺省时字母为斜体，其余字符为正体。 */
export type MathStyle = 'p' | 'b' | 'i' | 'bi'

export type MathScript =
  | 'roman'
  | 'script'
  | 'fraktur'
  | 'double-struck'
  | 'sans-serif'
  | 'monospace'

export interface MathRun<P> {
  readonly kind: 'run'
  readonly text: string
  readonly style: MathStyle | null
  readonly script: MathScript | null
  /** `m:nor`：普通文字，按字符属性的字体与字形排版，不做数学字母映射与运算符间距。 */
  readonly normal: boolean
  /** `m:lit`：字面字符，不做运算符间距。 */
  readonly literal: boolean
  readonly props: P | null
}

export interface MathFraction<P> {
  readonly kind: 'f'
  readonly type: 'bar' | 'noBar' | 'lin' | 'skw'
  readonly num: MathArg<P>
  readonly den: MathArg<P>
  readonly props: P | null
}

export interface MathScripts<P> {
  readonly kind: 'sSup' | 'sSub' | 'sSubSup'
  readonly base: MathArg<P>
  /** `sSup` 时为空数组。 */
  readonly sub: MathArg<P>
  /** `sSub` 时为空数组。 */
  readonly sup: MathArg<P>
  readonly props: P | null
}

export interface MathRadical<P> {
  readonly kind: 'rad'
  readonly degree: MathArg<P>
  readonly hideDegree: boolean
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathNary<P> {
  readonly kind: 'nary'
  /** 运算符字符，缺省为积分号；空串为不显示运算符。 */
  readonly char: string
  /** `null` 为按文档设置（`mathPr` 的 `naryLim` 或 `intLim`）。 */
  readonly limits: 'undOvr' | 'subSup' | null
  readonly grow: boolean
  readonly hideSub: boolean
  readonly hideSup: boolean
  readonly sub: MathArg<P>
  readonly sup: MathArg<P>
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathDelimiter<P> {
  readonly kind: 'd'
  /** 空串为不显示该侧括号。 */
  readonly open: string
  readonly close: string
  readonly separator: string
  readonly grow: boolean
  /** `m:shp`：centered 为对称于轴伸展，match 为与内容等高。 */
  readonly shape: 'centered' | 'match'
  readonly items: readonly MathArg<P>[]
  readonly props: P | null
}

export interface MathEquationArray<P> {
  readonly kind: 'eqArr'
  readonly rows: readonly MathArg<P>[]
  /** `m:baseJc`：与外部基线对齐的位置。 */
  readonly align: 'top' | 'center' | 'bottom'
  readonly props: P | null
}

export interface MathFunction<P> {
  readonly kind: 'func'
  readonly name: MathArg<P>
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathAccent<P> {
  readonly kind: 'acc'
  readonly char: string
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathBar<P> {
  readonly kind: 'bar'
  readonly position: 'top' | 'bot'
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathBox<P> {
  readonly kind: 'box'
  readonly base: MathArg<P>
  readonly props: P | null
}

export interface MathLimit<P> {
  readonly kind: 'limLow' | 'limUpp'
  readonly base: MathArg<P>
  readonly limit: MathArg<P>
  readonly props: P | null
}

/** 未实现的结构：整个公式不绘制，调用方按能力边界计数。 */
export interface MathUnsupported {
  readonly kind: 'unsupported'
  readonly name: string
}

export type MathNode<P> =
  | MathRun<P>
  | MathFraction<P>
  | MathScripts<P>
  | MathRadical<P>
  | MathNary<P>
  | MathDelimiter<P>
  | MathEquationArray<P>
  | MathFunction<P>
  | MathAccent<P>
  | MathBar<P>
  | MathBox<P>
  | MathLimit<P>
  | MathUnsupported

/** 一个 `m:oMath`。 */
export interface MathZone<P> {
  readonly nodes: MathArg<P>
}

export type MathJustification = 'left' | 'right' | 'center' | 'centerGroup'

/** 一个 `m:oMathPara`：每个 `m:oMath` 独占一行显示。`justification` 为 `null` 时按文档设置（`defJc`）。 */
export interface MathParagraph<P> {
  readonly justification: MathJustification | null
  readonly zones: readonly MathZone<P>[]
}

/** 文档级设置（WordprocessingML 的 `m:mathPr`）。PresentationML 中没有该元素，取缺省值。 */
export interface MathSettings {
  readonly font: string
  readonly smallFraction: boolean
  readonly defaultJustification: MathJustification
  /** 积分类运算符的上下限位置。 */
  readonly integralLimits: 'undOvr' | 'subSup'
  /** 其余 n 元运算符的上下限位置。 */
  readonly naryLimits: 'undOvr' | 'subSup'
  /** 显示公式的左右边距（磅）。 */
  readonly leftMargin: number
  readonly rightMargin: number
  /**
   * 显示公式断行时二元运算符与关系符的位置（`m:brkBin`）：`before` 移到下一行行首，`after` 留在本行行尾。
   * WPS 实测 `repeat` 与 `after` 相同（不在下一行重复运算符），`m:brkBinSub` 不起作用，因此不读取。
   */
  readonly breakBinary: 'before' | 'after'
  /** 首行以外的各行相对首行的缩进（磅，`m:wrapIndent`）。 */
  readonly wrapIndent: number
  /** 首行以外的各行靠右（`m:wrapRight`），此时不取 `wrapIndent`。 */
  readonly wrapRight: boolean
}

/** `m:mathPr` 各项省略时的值（ECMA-376 第 1 部分 22.1.2）。 */
export const MATH_SETTINGS_DEFAULTS: MathSettings = {
  font: 'Cambria Math',
  smallFraction: false,
  defaultJustification: 'centerGroup',
  integralLimits: 'subSup',
  naryLimits: 'undOvr',
  leftMargin: 0,
  rightMargin: 0,
  breakBinary: 'before',
  wrapIndent: 72,
  wrapRight: false,
}
