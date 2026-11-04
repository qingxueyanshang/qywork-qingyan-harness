/**
 * 条件格式引用的公式求值：`cellIs` 的操作数与 `expression` 规则。不是公式引擎，不计算单元格公式。
 *
 * - 支持：数字、字符串、逻辑值、错误值、单元格引用（含跨工作表）、四则运算、乘方、百分号、连接 `&`、
 *   比较运算与 `FUNCTIONS` 中的函数。区域引用、名称与其他函数不支持，`canEvaluate` 返回假。
 * - 相对引用按调用方给出的行列差平移；`$` 锁定的部分不变。
 * - 比较按 Excel 规则：数字小于文本小于逻辑值，文本不区分大小写，空值按 0 或空串参与比较。
 */

import type { CellValue, CfRule, Workbook, Worksheet } from './model.ts'
import { parseCellRef } from './parse/refs.ts'

export type Scalar = number | string | boolean | null | { readonly error: string }

export function scalarOf(v: CellValue | null | undefined): Scalar {
  if (!v) return null
  switch (v.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return v.value
    case 'error':
      return { error: v.value }
    case 'formula':
      return null
  }
}

export function isError(v: Scalar): v is { readonly error: string } {
  return typeof v === 'object' && v !== null
}

/** Excel 比较：数字小于文本小于逻辑值；文本不区分大小写；空值按 0 或空串参与比较。 */
export function compare(a: Scalar, b: Scalar): number {
  const rank = (x: Scalar) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2)
  let x = a
  let y = b
  if (x === null) x = typeof y === 'string' ? '' : typeof y === 'boolean' ? false : 0
  if (y === null) y = typeof x === 'string' ? '' : typeof x === 'boolean' ? false : 0
  const rx = rank(x)
  const ry = rank(y)
  if (rx !== ry) return rx - ry
  if (typeof x === 'string' && typeof y === 'string') {
    const p = x.toLowerCase()
    const q = y.toLowerCase()
    return p < q ? -1 : p > q ? 1 : 0
  }
  return Number(x) - Number(y)
}

export function compareOperator(
  op: Extract<CfRule, { type: 'cellIs' }>['operator'],
  v: Scalar,
  ops: Scalar[],
): boolean {
  const c0 = compare(v, ops[0] ?? null)
  switch (op) {
    case 'lessThan':
      return c0 < 0
    case 'lessThanOrEqual':
      return c0 <= 0
    case 'equal':
      return c0 === 0
    case 'notEqual':
      return c0 !== 0
    case 'greaterThanOrEqual':
      return c0 >= 0
    case 'greaterThan':
      return c0 > 0
    case 'between':
    case 'notBetween': {
      const a = ops[0] ?? null
      const b = ops[1] ?? null
      const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a]
      const inside = compare(v, lo) >= 0 && compare(v, hi) <= 0
      return op === 'between' ? inside : !inside
    }
  }
}

export function truthy(v: Scalar): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.toLowerCase() === 'true'
  return false
}

function toNumber(v: Scalar): number | { readonly error: string } {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (isError(v)) return v
  const n = Number(v.trim())
  return v.trim() !== '' && Number.isFinite(n) ? n : { error: '#VALUE!' }
}

function toText(v: Scalar): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isError(v)) return v.error
  return String(v)
}

type Node =
  | { k: 'lit'; v: Scalar }
  | { k: 'ref'; sheet: string | null; row: number; col: number; rowAbs: boolean; colAbs: boolean }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'fn'; name: string; args: Node[] }

