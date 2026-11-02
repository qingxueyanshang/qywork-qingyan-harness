/**
 * 单色扫描转换：提示后的轮廓（26.6，y 向上）按 TrueType 的扫描转换规则转为每像素一字节的点阵。
 *
 * - 规则 1、2：像素中心在轮廓内（非零环绕）或恰在轮廓上时着墨。逐行与逐列各取样一次，取并集：
 *   逐行取样时恰在水平边上的中心按半开区间会漏掉，逐列取样补上。
 * - 丢失控制（`ScanSettings` 开启且 SCANTYPE 为 0、1、4、5）：轮廓内的一段区间在扫描线上不含任何像素中心、
 *   且两侧相邻像素都未着墨时，着墨其中一个。简单方式取左侧（逐列时取下方）像素，智能方式取中心离区间中点较近的像素，
 *   距离相等时取左侧（下方）。逐行完成后再逐列处理，逐列时判定的是已有逐行结果的点阵。
 * - 端点短线（stub，SCANTYPE 1、5 不处理）：区间两侧的边所在的单调段在同一轮廓中相接（中间只有平行于扫描线的边），
 *   且扫描线是到达相接处之前的最后一条。此时只有相接处超出扫描线至少半像素、且区间宽度不小于半像素才着墨。
 * - 点阵范围：中心落在控制框内的像素（控制框一侧收缩为空时按舍入误差向一侧补 1 像素）。丢失控制选中的像素在范围之外时
 *   改取范围内的另一个。
 *
 * 实现：边与单调段存放在模块级的类型化数组中，逐次光栅化复用，不在调用之间保留内容；本模块不可重入。
 */

import type { BitmapGlyph } from '../bitmap.ts'
import type { HintedOutline } from './glyph.ts'

/** 曲线展开的容差：展开后的折线与曲线相差不超过 1/16 个 26.6 单位。 */
const FLATNESS = 1 / 16
/** 乘以 1/64 与除以 64 的结果相同（2 的幂，没有舍入），乘法较快。 */
const INV64 = 1 / 64

/** 按需加长的类型化数组；`grow` 保留已有内容。 */
function growF64(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  if (a.length >= n) return a
  const b = new Float64Array(Math.max(n, 2 * a.length))
  b.set(a)
  return b
}

function growI32(a: Int32Array<ArrayBuffer>, n: number): Int32Array<ArrayBuffer> {
  if (a.length >= n) return a
  const b = new Int32Array(Math.max(n, 2 * a.length))
  b.set(a)
  return b
}

/**
 * 折线顶点：各轮廓的顶点依次存放，第 k 个轮廓为 `[starts[k], starts[k + 1])`，首尾顶点相同。
 * `lineX`、`lineY` 为顶点坐标之下（小于该坐标）的最后一条扫描线的序号 Q：扫描线坐标 N = 64Q + 32 为整数，N < a 即
 * N ≤ ⌈a⌉ − 1，整数乘以 1/64 没有舍入。边 [lo, hi) 与序号 Q(lo) + 1 至 Q(hi) 的扫描线相交，Q(lo) = Q(hi) 时不相交。
 */
let px = new Float64Array(256)
let py = new Float64Array(256)
let lineX = new Int32Array(256)
let lineY = new Int32Array(256)
let starts = new Int32Array(16)
let vertexCount = 0
let polyCount = 0

function addVertex(x: number, y: number): void {
  if (vertexCount === px.length) {
    px = growF64(px, vertexCount + 1)
    py = growF64(py, vertexCount + 1)
    lineX = growI32(lineX, vertexCount + 1)
    lineY = growI32(lineY, vertexCount + 1)
  }
  px[vertexCount] = x
  py[vertexCount] = y
  lineX[vertexCount] = Math.floor((Math.ceil(x) - 33) * INV64)
  lineY[vertexCount] = Math.floor((Math.ceil(y) - 33) * INV64)
  vertexCount++
}

