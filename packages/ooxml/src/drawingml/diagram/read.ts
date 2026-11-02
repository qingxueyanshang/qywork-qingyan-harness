/**
 * SmartArt 部件的读取：图形框中的部件引用（`dgm:relIds`）、数据部件、布局定义、颜色定义与样式定义。
 *
 * - 三种格式共用：调用方按所在部件的关系表取得四个部件名（`readDiagramParts`），读出文本后交给 `readDiagram`。
 * - 元素按本地名匹配，不限定前缀。图形部件（`dsp:dataModelExt` 所指）不读取：WPS 不按它显示。
 * - 布局定义中未识别的元素读为 `unknown`，由求值阶段决定整个图示不绘制。
 */

import type { Relationships } from '../../opc/package.ts'
import { eachChild, num, relAttr, type Scanner, skip } from '../../opc/read.ts'
import { PartScanner } from '../../opc/scanner.ts'
import { type ColorSpec, isColorElement, readColor } from '../color.ts'
import {
  EMPTY_PROPS,
  readShapeProps,
  readStyle,
  type ShapeProps,
  type StyleRefs,
} from '../shape/read.ts'
import { type RawTextBody, readTextBody, type TextContext } from '../text/read.ts'
import type {
  ColorLabel,
  ColorList,
  Condition,
  Constraint,
  DataConnection,
  DataModel,
  DataPoint,
  Iteration,
  LayoutAtom,
  PointType,
  RawDiagram,
  Rule,
  ShapeSpec,
} from './model.ts'

/** 图示的四个部件名；数据部件之外缺失或关系无效的为 `null`。 */
export interface DiagramParts {
  readonly data: string
  readonly layout: string | null
  readonly style: string | null
  readonly colors: string | null
}

/** 四个部件的 XML；`dataRels` 为数据部件的关系表（填充中的图片）。 */
export interface DiagramSource {
  readonly data: string
  readonly dataRels: Relationships
  readonly layout: string | null
  readonly style: string | null
  readonly colors: string | null
}

const POINT_TYPES = new Set<string>(['doc', 'node', 'asst', 'parTrans', 'sibTrans', 'pres'])

function part(rels: Relationships, id: string | null): string | null {
  if (id === null) return null
  const rel = rels.byId(id)
  return rel === null || rel.external ? null : rel.part
}

/** 在 `relIds` 的开始标签处调用；`rels` 为图形框所在部件的关系表。数据部件无效时返回 `null`。 */
export function readDiagramParts(x: Scanner, rels: Relationships): DiagramParts | null {
  const data = part(rels, relAttr(x, 'dm'))
  const parts = {
    layout: part(rels, relAttr(x, 'lo')),
    style: part(rels, relAttr(x, 'qs')),
    colors: part(rels, relAttr(x, 'cs')),
  }
  skip(x)
  return data === null ? null : { data, ...parts }
}

/** 定位到根元素的开始标签；根元素不是 `local` 时返回 `false`。 */
function root(x: Scanner, local: string): boolean {
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && x.depth === 1) return x.local === local
  }
  return false
}

function attributes(x: Scanner): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < x.attrCount; i++) {
    const name = x.attrName(i)
    out[name.slice(name.indexOf(':') + 1)] = x.attrValue(i)
  }
  return out
}

function readPoint(x: Scanner, cx: TextContext): DataPoint {
  const id = x.attr('modelId') ?? ''
  const t = x.attr('type') ?? 'node'
  const type = (POINT_TYPES.has(t) ? t : 'node') as PointType
  let text: RawTextBody | null = null
  let props: ShapeProps = EMPTY_PROPS
  let set: Record<string, string> = {}
  const vars: Record<string, string> = {}
  eachChild(x, (local) => {
    if (local === 'prSet') {
      set = attributes(x)
      eachChild(x, (child) => {
        if (child !== 'presLayoutVars') return
        eachChild(x, (name) => {
          vars[name] = x.attr('val') ?? ''
        })
      })
    } else if (local === 'spPr') props = readShapeProps(x, cx)
    else if (local === 't') text = readTextBody(x, cx)
  })
  const custom: Record<string, number> = {}
  for (const [k, v] of Object.entries(set)) {
    if (!k.startsWith('cust')) continue
    const n = Number(v)
    custom[k] = Number.isFinite(n) ? n : 0
  }
  return {
    id,
    type,
    text,
    props,
    presName: set.presName ?? null,
    presAssoc: set.presAssocID ?? null,
    styleLabel: set.presStyleLbl ?? null,
    vars,
    custom,
  }
}

