/**
 * 相机与光照的求值：预设表、`rot` 与视角的合成、投影，以及平面对象的光照。实测（WPS 演示导出图，构造的网格图片与
 * 纯色形状，16:9 幻灯片）：
 * - 旋转：形状中心为原点、y 向下、z 指向观察者，点先绕竖直轴转 lon（正值使右侧靠近观察者），再绕水平轴转 lat
 *   （正值使上沿靠近），最后在画面内逆时针转 rev。正交与透视的 12 种组合四角误差不超过 0.45 像素。
 * - `rot` 取代预设的旋转，视角仍取预设（`perspectiveRight` 加 lon 350° 与 lon 350° 的透视相同）；`fov` 只作用于透视，
 *   `zoom` 不改变显示。
 * - 透视：投影中心为形状中心，z 处的点按 D / (D − z) 缩放，D = `PERSPECTIVE_SCALE` / tan(视角 / 2) 像素，与形状尺寸无关
 *   （80 × 60、160 × 120、240 × 180 的形状与视角 10°–120° 的拟合一致）。
 * - 光照：对象所有像素的颜色通道 c 变为 a × c + b（限于 0–255）；a 只取决于光照方案，b 随朝向变化，按 lat、lon 每隔 30°
 *   的实测表双线性插值（超出 ±60° 时取边界值）。光照方向 `dir` 与 rev 不影响结果；`scene3d` 存在时即使不旋转也按此着色。
 *   表为缺省材质 `warmMatte`；材质 `flat` 不着色，其余材质（`matte`、`metal`、`powder` 等正视时颜色不同）未实现。
 * - 棱台：形状正面为单一颜色，棱台不改变外观（矩形、椭圆、圆角矩形，6 种宽高、4 种颜色、6 种光照方案均如此），不另绘制。
 * - 斜二测（`oblique*`）与 `legacy*` 预设不改变形状，颜色另有规则，未实现。
 */

import type { FindingSink } from '../shape/model.ts'
import type { Rotation3D, Scene3D, Shape3D, ThreeD } from './model.ts'

/** 透视距离 D × tan(视角 / 2)，像素。 */
const PERSPECTIVE_SCALE = 595

interface Preset {
  readonly rotation: Rotation3D
  /** 透视的缺省视角（度）；正交为 `null`。 */
  readonly fov: number | null
}

const ISO = 35.26

function preset(lat: number, lon: number, rev: number, fov: number | null = null): Preset {
  return { rotation: { lat, lon, rev }, fov }
}

/**
 * 相机预设：旋转（lat、lon、rev）与视角，取自导出图的拟合。正交投影中 (lat, lon) 与 (−lat, −lon) 的形状相同，
 * 符号按光照与实测颜色一致的一组选取。
 */
const PRESETS: Readonly<Record<string, Preset>> = {
  orthographicFront: preset(0, 0, 0),
  isometricTopUp: preset(ISO, 45, 60),
  isometricTopDown: preset(-ISO, 45, -60),
  isometricBottomUp: preset(ISO, 45, 60),
  isometricBottomDown: preset(ISO, -45, -60),
  isometricLeftUp: preset(ISO, -45, 0),
  isometricLeftDown: preset(ISO, 45, 0),
  isometricRightUp: preset(ISO, -45, 0),
  isometricRightDown: preset(ISO, 45, 0),
  isometricOffAxis1Left: preset(-18, -64.1, 0),
  isometricOffAxis1Right: preset(18.3, -25.6, 0),
  isometricOffAxis1Top: preset(58.8, 53.3, 57.5),
  isometricOffAxis2Left: preset(18.3, 25.7, 0),
  isometricOffAxis2Right: preset(17.9, -64, 0),
  isometricOffAxis2Top: preset(-58.8, 53.4, -57.6),
  isometricOffAxis3Left: preset(17.9, -64, 0),
  isometricOffAxis3Right: preset(18.3, 25.7, 0),
  isometricOffAxis3Bottom: preset(58.8, -53.4, -57.6),
  isometricOffAxis4Left: preset(-18.3, 25.7, 0),
  isometricOffAxis4Right: preset(-18, -64.1, 0),
  isometricOffAxis4Bottom: preset(58.8, 53.3, 57.5),
  perspectiveFront: preset(0, 0, 0, 45),
  perspectiveLeft: preset(0, 20, 0, 45),
  perspectiveRight: preset(0, -20, 0, 45),
  perspectiveAbove: preset(-20, 0, 0, 45),
  perspectiveBelow: preset(20, 0, 0, 45),
  perspectiveAboveLeftFacing: preset(39.3, 14.2, -19, 45),
  perspectiveAboveRightFacing: preset(39.2, -14.3, 18.9, 45),
  perspectiveContrastingLeftFacing: preset(10.5, 43.9, -3.6, 45),
  perspectiveContrastingRightFacing: preset(10.4, -43.9, 3.6, 45),
  perspectiveHeroicLeftFacing: preset(-10.8, 14.4, 2.7, 45),
  perspectiveHeroicRightFacing: preset(-11, -14.1, -2.7, 45),
  perspectiveHeroicExtremeLeftFacing: preset(8.2, 34.5, -2.9, 80),
  perspectiveHeroicExtremeRightFacing: preset(7.9, -34.4, 3, 80),
  perspectiveRelaxed: preset(-50.6, 0, 0, 45),
  perspectiveRelaxedModerately: preset(-35.4, 0, 0, 45),
}

