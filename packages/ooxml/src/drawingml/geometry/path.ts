/**
 * 路径展开：把几何定义在给定尺寸下求值为绝对坐标的路径段，供 Canvas 描绘。
 *
 * - 坐标原点为形状左上角，单位与传入的宽高相同；参数在形状尺寸下求值，路径坐标再按
 *   「形状尺寸 ÷ 路径坐标系尺寸」缩放（路径的宽或高为 0 时该方向不缩放）。
 * - `arcTo` 的起始角与摆角是椭圆上的视觉角度：换算为参数角 `atan2(wR·sin θ, hR·cos θ)` 后，
 *   圆心由当前点反推。参数角与视觉角同象限，按此展开可保持多圈摆角的圈数。
 * - 未知的预设名称按矩形处理。
 */

import { angleToRadians, evaluateGuides, type GuideValues, guideValue } from './formula.ts'
import type { CustomGeometry, Geometry, GeometryValue, PathPoint } from './model.ts'
import { presetGeometry } from './preset.ts'

export type PathFill = 'norm' | 'none' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess'

export type Segment =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'line'; readonly x: number; readonly y: number }
  /** Canvas `ellipse` 的参数：角度为弧度，`anticlockwise` 为逆时针（y 轴向下）。终点见 `x`、`y`。 */
  | {
      readonly kind: 'arc'
      readonly cx: number
      readonly cy: number
      readonly rx: number
      readonly ry: number
      readonly start: number
      readonly end: number
      readonly anticlockwise: boolean
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: 'quad'
      readonly x1: number
      readonly y1: number
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: 'cubic'
      readonly x1: number
      readonly y1: number
      readonly x2: number
      readonly y2: number
      readonly x: number
      readonly y: number
    }
  | { readonly kind: 'close' }

export interface ShapePath {
  readonly fill: PathFill
  readonly stroke: boolean
  readonly segments: readonly Segment[]
}

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface ShapeOutline {
  readonly paths: readonly ShapePath[]
  /** 文本矩形；几何未定义时为整个形状。 */
  readonly textRect: Box
}

const RECT: CustomGeometry = presetGeometry('rect')!
const FILLS = new Set<string>(['norm', 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess'])

function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI)
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI
}

/** 视觉角换算为参数角，保持与视觉角之差小于半圈。 */
function parametric(angle: number, rx: number, ry: number): number {
  return angle + wrapPi(Math.atan2(rx * Math.sin(angle), ry * Math.cos(angle)) - angle)
}

function definition(geometry: Geometry): { def: CustomGeometry; overrides: Geometry['adjust'] } {
  if (geometry.kind === 'custom') return { def: geometry, overrides: [] }
  return { def: presetGeometry(geometry.name) ?? RECT, overrides: geometry.adjust }
}

/**
 * 几何在 `width × height` 下的路径与文本矩形。参数在该尺寸下求值；输出坐标再乘以 `unit`
 * （如以 EMU 求值、以像素输出时为 1/9525）。
 */
export function shapeOutline(
  geometry: Geometry,
  width: number,
  height: number,
  unit = 1,
): ShapeOutline {
  const { def, overrides } = definition(geometry)
  const values = evaluateGuides(def.adjust, overrides, def.guides, width, height)
  const v = (x: GeometryValue) => guideValue(values, x, width, height)
  const rect = def.textRect
  const textRect: Box =
    rect === null
      ? { left: 0, top: 0, right: width * unit, bottom: height * unit }
      : {
          left: v(rect.left) * unit,
          top: v(rect.top) * unit,
          right: v(rect.right) * unit,
          bottom: v(rect.bottom) * unit,
        }
  const paths = def.paths.map((p) => {
    const sx = (p.width > 0 ? width / p.width : 1) * unit
    const sy = (p.height > 0 ? height / p.height : 1) * unit
    return {
      fill: (FILLS.has(p.fill) ? p.fill : 'norm') as PathFill,
      stroke: p.stroke,
      segments: segments(p.commands, values, width, height, sx, sy),
    }
  })
  return { paths, textRect }
}

