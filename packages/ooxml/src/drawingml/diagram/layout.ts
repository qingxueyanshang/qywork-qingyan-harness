/**
 * SmartArt 排版：按约束、算法与规则求出每个布局节点实例的位置与字号，输出待绘制的形状。
 *
 * - 单位：长度为 EMU，字号与文字边距为磅。约束的 `val` 对长度为毫米、对字号与边距为磅；以字号为参照的长度（边距）在
 *   确定字号后求值，`begPad`、`endPad` 以 `conn` 算法求出的 `connDist` 为参照。
 * - 求值顺序：节点的框确定后，依次执行其约束中作用于子节点与后代的项，再执行各子节点作用于自身的项，然后由算法放置子节点，
 *   逐层向下。`op="equ"` 的同组目标：长度取最大值，字号取适配后的最小值；`lte`、`gte` 为上下限。
 * - `lin`（WPS 实测）：子节点宽度之和超出框宽时按同一比例缩小到恰好排满，不放大；宽度缩小后，高度等其他长度约束按缩小后的
 *   宽度重新求值（以父节点宽度为参照的不随之缩小），超出框高的截为框高；整行在框内居中，各子节点在垂直方向居中。
 *   `sp` 子节点只占位，宽度可为负（相邻形状重叠）。
 *   `custLinFactNeighborX` 使形状沿排列方向平移「系数 × 相邻 `sp` 的宽度」（同号同向），`custLinFactNeighborY` 不平移。
 * - `conn`：形状为本节点框内的箭头，起止两端各留 `begPad`、`endPad`，`connDist` 为框沿排列方向的长度。
 * - 字号（WPS 实测）：从 `primFontSz` 起按整磅递减，取文字能排入的最大字号；文字区为几何的文本矩形减去边距，
 *   有单词被强制断开即为无法排入。无法排入时依次执行规则：`primFontSz` 规则把字号下限放宽到 `val`，`h` 规则允许高度增加到
 *   `fact` 倍（或 `val`），不超过父节点的框高，取能排入的最小高度。
 */

import type { Effect, Line, ShapeFill } from '../fill.ts'
import type { Geometry } from '../geometry/model.ts'
import { shapeOutline } from '../geometry/path.ts'
import type { Paragraph, Run, TextBody } from '../text/model.ts'
import type { Constraint, Diagram, DiagramNode, Rule } from './model.ts'

const EMU_PER_PT = 12700
const EMU_PER_MM = 36000
/** `primFontSz` 未指定时的字号。 */
const DEFAULT_FONT = 65
/** `primFontSz` 规则未给出下限时的字号下限。 */
const MIN_FONT = 5
const FONT_TYPES = new Set(['primFontSz', 'secFontSz'])
const MARGIN_TYPES = new Set(['tMarg', 'bMarg', 'lMarg', 'rMarg'])
const EPSILON = 1e-6
/** `lin` 缩放宽度后重新执行的约束类型。 */
const RESCALED = new Set(['h', 'l', 't', 'r', 'b', 'ctrX', 'ctrY'])

/** 文字在 `width` 磅宽内的排版结果：内容高度（磅）与是否有单词被强制断开。 */
export type TextMeasure = (text: TextBody, width: number) => { height: number; broken: boolean }

export interface PlacedShape {
  /** 相对图示框左上角，EMU。 */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number
  readonly geometry: Geometry
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly text: TextBody | null
}

/** 参照另一个实例尚未确定的值（字号、`connDist`）的约束值。 */
interface Deferred {
  readonly item: Item
  readonly type: string
  readonly fact: number
}

type Value = number | Deferred

interface Bound {
  readonly op: 'lte' | 'gte'
  readonly value: Value
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

class Item {
  readonly children: Item[]
  readonly values = new Map<string, Value>()
  readonly bounds = new Map<string, Bound[]>()
  box: Box = { x: 0, y: 0, w: 0, h: 0 }
  /** 规则增加后的高度；没有增加时为 `null`。 */
  grown: number | null = null
  font = DEFAULT_FONT

  constructor(
    readonly node: DiagramNode,
    readonly parent: Item | null,
  ) {
    this.children = node.children.map((c) => new Item(c, this))
  }