const GRID = [-60, -30, 0, 30, 60] as const

interface Rig {
  readonly scale: number
  /** b，按 lat 行、lon 列（均为 −60、−30、0、30、60）。 */
  readonly add: readonly (readonly number[])[]
}

/** 光照方案：a 与 b 的实测表（灰 64 与灰 192 两区的颜色，正交投影）。 */
const RIGS: Readonly<Record<string, Rig>> = {
  threePt: {
    scale: 1.039,
    add: [
      [2.5, 15.5, 45.5, 53.5, 25.5],
      [0.5, 8.5, 55.5, 71.5, 20.5],
      [0.5, 0.5, 6.5, 9.5, 1.5],
      [6.5, 12.5, 8.5, 1.5, 0.5],
      [22.5, 32.5, 25.5, 11.5, 3.5],
    ],
  },
  contrasting: {
    scale: 0.969,
    add: [
      [0, 0, 0, 0, 0],
      [8, 0, 0, 0, 8],
      [24, 0, 0, 0, 24],
      [8, 0, 0, 0, 8],
      [0, 0, 0, 0, 0],
    ],
  },
  glow: {
    scale: 1.133,
    add: [
      [0, 0, 0, 0, 0],
      [4.5, 0, 0, 0, 6.5],
      [14.5, 0.5, 0, 0.5, 21.5],
      [4.5, 0, 0, 0, 6.5],
      [0, 0, 0, 0, 0],
    ],
  },
  twoPt: {
    scale: 0.977,
    add: [
      [17.5, 21.5, 16.5, 7.5, 2.5],
      [3.5, 5.5, 3.5, 0.5, 0.5],
      [0.5, 0.5, 4.5, 16.5, 6.5],
      [0.5, 1.5, 26.5, 66.5, 33.5],
      [0.5, 3.5, 15.5, 28.5, 18.5],
    ],
  },
}

/** 角度换算到 (−180, 180]。 */
function signed(a: number): number {
  const r = (((a + 180) % 360) + 360) % 360
  return r === 0 ? 180 : r - 180
}

function cell(v: number): { i: number; f: number } {
  const c = Math.min(60, Math.max(-60, v))
  const i = Math.min(3, Math.floor((c + 60) / 30))
  return { i, f: (c - GRID[i]!) / 30 }
}

function lightAdd(rig: Rig, r: Rotation3D): number {
  const a = cell(signed(r.lat))
  const o = cell(signed(r.lon))
  const t = rig.add
  return (
    t[a.i]![o.i]! * (1 - a.f) * (1 - o.f) +
    t[a.i + 1]![o.i]! * a.f * (1 - o.f) +
    t[a.i]![o.i + 1]! * (1 - a.f) * o.f +
    t[a.i + 1]![o.i + 1]! * a.f * o.f
  )
}

/** 已实测的材质：缺省材质按光照表着色，`flat` 不着色。 */
const MATERIALS = new Set(['warmMatte', 'flat'])

/** 绘制端未实现的三维内容：挤出、轮廓、斜二测与 `legacy*` 相机、未实测的光照方案与材质。 */
function unpainted(scene: Scene3D | null, shape: Shape3D | null): boolean {
  if (shape !== null && (shape.extrusion > 0 || shape.contour > 0)) return true
  if (scene === null) return false
  if (PRESETS[scene.camera] === undefined || RIGS[scene.rig] === undefined) return true
  return shape !== null && !MATERIALS.has(shape.material)
}