/** 各轮廓展开为闭合折线。起点为第一个点；它是控制点时取最后一个点，两者都是控制点时取中点。 */
function flatten(o: HintedOutline): void {
  vertexCount = 0
  polyCount = 0
  let first = 0
  for (const last of o.ends) {
    const n = last - first + 1
    const at = first
    first = last + 1
    if (n < 2) continue
    const xs = o.xs
    const ys = o.ys
    const on = o.onCurve
    const startVertex = vertexCount
    let sx = xs[at]!
    let sy = ys[at]!
    // 起点为第一个点时依次处理第 1 至 n − 1 点与第 0 点，否则依次处理第 0 至 n − 1 点。
    const fromFirst = on[at] !== 0
    if (!fromFirst) {
      if (on[at + n - 1] !== 0) {
        sx = xs[at + n - 1]!
        sy = ys[at + n - 1]!
      } else {
        sx = (xs[at]! + xs[at + n - 1]!) / 2
        sy = (ys[at]! + ys[at + n - 1]!) / 2
      }
    }
    addVertex(sx, sy)
    let cx = sx
    let cy = sy
    let hasControl = false
    let qx = 0
    let qy = 0
    for (let j = 0; j < n; j++) {
      const i = at + (fromFirst ? (j + 1) % n : j)
      const x = xs[i]!
      const y = ys[i]!
      let tx: number
      let ty: number
      if (on[i] !== 0) {
        tx = x
        ty = y
      } else if (hasControl) {
        tx = (qx + x) / 2
        ty = (qy + y) / 2
      } else {
        hasControl = true
        qx = x
        qy = y
        continue
      }
      if (hasControl) {
        // 二次曲线 (cx, cy) → (qx, qy) → (tx, ty) 按容差等分。
        const d = Math.hypot(cx - 2 * qx + tx, cy - 2 * qy + ty)
        const steps = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(d / (4 * FLATNESS)))))
        const x0 = cx
        const y0 = cy
        for (let k = 1; k < steps; k++) {
          const t = k / steps
          const u = 1 - t
          const lx = u * u * x0 + 2 * u * t * qx + t * t * tx
          const ly = u * u * y0 + 2 * u * t * qy + t * t * ty
          if (lx !== cx || ly !== cy) {
            addVertex(lx, ly)
            cx = lx
            cy = ly
          }
        }
      }
      if (tx !== cx || ty !== cy) {
        addVertex(tx, ty)
        cx = tx
        cy = ty
      }
      if (on[i] !== 0) hasControl = false
      else {
        qx = x
        qy = y
      }
    }
    if (hasControl) {
      const d = Math.hypot(cx - 2 * qx + sx, cy - 2 * qy + sy)
      const steps = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(d / (4 * FLATNESS)))))
      const x0 = cx
      const y0 = cy
      for (let k = 1; k < steps; k++) {
        const t = k / steps
        const u = 1 - t
        const lx = u * u * x0 + 2 * u * t * qx + t * t * sx
        const ly = u * u * y0 + 2 * u * t * qy + t * t * sy
        if (lx !== cx || ly !== cy) {
          addVertex(lx, ly)
          cx = lx
          cy = ly
        }
      }
    }
    if (sx !== cx || sy !== cy) addVertex(sx, sy)
    if (vertexCount - startVertex < 3) {
      vertexCount = startVertex
      continue
    }
    if (polyCount + 1 >= starts.length) starts = growI32(starts, polyCount + 2)
    starts[polyCount] = startVertex
    polyCount++
    starts[polyCount] = vertexCount
  }
}

/**
 * 一个扫描方向的边：`a` 为扫描方向坐标，`b` 为沿扫描线的坐标。只列入跨过至少一条扫描线的边，第 `efirst` 至 `elast`
 * 条扫描线与它相交（扫描线坐标 s 满足 `lo ≤ s < hi`）。边按折线的顺序编号；同一扫描线上交点相同时按编号排列。
 * 每条边属于一个单调段（`run`）：沿扫描方向单调的一段轮廓，`runNext` 为同一轮廓中的下一段，`runMin`、`runMax`
 * 为该段在扫描方向上的范围，`runUp` 为 1 时沿轮廓方向坐标递增（段的终点在 `runMax`）。平行于扫描线的边并入当前段，
 * 不跨过扫描线的边只计入单调段的范围。
 */
