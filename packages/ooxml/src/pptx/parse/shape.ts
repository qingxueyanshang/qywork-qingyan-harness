/**
 * 形状树：`spTree` 与 `grpSp` 中的 `sp`、`pic`、`grpSp`、`cxnSp`、`graphicFrame`、`contentPart`。
 *
 * - 只记录文档中出现的属性（`spPr` 各项缺失时为 `null`），占位符继承、样式引用与坐标换算在 `resolve/` 中完成。
 * - `AlternateContent` 的分支由扫描器按 `../load.ts` 声明的扩展选择：墨迹取 `contentPart`，公式取 `Fallback` 中的
 *   替代图片（按普通图片读取）。
 * - 每个形状的 `found` 记录该形状自身（含其文字与表格）遇到的未实现元素；组合的 `found` 不含子形状。
 * - 图表、SmartArt 与墨迹只记录部件名，能否绘制在求值时判定并计数。
 */

import { type DiagramParts, readDiagramParts } from '../../drawingml/diagram/read.ts'
import { type ImageFill, readFill, ZERO_RECT } from '../../drawingml/fill.ts'
import {
  countOtherEffects,
  EMPTY_NON_VISUAL,
  EMPTY_PROPS,
  type NonVisual,
  readNonVisual,
  readShapeProps,
  readStyle,
  readXfrm,
  type ShapeProps,
  type StyleRefs,
  type Xfrm,
} from '../../drawingml/shape/read.ts'
import { type RawTextBody, readTextBody, type TextContext } from '../../drawingml/text/read.ts'
import { eachChild, int, relAttr, type Scanner } from '../../opc/read.ts'
import type { PlaceholderType, UnsupportedKind } from '../model.ts'
import { type RawTable, readTable } from './table.ts'

export interface RawPlaceholder {
  readonly type: PlaceholderType
  readonly idx: number
}

interface RawBase {
  readonly id: number
  readonly name: string
  readonly hidden: boolean
  readonly placeholder: RawPlaceholder | null
  readonly found: readonly UnsupportedKind[]
}

export interface RawAutoShape extends RawBase {
  readonly kind: 'shape'
  readonly props: ShapeProps
  readonly style: StyleRefs | null
  readonly textBox: boolean
  readonly text: RawTextBody | null
}

export interface RawPicture extends RawBase {
  readonly kind: 'picture'
  readonly props: ShapeProps
  readonly style: StyleRefs | null
  readonly image: ImageFill
}

export interface RawConnector extends RawBase {
  readonly kind: 'connector'
  readonly props: ShapeProps
  readonly style: StyleRefs | null
  readonly start: { readonly shape: number; readonly site: number } | null
  readonly end: { readonly shape: number; readonly site: number } | null
}

export interface RawGroup extends RawBase {
  readonly kind: 'group'
  readonly props: ShapeProps
  readonly children: readonly RawShape[]
}

export interface RawTableFrame extends RawBase {
  readonly kind: 'table'
  readonly xfrm: Xfrm | null
  readonly table: RawTable
}

export interface RawGraphic extends RawBase {
  readonly kind: 'graphic'
  readonly xfrm: Xfrm | null
  readonly content: 'chart' | 'smartArt' | 'ole' | 'graphic'
  /** `c:chart` 引用的图表部件名；扩展图表（`cx:chart`）与关系缺失时为 `null`。 */
  readonly chart: string | null
  /** SmartArt 的部件名；数据部件的关系缺失时为 `null`。 */
  readonly diagram: DiagramParts | null
}

/** 墨迹（`contentPart`）。 */
export interface RawInk extends RawBase {
  readonly kind: 'ink'
  readonly xfrm: Xfrm | null
  /** `r:id` 所指的 InkML 部件名；关系缺失或为外部链接时为 `null`。 */
  readonly part: string | null
}

export type RawShape =
  | RawAutoShape
  | RawPicture
  | RawConnector
  | RawGroup
  | RawTableFrame
  | RawGraphic
  | RawInk

const PLACEHOLDER_TYPES = new Set<string>([
  'title',
  'body',
  'ctrTitle',
  'subTitle',
  'dt',
  'sldNum',
  'ftr',
  'hdr',
  'obj',
  'chart',
  'tbl',
  'clipArt',
  'dgm',
  'media',
  'sldImg',
  'pic',
])

