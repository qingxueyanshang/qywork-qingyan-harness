/**
 * 拖动节点时的对齐吸附：移动中的一组节点（取外框）向其余节点的左、中、右与上、中、下对齐。
 * 纯函数，坐标都是画布坐标。
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

/** 判定「已对齐」的容差：吸附后坐标经过取整与缩放，差半个单位以内算同一条线。 */
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

/** 一个方向上离得最近、且不超过 `reach` 的那一处对齐：回需要补的位移与对齐到的坐标；没有回 null。 */
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
 * 外框 `box` 向 `others` 吸附：横竖两个方向各取最近的一处（不超过 `reach`），回补上的位移与要画的对齐线。
 * 对齐线画在吸附到的那条坐标上，从外框与所有在这条线上的节点里最靠外的一端，画到最靠外的另一端。
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
