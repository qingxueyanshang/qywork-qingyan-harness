/**
 * 数值轴的自动刻度：最小值、最大值与主要单位。规则与 WPS 的显示一致（校准文件实测）：
 *
 * - 数据全部非负时：(最大 − 最小) / 最大 < 1/6 时下限取 最小 − (最大 − 最小) / 2，否则取 0；全部相等时取 0。
 *   数据有负值时下限取 最小 − 5% × (最大 − 最小)。全部非正时与之对称。
 * - 上限取 最大 + 5% × (最大 − 最小)（全部相等时跨度取最大值的绝对值）。上下限再分别向外取整到主要单位的整数倍。
 * - 主要单位取 {1, 2, 5} × 10ⁿ 中使区间数不超过 `maxIntervals` 的最小值；数据全为 0 时范围为 0–1。
 * - 指定了最小值、最大值或主要单位时，该项不再自动计算，其余项按上述规则在指定值的约束下计算。
 */

export interface Scale {
  readonly min: number
  readonly max: number
  readonly major: number
}

export interface ScaleOptions {
  readonly min: number | null
  readonly max: number | null
  readonly major: number | null
  /** 刻度区间数的上限，由坐标轴长度与标签尺寸决定（见 `layout.ts`），不小于 1。 */
  readonly maxIntervals: number
}

const STEPS = [1, 2, 5]
/** 浮点误差的容差：刻度值按主要单位取整时使用。 */
const EPSILON = 1e-9

/** 去掉浮点误差：保留 12 位有效数字。 */
export function clean(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v
  return Number(v.toPrecision(12))
}

function floorTo(v: number, unit: number): number {
  return clean(Math.floor(v / unit + EPSILON) * unit)
}

function ceilTo(v: number, unit: number): number {
  return clean(Math.ceil(v / unit - EPSILON) * unit)
}

/** `{1, 2, 5} × 10ⁿ` 中使 [lo, hi] 取整后的区间数不超过 `max` 的最小单位。 */
export function niceUnit(lo: number, hi: number, max: number): number {
  const range = hi - lo
  if (!(range > 0)) return 1
  const limit = Math.max(1, Math.floor(max))
  let exp = Math.floor(Math.log10(range / limit)) - 1
  for (let guard = 0; guard < 40; guard++, exp++) {
    for (const s of STEPS) {
      const u = clean(s * 10 ** exp)
      const count = Math.round((ceilTo(hi, u) - floorTo(lo, u)) / u)
      if (count <= limit) return u
    }
  }
  return clean(10 ** exp)
}

/** 自动范围（取整前）：见文件头。 */
export function autoRange(dataMin: number, dataMax: number): { lo: number; hi: number } {
  if (dataMin === 0 && dataMax === 0) return { lo: 0, hi: 1 }
  // 全部相等时按跨度为最大值（或最小值）的绝对值处理。
  const span = dataMax === dataMin ? Math.abs(dataMax) : dataMax - dataMin
  if (dataMin >= 0) {
    const lo = dataMax === dataMin || span / dataMax >= 1 / 6 ? 0 : Math.max(0, dataMin - span / 2)
    return { lo, hi: dataMax + 0.05 * span }
  }
  if (dataMax <= 0) {
    const hi = dataMax === dataMin || span / -dataMin >= 1 / 6 ? 0 : Math.min(0, dataMax + span / 2)
    return { lo: dataMin - 0.05 * span, hi }
  }
  return { lo: dataMin - 0.05 * span, hi: dataMax + 0.05 * span }
}

/** 数值轴刻度。`dataMin`、`dataMax` 为参与该轴的全部数据（堆积图为各分类的累计值）。 */
export function valueScale(dataMin: number, dataMax: number, o: ScaleOptions): Scale {
  let { lo, hi } = autoRange(dataMin, dataMax)
  if (o.min !== null) lo = o.min
  if (o.max !== null) hi = o.max
  if (hi <= lo) {
    if (o.max === null) hi = lo + (o.major ?? Math.abs(lo || 1))
    else lo = hi - (o.major ?? Math.abs(hi || 1))
  }
  const major = o.major ?? niceUnit(lo, hi, o.maxIntervals)
  const min = o.min ?? floorTo(lo, major)
  const max = o.max ?? ceilTo(hi, major)
  return { min, max: max > min ? max : clean(min + major), major }
}

/** 从 `min` 起每隔 `major` 的刻度值，不超过 `max`；个数上限防止异常的单位产生过多刻度。 */
export function ticks(s: Scale, limit = 1000): number[] {
  const out: number[] = []
  if (!(s.major > 0)) return [s.min, s.max]
  for (let i = 0; i <= limit; i++) {
    const v = clean(s.min + i * s.major)
    if (v > s.max + s.major * EPSILON) break
    out.push(v)
  }
  return out
}
