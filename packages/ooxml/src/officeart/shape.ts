/**
 * OfficeArt 绘图容器中的形状树。
 *
 * - 绘图容器（`DG_CONTAINER`）下的形状组容器（`SPGR_CONTAINER`）以第一个形状容器为根组（patriarch），其余子项为顶层形状；
 *   嵌套的形状组容器为组合，其第一个形状容器是组合本身，其余为组合的子形状。
 * - `clientData` 不为 `null` 的形状在宿主格式中另有对应记录：.xls 中按出现顺序（先序遍历）与 OBJ 记录一一对应，
 *   .ppt 中为其中的占位符、外部对象引用等记录。
 * - 属性取主属性表、次级与第三级属性表的合并（`mergeProperties`）。
 */

import {
  ART,
  type ArtProperties,
  type ArtRecord,
  EMPTY_PROPERTIES,
  mergeProperties,
  readArtRecords,
  readProperties,
} from './records.ts'

/** FSP 的标志位。 */
export const SHAPE_FLAG = {
  GROUP: 0x1,
  CHILD: 0x2,
  PATRIARCH: 0x4,
  DELETED: 0x8,
  OLE: 0x10,
  FLIP_H: 0x40,
  FLIP_V: 0x80,
  CONNECTOR: 0x100,
  BACKGROUND: 0x400,
} as const

/** 子锚点与组合坐标系的矩形：四边的坐标。 */
export interface ArtRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface ArtShape {
  /** FSP 的形状编号。 */
  readonly id: number
  /** FSP 的实例，即形状类型（75 为图片框）。 */
  readonly shapeType: number
  /** FSP 的标志位（`SHAPE_FLAG`）。 */
  readonly flags: number
  readonly properties: ArtProperties
  /** 客户锚点记录的数据，没有时为 `null`。 */
  readonly anchor: Uint8Array | null
  /** 组合内形状的子锚点（所在组合的坐标系），没有时为 `null`。 */
  readonly childAnchor: ArtRect | null
  /** 组合的子坐标系（FSPGR）；不是组合时为 `null`。 */
  readonly groupRect: ArtRect | null
  /** 客户数据记录的数据，没有时为 `null`。 */
  readonly clientData: Uint8Array | null
  /** 客户文本框记录的数据，没有时为 `null`。 */
  readonly clientTextbox: Uint8Array | null
  /** 组合的子形状；不是组合时为 `null`。 */
  readonly children: readonly ArtShape[] | null
}

function rect(data: Uint8Array): ArtRect | null {
  if (data.length < 16) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    left: view.getInt32(0, true),
    top: view.getInt32(4, true),
    right: view.getInt32(8, true),
    bottom: view.getInt32(12, true),
  }
}

function readShape(container: ArtRecord, children: readonly ArtShape[] | null): ArtShape {
  let id = 0
  let shapeType = 0
  let flags = 0
  const tables: ArtProperties[] = []
  let anchor: Uint8Array | null = null
  let childAnchor: ArtRect | null = null
  let groupRect: ArtRect | null = null
  let clientData: Uint8Array | null = null
  let clientTextbox: Uint8Array | null = null
  for (const r of readArtRecords(container.data)) {
    if (r.type === ART.FSP) {
      shapeType = r.instance
      const view = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength)
      if (r.data.length >= 8) {
        id = view.getUint32(0, true)
        flags = view.getUint32(4, true)
      }
    } else if (r.type === ART.FOPT) tables.unshift(readProperties(r))
    else if (r.type === ART.SECONDARY_FOPT || r.type === ART.TERTIARY_FOPT) {
      tables.push(readProperties(r))
    } else if (r.type === ART.CLIENT_ANCHOR) anchor = r.data
    else if (r.type === ART.CHILD_ANCHOR) childAnchor = rect(r.data)
    else if (r.type === ART.FSPGR) groupRect = rect(r.data)
    else if (r.type === ART.CLIENT_DATA) clientData = r.data
    else if (r.type === ART.CLIENT_TEXTBOX) clientTextbox = r.data
  }
  const properties = tables.length === 0 ? EMPTY_PROPERTIES : mergeProperties(...tables)
  return {
    id,
    shapeType,
    flags,
    properties,
    anchor,
    childAnchor,
    groupRect,
    clientData,
    clientTextbox,
    children,
  }
}

/** 形状组容器的子项：第一个形状容器为组合本身，返回组合与其后的子形状。 */
function readGroup(group: ArtRecord): { self: ArtRecord | null; members: ArtShape[] } {
  const items = readArtRecords(group.data)
  const members: ArtShape[] = []
  let self: ArtRecord | null = null
  for (const r of items) {
    if (r.type === ART.SP_CONTAINER && self === null) self = r
    else if (r.type === ART.SP_CONTAINER) members.push(readShape(r, null))
    else if (r.type === ART.SPGR_CONTAINER) {
      const inner = readGroup(r)
      if (inner.self !== null) members.push(readShape(inner.self, inner.members))
    }
  }
  return { self, members }
}

/** 绘图容器数据中的顶层形状（不含根组）。 */
export function readDrawingShapes(drawing: Uint8Array): ArtShape[] {
  const dg = readArtRecords(drawing).find((r) => r.type === ART.DG_CONTAINER)
  const root = dg && readArtRecords(dg.data).find((r) => r.type === ART.SPGR_CONTAINER)
  return root ? readGroup(root).members : []
}

/** 绘图容器中不在形状组内、设置了 `fBackground` 的形状（.ppt 幻灯片与母版的背景）；没有时为 `null`。 */
export function readDrawingBackground(drawing: Uint8Array): ArtShape | null {
  const dg = readArtRecords(drawing).find((r) => r.type === ART.DG_CONTAINER)
  for (const r of dg === undefined ? [] : readArtRecords(dg.data)) {
    if (r.type !== ART.SP_CONTAINER) continue
    const shape = readShape(r, null)
    if (shape.flags & SHAPE_FLAG.BACKGROUND) return shape
  }
  return null
}

/** 先序遍历：组合在其子形状之前。 */
export function flattenShapes(shapes: readonly ArtShape[]): ArtShape[] {
  return shapes.flatMap((s) => [s, ...(s.children ? flattenShapes(s.children) : [])])
}
