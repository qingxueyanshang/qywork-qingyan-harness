/**
 * 浮动对象：`wp:anchor`（DrawingML）与 `w:pict` 中绝对定位的 VML 形状。读取定位、环绕与可绘制的内容。
 *
 * - DrawingML：图片（`pic:pic`）为图片填充的矩形；形状（`wps:wsp`）的几何、填充、线条与效果经 `../../drawingml/`
 *   按主题求值，文本框（`wps:txbx`）的内容由调用方读取；组合（`wpg:wgp`）的子坐标系按 `chOff`、`chExt` 换算到对象框。
 *   图表（`c:chart`）由调用方按关系标识取得已求值的图表，对象框即图表区；SmartArt（`dgm:relIds`）由调用方按四个部件名
 *   取得已求值的图示，在对象框中排版。画布、扩展图表（`chartex`）与含未实现内容的图表、SmartArt 没有可绘制的内容
 *   （`drawing` 为 `null`），按种类计数。
 * - 顶层形状的 `xfrm` 映射到对象框（`wp:extent`），原点在对象框左上角。
 * - 文本框的内缩：DrawingML 的 `bodyPr` 缺省为左右 7.2 磅、上下 3.6 磅；VML 的 `v:textbox/@inset` 缺省相同。
 * - VML：`style` 中的 `margin-left`、`margin-top`、`width`、`height` 与 `mso-position-*` 给出定位，`w10:wrap` 给出环绕，
 *   没有 `w10:wrap` 时为浮于文字上方；`z-index` 为负时衬于文字下方。组合等其他 VML 计为 `vml`。
 */

import type { Chart } from '../../drawingml/chart/model.ts'
import { parseHexColor } from '../../drawingml/color.ts'
import type { Diagram } from '../../drawingml/diagram/model.ts'
import { type DiagramParts, readDiagramParts } from '../../drawingml/diagram/read.ts'
import {
  type Effect,
  type Line,
  type RelativeRect,
  readFill,
  type ShapeFill,
  ZERO_RECT,
} from '../../drawingml/fill.ts'
import type { Geometry } from '../../drawingml/geometry/model.ts'
import type { DrawingFinding, FindingSink, Frame } from '../../drawingml/shape/model.ts'
import {
  countOtherEffects,
  EMPTY_PROPS,
  readShapeProps,
  readStyle,
  type ShapeProps,
  type StyleRefs,
  type Xfrm,
} from '../../drawingml/shape/read.ts'
import {
  childTransform,
  countEffects,
  EMPTY_XFRM,
  frameOf,
  resolveShapeEffects,
  resolveShapeFill,
  resolveShapeLine,
  type StyleScope,
  shapeThreeD,
  type Transform,
} from '../../drawingml/shape/resolve.ts'
import { visibleThreeD } from '../../drawingml/three/camera.ts'
import type { Relationships } from '../../opc/package.ts'
import type { AnchorPosition, DrawingGraphic, Edges, UnsupportedKind, Wrap } from '../model.ts'
import { eachChild, type Scanner, skip } from './xml.ts'

const EMU_PER_POINT = 12700
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RECT: Geometry = { kind: 'preset', name: 'rect', adjust: [] }
const NO_FILL: ShapeFill = { kind: 'none' }
const ZERO_EDGES: Edges = { left: 0, top: 0, right: 0, bottom: 0 }
/** 文本框缺省内缩（磅）：左右 0.1 英寸，上下 0.05 英寸。 */
const DEFAULT_INSET: Edges = { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 }

/** `graphicData/@uri` 为图表时的后缀；扩展图表（`chartex`）不在其中。 */
export const CHART_URI = '/drawingml/2006/chart'
/** `graphicData/@uri` 为 SmartArt 时的后缀。 */
export const DIAGRAM_URI = '/drawingml/2006/diagram'

/** 图表与 SmartArt 的对象框（EMU）：宽高为 `wp:extent`（磅）。 */
export function graphicFrame(width: number, height: number): Frame {
  return {
    x: 0,
    y: 0,
    width: width * EMU_PER_POINT,
    height: height * EMU_PER_POINT,
    rotation: 0,
    flipH: false,
    flipV: false,
  }
}

