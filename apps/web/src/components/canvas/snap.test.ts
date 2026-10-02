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

  test('左对左、中对中、右对右各自吸附；横竖两个方向各取最近的一处', () => {
    // 左边差 4：吸到 x = 0。
    expect(snap({ x: 4, y: 500, w: 80, h: 30 }, [a], 6)).toMatchObject({ dx: -4, dy: 0 })
    // 水平中线：50 + 15 = 65 与 a 的中线 25 不近；竖直中线 x 中心 52 对 a 的 50，差 2。
    expect(snap({ x: 12, y: 500, w: 80, h: 30 }, [a], 6).dx).toBe(-2)
    // 右边差 3：吸到 x = 100。
    expect(snap({ x: 23, y: 500, w: 80, h: 30 }, [a], 6).dx).toBe(-3)
    // 底边对顶边：y 底 197 对 b 顶 200。
    expect(snap({ x: 600, y: 167, w: 20, h: 30 }, [a, b], 6).dy).toBe(3)
  })

  test('超出范围不吸；两处都在范围内取更近的那处', () => {
    expect(snap({ x: 10, y: 500, w: 7, h: 30 }, [a], 6)).toEqual({ dx: 0, dy: 0, guides: [] })
    // 对 b（300 / 330 / 360）：左边 304 差 4，中线 333 差 3，右边 362 差 2：取右边。
    expect(snap({ x: 304, y: 900, w: 58, h: 30 }, [b], 6).dx).toBe(-2)
  })

  test('对齐线画在吸附到的坐标上，从最靠外的一端画到另一端，覆盖这条线上的所有节点', () => {
    const c = { x: 0, y: 900, w: 40, h: 40 }
    const { guides } = snap({ x: 3, y: 400, w: 50, h: 50 }, [a, c], 6)
    expect(guides).toEqual([{ x1: 0, x2: 0, y1: 0, y2: 940 }])
  })
})
