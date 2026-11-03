/**
 * 工作表绘图部件（`xl/drawings/drawingN.xml`）：读取锚点中的图片与形状，其余对象按种类计数。
 *
 * - 用 `PartScanner` 展开 `AlternateContent`：不声明支持任何扩展命名空间，因此取 `Fallback`；
 *   只有 `Choice` 的对象（如 2010 版表单控件的形状）不产出，控件改由关系计数。
 * - 锚点的直接子对象：`pic` 为图片；`sp`、`cxnSp`、`grpSp` 为形状，填充、线条、效果、样式引用与文字经
 *   `../../drawingml/` 求值（颜色映射取默认映射，文字的列表样式依次为形状自身的 `lstStyle`、`fontRef`
 *   与 `SHEET_TEXT_DEFAULTS`）；
 *   `graphicFrame` 按 `graphicData/@uri` 区分图表与其他对象（SmartArt、表格），后者与 `contentPart` 计为 `graphic`；
 *   锚点完整的图表只记录图表部件名（`charts`），组合内与关系缺失的图表计为 `chart`。
 *   组合内的图片计入未显示的图片，组合内的其他对象同样按种类计数。
 * - `cNvPr/@hidden` 为真的对象不显示，也不计数（含其中的未实现内容与组合内的对象）。锚点不完整或顶层形状缺少
 *   `xfrm` 时不显示并计为 `graphic`：形状的坐标系由顶层 `xfrm` 确定（见 `SheetShape`）。
 * - 锚点按文档顺序编号（`order`），图片与形状共用同一序列。
 * - 工作表部件中的控件（`readControls`）：`AlternateContent` 按 `x14` 命名空间选择分支，2010 版起的 `controlPr` 写在要求
 *   `x14` 的 `Choice` 中，给出替代图片的关系与单元格锚点。
 */

import { type RelativeRect, readFill, type ShapeFill, ZERO_RECT } from '../../drawingml/fill.ts'
import type { Geometry } from '../../drawingml/geometry/model.ts'
import type { DrawingFinding, FindingSink } from '../../drawingml/shape/model.ts'
import {
  countOtherEffects,
  EMPTY_NON_VISUAL,
  EMPTY_PROPS,
  type NonVisual,
  readNonVisual,
  readShapeProps,
  readStyle,
  type ShapeProps,
  type StyleRefs,
} from '../../drawingml/shape/read.ts'
import {
  childTransform,
  countEffects,
  countText,
  EMPTY_XFRM,
  fontRefStyle,
  frameOf,
  IDENTITY_TRANSFORM,
  resolveShapeEffects,
  resolveShapeFill,
  resolveShapeLine,
  type StyleScope,
  shapeThreeD,
  type Transform,
} from '../../drawingml/shape/resolve.ts'
import { collectTextFonts, MISSING_LATIN } from '../../drawingml/text/fonts.ts'
import {
  type ListStyleSpec,
  type RawTextBody,
  readTextBody,
  type TextContext,
} from '../../drawingml/text/read.ts'
import { resolveTextBody } from '../../drawingml/text/resolve.ts'
import type { Theme } from '../../drawingml/theme.ts'
import { visibleThreeD } from '../../drawingml/three/camera.ts'
import type { Relationships } from '../../opc/package.ts'
import { eachChild, readText, relAttr, type Scanner } from '../../opc/read.ts'
import { PartScanner } from '../../opc/scanner.ts'
import type {
  AnchorMarker,
  DrawingAnchor,
  ShapeNode,
  SheetShape,
  UnsupportedCounts,
  UnsupportedKind,
} from '../model.ts'

export interface DrawingPicture {
  readonly anchor: DrawingAnchor
  readonly order: number
  /** 图片部件名；关系不存在或为外部链接时为 `null`。 */
  readonly part: string | null
  /** `srcRect` 裁剪比例（0–1），四边各自从原图边缘向内。 */
  readonly crop: RelativeRect
}

/** 锚定在工作表上的图表（不在组合内）：图表部件名，部件的读取与求值由调用方完成。 */
export interface DrawingChart {
  readonly anchor: DrawingAnchor
  readonly order: number
  readonly part: string
}

export interface ParsedDrawing {
  readonly pictures: DrawingPicture[]
  readonly shapes: SheetShape[]
  readonly charts: DrawingChart[]
  /** 锚点个数，即下一个对象的序号。 */
  readonly anchors: number
  readonly unsupported: UnsupportedCounts
}

/** 工作表的一个控件（`controls/control`）。 */
export interface RawControl {
  /** `control/@r:id`：控件部件（ActiveX 控件或表单控件属性）的关系 ID。 */
  readonly control: string | null
  /** `controlPr/@r:id`：替代图片的关系 ID；没有时为 `null`。 */
  readonly image: string | null
  /** `controlPr/anchor` 的单元格锚点；缺失或不完整时为 `null`。 */
  readonly anchor: DrawingAnchor | null
}

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'