const GRAPHIC_KINDS: readonly (readonly [string, UnsupportedKind])[] = [
  ['/drawingml/2006/chart', 'chart'],
  ['/drawing/2014/chartex', 'chart'],
  ['/drawingml/2006/diagram', 'smartArt'],
  ['/wordprocessingCanvas', 'canvas'],
]

const FINDING_KINDS: Readonly<Record<DrawingFinding, UnsupportedKind>> = {
  textWarp: 'effect',
  effect3d: 'effect',
  effect: 'effect',
  verticalText: 'effect',
  pictureBullet: 'effect',
  imageFormat: 'imageFormat',
}

/** 读取过程中待调用方解决的内容：文本框的内容类型由调用方决定。 */
export interface PendingTextBox<C> {
  readonly content: C
  readonly inset: Edges
  readonly anchor: 'top' | 'center' | 'bottom'
  readonly autoFit: boolean
  readonly wrap: boolean
  readonly turned: 0 | 90 | 270
}

export type PendingNode<C> =
  | {
      readonly kind: 'shape'
      readonly frame: Frame
      readonly geometry: Geometry
      readonly fill: ShapeFill
      readonly line: Line | null
      readonly effects: readonly Effect[]
      readonly text: PendingTextBox<C> | null
    }
  | {
      readonly kind: 'group'
      readonly frame: Frame
      readonly effects: readonly Effect[]
      readonly children: readonly PendingNode<C>[]
    }
  | DrawingGraphic

export interface PendingAnchor<C> {
  readonly horizontal: AnchorPosition
  readonly vertical: AnchorPosition
  readonly width: number
  readonly height: number
  readonly effect: Edges
  readonly wrap: Wrap
  readonly behind: boolean
  readonly z: number
  readonly drawing: PendingNode<C> | null
}

export interface DrawingContext<C> {
  readonly rels: Relationships
  readonly scope: StyleScope
  readonly count: (kind: UnsupportedKind) => void
  /** 登记图片部件，使其进入 `DocxDocument.media`。 */
  readonly image: (part: string) => void
  /** 在 `txbxContent` 的开始标签处调用：读取其中的块，返回时位于其结束标签。 */
  readonly content: () => C
  /** 关系标识引用的图表；部件不存在或图表含未实现内容时为 `null`。 */
  readonly chart: (id: string) => Chart | null
  /** 四个部件名引用的 SmartArt；数据部件不存在或含未实现内容时为 `null`。 */
  readonly diagram: (parts: DiagramParts) => Diagram | null
}

function emu(x: Scanner, name: string): number {
  const n = Number(x.attr(name) ?? 0)
  return Number.isFinite(n) ? n / EMU_PER_POINT : 0
}

function textOf(x: Scanner): string {
  const depth = x.depth
  let out = ''
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'text') out += x.text
  }
  return out.trim()
}

function readPosition(x: Scanner): AnchorPosition {
  const from = x.attr('relativeFrom') ?? 'column'
  let align: string | null = null
  let offset = 0
  eachChild(x, (local) => {
    if (local === 'align') align = textOf(x)
    else if (local === 'posOffset') {
      const n = Number(textOf(x))
      offset = Number.isFinite(n) ? n / EMU_PER_POINT : 0
    } else skip(x)
  })
  return { from, align, offset }
}

const WRAP_TYPES: Readonly<Record<string, Wrap['type']>> = {
  wrapNone: 'none',
  wrapSquare: 'square',
  wrapTight: 'tight',
  wrapThrough: 'through',
  wrapTopAndBottom: 'topAndBottom',
}

function wrapSide(v: string | null): Wrap['side'] {
  return v === 'left' || v === 'right' || v === 'largest' ? v : 'bothSides'
}

function sink<C>(cx: DrawingContext<C>): FindingSink {
  return {
    push: (...kinds: DrawingFinding[]) => {
      for (const k of kinds) cx.count(FINDING_KINDS[k])
    },
  }
}