function segments(
  commands: CustomGeometry['paths'][number]['commands'],
  values: GuideValues,
  width: number,
  height: number,
  sx: number,
  sy: number,
): Segment[] {
  const v = (x: GeometryValue) => guideValue(values, x, width, height)
  const px = (p: PathPoint) => v(p.x) * sx
  const py = (p: PathPoint) => v(p.y) * sy
  const out: Segment[] = []
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  for (const c of commands) {
    switch (c.kind) {
      case 'move':
        x = px(c.to)
        y = py(c.to)
        startX = x
        startY = y
        out.push({ kind: 'move', x, y })
        break
      case 'line':
        x = px(c.to)
        y = py(c.to)
        out.push({ kind: 'line', x, y })
        break
      case 'arc': {
        const wR = v(c.widthRadius)
        const hR = v(c.heightRadius)
        const st = angleToRadians(v(c.startAngle))
        const sw = angleToRadians(v(c.swingAngle))
        if (sw === 0) break
        const t0 = parametric(st, wR, hR)
        const t1 = parametric(st + sw, wR, hR)
        const rx = Math.abs(wR * sx)
        const ry = Math.abs(hR * sy)
        const cx = x - rx * Math.cos(t0)
        const cy = y - ry * Math.sin(t0)
        x = cx + rx * Math.cos(t1)
        y = cy + ry * Math.sin(t1)
        out.push({ kind: 'arc', cx, cy, rx, ry, start: t0, end: t1, anticlockwise: sw < 0, x, y })
        break
      }
      case 'quad': {
        const [a, b] = c.points
        if (a === undefined || b === undefined) break
        x = px(b)
        y = py(b)
        out.push({ kind: 'quad', x1: px(a), y1: py(a), x, y })
        break
      }
      case 'cubic': {
        const [a, b, e] = c.points
        if (a === undefined || b === undefined || e === undefined) break
        x = px(e)
        y = py(e)
        out.push({ kind: 'cubic', x1: px(a), y1: py(a), x2: px(b), y2: py(b), x, y })
        break
      }
      case 'close':
        x = startX
        y = startY
        out.push({ kind: 'close' })
        break
    }
  }
  return out
}

export interface Tangent {
  readonly x: number
  readonly y: number
  /** 路径前进方向，弧度。 */
  readonly angle: number
}

function direction(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax)
}

/** 每个可描绘的段：起点、起点处的出射方向、终点、终点处的入射方向。 */
function* pieces(segments: readonly Segment[]): Generator<[Tangent, Tangent]> {
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  for (const s of segments) {
    switch (s.kind) {
      case 'move':
        x = s.x
        y = s.y
        startX = x
        startY = y
        break
      case 'line':
      case 'close': {
        const tx = s.kind === 'line' ? s.x : startX
        const ty = s.kind === 'line' ? s.y : startY
        if (tx !== x || ty !== y) {
          const d = direction(x, y, tx, ty)
          yield [
            { x, y, angle: d },
            { x: tx, y: ty, angle: d },
          ]
        }
        x = tx
        y = ty
        break
      }
      case 'arc': {
        const sign = s.anticlockwise ? -1 : 1
        const tangent = (t: number) =>
          Math.atan2(s.ry * Math.cos(t) * sign, -s.rx * Math.sin(t) * sign)
        yield [
          { x, y, angle: tangent(s.start) },
          { x: s.x, y: s.y, angle: tangent(s.end) },
        ]
        x = s.x
        y = s.y
        break
      }
      case 'quad':
      case 'cubic': {
        const controls =
          s.kind === 'quad'
            ? [[s.x1, s.y1]]
            : [
                [s.x1, s.y1],
                [s.x2, s.y2],
              ]
        const all = [[x, y], ...controls, [s.x, s.y]] as [number, number][]
        const distinct = all.filter((p, i) => i === 0 || p[0] !== x || p[1] !== y)
        const second = distinct[1] ?? [s.x, s.y]
        const before = [...all].reverse().find((p) => p[0] !== s.x || p[1] !== s.y) ?? [x, y]
        yield [
          { x, y, angle: direction(x, y, second[0], second[1]) },
          { x: s.x, y: s.y, angle: direction(before[0], before[1], s.x, s.y) },
        ]
        x = s.x
        y = s.y
        break
      }
    }
  }
}

/** 路径的起点与终点及其切线方向（指向路径前进方向）；没有可描绘的段时为 `null`。 */
export function pathEnds(segments: readonly Segment[]): { start: Tangent; end: Tangent } | null {
  let start: Tangent | null = null
  let end: Tangent | null = null
  for (const [a, b] of pieces(segments)) {
    start ??= a
    end = b
  }
  return start === null || end === null ? null : { start, end }
}
