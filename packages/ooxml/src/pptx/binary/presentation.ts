/**
 * .ppt 解析入口：由 CFB 中的 `PowerPoint Document` 流得到与 pptx 相同的 `Presentation` 模型。由 `parsePptx` 在打开 ZIP 之前调用。
 *
 * - 持久对象的定位见 `persist.ts`，文档容器见 `document.ts`；`Current User` 流缺失或结构错误为已损坏（`ppt`），加密为已加密。
 * - .ppt 中没有部件：幻灯片与母版的部件名为 `slide/<slideId>`、`master/<slideId>`（版式与母版相同），图片为 `Pictures/<pib>`，
 *   由 `readPptImages` 按名称从图片库读取（`Pictures` 流）；metroBlob 与主题包中的图片见 `metro.ts`。
 * - 幻灯片的 SlideAtom：`masterIdRef` 为所属母版（标题母版的 SlideAtom 再引用主母版），`slideFlags` 的第 0 位为显示母版上的
 *   非占位符形状，第 1 位为使用母版的配色方案，第 2 位为使用母版的背景。母版形状绘制在幻灯片形状之下；标题母版也显示母版形状时，
 *   其主母版的形状在最下层。
 * - 背景为绘图容器中设置了 `fBackground` 的形状的填充；使用母版背景而标题母版没有背景形状时取主母版的背景。
 *   背景形状带 metroBlob（`p:background`）时按其中的背景求值。
 * - metroBlob（`metro.ts`）：解析前读取全部容器中带 metroBlob 的形状与各母版的 RoundTrip 记录；幻灯片的 DrawingML 作用域
 *   取其主母版（标题母版取其引用的主母版）。
 * - 配色方案为 ColorSchemeAtom（实例 1）的 8 种颜色：背景、文本与线条、阴影、标题文本、填充、强调、强调与超链接、
 *   强调与已访问的超链接，形状颜色的配色方案序号按此顺序取色。幻灯片使用母版的配色方案时取母版的。
 * - 文字见 `text.ts`：文字样式取主母版（标题母版取其引用的主母版）的 TextMasterStyleAtom；该母版带 RoundTrip 文字样式时
 *   占位符的文字经 DrawingML 的继承链求值。文档的缺省样式为 DrawingML 的 `defaultTextStyle`（`documentTextStyle`）。
 * - 能力边界：形状的计数见 `drawing.ts`；切换效果（SlideShowSlideInfoAtom 的效果类型或方向不为 0）计入 `transition`。
 */

import type { Color } from '../../drawingml/color.ts'
import type { ShapeFill } from '../../drawingml/fill.ts'
import { patternName } from '../../drawingml/paint/pattern.ts'
import { drawableImage } from '../../drawingml/shape/resolve.ts'
import { readMetafile } from '../../metafile/index.ts'
import { type Blip, openBlipStore, readBlipStore } from '../../officeart/blip.ts'
import { patternRows } from '../../officeart/pattern.ts'
import { type ArtRecord, readArtRecords } from '../../officeart/records.ts'
import {
  type ArtShape,
  flattenShapes,
  readDrawingBackground,
  readDrawingShapes,
} from '../../officeart/shape.ts'
import { type ArtStyleContext, artFill } from '../../officeart/style.ts'
import type { CfbFile } from '../../zip/cfb.ts'
import type { PptxResult } from '../load.ts'
import type { Shape, Slide, UnsupportedCounts, UnsupportedKind } from '../model.ts'
import type { ImagePart } from '../render/resources.ts'
import { resolveBackground, ShapeResolver } from '../resolve/shape.ts'
import { type PptDocument, readDocument, type SlideEntry } from './document.ts'
import { DrawingConverter, type DrawingScope, outlineGroups, shapeProperties } from './drawing.ts'
import {
  type MetroContents,
  type MetroMaster,
  metroScope,
  NO_METRO_MASTER,
  readMetroImage,
  readMetroMaster,
  readMetroShapes,
} from './metro.ts'
import { readPersist } from './persist.ts'
import { child, Fields, RT } from './records.ts'
import { documentTextStyle, genericDate, readMasterStyles } from './text.ts'

