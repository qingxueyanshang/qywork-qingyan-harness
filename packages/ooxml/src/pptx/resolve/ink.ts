/**
 * 墨迹的求值：InkML 笔画的坐标换算到形状框，笔宽按压力换算。
 *
 * - 坐标：全部笔画各点的外接框以同一比例缩放到形状框（`contentPart` 的位置尺寸即该外接框），比例取外接框较长的一边；
 *   外接框退化为一点时各点位于形状框中心。不按 InkML 的单位与分辨率换算：语料中 1046 个墨迹部件的分辨率为
 *   每厘米 28.35，按单位换算比实际位置大 20 倍，而形状框与外接框之比两个方向都是 0.050。
 * - 笔宽：笔刷宽度 ×（0.2 + 1.6 × 压力），没有压力时为笔刷宽度。实测（WPS 演示导出图）：1–14 磅笔刷、压力 0.6 的
 *   笔画粗细为笔刷宽度的 1.09–1.14 倍；5.67 磅笔刷、压力 0.27–0.80 的粗细为 0.64–1.48 倍。`ignorePressure` 不影响粗细。
 */

import type { Frame } from '../../drawingml/shape/model.ts'
import type { InkStroke } from '../model.ts'
import type { RawInkStroke } from '../parse/ink.ts'

const EMU_PER_CM = 360000

export function resolveInk(strokes: readonly RawInkStroke[], frame: Frame): InkStroke[] {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const s of strokes) {
    for (const p of s.points) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  }
  const w = x1 - x0
  const h = y1 - y0
  const k = w >= h ? (w > 0 ? frame.width / w : 0) : frame.height / h
  const ox = w > 0 ? 0 : frame.width / 2
  const oy = h > 0 ? 0 : frame.height / 2
  return strokes.map((s) => ({
    color: s.color,
    points: s.points.map((p) => ({
      x: ox + (p.x - x0) * k,
      y: oy + (p.y - y0) * k,
      width: s.width * EMU_PER_CM * (p.pressure === null ? 1 : 0.2 + 1.6 * p.pressure),
    })),
  }))
}
