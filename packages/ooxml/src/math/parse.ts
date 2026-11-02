/**
 * OMML 读取：从位于 `m:oMath`、`m:oMathPara` 或 `m:mathPr` 开始标签的扫描器读到其结束标签，得到公式树或文档设置。
 *
 * - 元素按本地名识别；`m:val` 先按 `m:` 前缀取，再按命名空间取，最后取无前缀的 `val`（部分生成器省略前缀）。
 * - 字符属性（`m:r` 与 `m:ctrlPr` 中非 `m:` 命名空间的 `rPr`）交给调用方的 `readProps` 读取：回调须读到该元素的结束标签。
 * - 修订：`ins`、`moveTo` 中的内容按最终状态保留，`del`、`moveFrom` 中的内容丢弃。书签、校对与批注范围标记忽略。
 * - 其余未识别的元素记为 `unsupported` 节点，排版时整个公式不绘制。
 */

import type { PartScanner } from '../opc/scanner.ts'
import {
  MATH_SETTINGS_DEFAULTS,
  type MathArg,
  type MathJustification,
  type MathNode,
  type MathParagraph,
  type MathScript,
  type MathSettings,
  type MathStyle,
  type MathZone,
} from './model.ts'

export const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

export type ReadProps<P> = (x: PartScanner) => P

const IGNORED = new Set([
  'bookmarkStart',
  'bookmarkEnd',
  'proofErr',
  'permStart',
  'permEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'moveFromRangeStart',
  'moveFromRangeEnd',
  'moveToRangeStart',
  'moveToRangeEnd',
  'lastRenderedPageBreak',
])

const STYLES = new Set<MathStyle>(['p', 'b', 'i', 'bi'])
const SCRIPTS = new Set<MathScript>([
  'roman',
  'script',
  'fraktur',
  'double-struck',
  'sans-serif',
  'monospace',
])
const JUSTIFICATIONS = new Set<MathJustification>(['left', 'right', 'center', 'centerGroup'])

function eachChild(x: PartScanner, visit: (local: string) => void): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
    if (t === 'start' && x.depth === depth + 1) visit(x.local)
  }
}

function skip(x: PartScanner): void {
  eachChild(x, () => {})
}

function readText(x: PartScanner): string {
  const depth = x.depth
  let out = ''
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'text') out += x.text
  }
  return out
}

/** `m:val`；元素存在而没有该属性时为 `null`。 */
function val(x: PartScanner): string | null {
  const prefix = x.prefix
  return (
    (prefix === '' ? null : x.attr(`${prefix}:val`)) ?? x.attrNs(MATH_NS, 'val') ?? x.attr('val')
  )
}

/** `ST_OnOff`：缺少 `m:val` 为真。 */
function onOff(x: PartScanner): boolean {
  const v = val(x)
  return v === null || !(v === 'false' || v === '0' || v === 'off')
}

/** 带 `m:val` 的空元素：读取属性后读到结束标签。 */
function take<T>(x: PartScanner, read: (x: PartScanner) => T): T {
  const v = read(x)
  skip(x)
  return v
}

function isMath(x: PartScanner): boolean {
  return x.namespace === MATH_NS
}

class Reader<P> {
  constructor(private readonly readProps: ReadProps<P>) {}

  /** `ctrlPr` 或字段中的字符属性；修订包装中的 `rPr` 同样读取。 */
  private props(x: PartScanner): P | null {
    let out: P | null = null
    eachChild(x, (local) => {
      if (local === 'rPr' && !isMath(x)) out = this.readProps(x)
      else if (local === 'ins' || local === 'del') {
        eachChild(x, (inner) => {
          if (inner === 'rPr' && !isMath(x)) out = this.readProps(x)
          else skip(x)
        })
      } else skip(x)
    })
    return out
  }

  /** 结构属性元素（`fPr`、`naryPr` 等）：按本地名调用 `visit`，`ctrlPr` 读为字符属性。 */
  private structProps(x: PartScanner, visit: (local: string) => void): P | null {
    let props: P | null = null
    eachChild(x, (local) => {
      if (local === 'ctrlPr') props = this.props(x)
      else visit(local)
    })
    return props
  }

  arg(x: PartScanner): MathNode<P>[] {
    const out: MathNode<P>[] = []
    eachChild(x, (local) => this.node(x, local, out))
    return out
  }

  private node(x: PartScanner, local: string, out: MathNode<P>[]): void {
    switch (local) {
      case 'r':
        out.push(this.run(x))
        return
      case 'f':
        out.push(this.fraction(x))
        return
      case 'sSup':
      case 'sSub':
      case 'sSubSup':
        out.push(this.scripts(x, local))
        return
      case 'rad':
        out.push(this.radical(x))
        return
      case 'nary':
        out.push(this.nary(x))
        return
      case 'd':
        out.push(this.delimiter(x))
        return
      case 'eqArr':
        out.push(this.equationArray(x))
        return
      case 'func':
        out.push(this.func(x))
        return
      case 'acc':
        out.push(this.accent(x))
        return
      case 'bar':
        out.push(this.bar(x))
        return
      case 'box':
        out.push(this.box(x))
        return
      case 'limLow':
      case 'limUpp':
        out.push(this.limit(x, local))
        return
      case 'ins':
      case 'moveTo':
        eachChild(x, (inner) => this.node(x, inner, out))
        return
      case 'del':
      case 'moveFrom':
      case 'ctrlPr':
        skip(x)
        return
    }
    if (!IGNORED.has(local)) out.push({ kind: 'unsupported', name: local })
    skip(x)
  }