const PICTURES = 'Pictures/'
const FLAG_MASTER_OBJECTS = 0x1
const FLAG_MASTER_SCHEME = 0x2
const FLAG_MASTER_BACKGROUND = 0x4
const NONE: ShapeFill = { kind: 'none' }
/** 幻灯片自身的页眉页脚设置（HeadersFootersContainer）。 */
const HEADERS_FOOTERS = 0x0fd9

interface Opened {
  readonly doc: PptDocument
  readonly pictures: Uint8Array | null
}

type OpenResult = { ok: true; value: Opened } | { ok: false; encrypted: boolean }

function open(file: CfbFile): OpenResult {
  const stream = file.stream('PowerPoint Document')
  const persist = stream === null ? null : readPersist(stream, file.stream('Current User'))
  if (persist === null) return { ok: false, encrypted: false }
  if (persist.kind === 'encrypted') return { ok: false, encrypted: true }
  const doc = readDocument(persist.document, persist.object)
  return { ok: true, value: { doc, pictures: file.stream('Pictures') } }
}

function pictureIndex(part: string): number {
  return part.startsWith(PICTURES) ? Number(part.slice(PICTURES.length)) : 0
}

function scheme(container: ArtRecord): Color[] | null {
  const atom = child(container, RT.COLOR_SCHEME_ATOM, 1)
  if (atom === null || atom.data.length < 32) return null
  return Array.from({ length: 8 }, (_, i) => ({
    r: atom.data[i * 4]! / 255,
    g: atom.data[i * 4 + 1]! / 255,
    b: atom.data[i * 4 + 2]! / 255,
    a: 1,
  }))
}

interface SlideInfo {
  readonly masterId: number
  readonly flags: number
}

/** SlideAtom：第 12 字节起为 `masterIdRef`，第 20 字节起为 `slideFlags`。 */
function slideInfo(container: ArtRecord): SlideInfo {
  const f = new Fields(child(container, RT.SLIDE_ATOM)?.data ?? new Uint8Array(0))
  return { masterId: f.u32(12), flags: f.u16(20) }
}

function drawing(container: ArtRecord): Uint8Array | null {
  return child(container, RT.DRAWING)?.data ?? null
}

function shapesOf(container: ArtRecord): ArtShape[] {
  const data = drawing(container)
  return data === null ? [] : readDrawingShapes(data)
}

/** 容器的背景形状与其 metroBlob 的键；没有背景形状时为 `null`。 */
function backgroundOf(
  entry: SlideEntry | null,
  kind: 'slide' | 'master',
): { shape: ArtShape; key: string } | null {
  const data = entry === null ? null : drawing(entry.container)
  const shape = data === null ? null : readDrawingBackground(data)
  return entry === null || shape === null
    ? null
    : { shape, key: `${kind}/${entry.slideId}/${shape.id}` }
}

/** 幻灯片与母版容器，按部件名。 */
function containersOf(doc: PptDocument): Map<string, ArtRecord> {
  return new Map([
    ...doc.slides.map((e) => [`slide/${e.slideId}`, e.container] as const),
    ...[...doc.masters.values()].map((m) => [`master/${m.slideId}`, m.container] as const),
  ])
}

function isPlaceholder(s: ArtShape): boolean {
  return (
    s.clientData !== null &&
    readArtRecords(s.clientData).some((r) => r.type === RT.PLACEHOLDER_ATOM)
  )
}

function addCounts(target: UnsupportedCounts, kinds: readonly UnsupportedKind[]): void {
  for (const k of kinds) target[k] = (target[k] ?? 0) + 1
}

