/**
 * 画布区的双指缩放。触屏没有滚轮，双指间距的变化按比例缩放，中点的移动同时平移；单指拖动空白处的平移在 `pointer.ts`。
 *
 * - 第二根手指按下时取消进行中的单指操作（拖动节点不提交，框选清除），此后在全部手指离开之前不再响应单指。
 * - 缩放范围与滚轮缩放相同（0.1–3）。
 */

import type { CanvasController } from '../board/controller.ts'

/** 记录按下的手指；第二根手指按下时开始双指缩放并返回 true，此时调用方不再按单指处理。 */
export function touchDown(canvas: CanvasController, e: PointerEvent): boolean {
  canvas.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (canvas.touches.size < 2) return false
  if (canvas.drag?.mode !== 'pinch') {
    if (canvas.drag?.mode === 'move') canvas.setMoving({})
    canvas.setMarquee(null)
    canvas.setGuides([])
    const [a, b] = [...canvas.touches.values()] as [Point, Point]
    const r = canvas.stage.getBoundingClientRect()
    canvas.drag = {
      mode: 'pinch',
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2 - r.left,
      my: (a.y + b.y) / 2 - r.top,
      z: canvas.z(),
      px: canvas.px(),
      py: canvas.py(),
    }
  }
  canvas.stage.setPointerCapture(e.pointerId)
  return true
}

/** 更新手指位置；双指缩放进行中时按两指的间距与中点设置视口并返回 true。 */
export function touchMove(canvas: CanvasController, e: PointerEvent): boolean {
  if (!canvas.touches.has(e.pointerId)) return false
  canvas.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
  const d = canvas.drag
  if (d?.mode !== 'pinch') return false
  const [a, b] = [...canvas.touches.values()] as [Point, Point]
  const r = canvas.stage.getBoundingClientRect()
  const mx = (a.x + b.x) / 2 - r.left
  const my = (a.y + b.y) / 2 - r.top
  const nz = Math.min(3, Math.max(0.1, (d.z * Math.hypot(a.x - b.x, a.y - b.y)) / d.dist))
  canvas.setPx(mx - (d.mx - d.px) * (nz / d.z))
  canvas.setPy(my - (d.my - d.py) * (nz / d.z))
  canvas.setZ(nz)
  return true
}

/** 手指离开。 */
export function touchUp(canvas: CanvasController, e: PointerEvent): void {
  canvas.touches.delete(e.pointerId)
}

interface Point {
  x: number
  y: number
}
