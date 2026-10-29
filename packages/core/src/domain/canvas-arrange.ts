/**
 * 未给出位置的新节点与改换了组的节点按组排列。只有大模型的操作走到这里：界面的新增操作都带坐标、`beside` 或 `near`。
 *
 * - 组名决定列：「类别/对象」中斜杠前是列，如「角色/沈砚」「角色/顾衡」同在「角色」列；没有斜杠时整个组名是列，
 *   如「文本」。
 * - 同列纵向：按创建顺序自上而下。同一对象的卡片在列中相连：后补的卡接在该对象最下方一行之后，
 *   列中位于其下方的卡整体下移；新对象接在列的末尾。
 * - 提示词卡与生成卡成行：同组、以文本连线连到生成卡的文件卡（`labelOf`）排在该生成卡左侧的同一行，
 *   列分为左侧的提示词与右侧的生成卡两栏，行高取该行较高的卡。同一列的卡上下移动时整行一起移动。
 * - 不同列横向：新的列放在全部已有内容的右侧，与顶端对齐，按创建顺序从左到右；每条时间线单独成一列。
 * - 视频列（有视频生成卡的列）按对象名的数字顺序排行，满一定行数后在右侧另起一栏（`arrangeShots`）。
 *
 * 各列只向下生长，新列只出现在最右侧，因此后加的卡不会被其他列挡住。
 * 不要按「组内有没有输入」把列分到左右两区：同一人物的服装变体常以基础定妆图为参考，
 * 按输入分区时该人物会被当作分镜，其他列被移到它的左侧。素材先于引用它的分镜创建，按创建顺序已位于分镜左侧。
 *
 * 算出的位置被占用时沿竖直方向顺延到第一个空位。已有节点只在以下情况下移动：同列中为插入让位；
 * 新卡比所在栏宽或新开一栏时右侧各列让开；卡片改变尺寸后随之移开或移回（`keepSpacing`）；带组的卡被删除或换组后，
 * 同列下方的卡上移补上空位（`closeGaps`）；排成网格或按栏重排后，右侧与下方的节点让开或移回（`arrangeGrid`、
 * `arrangeColumn`）。这些情况使用同一套规则（`follow`），界面删除的卡同样适用。
 */

import type { CanvasDoc, CanvasNode } from './canvas.ts'

/** 相邻卡片之间的间距，横向与纵向相同，列与列之间也相同。 */
export const CARD_GAP = 48
/** 判定占用时额外保留的距离，包含卡片上方的标题行。 */
const TITLE_CLEARANCE = 40
/** 按名称排序：名称中的数字按数值比较，P2 在 P10 之前，镜头 1-2 在 1-10 之前。 */
export const NAME_ORDER = new Intl.Collator('zh', { numeric: true })

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 带组的卡被删除或换组后空出的框；`group` 为删除或换组之前的组，同列的卡按它补上空位。 */
export interface Vacated extends Box {
  group?: string
}

