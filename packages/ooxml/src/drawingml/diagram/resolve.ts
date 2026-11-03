/**
 * SmartArt 求值：按数据模型实例化布局定义，并求值每个布局节点实例的形状与文字。结果与字体无关，排版见 `layout.ts`。
 *
 * - 实例化：根布局节点对应 `doc` 点；`forEach` 按轴从当前点取点，逐个以该点为当前点展开其内容；`choose` 取第一个条件成立的
 *   `if`，都不成立时取 `else`。`ch` 轴的顺序为「节点、其后的 `sibTrans`」交替，按 `srcOrd` 排序；`hideLastTrans`（缺省为真）
 *   去掉最后一个节点之后的 `sibTrans`。
 * - 变量（`if func="var"`）：布局节点 `varLst` 与对应 pres 点的 `presLayoutVars` 合并，pres 点优先，子节点继承。`dir` 缺省为 `norm`。
 * - 样式：样式标签取布局节点的 `styleLbl`，没有时取对应 pres 点的 `presStyleLbl`。样式定义给出 `lnRef`、`fillRef`、`effectRef`、
 *   `fontRef`，颜色定义按实例在同一标签中的序号取颜色替换引用中的颜色；数据点的 `spPr` 覆盖样式结果，pres 点的 `spPr` 再覆盖。
 * - 文字（WPS 实测）：段落居中，单倍行距，段落之间加 35% 行高的间距；字体与颜色取 `fontRef` 与颜色定义的 `txFillClrLst`，
 *   没有文字颜色时取 `fontRef` 中的颜色。形状 `rot` 不旋转文字。
 * - `cust` 属性（WPS 实测）：`custScaleX` 不改变显示；`custLinFactNeighborX`、`custLinFactNeighborY` 见 `layout.ts`。
 * - 以下情况返回 `null`（整个图示不绘制，由调用方计入 SmartArt）：未识别的布局元素、算法、算法参数、轴、点类型、条件函数、
 *   约束与规则类型；长度以字号为参照、字号与边距以长度为参照的约束（单位换算未核对）；`presOf` 选中多个点；文字带字号；
 *   `cust` 中其他属性；`dgm:bg`、`dgm:whole` 有内容；样式求值遇到未实现的效果或图片填充；布局节点实例没有对应的 pres 点。
 */

import { type ColorContext, type ColorSpec, resolveColor } from '../color.ts'
import type { Geometry, Guide } from '../geometry/model.ts'
import { presetGeometry } from '../geometry/preset.ts'
import type { DrawingFinding, FindingSink } from '../shape/model.ts'
import type { StyleRefs } from '../shape/read.ts'
import {
  resolveShapeEffects,
  resolveShapeFill,
  resolveShapeLine,
  type StyleScope,
  shapeThreeD,
} from '../shape/resolve.ts'
import { collectTextFonts } from '../text/fonts.ts'
import type { TextBody } from '../text/model.ts'
import type { ListStyleSpec, ParagraphSpec, RawTextBody, RunSpec } from '../text/read.ts'
import { resolveTextBody } from '../text/resolve.ts'
import type { Theme } from '../theme.ts'
import { visibleThreeD } from '../three/camera.ts'
import type {
  Algorithm,
  ColorList,
  Condition,
  Constraint,
  DataPoint,
  Diagram,
  DiagramNode,
  DiagramShape,
  Iteration,
  LayoutAtom,
  RawDiagram,
  Rule,
  ShapeSpec,
} from './model.ts'

export interface DiagramScope {
  readonly theme: Theme
  readonly colors: ColorContext
}

/** 段落之间的间距：前一段末行行高的倍数（WPS 实测）。 */
const PARAGRAPH_SPACE = 0.35

