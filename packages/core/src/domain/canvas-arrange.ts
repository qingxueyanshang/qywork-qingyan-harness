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
 * 算出的位置被占用时沿竖直方向顺延到第一个空位。已有节点只在三种情况下移动：同列中为插入让位；
 * 新卡比所在列宽时右侧各列让开；卡片改变尺寸后随之移开或移回（`keepSpacing`）。三者使用同一套规则（`follow`）。
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
 * 按卡片当前的框排位，不为结果的形状预留空间：出图改变形状后由 `keepSpacing` 保持间距。
 */
export function arrangeNew(doc: CanvasDoc, pending: readonly string[]): void {
  for (const id of pending) {
    const node = doc.nodes.find((n) => n.id === id)
    if (!node) continue
    const size = { w: node.w, h: node.h }
    const at = spotOf(doc, node)
    node.x = at.x
    node.y = at.y
    // 新卡比所在列宽时，右侧各列与出图变大时一样整列让开；不让开时新卡会绕到右侧一列的卡下面。
    // 必须先于下方的移动：右侧一列尚未让开时与新卡横向重叠，会被当作下方的节点一起下移。
    const lane = laneRight(doc, node, at.x)
    if (lane !== null && at.x + size.w > lane) {
      follow(doc, node, { x: at.x, y: at.y, w: lane - at.x, h: size.h }, 'right')
    }
    // 插在同一对象之后：相当于上方多出这张卡与一个间距。以插入点上方一个间距处、高为 0 的框为原框，
    // 下方的节点（含界面放置的节点）按原间距下移，同列的卡仍相隔 `CARD_GAP`。
    if (at.insert) follow(doc, node, { x: at.x, y: at.y - CARD_GAP, w: size.w, h: 0 }, 'down')
    const spot = freeSpot(doc, { ...size, x: at.x, y: at.y }, node)
    node.x = spot.x
    node.y = spot.y
  }
}

/** `node` 所在列中横坐标为 `x` 的其他卡的右缘；没有这样的卡（新的一列）时为 `null`。 */
function laneRight(doc: CanvasDoc, node: CanvasNode, x: number): number | null {
  const column = columnOf(node)
  const mates = doc.nodes.filter(
    (n) => n !== node && placed(n) && n.x === x && column !== undefined && columnOf(n) === column,
  )
  return mates.length ? Math.max(...mates.map((n) => n.x + n.w)) : null
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
 * 新卡的位置。本对象已有卡时插在其最下方一张之后（`insert`，下方的节点由 `arrangeNew` 下移）；
 * 本列已有卡时接在列的末尾；否则在全部已有内容右侧另起一列，空画布从原点开始。
 */
function spotOf(doc: CanvasDoc, node: CanvasNode): { x: number; y: number; insert: boolean } {
  const others = doc.nodes.filter((n) => n !== node && placed(n))
  const column = columnOf(node)
  const members = column === undefined ? [] : others.filter((n) => columnOf(n) === column)
  if (members.length) {
    const subject = subjectOf(node)
    const same = subject === undefined ? [] : members.filter((n) => subjectOf(n) === subject)
    const last = lowest(same.length ? same : members)
    return { x: last.x, y: last.y + last.h + CARD_GAP, insert: same.length > 0 }
  }
  if (!others.length) return { x: 0, y: 0, insert: false }
  return {
    x: Math.max(...others.map((b) => b.x + b.w)) + CARD_GAP,
    y: Math.min(...others.map((b) => b.y)),
    insert: false,
  }
}

function lowest(boxes: readonly Box[]): Box {
  return boxes.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a))
}

/** 从 `box` 开始向下查找 `self` 的空位：与已排位的其他节点相交时移到该节点下方相隔 `CARD_GAP` 处。 */
function freeSpot(doc: CanvasDoc, box: Box, self: CanvasNode): { x: number; y: number } {
  const others = doc.nodes.filter((n) => n !== self && placed(n))
  let { y } = box
  for (;;) {
    const hit = others.find((n) => intersects(n, { ...box, y }))
    if (!hit) return { x: box.x, y }
    y = hit.y + hit.h + CARD_GAP
  }
}

/** 两个框是否相交，计入卡片上方的标题行。 */
function intersects(a: Box, b: Box): boolean {
  return spans(a.x, a.w, b.x, b.w) && spans(a.y, a.h, b.y, b.h)
}

/** 两段区间（起点与长度）是否重叠，计入 `TITLE_CLEARANCE`。 */
function spans(a: number, al: number, b: number, bl: number): boolean {
  return a < b + bl + TITLE_CLEARANCE && a + al + TITLE_CLEARANCE > b
}

/** 一次修改中改变了尺寸的卡与它修改前的尺寸。 */
export interface Resized {
  id: string
  w: number
  h: number
}

