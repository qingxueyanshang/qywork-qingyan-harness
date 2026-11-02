/**
 * 字形的提示：字形点与 4 个幻影点装入字形区，按 ppem 缩放后执行字形指令，输出 26.6 的轮廓（原点为提示后的左侧位点）。
 *
 * - 幻影点：左侧位点 (xMin − lsb, 0)、前进点（再加前进宽度）、上方点 (0, yMax + tsb)、下方点（再减纵向前进）。
 *   执行指令前左侧位点与前进点的 x、上下两点的 y 取整到整像素，原始位置（`org`）不取整。没有字形指令时同样取整。
 *   ClearType 绘制（`SizeHinter.clearType`）下 x 方向取整到 1/16 像素（GDI 实测：前进点的初值），y 方向不变。
 * - 组合字形：各分量先按自身的指令提示，再按分量变换与偏移放置；`ROUND_XY_TO_GRID` 的偏移按同样的网格取整。
 *   组合字形自身带指令时，以已放置的分量点为原始坐标（缩放系数 1）再执行一次，执行前清除分量留下的触及标志。
 */

import {
  ARGS_ARE_XY,
  type GlyphOutlines,
  ROUND_XY_TO_GRID,
  SCALED_COMPONENT_OFFSET,
  USE_MY_METRICS,
} from '../outline.ts'
import { mulFix, pixRound } from './fixed.ts'
import { createZone, type ScanSettings, type SizeHinter, TAG_ON } from './interpreter.ts'

/** 纵向度量（字体单位）：上方位与纵向前进。 */
export interface VerticalAdvance {
  readonly topSideBearing: number
  readonly advanceHeight: number
}

/** 提示后的轮廓，坐标为 26.6、y 向上，原点为提示后的左侧位点。 */
export interface HintedOutline {
  readonly xs: Float64Array
  readonly ys: Float64Array
  /** 每点一个字节，1 为落点。 */
  readonly onCurve: Uint8Array
  readonly ends: readonly number[]
  /** 提示后的前进宽度，26.6。 */
  readonly advance: number
  readonly scan: ScanSettings
}

interface Loaded {
  xs: Float64Array
  ys: Float64Array
  on: Uint8Array
  ends: number[]
  /** 幻影点（26.6）：左侧位点与前进点的 x。 */
  pp1x: number
  pp2x: number
  scan: ScanSettings
}

const NO_SCAN: ScanSettings = { scanControl: false, scanType: 0 }
const MAX_DEPTH = 8

/**
 * 提示字形 `glyph`；没有轮廓的字形返回点数为 0 的轮廓。`gridFit` 为假时不执行指令，幻影点不取整（缩放后的轮廓）。
 * 字形数据不合法时抛出 `FontFormatError`。
 */
export function hintGlyph(
  outlines: GlyphOutlines,
  vertical: (glyph: number) => VerticalAdvance,
  size: SizeHinter,
  glyph: number,
  gridFit = true,
): HintedOutline {
  const hint = gridFit && size.ok && !size.disabled
  const g = load(outlines, vertical, size, glyph, hint, 0)
  // `load` 的结果是新建的数组，原地平移到左侧位点。
  const xs = g.xs
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! - g.pp1x
  return {
    xs,
    ys: g.ys,
    onCurve: g.on,
    ends: g.ends,
    advance: g.pp2x - g.pp1x,
    scan: g.scan,
  }
}

function phantom(
  outlines: GlyphOutlines,
  vertical: (glyph: number) => VerticalAdvance,
  glyph: number,
): [number, number, number, number] {
  const b = outlines.bounds(glyph)
  const xMin = b?.xMin ?? 0
  const yMax = b?.yMax ?? 0
  const pp1 = xMin - outlines.leftSideBearing(glyph)
  const v = vertical(glyph)
  const pp3 = yMax + v.topSideBearing
  return [pp1, pp1 + outlines.advance(glyph), pp3, pp3 - v.advanceHeight]
}

