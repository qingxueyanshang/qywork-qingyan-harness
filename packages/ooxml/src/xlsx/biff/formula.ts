/**
 * BIFF8 公式（RPN 记号序列）反编译为 A1 样式的公式文本，供条件格式（`../formula.ts` 求值）与图表系列引用（`../parse/chart-cells.ts` 取值）使用。
 *
 * - 支持的记号：常数（数字、字符串、逻辑值、错误值）、单元格与区域引用（含三维引用与相对引用记号 RefN、AreaN）、
 *   四则与比较运算、连接、乘方、百分号、正负号、括号、并集、`FUNCTIONS` 中的函数，以及不影响取值的属性记号与内存区域记号的头部。
 *   其余记号（名称、数组常数、未列出的函数等）使反编译失败，返回 `null`。
 * - 三维引用的工作表由 `sheetName(ixti)` 给出，返回 `null`（外部工作簿等）时反编译失败。工作表名一律加单引号。
 * - 相对引用记号（RefN、AreaN）的行列为相对 `base` 的偏移，换算后写成不带 `$` 的引用；普通引用按记号中的相对标志写出 `$`。
 *   调用方须以同一个 `base` 解释相对引用（条件格式为第一个区域的左上角）。
 */

import { Bytes } from './records.ts'

export interface FormulaContext {
  /** EXTERNSHEET 序号对应的工作表名；无法在本工作簿中解析时为 `null`。 */
  sheetName(ixti: number): string | null
  /** 相对引用记号的基准单元格。 */
  readonly base: { readonly row: number; readonly col: number }
}

/** 二元运算记号：PtgAdd 至 PtgRange，交集（0x0F）不支持。 */
const BINARY: ReadonlyMap<number, string> = new Map([
  [0x03, '+'],
  [0x04, '-'],
  [0x05, '*'],
  [0x06, '/'],
  [0x07, '^'],
  [0x08, '&'],
  [0x09, '<'],
  [0x0a, '<='],
  [0x0b, '='],
  [0x0c, '>='],
  [0x0d, '>'],
  [0x0e, '<>'],
  [0x10, ','],
  [0x11, ':'],
])

const ERRORS: ReadonlyMap<number, string> = new Map([
  [0x00, '#NULL!'],
  [0x07, '#DIV/0!'],
  [0x0f, '#VALUE!'],
  [0x17, '#REF!'],
  [0x1d, '#NAME?'],
  [0x24, '#NUM!'],
  [0x2a, '#N/A'],
])

/** 函数表序号 → 名称与固定参数个数（`null` 为可变参数，只经 PtgFuncVar 出现）。只列条件格式求值器支持的函数。 */
const FUNCTIONS: ReadonlyMap<number, { readonly name: string; readonly args: number | null }> =
  new Map([
    [1, { name: 'IF', args: null }],
    [3, { name: 'ISERROR', args: 1 }],
    [8, { name: 'ROW', args: null }],
    [9, { name: 'COLUMN', args: null }],
    [24, { name: 'ABS', args: 1 }],
    [32, { name: 'LEN', args: 1 }],
    [36, { name: 'AND', args: null }],
    [37, { name: 'OR', args: null }],
    [38, { name: 'NOT', args: 1 }],
    [39, { name: 'MOD', args: 2 }],
    [82, { name: 'SEARCH', args: null }],
    [124, { name: 'FIND', args: null }],
    [127, { name: 'ISTEXT', args: 1 }],
    [128, { name: 'ISNUMBER', args: 1 }],
    [129, { name: 'ISBLANK', args: 1 }],
  ])

function column(col: number): string {
  let s = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  }
  return s
}

/** 单元格引用文字：`rowAbs`、`colAbs` 为真时加 `$`。 */
function cell(row: number, col: number, rowAbs: boolean, colAbs: boolean): string {
  return `${colAbs ? '$' : ''}${column(col)}${rowAbs ? '$' : ''}${row + 1}`
}

/** 普通引用的行与列字段（列字段第 14、15 位为列、行的相对标志）。 */
function absolute(rw: number, colField: number): string {
  return cell(rw, colField & 0x3fff, (colField & 0x8000) === 0, (colField & 0x4000) === 0)
}

/** 相对引用记号：相对标志为真时行为 16 位、列为 8 位有符号偏移。 */
function relative(rw: number, colField: number, base: FormulaContext['base']): string | null {
  const rowRel = (colField & 0x8000) !== 0
  const colRel = (colField & 0x4000) !== 0
  const row = rowRel ? base.row + ((rw << 16) >> 16) : rw
  const col = colRel ? base.col + (((colField & 0xff) << 24) >> 24) : colField & 0x3fff
  if (row < 0 || col < 0) return null
  return cell(row, col, !rowRel, !colRel)
}