/** 顶层 `xfrm` 映射到对象框（EMU）的变换。 */
function boxTransform(xfrm: Xfrm | null, width: number, height: number): Transform {
  if (xfrm === null || xfrm.width === 0 || xfrm.height === 0)
    return { sx: 1, sy: 1, tx: -(xfrm?.x ?? 0), ty: -(xfrm?.y ?? 0) }
  const sx = width / xfrm.width
  const sy = height / xfrm.height
  return { sx, sy, tx: -xfrm.x * sx, ty: -xfrm.y * sy }
}

/** docx 不绘制三维效果：改变外观的三维设置（相机、旋转、棱台、挤出、轮廓）登记 `effect3d`。 */
function countThreeD(
  props: ShapeProps,
  style: StyleRefs | null,
  scope: StyleScope,
  found: FindingSink,
): void {
  const t = shapeThreeD([props], style, scope)
  if (visibleThreeD(t.scene, t.shape)) found.push('effect3d')
}

/**
 * 文本框的 `TextBox.turned`：`vert`（文字顺时针旋转 90°）与 270° 的形状、`vert270` 与 90° 的形状相抵。横排为 0；其余竖排方式、
 * 与形状旋转不相抵或形状翻转时为 `null`（按横排排版，调用方计入 `verticalText`）。
 */
function turnedText(vert: string | null, frame: Frame): 0 | 90 | 270 | null {
  if (vert === null || vert === 'horz') return 0
  const turn = vert === 'vert' ? 90 : vert === 'vert270' ? 270 : null
  if (turn === null || frame.flipH || frame.flipV) return null
  if ((((frame.rotation + turn) % 360) + 360) % 360 !== 0) return null
  return turn === 90 ? 270 : 90
}

/** 在 `bodyPr` 的开始标签处调用，返回时位于其结束标签。 */
function readBodyInset(x: Scanner): {
  inset: Edges
  anchor: 'top' | 'center' | 'bottom'
  autoFit: boolean
  wrap: boolean
  vert: string | null
} {
  const ins = (name: string, fallback: number) => (x.attr(name) === null ? fallback : emu(x, name))
  const a = x.attr('anchor')
  const vert = x.attr('vert')
  const wrap = x.attr('wrap') !== 'none'
  const inset = {
    left: ins('lIns', DEFAULT_INSET.left),
    top: ins('tIns', DEFAULT_INSET.top),
    right: ins('rIns', DEFAULT_INSET.right),
    bottom: ins('bIns', DEFAULT_INSET.bottom),
  }
  let autoFit = false
  eachChild(x, (local) => {
    if (local === 'spAutoFit') autoFit = true
    skip(x)
  })
  return {
    inset,
    anchor: a === 'ctr' ? 'center' : a === 'b' ? 'bottom' : 'top',
    autoFit,
    wrap,
    vert,
  }
}