const ALGORITHMS = new Set(['lin', 'composite', 'tx', 'sp', 'conn'])
/** 各算法已实现的参数与取值；参数不在表中、或取值不在列出范围内时不绘制。`null` 为任何取值都接受。 */
const PARAMS: Readonly<Record<string, Readonly<Record<string, readonly string[] | null>>>> = {
  lin: { linDir: ['fromL', 'fromR'] },
  composite: {},
  tx: { stBulletLvl: null, autoTxRot: ['grav', 'upr', 'none'] },
  sp: {},
  conn: { begPts: ['auto'], endPts: ['auto'] },
  none: {},
}
const AXES = new Set(['self', 'ch', 'des', 'desOrSelf', 'followSib', 'none'])
const POINT_FILTERS = new Set(['all', 'node', 'nonAsst', 'doc', 'parTrans', 'sibTrans'])
const FUNCS = new Set(['var', 'cnt', 'maxDepth', 'depth'])
const SIZE_TYPES = new Set(['w', 'h', 'l', 't', 'r', 'b', 'ctrX', 'ctrY'])
const CONSTRAINT_TYPES = new Set([
  ...SIZE_TYPES,
  'primFontSz',
  'secFontSz',
  'tMarg',
  'bMarg',
  'lMarg',
  'rMarg',
  'connDist',
  'begPad',
  'endPad',
])
const FONT_TYPES = new Set(['primFontSz', 'secFontSz'])
const MARGIN_TYPES = new Set(['tMarg', 'bMarg', 'lMarg', 'rMarg'])
const LENGTH_REFS = new Set([...SIZE_TYPES, 'connDist'])
const RULE_TYPES = new Set(['primFontSz', 'h'])
const KNOWN_CUSTOM = new Set(['custScaleX', 'custLinFactNeighborX', 'custLinFactNeighborY'])

class Unsupported extends Error {}

function check(ok: boolean): void {
  if (!ok) throw new Unsupported()
}

interface Child {
  readonly point: DataPoint
  readonly transition: boolean
}

interface State {
  algorithm: Algorithm | null
  shape: ShapeSpec | null
  presOf: Iteration | null
  readonly constraints: Constraint[]
  readonly rules: Rule[]
  readonly children: DiagramNode[]
}

function matchesType(point: DataPoint, filter: string): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'node':
    case 'nonAsst':
      return point.type === 'node'
    default:
      return point.type === filter
  }
}

function compare(op: string, a: number | string, b: string): boolean {
  const nb = Number(b)
  const numeric = typeof a === 'number' && b !== '' && Number.isFinite(nb)
  const x = numeric ? a : String(a)
  const y = numeric ? nb : b
  switch (op) {
    case 'equ':
      return x === y
    case 'neq':
      return x !== y
    case 'gt':
      return x > y
    case 'lt':
      return x < y
    case 'gte':
      return x >= y
    case 'lte':
      return x <= y
  }
  throw new Unsupported()
}

/**
 * 颜色列表中第 `index` 个实例的颜色；列表为空时为 `null`。WPS 实测：`repeat` 按列表顺序循环取色；
 * 多个颜色的 `span`（按色相插值）与 `cycle`（往返插值）未实现。
 */
function pickColor(list: ColorList, index: number): ColorSpec | null {
  const n = list.colors.length
  if (n === 0) return null
  check(list.method === 'repeat' || n === 1)
  return list.colors[index % n] ?? null
}

/** 形状 `rot` 只实现 0 与 180：文字边距的方向换算见 `layout.ts` 的 `sizedText`。 */
function geometryOf(spec: ShapeSpec): Geometry {
  const preset = presetGeometry(spec.type)
  check(preset !== null && (spec.rotation === 0 || spec.rotation === 180))
  const adjust: Guide[] = []
  for (const a of spec.adjust) {
    const guide = preset?.adjust[a.idx - 1]
    check(guide !== undefined)
    if (guide !== undefined)
      adjust.push({ name: guide.name, formula: `val ${Math.round(a.val * 100000)}` })
  }
  return { kind: 'preset', name: spec.type, adjust }
}