  descendants(out: Item[] = []): Item[] {
    for (const c of this.children) {
      out.push(c)
      c.descendants(out)
    }
    return out
  }
}

function matches(item: Item, name: string, ptType: string): boolean {
  if (name !== '' && item.node.name !== name) return false
  if (ptType === 'all') return true
  if (ptType === 'node' || ptType === 'nonAsst') return item.node.pointType === 'node'
  return item.node.pointType === ptType
}

function select(item: Item, rel: string, name: string, ptType: string): Item[] {
  const pool = rel === 'self' ? [item] : rel === 'ch' ? item.children : item.descendants()
  return pool.filter((i) => rel === 'self' || matches(i, name, ptType))
}

function length(type: string, val: number): number {
  return FONT_TYPES.has(type) || MARGIN_TYPES.has(type) ? val : val * EMU_PER_MM
}

class Engine {
  /** `op="equ"` 的同组目标：类型与成员。 */
  private readonly groups: { type: string; items: Item[] }[] = []

  constructor(private readonly measure: TextMeasure | null) {}

  /** 实例的值：未设置时长度取父节点的值（根为图示框），位置为 0，字号为 65，边距为 0。 */
  get(item: Item, type: string): Value {
    const v = item.values.get(type)
    if (v !== undefined) return v
    if (type === 'w' || type === 'h') {
      if (item.parent === null) return type === 'w' ? item.box.w : item.box.h
      return this.get(item.parent, type)
    }
    if (FONT_TYPES.has(type)) return { item, type, fact: 1 }
    if (type === 'connDist') return { item, type, fact: 1 }
    return 0
  }

  number(v: Value): number {
    if (typeof v === 'number') return v
    if (FONT_TYPES.has(v.type)) return v.item.font * v.fact
    if (v.type === 'connDist') return v.item.box.w * v.fact
    return this.number(this.get(v.item, v.type)) * v.fact
  }

  private scaled(v: Value, fact: number): Value {
    return typeof v === 'number' ? v * fact : { ...v, fact: v.fact * fact }
  }

  private apply(owner: Item, c: Constraint, targets: readonly Item[], record: boolean): void {
    let value: Value | null = null
    if (c.refType !== 'none') {
      const ref =
        c.refFor === 'self' ? owner : select(owner, c.refFor, c.refForName, c.refPtType)[0]
      if (ref === undefined) return
      const base = FONT_TYPES.has(c.refType)
        ? ({ item: ref, type: c.refType, fact: 1 } satisfies Deferred)
        : this.get(ref, c.refType)
      value = this.scaled(base, c.fact)
    } else if (c.val !== null) {
      value = length(c.type, c.val)
    }
    if (c.op === 'lte' || c.op === 'gte') {
      if (value === null) return
      for (const t of targets) {
        const list = t.bounds.get(c.type) ?? []
        list.push({ op: c.op, value })
        t.bounds.set(c.type, list)
      }
      return
    }
    if (value !== null) for (const t of targets) t.values.set(c.type, value)
    if (c.op === 'equ' && record) this.groups.push({ type: c.type, items: [...targets] })
  }

  /** 长度值经上下限约束后的数值。 */
  size(item: Item, type: string): number {
    let v = this.number(this.get(item, type))
    for (const b of item.bounds.get(type) ?? []) {
      const limit = this.number(b.value)
      v = b.op === 'lte' ? Math.min(v, limit) : Math.max(v, limit)
    }
    return v
  }

  /**
   * 执行节点作用于子节点与后代的约束，再执行各子节点作用于自身的约束。`rescaled` 为真时只重新执行宽度之外的长度约束：
   * 子节点的宽度已由算法确定，以宽度为参照的其他值随之更新。
   */
  private constrain(item: Item, rescaled = false): void {
    const wanted = (c: Constraint) => !rescaled || RESCALED.has(c.type)
    if (rescaled) for (const k of item.children) for (const t of RESCALED) k.bounds.delete(t)
    for (const c of item.node.constraints) {
      if (c.for !== 'self' && wanted(c))
        this.apply(item, c, select(item, c.for, c.forName, c.ptType), !rescaled)
    }
    for (const child of item.children) {
      for (const c of child.node.constraints) {
        if (c.for === 'self' && wanted(c)) this.apply(child, c, [child], !rescaled)
      }
    }
    for (const g of this.groups) {
      if (g.type !== 'w' && g.type !== 'h') continue
      const members = g.items.filter((i) => i.parent === item)
      if (members.length < 2) continue
      const max = Math.max(...members.map((i) => this.size(i, g.type)))
      for (const m of members) m.values.set(g.type, max)
    }
  }

  /** 设定实例的框并放置其子树。 */
  private place(item: Item, box: Box): void {
    item.box = box
    item.values.set('w', box.w)
    item.values.set('h', box.h)
    this.constrain(item)
    const alg = item.node.algorithm
    if (alg.type === 'lin') this.linear(item)
    else if (alg.type === 'composite') this.composite(item)
    else for (const c of item.children) this.place(c, { ...item.box })
  }