/** 全部幻灯片共用的数据：图片库与母版形状。 */
interface Shared {
  readonly doc: PptDocument
  readonly blips: readonly (Blip | null)[]
  readonly drawable: readonly boolean[]
  readonly patterns: readonly (string | null)[]
  readonly masterShapes: ReadonlyMap<number, ArtShape>
  readonly metro: MetroContents
  /** 按母版的 `slideId`。 */
  readonly metroMasters: ReadonlyMap<number, MetroMaster>
}

function readSlide(shared: Shared, entry: SlideEntry, index: number, used: Set<number>): Slide {
  const { doc } = shared
  const info = slideInfo(entry.container)
  const master = doc.masters.get(info.masterId) ?? null
  const masterInfo = master === null ? null : slideInfo(master.container)
  const main =
    master !== null && masterInfo !== null && master.container.type === RT.SLIDE
      ? (doc.masters.get(masterInfo.masterId) ?? null)
      : null
  const colors =
    (info.flags & FLAG_MASTER_SCHEME ? null : scheme(entry.container)) ??
    (master === null ? null : scheme(master.container)) ??
    []
  const found: UnsupportedKind[] = []
  const textMaster = main ?? master
  const metroMaster =
    (textMaster === null ? undefined : shared.metroMasters.get(textMaster.slideId)) ??
    NO_METRO_MASTER
  const metroSlide = metroScope(
    metroMaster,
    shared.metro.images,
    documentTextStyle(doc.text, colors),
    found,
  )
  const resolver = new ShapeResolver(metroSlide)
  const style = (background: ShapeFill): ArtStyleContext => ({
    scheme: colors,
    picture: (pib) => {
      if ((shared.blips[pib - 1] ?? null) === null) return null
      used.add(pib)
      return `${PICTURES}${pib}`
    },
    pattern: (pib) => shared.patterns[pib - 1] ?? null,
    background,
    found,
  })
  const scope = (background: ShapeFill): DrawingScope => ({
    masterShapes: shared.masterShapes,
    style: style(background),
    imageDrawable: (part) => shared.drawable[pictureIndex(part) - 1] ?? null,
    externals: doc.externals,
    text: {
      defaults: doc.text,
      master: textMaster === null ? new Map() : readMasterStyles(textMaster.container),
      scheme: colors,
      slideNumber: doc.firstSlideNumber + index,
      hyperlinks: doc.hyperlinks,
      found,
      drawingml: metroMaster.part.textStyles === null ? null : resolver,
      date: genericDate(child(entry.container, HEADERS_FOOTERS) ?? doc.headersFooters),
    },
    found,
    metro: shared.metro.shapes,
    resolver,
  })
  const bg =
    info.flags & FLAG_MASTER_BACKGROUND
      ? (backgroundOf(master, 'master') ?? backgroundOf(main, 'master'))
      : backgroundOf(entry, 'slide')
  const bgMetro = bg === null ? undefined : shared.metro.shapes.get(bg.key)
  const bgFill =
    bgMetro?.kind === 'background'
      ? resolveBackground(bgMetro.background, metroSlide)
      : bg === null
        ? NONE
        : artFill(shapeProperties(bg.shape, scope(NONE)), style(NONE))
  const shapeScope = scope(bgFill)
  const decorations = (m: SlideEntry | null): Shape[] =>
    m === null
      ? []
      : new DrawingConverter(
          shapeScope,
          'master',
          `master/${m.slideId}`,
          outlineGroups(m.texts),
        ).convert(shapesOf(m.container).filter((s) => !isPlaceholder(s)))
  const shapes: Shape[] = []
  if (info.flags & FLAG_MASTER_OBJECTS) {
    if (masterInfo !== null && masterInfo.flags & FLAG_MASTER_OBJECTS) {
      shapes.push(...decorations(main))
    }
    shapes.push(...decorations(master))
  }
  shapes.push(
    ...new DrawingConverter(
      shapeScope,
      'slide',
      `slide/${entry.slideId}`,
      outlineGroups(entry.texts),
    ).convert(shapesOf(entry.container)),
  )
  const transition = new Fields(
    child(entry.container, RT.SLIDE_SHOW_SLIDE_INFO_ATOM)?.data ?? new Uint8Array(0),
  )
  if (transition.u8(8) !== 0 || transition.u8(9) !== 0) found.push('transition')
  const unsupported: UnsupportedCounts = {}
  addCounts(unsupported, found)
  const masterPart = master === null ? '' : `master/${master.slideId}`
  return {
    part: `slide/${entry.slideId}`,
    number: doc.firstSlideNumber + index,
    hidden: false,
    layout: masterPart,
    master: masterPart,
    background: bgFill.kind === 'none' ? null : bgFill,
    shapes,
    unsupported,
  }
}