function readConnection(x: Scanner): DataConnection {
  const c: DataConnection = {
    type: x.attr('type') ?? 'parOf',
    src: x.attr('srcId') ?? '',
    dest: x.attr('destId') ?? '',
    srcOrd: num(x, 'srcOrd') ?? 0,
    parTrans: x.attr('parTransId'),
    sibTrans: x.attr('sibTransId'),
  }
  skip(x)
  return c
}

/** 元素有任何子元素。 */
function hasChildren(x: Scanner): boolean {
  let found = false
  eachChild(x, (local) => {
    if (local !== 'extLst') found = true
  })
  return found
}

function readData(xml: string, rels: Relationships): DataModel {
  const x = new PartScanner(xml)
  const points: DataPoint[] = []
  const connections: DataConnection[] = []
  let decorated = false
  const cx: TextContext = { rels, found: { push: () => 0 } }
  if (!root(x, 'dataModel')) return { points, connections, decorated }
  eachChild(x, (local) => {
    if (local === 'ptLst') {
      eachChild(x, (pt) => {
        if (pt === 'pt') points.push(readPoint(x, cx))
      })
    } else if (local === 'cxnLst') {
      eachChild(x, (c) => {
        if (c === 'cxn') connections.push(readConnection(x))
      })
    } else if ((local === 'bg' || local === 'whole') && hasChildren(x)) decorated = true
  })
  return { points, connections, decorated }
}

