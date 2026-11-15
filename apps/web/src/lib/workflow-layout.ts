/**
 * 任务派发图卡片的排列与连线。只由图的结构、图宽与测得的节点矩形决定，不读取 DOM，不依赖组件。
 */

const WF_NODE_MAX = 160
const WF_LAYER_GAP = 12
/**
 * 节点的最小宽度：左右内边距与边框 26px + 四个汉字的名称 48px + 8px 间距 +
 * 最长的种类名称「外部 CLI」44px。
 */
const WF_NODE_MIN = 128

/** 相邻两条竖向通道的间距，也是最靠近节点的通道与节点边缘的距离。 */
const WF_TRACK = 6
/** 同一层间空白中相邻两条横线的间距。 */
const WF_LANE = 8
/** 换行的层中，连线在节点上方或下方转向处与节点边缘的距离。必须小于层间空白中最近一条横线与节点的距离 13px。 */
const WF_HOOK = 8
/** 换行的层中，连线进入节点上边、离开节点下边的位置与节点左、右边缘的距离。 */
const WF_PORT = 14
/** 两条不相连的连线相交处，竖线在横线上下各断开的长度。必须小于 `WF_LANE` 的一半：相邻横线的断口不相接。 */
const WF_JUMP = 3

interface WorkflowWireNode {
  key: string
  needs: readonly string[]
}

/** 一个节点在图中的位置与它使用的通道。通道编号从最靠近节点的一条起算，-1 表示该项不适用。 */
interface WorkflowWirePlace {
  layer: number
  /** 节点上方有同层其他行时，输入线经节点左侧的通道下行；否则为 -1，输入线进入节点上边中点。 */
  inTrack: number
  /** 节点下方有同层其他行时，输出线经节点右侧的通道下行；否则为 -1，输出线由节点下边中点引出。 */
  outTrack: number
}

/** 图的排列与连线分配。只由图的结构与图宽决定，不依赖测量。 */
export interface WorkflowWirePlan {
  layers: {
    /** 每行的节点数。小于该层节点数时该层换行。 */
    cols: number
    wrapped: boolean
    /** 一列节点左侧、右侧通道数的最大值，决定列间距与两侧留白。 */
    inTracks: number
    outTracks: number
  }[]
  places: Map<string, WorkflowWirePlace>
  /** 依赖集合相同的同层节点共用一组连线：`sources` 全部连接到 `targets`。 */
  nets: { sources: string[]; targets: string[]; layer: number }[]
  /**
   * 共用一条输出线的上游：换行的层中同一列、下游完全相同的节点，其余情况为单个节点。
   * `feeds` 是它通向的各组连线在 `nets` 中的下标；`rails` 与之一一对应，
   * 是通向不相邻的层时在图右侧占用的通道编号，相邻层为 -1。
   */
  bundles: { sources: string[]; layer: number; feeds: number[]; rails: number[] }[]
  /** 图右侧为跨层连线留出的通道数。 */
  rails: number
}

/** 换行的层的列间距与两侧留白：列间容纳左列的输出通道与右列的输入通道。 */
function workflowChannels(layer: { wrapped: boolean; inTracks: number; outTracks: number }) {
  if (!layer.wrapped) return { gap: WF_LAYER_GAP, left: 0, right: 0 }
  return {
    // 左列的输出通道与右列的输入通道之间多留一条通道的宽度，两组竖线不显示为双线。
    gap: Math.max(WF_LAYER_GAP, (layer.inTracks + layer.outTracks + 2) * WF_TRACK),
    left: layer.inTracks ? (layer.inTracks + 1) * WF_TRACK : 0,
    right: layer.outTracks ? (layer.outTracks + 1) * WF_TRACK : 0,
  }
}

/** 图右侧为跨层连线留出的宽度。 */
export const workflowRailWidth = (rails: number) => (rails ? (rails + 1) * WF_TRACK : 0)