const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const ANCHORS = new Set(['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'])
const RECT: Geometry = { kind: 'preset', name: 'rect', adjust: [] }
const LINE: Geometry = { kind: 'preset', name: 'line', adjust: [] }
const NONE: ShapeFill = { kind: 'none' }

/**
 * 形状文字样式链的末项：未指定的字号为 11 磅，西文与东亚字体为主题正文字体。WPS 实测：`rPr` 只有 `lang` 的文字与
 * 显式写出 `sz="1100"`、`+mn-lt`、`+mn-ea` 的文字显示相同，主题正文字体改为 Times New Roman 与楷体时随之改变。
 */
const SHEET_TEXT_DEFAULTS: ListStyleSpec = {
  levels: Array.from({ length: 9 }, () => ({ run: { size: 11, latin: '+mn-lt', ea: '+mn-ea' } })),
}

/** 形状中未绘制的部分在工作表计数中的种类；图片格式（含图片项目符号）归入未显示的图片。 */
const FINDING_KIND: Record<DrawingFinding, UnsupportedKind> = {
  textWarp: 'textWarp',
  effect3d: 'effect3d',
  effect: 'effect',
  verticalText: 'verticalText',
  imageFormat: 'image',
}

/** 形状读取结果。`pending` 为读取时遇到的未实现内容与组合内未显示的对象，节点显示时才计入。 */
type RawNode = {
  readonly nv: NonVisual
  readonly props: ShapeProps
  readonly pending: readonly UnsupportedKind[]
} & (
  | {
      readonly kind: 'shape'
      readonly style: StyleRefs | null
      readonly text: RawTextBody | null
    }
  | { readonly kind: 'connector'; readonly style: StyleRefs | null }
  | { readonly kind: 'group'; readonly children: readonly RawNode[] }
)

interface RawPicture {
  readonly kind: 'picture'
  readonly hidden: boolean
  readonly part: string | null
  readonly crop: RelativeRect
}

/** 不显示的对象（图表、SmartArt、墨迹等）：计数的种类；隐藏时为 `null`。 */
interface RawOther {
  readonly kind: 'other'
  readonly counted: UnsupportedKind | null
  /** 可见的图表引用的图表部件名；其他对象与关系缺失时为 `null`。 */
  readonly chart: string | null
}

function count(counts: UnsupportedCounts, kind: UnsupportedKind): void {
  counts[kind] = (counts[kind] ?? 0) + 1
}

/** 把读取时登记的未实现内容换算为工作表计数的种类，记入 `pending`。 */
function pendingContext(rels: Relationships, pending: UnsupportedKind[]): TextContext {
  const found: FindingSink = {
    push(...kinds: DrawingFinding[]) {
      for (const k of kinds) pending.push(FINDING_KIND[k])
    },
  }
  return { rels, found }
}

function readMarker(x: Scanner): AnchorMarker {
  const m = { col: 0, colOff: 0, row: 0, rowOff: 0 }
  eachChild(x, (local) => {
    if (local === 'col' || local === 'colOff' || local === 'row' || local === 'rowOff') {
      m[local] = Number(readText(x).trim()) || 0
    }
  })
  return m
}

function numberAttr(x: Scanner, name: string): number {
  const v = Number(x.attr(name) ?? '')
  return Number.isFinite(v) ? v : 0
}

function readPicture(x: Scanner, rels: Relationships): RawPicture {
  let hidden = false
  let part: string | null = null
  let crop = ZERO_RECT
  eachChild(x, (local) => {
    if (local === 'nvPicPr') hidden = readNonVisual(x, null).hidden
    else if (local === 'blipFill') {
      const fill = readFill(x, rels)
      if (fill.kind === 'picture') {
        part = fill.image.part
        crop = fill.image.crop
      }
    }
  })
  return { kind: 'picture', hidden, part, crop }
}

function readGraphicFrame(x: Scanner, rels: Relationships): RawOther {
  let hidden = false
  let chart = false
  let part: string | null = null
  eachChild(x, (child) => {
    if (child === 'nvGraphicFramePr') hidden = readNonVisual(x, null).hidden
    else if (child === 'graphic') {
      eachChild(x, (data) => {
        if (data !== 'graphicData' || x.attr('uri') !== CHART_URI) return
        chart = true
        eachChild(x, (c) => {
          if (c !== 'chart') return
          const rel = rels.byId(relAttr(x, 'id') ?? '')
          part = rel === null || rel.external ? null : rel.part
        })
      })
    }
  })
  if (hidden) return { kind: 'other', counted: null, chart: null }
  return { kind: 'other', counted: chart ? 'chart' : 'graphic', chart: part }
}