  private run(x: PartScanner): MathNode<P> {
    let text = ''
    let style: MathStyle | null = null
    let script: MathScript | null = null
    let normal = false
    let literal = false
    let props: P | null = null
    let unsupported: string | null = null
    eachChild(x, (local) => {
      if (local === 'rPr' && isMath(x)) {
        eachChild(x, (p) => {
          if (p === 'sty') {
            const v = take(x, val)
            if (v !== null && STYLES.has(v as MathStyle)) style = v as MathStyle
          } else if (p === 'scr') {
            const v = take(x, val)
            if (v !== null && SCRIPTS.has(v as MathScript)) script = v as MathScript
          } else if (p === 'nor') normal = take(x, onOff)
          else if (p === 'lit') literal = take(x, onOff)
          else skip(x)
        })
      } else if (local === 'rPr') props = this.readProps(x)
      else if (local === 't') text += readText(x)
      else if (local === 'ins' || local === 'del' || IGNORED.has(local)) skip(x)
      else {
        unsupported ??= local
        skip(x)
      }
    })
    if (unsupported !== null) return { kind: 'unsupported', name: `r/${unsupported}` }
    return { kind: 'run', text, style, script, normal, literal, props }
  }

  private fraction(x: PartScanner): MathNode<P> {
    let type: 'bar' | 'noBar' | 'lin' | 'skw' = 'bar'
    let props: P | null = null
    let num: MathArg<P> = []
    let den: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'fPr') {
        props = this.structProps(x, (p) => {
          if (p === 'type') {
            const v = take(x, val)
            // 部分生成器写作小写的 `nobar`。
            if (v === 'noBar' || v === 'nobar') type = 'noBar'
            else if (v === 'lin' || v === 'skw' || v === 'bar') type = v
          } else skip(x)
        })
      } else if (local === 'num') num = this.arg(x)
      else if (local === 'den') den = this.arg(x)
      else skip(x)
    })
    return { kind: 'f', type, num, den, props }
  }

  private scripts(x: PartScanner, kind: 'sSup' | 'sSub' | 'sSubSup'): MathNode<P> {
    let props: P | null = null
    let base: MathArg<P> = []
    let sub: MathArg<P> = []
    let sup: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === `${kind}Pr`) props = this.structProps(x, () => skip(x))
      else if (local === 'e') base = this.arg(x)
      else if (local === 'sub') sub = this.arg(x)
      else if (local === 'sup') sup = this.arg(x)
      else skip(x)
    })
    return { kind, base, sub, sup, props }
  }

  private radical(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let hideDegree = false
    let degree: MathArg<P> = []
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'radPr') {
        props = this.structProps(x, (p) => {
          if (p === 'degHide') hideDegree = take(x, onOff)
          else skip(x)
        })
      } else if (local === 'deg') degree = this.arg(x)
      else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'rad', degree, hideDegree, base, props }
  }

  private nary(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let char = '∫'
    let limits: 'undOvr' | 'subSup' | null = null
    let grow = false
    let hideSub = false
    let hideSup = false
    let sub: MathArg<P> = []
    let sup: MathArg<P> = []
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'naryPr') {
        props = this.structProps(x, (p) => {
          if (p === 'chr') char = take(x, val) ?? char
          else if (p === 'limLoc') {
            const v = take(x, val)
            if (v === 'undOvr' || v === 'subSup') limits = v
          } else if (p === 'grow') grow = take(x, onOff)
          else if (p === 'subHide') hideSub = take(x, onOff)
          else if (p === 'supHide') hideSup = take(x, onOff)
          else skip(x)
        })
      } else if (local === 'sub') sub = this.arg(x)
      else if (local === 'sup') sup = this.arg(x)
      else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'nary', char, limits, grow, hideSub, hideSup, sub, sup, base, props }
  }

  private delimiter(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let open = '('
    let close = ')'
    let separator = '|'
    let grow = true
    let shape: 'centered' | 'match' = 'centered'
    const items: MathArg<P>[] = []
    eachChild(x, (local) => {
      if (local === 'dPr') {
        props = this.structProps(x, (p) => {
          if (p === 'begChr') open = take(x, val) ?? ''
          else if (p === 'endChr') close = take(x, val) ?? ''
          else if (p === 'sepChr') separator = take(x, val) ?? ''
          else if (p === 'grow') grow = take(x, onOff)
          else if (p === 'shp') shape = take(x, val) === 'match' ? 'match' : 'centered'
          else skip(x)
        })
      } else if (local === 'e') items.push(this.arg(x))
      else skip(x)
    })
    return { kind: 'd', open, close, separator, grow, shape, items, props }
  }

  private equationArray(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let align: 'top' | 'center' | 'bottom' = 'center'
    let unsupported: string | null = null
    const rows: MathArg<P>[] = []
    eachChild(x, (local) => {
      if (local === 'eqArrPr') {
        props = this.structProps(x, (p) => {
          if (p === 'baseJc') {
            const v = take(x, val)
            if (v === 'top' || v === 'bottom' || v === 'center') align = v
          } else if (p === 'rSp' || p === 'rSpRule') {
            // 行距设置未实测，出现时整个公式不绘制。
            unsupported ??= `eqArr/${p}`
            skip(x)
          } else skip(x)
        })
      } else if (local === 'e') rows.push(this.arg(x))
      else skip(x)
    })
    if (unsupported !== null) return { kind: 'unsupported', name: unsupported }
    return { kind: 'eqArr', rows, align, props }
  }

  private func(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let name: MathArg<P> = []
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'funcPr') props = this.structProps(x, () => skip(x))
      else if (local === 'fName') name = this.arg(x)
      else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'func', name, base, props }
  }

  private accent(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let char = '̂'
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'accPr') {
        props = this.structProps(x, (p) => {
          if (p === 'chr') char = take(x, val) ?? char
          else skip(x)
        })
      } else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'acc', char, base, props }
  }

  private bar(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let position: 'top' | 'bot' = 'bot'
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'barPr') {
        props = this.structProps(x, (p) => {
          if (p === 'pos') position = take(x, val) === 'top' ? 'top' : 'bot'
          else skip(x)
        })
      } else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'bar', position, base, props }
  }

  private box(x: PartScanner): MathNode<P> {
    let props: P | null = null
    let base: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === 'boxPr') props = this.structProps(x, () => skip(x))
      else if (local === 'e') base = this.arg(x)
      else skip(x)
    })
    return { kind: 'box', base, props }
  }

  private limit(x: PartScanner, kind: 'limLow' | 'limUpp'): MathNode<P> {
    let props: P | null = null
    let base: MathArg<P> = []
    let limit: MathArg<P> = []
    eachChild(x, (local) => {
      if (local === `${kind}Pr`) props = this.structProps(x, () => skip(x))
      else if (local === 'e') base = this.arg(x)
      else if (local === 'lim') limit = this.arg(x)
      else skip(x)
    })
    return { kind, base, limit, props }
  }
}