/**
 * 依次为 `pending` 中的节点确定位置。调用前这些节点的坐标为 `NaN`，生成卡与文件节点已带 `group`，
 * 文本连线已同步（`labelOf` 按连线配对）。
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
    // 新卡比所在栏宽时，右侧各列与出图变大时一样整列让开；不让开时新卡会绕到右侧一列的卡下面。
    // 新开生成卡一栏时同样让开：右侧的列此前紧挨着提示词一栏。
    // 必须先于下方的移动：右侧一列尚未让开时与新卡横向重叠，会被当作下方的节点一起下移。
    const lane = laneRight(doc, node, at.x)
    if (at.media) {
      // 提示词卡占据生成卡此前所在的位置：生成卡一栏连同右侧各列让开，与新开生成卡一栏时相同。
      // 放入已有的提示词一栏时不移动。
      if (at.x === at.media.x) {
        follow(doc, node, { x: at.x - CARD_GAP, y: at.y, w: 0, h: size.h }, 'right')
      }
    } else if (lane !== null && at.x + size.w > lane) {
      follow(doc, node, { x: at.x, y: at.y, w: lane - at.x, h: size.h }, 'right')
    } else if (lane === null && at.label) {
      follow(doc, node, { x: at.x - CARD_GAP, y: at.y, w: 0, h: size.h }, 'right')
    }
    // 插在同一对象之后：相当于上方多出这张卡与一个间距。以插入点上方一个间距处、高为 0 的框为原框，
    // 下方的节点（含界面放置的节点）按原间距下移，同列的卡仍相隔 `CARD_GAP`。
    if (at.insert) follow(doc, node, { x: at.x, y: at.y - CARD_GAP, w: size.w, h: 0 }, 'down')
    // 与同行的另一张卡成行且比它高：这一行变高，下方各行按差值下移。
    const row = at.label ?? at.media
    if (row && size.h > row.h) {
      follow(doc, node, { x: at.x, y: at.y, w: size.w, h: row.h }, 'down')
    }
    const spot = freeSpot(doc, { ...size, x: node.x, y: node.y }, node)
    node.x = spot.x
    node.y = spot.y
  }
}

/** `node` 所在列中横坐标为 `x` 的其他卡的右缘；没有这样的卡（新的一列或一栏）时为 `null`。 */
function laneRight(doc: CanvasDoc, node: CanvasNode, x: number): number | null {
  const column = columnOf(node)
  const mates = doc.nodes.filter(
    (n) => n !== node && placed(n) && n.x === x && column !== undefined && columnOf(n) === column,
  )
  return mates.length ? Math.max(...mates.map((n) => n.x + n.w)) : null
}

const placed = (n: Box) => Number.isFinite(n.x) && Number.isFinite(n.y)

function groupOf(n: CanvasNode): string | undefined {
  return n.type === 'timeline' ? undefined : n.group
}

/** 组名中的列：斜杠前的部分，没有斜杠时为整个组名。 */
export function columnOfGroup(group: string): string {
  const slash = group.indexOf('/')
  return slash < 0 ? group : group.slice(0, slash)
}

function columnOf(n: CanvasNode): string | undefined {
  const group = groupOf(n)
  return group === undefined ? undefined : columnOfGroup(group)
}

/** 组名中列内的对象：斜杠后的部分，没有斜杠时没有对象。 */
function subjectOf(n: CanvasNode): string | undefined {
  const group = groupOf(n)
  if (group === undefined) return undefined
  const slash = group.indexOf('/')
  return slash < 0 ? undefined : group.slice(slash + 1)
}

/** 生成卡的提示词卡：与它同组、以文本连线连到它的文件卡。有多张时取第一条连线的。 */
function labelOf(doc: CanvasDoc, n: CanvasNode): CanvasNode | undefined {
  if (n.type !== 'generate' || n.group === undefined) return undefined
  for (const e of doc.edges) {
    if (e.to !== n.id || e.role !== 'text') continue
    const from = doc.nodes.find((m) => m.id === e.from)
    if (from?.type === 'file' && from.group === n.group) return from
  }
  return undefined
}

/** 是否为某张生成卡的提示词卡（`labelOf`）。 */
function isLabel(doc: CanvasDoc, n: CanvasNode): boolean {
  if (n.type !== 'file' || n.group === undefined) return false
  return doc.edges.some((e) => {
    if (e.from !== n.id || e.role !== 'text') return false
    const to = doc.nodes.find((m) => m.id === e.to)
    return to?.type === 'generate' && to.group === n.group
  })
}

/**
 * 列中生成卡一栏的横坐标：已有提示词与生成卡成行时沿用该栏，否则在提示词一栏右侧一个间距处。
 * 列中没有提示词卡时为列的左缘。
 */
function mediaX(doc: CanvasDoc, members: readonly CanvasNode[]): number {
  const left = Math.min(...members.map((m) => m.x))
  const labels = members.filter((m) => isLabel(doc, m))
  if (!labels.length) return left
  const paired = members.filter(
    (m) => !isLabel(doc, m) && labels.some((l) => l.y === m.y && l.x < m.x),
  )
  if (paired.length) return Math.min(...paired.map((m) => m.x))
  const lx = Math.min(...labels.map((l) => l.x))
  return lx + Math.max(...labels.filter((l) => l.x === lx).map((l) => l.w)) + CARD_GAP
}