/**
 * 决定每层的列数，并为换行的层分配节点两侧的通道。
 *
 * 图宽不足以按 `WF_NODE_MIN` 并排一层的全部节点时，该层分为多行，各行节点数尽量相等，
 * 各行按同一组列对齐：列间空白是连线下行的通道，行与行错开后通道被节点阻断。
 * `width` 为 0 表示尚未测量，此时不换行。
 *
 * 同一列的节点共用一条通道的条件是依赖完全相同（输入）或下游完全相同（输出）；否则每个节点
 * 各用一条。输入通道按行自上而下由近到远排列，输出通道相反：转向节点的横线只越过已经结束或
 * 尚未开始的通道，不与其他连线相交。
 */
export function layoutWorkflowGraph(
  layers: readonly (readonly WorkflowWireNode[])[],
  width: number,
): WorkflowWirePlan {
  const layerOf = new Map<string, number>()
  for (const [li, layer] of layers.entries()) for (const n of layer) layerOf.set(n.key, li)

  const nets: WorkflowWirePlan['nets'] = []
  const netOf = new Map<string, number>()
  const feeds = new Map<string, number[]>()
  const netIds = new Map<string, number>()
  for (const [li, layer] of layers.entries()) {
    for (const n of layer) {
      const sources = n.needs.filter((key) => (layerOf.get(key) ?? li) < li).sort()
      if (sources.length === 0) continue
      const id = `${li}:${JSON.stringify(sources)}`
      let index = netIds.get(id)
      if (index === undefined) {
        index = nets.length
        netIds.set(id, index)
        nets.push({ sources, targets: [], layer: li })
        for (const s of sources) feeds.set(s, [...(feeds.get(s) ?? []), index])
      }
      nets[index]!.targets.push(n.key)
      netOf.set(n.key, index)
    }
  }
  const far = (key: string, net: number) => nets[net]!.layer > layerOf.get(key)! + 1
  // 右侧通道按「每个上游的每组跨层下游一条」留出宽度：实际分配不多于该数，且该数与列数无关。
  let rails = 0
  for (const [key, list] of feeds) rails += list.filter((net) => far(key, net)).length

  const assign = (layer: readonly WorkflowWireNode[], cols: number) => {
    const inTrack = new Map<string, number>()
    const outTrack = new Map<string, number>()
    let inTracks = 0
    let outTracks = 0
    for (let col = 0; col < cols; col += 1) {
      const column = layer.filter((_, i) => i % cols === col)
      // 每列最上方的节点由上边中点直接进入，最下方的节点由下边中点直接引出，两者不占用通道。
      const fed = column.slice(1).filter((n) => netOf.has(n.key))
      const sameIn = fed.every((n) => netOf.get(n.key) === netOf.get(fed[0]!.key))
      for (const [i, n] of fed.entries()) inTrack.set(n.key, sameIn ? 0 : i)
      inTracks = Math.max(inTracks, sameIn ? Math.min(fed.length, 1) : fed.length)
      const feeding = column.slice(0, -1).filter((n) => feeds.has(n.key))
      const downstream = (n: WorkflowWireNode) => feeds.get(n.key)!.join(',')
      const sameOut = feeding.every((n) => downstream(n) === downstream(feeding[0]!))
      for (const [i, n] of feeding.entries()) {
        outTrack.set(n.key, sameOut ? 0 : feeding.length - 1 - i)
      }
      outTracks = Math.max(outTracks, sameOut ? Math.min(feeding.length, 1) : feeding.length)
    }
    return { inTrack, outTrack, inTracks, outTracks }
  }

  const columns = (layer: readonly WorkflowWireNode[]) => {
    const size = layer.length
    if (size <= 1 || width <= 0) return Math.max(size, 1)
    const fits = (cols: number) => {
      if (cols === 1) return true
      const { gap, left, right } = workflowChannels({
        wrapped: cols < size,
        ...assign(layer, cols),
      })
      const needed = cols * WF_NODE_MIN + (cols - 1) * gap + left + right
      return needed <= width - workflowRailWidth(rails)
    }
    let cols = size
    while (!fits(cols)) cols -= 1
    const even = Math.ceil(size / Math.ceil(size / cols))
    return fits(even) ? even : cols
  }

  const plan: WorkflowWirePlan = { layers: [], places: new Map(), nets, bundles: [], rails }
  let rail = 0
  for (const [li, layer] of layers.entries()) {
    const cols = columns(layer)
    const wrapped = cols < layer.length
    const tracks = assign(layer, cols)
    const shared = new Map<string, WorkflowWirePlan['bundles'][number]>()
    for (const [i, n] of layer.entries()) {
      const outTrack = wrapped ? (tracks.outTrack.get(n.key) ?? -1) : -1
      plan.places.set(n.key, {
        layer: li,
        inTrack: wrapped ? (tracks.inTrack.get(n.key) ?? -1) : -1,
        outTrack,
      })
      const list = feeds.get(n.key)
      if (!list) continue
      // 共用一条输出通道的节点下游相同，属于同一条输出线。
      const id = wrapped ? `${i % cols}:${outTrack}` : n.key
      const known = shared.get(id)
      if (known) {
        known.sources.push(n.key)
        continue
      }
      const bundle = {
        sources: [n.key],
        layer: li,
        feeds: list,
        rails: list.map((net) => (far(n.key, net) ? rail++ : -1)),
      }
      shared.set(id, bundle)
      plan.bundles.push(bundle)
    }
    plan.layers.push({ cols, wrapped, inTracks: tracks.inTracks, outTracks: tracks.outTracks })
  }
  return plan
}