/** `pic:pic`、`wps:wsp`、`wpg:wgp`、`wpg:grpSp` 的开始标签处调用；其他元素返回 `null`。 */
function readNode<C>(
  x: Scanner,
  local: string,
  cx: DrawingContext<C>,
  t: Transform | null,
  box: { width: number; height: number },
): PendingNode<C> | null {
  const found = sink(cx)
  const text = { rels: cx.rels, found }
  const scope: StyleScope = { ...cx.scope, found }
  let props: ShapeProps = EMPTY_PROPS
  let style: StyleRefs | null = null
  const frame = (p: ShapeProps): { frame: Frame; inner: Transform } => {
    const xfrm = p.xfrm
    const outer = t ?? boxTransform(xfrm, box.width * EMU_PER_POINT, box.height * EMU_PER_POINT)
    const f = frameOf(xfrm ?? EMPTY_XFRM, outer)
    return { frame: f, inner: childTransform(xfrm, outer) }
  }
  switch (local) {
    case 'pic': {
      let fill: ShapeFill = NO_FILL
      eachChild(x, (child) => {
        if (child === 'blipFill') {
          const spec = readFill(x, cx.rels)
          fill = resolveShapeFill(spec, null, NO_FILL, scope)
          if (fill.kind === 'picture' && fill.image.part !== null) cx.image(fill.image.part)
        } else if (child === 'spPr') props = readShapeProps(x, text)
        else skip(x)
      })
      countThreeD(props, null, scope, found)
      const { frame: f } = frame(props)
      return {
        kind: 'shape',
        frame: f,
        geometry: props.geometry ?? RECT,
        fill,
        line: resolveShapeLine([props.line], null, scope),
        effects: resolveShapeEffects(props.effects, null, scope),
        text: null,
      }
    }
    case 'wsp': {
      let content: C | null = null
      let body = {
        inset: DEFAULT_INSET,
        anchor: 'top' as 'top' | 'center' | 'bottom',
        autoFit: false,
        wrap: true,
        vert: null as string | null,
      }
      eachChild(x, (child) => {
        if (child === 'spPr') props = readShapeProps(x, text)
        else if (child === 'style') style = readStyle(x)
        else if (child === 'txbx') {
          eachChild(x, (inner) => {
            if (inner === 'txbxContent') content = cx.content()
            else skip(x)
          })
        } else if (child === 'bodyPr') body = readBodyInset(x)
        else skip(x)
      })
      const { frame: f } = frame(props)
      const turned = content === null ? 0 : turnedText(body.vert, f)
      if (turned === null) found.push('verticalText')
      countOtherEffects(props, found)
      countThreeD(props, style, scope, found)
      const effects = resolveShapeEffects(props.effects, style, scope)
      countEffects(effects, found)
      const fill = resolveShapeFill(props.fill, style, NO_FILL, scope)
      if (fill.kind === 'picture' && fill.image.part !== null) cx.image(fill.image.part)
      return {
        kind: 'shape',
        frame: f,
        geometry: props.geometry ?? RECT,
        fill,
        line: resolveShapeLine([props.line], style, scope),
        effects,
        text:
          content === null
            ? null
            : {
                content,
                inset: body.inset,
                anchor: body.anchor,
                autoFit: body.autoFit,
                wrap: body.wrap,
                turned: turned ?? 0,
              },
      }
    }
    case 'wgp':
    case 'grpSp': {
      const children: PendingNode<C>[] = []
      let inner: Transform | null = null
      let groupFrame: Frame | null = null
      eachChild(x, (child) => {
        if (child === 'grpSpPr') {
          props = readShapeProps(x, text)
          countThreeD(props, null, scope, found)
          const r = frame(props)
          groupFrame = r.frame
          inner = r.inner
        } else if (child === 'wsp' || child === 'pic' || child === 'grpSp') {
          const node = readNode(x, child, cx, inner ?? t ?? { sx: 1, sy: 1, tx: 0, ty: 0 }, box)
          if (node !== null) children.push(node)
        } else {
          if (child === 'graphicFrame') cx.count('drawing')
          skip(x)
        }
      })
      return {
        kind: 'group',
        frame: groupFrame ?? frame(props).frame,
        effects: resolveShapeEffects(props.effects, null, scope),
        children,
      }
    }
    default:
      return null
  }
}

/**
 * 在 `wp:anchor` 的开始标签处调用，返回时位于其结束标签。`simplePos` 为真时按 `wp:simplePos` 相对页面定位。
 */
