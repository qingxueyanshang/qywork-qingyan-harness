/**
 * metroBlob：PowerPoint 2007 起保存的 .ppt 在形状属性 0x03A9 中存放的 OPC 包。包关系 `shapeXml`、`connectorXml`、`pictureXml`
 * 所指的部件为该形状的 DrawingML（`MEMBERS`）：自选图形与连接线的根元素为 `p:sp`，图片为 `p:pic`，背景形状中为
 * `p:background`。WPS 演示按它绘制带 metroBlob 的形状，旧格式记录是低版本的近似（带效果的文字为图片，三维形状为组合）。
 *
 * - 形状经 pptx 的 `readMember` 读取，由 `ShapeResolver` 求值；作用域取自母版的 RoundTrip 记录（`readMetroMaster`）：
 *   RoundTripTheme12Atom 为主题包，RoundTripColorMapping12Atom 为 UTF-8 的 `a:clrMap`，RoundTripOArtTextStyles12Atom 为
 *   `p:txStyles`。母版部件的形状为母版上带 metroBlob 的顶层形状，供占位符继承。
 * - 版式为空部件：幻灯片 metroBlob 中的占位符 `idx` 均为 4294967295，按 pptx 的规则不与版式占位符匹配，直接继承母版占位符。
 * - 文字（`metroText`）：旧格式记录有文字时，XML 中的文字为等长的占位字符，字符按位置取自旧格式记录，U+000B 为换行。
 * - 部件名：包内的部件名加上来源前缀，形状为 `<容器部件名>/shape/<形状编号>`，主题为 `<容器部件名>/theme`；
 *   `readMetroImage` 按前缀找回所在的包。
 * - 包无法打开、没有上述关系、XML 结构错误、根元素与关系类型不符或背景中没有填充时没有 metroBlob 内容，形状按旧格式记录
 *   换算。各 RoundTrip 记录缺失或无法读取时，主题为空主题，颜色映射与文字样式缺失。
 */

import { type ColorMap, DEFAULT_COLOR_MAP } from '../../drawingml/color.ts'
import { drawableImage } from '../../drawingml/shape/resolve.ts'
import type { ListStyleSpec, RawRun, RawTextBody } from '../../drawingml/text/read.ts'
import { EMPTY_THEME, parseTheme, type Theme } from '../../drawingml/theme.ts'
import type { ArtRecord } from '../../officeart/records.ts'
import {
  type ArtShape,
  flattenShapes,
  readDrawingBackground,
  readDrawingShapes,
} from '../../officeart/shape.ts'
import {
  type OpcPackage,
  openPackage,
  RelationshipList,
  type Relationships,
} from '../../opc/package.ts'
import { PartScanner } from '../../opc/scanner.ts'
import { XmlSyntaxError } from '../../xml/index.ts'
import type { UnsupportedKind } from '../model.ts'
import { type RawShape, readMember } from '../parse/shape.ts'
import {
  type BackgroundSpec,
  type RawPart,
  readBackground,
  readColorMap,
  readTextStyles,
  SLIDE_EXTENSIONS,
  type TextStyles,
} from '../parse/slide.ts'
import type { SlideScope } from '../resolve/scope.ts'
import { child, RT } from './records.ts'

const PROP_METRO_BLOB = 0x03a9
const RELATIONSHIPS = 'http://schemas.microsoft.com/office/2006/relationships/'
/**
 * 包关系的类型对应的形状元素：连接线部件的根元素名为 `sp`，内容为 `cxnSp` 的子元素；`inkXml`（墨迹）与 `graphicFrameDoc`
 * 不读取，按旧格式记录换算（墨迹的旧格式为图片）。
 */
const MEMBERS: ReadonlyMap<string, string> = new Map([
  [`${RELATIONSHIPS}shapeXml`, 'sp'],
  [`${RELATIONSHIPS}connectorXml`, 'cxnSp'],
  [`${RELATIONSHIPS}pictureXml`, 'pic'],
])

