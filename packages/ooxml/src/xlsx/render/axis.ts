/**
 * 一个方向（行或列）上各项的像素尺寸与累计偏移：前缀和加二分查找，只按需访问可见范围。
 *
 * 前 `explicit.length` 项逐项给出尺寸；其后的项默认为 `defaultSize`，`runs` 中的区段（两端都含）覆盖默认值。
 * Excel 的行数与列数上限（1048576、16384）由 `count` 表示，不逐项存储。
 */

export interface AxisRun {
  readonly from: number
  readonly to: number
  readonly size: number
}

interface Segment {
  readonly from: number
  readonly size: number
  /** 本段第一项的起始偏移。 */
  readonly start: number
}

export class Axis {
  /** `prefix[i]` 为第 `i` 项的起始偏移，`prefix[n]` 为前 n 项之和。 */
  private readonly prefix: Float64Array
  /** 自 `explicit.length` 起按起点升序排列、首尾相接的分段。 */
  private readonly segments: readonly Segment[]
  readonly count: number

  constructor(
    explicit: ArrayLike<number>,
    defaultSize: number,
    runs: readonly AxisRun[],
    count: number,
  ) {
    const n = Math.min(explicit.length, count)
    this.count = count
    this.prefix = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) this.prefix[i + 1] = this.prefix[i]! + explicit[i]!
    // 各区段与默认值合并为首尾相接的分段。
    const points: { from: number; size: number }[] = [{ from: n, size: defaultSize }]
    for (const r of [...runs].sort((a, b) => a.from - b.from)) {
      const from = Math.max(r.from, n)
      if (r.to < from || from >= count) continue
      points.push({ from, size: r.size })
      if (r.to + 1 < count) points.push({ from: r.to + 1, size: defaultSize })
    }
    points.sort((a, b) => a.from - b.from)
    const segments: Segment[] = []
    let start = this.prefix[n]!
    for (const p of points) {
      const prev = segments.at(-1)
      if (prev && prev.from === p.from) {
        segments[segments.length - 1] = { from: p.from, size: p.size, start: prev.start }
        continue
      }
      if (prev) start = prev.start + (p.from - prev.from) * prev.size
      segments.push({ from: p.from, size: p.size, start })
    }
    this.segments = segments
  }

  private get explicitCount(): number {
    return this.prefix.length - 1
  }

  size(i: number): number {
    if (i < 0 || i >= this.count) return 0
    if (i < this.explicitCount) return this.prefix[i + 1]! - this.prefix[i]!
    return this.segmentAt(i).size
  }

  /** 第 `i` 项的起始偏移；`i` 等于 `count` 时为总长。 */
  offset(i: number): number {
    if (i <= 0) return 0
    if (i <= this.explicitCount) return this.prefix[i]!
    const k = Math.min(i, this.count)
    const seg = this.segmentAt(k - 1)
    return seg.start + (k - seg.from) * seg.size
  }

  get total(): number {
    return this.offset(this.count)
  }

  /** 包含偏移 `px` 的项。超出范围时夹到首项或末项；落在尺寸为 0 的项上时返回其前一个可见项。 */
  indexAt(px: number): number {
    if (px < 0) return 0
    const n = this.explicitCount
    if (px < this.prefix[n]!) {
      let lo = 0
      let hi = n - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1
        if (this.prefix[mid]! <= px) lo = mid
        else hi = mid - 1
      }
      return lo
    }
    for (let k = this.segments.length - 1; k >= 0; k--) {
      const seg = this.segments[k]!
      if (px < seg.start) continue
      const end = this.segments[k + 1]?.from ?? this.count
      if (seg.size <= 0) return Math.max(0, seg.from - 1)
      return Math.min(end - 1, seg.from + Math.floor((px - seg.start) / seg.size))
    }
    return this.count - 1
  }

  private segmentAt(i: number): Segment {
    const list = this.segments
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (list[mid]!.from <= i) lo = mid
      else hi = mid - 1
    }
    return list[lo]!
  }
}