/** 修改前后都存在、位置未变而尺寸改变的节点。界面添加的卡与画布排列的卡相同。 */
export function resizedCards(before: CanvasDoc, after: CanvasDoc): Resized[] {
  const prior = new Map(before.nodes.map((n) => [n.id, n]))
  return after.nodes.flatMap((n) => {
    const was = prior.get(n.id)
    if (!was || !placed(n) || was.x !== n.x || was.y !== n.y) return []
    return n.w !== was.w || n.h !== was.h ? [{ id: n.id, w: was.w, h: was.h }] : []
  })
}

/**
 * 节点改变尺寸后，右侧与下方的节点随之移动，间距保持为原间距与 `CARD_GAP` 中的较小者。
 * 卡片按当前框排位、不为结果的形状预留空间，出图改变形状后由此保持间距。
 *
 * - 变大时推开：间距不足的节点移开，被移开的节点继续推开它右侧或下方的节点。
 * - 变小时收回：原间距不超过 `CARD_GAP`、紧挨着已移动节点的节点随之移回，但与其他相对的节点仍不小于各自的原间距
 *   与 `CARD_GAP` 中的较小者；间距大于 `CARD_GAP` 的节点不动。
 * - 向右时带组的节点与同列、同横坐标的卡整列移动，保持列内对齐；向下时逐个移动。
 * - 界面放置的卡与画布排列的卡规则相同：变大时同样推开相邻的节点，也同样被推开。
 */
export function keepSpacing(doc: CanvasDoc, resized: readonly Resized[]): void {
  for (const r of resized) {
    const node = doc.nodes.find((n) => n.id === r.id)
    if (!node || !placed(node)) continue
    if (node.w !== r.w) follow(doc, node, { x: node.x, y: node.y, w: r.w, h: node.h }, 'right')
    if (node.h !== r.h) follow(doc, node, { x: node.x, y: node.y, w: node.w, h: r.h }, 'down')
  }
}

/**
 * `changed` 的框由 `was` 改为当前框之后，起点在 `was` 远端以外的节点按起点由近到远依次确定位移：
 * 取所有相对且移动前位于它之前的节点给出的下限（该节点现在的远端加上原间距与 `CARD_GAP` 中的较小者）中的最大值。
 * 下限大于当前位置时前移；小于当前位置且它紧挨着一个已移动的节点时后移；否则不动。
 */
function follow(doc: CanvasDoc, changed: CanvasNode, was: Box, along: 'right' | 'down'): void {
  const right = along === 'right'
  const lead = (b: Box) => (right ? b.x : b.y)
  const trail = (b: Box) => (right ? b.x + b.w : b.y + b.h)
  /**
   * 是否相对：与移动方向垂直的一侧重叠，向右时比较纵向，向下时比较横向。
   * 向右时两者都带组即相对：各列向下生长，只按纵向判定时，变宽的卡会占住右侧一列下方的位置，
   * 之后补进该列的卡绕到它下面，列内间距不再是 `CARD_GAP`。
   */
  const facing = (a: CanvasNode, b: CanvasNode) =>
    right
      ? spans(a.y, a.h, b.y, b.h) || (groupOf(a) !== undefined && groupOf(b) !== undefined)
      : spans(a.x, a.w, b.x, b.w)
  // 移动之前的框：下限按原间距计算。
  const origin = new Map<string, Box>(doc.nodes.map((n) => [n.id, { ...n }]))
  origin.set(changed.id, was)
  const shifted = (n: CanvasNode) => trail(n) !== trail(origin.get(n.id)!)
  const ahead = doc.nodes
    .filter((n) => n !== changed && placed(n) && lead(n) >= trail(was))
    .sort((a, b) => lead(a) - lead(b))
  const done = new Set<string>()
  for (const n of ahead) {
    if (done.has(n.id)) continue
    const unit = right ? columnMates(doc, n) : [n]
    for (const b of unit) done.add(b.id)
    let shift = Number.NEGATIVE_INFINITY
    let attached = false
    for (const b of unit) {
      const ob = origin.get(b.id)!
      for (const l of doc.nodes) {
        if (unit.includes(l) || !placed(l)) continue
        const ol = origin.get(l.id)!
        if (lead(ob) < trail(ol) || !facing(l, b)) continue
        const gap = lead(ob) - trail(ol)
        shift = Math.max(shift, trail(l) + Math.min(gap, CARD_GAP) - lead(ob))
        if (gap <= CARD_GAP && shifted(l)) attached = true
      }
    }
    if (!Number.isFinite(shift) || shift === 0 || (shift < 0 && !attached)) continue
    for (const b of unit) {
      if (right) b.x += shift
      else b.y += shift
    }
  }
}

/** 与 `n` 同列且横坐标相同的节点（含 `n`）；没有组的节点单独移动。 */
function columnMates(doc: CanvasDoc, n: CanvasNode): CanvasNode[] {
  const column = columnOf(n)
  if (column === undefined) return [n]
  return doc.nodes.filter((m) => placed(m) && m.x === n.x && columnOf(m) === column)
}