/**
 * 新卡的位置。提示词卡已排好、还没有配对的生成卡时排在它右侧的同一行（`label`）；生成卡已排好、提示词卡后补时排在它左侧的
 * 同一行（`media`）：左侧已有提示词一栏时放入该栏，否则占据生成卡的位置，由 `arrangeNew` 使生成卡一栏及右侧各列让开。
 * 本对象已有卡时插在其最下方一行之后（`insert`，下方的节点由 `arrangeNew` 下移）；本列已有卡时接在列的末尾；
 * 否则在全部已有内容右侧另起一列，空画布从原点开始。列中有提示词卡时，提示词排在左栏，其他卡排在生成卡一栏。
 */
function spotOf(
  doc: CanvasDoc,
  node: CanvasNode,
): { x: number; y: number; insert: boolean; label?: CanvasNode; media?: CanvasNode } {
  const others = doc.nodes.filter((n) => n !== node && placed(n))
  const column = columnOf(node)
  const members = column === undefined ? [] : others.filter((n) => columnOf(n) === column)
  if (members.length) {
    const label = labelOf(doc, node)
    if (label && members.includes(label) && !members.some((m) => labelOf(doc, m) === label)) {
      return { x: mediaX(doc, members), y: label.y, insert: false, label }
    }
    const media = members.find((m) => labelOf(doc, m) === node)
    if (media && !members.some((m) => isLabel(doc, m) && m.y === media.y && m.x < media.x)) {
      return { x: labelLaneOf(doc, members, media) ?? media.x, y: media.y, insert: false, media }
    }
    const subject = subjectOf(node)
    const same = subject === undefined ? [] : members.filter((n) => subjectOf(n) === subject)
    const last = lowest(same.length ? same : members)
    const labels = members.filter((m) => isLabel(doc, m))
    const x = isLabel(doc, node)
      ? labels.length
        ? Math.min(...labels.map((l) => l.x))
        : Math.min(...members.map((m) => m.x))
      : mediaX(doc, members)
    return { x, y: last.y + last.h + CARD_GAP, insert: same.length > 0 }
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

/**
 * 紧挨在 `media` 左侧的提示词一栏的横坐标：右缘加一个间距恰好到达 `media` 的栏。没有时为 `undefined`。
 * 视频列分为多栏时每栏各有一组提示词与生成卡，按右缘定位才能取到同一栏的提示词。
 */
function labelLaneOf(
  doc: CanvasDoc,
  members: readonly CanvasNode[],
  media: CanvasNode,
): number | undefined {
  return members.find((m) => isLabel(doc, m) && m.x + m.w + CARD_GAP === media.x)?.x
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
 * - 向右时带组的节点与同列、同横坐标的卡整栏移动，保持栏内对齐；向下时同列的卡都相对，提示词与生成卡整行移动。
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
 * 带组的卡被删除或移到其他组之后，同列中紧挨在空位下方的卡上移，不留空位；一栏因此不再有卡时，右侧各栏左移，
 * 不留空栏。`vacated` 为空出的框，未排位的跳过。
 *
 * 每个空位以其上方一个间距处、高为 0、带原组的框代替原卡，下方的节点按 `follow` 的收回规则移动，与卡片变小时相同；
 * 带原组使同列另一栏的卡一起上移，提示词与生成卡仍成行。间距大于 `CARD_GAP` 的节点不动。
 * 空位自下而上处理：同一列中先处理上方的空位时，下方空位之下的卡与它不相邻，不会移回。
 * 空栏以其左侧一个间距处、宽为 0 的框代替，右侧的节点同样按 `follow` 的收回规则移动，自右向左处理。
 */
export function closeGaps(doc: CanvasDoc, vacated: readonly Vacated[]): void {
  const gaps = vacated.filter((b) => placed(b)).sort((a, b) => b.y - a.y)
  for (const box of gaps) {
    const gap: CanvasNode = {
      ...ghost(),
      ...(box.group === undefined ? {} : { group: box.group }),
      x: box.x,
      y: box.y - CARD_GAP,
      w: box.w,
      h: 0,
    }
    doc.nodes.push(gap)
    follow(doc, gap, box, 'down')
    doc.nodes.pop()
  }
  const lanes = new Map<string, Vacated>()
  for (const box of gaps) {
    if (box.group === undefined) continue
    const column = columnOfGroup(box.group)
    if (doc.nodes.some((n) => placed(n) && n.x === box.x && columnOf(n) === column)) continue
    const key = `${column}\n${box.x}`
    const lane = lanes.get(key)
    if (!lane || box.w > lane.w) lanes.set(key, box)
  }
  for (const box of [...lanes.values()].sort((a, b) => b.x - a.x)) {
    const gap: CanvasNode = {
      ...ghost(),
      ...(box.group === undefined ? {} : { group: box.group }),
      x: box.x - CARD_GAP,
      y: box.y,
      w: 0,
      h: box.h,
    }
    doc.nodes.push(gap)
    follow(doc, gap, box, 'right')
    doc.nodes.pop()
  }
}

/**
 * 把 `cards` 按给出的顺序排成每行 `perRow` 张的网格，左上角是这些卡原来所占区域的左上角。
 * 列宽取其中最宽的卡，行高取该行最高的卡，间距为 `CARD_GAP`；卡片保持各自的尺寸。
 * 文本卡与 16:9 的生成卡缺省框相同，一组这样的卡排成的各行等高。
 *
 * 网格所占的区域按一张由原区域改变尺寸的卡处理（`settle`）：右侧与下方的节点让开，网格变小时紧挨着的节点移回。
 * 不在 `cards` 中、却位于原区域内部的节点（选出的卡分属不相邻的几列时）不移动。
 */
export function arrangeGrid(doc: CanvasDoc, cards: readonly CanvasNode[], perRow: number): void {
  const grid = cards.filter((n) => placed(n))
  if (!grid.length) return
  const was = boundsOf(grid)
  const cell = Math.max(...grid.map((n) => n.w))
  let y = was.y
  for (let i = 0; i < grid.length; i += perRow) {
    const row = grid.slice(i, i + perRow)
    for (const [k, n] of row.entries()) {
      n.x = was.x + k * (cell + CARD_GAP)
      n.y = y
    }
    y += Math.max(...row.map((n) => n.h)) + CARD_GAP
  }
  settle(doc, grid, was)
}

/** 视频列每栏的缺省行数：镜头不超过 24 个时 6 行，不超过 35 个时 7 行，更多时 8 行。 */
export function shotRows(count: number): number {
  return count <= 24 ? 6 : count <= 35 ? 7 : 8
}

/** 列中的一行：提示词卡与它右侧的生成卡；没有配对的卡单独成行：提示词卡排在左栏，其他卡排在生成卡一栏。 */
interface Row {
  label?: CanvasNode
  media?: CanvasNode
}

/**
 * 把列 `column` 的卡按行重排：行按对象名的数字顺序排列（镜头 1-2 在 1-10 之前），没有对象时按名称，
 * 相同时按创建顺序；每栏 `perColumn` 行，满了在右侧一个间距处另起一栏。左上角是该列重排之前的左上角，
 * 栏宽取各栏中最宽的提示词卡与生成卡，行高取该行较高的卡。重排后右侧与下方的节点让开或移回（`settle`）。
 */
export function arrangeColumn(doc: CanvasDoc, column: string, perColumn: number): void {
  const members = doc.nodes.filter((n) => placed(n) && columnOf(n) === column)
  if (!members.length) return
  const was = boundsOf(members)
  const labels = new Set(members.filter((m) => isLabel(doc, m)))
  const used = new Set<CanvasNode>()
  const rows: Row[] = []
  for (const m of members) {
    if (labels.has(m)) continue
    const label = labelOf(doc, m)
    const own = label && labels.has(label) && !used.has(label) ? label : undefined
    if (own) used.add(own)
    rows.push(own ? { label: own, media: m } : { media: m })
  }
  for (const l of labels) if (!used.has(l)) rows.push({ label: l })
  const head = (r: Row) => (r.media ?? r.label)!
  const keyOf = (r: Row) => subjectOf(head(r)) ?? head(r).name ?? ''
  const index = (r: Row) => doc.nodes.indexOf(head(r))
  rows.sort((a, b) => NAME_ORDER.compare(keyOf(a), keyOf(b)) || index(a) - index(b))
  const widest = (cards: (CanvasNode | undefined)[]) =>
    Math.max(0, ...cards.flatMap((c) => (c ? [c.w] : [])))
  const labelW = widest(rows.map((r) => r.label))
  const mediaW = widest(rows.map((r) => r.media))
  const mediaDx = labelW && mediaW ? labelW + CARD_GAP : 0
  const laneW = mediaDx + (mediaW || labelW)
  for (let k = 0; k * perColumn < rows.length; k++) {
    const x = was.x + k * (laneW + CARD_GAP)
    let y = was.y
    for (const r of rows.slice(k * perColumn, (k + 1) * perColumn)) {
      if (r.label) Object.assign(r.label, { x, y })
      if (r.media) Object.assign(r.media, { x: x + mediaDx, y })
      y += Math.max(r.label?.h ?? 0, r.media?.h ?? 0) + CARD_GAP
    }
  }
  settle(doc, members, was)
}

/**
 * 本批涉及的视频列按 `arrangeColumn` 重排。每栏行数沿用修改前的布局：已分成多栏，
 * 或单栏行数多于缺省值（`arrange` 的 `perColumn` 指定过）时取第一栏的行数；否则按镜头数取缺省值（`shotRows`）。
 */
export function arrangeShots(before: CanvasDoc, doc: CanvasDoc, columns: Iterable<string>): void {
  const isShot = (n: CanvasNode) => n.type === 'generate' && n.output === 'video'
  for (const column of new Set(columns)) {
    const shots = doc.nodes.filter((n) => isShot(n) && columnOf(n) === column)
    if (!shots.length) continue
    const was = before.nodes.filter((n) => isShot(n) && placed(n) && columnOf(n) === column)
    let rows = shotRows(shots.length)
    if (was.length) {
      const first = Math.min(...was.map((n) => n.x))
      const kept = was.filter((n) => n.x === first).length
      if (new Set(was.map((n) => n.x)).size > 1 || kept > shotRows(was.length)) rows = kept
    }
    arrangeColumn(doc, column, rows)
  }
}

/** 重排之后 `cards` 所占的区域按一张由 `was` 改变尺寸的卡处理（`keepSpacing`），右侧与下方的节点让开或移回。 */
function settle(doc: CanvasDoc, cards: readonly CanvasNode[], was: Box): void {
  const all = doc.nodes
  const block: CanvasNode = { ...ghost(), ...boundsOf(cards) }
  doc.nodes = [...all.filter((n) => !cards.includes(n)), block]
  keepSpacing(doc, [{ id: block.id, w: was.w, h: was.h }])
  doc.nodes = all
}

/**
 * 显式 arrange 之后的列间靠拢：左缘不小于 `from` 的带组的各栏与时间线自左向右依次左移，与左侧最近的卡相隔 `CARD_GAP`。
 *
 * `settle` 只收回原间距不超过 `CARD_GAP` 的节点，已经存在的大间距在重排之后保持不变；整理布局时由此消除。
 * 每条时间线单独成一栏（时间线单独占一列）；不带组的其他节点是界面放置的卡，不移动。
 * 左侧的卡带组时一律作为界限（各列向下生长），不带组时只在纵向重叠时作为界限。栏只左移不右移，
 * 左侧没有卡的栏不动。只在显式 arrange 之后执行：自动的视频列重排执行它时，每补一个镜头都会移动用户拖开的列。
 */
export function packLanes(doc: CanvasDoc, from: number): void {
  const lanes = new Map<string, CanvasNode[]>()
  for (const n of doc.nodes) {
    const column = columnOf(n)
    if (!placed(n) || n.x < from) continue
    if (column === undefined && n.type !== 'timeline') continue
    const key = column === undefined ? `\n${n.id}` : `${column}\n${n.x}`
    lanes.set(key, [...(lanes.get(key) ?? []), n])
  }
  for (const lane of [...lanes.values()].sort((a, b) => a[0]!.x - b[0]!.x)) {
    const x = lane[0]!.x
    const top = Math.min(...lane.map((n) => n.y))
    const bottom = Math.max(...lane.map((n) => n.y + n.h))
    const left = doc.nodes.filter(
      (n) =>
        placed(n) &&
        !lane.includes(n) &&
        n.x + n.w <= x &&
        (groupOf(n) !== undefined || spans(n.y, n.h, top, bottom - top)),
    )
    if (!left.length) continue
    const to = Math.max(...left.map((n) => n.x + n.w)) + CARD_GAP
    if (to >= x) continue
    for (const n of lane) n.x = to
  }
}

/** 只在排位计算中临时加入文档的框：id 为空，不与任何节点的 id 相同，计算结束即移除。 */
function ghost(): CanvasNode {
  return { id: '', type: 'file', path: '', x: 0, y: 0, w: 0, h: 0 }
}

function boundsOf(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
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
   * 向下时同列即相对：提示词与生成卡分在两栏、横向不重叠，一张变高时另一栏下方的卡也要下移，各行才保持对齐。
   */
  const facing = (a: CanvasNode, b: CanvasNode) =>
    right
      ? spans(a.y, a.h, b.y, b.h) || (groupOf(a) !== undefined && groupOf(b) !== undefined)
      : spans(a.x, a.w, b.x, b.w) || (columnOf(a) !== undefined && columnOf(a) === columnOf(b))
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
    const unit = right ? columnMates(doc, n, origin) : [n]
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

/**
 * 移动之前与 `n` 同列且横坐标相同的节点（含 `n`）；没有组的节点单独移动。
 *
 * 必须按移动之前的坐标（`origin`）判定：同列先处理的一栏右移后可能恰好落在另一栏的横坐标上，
 * 按当前坐标判定时它会被当作后一栏的成员再移一次，两栏重叠且右侧各列被多推一段。
 */
function columnMates(
  doc: CanvasDoc,
  n: CanvasNode,
  origin: ReadonlyMap<string, Box>,
): CanvasNode[] {
  const column = columnOf(n)
  if (column === undefined) return [n]
  const x = origin.get(n.id)!.x
  return doc.nodes.filter((m) => placed(m) && origin.get(m.id)?.x === x && columnOf(m) === column)
}

/** 画布按列的布局摘要：读取与修改画布的回执据此写明各列位置与列间距，模型据此核对布局。 */
export interface CanvasLayout {
  /**
   * 带组的卡按列汇总，每条时间线单独成一列（`column` 为「时间线 名称」），按左缘排列。
   * `gap` 是与左侧一列右缘的距离，第一列没有；正常为 `CARD_GAP`。
   */
  columns: {
    column: string
    left: number
    right: number
    lanes: number[]
    cards: number
    gap?: number
  }[]
  /** 相交（计入标题行）的两张卡。 */
  overlaps: [CanvasNode, CanvasNode][]
  /** 没有组的卡：界面放置的卡。 */
  loose: CanvasNode[]
}

export function layoutOf(doc: CanvasDoc): CanvasLayout {
  const shown = doc.nodes.filter((n) => placed(n))
  const by = new Map<string, CanvasNode[]>()
  for (const n of shown) {
    const column = n.type === 'timeline' ? `时间线 ${n.name}` : columnOf(n)
    if (column !== undefined) by.set(column, [...(by.get(column) ?? []), n])
  }
  const columns: CanvasLayout['columns'] = [...by.entries()]
    .map(([column, cards]) => ({
      column,
      left: Math.min(...cards.map((n) => n.x)),
      right: Math.max(...cards.map((n) => n.x + n.w)),
      lanes: [...new Set(cards.map((n) => n.x))].sort((a, b) => a - b),
      cards: cards.length,
    }))
    .sort((a, b) => a.left - b.left)
    .map((c, i, all) => (i ? { ...c, gap: c.left - all[i - 1]!.right } : c))
  const overlaps: [CanvasNode, CanvasNode][] = []
  for (const [i, a] of shown.entries()) {
    for (const b of shown.slice(i + 1)) if (intersects(a, b)) overlaps.push([a, b])
  }
  return {
    columns,
    overlaps,
    loose: shown.filter((n) => n.type !== 'timeline' && columnOf(n) === undefined),
  }
}
