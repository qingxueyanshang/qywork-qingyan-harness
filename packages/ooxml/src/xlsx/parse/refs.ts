/**
 * A1 引用：单元格地址、区域与共享公式的相对引用平移。行号与列号从 0 起算。
 */

import type { CellRange } from '../model.ts'

export const MAX_ROW = 1_048_575
export const MAX_COL = 16_383

/** `AB12` → `{ row: 11, col: 27 }`；`$` 忽略。格式不符时返回 `null`。 */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  let i = 0
  let col = 0
  const s = ref.trim()
  if (s[i] === '$') i++
  const colStart = i
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const upper = c >= 65 && c <= 90 ? c : c >= 97 && c <= 122 ? c - 32 : 0
    if (!upper) break
    col = col * 26 + (upper - 64)
  }
  if (i === colStart || i - colStart > 3) return null
  if (s[i] === '$') i++
  const rowText = s.slice(i)
  if (!/^\d+$/.test(rowText)) return null
  const row = Number(rowText) - 1
  if (row < 0 || row > MAX_ROW || col - 1 > MAX_COL) return null
  return { row, col: col - 1 }
}

/** `A1:B2`、`A1`；整列 `A:B` 与整行 `1:2` 展开到表格边界。格式不符时返回 `null`。 */
export function parseRange(ref: string): CellRange | null {
  const pieces = ref.trim().split(':')
  const a = pieces[0] ?? ''
  const b = pieces[1] ?? a
  const colOnly = /^\$?[A-Za-z]{1,3}$/
  const rowOnly = /^\$?\d+$/
  if (colOnly.test(a) && colOnly.test(b)) {
    const l = parseCellRef(`${a}1`)
    const r = parseCellRef(`${b}1`)
    return l && r ? normalize(0, l.col, MAX_ROW, r.col) : null
  }
  if (rowOnly.test(a) && rowOnly.test(b)) {
    const t = Number(a.replace('$', '')) - 1
    const btm = Number(b.replace('$', '')) - 1
    return t >= 0 && btm >= 0 ? normalize(t, 0, btm, MAX_COL) : null
  }
  const p = parseCellRef(a)
  const q = parseCellRef(b)
  return p && q ? normalize(p.row, p.col, q.row, q.col) : null
}

function normalize(r1: number, c1: number, r2: number, c2: number): CellRange {
  return {
    top: Math.min(r1, r2),
    left: Math.min(c1, c2),
    bottom: Math.max(r1, r2),
    right: Math.max(c1, c2),
  }
}

/** 空格分隔的多个区域（`sqref`）。无法解析的项略过。 */
export function parseRangeList(sqref: string): CellRange[] {
  return sqref
    .split(/\s+/)
    .filter((s) => s !== '')
    .flatMap((s) => {
      const r = parseRange(s)
      return r ? [r] : []
    })
}

export function colName(col: number): string {
  let s = ''
  let c = col + 1
  while (c > 0) {
    const m = (c - 1) % 26
    s = String.fromCharCode(65 + m) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

/**
 * 共享公式的从属单元格：按与主单元格的行列差平移公式中的相对引用，`$` 锁定的部分不变。
 * 引号内的文本不平移；紧跟 `(` 的标识符是函数名（如 `LOG10(`），不当作引用。
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  let out = ''
  let i = 0
  const re = /(?<![A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(!])/y
  while (i < formula.length) {
    const ch = formula[i]!
    if (ch === '"') {
      const end = formula.indexOf('"', i + 1)
      const stop = end < 0 ? formula.length : end + 1
      out += formula.slice(i, stop)
      i = stop
      continue
    }
    re.lastIndex = i
    const m = re.exec(formula)
    if (m) {
      const [, colAbs, letters, rowAbs, digits] = m
      const ref = parseCellRef(`${letters}${digits}`)
      if (ref) {
        const col = colAbs ? ref.col : ref.col + dCol
        const row = rowAbs ? ref.row : ref.row + dRow
        out += `${colAbs}${colName(Math.max(0, col))}${rowAbs}${Math.max(0, row) + 1}`
        i += m[0].length
        continue
      }
    }
    out += ch
    i++
  }
  return out
}