const MEDIA_ELEMENTS = new Set(['videoFile', 'audioFile', 'wavAudioFile', 'quickTimeFile', 'media'])

const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'

const GRAPHIC_KINDS: Record<string, RawGraphic['content'] | 'table'> = {
  'http://schemas.openxmlformats.org/drawingml/2006/table': 'table',
  [CHART_URI]: 'chart',
  'http://schemas.microsoft.com/office/drawing/2014/chartex': 'chart',
  [DIAGRAM_URI]: 'smartArt',
  'http://schemas.openxmlformats.org/presentationml/2006/ole': 'ole',
}

/** 非可视属性，加上 `nvPr` 中的占位符与音视频标记。 */
interface SlideNonVisual extends NonVisual {
  readonly placeholder: RawPlaceholder | null
  readonly media: boolean
}

const EMPTY_SLIDE_NON_VISUAL: SlideNonVisual = {
  ...EMPTY_NON_VISUAL,
  placeholder: null,
  media: false,
}

/** 在 `nvSpPr`、`nvPicPr` 等非可视属性元素的开始标签处调用。 */
function readSlideNonVisual(x: Scanner): SlideNonVisual {
  let placeholder: RawPlaceholder | null = null
  let media = false
  const nv = readNonVisual(x, (local) => {
    if (local !== 'nvPr') return
    const depth = x.depth
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'end' && x.depth === depth) break
      if (t !== 'start') continue
      if (x.local === 'ph' && x.depth === depth + 1) {
        const type = x.attr('type') ?? 'obj'
        placeholder = {
          type: (PLACEHOLDER_TYPES.has(type) ? type : 'obj') as PlaceholderType,
          idx: int(x, 'idx', 0),
        }
      } else if (MEDIA_ELEMENTS.has(x.local)) {
        media = true
      }
    }
  })
  return { ...nv, placeholder, media }
}

function base(nv: SlideNonVisual, found: UnsupportedKind[]): RawBase {
  return { id: nv.id, name: nv.name, hidden: nv.hidden, placeholder: nv.placeholder, found }
}

function readAutoShape(x: Scanner, rels: TextContext['rels']): RawAutoShape {
  const found: UnsupportedKind[] = []
  const cx: TextContext = { rels, found }
  let nv = EMPTY_SLIDE_NON_VISUAL
  let props = EMPTY_PROPS
  let style: StyleRefs | null = null
  let text: RawTextBody | null = null
  eachChild(x, (local) => {
    if (local === 'nvSpPr') nv = readSlideNonVisual(x)
    else if (local === 'spPr') props = readShapeProps(x, cx)
    else if (local === 'style') style = readStyle(x)
    else if (local === 'txBody') text = readTextBody(x, cx)
  })
  countOtherEffects(props, found)
  return { kind: 'shape', ...base(nv, found), props, style, textBox: nv.textBox, text }
}

function readPicture(x: Scanner, rels: TextContext['rels']): RawPicture {
  const found: UnsupportedKind[] = []
  const cx: TextContext = { rels, found }
  let nv = EMPTY_SLIDE_NON_VISUAL
  let props = EMPTY_PROPS
  let style: StyleRefs | null = null
  let image: ImageFill = {
    part: null,
    crop: ZERO_RECT,
    stretch: ZERO_RECT,
    tile: null,
    alpha: 1,
    effects: [],
    rotateWithShape: true,
  }
  eachChild(x, (local) => {
    if (local === 'nvPicPr') nv = readSlideNonVisual(x)
    else if (local === 'blipFill') {
      const fill = readFill(x, rels)
      if (fill.kind === 'picture') image = fill.image
    } else if (local === 'spPr') props = readShapeProps(x, cx)
    else if (local === 'style') style = readStyle(x)
  })
  if (nv.media) found.push('media')
  if (image.effects.length > 0) found.push('imageEffect')
  countOtherEffects(props, found)
  return { kind: 'picture', ...base(nv, found), props, style, image }
}

function readConnector(x: Scanner, rels: TextContext['rels']): RawConnector {
  const found: UnsupportedKind[] = []
  const cx: TextContext = { rels, found }
  let nv = EMPTY_SLIDE_NON_VISUAL
  let props = EMPTY_PROPS
  let style: StyleRefs | null = null
  eachChild(x, (local) => {
    if (local === 'nvCxnSpPr') nv = readSlideNonVisual(x)
    else if (local === 'spPr') props = readShapeProps(x, cx)
    else if (local === 'style') style = readStyle(x)
  })
  countOtherEffects(props, found)
  return { kind: 'connector', ...base(nv, found), props, style, start: nv.start, end: nv.end }
}