/**
 * 一层的列、列间距、两侧留白与上方空白的高度。宽度充足时节点宽度不超过 `WF_NODE_MAX`。
 * `lanes` 是该层上方空白中的横线数，由 `routeWorkflowWires` 按测得的位置给出。
 */
export function workflowLayerStyle(layer: WorkflowWirePlan['layers'][number], lanes: number) {
  const { gap, left, right } = workflowChannels(layer)
  return {
    'grid-template-columns': `repeat(${layer.cols}, minmax(0, 1fr))`,
    'column-gap': `${gap}px`,
    'padding-inline': `${left}px ${right}px`,
    'max-width': `${layer.cols * WF_NODE_MAX + (layer.cols - 1) * gap + left + right}px`,
    'margin-top': `${Math.max(0, lanes - 1) * WF_LANE}px`,
  }
}

export interface WorkflowEdgeSegment {
  axis: 'horizontal' | 'vertical'
  fixed: number
  from: number
  to: number
  live: boolean
}

/** 节点测得的矩形，坐标相对于图的左上角。 */
export interface WorkflowNodeRect {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 自上而下排列一组横线：每次从余下各条中取出放在最上方时相交次数最少的一条。
 * `crossings(upper, lower)` 是两条横线按该上下次序放置时的相交次数。
 */
function arrangeWorkflowLanes<T>(items: readonly T[], crossings: (upper: T, lower: T) => number) {
  const rest = [...items]
  const ordered: T[] = []
  while (rest.length > 0) {
    const cost = (item: T) =>
      rest.reduce((sum, other) => (other === item ? sum : sum + crossings(item, other)), 0)
    const next = rest.reduce((best, item) => (cost(item) < cost(best) ? item : best))
    rest.splice(rest.indexOf(next), 1)
    ordered.push(next)
  }
  return ordered
}

/**
 * 按 `layoutWorkflowGraph` 的分配与测得的节点位置生成连线的线段，并给出每层上方空白中的横线数。
 * 图宽以内无法容纳全部竖线时，多出的竖线画在图的右边界之外，`overflow` 是越出的宽度。
 *
 * 不变量：每条线段只属于一条输出线或一组连线，不同归属的线段只相交、不重合也不相接。
 * 违反时图上会多出一条不存在的依赖。因此：
 * - 一个上游通向多组连线时，输出线先到达它独占的分线横线，再由各条分支分别下行到一组连线；
 *   不要让输出线依次经过多组连线的横线，上方一组的其他上游会沿它到达下方一组。
 * - 一组连线在层间空白中分为三部分：汇集各上游的上横线、一条下行竖线、分发到各目标的下横线。
 *   上游的竖线只在上横线以上，目标的竖线只在下横线以下，两者横坐标相同也不重合。
 * - 分支与下行竖线的横坐标在空白中选取：与其他竖线的距离不小于 `WF_TRACK`，
 *   或与同一组连线自己的竖线完全重合（此时对应的横线长度为零，不占位置）。
 * - 空白中只有一组连线且各上游都不需要分线时，上、下横线合为一条，没有下行竖线。
 *
 * 换行的层中，引出与进入都经节点旁的通道，连线不穿过同层其他行的节点。上游与目标不在相邻层时，
 * 分支经图右侧的通道下行，不穿过中间各层。
 *
 * 每个目标输出通向它的完整路径，重合部分由 `mergeWorkflowEdgeSegments` 合并。
 * 坐标偏移半像素：1px 的描边绘制在整数坐标上会跨越两个物理像素，显示为两条颜色减半的线。
 */
export function routeWorkflowWires(
  plan: WorkflowWirePlan,
  rects: ReadonlyMap<string, WorkflowNodeRect>,
  width: number,
): {
  segments: (Omit<WorkflowEdgeSegment, 'live'> & { target: string })[]
  lanes: number[]
  /** 图宽以内无法容纳全部竖线时，连线越出图右边界的宽度；否则为 0。 */
  overflow: number
} {
  type Piece = Omit<WorkflowEdgeSegment, 'live'>
  const at = (v: number) => Math.round(v) + 0.5
  const vertical = (list: Piece[], x: number, from: number, to: number) =>
    list.push({ axis: 'vertical', fixed: x, from, to })
  const horizontal = (list: Piece[], y: number, from: number, to: number) =>
    list.push({ axis: 'horizontal', fixed: y, from, to })
  const within = (x: number, xs: readonly number[]) => x > Math.min(...xs) && x < Math.max(...xs)

  const tops: number[] = []
  const bottoms: number[] = []
  for (const [key, r] of rects) {
    const layer = plan.places.get(key)?.layer
    if (layer === undefined) continue
    tops[layer] = Math.min(tops[layer] ?? r.top, r.top)
    bottoms[layer] = Math.max(bottoms[layer] ?? r.bottom, r.bottom)
  }
  const railX = (rail: number) => at(width - (rail + 1) * WF_TRACK)

  /** 每条输出线离开所在层的部分：横坐标、起点，以及换行的层中从节点到通道的转折。 */
  const trunks = plan.bundles.map((bundle) => {
    const pieces: Piece[] = []
    let x: number | undefined
    let top = Number.POSITIVE_INFINITY
    for (const key of bundle.sources) {
      const r = rects.get(key)
      const place = plan.places.get(key)
      if (!r || !place) continue
      if (place.outTrack < 0) {
        x = at((r.left + r.right) / 2)
        top = Math.min(top, at(r.bottom))
        continue
      }
      const port = at(r.right - WF_PORT)
      const hook = at(r.bottom + WF_HOOK)
      x = at(r.right + (place.outTrack + 1) * WF_TRACK)
      vertical(pieces, port, at(r.bottom), hook)
      horizontal(pieces, hook, port, x)
      top = Math.min(top, hook)
    }
    return { x, top, pieces }
  })
  /** 目标的输入线离开下横线的横坐标。 */
  const entryOf = (key: string) => {
    const r = rects.get(key)
    const place = plan.places.get(key)
    if (!r || !place) return undefined
    return at(place.inTrack < 0 ? (r.left + r.right) / 2 : r.left - (place.inTrack + 1) * WF_TRACK)
  }

  /** 每组连线：各上游竖线到达上横线的横坐标、下行竖线的横坐标、上横线与下横线的纵坐标。 */
  const wires = plan.nets.map((net, index) => ({
    net,
    index,
    feeders: [] as number[],
    entries: net.targets.map(entryOf).filter((x): x is number => x !== undefined),
    drop: undefined as number | undefined,
    upper: 0,
    lower: 0,
  }))
  /** 每条需要分线的输出线：分线横线的纵坐标，以及通向各组连线的分支的横坐标。 */
  const forks = plan.bundles.map(() => ({ y: 0, branches: [] as number[] }))
  const forked = (b: number) => {
    const bundle = plan.bundles[b]!
    return bundle.feeds.length > 1 || bundle.rails[0]! >= 0
  }
  const lanes = plan.layers.map(() => 0)
  let overflow = 0

  for (let layer = 1; layer < plan.layers.length; layer += 1) {
    const top = bottoms[layer - 1]
    const bottom = tops[layer]
    if (top === undefined || bottom === undefined) continue
    const here = wires.filter((wire) => wire.net.layer === layer)
    const above = plan.bundles.flatMap((bundle, b) =>
      bundle.layer === layer - 1 && trunks[b]!.x !== undefined ? [b] : [],
    )

    // 空白中已确定的竖线。`id` 标明归属：新选取的横坐标只允许与自己的竖线完全重合。
    const pins: { x: number; id: string }[] = []
    for (let rail = 0; rail < plan.rails; rail += 1) pins.push({ x: railX(rail), id: `r${rail}` })
    for (const b of above) pins.push({ x: trunks[b]!.x!, id: `t${b}` })
    for (const wire of here) for (const x of wire.entries) pins.push({ x, id: `e${wire.index}` })
    const free = (x: number, own: readonly string[]) =>
      pins.every((pin) => (pin.x === x ? own.includes(pin.id) : Math.abs(pin.x - x) >= WF_TRACK))
    const choose = (prefer: readonly number[], around: number, own: readonly string[]) => {
      for (const x of prefer) if (free(x, own)) return x
      for (let step = 1; step * WF_TRACK < width; step += 1) {
        for (const x of [around + step * WF_TRACK, around - step * WF_TRACK]) {
          if (x > 0 && x < width && free(x, own)) return x
        }
      }
      // 图宽以内没有空位时取图右侧之外的位置，并上报越出的宽度：卡片据此横向滚动。
      let x = at(width) + WF_TRACK
      while (!free(x, own)) x += WF_TRACK
      overflow = Math.max(overflow, Math.ceil(x - width) + WF_TRACK)
      return x
    }

    // 各组连线的上游：不需要分线的相邻层输出线与经右侧通道到达的分支已有确定的横坐标。
    const sources = here.map((wire) => {
      const index = wire.index
      const fixed: { x: number; id: string }[] = []
      const branching: number[] = []
      for (const [b, bundle] of plan.bundles.entries()) {
        const slot = bundle.feeds.indexOf(index)
        if (slot < 0 || trunks[b]!.x === undefined) continue
        if (bundle.rails[slot]! >= 0) {
          fixed.push({ x: railX(bundle.rails[slot]!), id: `r${bundle.rails[slot]}` })
        } else if (forked(b)) branching.push(b)
        else fixed.push({ x: trunks[b]!.x!, id: `t${b}` })
      }
      return { wire, index, fixed, branching }
    })
    const merged = sources.length === 1 && sources[0]!.branching.length === 0

    // 输出线直行到一组连线时，它本身就是通向该组的分支；每条输出线只有一组连线可以这样连接。
    const straight = new Map<number, number>()
    for (const { wire, index, fixed, branching } of sources) {
      wire.feeders = fixed.map((pin) => pin.x)
      if (merged) continue
      const own = [...fixed.map((pin) => pin.id), `e${wire.index}`]
      const known = [...wire.feeders, ...wire.entries]
      const middle = known.reduce((sum, x) => sum + x, 0) / Math.max(known.length, 1)
      const prefer: number[] = []
      const only = fixed.length + branching.length === 1
      if (only && fixed.length === 1) prefer.push(fixed[0]!.x)
      const direct = only && branching.length === 1 && !straight.has(branching[0]!)
      if (direct) {
        prefer.push(trunks[branching[0]!]!.x!)
        own.push(`t${branching[0]}`)
      }
      if (new Set(wire.entries).size === 1) prefer.push(wire.entries[0]!)
      prefer.push(...[...known].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle)))
      const drop = choose(prefer, at(middle), own)
      wire.drop = drop
      if (direct && drop === trunks[branching[0]!]!.x) straight.set(branching[0]!, index)
      pins.push({ x: drop, id: `d${index}` })
    }
    for (const { wire, index, fixed, branching } of sources) {
      for (const b of branching) {
        const trunk = trunks[b]!.x!
        const slot = plan.bundles[b]!.feeds.indexOf(index)
        let x: number
        if (straight.get(b) === index) x = trunk
        else if (fixed.length + branching.length === 1) x = wire.drop!
        else if (!straight.has(b)) {
          x = trunk
          straight.set(b, index)
        } else {
          x = choose([], trunk, [])
          pins.push({ x, id: `b${b}` })
        }
        forks[b]!.branches[slot] = x
        wire.feeders.push(x)
      }
    }
    for (const b of above) {
      const bundle = plan.bundles[b]!
      for (const [slot, rail] of bundle.rails.entries()) {
        if (rail >= 0) forks[b]!.branches[slot] = railX(rail)
      }
    }

