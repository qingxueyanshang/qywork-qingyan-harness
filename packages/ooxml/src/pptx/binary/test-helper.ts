/**
 * 测试夹具：按记录生成 .ppt（CFB 中的 `Current User`、`PowerPoint Document` 与 `Pictures` 流）。
 *
 * - 持久对象编号：1 为文档容器，2 为主母版（`slideId` 为 0x80000000），其后依次为各幻灯片；`slideId` 从 256 起。
 * - `buildPpt` 依次写出各持久对象、PersistDirectoryAtom 与 UserEditAtom；`edits` 给出快速保存时追加的各次保存
 *   （替换给定编号的持久对象），每次追加一组持久对象、PersistDirectoryAtom 与 UserEditAtom。
 * - 形状记录由 `art` 按记录头生成，形状容器由 `shape` 按属性与锚点生成。
 * - metroBlob 与母版的 RoundTrip 记录由 `metroBlob`、`themeAtom`、`colorMapAtom`、`textStylesAtom` 生成。
 */

import { buildCfb } from '../../zip/test-helper.ts'
import { buildZip, NS_DECL } from '../test-helper.ts'

export function fields(...items: [1 | 2 | 4, number][]): Uint8Array {
  const out = new Uint8Array(items.reduce((n, [size]) => n + size, 0))
  const view = new DataView(out.buffer)
  let p = 0
  for (const [size, value] of items) {
    if (size === 1) view.setUint8(p, value)
    else if (size === 2) view.setUint16(p, value & 0xffff, true)
    else view.setUint32(p, value >>> 0, true)
    p += size
  }
  return out
}

export function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/** 记录：`verInst` 为版本与实例的合并值（容器版本为 0xF）。 */
export function art(verInst: number, type: number, ...body: Uint8Array[]): Uint8Array {
  const data = join(...body)
  return join(fields([2, verInst], [2, type], [4, data.length]), data)
}

export const container = (type: number, ...body: Uint8Array[]) => art(0x000f, type, ...body)

/** 属性：`[编号, 值]` 为简单属性，`[编号, 附加数据]` 为复杂属性，第三项为记录的长度（缺省为附加数据的长度）。 */
export type Prop = readonly [number, number | Uint8Array, number?]

export function fopt(type: number, props: readonly Prop[]): Uint8Array {
  const table = props.map(([id, v, length]) =>
    v instanceof Uint8Array
      ? fields([2, id | 0x8000], [4, length ?? v.length])
      : fields([2, id], [4, v]),
  )
  const extra = props.flatMap(([, v]) => (v instanceof Uint8Array ? [v] : []))
  return art((props.length << 4) | 3, type, ...table, ...extra)
}

export interface ShapeSpec {
  readonly id: number
  readonly type?: number
  /** FSP 标志位，缺省为 0xA00（有锚点、有形状类型）。 */
  readonly flags?: number
  readonly props?: readonly Prop[]
  /** 主单位的上、左、右、下；16 位锚点。 */
  readonly anchor?: readonly [number, number, number, number]
  /** 组合内的子锚点：左、上、右、下。 */
  readonly child?: readonly [number, number, number, number]
  /** 组合的子坐标系：左、上、右、下。 */
  readonly group?: readonly [number, number, number, number]
  /** 客户数据中的记录。 */
  readonly client?: readonly Uint8Array[]
  /** 客户文本框中的记录。 */
  readonly textbox?: readonly Uint8Array[]
}

export function shape(s: ShapeSpec): Uint8Array {
  const parts = [
    ...(s.group ? [art(0x0001, 0xf009, fields(...s.group.map((v) => [4, v] as [4, number])))] : []),
    art(((s.type ?? 1) << 4) | 2, 0xf00a, fields([4, s.id], [4, s.flags ?? 0xa00])),
  ]
  if (s.props && s.props.length > 0) parts.push(fopt(0xf00b, s.props))
  if (s.anchor) parts.push(art(0, 0xf010, fields(...s.anchor.map((v) => [2, v] as [2, number]))))
  if (s.child) parts.push(art(0, 0xf00f, fields(...s.child.map((v) => [4, v] as [4, number]))))
  if (s.client) parts.push(container(0xf011, ...s.client))
  if (s.textbox) parts.push(container(0xf00d, ...s.textbox))
  return container(0xf004, ...parts)
}

