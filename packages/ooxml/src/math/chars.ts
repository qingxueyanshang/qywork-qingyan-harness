/**
 * 公式字符：数学字母映射（`m:sty`、`m:scr` → Unicode 数学字母数字符号）、运算符分类（决定间距）与公式的文字（`mathText`）。
 *
 * - 缺省（无 `m:sty`）时拉丁字母与希腊字母（含大写）取斜体，其余字符不变。WPS 实测大写希腊字母同样取斜体。
 * - 分类只用于间距：`·`（U+00B7）、`.`、`/` 为普通字符（WPS 实测前后不加间距），`:` 与逗号、分号同为标点（其后加间距）。
 */

import type { MathArg, MathNode, MathScript, MathStyle, MathZone } from './model.ts'

export type AtomClass = 'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct' | 'inner'

/** 字母表起点：大写 A、小写 a；`null` 为该字体变体没有这类字母。 */
interface Alphabet {
  readonly upper: number
  readonly lower: number
  readonly digit: number | null
  /** 已在 BMP 中编码、数学字母区留空的字母。 */
  readonly holes?: Readonly<Record<string, number>>
  /** 希腊字母表起点（大写 Α 所在位置），没有时为 `null`。 */
  readonly greek: number | null
}

const ITALIC: Alphabet = {
  upper: 0x1d434,
  lower: 0x1d44e,
  digit: null,
  holes: { h: 0x210e },
  greek: 0x1d6e2,
}
const BOLD: Alphabet = { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce, greek: 0x1d6a8 }
const BOLD_ITALIC: Alphabet = { upper: 0x1d468, lower: 0x1d482, digit: null, greek: 0x1d71c }
const SCRIPT: Alphabet = {
  upper: 0x1d49c,
  lower: 0x1d4b6,
  digit: null,
  holes: {
    B: 0x212c,
    E: 0x2130,
    F: 0x2131,
    H: 0x210b,
    I: 0x2110,
    L: 0x2112,
    M: 0x2133,
    R: 0x211b,
    e: 0x212f,
    g: 0x210a,
    o: 0x2134,
  },
  greek: null,
}
const BOLD_SCRIPT: Alphabet = { upper: 0x1d4d0, lower: 0x1d4ea, digit: null, greek: null }
const FRAKTUR: Alphabet = {
  upper: 0x1d504,
  lower: 0x1d51e,
  digit: null,
  holes: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  greek: null,
}
const BOLD_FRAKTUR: Alphabet = { upper: 0x1d56c, lower: 0x1d586, digit: null, greek: null }
const DOUBLE_STRUCK: Alphabet = {
  upper: 0x1d538,
  lower: 0x1d552,
  digit: 0x1d7d8,
  holes: { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
  greek: null,
}
const SANS: Alphabet = { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2, greek: null }
const SANS_BOLD: Alphabet = { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec, greek: 0x1d756 }
const SANS_ITALIC: Alphabet = { upper: 0x1d608, lower: 0x1d622, digit: null, greek: null }
const SANS_BOLD_ITALIC: Alphabet = {
  upper: 0x1d63c,
  lower: 0x1d656,
  digit: null,
  greek: 0x1d790,
}
const MONO: Alphabet = { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6, greek: null }

/** 希腊字母在数学字母表中的序号：大写 0–24（Α–Ω，ϴ 占 17），25 为 ∇；小写 26 起（α–ω），之后为 ∂ϵϑϰϕϱϖ。 */
function greekIndex(cp: number): number {
  if (cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a2) return cp - 0x391
  if (cp === 0x3f4) return 17
  if (cp === 0x2207) return 25
  if (cp >= 0x3b1 && cp <= 0x3c9) return 26 + cp - 0x3b1
  const tail = [0x2202, 0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6].indexOf(cp)
  return tail < 0 ? -1 : 51 + tail
}

function isLatin(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
}

function alphabet(style: MathStyle | null, script: MathScript | null): Alphabet | null {
  const bold = style === 'b' || style === 'bi'
  const italic = style === null || style === 'i' || style === 'bi'
  switch (script) {
    case 'script':
      return bold ? BOLD_SCRIPT : SCRIPT
    case 'fraktur':
      return bold ? BOLD_FRAKTUR : FRAKTUR
    case 'double-struck':
      return DOUBLE_STRUCK
    case 'sans-serif':
      if (bold) return italic ? SANS_BOLD_ITALIC : SANS_BOLD
      return italic ? SANS_ITALIC : SANS
    case 'monospace':
      return MONO
    default:
      if (bold) return italic ? BOLD_ITALIC : BOLD
      return italic ? ITALIC : null
  }
}

/** 按 `m:sty` 与 `m:scr` 映射一个码位；没有对应的数学字母时返回原码位。 */
export function mathLetter(cp: number, style: MathStyle | null, script: MathScript | null): number {
  const a = alphabet(style, script)
  if (a === null) return cp
  if (isLatin(cp)) {
    const ch = String.fromCodePoint(cp)
    const hole = a.holes?.[ch]
    if (hole !== undefined) return hole
    return cp <= 0x5a ? a.upper + cp - 0x41 : a.lower + cp - 0x61
  }
  if (cp >= 0x30 && cp <= 0x39) return a.digit === null ? cp : a.digit + cp - 0x30
  if (a.greek !== null) {
    const i = greekIndex(cp)
    if (i >= 0) return a.greek + i
  }
  return cp
}

const BIN = new Set([
  0x2b, 0x2212, 0xb1, 0x2213, 0xd7, 0xf7, 0x2217, 0x2218, 0x2219, 0x22c5, 0x2229, 0x222a, 0x2227,
  0x2228, 0x2295, 0x2296, 0x2297, 0x2298, 0x2299, 0x228e, 0x2293, 0x2294, 0x2216, 0x22c6, 0x22c4,
  0x2240, 0x22bb, 0x22ba, 0x2a2f,
])

const REL = new Set([
  0x3d, 0x3c, 0x3e, 0x2260, 0x2264, 0x2265, 0x2261, 0x2262, 0x2248, 0x2245, 0x223c, 0x2243, 0x221d,
  0x2208, 0x2209, 0x220b, 0x220c, 0x2282, 0x2283, 0x2286, 0x2287, 0x2284, 0x2285, 0x228a, 0x228b,
  0x2223, 0x2224, 0x2225, 0x2226, 0x22a5, 0x226a, 0x226b, 0x227a, 0x227b, 0x2aaf, 0x2ab0, 0x22a2,
  0x22a8, 0x2254, 0x225d, 0x2250, 0x225c, 0x2266, 0x2267, 0x2a7d, 0x2a7e, 0x226e, 0x226f, 0x2270,
  0x2271, 0x2241, 0x2244, 0x2247, 0x2249, 0x224d, 0x2263,
])

const OPEN = new Set([0x28, 0x5b, 0x7b, 0x27e8, 0x2308, 0x230a, 0x3008, 0x27e6])
const CLOSE = new Set([0x29, 0x5d, 0x7d, 0x27e9, 0x2309, 0x230b, 0x3009, 0x27e7])
const PUNCT = new Set([0x2c, 0x3b, 0x3a])
const OP = new Set([
  0x2211, 0x220f, 0x2210, 0x222b, 0x222c, 0x222d, 0x222e, 0x222f, 0x2230, 0x22c0, 0x22c1, 0x22c2,
  0x22c3, 0x2a00, 0x2a01, 0x2a02,
])

/** 公式文字中结构的起点与每个参数的终点（WPS 的写法，见 `mathText`）。 */
const STRUCTURE_START = '\u001a'
const ARGUMENT_END = '\u001b'

function argsText<P>(args: readonly MathArg<P>[]): string {
  let out = STRUCTURE_START
  for (const a of args) out += nodesText(a) + ARGUMENT_END
  return out
}

function nodeText<P>(n: MathNode<P>): string {
  switch (n.kind) {
    case 'run': {
      if (n.normal) return n.text
      let out = ''
      for (const ch of n.text)
        out += String.fromCodePoint(mathLetter(ch.codePointAt(0)!, n.style, n.script))
      return out
    }
    case 'f':
      return argsText([n.num, n.den])
    case 'sSup':
      return argsText([n.base, n.sup])
    case 'sSub':
      return argsText([n.base, n.sub])
    case 'sSubSup':
      return argsText([n.base, n.sub, n.sup])
    case 'rad':
      return argsText([n.degree, n.base])
    case 'nary':
      return argsText([n.sub, n.sup, n.base])
    case 'd':
      return argsText(n.items)
    case 'eqArr':
      return argsText(n.rows)
    case 'func':
      return argsText([n.name, n.base])
    case 'acc':
    case 'bar':
    case 'box':
      return argsText([n.base])
    case 'limLow':
    case 'limUpp':
      return argsText([n.base, n.limit])
    case 'unsupported':
      return ''
  }
}

function nodesText<P>(nodes: MathArg<P>): string {
  let out = ''
  for (const n of nodes) out += nodeText(n)
  return out
}

/**
 * 公式的文字：WPS 中引用含公式段落的 STYLEREF 域显示的内容（实测，构造文档 w10s）。
 * - 字符按 `m:sty` 与 `m:scr` 映射为数学字母（`mathLetter`），`m:nor` 的字符不映射：「x+1」为「𝑥+1」，`m:sty="b"` 的「ab」为「𝐚𝐛」。
 * - 每个结构写为 U+001A 与各参数的文字，每个参数之后加 U+001B；参数按元素次序，隐藏的根指数与上下限仍各为一个空参数。
 *   括号、分隔符、n 元运算符、重音与横线等结构自身的字符不写出（`(x+1)` 为 U+001A「𝑥+1」U+001B）。
 * - 未实现的结构写为空串。
 */
export function mathText<P>(zone: MathZone<P>): string {
  return nodesText(zone.nodes)
}

export function atomClass(cp: number): AtomClass {
  if (BIN.has(cp)) return 'bin'
  // 箭头一律为关系符。
  if (REL.has(cp) || (cp >= 0x2190 && cp <= 0x21ff) || (cp >= 0x27f0 && cp <= 0x27ff)) return 'rel'
  if (OPEN.has(cp)) return 'open'
  if (CLOSE.has(cp)) return 'close'
  if (PUNCT.has(cp)) return 'punct'
  if (OP.has(cp)) return 'op'
  return 'ord'
}
