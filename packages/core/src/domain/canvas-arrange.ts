/**
 * 未给出位置的新节点按组排列。只有大模型的操作走到这里：界面的新增操作都带坐标、`beside` 或 `near`。
 *
 * - 组是同一个对象：同一人物的各套服装、同一场景的各个角度、同一场戏的各个镜头。
 * - 同组纵向：一组只占一列，按创建顺序自上而下，不折成多列：折出的列与相邻的组无法区分。
 * - 不同组横向：各组从左到右排列。素材组（组内的卡都没有输入，如人物、场景、道具）在左，
 *   引用素材的组（组内有卡带输入，如分镜、镜头）在素材右侧，连线方向与阅读方向一致。
 * - 时间线放在引用素材的组下方。
 *
 * 已有节点不移动；算出的位置被占用时沿竖直方向顺延到第一个空位。
 */

import type { CanvasDoc, CanvasNode } from './canvas.ts'

/** 相邻卡片之间的间距，横向与纵向相同，组与组之间也相同。 */
export const CARD_GAP = 150
/** 判定占用时额外保留的距离，包含卡片上方的标题行。 */
const TITLE_CLEARANCE = 40

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 依次为 `pending` 中的节点确定位置。调用前这些节点的坐标为 `NaN`，生成卡与文件节点已带 `group`；
 * 连线须已全部写入，组的类别按连线判定。`extentOf` 给出排位时节点占用的框。
 */
export function arrangeNew(
  doc: CanvasDoc,
  pending: readonly string[],
  extentOf: (n: CanvasNode) => Box,
): void {
  for (const id of pending) {
    const node = doc.nodes.find((n) => n.id === id)
    if (!node) continue
    const spot =
      node.type === 'timeline' ? timelineSpot(doc, node, extentOf) : cardSpot(doc, node, extentOf)
    node.x = spot.x
    node.y = spot.y
  }
}

const placed = (n: CanvasNode) => Number.isFinite(n.x) && Number.isFinite(n.y)

function groupOf(n: CanvasNode): string | undefined {
  return n.type === 'timeline' ? undefined : n.group
}

/** 组内有卡带输入时为引用素材的组。同一批中尚未排位的成员一并计入。 */
function consumes(doc: CanvasDoc, group: string): boolean {
  return doc.nodes.some((n) => groupOf(n) === group && doc.edges.some((e) => e.to === n.id))
}

function bounds(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  }
}

/** 已排位、带组的节点按组的类别分为素材区与引用区；时间线计入引用区。 */
function regions(doc: CanvasDoc, extentOf: (n: CanvasNode) => Box) {
  const assets: Box[] = []
  const consumers: Box[] = []
  for (const n of doc.nodes) {
    if (!placed(n)) continue
    if (n.type === 'timeline') consumers.push(extentOf(n))
    const group = groupOf(n)
    if (group === undefined) continue
    ;(consumes(doc, group) ? consumers : assets).push(extentOf(n))
  }
  return { assets: bounds(assets), consumers: bounds(consumers) }
}

/** 画布上还没有带组的节点时，第一组的起点：已有内容右侧，与其顶端对齐；空画布从原点开始。 */
function startOf(doc: CanvasDoc, extentOf: (n: CanvasNode) => Box): { x: number; y: number } {
  const all = bounds(doc.nodes.filter(placed).map(extentOf))
  return all ? { x: all.x + all.w + CARD_GAP, y: all.y } : { x: 0, y: 0 }
}

function cardSpot(
  doc: CanvasDoc,
  node: CanvasNode,
  extentOf: (n: CanvasNode) => Box,
): { x: number; y: number } {
  const size = extentOf({ ...node, x: 0, y: 0 })
  const group = groupOf(node)
  const consumer = group !== undefined && consumes(doc, group)
  const members = doc.nodes
    .filter((n) => n !== node && placed(n) && group !== undefined && groupOf(n) === group)
    .map(extentOf)
  if (members.length) {
    // 接在本组最下方一张的下面。
    const last = members.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a))
    return freeSpot(doc, { ...size, x: last.x, y: last.y + last.h + CARD_GAP }, extentOf)
  }
  const { assets, consumers } = regions(doc, extentOf)
  let at: { x: number; y: number }
  if (consumer) {
    const area = consumers ?? assets
    at = area ? { x: area.x + area.w + CARD_GAP, y: area.y } : startOf(doc, extentOf)
  } else if (assets) {
    at = { x: assets.x + assets.w + CARD_GAP, y: assets.y }
    // 引用区已在素材右侧时，新的素材列放到素材区左侧，不插入两区之间。
    if (consumers && at.x + size.w + CARD_GAP > consumers.x)
      at = { x: assets.x - size.w - CARD_GAP, y: assets.y }
  } else if (consumers) {
    at = { x: consumers.x - size.w - CARD_GAP, y: consumers.y }
  } else {
    at = startOf(doc, extentOf)
  }
  return freeSpot(doc, { ...size, ...at }, extentOf)
}

/** 时间线：引用区（含已有时间线）下方，与引用区左端对齐；没有引用区时放在全部带组节点的下方。 */
function timelineSpot(
  doc: CanvasDoc,
  node: CanvasNode,
  extentOf: (n: CanvasNode) => Box,
): { x: number; y: number } {
  const { assets, consumers } = regions(doc, extentOf)
  const area = consumers ?? assets
  const size = extentOf({ ...node, x: 0, y: 0 })
  if (!area) return freeSpot(doc, { ...size, ...startOf(doc, extentOf) }, extentOf)
  return freeSpot(doc, { ...size, x: area.x, y: area.y + area.h + CARD_GAP }, extentOf)
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
