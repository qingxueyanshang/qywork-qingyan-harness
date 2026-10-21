/**
 * New API 分档计费公式（`/api/pricing` 中 `billing_mode: tiered_expr` 的 `billing_expr`）的求值。
 *
 * 支持的语法：数字、双引号字符串、`+ - * /`、比较、`&& ||`、三元、括号，函数 `tier(名称, 值)`、`u(计量名)`、
 * `weekday(时区)`、`hour(时区)`，以及调用方给出的变量（对话为 `p c cr cc len`）。其余函数与未给出的变量
 * 在求值到时抛出 `UnsupportedBilling`：此时价格不明，不按部分结果折算。
 * 三元与 `&& ||` 只对选中的分支求值，未选中分支中的不支持项不影响结果。
 */

export class UnsupportedBilling extends Error {}

type Value = number | string | boolean

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'var'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'if'; cond: Node; a: Node; b: Node }

type Token = { t: 'lit'; v: Value } | { t: 'id'; v: string } | { t: 'op'; v: string }

const OPERATORS = [
  '||',
  '&&',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '?',
  ':',
  '(',
  ')',
  ',',
]
const COMPARISONS = ['==', '!=', '<', '<=', '>', '>=']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'lit', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1)
      if (end < 0) throw new UnsupportedBilling('字符串未闭合')
      out.push({ t: 'lit', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (!op) throw new UnsupportedBilling(`无法识别的字符 ${ch}`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  return out
}

function parse(src: string): Node {
  const tokens = tokenize(src)
  let pos = 0
  const at = (v: string) => tokens[pos]?.t === 'op' && tokens[pos]!.v === v
  const expect = (v: string) => {
    if (!at(v)) throw new UnsupportedBilling(`缺少 ${v}`)
    pos++
  }
  const binary = (next: () => Node, ops: readonly string[]) => (): Node => {
    let a = next()
    while (tokens[pos]?.t === 'op' && ops.includes(tokens[pos]!.v as string)) {
      const op = tokens[pos++]!.v as string
      a = { k: 'bin', op, a, b: next() }
    }
    return a
  }
  const primary = (): Node => {
    const tok = tokens[pos++]
    if (!tok) throw new UnsupportedBilling('公式不完整')
    if (tok.t === 'lit') return { k: 'lit', v: tok.v }
    if (tok.t === 'op') {
      if (tok.v === '-') return { k: 'neg', a: primary() }
      if (tok.v !== '(') throw new UnsupportedBilling(`意外的 ${tok.v}`)
      const inner = ternary()
      expect(')')
      return inner
    }
    if (!at('(')) return { k: 'var', name: tok.v }
    pos++
    const args: Node[] = []
    while (!at(')')) {
      args.push(ternary())
      if (!at(')')) expect(',')
    }
    pos++
    return { k: 'call', name: tok.v, args }
  }
  const mul = binary(primary, ['*', '/'])
  const add = binary(mul, ['+', '-'])
  const compare = binary(add, COMPARISONS)
  const and = binary(compare, ['&&'])
  const or = binary(and, ['||'])
  function ternary(): Node {
    const cond = or()
    if (!at('?')) return cond
    pos++
    const a = ternary()
    expect(':')
    return { k: 'if', cond, a, b: ternary() }
  }
  const root = ternary()
  if (pos !== tokens.length) throw new UnsupportedBilling('公式中有多余内容')
  return root
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const formats = new Map<string, Intl.DateTimeFormat>()

/** 时刻 `at` 在时区 `zone` 的星期（0 = 周日）与小时（0–23）。 */
function localTime(at: number, zone: string): { weekday: number; hour: number } {
  let format = formats.get(zone)
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        hourCycle: 'h23',
      })
    } catch {
      throw new UnsupportedBilling(`不支持时区 ${zone}`)
    }
    formats.set(zone, format)
  }
  const parts = format.formatToParts(at)
  return {
    weekday: WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')!.value),
    hour: Number(parts.find((p) => p.type === 'hour')!.value),
  }
}

/** 编译后的公式。`at` 是计费时刻（毫秒时间戳），省略时 `weekday` 与 `hour` 不支持。 */
export type Billing = (
  vars: Readonly<Record<string, number>>,
  usage?: Readonly<Record<string, number | string>>,
  at?: number,
) => number

/**
 * 编译公式，语法错误时抛出 `UnsupportedBilling`。返回的函数对公式求值：`vars` 是公式中直接引用的变量，
 * `usage` 是 `u("名称")` 取得的计量；结果必须是有限数字，否则抛出 `UnsupportedBilling`。
 */
export function compileBilling(expr: string): Billing {
  const root = parse(expr)
  return (vars, usage = {}, at) => {
    const num = (v: Value): number => {
      if (typeof v !== 'number') throw new UnsupportedBilling('运算对象不是数字')
      return v
    }
    const clock = (name: 'weekday' | 'hour', arg: Node): number => {
      const zone = run(arg)
      if (at === undefined || typeof zone !== 'string')
        throw new UnsupportedBilling(`不支持函数 ${name}`)
      return localTime(at, zone)[name]
    }
    const run = (n: Node): Value => {
      switch (n.k) {
        case 'lit':
          return n.v
        case 'var': {
          const v = vars[n.name]
          if (v === undefined) throw new UnsupportedBilling(`不支持变量 ${n.name}`)
          return v
        }
        case 'neg':
          return -num(run(n.a))
        case 'if':
          return run(n.cond) ? run(n.a) : run(n.b)
        case 'call': {
          if (n.name === 'tier' && n.args.length === 2) return run(n.args[1]!)
          if (n.name === 'u' && n.args.length === 1) {
            const key = run(n.args[0]!)
            const v = typeof key === 'string' ? usage[key] : undefined
            if (v === undefined) throw new UnsupportedBilling(`缺少计量 ${String(key)}`)
            return v
          }
          if ((n.name === 'weekday' || n.name === 'hour') && n.args.length === 1)
            return clock(n.name, n.args[0]!)
          throw new UnsupportedBilling(`不支持函数 ${n.name}`)
        }
        case 'bin': {
          if (n.op === '&&') return Boolean(run(n.a)) && Boolean(run(n.b))
          if (n.op === '||') return Boolean(run(n.a)) || Boolean(run(n.b))
          const a = run(n.a)
          const b = run(n.b)
          switch (n.op) {
            case '==':
              return a === b
            case '!=':
              return a !== b
            case '<':
              return num(a) < num(b)
            case '<=':
              return num(a) <= num(b)
            case '>':
              return num(a) > num(b)
            case '>=':
              return num(a) >= num(b)
            case '+':
              return num(a) + num(b)
            case '-':
              return num(a) - num(b)
            case '*':
              return num(a) * num(b)
            default:
              return num(a) / num(b)
          }
        }
      }
    }
    const result = run(root)
    if (typeof result !== 'number' || !Number.isFinite(result))
      throw new UnsupportedBilling('结果不是数字')
    return result
  }
}
