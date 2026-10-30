/**
 * 覆盖 `canvas/Flow.tsx` 的纯函数：连线曲线（`curveOf` / `pathOf`）与流动虚线的顶点（`flowMesh`）。
 * WebGL 绘制与推进由 `CanvasPanel.test.tsx` 以替身上下文验证，画面在桌面外壳中实测。
 */

import { describe, expect, test } from 'bun:test'
import { curveOf, flowMesh, pathOf } from './Flow.tsx'

const STRIDE = 7

/** 按曲线细分求得的弧长，作为顶点中弧长的对照。 */
function arcLength(c: number[], steps = 20000): number {
  let len = 0
  let px = c[0]!
  let py = c[1]!
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * u * c[0]! + 3 * u * u * t * c[2]! + 3 * u * t * t * c[4]! + t * t * t * c[6]!
    const y = u * u * u * c[1]! + 3 * u * u * t * c[3]! + 3 * u * t * t * c[5]! + t * t * t * c[7]!
    len += Math.hypot(x - px, y - py)
    px = x
    py = y
  }
  return len
}

describe('连线曲线', () => {
  test('控制点从两端水平偏移，偏移至少 40', () => {
    expect(curveOf(0, 0, 400, 100)).toEqual([0, 0, 200, 0, 200, 100, 400, 100])
    expect(curveOf(100, 0, 120, 50)).toEqual([100, 0, 140, 0, 80, 50, 120, 50])
    expect(pathOf(curveOf(0, 0, 400, 100))).toBe('M0 0 C200 0 200 100 400 100')
  })
})

describe('流动虚线的顶点', () => {
  test('每个采样点两侧各一个顶点，每段两个三角形', () => {
    const { vertices, indices } = flowMesh([{ x1: 0, y1: 0, x2: 400, y2: 100 }], 1)
    const points = vertices.length / STRIDE / 2
    expect(Number.isInteger(points)).toBe(true)
    expect(indices.length).toBe((points - 1) * 6)
    expect(Math.max(...indices)).toBe(points * 2 - 1)
  })

  test('弧长从 0 增至曲线全长，渐变参数在两端为 0 与 1，法线为垂直于切线的单位向量', () => {
    const e = { x1: 10, y1: 20, x2: 610, y2: 420 }
    const { vertices } = flowMesh([e], 1)
    const at = (i: number) => vertices.subarray(i * STRIDE, (i + 1) * STRIDE)
    const count = vertices.length / STRIDE
    expect(at(0)[5]).toBe(0)
    expect(at(0)[6]).toBeCloseTo(0, 6)
    expect(at(count - 1)[6]).toBeCloseTo(1, 6)
    expect(at(count - 1)[5]!).toBeCloseTo(arcLength(curveOf(e.x1, e.y1, e.x2, e.y2)), 0)
    for (let i = 2; i < count; i += 2) {
      expect(at(i)[5]!).toBeGreaterThanOrEqual(at(i - 2)[5]!)
      const [x, y, nx, ny] = at(i)
      const [px, py] = at(i - 2)
      expect(Math.hypot(nx!, ny!)).toBeCloseTo(1, 6)
      // 相邻采样点之间的方向与法线近似垂直。
      const dx = x! - px!
      const dy = y! - py!
      expect(Math.abs(dx * nx! + dy * ny!) / Math.hypot(dx, dy)).toBeLessThan(0.05)
    }
    expect(at(0)[4]).toBe(-1)
    expect(at(1)[4]).toBe(1)
  })

  test('段数按缩放后的屏幕长度取，平移不影响', () => {
    const e = { x1: 0, y1: 0, x2: 2000, y2: 300 }
    const near = flowMesh([e], 2).vertices.length
    const far = flowMesh([e], 0.25).vertices.length
    expect(near).toBeGreaterThan(far)
    expect(flowMesh([{ x1: 500, y1: 500, x2: 2500, y2: 800 }], 2).vertices.length).toBe(near)
  })

  test('没有生成中的连线时顶点为空', () => {
    const { vertices, indices } = flowMesh([], 1)
    expect(vertices.length).toBe(0)
    expect(indices.length).toBe(0)
  })
})