export function readAnchor<C>(x: Scanner, cx: DrawingContext<C>): PendingAnchor<C> {
  const distance = {
    top: emu(x, 'distT'),
    bottom: emu(x, 'distB'),
    left: emu(x, 'distL'),
    right: emu(x, 'distR'),
  }
  const simple = x.attr('simplePos') === '1' || x.attr('simplePos') === 'true'
  const behind = x.attr('behindDoc') === '1' || x.attr('behindDoc') === 'true'
  const z = Number(x.attr('relativeHeight') ?? 0) || 0
  let horizontal: AnchorPosition = { from: 'column', align: null, offset: 0 }
  let vertical: AnchorPosition = { from: 'paragraph', align: null, offset: 0 }
  let simplePos = { x: 0, y: 0 }
  let width = 0
  let height = 0
  let effect: Edges = ZERO_EDGES
  let wrap: Wrap = { type: 'none', side: 'bothSides', distance }
  let drawing: PendingNode<C> | null = null
  let kind: UnsupportedKind | null = null
  eachChild(x, (local) => {
    switch (local) {
      case 'simplePos':
        simplePos = { x: emu(x, 'x'), y: emu(x, 'y') }
        break
      case 'positionH':
        horizontal = readPosition(x)
        return
      case 'positionV':
        vertical = readPosition(x)
        return
      case 'extent':
        width = emu(x, 'cx')
        height = emu(x, 'cy')
        break
      case 'effectExtent':
        effect = { left: emu(x, 'l'), top: emu(x, 't'), right: emu(x, 'r'), bottom: emu(x, 'b') }
        break
      case 'graphic':
        eachChild(x, (data) => {
          if (data !== 'graphicData') {
            skip(x)
            return
          }
          const uri = x.attr('uri') ?? ''
          for (const [suffix, k] of GRAPHIC_KINDS) if (uri.endsWith(suffix)) kind = k
          eachChild(x, (obj) => {
            if (uri.endsWith(CHART_URI) && obj === 'chart') {
              const id = x.attrNs(RELATIONSHIPS, 'id')
              const chart = id === null ? null : cx.chart(id)
              if (chart !== null)
                drawing = { kind: 'chart', frame: graphicFrame(width, height), chart }
              skip(x)
              return
            }
            if (uri.endsWith(DIAGRAM_URI) && obj === 'relIds') {
              const parts = readDiagramParts(x, cx.rels)
              const diagram = parts === null ? null : cx.diagram(parts)
              if (diagram !== null)
                drawing = { kind: 'diagram', frame: graphicFrame(width, height), diagram }
              return
            }
            const node = kind === null ? readNode(x, obj, cx, null, { width, height }) : null
            if (node !== null) drawing = node
            else skip(x)
          })
        })
        return
      default: {
        const type = WRAP_TYPES[local]
        if (type !== undefined) wrap = { type, side: wrapSide(x.attr('wrapText')), distance }
      }
    }
    skip(x)
  })
  if (drawing === null) cx.count(kind ?? 'drawing')
  if (simple) {
    horizontal = { from: 'page', align: null, offset: simplePos.x }
    vertical = { from: 'page', align: null, offset: simplePos.y }
  }
  return { horizontal, vertical, width, height, effect, wrap, behind, z, drawing }
}

/** CSS 长度换算为磅：`pt`、`in`、`cm`、`mm`、`px`（0.75 磅），无单位按像素。 */
function cssLength(v: string | undefined): number | null {
  if (v === undefined) return null
  const m = /^(-?[\d.]+)\s*(pt|in|cm|mm|px|em)?$/.exec(v.trim())
  if (m === null) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 'pt':
      return n
    case 'in':
      return n * 72
    case 'cm':
      return (n * 72) / 2.54
    case 'mm':
      return (n * 72) / 25.4
    default:
      return n * 0.75
  }
}

function cssStyle(s: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of s.split(';')) {
    const i = part.indexOf(':')
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return out
}

/** VML 颜色：`#rgb`、`#rrggbb` 与常用颜色名；其后的附加说明（如 `[67]`）忽略。 */
const VML_NAMES: Readonly<Record<string, string>> = {
  black: '000000',
  white: 'ffffff',
  red: 'ff0000',
  green: '008000',
  blue: '0000ff',
  yellow: 'ffff00',
  gray: '808080',
  silver: 'c0c0c0',
}

function vmlColor(v: string | null) {
  if (v === null) return null
  const s = v.trim().split(/\s/, 1)[0]!.toLowerCase()
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? s.slice(1).replace(/./g, (c) => c + c) : s.slice(1, 7)
    return parseHexColor(hex)
  }
  return parseHexColor(VML_NAMES[s] ?? null)
}

const VML_RELATIVE_H: Readonly<Record<string, string>> = {
  margin: 'margin',
  page: 'page',
  text: 'column',
  char: 'character',
}
const VML_RELATIVE_V: Readonly<Record<string, string>> = {
  margin: 'margin',
  page: 'page',
  text: 'paragraph',
  line: 'line',
}

const VML_SHAPES = new Set(['shape', 'rect', 'roundrect', 'oval'])

/** `w:object` 中显示对象的 VML 形状：`style` 的宽高（磅）、`v:imagedata` 的图片部件与裁剪比例。 */
export interface ObjectShape {
  readonly width: number
  readonly height: number
  readonly picture: string | null
  readonly crop: RelativeRect
}