export type MetroContent =
  | { readonly kind: 'shape'; readonly shape: RawShape }
  | { readonly kind: 'background'; readonly background: BackgroundSpec }

/** 全部容器中带 metroBlob 的形状（键为 `<容器部件名>/<形状编号>`）与包内图片能否绘制（键为部件名）。 */
export interface MetroContents {
  readonly shapes: Map<string, MetroContent>
  readonly images: Map<string, boolean>
}

const EMPTY_RELS = new RelationshipList('/', [])

function prefixed(rels: Relationships, prefix: string): Relationships {
  return new RelationshipList(
    rels.source,
    rels.list.map((r) => (r.part === null ? r : { ...r, part: prefix + r.part })),
  )
}

async function open(data: Uint8Array): Promise<OpcPackage | null> {
  const r = await openPackage(data.slice())
  return r.ok ? r.value : null
}

async function relsOf(pkg: OpcPackage, source: string): Promise<Relationships> {
  const r = await pkg.relationships(source)
  return r.ok ? r.value : EMPTY_RELS
}

async function textOf(pkg: OpcPackage, part: string | null): Promise<string | null> {
  if (part === null) return null
  const r = await pkg.text(part)
  return r.ok ? r.value : null
}

/** XML 结构错误时为 `null`。 */
function parsed<T>(read: () => T | null): T | null {
  try {
    return read()
  } catch (e) {
    if (e instanceof XmlSyntaxError) return null
    throw e
  }
}

/** 扫描器停在根元素的开始标签处；没有根元素时为 `null`。 */
function root(xml: string): PartScanner | null {
  const x = new PartScanner(xml, SLIDE_EXTENSIONS)
  for (let t = x.next(); t !== null; t = x.next()) if (t === 'start') return x
  return null
}

/** 记录包内图片关系所指部件能否绘制（键为加上前缀的部件名）。 */
async function readImages(
  pkg: OpcPackage,
  rels: Relationships,
  prefix: string,
  out: Map<string, boolean>,
): Promise<void> {
  for (const r of rels.ofKind('image')) {
    if (r.part === null) continue
    const bytes = await pkg.bytes(r.part)
    out.set(
      prefix + r.part,
      bytes.ok && bytes.value !== null && drawableImage(pkg.contentType(r.part) ?? '', bytes.value),
    )
  }
}

async function readContent(
  blob: Uint8Array,
  prefix: string,
  images: Map<string, boolean>,
): Promise<MetroContent | null> {
  const pkg = await open(blob)
  if (pkg === null) return null
  const top = await relsOf(pkg, '/')
  const rel = top.list.find((r) => MEMBERS.has(r.type) && r.part !== null)
  const member = rel === undefined ? undefined : MEMBERS.get(rel.type)
  const part = rel?.part ?? null
  const xml = await textOf(pkg, part)
  if (member === undefined || part === null || xml === null) return null
  const own = await relsOf(pkg, part)
  await readImages(pkg, own, prefix, images)
  const rels = prefixed(own, prefix)
  return parsed<MetroContent>(() => {
    const x = root(xml)
    if (x?.local === 'background') {
      const background = readBackground(x, rels)
      return background === null ? null : { kind: 'background', background }
    }
    if (x === null || x.local !== (member === 'pic' ? 'pic' : 'sp')) return null
    const out: RawShape[] = []
    readMember(x, member, rels, out)
    return out[0] === undefined ? null : { kind: 'shape', shape: out[0] }
  })
}

function metroBlob(s: ArtShape): Uint8Array | null {
  return s.properties.complex.get(PROP_METRO_BLOB) ?? null
}

/** 绘图中的背景形状与全部形状（含组合内）。 */
function drawingShapes(drawing: Uint8Array): ArtShape[] {
  const background = readDrawingBackground(drawing)
  return [
    ...(background === null ? [] : [background]),
    ...flattenShapes(readDrawingShapes(drawing)),
  ]
}