/** 组合：第一个形状容器为组合本身。 */
export function groupShape(self: ShapeSpec, ...members: Uint8Array[]): Uint8Array {
  return container(0xf003, shape({ ...self, flags: (self.flags ?? 0xa00) | 0x1 }), ...members)
}

const PATRIARCH = shape({ id: 0, type: 0, flags: 0x5 })

/** PPDrawing：绘图容器中的形状组（根组之后为 `shapes`）与可选的背景形状。 */
export function drawing(shapes: readonly Uint8Array[], background?: Uint8Array): Uint8Array {
  return container(
    0x040c,
    container(
      0xf002,
      art(0, 0xf008, fields([4, 0], [4, 0])),
      container(0xf003, PATRIARCH, ...shapes),
      ...(background ? [background] : []),
    ),
  )
}

/** 8 种颜色的配色方案（RGB 整数）。 */
export function colorScheme(colors: readonly number[]): Uint8Array {
  return art(
    0x0010,
    0x07f0,
    ...colors.map((c) =>
      fields([1, (c >> 16) & 0xff], [1, (c >> 8) & 0xff], [1, c & 0xff], [1, 0]),
    ),
  )
}

export const SCHEME = [
  0xffffff, 0x000000, 0x808080, 0x000000, 0x00cc99, 0x3333cc, 0xff0000, 0x00ff00,
]

export function slideAtom(masterId: number, flags: number): Uint8Array {
  return art(
    0x0002,
    0x03ef,
    fields([4, 0]),
    new Uint8Array(8),
    fields([4, masterId], [4, 0], [2, flags], [2, 0]),
  )
}

export interface SlideSpec {
  readonly shapes?: readonly Uint8Array[]
  readonly background?: Uint8Array
  /** SlideAtom 的 `slideFlags`，缺省为 7（母版形状、配色方案、背景都取母版）。 */
  readonly flags?: number
  readonly scheme?: readonly number[]
  /** 其他子记录（如 SlideShowSlideInfoAtom、母版的 TextMasterStyleAtom）。 */
  readonly extra?: readonly Uint8Array[]
  /** SlideListWithText 中 SlidePersistAtom 之后的文字记录。 */
  readonly texts?: readonly Uint8Array[]
}

export interface PptSpec {
  /** 幻灯片尺寸（主单位），缺省 5760 × 4320。 */
  readonly size?: readonly [number, number]
  readonly firstSlideNumber?: number
  readonly master?: SlideSpec
  readonly slides: readonly SlideSpec[]
  /** SlideListWithText 中幻灯片的顺序（下标），缺省为原顺序。 */
  readonly order?: readonly number[]
  /** 绘图组：缺省属性与图片库项（FBSE 内嵌的图片记录，或写入 `Pictures` 流的图片记录）。 */
  readonly defaults?: readonly Prop[]
  readonly blips?: readonly Uint8Array[]
  readonly delayBlips?: readonly Uint8Array[]
  /** 快速保存追加的各次保存：持久对象编号到新的记录。 */
  readonly edits?: readonly ReadonlyMap<number, Uint8Array>[]
  readonly encrypted?: boolean
  readonly currentUser?: boolean
  readonly extraStreams?: Record<string, Uint8Array>
  /** 字体表（FontEntityAtom 的实例为下标）与字符集。 */
  readonly fonts?: readonly (readonly [string, number])[]
  /** DocumentTextInfoContainer 中字体表之后的子记录（文档的 TextMasterStyleAtom 等）。 */
  readonly environment?: readonly Uint8Array[]
  /** 文档容器中的其他子记录（如外部对象列表）。 */
  readonly documentRecords?: readonly Uint8Array[]
}