function readGraphicFrame(x: Scanner, rels: TextContext['rels']): RawTableFrame | RawGraphic {
  const found: UnsupportedKind[] = []
  const cx: TextContext = { rels, found }
  let nv = EMPTY_SLIDE_NON_VISUAL
  let xfrm: Xfrm | null = null
  let content: RawGraphic['content'] = 'graphic'
  let table = null as RawTable | null
  let chart: string | null = null
  let diagram: DiagramParts | null = null
  eachChild(x, (local) => {
    if (local === 'nvGraphicFramePr') nv = readSlideNonVisual(x)
    else if (local === 'xfrm') xfrm = readXfrm(x)
    else if (local === 'graphic') {
      eachChild(x, (data) => {
        if (data !== 'graphicData') return
        const uri = x.attr('uri') ?? ''
        const kind = GRAPHIC_KINDS[uri] ?? 'graphic'
        if (kind !== 'table') {
          content = kind
          if (uri === DIAGRAM_URI) {
            eachChild(x, (c) => {
              if (c === 'relIds') diagram = readDiagramParts(x, rels)
            })
            return
          }
          if (uri !== CHART_URI) return
          eachChild(x, (c) => {
            if (c !== 'chart') return
            const rel = rels.byId(relAttr(x, 'id') ?? '')
            chart = rel === null || rel.external ? null : rel.part
          })
          return
        }
        eachChild(x, (tbl) => {
          if (tbl === 'tbl') table = readTable(x, cx)
        })
      })
    }
  })
  if (table !== null) return { kind: 'table', ...base(nv, found), xfrm, table }
  if (chart === null && diagram === null) found.push(content)
  return { kind: 'graphic', ...base(nv, found), xfrm, content, chart, diagram }
}

/** `contentPart`：非可视属性与位置尺寸在 `p14` 命名空间中，按本地名读取。 */
function readContentPart(x: Scanner, rels: TextContext['rels']): RawInk {
  const rel = rels.byId(relAttr(x, 'id') ?? '')
  let nv = EMPTY_SLIDE_NON_VISUAL
  let xfrm: Xfrm | null = null
  eachChild(x, (local) => {
    if (local === 'nvContentPartPr') nv = readSlideNonVisual(x)
    else if (local === 'xfrm') xfrm = readXfrm(x)
  })
  const part = rel === null || rel.external ? null : rel.part
  return { kind: 'ink', ...base(nv, []), xfrm, part }
}

function readGroup(x: Scanner, rels: TextContext['rels']): RawGroup {
  const found: UnsupportedKind[] = []
  const cx: TextContext = { rels, found }
  let nv = EMPTY_SLIDE_NON_VISUAL
  let props = EMPTY_PROPS
  const children: RawShape[] = []
  eachChild(x, (local) => {
    if (local === 'nvGrpSpPr') nv = readSlideNonVisual(x)
    else if (local === 'grpSpPr') props = readShapeProps(x, cx)
    else readMember(x, local, rels, children)
  })
  countOtherEffects(props, found)
  return { kind: 'group', ...base(nv, found), props, children }
}

function readMember(x: Scanner, local: string, rels: TextContext['rels'], out: RawShape[]): void {
  switch (local) {
    case 'sp':
      out.push(readAutoShape(x, rels))
      return
    case 'pic':
      out.push(readPicture(x, rels))
      return
    case 'cxnSp':
      out.push(readConnector(x, rels))
      return
    case 'grpSp':
      out.push(readGroup(x, rels))
      return
    case 'graphicFrame':
      out.push(readGraphicFrame(x, rels))
      return
    case 'contentPart':
      out.push(readContentPart(x, rels))
      return
  }
}

/** 在 `spTree` 的开始标签处调用。`spTree` 本身的变换不参与坐标换算。 */
export function readShapeTree(x: Scanner, rels: TextContext['rels']): RawShape[] {
  const shapes: RawShape[] = []
  eachChild(x, (local) => readMember(x, local, rels, shapes))
  return shapes
}