const TOKEN =
  /\s*(?:("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-z_\u4e00-\u9fff][\w.\u4e00-\u9fff]*)!)?(\$?[A-Za-z]{1,3}\$?\d+)(?![\w(])|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|(#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA))|([A-Za-z_][\w.]*)\s*(?=\()|(TRUE|FALSE)(?![\w(])|(<=|>=|<>|[-+*/^&=<>(),%]))/iy

interface Token {
  readonly kind: 'str' | 'ref' | 'num' | 'err' | 'fn' | 'bool' | 'op'
  readonly text: string
  readonly sheet?: string
}

function tokenize(src: string): Token[] | null {
  const out: Token[] = []
  TOKEN.lastIndex = 0
  let i = 0
  while (i < src.length) {
    if (/\s/.test(src[i]!)) {
      i++
      continue
    }
    TOKEN.lastIndex = i
    const m = TOKEN.exec(src)
    if (!m || m.index !== i || m[0].length === 0) return null
    i = TOKEN.lastIndex
    if (m[1] !== undefined) out.push({ kind: 'str', text: m[1].slice(1, -1).replace(/""/g, '"') })
    else if (m[3] !== undefined) {
      const sheet = m[2] ? m[2].slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : undefined
      out.push(
        sheet === undefined ? { kind: 'ref', text: m[3] } : { kind: 'ref', text: m[3], sheet },
      )
    } else if (m[4] !== undefined) out.push({ kind: 'num', text: m[4] })
    else if (m[5] !== undefined) out.push({ kind: 'err', text: m[5] })
    else if (m[6] !== undefined) out.push({ kind: 'fn', text: m[6].toUpperCase() })
    else if (m[7] !== undefined) out.push({ kind: 'bool', text: m[7].toUpperCase() })
    else if (m[8] !== undefined) out.push({ kind: 'op', text: m[8] })
  }
  return out
}

const PRECEDENCE: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
}

function parse(tokens: Token[]): Node | null {
  let pos = 0
  const peek = () => tokens[pos]
  const primary = (): Node | null => {
    const t = tokens[pos++]
    if (!t) return null
    switch (t.kind) {
      case 'str':
        return { k: 'lit', v: t.text }
      case 'num':
        return { k: 'lit', v: Number(t.text) }
      case 'bool':
        return { k: 'lit', v: t.text === 'TRUE' }
      case 'err':
        return { k: 'lit', v: { error: t.text } }
      case 'ref': {
        const p = parseCellRef(t.text)
        if (!p) return null
        const colAbs = t.text.startsWith('$')
        const rowAbs = /[A-Za-z]\$/.test(t.text)
        return { k: 'ref', sheet: t.sheet ?? null, row: p.row, col: p.col, rowAbs, colAbs }
      }
      case 'fn': {
        if (tokens[pos]?.text !== '(') return null
        pos++
        const args: Node[] = []
        if (peek()?.text === ')') {
          pos++
          return { k: 'fn', name: t.text, args }
        }
        for (;;) {
          const a = expr(0)
          if (!a) return null
          args.push(a)
          const sep = tokens[pos++]
          if (sep?.text === ')') break
          if (sep?.text !== ',') return null
        }
        return { k: 'fn', name: t.text, args }
      }
      case 'op':
        if (t.text === '(') {
          const e = expr(0)
          if (!e || tokens[pos++]?.text !== ')') return null
          return e
        }
        if (t.text === '-' || t.text === '+') {
          const a = expr(5)
          return a ? { k: 'un', op: t.text, a } : null
        }
        return null
    }
  }
  const expr = (min: number): Node | null => {
    let left = primary()
    if (!left) return null
    while (peek()?.text === '%') {
      pos++
      left = { k: 'bin', op: '/', a: left, b: { k: 'lit', v: 100 } }
    }
    for (;;) {
      const t = peek()
      const prec = t && t.kind === 'op' ? PRECEDENCE[t.text] : undefined
      if (prec === undefined || prec < min) return left
      pos++
      const right = expr(t!.text === '^' ? prec : prec + 1)
      if (!right) return null
      left = { k: 'bin', op: t!.text, a: left, b: right }
    }
  }
  const node = expr(0)
  return node && pos === tokens.length ? node : null
}

const compiled = new Map<string, Node | null>()

function compile(formula: string): Node | null {
  const src = formula
    .trim()
    .replace(/^=/, '')
    .replace(/_xlfn\./gi, '')
  let node = compiled.get(src)
  if (node === undefined) {
    const tokens = tokenize(src)
    node = tokens ? parse(tokens) : null
    compiled.set(src, node)
  }
  return node
}

/** 公式能被求值器解析（语法与函数都受支持）。解析层据此统计无法求值的条件格式规则。 */
export function canEvaluate(formula: string): boolean {
  const node = compile(formula)
  return node !== null && usesKnownFunctions(node)
}

function usesKnownFunctions(n: Node): boolean {
  switch (n.k) {
    case 'fn':
      return n.name in FUNCTIONS && n.args.every(usesKnownFunctions)
    case 'un':
      return usesKnownFunctions(n.a)
    case 'bin':
      return usesKnownFunctions(n.a) && usesKnownFunctions(n.b)
    default:
      return true
  }
}

/** 公式的值；无法求值时为 `undefined`。`dRow`、`dCol` 为相对引用的平移量。 */
export function evaluateFormula(
  formula: string,
  wb: Workbook,
  sheet: Worksheet,
  dRow: number,
  dCol: number,
): Scalar | undefined {
  const node = compile(formula)
  if (!node) return undefined
  const value = evalNode(node, { wb, sheet, dRow, dCol })
  return value === undefined ? undefined : value
}

interface EvalContext {
  readonly wb: Workbook
  readonly sheet: Worksheet
  readonly dRow: number
  readonly dCol: number
}

const FUNCTIONS: Record<string, (args: Scalar[], ctx: EvalContext, nodes: Node[]) => Scalar> = {
  AND: (a) => a.every(truthy),
  OR: (a) => a.some(truthy),
  NOT: (a) => !truthy(a[0] ?? false),
  IF: (a) => (truthy(a[0] ?? false) ? (a[1] ?? true) : (a[2] ?? false)),
  ISERROR: (a) => isError(a[0] ?? null),
  ISBLANK: (a) => a[0] === null,
  ISNUMBER: (a) => typeof a[0] === 'number',
  ISTEXT: (a) => typeof a[0] === 'string',
  LEN: (a) => toText(a[0] ?? null).length,
  ABS: (a) => {
    const n = toNumber(a[0] ?? null)
    return typeof n === 'number' ? Math.abs(n) : n
  },
  MOD: (a) => {
    const x = toNumber(a[0] ?? null)
    const y = toNumber(a[1] ?? null)
    if (typeof x !== 'number') return x
    if (typeof y !== 'number') return y
    if (y === 0) return { error: '#DIV/0!' }
    return x - y * Math.floor(x / y)
  },
  SEARCH: (a) => {
    const i = toText(a[1] ?? null)
      .toLowerCase()
      .indexOf(toText(a[0] ?? null).toLowerCase())
    return i < 0 ? { error: '#VALUE!' } : i + 1
  },
  FIND: (a) => {
    const i = toText(a[1] ?? null).indexOf(toText(a[0] ?? null))
    return i < 0 ? { error: '#VALUE!' } : i + 1
  },
  ROW: (_a, ctx, nodes) => {
    const n = nodes[0]
    return n && n.k === 'ref' ? (n.rowAbs ? n.row : n.row + ctx.dRow) + 1 : { error: '#VALUE!' }
  },
  COLUMN: (_a, ctx, nodes) => {
    const n = nodes[0]
    return n && n.k === 'ref' ? (n.colAbs ? n.col : n.col + ctx.dCol) + 1 : { error: '#VALUE!' }
  },
}

function evalNode(n: Node, ctx: EvalContext): Scalar | undefined {
  switch (n.k) {
    case 'lit':
      return n.v
    case 'ref': {
      // 图表工作表没有单元格，引用它与引用不存在的工作表相同。
      const sheet =
        n.sheet === null
          ? ctx.sheet
          : ctx.wb.sheets.find((s): s is Worksheet => s.kind === 'worksheet' && s.name === n.sheet)
      if (!sheet) return { error: '#REF!' }
      const row = n.rowAbs ? n.row : n.row + ctx.dRow
      const col = n.colAbs ? n.col : n.col + ctx.dCol
      if (row < 0 || col < 0) return { error: '#REF!' }
      return scalarOf(sheet.cells.get(row)?.get(col)?.value)
    }
    case 'un': {
      const a = evalNode(n.a, ctx)
      if (a === undefined) return undefined
      const x = toNumber(a)
      if (typeof x !== 'number') return x
      return n.op === '-' ? -x : x
    }
    case 'bin': {
      const a = evalNode(n.a, ctx)
      const b = evalNode(n.b, ctx)
      if (a === undefined || b === undefined) return undefined
      if (isError(a)) return a
      if (isError(b)) return b
      if (n.op === '&') return toText(a) + toText(b)
      if (PRECEDENCE[n.op] === 1) {
        const c = compare(a, b)
        return n.op === '='
          ? c === 0
          : n.op === '<>'
            ? c !== 0
            : n.op === '<'
              ? c < 0
              : n.op === '>'
                ? c > 0
                : n.op === '<='
                  ? c <= 0
                  : c >= 0
      }
      const x = toNumber(a)
      const y = toNumber(b)
      if (typeof x !== 'number') return x
      if (typeof y !== 'number') return y
      switch (n.op) {
        case '+':
          return x + y
        case '-':
          return x - y
        case '*':
          return x * y
        case '/':
          return y === 0 ? { error: '#DIV/0!' } : x / y
        case '^':
          return x ** y
      }
      return undefined
    }
    case 'fn': {
      const fn = FUNCTIONS[n.name]
      if (!fn) return undefined
      const args: Scalar[] = []
      for (const a of n.args) {
        const v = evalNode(a, ctx)
        if (v === undefined) return undefined
        args.push(v)
      }
      return fn(args, ctx, n.args)
    }
  }
}
