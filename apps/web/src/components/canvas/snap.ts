/**
 * 拖动节点时的对齐吸附：移动中的一组节点（取外框）向其余节点的左、中、右与上、中、下对齐。
 * 纯函数，坐标均为画布坐标。
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 一条对齐线（画布坐标），竖线 `x1 === x2`、横线 `y1 === y2`。 */
export interface Guide {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 判定已对齐的容差：吸附后坐标经过取整与缩放，相差半个单位以内视为同一条线。 */
const SAME = 0.5

/** 一组框的外框。 */
export function boundsOf(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const b = Math.max(...boxes.map((n) => n.y + n.h))
  return { x, y, w: r - x, h: b - y }
}

const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w]
const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h]

/** 一个方向上距离最近且不超过 `reach` 的对齐位置：返回需要补偿的位移与对齐到的坐标；没有时返回 null。 */
function nearest(
  mine: number[],
  theirs: number[],
  reach: number,
): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null
  for (const m of mine) {
    for (const t of theirs) {
      const shift = t - m
      if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, at: t }
      }
    }
  }
  return best
}

/**
 * 外框 `box` 向 `others` 吸附：水平与竖直两个方向各取最近的一处（不超过 `reach`），返回补偿的位移与需要绘制的对齐线。
 * 对齐线绘制在吸附到的坐标上，从外框与该线上所有节点中最外侧的一端，绘制到另一端的最外侧。
 */
export function snap(
  box: Box,
  others: readonly Box[],
  reach: number,
): { dx: number; dy: number; guides: Guide[] } {
  const x = nearest(xs(box), others.flatMap(xs), reach)
  const y = nearest(ys(box), others.flatMap(ys), reach)
  const dx = x?.shift ?? 0
  const dy = y?.shift ?? 0
  const moved = { ...box, x: box.x + dx, y: box.y + dy }
  const guides: Guide[] = []
  if (x) {
    const on = [moved, ...others.filter((o) => xs(o).some((v) => Math.abs(v - x.at) < SAME))]
    guides.push({
      x1: x.at,
      x2: x.at,
      y1: Math.min(...on.map((o) => o.y)),
      y2: Math.max(...on.map((o) => o.y + o.h)),
    })
  }
  if (y) {
    const on = [moved, ...others.filter((o) => ys(o).some((v) => Math.abs(v - y.at) < SAME))]
    guides.push({
      y1: y.at,
      y2: y.at,
      x1: Math.min(...on.map((o) => o.x)),
      x2: Math.max(...on.map((o) => o.x + o.w)),
    })
  }
  return { dx, dy, guides }
}