/** 读取一个容器（`part` 为其部件名）的绘图中带 metroBlob 的形状与背景，结果加入 `out`。 */
export async function readMetroShapes(
  drawing: Uint8Array,
  part: string,
  out: MetroContents,
): Promise<void> {
  for (const s of drawingShapes(drawing)) {
    const blob = metroBlob(s)
    if (blob === null) continue
    const content = await readContent(blob, `${part}/shape/${s.id}`, out.images)
    if (content !== null) out.shapes.set(`${part}/${s.id}`, content)
  }
}

/** 母版的 DrawingML 作用域。 */
export interface MetroMaster {
  readonly theme: Theme
  /** 母版部件：顶层带 metroBlob 的形状、背景、颜色映射与文字样式。 */
  readonly part: RawPart
}

async function readTheme(
  atom: ArtRecord | null,
  prefix: string,
  images: Map<string, boolean>,
): Promise<Theme> {
  const pkg = atom === null ? null : await open(atom.data)
  if (pkg === null) return EMPTY_THEME
  const manager = (await relsOf(pkg, '/')).part('officeDocument')
  const part = manager === null ? null : (await relsOf(pkg, manager)).part('theme')
  const xml = await textOf(pkg, part)
  if (part === null || xml === null) return EMPTY_THEME
  const rels = await relsOf(pkg, part)
  await readImages(pkg, rels, prefix, images)
  return parsed(() => parseTheme(xml, prefixed(rels, prefix))) ?? EMPTY_THEME
}

function readColorMapAtom(atom: ArtRecord | null): ColorMap | null {
  return atom === null
    ? null
    : parsed(() => {
        const x = root(new TextDecoder().decode(atom.data))
        return x === null ? null : readColorMap(x)
      })
}

async function readTextStylesAtom(atom: ArtRecord | null): Promise<TextStyles | null> {
  const pkg = atom === null ? null : await open(atom.data)
  if (pkg === null) return null
  const xml = await textOf(pkg, (await relsOf(pkg, '/')).part('slideMaster'))
  return xml === null
    ? null
    : parsed(() => {
        const x = root(xml)
        return x === null ? null : readTextStyles(x, { rels: EMPTY_RELS, found: [] })
      })
}

function emptyPart(part: string): RawPart {
  return {
    part,
    rels: EMPTY_RELS,
    hidden: false,
    showMasterShapes: true,
    background: null,
    shapes: [],
    found: [],
    colorMap: null,
    textStyles: null,
  }
}

/** 没有母版时的作用域：空主题、空母版部件。 */
export const NO_METRO_MASTER: MetroMaster = { theme: EMPTY_THEME, part: emptyPart('') }

/** 母版容器（`part` 为其部件名）的 DrawingML 作用域；`contents` 为已读取的 metroBlob（`readMetroShapes`）。 */
export async function readMetroMaster(
  container: ArtRecord,
  part: string,
  contents: MetroContents,
): Promise<MetroMaster> {
  const drawing = child(container, RT.DRAWING)?.data
  const shapes = (drawing === undefined ? [] : readDrawingShapes(drawing)).flatMap((s) => {
    const c = contents.shapes.get(`${part}/${s.id}`)
    return c?.kind === 'shape' ? [c.shape] : []
  })
  const bg = drawing === undefined ? null : readDrawingBackground(drawing)
  const bgContent = bg === null ? undefined : contents.shapes.get(`${part}/${bg.id}`)
  return {
    theme: await readTheme(child(container, RT.ROUND_TRIP_THEME), `${part}/theme`, contents.images),
    part: {
      ...emptyPart(part),
      background: bgContent?.kind === 'background' ? bgContent.background : null,
      shapes,
      colorMap: readColorMapAtom(child(container, RT.ROUND_TRIP_COLOR_MAPPING)),
      textStyles: await readTextStylesAtom(child(container, RT.ROUND_TRIP_TEXT_STYLES)),
    },
  }
}