function textDefaults(style: StyleRefs | null, color: ColorSpec | null): ListStyleSpec {
  const font = style?.font ?? null
  const prefix = font?.idx === 'major' ? '+mj' : font?.idx === 'minor' ? '+mn' : null
  const run: { -readonly [K in keyof RunSpec]: RunSpec[K] } = {}
  if (prefix !== null) {
    run.latin = `${prefix}-lt`
    run.ea = `${prefix}-ea`
    run.cs = `${prefix}-cs`
  }
  const fill = color ?? font?.color ?? null
  if (fill !== null) run.fill = { kind: 'solid', color: fill }
  const level: ParagraphSpec = {
    align: 'ctr',
    lineSpacing: { unit: 'percent', value: 1 },
    spaceBefore: { unit: 'percent', value: PARAGRAPH_SPACE },
    spaceAfter: { unit: 'points', value: 0 },
    run,
  }
  return { levels: Array.from({ length: 9 }, () => level) }
}

function hasText(raw: RawTextBody): boolean {
  return raw.paragraphs.some((p) =>
    p.runs.some((r) => r.kind === 'math' || (r.kind !== 'break' && r.text !== '')),
  )
}

/** 文字中写明字号的字段与段落结束符：这类文字的显示未核对，按未实现处理。 */
function customSize(raw: RawTextBody): boolean {
  return raw.paragraphs.some(
    (p) =>
      p.end?.size !== undefined ||
      p.runs.some((r) => r.kind !== 'math' && r.props.size !== undefined),
  )
}

class Builder {
  private readonly byId = new Map<string, DataPoint>()
  private readonly sequence = new Map<string, Child[]>()
  private readonly parent = new Map<string, string>()
  private readonly pres = new Map<string, DataPoint>()
  private readonly labelIndex = new Map<string, number>()
  private readonly findings: DrawingFinding[] = []
  private readonly styleScope: StyleScope

  constructor(
    private readonly raw: RawDiagram,
    private readonly scope: DiagramScope,
  ) {
    const sink: FindingSink = { push: (...kinds) => this.findings.push(...kinds) }
    this.styleScope = { theme: scope.theme, colors: scope.colors, found: sink }
    for (const p of raw.data.points) this.byId.set(p.id, p)
    const parOf = raw.data.connections
      .filter((c) => c.type === 'parOf')
      .sort((a, b) => a.srcOrd - b.srcOrd)
    for (const c of parOf) {
      const child = this.byId.get(c.dest)
      if (child === undefined) continue
      const list = this.sequence.get(c.src) ?? []
      list.push({ point: child, transition: false })
      const sib = c.sibTrans === null ? undefined : this.byId.get(c.sibTrans)
      if (sib !== undefined) list.push({ point: sib, transition: true })
      this.sequence.set(c.src, list)
      this.parent.set(c.dest, c.src)
      if (sib !== undefined) this.parent.set(sib.id, c.src)
    }
    for (const p of raw.data.points) {
      if (p.type === 'pres' && p.presAssoc !== null && p.presName !== null) {
        this.pres.set(`${p.presAssoc}\u0000${p.presName}`, p)
      }
    }
  }

  build(): Diagram {
    const doc = this.raw.data.points.find((p) => p.type === 'doc')
    const layout = this.raw.layout
    check(doc !== undefined && layout !== null && layout.kind === 'layoutNode')
    check(!this.raw.data.decorated)
    check(this.raw.data.points.every((p) => p.type !== 'asst'))
    if (doc === undefined || layout === null || layout.kind !== 'layoutNode')
      throw new Unsupported()
    const root = this.node(layout, doc, {})
    check(this.findings.length === 0)
    return { root }
  }

  private children(point: DataPoint, hideLastTrans: boolean): Child[] {
    const list = this.sequence.get(point.id) ?? []
    return hideLastTrans && list.at(-1)?.transition === true ? list.slice(0, -1) : list
  }