export async function parsePpt(file: CfbFile): Promise<PptxResult> {
  const opened = open(file)
  if (!opened.ok) {
    return {
      ok: false,
      failure: opened.encrypted ? { kind: 'encrypted' } : { kind: 'corrupt', reason: 'ppt' },
    }
  }
  const { doc, pictures } = opened.value
  const blips = await readBlipStore(doc.drawingGroup, pictures)
  const masterShapes = new Map<number, ArtShape>()
  for (const m of doc.masters.values()) {
    for (const s of flattenShapes(shapesOf(m.container))) masterShapes.set(s.id, s)
  }
  const metro: MetroContents = { shapes: new Map(), images: new Map() }
  for (const [part, container] of containersOf(doc)) {
    const data = drawing(container)
    if (data !== null) await readMetroShapes(data, part, metro)
  }
  const metroMasters = new Map<number, MetroMaster>()
  for (const m of doc.masters.values()) {
    metroMasters.set(m.slideId, await readMetroMaster(m.container, `master/${m.slideId}`, metro))
  }
  const shared: Shared = {
    doc,
    blips,
    drawable: blips.map((b) => b !== null && drawableImage(b.contentType, b.bytes)),
    patterns: await Promise.all(
      blips.map(async (b) => {
        const rows = b === null ? null : await patternRows(b)
        return rows === null ? null : patternName(rows)
      }),
    ),
    masterShapes,
    metro,
    metroMasters,
  }
  const used = new Set<number>()
  const slides = doc.slides.map((entry, index) => readSlide(shared, entry, index, used))
  const total: UnsupportedCounts = {}
  for (const s of slides) {
    for (const [k, n] of Object.entries(s.unsupported) as [UnsupportedKind, number][]) {
      total[k] = (total[k] ?? 0) + n
    }
  }
  const metafileFonts = new Set<string>()
  for (const pib of used) {
    const b = blips[pib - 1] ?? null
    const mf = b === null ? null : readMetafile(b.bytes)
    if (mf !== null && mf.unsupported.length === 0) for (const f of mf.fonts) metafileFonts.add(f)
  }
  return {
    ok: true,
    value: {
      width: doc.width,
      height: doc.height,
      firstSlideNumber: doc.firstSlideNumber,
      embeddedFonts: [],
      masters: [...doc.masters.values()].map((m) => `master/${m.slideId}`),
      slides,
      unsupported: total,
      metafileFonts: [...metafileFonts],
    },
  }
}

/** 按部件名读取图片（`Pictures/<pib>` 与 metroBlob 中的部件）；文件无法打开或图片不可读取的项不在结果中。 */
export async function readPptImages(
  file: CfbFile,
  parts: readonly string[],
): Promise<Map<string, ImagePart>> {
  const out = new Map<string, ImagePart>()
  const opened = open(file)
  if (!opened.ok) return out
  const store = openBlipStore(opened.value.doc.drawingGroup, opened.value.pictures)
  const containers = containersOf(opened.value.doc)
  for (const part of parts) {
    const image = part.startsWith(PICTURES)
      ? await store.read(pictureIndex(part))
      : await readMetroImage(part, containers)
    if (image !== null) out.set(part, { bytes: image.bytes, contentType: image.contentType })
  }
  return out
}