/** 数值属性：`NaN`、`INF` 按字面读取。 */
function numeric(x: Scanner, name: string, fallback: number): number {
  const v = x.attr(name)
  if (v === null || v === '') return fallback
  if (v === 'INF') return Number.POSITIVE_INFINITY
  if (v === '-INF') return Number.NEGATIVE_INFINITY
  if (v === 'NaN') return Number.NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readIteration(x: Scanner): Iteration {
  return {
    axis: x.attr('axis') ?? 'none',
    ptType: x.attr('ptType') ?? 'all',
    start: numeric(x, 'st', 1),
    count: numeric(x, 'cnt', 0),
    step: numeric(x, 'step', 1),
    hideLastTrans: x.attr('hideLastTrans') !== 'false' && x.attr('hideLastTrans') !== '0',
  }
}

function readCondition(x: Scanner): Condition {
  return {
    ...readIteration(x),
    func: x.attr('func') ?? '',
    arg: x.attr('arg') ?? 'none',
    op: x.attr('op') ?? '',
    val: x.attr('val') ?? '',
  }
}

function readConstraint(x: Scanner): Constraint {
  const val = x.attr('val')
  const c: Constraint = {
    type: x.attr('type') ?? 'none',
    for: x.attr('for') ?? 'self',
    forName: x.attr('forName') ?? '',
    ptType: x.attr('ptType') ?? 'all',
    refType: x.attr('refType') ?? 'none',
    refFor: x.attr('refFor') ?? 'self',
    refForName: x.attr('refForName') ?? '',
    refPtType: x.attr('refPtType') ?? 'all',
    op: x.attr('op') ?? 'none',
    val: val === null ? null : numeric(x, 'val', 0),
    fact: numeric(x, 'fact', 1),
  }
  skip(x)
  return c
}

function readRule(x: Scanner): Rule {
  const r: Rule = {
    type: x.attr('type') ?? 'none',
    for: x.attr('for') ?? 'self',
    forName: x.attr('forName') ?? '',
    ptType: x.attr('ptType') ?? 'all',
    val: numeric(x, 'val', Number.NaN),
    fact: numeric(x, 'fact', Number.NaN),
    max: numeric(x, 'max', Number.NaN),
  }
  skip(x)
  return r
}

function readShapeSpec(x: Scanner): ShapeSpec {
  const type = x.attr('type') ?? ''
  const rotation = numeric(x, 'rot', 0)
  const hide = x.attr('hideGeom')
  const adjust: { idx: number; val: number }[] = []
  eachChild(x, (local) => {
    if (local !== 'adjLst') return
    eachChild(x, (adj) => {
      if (adj === 'adj') adjust.push({ idx: numeric(x, 'idx', 1), val: numeric(x, 'val', 0) })
    })
  })
  return { type, rotation, hideGeometry: hide === '1' || hide === 'true', adjust }
}

function readAtoms(x: Scanner): LayoutAtom[] {
  const out: LayoutAtom[] = []
  eachChild(x, (local) => {
    const atom = readAtom(x, local)
    if (atom !== null) out.push(atom)
  })
  return out
}

/** 在布局定义元素的开始标签处调用；扩展元素返回 `null`。 */
function readAtom(x: Scanner, local: string): LayoutAtom | null {
  switch (local) {
    case 'layoutNode':
      return {
        kind: 'layoutNode',
        name: x.attr('name') ?? '',
        styleLabel: x.attr('styleLbl'),
        children: readAtoms(x),
      }
    case 'alg': {
      const type = x.attr('type') ?? ''
      const params: Record<string, string> = {}
      eachChild(x, (p) => {
        if (p === 'param') params[x.attr('type') ?? ''] = x.attr('val') ?? ''
      })
      return { kind: 'alg', type, params }
    }
    case 'shape':
      return { kind: 'shape', shape: readShapeSpec(x) }
    case 'presOf': {
      const iteration = readIteration(x)
      skip(x)
      return { kind: 'presOf', iteration }
    }
    case 'constrLst': {
      const list: Constraint[] = []
      eachChild(x, (c) => {
        if (c === 'constr') list.push(readConstraint(x))
      })
      return { kind: 'constraints', list }
    }
    case 'ruleLst': {
      const list: Rule[] = []
      eachChild(x, (r) => {
        if (r === 'rule') list.push(readRule(x))
      })
      return { kind: 'rules', list }
    }
    case 'varLst': {
      const vars: Record<string, string> = {}
      eachChild(x, (name) => {
        vars[name] = x.attr('val') ?? ''
      })
      return { kind: 'vars', vars }
    }
    case 'choose': {
      const branches: { condition: Condition | null; children: LayoutAtom[] }[] = []
      eachChild(x, (b) => {
        if (b === 'if') {
          const condition = readCondition(x)
          branches.push({ condition, children: readAtoms(x) })
        } else if (b === 'else') branches.push({ condition: null, children: readAtoms(x) })
      })
      return { kind: 'choose', branches }
    }
    case 'forEach': {
      const iteration = readIteration(x)
      const ref = x.attr('ref')
      return { kind: 'forEach', iteration, ref, children: readAtoms(x) }
    }
    case 'extLst':
      skip(x)
      return null
    default:
      skip(x)
      return { kind: 'unknown', name: local }
  }
}

function readLayout(xml: string): LayoutAtom | null {
  const x = new PartScanner(xml)
  if (!root(x, 'layoutDef')) return null
  let node: LayoutAtom | null = null
  eachChild(x, (local) => {
    if (local === 'layoutNode' && node === null) node = readAtom(x, local)
  })
  return node
}

function readColorList(x: Scanner): ColorList {
  const method = x.attr('meth') ?? 'repeat'
  const colors: ColorSpec[] = []
  eachChild(x, (local) => {
    if (!isColorElement(local)) return
    const c = readColor(x)
    if (c !== null) colors.push(c)
  })
  return { method, colors }
}

const NO_COLORS: ColorList = { method: 'repeat', colors: [] }

function readColors(xml: string): Record<string, ColorLabel> {
  const x = new PartScanner(xml)
  const out: Record<string, ColorLabel> = {}
  if (!root(x, 'colorsDef')) return out
  eachChild(x, (local) => {
    if (local !== 'styleLbl') return
    const name = x.attr('name') ?? ''
    const label = { fill: NO_COLORS, line: NO_COLORS, effect: NO_COLORS, textFill: NO_COLORS }
    eachChild(x, (list) => {
      if (list === 'fillClrLst') label.fill = readColorList(x)
      else if (list === 'linClrLst') label.line = readColorList(x)
      else if (list === 'effectClrLst') label.effect = readColorList(x)
      else if (list === 'txFillClrLst') label.textFill = readColorList(x)
    })
    out[name] = label
  })
  return out
}

function readStyles(xml: string): Record<string, StyleRefs> {
  const x = new PartScanner(xml)
  const out: Record<string, StyleRefs> = {}
  if (!root(x, 'styleDef')) return out
  eachChild(x, (local) => {
    if (local !== 'styleLbl') return
    const name = x.attr('name') ?? ''
    eachChild(x, (child) => {
      if (child === 'style') out[name] = readStyle(x)
    })
  })
  return out
}

export function readDiagram(source: DiagramSource): RawDiagram {
  return {
    data: readData(source.data, source.dataRels),
    layout: source.layout === null ? null : readLayout(source.layout),
    colors: source.colors === null ? {} : readColors(source.colors),
    styles: source.style === null ? {} : readStyles(source.style),
  }
}
