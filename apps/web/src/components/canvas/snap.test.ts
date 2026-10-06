/**
 * 覆盖 `canvas/snap.ts`：拖动节点时的对齐吸附与对齐线。
 */

import { describe, expect, test } from 'bun:test'
import { boundsOf, snap } from './snap.ts'

const a = { x: 0, y: 0, w: 100, h: 50 }
const b = { x: 300, y: 200, w: 60, h: 40 }

describe('画布：对齐吸附', () => {
  test('外框取一组框的最外边', () => {
    expect(boundsOf([a, b])).toEqual({ x: 0, y: 0, w: 360, h: 240 })
  })

  test('左边、中线、右边各自对齐吸附；水平与竖直两个方向各取最近的一处', () => {
    // 左边相差 4：吸附到 x = 0。
    expect(snap({ x: 4, y: 500, w: 80, h: 30 }, [a], 6)).toMatchObject({ dx: -4, dy: 0 })
    // 水平中线：500 + 15 = 515 与 a 的中线 25 相距过远；竖直中线 x 中心 52 与 a 的 50 相差 2。
    expect(snap({ x: 12, y: 500, w: 80, h: 30 }, [a], 6).dx).toBe(-2)
    // 右边相差 3：吸附到 x = 100。
    expect(snap({ x: 23, y: 500, w: 80, h: 30 }, [a], 6).dx).toBe(-3)
    // 底边对齐顶边：底边 y 为 197，b 的顶边为 200。
    expect(snap({ x: 600, y: 167, w: 20, h: 30 }, [a, b], 6).dy).toBe(3)
  })

  test('超出范围不吸附；两处均在范围内时取更近的一处', () => {
    expect(snap({ x: 10, y: 500, w: 7, h: 30 }, [a], 6)).toEqual({ dx: 0, dy: 0, guides: [] })
    // 相对 b（300 / 330 / 360）：左边 304 相差 4，中线 333 相差 3，右边 362 相差 2，取右边。
    expect(snap({ x: 304, y: 900, w: 58, h: 30 }, [b], 6).dx).toBe(-2)
  })

  test('对齐线绘制在吸附到的坐标上，从最外侧的一端绘制到另一端，覆盖该线上的所有节点', () => {
    const c = { x: 0, y: 900, w: 40, h: 40 }
    const { guides } = snap({ x: 3, y: 400, w: 50, h: 50 }, [a, c], 6)
    expect(guides).toEqual([{ x1: 0, x2: 0, y1: 0, y2: 940 }])
  })
})
