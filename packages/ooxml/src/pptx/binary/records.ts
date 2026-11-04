/**
 * .ppt（PowerPoint 97–2003）`PowerPoint Document` 流中的记录：记录头与 OfficeArt 相同（`../../officeart/records.ts`）。
 *
 * - 记录类型取自 MS-PPT 规范的 `RecordType`，只列出读取的类型。
 * - 坐标单位为主单位（每英寸 576），乘 `EMU_PER_MASTER` 得到 EMU。
 */

import type { ArtRecord } from '../../officeart/records.ts'
import { readArtRecords } from '../../officeart/records.ts'

export const RT = {
  DOCUMENT: 0x03e8,
  DOCUMENT_ATOM: 0x03e9,
  SLIDE: 0x03ee,
  SLIDE_ATOM: 0x03ef,
  NOTES: 0x03f0,
  ENVIRONMENT: 0x03f2,
  SLIDE_PERSIST_ATOM: 0x03f3,
  MAIN_MASTER: 0x03f8,
  SLIDE_SHOW_SLIDE_INFO_ATOM: 0x03f9,
  VBA_INFO: 0x03ff,
  VBA_INFO_ATOM: 0x0400,
  EXTERNAL_OBJECT_LIST: 0x0409,
  DRAWING_GROUP: 0x040b,
  DRAWING: 0x040c,
  ROUND_TRIP_THEME: 0x040e,
  ROUND_TRIP_COLOR_MAPPING: 0x040f,
  ROUND_TRIP_TEXT_STYLES: 0x0423,
  LIST: 0x07d0,
  FONT_COLLECTION: 0x07d5,
  COLOR_SCHEME_ATOM: 0x07f0,
  PLACEHOLDER_ATOM: 0x0bc3,
  EXTERNAL_OBJECT_REF_ATOM: 0x0bc1,
  OUTLINE_TEXT_REF_ATOM: 0x0f9e,
  TEXT_HEADER_ATOM: 0x0f9f,
  TEXT_CHARS_ATOM: 0x0fa0,
  STYLE_TEXT_PROP_ATOM: 0x0fa1,
  TEXT_MASTER_STYLE_ATOM: 0x0fa3,
  TEXT_BYTES_ATOM: 0x0fa8,
  TEXT_SPECIAL_INFO_ATOM: 0x0faa,
  FONT_ENTITY_ATOM: 0x0fb7,
  EXTERNAL_OLE_OBJECT_STORAGE: 0x1011,
  ANIMATION_INFO: 0x1014,
  INTERACTIVE_INFO: 0x0ff2,
  INTERACTIVE_INFO_ATOM: 0x0ff3,
  TX_INTERACTIVE_INFO_ATOM: 0x0fdf,
  EX_HYPERLINK: 0x0fd7,
  EX_HYPERLINK_ATOM: 0x0fd3,
  CSTRING: 0x0fba,
  SLIDE_LIST_WITH_TEXT: 0x0ff0,
  USER_EDIT_ATOM: 0x0ff5,
  CURRENT_USER_ATOM: 0x0ff6,
  PROG_TAGS: 0x1388,
  PERSIST_DIRECTORY_ATOM: 0x1772,
  CRYPT_SESSION: 0x2f14,
} as const

/** 每主单位的 EMU：914400 / 576。 */
export const EMU_PER_MASTER = 1587.5

export function children(r: ArtRecord): ArtRecord[] {
  return r.version === 0xf ? readArtRecords(r.data) : []
}

/** 第一个类型为 `type`（与实例为 `instance`）的子记录。 */
export function child(r: ArtRecord, type: number, instance?: number): ArtRecord | null {
  return (
    children(r).find(
      (c) => c.type === type && (instance === undefined || c.instance === instance),
    ) ?? null
  )
}

/** 记录数据的小端读取；越界的字段为 0。 */
export class Fields {
  private readonly view: DataView
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  get length(): number {
    return this.data.length
  }
  u8(p: number): number {
    return p + 1 <= this.data.length ? this.view.getUint8(p) : 0
  }
  u16(p: number): number {
    return p + 2 <= this.data.length ? this.view.getUint16(p, true) : 0
  }
  i16(p: number): number {
    return p + 2 <= this.data.length ? this.view.getInt16(p, true) : 0
  }
  u32(p: number): number {
    return p + 4 <= this.data.length ? this.view.getUint32(p, true) : 0
  }
  i32(p: number): number {
    return p + 4 <= this.data.length ? this.view.getInt32(p, true) : 0
  }
}
