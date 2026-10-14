import type { MediaParamOption } from '../../lib/store/index.ts'

export const PARAM_UNITS: Record<string, string> = {
  duration: '秒',
  durationSeconds: '秒',
  seconds: '秒',
  n: '张',
  rate: '×',
  speed: '×',
  pitch: '×',
}

/** 连续秒数即使接口以字符串枚举声明，也使用数字控件；离散档位保留原有选择。 */
export function numericRange(p: MediaParamOption) {
  if (p.values || p.presets) {
    if (PARAM_UNITS[p.name] !== '秒') return null
    const values = p.values ?? p.presets ?? []
    if (values.length < 2) return null
    const numbers = values.map(Number).sort((a, b) => a - b)
    if (!numbers.every((n, i) => Number.isInteger(n) && (i === 0 || n === numbers[i - 1]! + 1)))
      return null
    return { min: numbers[0]!, max: numbers[numbers.length - 1]!, step: 1 }
  }
  return p.type === 'integer' || p.type === 'number'
    ? { min: p.min, max: p.max, step: p.type === 'integer' ? 1 : 0.1 }
    : null
}

/** 数字控件不改变接口类型，字符串秒数仍提交字符串。 */
export function numericValue(p: MediaParamOption, value: number): string | number | undefined {
  const range = numericRange(p)
  if (!range || !Number.isFinite(value)) return undefined
  if (value === p.auto) return value
  const n = Math.max(range.min ?? -Infinity, Math.min(range.max ?? Infinity, value))
  const rounded = range.step === 1 ? Math.round(n) : Number(n.toFixed(10))
  const choices = p.values ?? p.presets
  return choices ? (choices.find((v) => Number(v) === rounded) as string | number) : rounded
}