    // 自上而下：分线横线、各组连线的上横线、各组连线的下横线。长度为零的横线不占位置。
    const splitting = arrangeWorkflowLanes(above.filter(forked), (upper, lower) => {
      const span = [trunks[upper]!.x!, ...forks[upper]!.branches]
      const below = [trunks[lower]!.x!, ...forks[lower]!.branches]
      return (
        (within(trunks[lower]!.x!, span) ? 1 : 0) +
        forks[upper]!.branches.filter((x) => within(x, below)).length
      )
    })
    const collecting = arrangeWorkflowLanes(
      here.filter((wire) => merged || wire.feeders.some((x) => x !== wire.drop)),
      (upper, lower) =>
        lower.feeders.filter((x) => within(x, [...upper.feeders, upper.drop!])).length +
        (within(upper.drop!, [...lower.feeders, lower.drop!]) ? 1 : 0),
    )
    const spreading = arrangeWorkflowLanes(
      here.filter((wire) => !merged && wire.entries.some((x) => x !== wire.drop)),
      (upper, lower) =>
        upper.entries.filter((x) => within(x, [...lower.entries, lower.drop!])).length +
        (within(lower.drop!, [...upper.entries, upper.drop!]) ? 1 : 0),
    )
    const count = splitting.length + collecting.length + spreading.length
    lanes[layer] = count
    /** 第 `slot` 条横线的纵坐标：全部横线作为一组在空白中居中。 */
    const laneY = (slot: number) => at((top + bottom) / 2 + (slot - (count - 1) / 2) * WF_LANE)
    for (const [slot, b] of splitting.entries()) forks[b]!.y = laneY(slot)
    for (const wire of here) {
      const up = collecting.indexOf(wire)
      const down = spreading.indexOf(wire)
      const upper = up < 0 ? undefined : laneY(splitting.length + up)
      const lower = down < 0 ? undefined : laneY(splitting.length + collecting.length + down)
      // 两条横线都不存在时上游竖线直达目标：不要在空白中部设端点，端点落在其他连线的横线上即与之相连。
      wire.upper = upper ?? lower ?? at(bottom)
      wire.lower = lower ?? wire.upper
    }
  }

  // 每组连线中各目标共用的部分：各上游到上横线、上横线、下行竖线。
  const shared: Piece[][] = wires.map(() => [])
  for (const [b, bundle] of plan.bundles.entries()) {
    const trunk = trunks[b]!
    if (trunk.x === undefined) continue
    for (const [slot, index] of bundle.feeds.entries()) {
      const wire = wires[index]!
      const list = shared[index]!
      list.push(...trunk.pieces)
      if (!forked(b)) {
        vertical(list, trunk.x, trunk.top, wire.upper)
        continue
      }
      const branch = forks[b]!.branches[slot]
      if (branch === undefined) continue
      vertical(list, trunk.x, trunk.top, forks[b]!.y)
      horizontal(list, forks[b]!.y, trunk.x, branch)
      vertical(list, branch, forks[b]!.y, wire.upper)
    }
  }
  const segments: (Omit<WorkflowEdgeSegment, 'live'> & { target: string })[] = []
  for (const [index, wire] of wires.entries()) {
    const list = shared[index]!
    if (wire.drop !== undefined) {
      for (const x of wire.feeders) horizontal(list, wire.upper, x, wire.drop)
      vertical(list, wire.drop, wire.upper, wire.lower)
    }
    for (const target of wire.net.targets) {
      const t = rects.get(target)
      const place = plan.places.get(target)
      const entry = entryOf(target)
      if (!t || !place || entry === undefined) continue
      const own: Piece[] = []
      if (wire.drop !== undefined) horizontal(own, wire.lower, wire.drop, entry)
      else for (const x of wire.feeders) horizontal(own, wire.lower, x, entry)
      if (place.inTrack < 0) vertical(own, entry, wire.lower, at(t.top))
      else {
        const turn = at(t.top - WF_HOOK)
        const port = at(t.left + WF_PORT)
        vertical(own, entry, wire.lower, turn)
        horizontal(own, turn, entry, port)
        vertical(own, port, turn, at(t.top))
      }
      for (const piece of [...list, ...own]) segments.push({ ...piece, target })
    }
  }
  return { segments, lanes, overflow }
}