function load(
  outlines: GlyphOutlines,
  vertical: (glyph: number) => VerticalAdvance,
  size: SizeHinter,
  glyph: number,
  hint: boolean,
  depth: number,
): Loaded {
  const scale = size.scale
  const [pp1, pp2, pp3, pp4] = phantom(outlines, vertical, glyph)
  const data = outlines.data(glyph)
  if (data === null || data.kind === 'simple') {
    const n = data?.xs.length ?? 0
    const ends = data?.ends ?? []
    const zone = createZone(n + 4, ends)
    for (let i = 0; i < n; i++) {
      zone.orusX[i] = data!.xs[i]!
      zone.orusY[i] = data!.ys[i]!
      zone.tags[i] = data!.onCurve[i]! ? TAG_ON : 0
    }
    zone.orusX[n] = pp1
    zone.orusX[n + 1] = pp2
    zone.orusY[n + 2] = pp3
    zone.orusY[n + 3] = pp4
    for (let i = 0; i < n + 4; i++) {
      zone.orgX[i] = zone.curX[i] = mulFix(zone.orusX[i]!, scale)
      zone.orgY[i] = zone.curY[i] = mulFix(zone.orusY[i]!, scale)
    }
    let scan = NO_SCAN
    if (hint) {
      roundPhantoms(zone.curX, zone.curY, n, size.clearType)
      if (data !== null && data.instructions.length > 0)
        scan = size.hint(zone, data.instructions, false)
    }
    const on = zone.tags.slice(0, n)
    for (let i = 0; i < n; i++) on[i]! &= TAG_ON
    return {
      xs: zone.curX.slice(0, n),
      ys: zone.curY.slice(0, n),
      on,
      ends: [...ends],
      pp1x: zone.curX[n]!,
      pp2x: zone.curX[n + 1]!,
      scan,
    }
  }
  if (depth >= MAX_DEPTH) return empty(pp1, pp2, scale, hint)
  const xs: number[] = []
  const ys: number[] = []
  const on: number[] = []
  const ends: number[] = []
  let metrics: [number, number] | null = null
  let scan = NO_SCAN
  for (const k of data.components) {
    const sub = load(outlines, vertical, size, k.glyph, hint, depth + 1)
    const [a, b, c, d] = k.transform
    const identity = a === 1 && b === 0 && c === 0 && d === 1
    const m = sub.xs.length
    let dx: number
    let dy: number
    if (k.flags & ARGS_ARE_XY) {
      let ox = k.arg1
      let oy = k.arg2
      if (!identity && k.flags & SCALED_COMPONENT_OFFSET) {
        ox = Math.round(a * k.arg1 + c * k.arg2)
        oy = Math.round(b * k.arg1 + d * k.arg2)
      }
      dx = mulFix(ox, scale)
      dy = mulFix(oy, scale)
      if (hint && k.flags & ROUND_XY_TO_GRID) {
        dx = roundX(dx, size.clearType)
        dy = pixRound(dy)
      }
    } else {
      const base = xs.length
      const p1 = k.arg1
      const p2 = k.arg2
      const at = (i: number, axis: 0 | 1) => {
        const x = sub.xs[i]!
        const y = sub.ys[i]!
        if (identity) return axis === 0 ? x : y
        return axis === 0 ? Math.round(a * x + c * y) : Math.round(b * x + d * y)
      }
      dx = p1 < base && p2 < m ? xs[p1]! - at(p2, 0) : 0
      dy = p1 < base && p2 < m ? ys[p1]! - at(p2, 1) : 0
    }
    const offset = xs.length
    for (let i = 0; i < m; i++) {
      const x = sub.xs[i]!
      const y = sub.ys[i]!
      xs.push((identity ? x : Math.round(a * x + c * y)) + dx)
      ys.push((identity ? y : Math.round(b * x + d * y)) + dy)
      on.push(sub.on[i]!)
    }
    for (const e of sub.ends) ends.push(e + offset)
    if (k.flags & USE_MY_METRICS) metrics = [sub.pp1x, sub.pp2x]
    scan = sub.scan
  }
  let pp1x = mulFix(pp1, scale)
  let pp2x = mulFix(pp2, scale)
  if (hint) {
    pp1x = roundX(pp1x, size.clearType)
    pp2x = roundX(pp2x, size.clearType)
  }
  if (metrics !== null) [pp1x, pp2x] = metrics
  if (hint && data.instructions.length > 0 && xs.length > 0) {
    const n = xs.length
    const zone = createZone(n + 4, ends)
    for (let i = 0; i < n; i++) {
      zone.orusX[i] = zone.orgX[i] = zone.curX[i] = xs[i]!
      zone.orusY[i] = zone.orgY[i] = zone.curY[i] = ys[i]!
      zone.tags[i] = on[i]! ? TAG_ON : 0
    }
    const ph = [pp1x, pp2x, pixRound(mulFix(pp3, scale)), pixRound(mulFix(pp4, scale))]
    zone.orusX[n] = zone.orgX[n] = zone.curX[n] = ph[0]!
    zone.orusX[n + 1] = zone.orgX[n + 1] = zone.curX[n + 1] = ph[1]!
    zone.orusY[n + 2] = zone.orgY[n + 2] = zone.curY[n + 2] = ph[2]!
    zone.orusY[n + 3] = zone.orgY[n + 3] = zone.curY[n + 3] = ph[3]!
    scan = size.hint(zone, data.instructions, true)
    for (let i = 0; i < n; i++) {
      xs[i] = zone.curX[i]!
      ys[i] = zone.curY[i]!
      on[i] = zone.tags[i]! & TAG_ON
    }
    pp1x = zone.curX[n]!
    pp2x = zone.curX[n + 1]!
  }
  return {
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    on: Uint8Array.from(on),
    ends,
    pp1x,
    pp2x,
    scan,
  }
}

/** x 方向的取整：单色为整像素，ClearType 为 1/16 像素（26.6 的 4）。 */
function roundX(v: number, clearType: boolean): number {
  return clearType ? Math.floor((v + 2) / 4) * 4 : pixRound(v)
}

function roundPhantoms(xs: Float64Array, ys: Float64Array, n: number, clearType: boolean): void {
  xs[n] = roundX(xs[n]!, clearType)
  xs[n + 1] = roundX(xs[n + 1]!, clearType)
  ys[n + 2] = pixRound(ys[n + 2]!)
  ys[n + 3] = pixRound(ys[n + 3]!)
}

function empty(pp1: number, pp2: number, scale: number, hint: boolean): Loaded {
  const r = (v: number) => (hint ? pixRound(mulFix(v, scale)) : mulFix(v, scale))
  return {
    xs: new Float64Array(0),
    ys: new Float64Array(0),
    on: new Uint8Array(0),
    ends: [],
    pp1x: r(pp1),
    pp2x: r(pp2),
    scan: NO_SCAN,
  }
}