/** FontEntityAtom：64 字节 UTF-16 字体名、字符集与 3 个标志字节。 */
function fontEntity(index: number, name: string, charset: number): Uint8Array {
  const face = new Uint8Array(64)
  for (let i = 0; i < name.length; i++) {
    face[i * 2] = name.charCodeAt(i) & 0xff
    face[i * 2 + 1] = name.charCodeAt(i) >> 8
  }
  return art(index << 4, 0x0fb7, face, fields([1, charset], [1, 0], [1, 0], [1, 0]))
}

export const MASTER_ID = 0x80000000

function slideRecord(s: SlideSpec, master: boolean): Uint8Array {
  return container(
    master ? 0x03f8 : 0x03ee,
    slideAtom(master ? 0 : MASTER_ID, master ? 0 : (s.flags ?? 7)),
    ...(s.extra ?? []),
    drawing(s.shapes ?? [], s.background),
    colorScheme(s.scheme ?? SCHEME),
  )
}

function fbse(blip: Uint8Array | null, delayOffset: number, delaySize: number): Uint8Array {
  return art(
    0x0062,
    0xf007,
    fields([1, 6], [1, 6]),
    new Uint8Array(16),
    fields([2, 0], [4, blip?.length ?? delaySize], [4, 1], [4, blip ? 0 : delayOffset]),
    fields([1, 0], [1, 0], [1, 0], [1, 0]),
    ...(blip ? [blip] : []),
  )
}

export function buildPpt(spec: PptSpec): Uint8Array<ArrayBuffer> {
  const [width, height] = spec.size ?? [5760, 4320]
  const delay = join(...(spec.delayBlips ?? []))
  const entries: Uint8Array[] = (spec.blips ?? []).map((b) => fbse(b, 0, 0))
  let delayOffset = 0
  for (const b of spec.delayBlips ?? []) {
    entries.push(fbse(null, delayOffset, b.length))
    delayOffset += b.length
  }
  const dgg = container(
    0xf000,
    art(0, 0xf006, fields([4, 0], [4, 0], [4, 0], [4, 0])),
    container(0xf001, ...entries),
    fopt(0xf00b, spec.defaults ?? []),
  )
  const order = spec.order ?? spec.slides.map((_, i) => i)
  const slideList = container(
    0x0ff0,
    ...order.flatMap((i) => [
      art(0, 0x03f3, fields([4, 3 + i], [4, 0], [4, 0], [4, 256 + i], [4, 0])),
      ...(spec.slides[i]!.texts ?? []),
    ]),
  )
  const masterList = art(
    0x001f,
    0x0ff0,
    art(0, 0x03f3, fields([4, 2], [4, 0], [4, 0], [4, MASTER_ID], [4, 0])),
  )
  const document = container(
    0x03e8,
    art(
      0x0001,
      0x03e9,
      fields([4, width], [4, height], [4, width], [4, height], [4, 1], [4, 1], [4, 0], [4, 0]),
      fields([2, spec.firstSlideNumber ?? 1], [2, 0], [1, 0], [1, 0], [1, 0], [1, 0]),
    ),
    container(
      0x03f2,
      container(
        0x07d5,
        ...(spec.fonts ?? []).map(([name, charset], i) => fontEntity(i, name, charset)),
      ),
      ...(spec.environment ?? []),
    ),
    container(0x040b, dgg),
    ...(spec.documentRecords ?? []),
    masterList,
    slideList,
    art(0, 0x03ea),
  )
  const objects = [
    document,
    slideRecord(spec.master ?? {}, true),
    ...spec.slides.map((s) => slideRecord(s, false)),
  ]

  const chunks: Uint8Array[] = []
  let size = 0
  const put = (bytes: Uint8Array): number => {
    const at = size
    chunks.push(bytes)
    size += bytes.length
    return at
  }
  let lastEdit = 0
  const save = (records: ReadonlyMap<number, Uint8Array>) => {
    const ids = [...records.keys()].sort((a, b) => a - b)
    const offsets = new Map(ids.map((id) => [id, put(records.get(id)!)]))
    const dir = put(
      art(0, 0x1772, ...ids.map((id) => fields([4, id | (1 << 20)], [4, offsets.get(id)!]))),
    )
    const edit = put(
      art(
        0,
        0x0ff5,
        fields([4, 256], [2, 0], [1, 0], [1, 3], [4, lastEdit], [4, dir], [4, 1]),
        fields([4, objects.length + 1], [2, 1], [2, 0]),
      ),
    )
    lastEdit = edit
    return edit
  }
  let current = save(new Map(objects.map((o, i) => [i + 1, o])))
  for (const edit of spec.edits ?? []) current = save(edit)

  const user = art(
    0,
    0x0ff6,
    fields(
      [4, 0x14],
      [4, spec.encrypted ? 0xf3d1c4df : 0xe391c05f],
      [4, current],
      [2, 1],
      [2, 0x03f4],
      [1, 3],
      [1, 0],
      [2, 0],
    ),
    Uint8Array.from([0x55]),
    fields([4, 8]),
  )
  return buildCfb({
    ...(spec.currentUser === false ? {} : { 'Current User': user }),
    'PowerPoint Document': join(...chunks),
    ...(delay.length > 0 ? { Pictures: delay } : {}),
    ...(spec.extraStreams ?? {}),
  })
}