/** VML 的裁剪比例：以 `f` 结尾时单位为 1/65536，否则为小数。 */
function vmlFraction(v: string | null): number {
  if (v === null) return 0
  const t = v.trim()
  const n = t.endsWith('f') ? Number(t.slice(0, -1)) / 65536 : Number(t)
  return Number.isFinite(n) ? n : 0
}

/**
 * 在 `w:object` 的开始标签处调用，返回时位于其结束标签。取第一个 VML 形状；没有形状时返回 `null`。
 * 嵌入对象（`o:OLEObject`）本身不读取：WPS 显示的是该形状的图片。
 */
export function readObjectShape(x: Scanner, rels: Relationships): ObjectShape | null {
  let out: ObjectShape | null = null
  eachChild(x, (local) => {
    if (!VML_SHAPES.has(local) || out !== null) {
      skip(x)
      return
    }
    const css = cssStyle(x.attr('style') ?? '')
    let picture: string | null = null
    let crop = ZERO_RECT
    eachChild(x, (child) => {
      if (child === 'imagedata' && picture === null) {
        const id = x.attrNs(RELATIONSHIPS, 'id')
        const rel = id === null ? null : rels.byId(id)
        if (rel !== null && !rel.external) picture = rel.part ?? null
        crop = {
          left: vmlFraction(x.attr('cropleft')),
          top: vmlFraction(x.attr('croptop')),
          right: vmlFraction(x.attr('cropright')),
          bottom: vmlFraction(x.attr('cropbottom')),
        }
      }
      skip(x)
    })
    out = {
      width: cssLength(css.get('width')) ?? 0,
      height: cssLength(css.get('height')) ?? 0,
      picture,
      crop,
    }
  })
  return out
}

/**
 * 在 `w:pict` 的开始标签处调用，返回时位于其结束标签。只转换绝对定位的单个形状；其余返回 `null` 并计为 `vml`。
 */
export function readVml<C>(x: Scanner, cx: DrawingContext<C>): PendingAnchor<C> | null {
  let result: PendingAnchor<C> | null = null
  let other = false
  eachChild(x, (local) => {
    if (local === 'shapetype') {
      skip(x)
      return
    }
    if (!VML_SHAPES.has(local) || result !== null) {
      other = true
      skip(x)
      return
    }
    result = readVmlShape(x, local, cx)
    if (result === null) other = true
  })
  if (result === null && other) cx.count('vml')
  return result
}