/**
 * 三维设置的求值。未实现的内容登记一次 `effect3d`：挤出与轮廓照常绘制正面；光照方案未实测时投影照常、不着色；
 * 相机未实现时按平面绘制。没有 `scene3d` 时没有可见变化，返回 `null`。
 */
export function resolveThreeD(
  scene: Scene3D | null,
  shape: Shape3D | null,
  found: FindingSink,
): ThreeD | null {
  if (unpainted(scene, shape)) found.push('effect3d')
  if (scene === null) return null
  const p = PRESETS[scene.camera]
  if (p === undefined) return null
  const rig = shape?.material === 'flat' ? undefined : RIGS[scene.rig]
  const rotation = scene.rotation ?? p.rotation
  const fov = p.fov === null ? null : (scene.fov ?? p.fov)
  const distance =
    fov === null || fov <= 0 || fov >= 180
      ? null
      : PERSPECTIVE_SCALE / Math.tan((fov * Math.PI) / 360)
  if (rig === undefined) return { rotation, distance, scale: 1, add: 0 }
  return { rotation, distance, scale: rig.scale, add: lightAdd(rig, rotation) }
}

/** 文字的三维效果（`bodyPr` 中）绘制端不实现：改变外观时登记（相机不是正视或带旋转，或有棱台、挤出、轮廓）。 */
export function visibleThreeD(scene: Scene3D | null, shape: Shape3D | null): boolean {
  if (shape !== null) {
    if (shape.extrusion > 0 || shape.contour > 0 || shape.top !== null || shape.bottom !== null)
      return true
  }
  if (scene === null) return false
  const r = scene.rotation
  return (
    scene.camera !== 'orthographicFront' ||
    (r !== null && (r.lat !== 0 || r.lon !== 0 || r.rev !== 0))
  )
}

/** 形状局部坐标（像素，原点为框左上角）的投影：`forward` 与其逆 `inverse`；`inverse` 在视线方向上无解时返回 `null`。 */
export interface Projector {
  forward(u: number, v: number): { x: number; y: number }
  inverse(x: number, y: number): { u: number; v: number } | null
}

export function projector(three: ThreeD, width: number, height: number): Projector {
  const rad = Math.PI / 180
  const a = three.rotation.lat * rad
  const b = three.rotation.lon * rad
  const g = -three.rotation.rev * rad
  const [ca, sa, cb, sb, cg, sg] = [
    Math.cos(a),
    Math.sin(a),
    Math.cos(b),
    Math.sin(b),
    Math.cos(g),
    Math.sin(g),
  ]
  // M = Rz(g)·Rx(a)·Ry(b) 的前两列（形状点的 z 为 0）。
  const rx0 = [cb, sa * sb, -ca * sb]
  const rx1 = [0, ca, sa]
  const m00 = cg * rx0[0]! - sg * rx0[1]!
  const m10 = sg * rx0[0]! + cg * rx0[1]!
  const m20 = rx0[2]!
  const m01 = cg * rx1[0]! - sg * rx1[1]!
  const m11 = sg * rx1[0]! + cg * rx1[1]!
  const m21 = rx1[2]!
  const cx = width / 2
  const cy = height / 2
  const D = three.distance
  return {
    forward(u, v) {
      const du = u - cx
      const dv = v - cy
      const qx = m00 * du + m01 * dv
      const qy = m10 * du + m11 * dv
      const k = D === null ? 1 : D / (D + m20 * du + m21 * dv)
      return { x: cx + qx * k, y: cy + qy * k }
    },
    inverse(x, y) {
      const X = x - cx
      const Y = y - cy
      const s = D ?? 1
      const tx = D === null ? 0 : X
      const ty = D === null ? 0 : Y
      const p = s * m00 - tx * m20
      const q = s * m01 - tx * m21
      const r = s * m10 - ty * m20
      const t = s * m11 - ty * m21
      const det = p * t - q * r
      if (Math.abs(det) < 1e-9) return null
      const ex = X * s
      const ey = Y * s
      return { u: cx + (ex * t - q * ey) / det, v: cy + (p * ey - ex * r) / det }
    },
  }
}
