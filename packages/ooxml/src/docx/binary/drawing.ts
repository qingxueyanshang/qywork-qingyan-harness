/**
 * .doc 的浮动对象：锚点字符（0x08）的 FSPA 与表流中 OfficeArtContent 的形状换算为 `PendingAnchor`。
 *
 * - OfficeArtContent（FIB 的 DggInfo）：绘图组容器（含图片库）之后是若干绘图，每个之前 1 字节标出属于正文（0）还是页眉
 *   页脚（1）。PlcSpaMom、PlcSpaHdr 以锚点字符在正文、页眉文字中的位置给出 FSPA：形状编号、对象框四边（缇）与标志。
 * - 定位：对象框相对 FSPA 的 `bx`（0 页边距、1 页面、2 栏）与 `by`（0 页边距、1 页面、2 段落）；形状属性中有 `posrelh`、
 *   `posrelv` 时基准取自它们（另有 3：字符、行），`posh`、`posv` 不为 0 时按对齐。
 * - 环绕：`wr` 为 1 上下型、0 与 2 四周型、3 不环绕、4 紧密型、5 穿越型，`wrk` 为环绕的一侧，`fBelowText` 为衬于文字下方；
 *   距正文的距离取 `dxWrapDist*`、`dyWrapDist*`（缺省左右 114300、上下 0 EMU）。叠放次序为绘图中顶层形状的顺序。
 * - 形状的几何、填充、线条与效果经 `../../officeart/` 换算；图片（类型 75 且有 `pib`）为图片填充的矩形，图片取自图片库，
 *   图片记录在 `WordDocument` 流中 FBSE 的 `foDelay` 处。旋转角接近竖直的形状，对象框是旋转 90° 后的外接矩形，形状框为
 *   它绕中心转回后的矩形。组合中的形状按组合的子坐标系换算到对象框中。`fHidden` 的形状不绘制。
 * - 文本框：形状的 `lTxid` 高 16 位为文本框文字的 PlcftxbxTxt（页眉页脚为 PlcfHdrtxbxTxt）中的序号（从 1 起），文字为该项的
 *   区间，去掉末尾的保护段落标记；内缩取 `dxTextLeft` 等（缺省左右 91440、上下 45720 EMU），`anchorText` 为纵向位置，
 *   `WrapText` 为 2 时不换行，`fFitShapeToText` 为根据文字调整形状大小。
 * - 几何无法换算（含艺术字）的形状只占位置，计入 `drawing`；不可绘制的图片格式计入 `imageFormat`。
 */

import type { ShapeFill } from '../../drawingml/fill.ts'
import type { Frame } from '../../drawingml/shape/model.ts'
import type { Xfrm } from '../../drawingml/shape/read.ts'
import {
  childTransform,
  frameOf,
  IDENTITY_TRANSFORM,
  nearVertical,
  type Transform,
} from '../../drawingml/shape/resolve.ts'
import { type Blip, openBlipStore } from '../../officeart/blip.ts'
import { artGeometry } from '../../officeart/geometry.ts'
import { ART, type ArtRecord, flagOf, readArtRecords } from '../../officeart/records.ts'
import {
  type ArtRect,
  type ArtShape,
  readDrawingShapes,
  SHAPE_FLAG,
} from '../../officeart/shape.ts'
import {
  type ArtStyleContext,
  artEffects,
  artFill,
  artLine,
  artPicture,
  artRotation,
} from '../../officeart/style.ts'
import type { AnchorPosition, Edges, Wrap } from '../model.ts'
import type { PendingAnchor, PendingNode, PendingTextBox } from '../parse/drawing.ts'
import { Plc } from './fib.ts'
import { u16, u32 } from './sprm.ts'

const EMU_PER_TWIP = 635
const EMU_PER_POINT = 12700
const PICTURE_FRAME = 75

const P = {
  lTxid: 0x0080,
  textLeft: 0x0081,
  textTop: 0x0082,
  textRight: 0x0083,
  textBottom: 0x0084,
  wrapText: 0x0085,
  anchorText: 0x0087,
  textFlow: 0x0088,
  textBooleans: 0x00bf,
  gtext: 0x00c0,
  pib: 0x0104,
  fillBlip: 0x0186,
  wrapLeft: 0x0384,
  wrapTop: 0x0385,
  wrapRight: 0x0386,
  wrapBottom: 0x0387,
  posh: 0x038f,
  posrelh: 0x0390,
  posv: 0x0391,
  posrelv: 0x0392,
  groupBooleans: 0x03bf,
} as const

/** 一个文档的形状：正文与页眉页脚的绘图、图片库。 */
export interface ArtContent {
  /** 绘图组容器中的记录（图片库在其中）。 */
  readonly group: readonly ArtRecord[]
  /** 正文（0）与页眉页脚（1）绘图中的形状，按形状编号；顶层形状另记叠放次序。 */
  readonly shapes: readonly ReadonlyMap<number, { readonly shape: ArtShape; readonly z: number }>[]
}