function readVmlShape<C>(
  x: Scanner,
  local: string,
  cx: DrawingContext<C>,
): PendingAnchor<C> | null {
  const css = cssStyle(x.attr('style') ?? '')
  if (css.get('position') !== 'absolute') {
    skip(x)
    return null
  }
  const width = cssLength(css.get('width')) ?? 0
  const height = cssLength(css.get('height')) ?? 0
  const alignH = css.get('mso-position-horizontal')
  const alignV = css.get('mso-position-vertical')
  const horizontal: AnchorPosition = {
    from: VML_RELATIVE_H[css.get('mso-position-horizontal-relative') ?? 'text'] ?? 'column',
    align: alignH === undefined || alignH === 'absolute' ? null : alignH,
    offset: (cssLength(css.get('margin-left')) ?? 0) + (cssLength(css.get('left')) ?? 0),
  }
  const vertical: AnchorPosition = {
    from: VML_RELATIVE_V[css.get('mso-position-vertical-relative') ?? 'text'] ?? 'paragraph',
    align: alignV === undefined || alignV === 'absolute' ? null : alignV,
    offset: (cssLength(css.get('margin-top')) ?? 0) + (cssLength(css.get('top')) ?? 0),
  }
  const z = Number(css.get('z-index') ?? 0) || 0
  const filledAttr = x.attr('filled')
  const strokedAttr = x.attr('stroked')
  let fillColor = vmlColor(x.attr('fillcolor')) ?? { r: 1, g: 1, b: 1, a: 1 }
  let filled = !(filledAttr === 'f' || filledAttr === 'false')
  let strokeColor = vmlColor(x.attr('strokecolor')) ?? { r: 0, g: 0, b: 0, a: 1 }
  let stroked = !(strokedAttr === 'f' || strokedAttr === 'false')
  const weight = cssLength(x.attr('strokeweight') ?? undefined) ?? 0.75
  let picture: string | null = null
  let content: C | null = null
  let inset = DEFAULT_INSET
  let wrap: Wrap = {
    type: 'none',
    side: 'bothSides',
    distance: { left: 9, right: 9, top: 0, bottom: 0 },
  }
  const textAnchor = css.get('v-text-anchor')
  eachChild(x, (child) => {
    switch (child) {
      case 'fill': {
        const on = x.attr('on')
        if (on === 'f' || on === 'false') filled = false
        fillColor = vmlColor(x.attr('color')) ?? fillColor
        break
      }
      case 'stroke': {
        const on = x.attr('on')
        if (on === 'f' || on === 'false') stroked = false
        strokeColor = vmlColor(x.attr('color')) ?? strokeColor
        break
      }
      case 'imagedata': {
        const id = x.attrNs(RELATIONSHIPS, 'id')
        const rel = id === null ? null : cx.rels.byId(id)
        if (rel !== null && !rel.external) picture = rel.part ?? null
        break
      }
      case 'textbox': {
        const raw = x.attr('inset')
        if (raw !== null) {
          const parts = raw.split(',').map((v) => cssLength(v))
          inset = {
            left: parts[0] ?? DEFAULT_INSET.left,
            top: parts[1] ?? DEFAULT_INSET.top,
            right: parts[2] ?? DEFAULT_INSET.right,
            bottom: parts[3] ?? DEFAULT_INSET.bottom,
          }
        }
        eachChild(x, (inner) => {
          if (inner === 'txbxContent') content = cx.content()
          else skip(x)
        })
        return
      }
      case 'wrap': {
        const type = x.attr('type')
        const t: Wrap['type'] =
          type === 'square' || type === 'tight' || type === 'through'
            ? type
            : type === 'topAndBottom'
              ? 'topAndBottom'
              : 'none'
        wrap = { ...wrap, type: t, side: wrapSide(x.attr('side')) }
        break
      }
    }
    skip(x)
  })
  if (picture !== null) cx.image(picture)
  const fill: ShapeFill =
    picture !== null
      ? {
          kind: 'picture',
          image: {
            part: picture,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
            stretch: { left: 0, top: 0, right: 0, bottom: 0 },
            tile: null,
            alpha: 1,
            effects: [],
            rotateWithShape: true,
          },
        }
      : filled
        ? { kind: 'solid', color: fillColor }
        : NO_FILL
  const line: Line | null = stroked
    ? {
        width: weight * EMU_PER_POINT,
        fill: { kind: 'solid', color: strokeColor },
        dash: { kind: 'preset', name: 'solid' },
        cap: 'flat',
        compound: 'sng',
        align: 'ctr',
        join: 'round',
        miterLimit: null,
        head: null,
        tail: null,
      }
    : null
  const geometry: Geometry =
    local === 'roundrect'
      ? { kind: 'preset', name: 'roundRect', adjust: [] }
      : local === 'oval'
        ? { kind: 'preset', name: 'ellipse', adjust: [] }
        : RECT
  const frame: Frame = {
    x: 0,
    y: 0,
    width: width * EMU_PER_POINT,
    height: height * EMU_PER_POINT,
    rotation: Number.parseFloat(css.get('rotation') ?? '0') || 0,
    flipH: (css.get('flip') ?? '').includes('x'),
    flipV: (css.get('flip') ?? '').includes('y'),
  }
  return {
    horizontal,
    vertical,
    width,
    height,
    effect: ZERO_EDGES,
    wrap,
    behind: z < 0,
    z: Math.abs(z),
    drawing: {
      kind: 'shape',
      frame,
      geometry,
      fill,
      line,
      effects: [],
      text:
        content === null
          ? null
          : {
              content,
              inset,
              anchor:
                textAnchor === 'middle' ? 'center' : textAnchor === 'bottom' ? 'bottom' : 'top',
              autoFit: css.get('mso-fit-shape-to-text') === 't',
              wrap: css.get('mso-wrap-style') !== 'none',
              turned: 0,
            },
    },
  }
}