const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function relsXml(items: readonly [string, string, string][]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_RELS}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>'

/**
 * metroBlob（形状属性 0x03A9 的附加数据）：包关系 `relType`（缺省为 `shapeXml`）指向 `drs/shapexml.xml`，`xml` 为其根元素
 * （`p:sp`、`p:pic` 或 `p:background`，命名空间声明由本函数加上）。`media` 中的部件放在 `drs/media/` 下，依次由 `rId1` 起的
 * 图片关系引用。
 */
export function metroBlob(
  xml: string,
  media: Record<string, Uint8Array> = {},
  relType = 'shapeXml',
): Uint8Array {
  const names = Object.keys(media)
  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': relsXml([
      [
        'rId1',
        `http://schemas.microsoft.com/office/2006/relationships/${relType}`,
        'drs/shapexml.xml',
      ],
    ]),
    'drs/shapexml.xml': xml.replace(/^<(p:\w+)/, (_, name: string) => `<${name} ${NS_DECL}`),
    'drs/_rels/shapexml.xml.rels': relsXml(
      names.map((n, i) => [`rId${i + 1}`, `${OFFICE_RELS}/image`, `media/${n}`]),
    ),
    ...Object.fromEntries(names.map((n) => [`drs/media/${n}`, media[n]!])),
  })
}

/** RoundTripTheme12Atom：主题包中 `themeManager.xml` 的关系指向 `theme1.xml`（`theme` 为其全文）。 */
export function themeAtom(theme: string): Uint8Array {
  return art(
    0,
    0x040e,
    buildZip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': relsXml([
        ['rId1', `${OFFICE_RELS}/officeDocument`, 'theme/theme/themeManager.xml'],
      ]),
      'theme/theme/themeManager.xml': `<a:themeManager ${NS_DECL}/>`,
      'theme/theme/_rels/themeManager.xml.rels': relsXml([
        ['rId1', `${OFFICE_RELS}/theme`, 'theme1.xml'],
      ]),
      'theme/theme/theme1.xml': theme,
    }),
  )
}

/** RoundTripColorMapping12Atom：UTF-8 的 `a:clrMap`，`attrs` 为其属性串。 */
export function colorMapAtom(attrs: string): Uint8Array {
  return art(0, 0x040f, new TextEncoder().encode(`<a:clrMap ${NS_DECL} ${attrs}/>`))
}

/** RoundTripOArtTextStyles12Atom：包关系 `slideMaster` 指向的部件为 `p:txStyles`（`inner` 为其子元素）。 */
export function textStylesAtom(inner: string): Uint8Array {
  return art(
    0,
    0x0423,
    buildZip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': relsXml([
        ['rId1', `${OFFICE_RELS}/slideMaster`, 'drs/slideMasters/slideMaster1.xml'],
      ]),
      'drs/slideMasters/slideMaster1.xml': `<p:txStyles ${NS_DECL}>${inner}</p:txStyles>`,
    }),
  )
}