/** 在锚点或组合的子对象的开始标签处调用；不认识的元素返回 `null`。 */
function readObject(
  x: Scanner,
  local: string,
  rels: Relationships,
): RawNode | RawPicture | RawOther | null {
  const pending: UnsupportedKind[] = []
  const cx = pendingContext(rels, pending)
  let nv = EMPTY_NON_VISUAL
  let props = EMPTY_PROPS
  let style: StyleRefs | null = null
  switch (local) {
    case 'pic':
      return readPicture(x, rels)
    case 'graphicFrame':
      return readGraphicFrame(x, rels)
    case 'contentPart':
      return { kind: 'other', counted: 'graphic', chart: null }
    case 'sp': {
      let text: RawTextBody | null = null
      eachChild(x, (child) => {
        if (child === 'nvSpPr') nv = readNonVisual(x, null)
        else if (child === 'spPr') props = readShapeProps(x, cx)
        else if (child === 'style') style = readStyle(x)
        else if (child === 'txBody') text = readTextBody(x, cx)
      })
      return { kind: 'shape', nv, props, pending, style, text }
    }
    case 'cxnSp':
      eachChild(x, (child) => {
        if (child === 'nvCxnSpPr') nv = readNonVisual(x, null)
        else if (child === 'spPr') props = readShapeProps(x, cx)
        else if (child === 'style') style = readStyle(x)
      })
      return { kind: 'connector', nv, props, pending, style }
    case 'grpSp': {
      const children: RawNode[] = []
      eachChild(x, (child) => {
        if (child === 'nvGrpSpPr') nv = readNonVisual(x, null)
        else if (child === 'grpSpPr') props = readShapeProps(x, cx)
        else {
          const member = readObject(x, child, rels)
          if (member === null) return
          if (member.kind === 'picture') {
            if (!member.hidden) pending.push('image')
          } else if (member.kind === 'other') {
            if (member.counted !== null) pending.push(member.counted)
          } else {
            children.push(member)
          }
        }
      })
      return { kind: 'group', nv, props, pending, children }
    }
    default:
      return null
  }
}

function buildAnchor(
  kind: string,
  from: AnchorMarker | null,
  to: AnchorMarker | null,
  pos: { x: number; y: number },
  ext: { cx: number; cy: number },
): DrawingAnchor | null {
  if (kind === 'twoCellAnchor' && from && to) return { kind: 'twoCell', from, to }
  if (kind === 'oneCellAnchor' && from)
    return { kind: 'oneCell', from, width: ext.cx, height: ext.cy }
  if (kind === 'absoluteAnchor') {
    return { kind: 'absolute', x: pos.x, y: pos.y, width: ext.cx, height: ext.cy }
  }
  return null
}

class Resolver {
  readonly scope: StyleScope

  constructor(
    theme: Theme,
    private readonly counts: UnsupportedCounts,
    private readonly fontNames: Set<string>,
  ) {
    const found: FindingSink = {
      push: (...kinds: DrawingFinding[]) => {
        for (const k of kinds) count(counts, FINDING_KIND[k])
      },
    }
    this.scope = { theme, colors: { scheme: theme.colors }, found }
  }

  /** 形状与文字的图片填充计入未显示的图片：绘制端只取得锚定图片的位图。 */
  private countFill(fill: ShapeFill): void {
    if (fill.kind === 'picture') count(this.counts, 'image')
  }

  /** 隐藏的节点返回 `null`，其中的内容不计数。 */
  node(raw: RawNode, t: Transform, group: ShapeFill): ShapeNode | null {
    if (raw.nv.hidden) return null
    for (const k of raw.pending) count(this.counts, k)
    const scope = this.scope
    const frame = frameOf(raw.props.xfrm ?? EMPTY_XFRM, t)
    const effects = resolveShapeEffects(
      raw.props.effects,
      raw.kind === 'group' ? null : raw.style,
      scope,
    )
    countOtherEffects(raw.props, scope.found)
    // 自选图形与组合经过效果图层绘制（`../render/shapes.ts` 的 `paintShapeNode`），连接线不经过。
    countEffects(effects, scope.found, raw.kind !== 'connector')
    // 工作表不绘制三维效果：改变外观的三维设置（相机、旋转、棱台、挤出、轮廓）登记 `effect3d`。
    const three = shapeThreeD([raw.props], raw.kind === 'group' ? null : raw.style, scope)
    if (visibleThreeD(three.scene, three.shape)) scope.found.push('effect3d')
    switch (raw.kind) {
      case 'shape': {
        const fill = resolveShapeFill(raw.props.fill, raw.style, group, scope)
        this.countFill(fill)
        const text =
          raw.text === null
            ? null
            : resolveTextBody(raw.text, {
                theme: scope.theme,
                colors: scope.colors,
                listStyles: [fontRefStyle(raw.style?.font ?? null), SHEET_TEXT_DEFAULTS],
                bodies: [],
              })
        if (text !== null) {
          countText(
            text,
            scope.found,
            (f) => this.countFill(f),
            () => scope.found.push('imageFormat'),
          )
          collectTextFonts(this.fontNames, text)
          this.fontNames.add(MISSING_LATIN)
        }
        return {
          kind: 'shape',
          frame,
          geometry: raw.props.geometry ?? RECT,
          fill,
          line: resolveShapeLine([raw.props.line], raw.style, scope),
          effects,
          text,
        }
      }
      case 'connector':
        return {
          kind: 'connector',
          frame,
          geometry: raw.props.geometry ?? LINE,
          line: resolveShapeLine([raw.props.line], raw.style, scope),
          effects,
        }
      case 'group': {
        const fill =
          raw.props.fill === null ? group : resolveShapeFill(raw.props.fill, null, group, scope)
        const inner = childTransform(raw.props.xfrm, t)
        const children: ShapeNode[] = []
        for (const c of raw.children) {
          const child = this.node(c, inner, fill)
          if (child !== null) children.push(child)
        }
        return { kind: 'group', frame, effects, children }
      }
    }
  }
}