  private linear(item: Item): void {
    const box = item.box
    const kids = item.children
    const widths = kids.map((k) => this.size(k, 'w'))
    const total = widths.reduce((a, b) => a + b, 0)
    const s = total > box.w && total > 0 ? box.w / total : 1
    for (const [i, k] of kids.entries()) k.values.set('w', widths[i]! * s)
    this.constrain(item, true)
    const heights = kids.map((k) => this.size(k, 'h'))
    const fromRight = item.node.algorithm.params.linDir === 'fromR'
    let cursor = (box.w - total * s) / 2
    const boxes: Box[] = kids.map((k, i) => {
      const w = widths[i]! * s
      const h = k.grown ?? Math.min(heights[i]!, box.h)
      const x = fromRight ? box.x + box.w - cursor - w : box.x + cursor
      cursor += w
      return { x, y: box.y + (box.h - h) / 2, w, h }
    })
    kids.forEach((k, i) => {
      const f = k.node.neighborFactor.x
      if (f === 0) return
      const next = kids[i + 1]
      const neighbor = next?.node.algorithm.type === 'sp' ? i + 1 : i - 1
      const spacing = kids[neighbor]?.node.algorithm.type === 'sp' ? boxes[neighbor]!.w : 0
      boxes[i]!.x += (fromRight ? -1 : 1) * f * spacing
    })
    for (const [i, k] of kids.entries()) this.place(k, boxes[i]!)
  }

  private composite(item: Item): void {
    const box = item.box
    for (const k of item.children) {
      const has = (t: string) => k.values.has(t)
      const w = this.size(k, 'w')
      const h = this.size(k, 'h')
      const x = has('l')
        ? this.size(k, 'l')
        : has('r')
          ? this.size(k, 'r') - w
          : has('ctrX')
            ? this.size(k, 'ctrX') - w / 2
            : 0
      const y = has('t')
        ? this.size(k, 't')
        : has('b')
          ? this.size(k, 'b') - h
          : has('ctrY')
            ? this.size(k, 'ctrY') - h / 2
            : 0
      this.place(k, { x: box.x + x, y: box.y + y, w, h })
    }
  }

  /** 文字区（磅）：几何的文本矩形减去边距；`conn` 与隐藏几何的形状取整个框。 */
  private area(item: Item, w: number, h: number): { width: number; height: number } {
    const geometry = item.node.shape?.geometry
    let rw = w / EMU_PER_PT
    let rh = h / EMU_PER_PT
    if (geometry !== undefined) {
      const r = shapeOutline(geometry, w, h, 1 / EMU_PER_PT).textRect
      rw = r.right - r.left
      rh = r.bottom - r.top
    }
    const m = (t: string) => this.number(this.get(item, t))
    return { width: rw - m('lMarg') - m('rMarg'), height: rh - m('tMarg') - m('bMarg') }
  }

  private fits(item: Item, font: number, h: number): boolean {
    const text = item.node.text
    if (text === null || this.measure === null) return true
    const saved = item.font
    item.font = font
    const a = this.area(item, item.box.w, h)
    item.font = saved
    if (a.width <= 0 || a.height <= 0) return false
    const m = this.measure(withSize(text, font), a.width)
    return !m.broken && m.height <= a.height + EPSILON
  }

  /** 字号上限：`primFontSz` 的值经上下限约束，取整磅。 */
  private startFont(item: Item): number {
    const v = item.values.get('primFontSz')
    const base = v === undefined || typeof v !== 'number' ? DEFAULT_FONT : v
    let f = base
    for (const b of item.bounds.get('primFontSz') ?? []) {
      const limit = this.number(b.value)
      f = b.op === 'lte' ? Math.min(f, limit) : Math.max(f, limit)
    }
    return Math.floor(f + EPSILON)
  }

  /** 按规则求字号与高度：从字号上限起，无法排入时依次执行规则。 */
  private search(item: Item): { font: number; h: number } {
    let font = this.startFont(item)
    let h = item.box.h
    if (this.fits(item, font, h)) return { font, h }
    for (const r of item.node.rules) {
      if (r.type === 'primFontSz') {
        const floor = Math.ceil((Number.isFinite(r.val) ? r.val : MIN_FONT) - EPSILON)
        for (let f = font - 1; f >= floor; f--) if (this.fits(item, f, h)) return { font: f, h }
        font = Math.min(font, floor)
      } else {
        const limit = Math.min(ruleLimit(r, item.box.h), item.parent?.box.h ?? item.box.h)
        if (limit > h && this.fits(item, font, limit)) {
          let lo = h
          let hi = limit
          for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2
            if (this.fits(item, font, mid)) hi = mid
            else lo = mid
          }
          return { font, h: hi }
        }
        h = Math.max(h, limit)
      }
    }
    return { font, h }
  }