function quoted(name: string): string {
  return `'${name.replaceAll("'", "''")}'!`
}

/** 反编译 `rgce`；含不支持的记号或结构错误时返回 `null`。 */
export function formulaText(rgce: Uint8Array, ctx: FormulaContext): string | null {
  const b = new Bytes(rgce)
  const stack: string[] = []
  const pop = (n: number): string[] | null => (stack.length < n ? null : stack.splice(-n, n))
  let p = 0
  while (p < b.length) {
    const ptg = b.u8(p++)
    const op = BINARY.get(ptg)
    if (op !== undefined) {
      const ab = pop(2)
      if (ab === null) return null
      stack.push(`${ab[0]}${op}${ab[1]}`)
      continue
    }
    const base = ptg >= 0x20 ? (ptg & 0x1f) | 0x20 : ptg
    switch (base) {
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15: {
        const a = pop(1)
        if (a === null) return null
        stack.push(
          base === 0x12
            ? `+${a[0]}`
            : base === 0x13
              ? `-${a[0]}`
              : base === 0x14
                ? `${a[0]}%`
                : `(${a[0]})`,
        )
        break
      }
      case 0x16:
        stack.push('')
        break
      case 0x17: {
        const n = b.u8(p)
        const wide = (b.u8(p + 1) & 1) === 1
        let s = ''
        for (let k = 0; k < n; k++) {
          s += String.fromCharCode(wide ? b.u16(p + 2 + k * 2) : b.u8(p + 2 + k))
        }
        p += 2 + n * (wide ? 2 : 1)
        stack.push(`"${s.replaceAll('"', '""')}"`)
        break
      }
      case 0x19: {
        const grbit = b.u8(p)
        if (grbit & 0x04) p += 3 + (b.u16(p + 1) + 1) * 2
        else p += 3
        if (grbit & 0x10) {
          const a = pop(1)
          if (a === null) return null
          stack.push(`SUM(${a[0]})`)
        }
        break
      }
      case 0x1c:
        stack.push(ERRORS.get(b.u8(p)) ?? '#N/A')
        p += 1
        break
      case 0x1d:
        stack.push(b.u8(p) ? 'TRUE' : 'FALSE')
        p += 1
        break
      case 0x1e:
        stack.push(String(b.u16(p)))
        p += 2
        break
      case 0x1f:
        stack.push(String(b.f64(p)))
        p += 8
        break
      case 0x21:
      case 0x22: {
        const fixed = base === 0x21
        const id = fixed ? b.u16(p) : b.u16(p + 1) & 0x7fff
        const fn = FUNCTIONS.get(id)
        const argc = fixed ? fn?.args : b.u8(p)
        p += fixed ? 2 : 3
        if (fn === undefined || argc === null || argc === undefined) return null
        const args = argc === 0 ? [] : pop(argc)
        if (args === null) return null
        stack.push(`${fn.name}(${args.join(',')})`)
        break
      }
      case 0x24:
        stack.push(absolute(b.u16(p), b.u16(p + 2)))
        p += 4
        break
      case 0x25:
        stack.push(`${absolute(b.u16(p), b.u16(p + 4))}:${absolute(b.u16(p + 2), b.u16(p + 6))}`)
        p += 8
        break
      case 0x26:
        p += 6
        break
      case 0x29:
        p += 2
        break
      case 0x2a:
        stack.push('#REF!')
        p += 4
        break
      case 0x2b:
        stack.push('#REF!')
        p += 8
        break
      case 0x2c: {
        const s = relative(b.u16(p), b.u16(p + 2), ctx.base)
        if (s === null) return null
        stack.push(s)
        p += 4
        break
      }
      case 0x2d: {
        const first = relative(b.u16(p), b.u16(p + 4), ctx.base)
        const last = relative(b.u16(p + 2), b.u16(p + 6), ctx.base)
        if (first === null || last === null) return null
        stack.push(`${first}:${last}`)
        p += 8
        break
      }
      case 0x3a:
      case 0x3b: {
        const name = ctx.sheetName(b.u16(p))
        if (name === null) return null
        const ref =
          base === 0x3a
            ? absolute(b.u16(p + 2), b.u16(p + 4))
            : `${absolute(b.u16(p + 2), b.u16(p + 6))}:${absolute(b.u16(p + 4), b.u16(p + 8))}`
        stack.push(quoted(name) + ref)
        p += base === 0x3a ? 6 : 10
        break
      }
      case 0x3c:
        stack.push('#REF!')
        p += 6
        break
      case 0x3d:
        stack.push('#REF!')
        p += 10
        break
      default:
        return null
    }
  }
  return stack.length === 1 ? stack[0]! : null
}
