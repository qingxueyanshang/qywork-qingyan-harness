/**
 * .ppt 的文档容器（DocumentContainer）：幻灯片尺寸与起始编号、幻灯片与母版的顺序与容器、绘图组、外部对象与文字缺省（`text.ts`）。
 *
 * - DocumentAtom：`slideSize`（主单位）与 `firstSlideNumber`。
 * - SlideListWithText 实例 0 为幻灯片、实例 1 为母版（含标题母版）：每个 SlidePersistAtom 的 `persistIdRef` 指向容器，
 *   其后到下一个 SlidePersistAtom 之前的文字记录属于该幻灯片的占位符（由形状的 OutlineTextRefAtom 按序号引用）。
 *   幻灯片顺序即其中 SlidePersistAtom 的顺序；容器不存在或类型不符的项跳过。
 * - 母版按 SlidePersistAtom 的 `slideId` 索引：幻灯片的 SlideAtom 以 `masterIdRef` 引用它。
 * - 外部对象列表（ExObjList）：嵌入与链接的 OLE 对象、控件与音视频对象，按外部对象编号：OLE 对象与控件取 ExOleObjAtom
 *   第 8 字节起的值，音视频取 ExMediaAtom（视频在 ExVideoContainer 之内）第 0 字节起的值。超链接（ExHyperlinkContainer）
 *   按 ExHyperlinkAtom 的编号取目标（实例为 1 的 CString；没有时为空串）。
 */

import type { ArtRecord } from '../../officeart/records.ts'
import { ART } from '../../officeart/records.ts'
import { child, children, EMU_PER_MASTER, Fields, RT } from './records.ts'
import { readTextDefaults, type TextDefaults } from './text.ts'

export interface SlideEntry {
  readonly slideId: number
  /** SlideContainer 或 MainMasterContainer。 */
  readonly container: ArtRecord
  /** SlideListWithText 中属于该项的文字记录。 */
  readonly texts: readonly ArtRecord[]
}

/** 外部对象的种类：形状的 ExObjRefAtom 按编号引用。 */
export type ExternalKind = 'ole' | 'media'

/** 外部对象容器的记录类型：OLE 嵌入、OLE 链接、控件；AVI、MCI 视频，MIDI、CD、嵌入与链接的 WAV 音频。 */
const EXTERNAL_KINDS: ReadonlyMap<number, ExternalKind> = new Map([
  [0x0fcc, 'ole'],
  [0x0fce, 'ole'],
  [0x0fee, 'ole'],
  [0x1006, 'media'],
  [0x1007, 'media'],
  [0x100d, 'media'],
  [0x100e, 'media'],
  [0x100f, 'media'],
  [0x1010, 'media'],
])

export interface PptDocument {
  /** EMU。 */
  readonly width: number
  readonly height: number
  readonly firstSlideNumber: number
  readonly slides: readonly SlideEntry[]
  /** 按 `slideId`。 */
  readonly masters: ReadonlyMap<number, SlideEntry>
  /** OfficeArtDggContainer 的子记录（图片库与缺省形状属性）；没有绘图组时为空。 */
  readonly drawingGroup: readonly ArtRecord[]
  readonly externals: ReadonlyMap<number, ExternalKind>
  /** 超链接的目标，按编号。 */
  readonly hyperlinks: ReadonlyMap<number, string>
  readonly text: TextDefaults
  /** 幻灯片的页眉页脚设置（HeadersFootersContainer，实例 3）；没有时为 `null`。 */
  readonly headersFooters: ArtRecord | null
}

const SLIDE_CONTAINERS: ReadonlySet<number> = new Set([RT.SLIDE, RT.MAIN_MASTER])

function readList(
  doc: ArtRecord,
  instance: number,
  object: (id: number) => ArtRecord | null,
): SlideEntry[] {
  const list = child(doc, RT.SLIDE_LIST_WITH_TEXT, instance)
  if (list === null) return []
  const out: { slideId: number; container: ArtRecord | null; texts: ArtRecord[] }[] = []
  for (const r of children(list)) {
    if (r.type === RT.SLIDE_PERSIST_ATOM) {
      const f = new Fields(r.data)
      out.push({ slideId: f.u32(12), container: object(f.u32(0)), texts: [] })
    } else {
      out.at(-1)?.texts.push(r)
    }
  }
  return out.flatMap((e) =>
    e.container !== null && SLIDE_CONTAINERS.has(e.container.type)
      ? [{ slideId: e.slideId, container: e.container, texts: e.texts }]
      : [],
  )
}

const OLE_OBJECT_ATOM = 0x0fc3
const HEADERS_FOOTERS = 0x0fd9
const MEDIA_ATOM = 0x1004

function externalId(r: ArtRecord, kind: ExternalKind): number | null {
  if (kind === 'ole') {
    const atom = child(r, OLE_OBJECT_ATOM)
    return atom === null ? null : new Fields(atom.data).u32(8)
  }
  const atom =
    child(r, MEDIA_ATOM) ?? children(r).find((c) => child(c, MEDIA_ATOM) !== null) ?? null
  const media = atom?.type === MEDIA_ATOM ? atom : atom === null ? null : child(atom, MEDIA_ATOM)
  return media === null ? null : new Fields(media.data).u32(0)
}

function readExternals(doc: ArtRecord): Map<number, ExternalKind> {
  const out = new Map<number, ExternalKind>()
  const list = child(doc, RT.EXTERNAL_OBJECT_LIST)
  for (const r of list === null ? [] : children(list)) {
    const kind = EXTERNAL_KINDS.get(r.type)
    const id = kind === undefined ? null : externalId(r, kind)
    if (kind !== undefined && id !== null) out.set(id, kind)
  }
  return out
}

function utf16(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < data.length; i += 2)
    s += String.fromCharCode(data[i]! | (data[i + 1]! << 8))
  return s
}

function readHyperlinks(doc: ArtRecord): Map<number, string> {
  const out = new Map<number, string>()
  const list = child(doc, RT.EXTERNAL_OBJECT_LIST)
  for (const r of list === null ? [] : children(list)) {
    const atom = r.type === RT.EX_HYPERLINK ? child(r, RT.EX_HYPERLINK_ATOM) : null
    if (atom === null) continue
    const target = child(r, RT.CSTRING, 1)
    out.set(new Fields(atom.data).u32(0), target === null ? '' : utf16(target.data))
  }
  return out
}

export function readDocument(
  doc: ArtRecord,
  object: (id: number) => ArtRecord | null,
): PptDocument {
  const atom = new Fields(child(doc, RT.DOCUMENT_ATOM)?.data ?? new Uint8Array(0))
  const group = child(doc, RT.DRAWING_GROUP)
  const dgg = group === null ? null : child(group, ART.DGG_CONTAINER)
  return {
    width: atom.i32(0) * EMU_PER_MASTER,
    height: atom.i32(4) * EMU_PER_MASTER,
    firstSlideNumber: atom.u16(32),
    slides: readList(doc, 0, object),
    masters: new Map(readList(doc, 1, object).map((m) => [m.slideId, m])),
    drawingGroup: dgg === null ? [] : children(dgg),
    externals: readExternals(doc),
    hyperlinks: readHyperlinks(doc),
    text: readTextDefaults(doc),
    headersFooters: child(doc, HEADERS_FOOTERS, 3),
  }
}