  private descendants(point: DataPoint, out: DataPoint[]): DataPoint[] {
    for (const c of this.children(point, false)) {
      out.push(c.point)
      if (!c.transition) this.descendants(c.point, out)
    }
    return out
  }

  private axis(it: Iteration, point: DataPoint): DataPoint[] {
    check(AXES.has(it.axis) && POINT_FILTERS.has(it.ptType))
    let list: DataPoint[]
    switch (it.axis) {
      case 'self':
        list = [point]
        break
      case 'ch':
        list = this.children(point, it.hideLastTrans).map((c) => c.point)
        break
      case 'des':
        list = this.descendants(point, [])
        break
      case 'desOrSelf':
        list = this.descendants(point, [point])
        break
      case 'followSib': {
        const parent = this.byId.get(this.parent.get(point.id) ?? '')
        const siblings = parent === undefined ? [] : this.children(parent, it.hideLastTrans)
        const index = siblings.findIndex((c) => c.point === point)
        list = index < 0 ? [] : siblings.slice(index + 1).map((c) => c.point)
        break
      }
      default:
        list = []
    }
    const filtered = list.filter((p) => matchesType(p, it.ptType))
    const out: DataPoint[] = []
    const step = Math.max(1, it.step)
    for (let i = Math.max(1, it.start) - 1; i < filtered.length; i += step) {
      const p = filtered[i]
      if (p !== undefined) out.push(p)
      if (it.count > 0 && out.length >= it.count) break
    }
    return out
  }

  private depth(point: DataPoint): number {
    let d = 0
    for (let id = this.parent.get(point.id); id !== undefined; id = this.parent.get(id)) d++
    return d
  }

  private maxDepth(point: DataPoint): number {
    let max = 0
    for (const c of this.children(point, false)) {
      if (!c.transition) max = Math.max(max, 1 + this.maxDepth(c.point))
    }
    return max
  }

  private holds(c: Condition, point: DataPoint, vars: Record<string, string>): boolean {
    check(FUNCS.has(c.func))
    switch (c.func) {
      case 'var':
        check(c.arg === 'dir')
        return compare(c.op, vars.dir === undefined || vars.dir === '' ? 'norm' : vars.dir, c.val)
      case 'cnt':
        return compare(c.op, this.axis(c, point).length, c.val)
      case 'maxDepth':
        check(c.axis === 'des' || c.axis === 'desOrSelf')
        return compare(c.op, this.maxDepth(point), c.val)
      default:
        return compare(c.op, this.depth(point), c.val)
    }
  }

  private atoms(
    list: readonly LayoutAtom[],
    point: DataPoint,
    state: State,
    vars: Record<string, string>,
    pres: DataPoint | null,
    nested: boolean,
  ): void {
    for (const a of list) {
      switch (a.kind) {
        case 'layoutNode':
          state.children.push(this.node(a, point, vars))
          break
        case 'choose': {
          const branch = a.branches.find(
            (b) => b.condition === null || this.holds(b.condition, point, vars),
          )
          if (branch !== undefined) this.atoms(branch.children, point, state, vars, pres, nested)
          break
        }
        case 'forEach':
          check(a.ref === null)
          for (const p of this.axis(a.iteration, point))
            this.atoms(a.children, p, state, vars, pres, true)
          break
        case 'unknown':
          throw new Unsupported()
        default:
          check(!nested)
          this.attribute(a, state, vars, pres)
      }
    }
  }

