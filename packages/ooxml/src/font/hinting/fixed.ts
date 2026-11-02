/**
 * TrueType 指令的定点运算：坐标与距离为 26.6（64 = 1 像素），向量分量为 2.14（0x4000 = 1），缩放系数为 16.16。
 *
 * - 乘除一律在绝对值上计算后再还原符号，舍入为四舍五入且远离零；不要改为 `Math.round`，负数的半值会舍向正方向，
 *   左右对称的笔画因此相差 1/64 像素，取整后可能相差 1 像素。
 * - 结果在 2^53 以内精确：坐标不超过 2^24，向量分量不超过 2^15。
 */

/** `a × b / c`，四舍五入；`c` 为 0 时返回 `0x7fffffff`（与正溢出相同）。 */
export function mulDiv(a: number, b: number, c: number): number {
  let s = 1
  if (a < 0) {
    a = -a
    s = -s
  }
  if (b < 0) {
    b = -b
    s = -s
  }
  if (c < 0) {
    c = -c
    s = -s
  }
  const d = c > 0 ? Math.floor((a * b + Math.floor(c / 2)) / c) : 0x7fffffff
  return s < 0 ? -d : d
}

/** `a × b / c`，向零截断。 */
export function mulDivTrunc(a: number, b: number, c: number): number {
  let s = 1
  if (a < 0) {
    a = -a
    s = -s
  }
  if (b < 0) {
    b = -b
    s = -s
  }
  if (c < 0) {
    c = -c
    s = -s
  }
  const d = c > 0 ? Math.floor((a * b) / c) : 0x7fffffff
  return s < 0 ? -d : d
}

/** 16.16 乘法：`a × b / 65536`，四舍五入。 */
export function mulFix(a: number, b: number): number {
  const s = a < 0 !== b < 0 ? -1 : 1
  const d = Math.floor((Math.abs(a) * Math.abs(b) + 0x8000) / 0x10000)
  return s < 0 ? -d : d
}

/** 16.16 除法：`a × 65536 / b`，四舍五入。 */
export function divFix(a: number, b: number): number {
  const s = a < 0 !== b < 0 ? -1 : 1
  const ub = Math.abs(b)
  const d = ub > 0 ? Math.floor((Math.abs(a) * 0x10000 + Math.floor(ub / 2)) / ub) : 0x7fffffff
  return s < 0 ? -d : d
}

/** 与 2.14 数相乘：`a × b / 16384`，四舍五入。 */
export function mulFix14(a: number, b: number): number {
  const s = a < 0 !== b < 0 ? -1 : 1
  const d = Math.floor((Math.abs(a) * Math.abs(b) + 0x2000) / 0x4000)
  return s < 0 ? -d : d
}

/** 26.6 向量与 2.14 单位向量的点积，结果为 26.6，四舍五入。 */
export function dot14(ax: number, ay: number, bx: number, by: number): number {
  const sum = ax * bx + ay * by
  return sum >= 0 ? Math.floor((sum + 0x2000) / 0x4000) : -Math.floor((-sum + 0x2000) / 0x4000)
}

/** 2.14 单位向量。 */
export interface UnitVector {
  x: number
  y: number
}

/** 单位化为 2.14 向量；零向量保持 `out` 不变（规范未定义，取前一个值）。 */
export function normalize(x: number, y: number, out: UnitVector): void {
  if (x === 0 && y === 0) return
  if (x === 0) {
    out.x = 0
    out.y = y > 0 ? 0x4000 : -0x4000
    return
  }
  if (y === 0) {
    out.x = x > 0 ? 0x4000 : -0x4000
    out.y = 0
    return
  }
  const len = Math.hypot(x, y)
  out.x = Math.trunc(Math.round((x * 0x10000) / len) / 4)
  out.y = Math.trunc(Math.round((y * 0x10000) / len) / 4)
}

/** 26.6 的向下、向上取整到整像素。 */
export function pixFloor(v: number): number {
  return Math.floor(v / 64) * 64
}

export function pixCeil(v: number): number {
  return Math.ceil(v / 64) * 64
}

export function pixRound(v: number): number {
  return Math.floor((v + 32) / 64) * 64
}
