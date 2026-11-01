/**
 * 三维饼图的几何与着色。规则取自 WPS 对照图（校准文件实测，经验拟合）：
 *
 * - 底面直径 D = min(W − 11.5, (H − 11.1) / (0.647 + 0.088 h), (H − 10) / (sin θ + cos θ × h / 6))，
 *   W、H 为绘图区宽高（扣除数据标签的预留），θ 为 `rotX`，h 为 `hPercent` / 100；厚度为 D × h / 6。
 *   透视（`rAngAx` 为假）时 D 再乘 1 − 0.0008 p（p 为 `perspective` 的值）；有扇区分离时再除以 1 + e / 2
 *   （e 为最大分离比例，一组实测：e = 0.2 时缩小约 9%）。
 * - 正投影下顶面为椭圆，长半轴 D / 2，短半轴 D / 2 × sin θ；侧面投影高度为 厚度 × cos θ。图形整体在绘图区居中。
 * - 透视按针孔投影：相机距中心 L = 2.37 R / tan(p / 4 °)，近处放大 L / (L − 深度)，纵向再乘 1 − 0.0006 p
 *   （p = 30 时顶面前缘距圆心 1.05 倍、后缘 0.95 倍）。
 * - 第一个扇区从 12 点方向（远端）起，按 `rotY` 顺时针旋转，扇区顺时针排列（俯视）。
 * - 着色：顶面各通道为 1.04 c + 6（通道值按 0–255 计）；侧面为 c × k(u)，u 为相对圆心的水平位置（以半径计），
 *   k 取 `SIDE_SHADE`（在 u = −0.2 处最亮），与倾角无关；c 为扇区颜色的通道值。扇区分离时露出的径向侧面取 c × 0.36。
 */

import type { Color } from '../color.ts'
import type { ShapeFill } from '../fill.ts'
import type { View3D } from './model.ts'

export interface Pie3D {
  /** 底面半径（像素）。 */
  readonly r: number
  /** 厚度（像素，三维长度）。 */
  readonly thickness: number
  readonly cx: number
  /** 顶面中心的纵坐标（正投影）。 */
  readonly cy: number
  readonly sin: number
  readonly cos: number
  /** 相机距离；正投影为 `Infinity`。 */
  readonly distance: number
  readonly squash: number
}

/** 绘图区（扣除标签预留后为 `w`、`h`）中的三维饼图几何。 */
export function pieGeometry(
  view: View3D,
  x: number,
  y: number,
  w: number,
  h: number,
  reserve: number,
  explosion: number,
): Pie3D {
  const theta = (Math.min(90, Math.max(0, view.rotX)) * Math.PI) / 180
  const sin = Math.sin(theta)
  const cos = Math.cos(theta)
  const hp = Math.max(0, view.heightPercent) / 100
  const W = w - reserve
  const H = h - reserve
  const p = view.rightAngle ? 0 : Math.max(0, view.perspective)
  let d = Math.min(W - 11.5, (H - 11.1) / (0.647 + 0.088 * hp), (H - 10) / (sin + (cos * hp) / 6))
  d = Math.max(2, (d * (1 - 0.0008 * p)) / (1 + Math.max(0, explosion) / 2))
  const r = d / 2
  const thickness = (d * hp) / 6
  const total = d * sin + thickness * cos
  const distance = p > 0 ? (2.37 * r) / Math.tan((p / 4) * (Math.PI / 180)) : Infinity
  return {
    r,
    thickness,
    cx: x + w / 2,
    cy: y + h / 2 - total / 2 + r * sin,
    sin,
    cos,
    distance,
    squash: 1 - 0.0006 * p,
  }
}

/** 顶面角度 `a`（自 12 点方向顺时针，弧度）、半径 `radius`、高度 `z`（顶面为 0，向下为负）处的点的投影。 */
export function project(
  g: Pie3D,
  a: number,
  radius: number,
  z: number,
  ox = 0,
  oz = 0,
): { x: number; y: number } {
  const X = Math.sin(a) * radius + ox
  const Z = -Math.cos(a) * radius + oz
  const depth = Z * g.cos + z * g.sin
  const k = Number.isFinite(g.distance) ? g.distance / (g.distance - depth) : 1
  return { x: g.cx + X * k, y: g.cy + (Z * g.sin - z * g.cos) * k * g.squash }
}

function mapColors(fill: ShapeFill, f: (c: Color) => Color): ShapeFill {
  if (fill.kind === 'solid') return { ...fill, color: f(fill.color) }
  if (fill.kind === 'gradient')
    return { ...fill, stops: fill.stops.map((s) => ({ ...s, color: f(s.color) })) }
  return fill
}

/** 通道值为 0–1。 */
function channel(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function scaled(c: Color, k: number, add = 0): Color {
  return { r: channel(c.r * k + add), g: channel(c.g * k + add), b: channel(c.b * k + add), a: c.a }
}

export function topFill(fill: ShapeFill): ShapeFill {
  return mapColors(fill, (c) => scaled(c, 1.04, 6 / 255))
}

export function wallFill(fill: ShapeFill): ShapeFill {
  return mapColors(fill, (c) => scaled(c, 0.36))
}

/** 侧面的亮度系数：u = −1, −0.9, …, 1 处的实测值（两端为外推）。 */
const SIDE_SHADE = [
  0.55, 0.643, 0.786, 0.886, 0.956, 1.0, 1.034, 1.055, 1.061, 1.056, 1.041, 1.014, 0.979, 0.931,
  0.872, 0.797, 0.711, 0.6, 0.462, 0.26, 0.1,
]

/** 侧面填充：纯色扇区按水平位置着色（自左至右的线性渐变，范围为底面直径）；其余填充不变。 */
export function sideFill(fill: ShapeFill): ShapeFill {
  if (fill.kind !== 'solid') return fill
  const stops = SIDE_SHADE.map((k, i) => ({ position: i / 20, color: scaled(fill.color, k) }))
  return {
    kind: 'gradient',
    stops,
    shade: { kind: 'linear', angle: 0, scaled: false },
    flip: 'none',
    rotateWithShape: true,
  }
}
