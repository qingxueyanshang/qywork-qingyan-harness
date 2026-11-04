/**
 * .ppt 幻灯片与母版的 OfficeArt 形状换算为 `Shape`。
 *
 * - 属性依次取 `hspMaster`（0x0301）所指母版形状的属性（逐级）与形状自身的属性（`mergeProperties`），都没有的属性取 MS-ODRAW 的缺省值。
 *   绘图组的缺省属性（OfficeArtDggContainer 中的 FOPT）不参与：它是新建形状的缺省，WPS 演示实测（文本框没有 `WrapText` 与 `anchorText`，
 *   绘图组的缺省为不换行、居中）按换行、顶端显示。
 *   幻灯片上的占位符多数只写出位置，填充与线条取自母版上的同一占位符。
 * - 位置：顶层形状的客户锚点为主单位的上、左、右、下（8 字节时各 16 位，16 字节时各 32 位）；组合内形状的子锚点为
 *   所在组合 FSPGR 坐标系中的左、上、右、下。旋转角在 [45°, 135°) 或 [225°, 315°) 的形状，锚点记录的是旋转 90° 后的
 *   外接矩形，形状框为它绕中心转回后的矩形（宽高互换）。组合的旋转与翻转不并入子形状的 `frame`（同 pptx）。
 * - 种类：组合（FSP 的 `fGroup`）、图片（类型 75 且有 `pib`，含 OLE 对象与控件的替代图片）、连接线（FSP 的 `fConnector`）、
 *   其余为自选图形。已删除的形状不读取；`fHidden`（0x03BF 第 1 位）为真时隐藏。
 * - 文字：客户文本框中的文字记录，其中有 OutlineTextRefAtom 时取所在幻灯片 SlideListWithText 中第 n 组文字（见 `text.ts`）。
 * - 带 metroBlob 的形状（`metro.ts`）按其中的 DrawingML 求值，位置、旋转、翻转、几何、填充、线条、效果与文字格式都取自 XML，
 *   文字的字符取自上述文字记录；客户数据中的动画信息照常计数。组合与图片形状带 metroBlob 时是一个形状的替代，不读取其子形状与图片。
 *   XML 中没有 `xfrm` 的占位符取旧格式锚点（母版上的同一占位符也带 metroBlob 时，按 pptx 规则继承的位置与旧格式锚点相同）。
 * - 能力边界：艺术字（有 `gtextUNICODE`，0x00C0）不绘制，计入 `textWarp`；几何无法换算（`../../officeart/geometry.ts`）时
 *   不绘制，计入 `graphic`；图片库中不可绘制的图片计入 `imageFormat`；没有替代图片的嵌入对象计入 `ole`，音视频对象计入 `media`；
 *   客户数据中有动画信息的形状计入 `animation`。
 */

import type { Frame } from '../../drawingml/shape/model.ts'
import type { Xfrm } from '../../drawingml/shape/read.ts'
import {
  childTransform,
  countText,
  frameOf,
  IDENTITY_TRANSFORM,
  nearVertical,
  type Transform,
} from '../../drawingml/shape/resolve.ts'
import type { TextBody } from '../../drawingml/text/model.ts'
import { artGeometry } from '../../officeart/geometry.ts'
import {
  type ArtProperties,
  type ArtRecord,
  flagOf,
  mergeProperties,
  readArtRecords,
} from '../../officeart/records.ts'
import { type ArtRect, type ArtShape, SHAPE_FLAG } from '../../officeart/shape.ts'
import {
  type ArtStyleContext,
  artEffects,
  artFill,
  artLine,
  artPicture,
  artRotation,
} from '../../officeart/style.ts'
import type { Placeholder, PlaceholderType, Shape, UnsupportedKind } from '../model.ts'
import type { RawShape } from '../parse/shape.ts'
import type { ShapeResolver } from '../resolve/shape.ts'
import type { ExternalKind } from './document.ts'
import { type MetroContent, metroText } from './metro.ts'
import { EMU_PER_MASTER, Fields, RT } from './records.ts'
import { readTextBody, readTextProps9, type TextScope, textOf } from './text.ts'