  private attribute(
    a: Exclude<LayoutAtom, { kind: 'layoutNode' | 'choose' | 'forEach' | 'unknown' }>,
    state: State,
    vars: Record<string, string>,
    pres: DataPoint | null,
  ): void {
    switch (a.kind) {
      case 'alg': {
        check(ALGORITHMS.has(a.type))
        const allowed = PARAMS[a.type] ?? {}
        for (const [k, v] of Object.entries(a.params)) {
          check(k in allowed)
          const values = allowed[k]
          check(values === null || values === undefined || values.includes(v))
        }
        state.algorithm = { type: a.type as Algorithm['type'], params: a.params }
        break
      }
      case 'shape':
        state.shape = a.shape
        break
      case 'presOf':
        state.presOf = a.iteration
        break
      case 'constraints':
        for (const c of a.list) {
          check(CONSTRAINT_TYPES.has(c.type) && ['self', 'ch', 'des'].includes(c.for))
          check(c.refType === 'none' || CONSTRAINT_TYPES.has(c.refType))
          const fontLike = FONT_TYPES.has(c.type) || MARGIN_TYPES.has(c.type)
          check(c.refType === 'none' || (fontLike ? FONT_TYPES : LENGTH_REFS).has(c.refType))
          check(['none', 'equ', 'lte', 'gte'].includes(c.op) && POINT_FILTERS.has(c.ptType))
          check(['self', 'ch', 'des'].includes(c.refFor) && POINT_FILTERS.has(c.refPtType))
        }
        state.constraints.push(...a.list)
        break
      case 'rules':
        for (const r of a.list) check(RULE_TYPES.has(r.type) && r.for === 'self')
        state.rules.push(...a.list)
        break
      case 'vars':
        Object.assign(vars, a.vars, pres?.vars ?? {})
        break
    }
  }

  private nextIndex(label: string): number {
    const i = this.labelIndex.get(label) ?? 0
    this.labelIndex.set(label, i + 1)
    return i
  }

  private node(
    atom: Extract<LayoutAtom, { kind: 'layoutNode' }>,
    point: DataPoint,
    inherited: Record<string, string>,
  ): DiagramNode {
    const pres = this.pres.get(`${point.id}\u0000${atom.name}`) ?? null
    // WPS 实测：布局节点实例在数据部件中没有对应的 pres 点时不显示；只缺一部分时的显示未核对，整个图示按未实现处理。
    check(pres !== null)
    for (const k of Object.keys(pres?.custom ?? {})) check(KNOWN_CUSTOM.has(k))
    const vars = { ...inherited, ...(pres?.vars ?? {}) }
    const state: State = {
      algorithm: null,
      shape: null,
      presOf: null,
      constraints: [],
      rules: [],
      children: [],
    }
    this.atoms(atom.children, point, state, vars, pres, false)
    const algorithm = state.algorithm ?? { type: 'none', params: {} }
    check(algorithm.type !== 'none' || state.children.length === 0)
    const presented = state.presOf === null ? [] : this.axis(state.presOf, point)
    check(presented.length <= 1)
    const source = presented[0] ?? null
    const rawText = source?.text ?? null
    const label = atom.styleLabel ?? pres?.styleLabel ?? null
    const spec = state.shape
    const drawn = spec !== null && spec.type !== '' && !spec.hideGeometry
    const textual = rawText !== null && hasText(rawText)
    let style: StyleRefs | null = null
    let colors: {
      fill: ColorSpec | null
      line: ColorSpec | null
      effect: ColorSpec | null
      text: ColorSpec | null
    } = {
      fill: null,
      line: null,
      effect: null,
      text: null,
    }
    if (drawn || textual) {
      check(label !== null)
      const index = this.nextIndex(label ?? '')
      style = this.raw.styles[label ?? ''] ?? null
      check(style !== null)
      const list = this.raw.colors[label ?? '']
      if (list !== undefined) {
        colors = {
          fill: pickColor(list.fill, index),
          line: pickColor(list.line, index),
          effect: pickColor(list.effect, index),
          text: pickColor(list.textFill, index),
        }
      }
    }
    const refs: StyleRefs | null =
      style === null
        ? null
        : {
            fill:
              style.fill === null
                ? null
                : { idx: style.fill.idx, color: colors.fill ?? style.fill.color },
            line:
              style.line === null
                ? null
                : { idx: style.line.idx, color: colors.line ?? style.line.color },
            effect:
              style.effect === null
                ? null
                : { idx: style.effect.idx, color: colors.effect ?? style.effect.color },
            font: style.font,
          }
    const layers = [pres?.props, source?.props].filter((p) => p !== undefined)
    const fillSpec = layers.find((p) => p.fill !== null)?.fill ?? null
    const effectSpec = layers.find((p) => p.effects !== null)?.effects ?? null
    const paint = () => {
      // SmartArt 按平面绘制：改变外观的三维设置（形状自身或样式引用的效果样式中）使整个图形不绘制。
      const three = shapeThreeD(layers, refs, this.styleScope)
      if (visibleThreeD(three.scene, three.shape)) this.styleScope.found.push('effect3d')
      const fill = resolveShapeFill(fillSpec, refs, { kind: 'none' }, this.styleScope)
      // 图片填充的部件不在幻灯片的图片清单中，未实现。
      check(fill.kind !== 'picture')
      return {
        fill,
        line: resolveShapeLine(
          layers.map((p) => p.line),
          refs,
          this.styleScope,
        ),
        effects: resolveShapeEffects(effectSpec, refs, this.styleScope),
      }
    }
    let shape: DiagramShape | null = null
    let connector: DiagramNode['connector'] = null
    if (drawn && spec !== null) {
      if (spec.type === 'conn') {
        check(algorithm.type === 'conn')
        connector = paint()
      } else {
        shape = { geometry: geometryOf(spec), rotation: spec.rotation, ...paint() }
      }
    }
    let text: TextBody | null = null
    if (textual && rawText !== null) {
      check(!customSize(rawText))
      text = this.text(rawText, refs, colors.text, spec?.rotation ?? 0)
    }
    return {
      name: atom.name,
      pointType: point.type,
      algorithm,
      shape,
      connector,
      text,
      constraints: state.constraints,
      rules: state.rules,
      neighborFactor: {
        x: (pres?.custom.custLinFactNeighborX ?? 0) / 100000,
        y: (pres?.custom.custLinFactNeighborY ?? 0) / 100000,
      },
      children: state.children,
    }
  }