  private fit(item: Item): void {
    const r = this.search(item)
    item.font = r.font
    item.grown = r.h > item.box.h + EPSILON ? r.h : null
  }

  /** 放置整个图示；同组约束在每次放置时重新收集。 */
  layout(root: Item, box: Box): void {
    this.groups.length = 0
    this.place(root, box)
  }

  /** 全部文字适配：逐个适配后，同组字号取最小值、同组增加的高度取最大值，高度有变化时重新放置。 */
  typeset(root: Item): void {
    const items = root.descendants().filter((i) => i.node.text !== null)
    for (const i of items) this.fit(i)
    for (const g of this.groups) {
      const members = g.items.filter((i) => i.node.text !== null)
      if (members.length < 2) continue
      if (FONT_TYPES.has(g.type)) {
        const min = Math.min(...members.map((i) => i.font))
        for (const m of members) m.font = min
      } else if (g.type === 'h' && members.some((m) => m.grown !== null)) {
        const max = Math.max(...members.map((m) => m.grown ?? m.box.h))
        for (const m of members) m.grown = max
      }
    }
    if (items.some((i) => i.grown !== null)) this.layout(root, { ...root.box })
  }

  shapes(item: Item, out: PlacedShape[]): PlacedShape[] {
    const node = item.node
    const b = item.box
    const text = node.text === null ? null : this.sizedText(item, node.text)
    if (node.shape !== null) {
      const s = node.shape
      out.push({
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        rotation: s.rotation,
        geometry: s.geometry,
        fill: s.fill,
        line: s.line,
        effects: s.effects,
        text,
      })
    } else if (node.connector !== null) {
      const fromRight = item.parent?.node.algorithm.params.linDir === 'fromR'
      const beg = this.number(this.get(item, 'begPad'))
      const end = this.number(this.get(item, 'endPad'))
      const w = Math.max(0, b.w - beg - end)
      out.push({
        x: b.x + (fromRight ? end : beg),
        y: b.y,
        width: w,
        height: b.h,
        rotation: 0,
        geometry: { kind: 'preset', name: fromRight ? 'leftArrow' : 'rightArrow', adjust: [] },
        ...node.connector,
        text,
      })
    } else if (text !== null) {
      out.push({
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        rotation: 0,
        geometry: RECT,
        fill: NONE,
        line: null,
        effects: [],
        text,
      })
    }
    for (const c of item.children) this.shapes(c, out)
    return out
  }

  /**
   * 字号与边距写入文字。边距按文字的正立方向理解（WPS 实测）：形状旋转 180° 时文本框随形状旋转，
   * 左右、上下边距在此对调，绘制后才落在正立方向的同一侧。
   */
  private sizedText(item: Item, text: TextBody): TextBody {
    const m = (t: string) => Math.round(this.number(this.get(item, t)) * EMU_PER_PT)
    const turned = item.node.shape?.rotation === 180
    const [left, right, top, bottom] = turned
      ? [m('rMarg'), m('lMarg'), m('bMarg'), m('tMarg')]
      : [m('lMarg'), m('rMarg'), m('tMarg'), m('bMarg')]
    return {
      ...withSize(text, item.font),
      body: {
        ...text.body,
        insetLeft: left,
        insetRight: right,
        insetTop: top,
        insetBottom: bottom,
      },
    }
  }
}

const RECT: Geometry = { kind: 'preset', name: 'rect', adjust: [] }
const NONE: ShapeFill = { kind: 'none' }

function ruleLimit(r: Rule, base: number): number {
  if (Number.isFinite(r.val)) return r.val * EMU_PER_MM
  if (r.val === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  if (Number.isFinite(r.fact)) return base * r.fact
  return base
}

function sized(run: Run, size: number): Run {
  return { ...run, style: { ...run.style, size } }
}

/** 文字的全部字段与段落结束符改为同一字号。 */
export function withSize(text: TextBody, size: number): TextBody {
  const paragraphs: Paragraph[] = text.paragraphs.map((p) => ({
    ...p,
    runs: p.runs.map((r) => sized(r, size)),
    end: { ...p.end, size },
  }))
  return { ...text, paragraphs }
}

/** 在 `width` × `height`（EMU）的图示框中排版，返回按绘制顺序排列的形状。`measure` 为 `null` 时字号取上限，不适配。 */
export function layoutDiagram(
  diagram: Diagram,
  width: number,
  height: number,
  measure: TextMeasure | null,
): PlacedShape[] {
  const engine = new Engine(measure)
  const root = new Item(diagram.root, null)
  engine.layout(root, { x: 0, y: 0, w: width, h: height })
  engine.typeset(root)
  return engine.shapes(root, [])
}
