/**
 * 未给出位置的新节点按组排列。只有大模型的操作走到这里：界面的新增操作都带坐标、`beside` 或 `near`。
 *
 * - 组名决定列：「类别/对象」中斜杠前是列，如「角色/沈砚」「角色/顾衡」同在「角色」列；没有斜杠时整个组名是列，
 *   如「山门·分镜」。
 * - 同列纵向：按创建顺序自上而下。同一对象的卡片在列中相连：后补的卡接在该对象最下方一张之后，
 *   列中位于其下方的卡整体下移；新对象接在列的末尾。
 * - 不同列横向：新的列放在全部已有内容的右侧，与顶端对齐，按创建顺序从左到右；每条时间线单独成一列。
 *
 * 各列只向下生长，新列只出现在最右侧，因此后加的卡不会被其他列挡住。
 * 不要按「组内有没有输入」把列分到左右两区：同一人物的服装变体常以基础定妆图为参考，
 * 按输入分区时该人物会被当作分镜，其他列被移到它的左侧。素材先于引用它的分镜创建，按创建顺序已位于分镜左侧。
 *
 * 除同列中为插入让位的卡之外，已有节点不移动；算出的位置被占用时沿竖直方向顺延到第一个空位。
 */

import type { CanvasDoc, CanvasNode } from './canvas.ts'

/** 相邻卡片之间的间距，横向与纵向相同，列与列之间也相同。 */
export const CARD_GAP = 100
/** 判定占用时额外保留的距离，包含卡片上方的标题行。 */
const TITLE_CLEARANCE = 40

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 依次为 `pending` 中的节点确定位置。调用前这些节点的坐标为 `NaN`，生成卡与文件节点已带 `group`。
 * `extentOf` 给出排位时节点占用的框。
 */
export function arrangeNew(
  doc: CanvasDoc,
  pending: readonly string[],
  extentOf: (n: CanvasNode) => Box,
): void {
  for (const id of pending) {
    const node = doc.nodes.find((n) => n.id === id)
    if (!node) continue
    const size = extentOf({ ...node, x: 0, y: 0 })
    const spot = freeSpot(doc, { ...size, ...spotOf(doc, node, size, extentOf) }, extentOf)
    node.x = spot.x
    node.y = spot.y
  }
}

const placed = (n: CanvasNode) => Number.isFinite(n.x) && Number.isFinite(n.y)

function groupOf(n: CanvasNode): string | undefined {
  return n.type === 'timeline' ? undefined : n.group
}

/** 组名中的列：斜杠前的部分，没有斜杠时为整个组名。 */
function columnOf(n: CanvasNode): string | undefined {
  const group = groupOf(n)
  if (group === undefined) return undefined
  const slash = group.indexOf('/')
  return slash < 0 ? group : group.slice(0, slash)
}

/** 组名中列内的对象：斜杠后的部分，没有斜杠时没有对象。 */
function subjectOf(n: CanvasNode): string | undefined {
  const group = groupOf(n)
  if (group === undefined) return undefined
  const slash = group.indexOf('/')
  return slash < 0 ? undefined : group.slice(slash + 1)
}

/**
 * 新卡的位置。本对象已有卡时插在其最下方一张之后，并把列中下方的卡整体下移；
 * 本列已有卡时接在列的末尾；否则在全部已有内容右侧另起一列，空画布从原点开始。
 */
function spotOf(
  doc: CanvasDoc,
  node: CanvasNode,
  size: Box,
  extentOf: (n: CanvasNode) => Box,
): { x: number; y: number } {
  const others = doc.nodes.filter((n) => n !== node && placed(n))
  const column = columnOf(node)
  const members = column === undefined ? [] : others.filter((n) => columnOf(n) === column)
  if (members.length) {
    const subject = subjectOf(node)
    const same = subject === undefined ? [] : members.filter((n) => subjectOf(n) === subject)
    const last = lowest((same.length ? same : members).map(extentOf))
    const y = last.y + last.h + CARD_GAP
    if (same.length) {
      for (const n of members) if (extentOf(n).y >= y) n.y += size.h + CARD_GAP
    }
    return { x: last.x, y }
  }
  const boxes = others.map(extentOf)
  if (!boxes.length) return { x: 0, y: 0 }
  return {
    x: Math.max(...boxes.map((b) => b.x + b.w)) + CARD_GAP,
    y: Math.min(...boxes.map((b) => b.y)),
  }
}

function lowest(boxes: readonly Box[]): Box {
  return boxes.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a))
}

/** 从 `box` 开始向下查找空位：与已排位的节点相交时移到该节点下方相隔 `CARD_GAP` 处。 */
function freeSpot(
  doc: CanvasDoc,
  box: Box,
  extentOf: (n: CanvasNode) => Box,
): { x: number; y: number } {
  const others = doc.nodes.filter(placed).map(extentOf)
  let { y } = box
  for (;;) {
    const hit = others.find((n) => intersects(n, { ...box, y }))
    if (!hit) return { x: box.x, y }
    y = hit.y + hit.h + CARD_GAP
  }
}

/** 两个框是否相交，计入卡片上方的标题行。 */
function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w + TITLE_CLEARANCE &&
    a.x + a.w + TITLE_CLEARANCE > b.x &&
    a.y < b.y + b.h + TITLE_CLEARANCE &&
    a.y + a.h + TITLE_CLEARANCE > b.y
  )
}