/** 表流中的 OfficeArtContent；没有时两个绘图都为空。 */
export function readArtContent(table: Uint8Array, pair: { fc: number; lcb: number }): ArtContent {
  const shapes = [new Map(), new Map()] as Map<number, { shape: ArtShape; z: number }>[]
  if (pair.lcb === 0 || pair.fc + pair.lcb > table.length) return { group: [], shapes }
  const data = table.subarray(pair.fc, pair.fc + pair.lcb)
  const dgg = readArtRecords(data)[0]
  if (dgg === undefined) return { group: [], shapes }
  let p = 8 + dgg.data.length
  while (p + 9 <= data.length) {
    const label = data[p]!
    const dg = readArtRecords(data.subarray(p + 1, p + 9))[0]
    const end = Math.min(data.length, p + 9 + u32(data, p + 5))
    if (dg?.type !== ART.DG_CONTAINER || label > 1) break
    readDrawingShapes(data.subarray(p + 1, end)).forEach((shape, z) => {
      shapes[label]!.set(shape.id, { shape, z })
    })
    p = end
  }
  return { group: readArtRecords(dgg.data), shapes }
}

/** FSPA：形状编号、对象框（缇）与标志。 */
interface Fspa {
  readonly spid: number
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly flags: number
}

/** PlcSpaMom 或 PlcSpaHdr：锚点字符的位置（相对所在文字的开头）到 FSPA。 */
export function readFspas(table: Uint8Array, pair: { fc: number; lcb: number }): Map<number, Fspa> {
  const plc = new Plc(table, pair.fc, pair.lcb, 26)
  const out = new Map<number, Fspa>()
  for (let i = 0; i < plc.count; i++) {
    const at = plc.item(i)
    out.set(plc.position(i), {
      spid: u32(table, at),
      left: u32(table, at + 4) | 0,
      top: u32(table, at + 8) | 0,
      right: u32(table, at + 12) | 0,
      bottom: u32(table, at + 16) | 0,
      flags: u16(table, at + 20),
    })
  }
  return out
}

/** PlcftxbxTxt 或 PlcfHdrtxbxTxt：各文本框文字的区间（相对文本框文字的开头），不含末尾的保护段落标记。 */
export function readTextboxes(
  table: Uint8Array,
  pair: { fc: number; lcb: number },
): { readonly start: number; readonly end: number }[] {
  const plc = new Plc(table, pair.fc, pair.lcb, 22)
  const out: { start: number; end: number }[] = []
  for (let i = 0; i < plc.count; i++) {
    const start = plc.position(i)
    out.push({ start, end: Math.max(start, plc.position(i + 1) - 1) })
  }
  return out
}

/** 图片库中各项的图片，按 `pib`；只读取 `pibs` 中的项。 */
export async function readBlips(
  group: readonly ArtRecord[],
  word: Uint8Array,
  pibs: Iterable<number>,
): Promise<Map<number, Blip | null>> {
  const store = openBlipStore(group, word)
  const out = new Map<number, Blip | null>()
  for (const pib of pibs) if (!out.has(pib)) out.set(pib, await store.read(pib))
  return out
}

/** 形状（含组合中的）引用的图片库序号。 */
export function shapePictures(shapes: Iterable<ArtShape>): Set<number> {
  const out = new Set<number>()
  const walk = (s: ArtShape) => {
    for (const id of [P.pib, P.fillBlip]) {
      const v = s.properties.values.get(id)
      if (v !== undefined && v > 0) out.add(v)
    }
    for (const c of s.children ?? []) walk(c)
  }
  for (const s of shapes) walk(s)
  return out
}

const H_RELATIVE = ['margin', 'page', 'column', 'character']
const V_RELATIVE = ['margin', 'page', 'paragraph', 'line']
const H_ALIGN = [null, 'left', 'center', 'right', 'inside', 'outside']
const V_ALIGN = [null, 'top', 'center', 'bottom', 'inside', 'outside']
const WRAP_TYPES: readonly Wrap['type'][] = [
  'square',
  'topAndBottom',
  'square',
  'none',
  'tight',
  'through',
]
const WRAP_SIDES: readonly Wrap['side'][] = ['bothSides', 'left', 'right', 'largest']
const TEXT_ANCHORS = ['top', 'center', 'bottom', 'top', 'center', 'bottom'] as const

export interface ShapeScope<C> {
  readonly style: ArtStyleContext
  /** 文本框序号（从 1 起）的内容；没有时为 `null`。 */
  readonly textbox: (index: number) => C | null
  readonly count: (kind: 'drawing' | 'textDirection') => void
}

