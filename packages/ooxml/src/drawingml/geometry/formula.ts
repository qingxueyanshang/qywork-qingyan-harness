/**
 * 几何公式求值：内置量、调整值与参数（`gd`）的 17 种运算。
 *
 * - 长度与形状尺寸同单位；角度为六万分之一度，三角函数的输入与 `at2` 的输出均按此换算。
 * - 求值顺序：内置量，调整值（定义中的缺省值按名称被形状的 `avLst` 覆盖），参数按文档顺序；
 *   后求值的名称可引用先求值的名称，引用未定义的名称取 0。
 * - 除数为 0 时结果取 0，不产生无穷大与非数：路径坐标中出现非数时整条路径无法绘制。
 */

import type { Guide } from './model.ts'

export type GuideValues = ReadonlyMap<string, number>

const ANGLE_UNIT = 60000
const RADIANS = Math.PI / (180 * ANGLE_UNIT)

const ANGLES: Readonly<Record<string, number>> = {
  cd2: 10800000,
  cd4: 5400000,
  cd8: 2700000,
  '3cd4': 16200000,
  '3cd8': 8100000,
  '5cd8': 13500000,
  '7cd8': 18900000,
}

const DIVIDED = /^(wd|hd|ssd)(\d+)$/
const NUMBER = /^-?\d+(\.\d+)?$/

/** 内置量：`w`、`h`、`l`、`t`、`r`、`b`、`hc`、`vc`、`ss`、`ls`、`wdN`、`hdN`、`ssdN` 与角度常量。 */
function builtin(name: string, w: number, h: number): number | undefined {
  switch (name) {
    case 'w':
    case 'r':
      return w
    case 'h':
    case 'b':
      return h
    case 'l':
    case 't':
      return 0
    case 'hc':
      return w / 2
    case 'vc':
      return h / 2
    case 'ss':
      return Math.min(w, h)
    case 'ls':
      return Math.max(w, h)
  }
  const angle = ANGLES[name]
  if (angle !== undefined) return angle
  const m = DIVIDED.exec(name)
  if (m === null) return undefined
  const base = m[1] === 'wd' ? w : m[1] === 'hd' ? h : Math.min(w, h)
  const n = Number(m[2])
  return n === 0 ? 0 : base / n
}

function divide(a: number, b: number): number {
  return b === 0 ? 0 : a / b
}

/** 按公式原文求值；`lookup` 取名称的值。未知运算取 0。 */
export function evaluateFormula(formula: string, lookup: (name: string) => number): number {
  const tokens = formula.trim().split(/\s+/)
  const op = tokens[0] ?? ''
  const arg = (i: number): number => {
    const t = tokens[i + 1]
    if (t === undefined) return 0
    return NUMBER.test(t) ? Number(t) : lookup(t)
  }
  const x = arg(0)
  switch (op) {
    case 'val':
      return x
    case '*/':
      return divide(x * arg(1), arg(2))
    case '+-':
      return x + arg(1) - arg(2)
    case '+/':
      return divide(x + arg(1), arg(2))
    case '?:':
      return x > 0 ? arg(1) : arg(2)
    case 'abs':
      return Math.abs(x)
    case 'at2':
      return Math.atan2(arg(1), x) / RADIANS
    case 'cat2':
      return x * Math.cos(Math.atan2(arg(2), arg(1)))
    case 'sat2':
      return x * Math.sin(Math.atan2(arg(2), arg(1)))
    case 'cos':
      return x * Math.cos(arg(1) * RADIANS)
    case 'sin':
      return x * Math.sin(arg(1) * RADIANS)
    case 'tan':
      return x * Math.tan(arg(1) * RADIANS)
    case 'max':
      return Math.max(x, arg(1))
    case 'min':
      return Math.min(x, arg(1))
    case 'mod':
      return Math.sqrt(x * x + arg(1) * arg(1) + arg(2) * arg(2))
    case 'pin': {
      const y = arg(1)
      const lo = x
      const hi = arg(2)
      return y < lo ? lo : y > hi ? hi : y
    }
    case 'sqrt':
      return Math.sqrt(Math.max(0, x))
    default:
      return 0
  }
}

/**
 * 求出全部名称的值。`defaults` 为定义中的调整值，`overrides` 为形状 `avLst` 中的调整值（按名称覆盖），
 * `guides` 为参数。
 */
export function evaluateGuides(
  defaults: readonly Guide[],
  overrides: readonly Guide[],
  guides: readonly Guide[],
  width: number,
  height: number,
): GuideValues {
  const values = new Map<string, number>()
  const lookup = (name: string): number => values.get(name) ?? builtin(name, width, height) ?? 0
  const put = (g: Guide) => {
    const v = evaluateFormula(g.formula, lookup)
    values.set(g.name, Number.isFinite(v) ? v : 0)
  }
  const overridden = new Map(overrides.map((g) => [g.name, g]))
  for (const g of defaults) put(overridden.get(g.name) ?? g)
  for (const g of overrides) if (!values.has(g.name)) put(g)
  for (const g of guides) put(g)
  return values
}

/** 名称或字面量的值：字面量原样返回，名称依次查参数与内置量，都没有时为 0。 */
export function guideValue(
  values: GuideValues,
  value: number | string,
  width: number,
  height: number,
): number {
  if (typeof value === 'number') return value
  if (NUMBER.test(value)) return Number(value)
  return values.get(value) ?? builtin(value, width, height) ?? 0
}

/** 六万分之一度换算为弧度。 */
export function angleToRadians(angle: number): number {
  return angle * RADIANS
}