const PROP_PIB = 0x0104
const PROP_GTEXT = 0x00c0
const PROP_MASTER = 0x0301
const PROP_NAME = 0x0380
const PROP_GROUP_BOOLEANS = 0x03bf
const PICTURE_FRAME = 75
const TEXT_BOX = 202

/** PlaceholderAtom 的 `placementId`（MS-PPT 的 PlaceholderEnum）对应的占位符类型。 */
const PLACEHOLDERS: Readonly<Record<number, PlaceholderType>> = {
  1: 'title',
  2: 'body',
  3: 'ctrTitle',
  4: 'subTitle',
  5: 'sldImg',
  6: 'body',
  7: 'dt',
  8: 'sldNum',
  9: 'ftr',
  10: 'hdr',
  11: 'sldImg',
  12: 'body',
  13: 'title',
  14: 'body',
  15: 'ctrTitle',
  16: 'subTitle',
  17: 'title',
  18: 'body',
  19: 'obj',
  20: 'chart',
  21: 'tbl',
  22: 'clipArt',
  23: 'dgm',
  24: 'media',
  25: 'obj',
  26: 'pic',
}

export interface DrawingScope {
  /** 全部母版上的形状，按形状编号（`hspMaster` 的取值）。 */
  readonly masterShapes: ReadonlyMap<number, ArtShape>
  readonly style: ArtStyleContext
  /** 图片部件能否绘制；`null` 表示部件不存在。 */
  imageDrawable(part: string): boolean | null
  readonly externals: ReadonlyMap<number, ExternalKind>
  readonly text: TextScope
  readonly found: UnsupportedKind[]
  /** 带 metroBlob 的形状，键为 `<容器部件名>/<形状编号>`。 */
  readonly metro: ReadonlyMap<string, MetroContent>
  /** 所在幻灯片的 DrawingML 求值器（`metroScope`）。 */
  readonly resolver: ShapeResolver
}

/** 图片框的缺省：没有填充、没有线条（WPS 演示实测：没有填充与线条属性的图片框既不填充也不描边）。 */
const PICTURE_DEFAULTS: ArtProperties = {
  values: new Map([
    [0x01bf, 0x100000],
    [0x01ff, 0x80000],
  ]),
  complex: new Map(),
}

/** 形状的有效属性：母版形状链与自身，图片框另以 `PICTURE_DEFAULTS` 为底。母版链成环时在重复处截断。 */
export function shapeProperties(shape: ArtShape, scope: DrawingScope): ArtProperties {
  const chain: ArtProperties[] = [shape.properties]
  const seen = new Set<number>([shape.id])
  for (let id = shape.properties.values.get(PROP_MASTER); id !== undefined; ) {
    const master = scope.masterShapes.get(id)
    if (master === undefined || seen.has(id)) break
    seen.add(id)
    chain.unshift(master.properties)
    id = master.properties.values.get(PROP_MASTER)
  }
  return shape.shapeType === PICTURE_FRAME
    ? mergeProperties(PICTURE_DEFAULTS, ...chain)
    : mergeProperties(...chain)
}

function anchorRect(anchor: Uint8Array): ArtRect | null {
  const f = new Fields(anchor)
  if (anchor.length >= 16) {
    return { top: f.i32(0), left: f.i32(4), right: f.i32(8), bottom: f.i32(12) }
  }
  if (anchor.length >= 8) {
    return { top: f.i16(0), left: f.i16(2), right: f.i16(4), bottom: f.i16(6) }
  }
  return null
}