/** 锚点字符的浮动对象：`fspa` 给出对象框与环绕，`entry` 为同一编号的形状。 */
export function anchorOf<C>(
  fspa: Fspa,
  entry: { readonly shape: ArtShape; readonly z: number },
  scope: ShapeScope<C>,
): PendingAnchor<C> {
  const props = entry.shape.properties.values
  const flags = fspa.flags
  const bx = (flags >> 1) & 3
  const by = (flags >> 3) & 3
  const width = (fspa.right - fspa.left) / 20
  const height = (fspa.bottom - fspa.top) / 20
  const horizontal: AnchorPosition = {
    from: H_RELATIVE[props.get(P.posrelh) ?? bx] ?? 'column',
    align: H_ALIGN[props.get(P.posh) ?? 0] ?? null,
    offset: fspa.left / 20,
  }
  const vertical: AnchorPosition = {
    from: V_RELATIVE[props.get(P.posrelv) ?? by] ?? 'paragraph',
    align: V_ALIGN[props.get(P.posv) ?? 0] ?? null,
    offset: fspa.top / 20,
  }
  const distance: Edges = {
    left: (props.get(P.wrapLeft) ?? 114300) / EMU_PER_POINT,
    top: (props.get(P.wrapTop) ?? 0) / EMU_PER_POINT,
    right: (props.get(P.wrapRight) ?? 114300) / EMU_PER_POINT,
    bottom: (props.get(P.wrapBottom) ?? 0) / EMU_PER_POINT,
  }
  const box: ArtRect = {
    left: 0,
    top: 0,
    right: fspa.right - fspa.left,
    bottom: fspa.bottom - fspa.top,
  }
  const drawing = nodeOf(entry.shape, box, EMU_PER_TWIP, IDENTITY_TRANSFORM, scope)
  if (drawing === null) scope.count('drawing')
  return {
    horizontal,
    vertical,
    width,
    height,
    effect: { left: 0, top: 0, right: 0, bottom: 0 },
    wrap: {
      type: WRAP_TYPES[(flags >> 5) & 0xf] ?? 'none',
      side: WRAP_SIDES[(flags >> 9) & 0xf] ?? 'bothSides',
      distance,
      polygon: null,
    },
    behind: (flags & 0x4000) !== 0,
    z: entry.z,
    drawing,
  }
}

/** 形状框：外层坐标中的矩形按 `scale` 换算为 EMU，旋转角接近竖直时宽高互换。 */
function xfrmOf(rect: ArtRect, scale: number, s: ArtShape, rotation: number): Xfrm {
  let w = (rect.right - rect.left) * scale
  let h = (rect.bottom - rect.top) * scale
  const cx = rect.left * scale + w / 2
  const cy = rect.top * scale + h / 2
  if (nearVertical(rotation)) [w, h] = [h, w]
  const g = s.groupRect
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    rotation,
    flipH: (s.flags & SHAPE_FLAG.FLIP_H) !== 0,
    flipV: (s.flags & SHAPE_FLAG.FLIP_V) !== 0,
    child:
      g === null
        ? null
        : { x: g.left, y: g.top, width: g.right - g.left, height: g.bottom - g.top },
  }
}

function nodeOf<C>(
  s: ArtShape,
  rect: ArtRect,
  scale: number,
  t: Transform,
  scope: ShapeScope<C>,
): PendingNode<C> | null {
  const props = s.properties
  if (s.flags & SHAPE_FLAG.DELETED || flagOf(props, P.groupBooleans, 1, false)) return null
  const xfrm = xfrmOf(rect, scale, s, artRotation(props))
  const frame: Frame = frameOf(xfrm, t)
  const style = scope.style
  if (s.children !== null) {
    const inner = childTransform(xfrm, t)
    const children: PendingNode<C>[] = []
    for (const c of s.children) {
      if (c.childAnchor === null) continue
      const node = nodeOf(c, c.childAnchor, 1, inner, scope)
      if (node !== null) children.push(node)
    }
    return { kind: 'group', frame, effects: [], children }
  }
  if (props.values.has(P.gtext)) return null
  const effects = artEffects(props, style)
  if (s.shapeType === PICTURE_FRAME && props.values.has(P.pib)) {
    const image = artPicture(props, style)
    if (image === null) return null
    const fill: ShapeFill = { kind: 'picture', image }
    return {
      kind: 'shape',
      frame,
      geometry: { kind: 'preset', name: 'rect', adjust: [] },
      fill,
      line: artLine(props, style),
      effects,
      text: textOf(s, scope),
    }
  }
  const geometry = artGeometry(s.shapeType, props, { w: frame.width, h: frame.height })
  if (geometry === null) return null
  return {
    kind: 'shape',
    frame,
    geometry,
    fill: artFill(props, style),
    line: artLine(props, style),
    effects,
    text: textOf(s, scope),
  }
}

function textOf<C>(s: ArtShape, scope: ShapeScope<C>): PendingTextBox<C> | null {
  const v = s.properties.values
  const txid = v.get(P.lTxid)
  if (txid === undefined) return null
  const content = scope.textbox(txid >>> 16)
  if (content === null) return null
  if ((v.get(P.textFlow) ?? 0) !== 0) scope.count('textDirection')
  const inset = (id: number, fallback: number) => (v.get(id) ?? fallback) / EMU_PER_POINT
  return {
    content,
    inset: {
      left: inset(P.textLeft, 91440),
      top: inset(P.textTop, 45720),
      right: inset(P.textRight, 91440),
      bottom: inset(P.textBottom, 45720),
    },
    anchor: TEXT_ANCHORS[v.get(P.anchorText) ?? 0] ?? 'top',
    autoFit: flagOf(s.properties, P.textBooleans, 1, false),
    wrap: (v.get(P.wrapText) ?? 0) !== 2,
    turned: 0,
  }
}
