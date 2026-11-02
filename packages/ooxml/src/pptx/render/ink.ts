/**
 * 墨迹绘制：每条笔画按相邻两点画圆头线段，线宽取两点笔宽的平均值；只有一点的笔画画为直径等于笔宽的圆点。
 * 坐标与笔宽见 `../resolve/ink.ts`。笔画不透明，线段重叠处不影响颜色。
 */

import { colorToCss } from '../../drawingml/color.ts'
import { type Matrix, type PaintContext, setMatrix } from '../../drawingml/paint/context.ts'
import { EMU_PER_PX } from '../../drawingml/shape/paint.ts'
import type { Ink } from '../model.ts'

/** `matrix` 为形状框局部坐标（96 dpi 像素，原点为形状框左上角）到设备坐标。 */
export function paintInk(ctx: PaintContext, ink: Ink, matrix: Matrix): void {
  setMatrix(ctx, matrix)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of ink.strokes) {
    const css = colorToCss(stroke.color)
    const pts = stroke.points
    if (pts.length === 1) {
      const p = pts[0]!
      ctx.fillStyle = css
      ctx.beginPath()
      ctx.ellipse(
        p.x / EMU_PER_PX,
        p.y / EMU_PER_PX,
        p.width / EMU_PER_PX / 2,
        p.width / EMU_PER_PX / 2,
        0,
        0,
        2 * Math.PI,
        false,
      )
      ctx.fill()
      continue
    }
    ctx.strokeStyle = css
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!
      const b = pts[i]!
      ctx.lineWidth = (a.width + b.width) / 2 / EMU_PER_PX
      ctx.beginPath()
      ctx.moveTo(a.x / EMU_PER_PX, a.y / EMU_PER_PX)
      ctx.lineTo(b.x / EMU_PER_PX, b.y / EMU_PER_PX)
      ctx.stroke()
    }
  }
}