/**
 * 幻灯片求值所用的作用域：主题、颜色映射与母版部件取自 `master`，版式为空部件；`defaultTextStyle` 为文档的缺省样式
 * （`../binary/text.ts` 的 `documentTextStyle`）。
 */
export function metroScope(
  master: MetroMaster,
  images: ReadonlyMap<string, boolean>,
  defaultTextStyle: ListStyleSpec,
  found: UnsupportedKind[],
): SlideScope {
  return {
    theme: master.theme,
    colors: { scheme: master.theme.colors, map: master.part.colorMap ?? DEFAULT_COLOR_MAP },
    master: master.part,
    layout: emptyPart(''),
    defaultTextStyle,
    tableStyles: new Map(),
    imageDrawable: (part) => images.get(part) ?? null,
    charts: new Map(),
    diagrams: new Map(),
    inks: new Map(),
    found,
  }
}

/**
 * metroBlob 中的文字。`text` 不为 `null` 时，XML 文字中的字符按位置替换为旧格式记录的文字：各段之间对应一个 U+000D，
 * 换行（`a:br`）对应一个 U+000B，文字段中的 U+000B 拆为换行；字段与公式保留 XML 中的内容，字段按其文字长度前进。
 * 没有 `endParaRPr` 的段落，结束符的格式取最后一个文字段：XML 写出时省略与最后一个文字段相同的结束符格式。
 * 不要改为按列表样式取：经核对的 12 份中，按列表样式取时 150 段的结束符字号与旧格式记录不同，按最后一个文字段取时 4 段；
 * 末行的行高含结束符的字号。
 */
export function metroText(body: RawTextBody, text: string | null): RawTextBody {
  let p = 0
  const paragraphs = body.paragraphs.map((para, i) => {
    if (i > 0) p++
    const runs: RawRun[] = []
    for (const r of para.runs) {
      if (r.kind === 'text' && text !== null) {
        const pieces = text.slice(p, p + r.text.length).split('\v')
        p += r.text.length
        pieces.forEach((piece, k) => {
          if (k > 0) runs.push({ kind: 'break', props: r.props })
          if (piece !== '') runs.push({ ...r, text: piece })
        })
      } else {
        if (r.kind === 'break') p++
        else if (r.kind === 'field') p += r.text.length
        runs.push(r)
      }
    }
    const last = runs.findLast((r) => r.kind === 'text')
    return { ...para, runs, end: para.end ?? (last?.kind === 'text' ? last.props : null) }
  })
  return { ...body, paragraphs }
}

/** 按部件名读取 metroBlob 中的图片：`containers` 按容器部件名给出容器记录。不是 metroBlob 部件或不存在时为 `null`。 */
export async function readMetroImage(
  part: string,
  containers: ReadonlyMap<string, ArtRecord>,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const m = /^((?:slide|master)\/\d+)\/(?:shape\/(\d+)|theme)(\/.*)$/.exec(part)
  const container = m === null ? undefined : containers.get(m[1]!)
  if (m === null || container === undefined) return null
  let data: Uint8Array | null = null
  if (m[2] === undefined) {
    data = child(container, RT.ROUND_TRIP_THEME)?.data ?? null
  } else {
    const drawing = child(container, RT.DRAWING)?.data
    const id = Number(m[2])
    const shape =
      drawing === undefined ? undefined : drawingShapes(drawing).find((s) => s.id === id)
    data = shape === undefined ? null : metroBlob(shape)
  }
  const pkg = data === null ? null : await open(data)
  if (pkg === null) return null
  const bytes = await pkg.bytes(m[3]!)
  if (!bytes.ok || bytes.value === null) return null
  return { bytes: bytes.value, contentType: pkg.contentType(m[3]!) ?? '' }
}