let ea0 = new Float64Array(256)
let eb0 = new Float64Array(256)
let ea1 = new Float64Array(256)
let eb1 = new Float64Array(256)
let efirst = new Int32Array(256)
let elast = new Int32Array(256)
let erun = new Int32Array(256)
let edgeCount = 0
let runNext = new Int32Array(64)
let runMin = new Float64Array(64)
let runMax = new Float64Array(64)
let runUp = new Int32Array(64)
/** 按第一条相交的扫描线分组（计数排序）：第 `line` 组为 `eorder` 的 `[groupStart[line], groupStart[line + 1])`。 */
let eorder = new Int32Array(256)
let groupStart = new Int32Array(256)
let groupCursor = new Int32Array(256)

/**
 * 按扫描方向建立边表。`axis` 为 1 时扫描线水平（逐行，单调指 y），为 0 时扫描线竖直（逐列，单调指 x）；
 * 第 `line` 条扫描线的坐标为 `64 × (lineOrigin + line) + 32`，共 `lines` 条。`runs` 为假时不建立单调段（只有端点短线
 * 的判定用到）。
 */
function buildEdges(axis: 0 | 1, lines: number, lineOrigin: number, runs: boolean): void {
  const as = axis === 1 ? py : px
  const bs = axis === 1 ? px : py
  const vq = axis === 1 ? lineY : lineX
  const need = vertexCount
  if (ea0.length < need) {
    ea0 = growF64(ea0, need)
    eb0 = growF64(eb0, need)
    ea1 = growF64(ea1, need)
    eb1 = growF64(eb1, need)
    efirst = growI32(efirst, need)
    elast = growI32(elast, need)
    erun = growI32(erun, need)
    eorder = growI32(eorder, need)
  }
  if (runNext.length < need) {
    runNext = growI32(runNext, need)
    runMin = growF64(runMin, need)
    runMax = growF64(runMax, need)
    runUp = growI32(runUp, need)
  }
  if (groupStart.length < lines + 1) {
    groupStart = new Int32Array(lines + 1)
    groupCursor = new Int32Array(lines + 1)
  }
  groupStart.fill(0, 0, lines + 1)
  edgeCount = 0
  let runCount = 0
  for (let k = 0; k < polyCount; k++) {
    const v0 = starts[k]!
    const v1 = starts[k + 1]! - 1
    const firstRun = runCount
    let dir = 0
    let run = -1
    for (let i = v0; i < v1; i++) {
      if (!runs && vq[i] === vq[i + 1]) continue
      const a0 = as[i]!
      const a1 = as[i + 1]!
      if (a0 === a1) continue
      const d = a1 > a0 ? 1 : -1
      const lo = d > 0 ? a0 : a1
      const hi = d > 0 ? a1 : a0
      if (runs) {
        if (run < 0 || d !== dir) {
          run = runCount++
          runMin[run] = lo
          runMax[run] = hi
          runUp[run] = d > 0 ? 1 : 0
          dir = d
        } else {
          if (lo < runMin[run]!) runMin[run] = lo
          if (hi > runMax[run]!) runMax[run] = hi
        }
      }
      let first = (d > 0 ? vq[i]! : vq[i + 1]!) + 1 - lineOrigin
      let last = (d > 0 ? vq[i + 1]! : vq[i]!) - lineOrigin
      if (first < 0) first = 0
      if (last > lines - 1) last = lines - 1
      if (first > last) continue
      const e = edgeCount++
      ea0[e] = a0
      ea1[e] = a1
      eb0[e] = bs[i]!
      eb1[e] = bs[i + 1]!
      efirst[e] = first
      elast[e] = last
      erun[e] = run
      if (first + 1 < lines) groupStart[first + 1]!++
    }
    for (let r = firstRun; r < runCount; r++) runNext[r] = r + 1 < runCount ? r + 1 : firstRun
  }
  for (let g = 1; g < lines; g++) groupStart[g] = groupStart[g]! + groupStart[g - 1]!
  groupCursor.set(groupStart.subarray(0, lines))
  for (let e = 0; e < edgeCount; e++) eorder[groupCursor[efirst[e]!]!++] = e
  groupStart[lines] = edgeCount
}