/** 锚点矩形（外层坐标）与旋转角得到 `Xfrm`：接近竖直时宽高互换。`child` 为组合的子坐标系。 */
function xfrmOf(
  rect: ArtRect,
  scale: number,
  shape: ArtShape,
  rotation: number,
  child: ArtRect | null,
): Xfrm {
  let w = (rect.right - rect.left) * scale
  let h = (rect.bottom - rect.top) * scale
  const cx = rect.left * scale + w / 2
  const cy = rect.top * scale + h / 2
  if (nearVertical(rotation)) [w, h] = [h, w]
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    rotation,
    flipH: (shape.flags & SHAPE_FLAG.FLIP_H) !== 0,
    flipV: (shape.flags & SHAPE_FLAG.FLIP_V) !== 0,
    child:
      child === null
        ? null
        : {
            x: child.left,
            y: child.top,
            width: child.right - child.left,
            height: child.bottom - child.top,
          },
  }
}

function utf16(data: Uint8Array | undefined): string {
  if (data === undefined) return ''
  let s = ''
  for (let i = 0; i + 1 < data.length; i += 2) {
    const c = data[i]! | (data[i + 1]! << 8)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

interface ClientInfo {
  readonly placeholder: Placeholder | null
  readonly external: number | null
  readonly animated: boolean
}

function clientInfo(data: Uint8Array | null): ClientInfo {
  let placeholder: Placeholder | null = null
  let external: number | null = null
  let animated = false
  for (const r of data === null ? [] : readArtRecords(data)) {
    if (r.type === RT.PLACEHOLDER_ATOM) {
      const f = new Fields(r.data)
      const type = PLACEHOLDERS[f.u8(4)]
      if (type !== undefined) {
        placeholder = {
          type,
          idx: f.i32(0) < 0 ? 0 : f.u32(0),
          layoutShape: null,
          masterShape: null,
        }
      }
    } else if (r.type === RT.EXTERNAL_OBJECT_REF_ATOM) {
      external = new Fields(r.data).u32(0)
    } else if (r.type === RT.ANIMATION_INFO) {
      animated = true
    }
  }
  return { placeholder, external, animated }
}

/** SlideListWithText 中属于一张幻灯片的文字记录按 TextHeaderAtom 分组。 */
export function outlineGroups(records: readonly ArtRecord[]): ArtRecord[][] {
  const out: ArtRecord[][] = []
  for (const r of records) {
    if (r.type === RT.TEXT_HEADER_ATOM) out.push([r])
    else out.at(-1)?.push(r)
  }
  return out
}

export class DrawingConverter {
  /** `part` 为所在容器的部件名，`outline` 为所在幻灯片或母版的文字分组（`outlineGroups`）。 */
  constructor(
    private readonly scope: DrawingScope,
    private readonly origin: Shape['origin'],
    private readonly part: string,
    private readonly outline: readonly (readonly ArtRecord[])[],
  ) {}

  /** 形状的一组文字记录；没有客户文本框或引用的分组不存在时为 `null`。 */
  private records(s: ArtShape): readonly ArtRecord[] | null {
    if (s.clientTextbox === null) return null
    const records = readArtRecords(s.clientTextbox)
    const ref = records.find((r) => r.type === RT.OUTLINE_TEXT_REF_ATOM)
    return ref === undefined ? records : (this.outline[new Fields(ref.data).u32(0)] ?? null)
  }

  private text(
    s: ArtShape,
    props: ArtProperties,
    placeholder: Placeholder | null,
  ): TextBody | null {
    const group = this.records(s)
    const numbers = readTextProps9(s.clientData === null ? [] : readArtRecords(s.clientData))
    const text =
      group === null ? null : readTextBody(group, props, this.scope.text, numbers, placeholder)
    if (text !== null)
      countText(
        text,
        this.scope.found,
        () => {},
        () => {},
      )
    return text
  }

  convert(shapes: readonly ArtShape[]): Shape[] {
    return this.list(shapes, IDENTITY_TRANSFORM, null)
  }

  private list(shapes: readonly ArtShape[], t: Transform, parent: ArtRect | null): Shape[] {
    const out: Shape[] = []
    for (const s of shapes) {
      if (s.flags & SHAPE_FLAG.DELETED) continue
      const shape = this.shape(s, t, parent)
      if (shape !== null) out.push(shape)
    }
    return out
  }

  /** `xfrm` 为旧格式锚点的位置；旧格式记录有文字时，XML 中的占位字符替换为其中的字符。 */
  private metroShape(s: ArtShape, raw: RawShape, xfrm: Xfrm, t: Transform): Shape {
    const group = this.records(s)
    const text = group?.some((r) => r.type === RT.TEXT_HEADER_ATOM) ? textOf(group) : null
    const shape =
      raw.kind === 'shape'
        ? {
            ...raw,
            props: raw.props.xfrm === null ? { ...raw.props, xfrm } : raw.props,
            text: raw.text === null ? null : metroText(raw.text, text),
          }
        : raw
    return this.scope.resolver.resolve([{ ...shape, id: s.id }], this.origin, t)[0]!
  }

  private shape(s: ArtShape, t: Transform, parent: ArtRect | null): Shape | null {
    const scope = this.scope
    const props = shapeProperties(s, scope)
    const client = clientInfo(s.clientData)
    if (client.animated) scope.found.push('animation')
    const rect = parent === null ? (s.anchor === null ? null : anchorRect(s.anchor)) : s.childAnchor
    if (rect === null) return null
    const rotation = artRotation(props)
    const xfrm = xfrmOf(rect, parent === null ? EMU_PER_MASTER : 1, s, rotation, s.groupRect)
    const metro = scope.metro.get(`${this.part}/${s.id}`)
    if (metro?.kind === 'shape') return this.metroShape(s, metro.shape, xfrm, t)
    const frame: Frame = frameOf(xfrm, t)
    const common = {
      id: s.id,
      name: utf16(props.complex.get(PROP_NAME)),
      origin: this.origin,
      hidden: flagOf(props, PROP_GROUP_BOOLEANS, 1, false),
      frame,
      placeholder: client.placeholder,
    }
    const style = scope.style
    if (s.children !== null) {
      return {
        kind: 'group',
        ...common,
        fill: { kind: 'none' },
        effects: [],
        children: this.list(s.children, childTransform(xfrm, t), s.groupRect),
      }
    }
    if (props.values.has(PROP_GTEXT)) {
      scope.found.push('textWarp')
      return null
    }
    const external = client.external === null ? undefined : scope.externals.get(client.external)
    if (external === 'media') scope.found.push('media')
    const size = { w: frame.width, h: frame.height }
    if (s.shapeType === PICTURE_FRAME && props.values.has(PROP_PIB)) {
      const image = artPicture(props, style)
      const drawable = image === null ? false : scope.imageDrawable(image.part!)
      if (drawable === false) scope.found.push(external === 'ole' ? 'ole' : 'imageFormat')
      if (image === null) return null
      return {
        kind: 'picture',
        ...common,
        image,
        geometry: { kind: 'preset', name: 'rect', adjust: [] },
        fill: artFill(props, style),
        line: artLine(props, style),
        effects: artEffects(props, style),
        threeD: null,
      }
    }
    if (external === 'ole') {
      scope.found.push('ole')
      return null
    }
    const geometry = artGeometry(s.shapeType, props, size)
    if (geometry === null) {
      scope.found.push('graphic')
      return null
    }
    const fill = artFill(props, style)
    if (fill.kind === 'picture' && fill.image.part !== null) {
      if (scope.imageDrawable(fill.image.part) === false) scope.found.push('imageFormat')
    }
    if (s.flags & SHAPE_FLAG.CONNECTOR) {
      return {
        kind: 'connector',
        ...common,
        geometry,
        line: artLine(props, style),
        effects: artEffects(props, style),
        start: null,
        end: null,
      }
    }
    return {
      kind: 'shape',
      ...common,
      geometry,
      fill,
      line: artLine(props, style),
      effects: artEffects(props, style),
      threeD: null,
      textBox: s.shapeType === TEXT_BOX,
      text: this.text(s, props, client.placeholder),
    }
  }
}