  private text(
    raw: RawTextBody,
    style: StyleRefs | null,
    color: ColorSpec | null,
    rotation: number,
  ): TextBody {
    const resolved = resolveTextBody(
      { ...raw, body: {} },
      {
        theme: this.scope.theme,
        colors: this.scope.colors,
        listStyles: [
          textDefaults(style, color === null ? null : resolvable(color, this.scope.colors)),
        ],
        bodies: [],
      },
    )
    return {
      paragraphs: resolved.paragraphs,
      body: {
        ...resolved.body,
        rotation: -rotation,
        wrap: true,
        insetLeft: 0,
        insetTop: 0,
        insetRight: 0,
        insetBottom: 0,
        anchor: 'ctr',
        anchorCenter: false,
        autofit: { kind: 'none' },
      },
    }
  }
}

/** 无法求值的颜色按未指定处理。 */
function resolvable(spec: ColorSpec, context: ColorContext): ColorSpec | null {
  return resolveColor(spec, context) === null ? null : spec
}

/** 图示文字用到的字体名加入 `out`。 */
export function collectDiagramFonts(out: Set<string>, diagram: Diagram): void {
  const visit = (n: DiagramNode) => {
    if (n.text !== null) collectTextFonts(out, n.text)
    for (const c of n.children) visit(c)
  }
  visit(diagram.root)
}

/** 不支持的布局或内容返回 `null`。 */
export function resolveDiagram(raw: RawDiagram, scope: DiagramScope): Diagram | null {
  try {
    return new Builder(raw, scope).build()
  } catch (e) {
    if (e instanceof Unsupported) return null
    throw e
  }
}