/** 一条扫描线上的交点与区间，按需加长。 */
let active = new Int32Array(64)
let crossV = new Float64Array(64)
let crossE = new Int32Array(64)
let spanLo = new Float64Array(32)
let spanHi = new Float64Array(32)
let spanFirst = new Int32Array(32)
let spanLast = new Int32Array(32)
let drops = new Int32Array(32)

/**
 * 区间两侧的边构成端点短线且不应补像素（见文件头）。`s` 为扫描线坐标。两段相接处是前一段的终点；
 * 相接处在扫描方向的最大（最小）一侧，且 `s` 是到达该处之前的最后（最先）一条扫描线时为端点短线。
 */
function stub(span: number, s: number): boolean {
  const a = erun[spanFirst[span]!]!
  const b = erun[spanLast[span]!]!
  const before = runNext[a] === b ? a : runNext[b] === a ? b : -1
  if (before < 0) return false
  const wide = spanHi[span]! - spanLo[span]! >= 32
  if (runUp[before]) {
    const max = runMax[before]!
    return s + 64 > max && !(max - s >= 32 && wide)
  }
  const min = runMin[before]!
  return s - 64 < min && !(s - min >= 32 && wide)
}

/**
 * 逐条扫描线取非零环绕的区间并着墨。扫描线 `line` 上第 `cell` 个像素在 `pixels` 中的下标为 `base + line × lineStep +
 * cell × cellStep`。交点按坐标升序、坐标相同时按边的编号排列。
 */
function sweep(
  pixels: Uint8Array,
  lines: number,
  cells: number,
  lineOrigin: number,
  cellOrigin: number,
  base: number,
  lineStep: number,
  cellStep: number,
  dropout: boolean,
  smart: boolean,
  stubs: boolean,
): void {
  if (active.length < edgeCount) {
    active = new Int32Array(edgeCount)
    crossV = new Float64Array(edgeCount)
    crossE = new Int32Array(edgeCount)
  }
  if (spanLo.length < edgeCount) {
    spanLo = new Float64Array(edgeCount)
    spanHi = new Float64Array(edgeCount)
    spanFirst = new Int32Array(edgeCount)
    spanLast = new Int32Array(edgeCount)
    drops = new Int32Array(edgeCount)
  }
  let activeCount = 0
  for (let line = 0; line < lines; line++) {
    const s = 64 * (lineOrigin + line) + 32
    for (let i = groupStart[line]!, end = groupStart[line + 1]!; i < end; i++)
      active[activeCount++] = eorder[i]!
    // 去掉已越过的边，计算其余各边的交点并按（坐标，编号）插入排序。
    let kept = 0
    let crossCount = 0
    for (let i = 0; i < activeCount; i++) {
      const e = active[i]!
      if (elast[e]! < line) continue
      active[kept++] = e
      const a0 = ea0[e]!
      const b0 = eb0[e]!
      const v = b0 + ((s - a0) * (eb1[e]! - b0)) / (ea1[e]! - a0)
      let j = crossCount++
      while (j > 0 && (crossV[j - 1]! > v || (crossV[j - 1] === v && crossE[j - 1]! > e))) {
        crossV[j] = crossV[j - 1]!
        crossE[j] = crossE[j - 1]!
        j--
      }
      crossV[j] = v
      crossE[j] = e
    }
    activeCount = kept
    if (crossCount === 0) continue
    let spanCount = 0
    let w = 0
    let start = -1
    for (let i = 0; i < crossCount; i++) {
      const e = crossE[i]!
      const before = w
      w += ea1[e]! > ea0[e]! ? 1 : -1
      if (before === 0 && w !== 0) start = i
      else if (before !== 0 && w === 0 && start >= 0) {
        spanLo[spanCount] = crossV[start]!
        spanHi[spanCount] = crossV[i]!
        spanFirst[spanCount] = crossE[start]!
        spanLast[spanCount] = e
        spanCount++
      }
    }
    const lineBase = base + line * lineStep
    let dropCount = 0
    for (let k = 0; k < spanCount; k++) {
      const c0 = Math.ceil((spanLo[k]! - 32) * INV64) - cellOrigin
      const c1 = Math.floor((spanHi[k]! - 32) * INV64) - cellOrigin
      if (c0 <= c1) {
        const from = c0 > 0 ? c0 : 0
        const to = c1 < cells - 1 ? c1 : cells - 1
        if (cellStep === 1) pixels.fill(1, lineBase + from, lineBase + to + 1)
        else for (let c = from; c <= to; c++) pixels[lineBase + c * cellStep] = 1
      } else if (dropout && !(stubs && stub(k, s))) drops[dropCount++] = k
    }
    for (let k = 0; k < dropCount; k++) {
      const span = drops[k]!
      const lo0 = spanLo[span]!
      const hi = Math.ceil((lo0 - 32) * INV64) - cellOrigin
      const lo = hi - 1
      let c = smart ? Math.floor(((lo0 + spanHi[span]!) / 2 - 0.5) * INV64) - cellOrigin : lo
      if (c < 0) c = hi
      else if (c >= cells) c = lo
      const other = c === hi ? lo : hi
      if (other >= 0 && other < cells && pixels[lineBase + other * cellStep] !== 0) continue
      if (c >= 0 && c < cells) pixels[lineBase + c * cellStep] = 1
    }
  }
}