/**
 * 多条依赖共享入口或出口时会产生共线区间。先按坐标切分为最小区间，再合并相邻且状态
 * 相同的区间，保证每一段像素只绘制一次；共享区间中只要有一条活动依赖就显示活动状态。
 *
 * 竖线与横线相交而没有任何线段在交点结束时，两者属于不同的依赖：竖线在交点上下断开，
 * 表示从横线下方穿过。有线段在交点结束时两者相连，不断开。
 */
export function mergeWorkflowEdgeSegments(
  segments: readonly WorkflowEdgeSegment[],
): { d: string; live: boolean }[] {
  const groups = new Map<
    string,
    { axis: WorkflowEdgeSegment['axis']; fixed: number; parts: WorkflowEdgeSegment[] }
  >()
  for (const segment of segments) {
    const from = Math.min(segment.from, segment.to)
    const to = Math.max(segment.from, segment.to)
    if (from === to) continue
    const normalized = { ...segment, from, to }
    const key = `${segment.axis}:${segment.fixed}`
    const group = groups.get(key)
    if (group) group.parts.push(normalized)
    else groups.set(key, { axis: segment.axis, fixed: segment.fixed, parts: [normalized] })
  }

  const paths: { d: string; live: boolean }[] = []
  for (const group of groups.values()) {
    const jumps: number[] = []
    if (group.axis === 'vertical') {
      for (const other of groups.values()) {
        if (other.axis !== 'horizontal') continue
        const across = other.parts.filter((p) => p.from <= group.fixed && p.to >= group.fixed)
        const down = group.parts.filter((p) => p.from <= other.fixed && p.to >= other.fixed)
        if (across.length === 0 || down.length === 0) continue
        const joined =
          across.some((p) => p.from === group.fixed || p.to === group.fixed) ||
          down.some((p) => p.from === other.fixed || p.to === other.fixed)
        if (!joined) jumps.push(other.fixed)
      }
    }
    const points = [
      ...new Set([
        ...group.parts.flatMap((part) => [part.from, part.to]),
        ...jumps.flatMap((y) => [y - WF_JUMP, y + WF_JUMP]),
      ]),
    ].sort((a, b) => a - b)
    let run: { from: number; to: number; live: boolean } | null = null
    const flush = () => {
      if (!run) return
      paths.push({
        d:
          group.axis === 'horizontal'
            ? `M${run.from} ${group.fixed}H${run.to}`
            : `M${group.fixed} ${run.from}V${run.to}`,
        live: run.live,
      })
      run = null
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i]!
      const to = points[i + 1]!
      const covering = group.parts.filter((part) => part.from <= from && part.to >= to)
      const cut = jumps.some((y) => from >= y - WF_JUMP && to <= y + WF_JUMP)
      if (covering.length === 0 || cut) {
        flush()
        continue
      }
      const live = covering.some((part) => part.live)
      if (run && run.to === from && run.live === live) run.to = to
      else {
        flush()
        run = { from, to, live }
      }
    }
    flush()
  }
  return paths
}