/** 扫描器位于 `m:oMath` 开始标签；返回时位于其结束标签。 */
export function readMath<P>(x: PartScanner, readProps: ReadProps<P>): MathZone<P> {
  return { nodes: new Reader(readProps).arg(x) }
}

/** 扫描器位于 `m:oMathPara` 开始标签；返回时位于其结束标签。 */
export function readMathParagraph<P>(x: PartScanner, readProps: ReadProps<P>): MathParagraph<P> {
  const reader = new Reader(readProps)
  let justification: MathJustification | null = null
  const zones: MathZone<P>[] = []
  eachChild(x, (local) => {
    if (local === 'oMathParaPr') {
      eachChild(x, (p) => {
        if (p === 'jc') {
          const v = take(x, val)
          if (v !== null && JUSTIFICATIONS.has(v as MathJustification))
            justification = v as MathJustification
        } else skip(x)
      })
    } else if (local === 'oMath') zones.push({ nodes: reader.arg(x) })
    else skip(x)
  })
  return { justification, zones }
}

/** 扫描器位于 `m:mathPr` 开始标签；返回时位于其结束标签。`lMargin`、`rMargin`、`wrapIndent` 由缇换算为磅。 */
export function readMathSettings(x: PartScanner): MathSettings {
  let s: MathSettings = MATH_SETTINGS_DEFAULTS
  eachChild(x, (local) => {
    const v = val(x)
    switch (local) {
      case 'mathFont':
        if (v) s = { ...s, font: v }
        break
      case 'smallFrac':
        s = { ...s, smallFraction: onOff(x) }
        break
      case 'defJc':
        if (v !== null && JUSTIFICATIONS.has(v as MathJustification))
          s = { ...s, defaultJustification: v as MathJustification }
        break
      case 'intLim':
        if (v === 'undOvr' || v === 'subSup') s = { ...s, integralLimits: v }
        break
      case 'naryLim':
        if (v === 'undOvr' || v === 'subSup') s = { ...s, naryLimits: v }
        break
      case 'lMargin':
        if (v !== null && Number.isFinite(Number(v))) s = { ...s, leftMargin: Number(v) / 20 }
        break
      case 'rMargin':
        if (v !== null && Number.isFinite(Number(v))) s = { ...s, rightMargin: Number(v) / 20 }
        break
      case 'brkBin':
        if (v === 'before') s = { ...s, breakBinary: 'before' }
        else if (v === 'after' || v === 'repeat') s = { ...s, breakBinary: 'after' }
        break
      case 'wrapIndent':
        if (v !== null && Number.isFinite(Number(v))) s = { ...s, wrapIndent: Number(v) / 20 }
        break
      case 'wrapRight':
        s = { ...s, wrapRight: onOff(x) }
        break
    }
    skip(x)
  })
  return s
}