/**
 * 解析绘图部件。`rels` 为绘图部件的关系表（图片与超链接目标）；`theme` 为工作簿主题，没有主题部件时传入
 * `EMPTY_THEME`；形状文字用到的字体名与 `MISSING_LATIN` 加入 `fontNames`。
 */
export function parseDrawing(
  xml: string,
  rels: Relationships,
  theme: Theme,
  fontNames: Set<string>,
): ParsedDrawing {
  const x = new PartScanner(xml)
  const pictures: DrawingPicture[] = []
  const shapes: SheetShape[] = []
  const charts: DrawingChart[] = []
  const counts: UnsupportedCounts = {}
  const resolver = new Resolver(theme, counts, fontNames)
  let order = 0
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && x.depth === 1) break
  }
  eachChild(x, (kind) => {
    if (!ANCHORS.has(kind)) return
    let from: AnchorMarker | null = null
    let to: AnchorMarker | null = null
    let pos = { x: 0, y: 0 }
    let ext = { cx: 0, cy: 0 }
    const objects: (RawNode | RawPicture | RawOther)[] = []
    eachChild(x, (local) => {
      if (local === 'from') from = readMarker(x)
      else if (local === 'to') to = readMarker(x)
      else if (local === 'pos') pos = { x: numberAttr(x, 'x'), y: numberAttr(x, 'y') }
      else if (local === 'ext') ext = { cx: numberAttr(x, 'cx'), cy: numberAttr(x, 'cy') }
      else {
        const object = readObject(x, local, rels)
        if (object !== null) objects.push(object)
      }
    })
    const anchor = buildAnchor(kind, from, to, pos, ext)
    const index = order++
    for (const o of objects) {
      if (o.kind === 'other') {
        if (o.chart !== null && anchor !== null)
          charts.push({ anchor, order: index, part: o.chart })
        else if (o.counted !== null) count(counts, o.counted)
      } else if (o.kind === 'picture') {
        if (o.hidden) continue
        if (anchor === null || o.part === null) count(counts, 'image')
        else pictures.push({ anchor, order: index, part: o.part, crop: o.crop })
      } else if (!o.nv.hidden) {
        if (anchor === null || o.props.xfrm === null) {
          count(counts, 'graphic')
          for (const k of o.pending) count(counts, k)
          continue
        }
        const shape = resolver.node(o, IDENTITY_TRANSFORM, NONE)
        if (shape !== null) shapes.push({ anchor, order: index, shape })
      }
    }
  })
  return { pictures, shapes, charts, anchors: order, unsupported: counts }
}

/** 读取工作表部件中 `controls` 的各个控件。 */
export function readControls(xml: string): RawControl[] {
  const x = new PartScanner(xml, [X14])
  const out: RawControl[] = []
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2 || x.local !== 'controls') continue
    eachChild(x, (local) => {
      if (local === 'control') out.push(readControl(x))
    })
  }
  return out
}

function readControl(x: Scanner): RawControl {
  const control = relAttr(x, 'id')
  let image: string | null = null
  let anchor: DrawingAnchor | null = null
  eachChild(x, (local) => {
    if (local !== 'controlPr') return
    image = relAttr(x, 'id')
    eachChild(x, (inner) => {
      if (inner !== 'anchor') return
      let from: AnchorMarker | null = null
      let to: AnchorMarker | null = null
      eachChild(x, (m) => {
        if (m === 'from') from = readMarker(x)
        else if (m === 'to') to = readMarker(x)
      })
      anchor = buildAnchor('twoCellAnchor', from, to, { x: 0, y: 0 }, { cx: 0, cy: 0 })
    })
  })
  return { control, image, anchor }
}