/** 控制框按「中心落在框内的像素」取整的范围 `[lo, hi)`（像素）。 */
function pixelRange(min: number, max: number): [number, number] {
  let lo = (min + 31) >> 6
  let hi = (max + 32) >> 6
  if (lo === hi) {
    if (((min + 31) & 63) - 31 + ((max + 32) & 63) - 32 < 0) lo -= 1
    else hi += 1
  }
  return [lo, hi]
}

/** 光栅化提示后的轮廓。`advance` 为提示后的前进宽度（像素，取整）。 */
export function rasterize(o: HintedOutline): BitmapGlyph {
  const advance = Math.round(o.advance / 64)
  if (o.xs.length === 0) {
    return { width: 0, height: 0, bearingX: 0, bearingY: 0, advance, pixels: new Uint8Array(0) }
  }
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (let i = 0; i < o.xs.length; i++) {
    const x = o.xs[i]!
    const y = o.ys[i]!
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
    if (y < yMin) yMin = y
    if (y > yMax) yMax = y
  }
  const [left, right] = pixelRange(xMin, xMax)
  const [bottom, top] = pixelRange(yMin, yMax)
  const width = right - left
  const height = top - bottom
  const pixels = new Uint8Array(width * height)
  flatten(o)
  const { scanControl, scanType } = o.scan
  const dropout =
    scanControl && (scanType === 0 || scanType === 1 || scanType === 4 || scanType === 5)
  const smart = scanType >= 4
  const stubs = scanType === 1 || scanType === 5
  // 点阵自上而下存放：自下而上第 k 行、第 c 列的下标为 (height − 1 − k) × width + c。
  const bottomRow = (height - 1) * width
  buildEdges(1, height, bottom, dropout && stubs)
  sweep(pixels, height, width, bottom, left, bottomRow, -width, 1, dropout, smart, stubs)
  buildEdges(0, width, left, dropout && stubs)
  sweep(pixels, width, height, left, bottom, bottomRow, 1, -width, dropout, smart, stubs)
  return { width, height, bearingX: left, bearingY: top, advance, pixels }
}
