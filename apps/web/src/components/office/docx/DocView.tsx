/**
 * Word 预览：取得文件字节，在 Worker 中解析；取得字体后在 Worker 中排版与分页，按顺序纵向排列页面，只绘制可见的页面。
 * 滚动、缩放与按可见区域绘制见 `page-viewport.ts`；加载、改写后重新加载与失败文案见 `../document.ts`。
 *
 * - 重新加载完成后保留滚动位置与缩放比例。存在未显示的内容时显示一行能力边界，计数为整个文件之和；未绘制的公式取自
 *   分页结果（`Page.hiddenMath`），其余取自解析结果。
 * - Worker 只在解析与分页期间存在：分页结果为纯数据，图片字节随结果转交主线程。
 * - 字体：主机字体经 `../fonts.ts` 取得，同一份字节交给 Worker 排版、在主线程读取绘制度量。分页结果以文档中的字体名引用字形，
 *   绘制前换算为注册时的族名：文档以另一个名称引用已注册的字体时（如 `SimSun` 与 `宋体`），注册的族名是首次注册时的名称。
 * - 缺少字体与缺字时使用宋体；主机没有宋体时取文档字体中主机已有的第一个。主机字体的族名在解析前取得（`loadHostFamilies`），
 *   Worker 据此为主机没有的字体名做前缀匹配。
 * - 文档的嵌入字体（主机没有其字体名的项）随解析结果取得，每次加载以新的族名注册，与主机字体一同排版；文档被替换、加载失败
 *   或组件卸载时从 `document.fonts` 删除：不同文件嵌入同名字体的不同子集时，族名相同会使绘制取到另一份字形。
 * - 主机显示器的 ClearType 设置随文档一同取得（`loadClearType`）：不为 `null` 时平滑字号的文字以 ClearType 字形写入画布像素，
 *   画布按频繁读取像素创建。
 * - 图片在页面首次进入可见区域时解码，按下标缓存到文档被替换为止。
 *
 * 默认导出供 `lazy()` 使用：解析与绘制代码只在打开文档时下载。
 */

import {
  type DocumentPages,
  type DocxFace,
  type FaceRef,
  loadDocxFace,
  type PageClearType,
  type PageFonts,
  pageImages,
  paintPage,
  type UnsupportedCounts,
  type UnsupportedKind,
} from '@qywork/ooxml/docx'
import {
  type CreateCanvas,
  decodePicture,
  type ImageDecoder,
  type PaintCanvas,
  type PaintPicture,
} from '@qywork/ooxml/drawingml'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { boundaryText, connectWorker, createDocumentLoader, failureText } from '../document.ts'
import {
  type HostFace,
  loadClearType,
  loadHostFaces,
  loadHostFamilies,
  registerFace,
} from '../fonts.ts'
import type { ViewPosition } from '../viewport.ts'
import type { DocxReplies, DocxRequest } from './docx-worker.ts'
import { createPageViewport, type PageViewport } from './page-viewport.ts'

type BoundaryKind = Exclude<UnsupportedKind, 'imageFormat' | 'vml'> | 'math'

/**
 * 能力边界中各种类的名称，按此顺序列出。无法绘制的图片格式（`imageFormat`）计入「图片」，无法转换的 VML（`vml`）
 * 计入「其他对象」：同一名称只列一次。
 */
const UNSUPPORTED_LABEL: Record<BoundaryKind, string> = {
  picture: '图片',
  chart: '图表',
  smartArt: 'SmartArt',
  shape: '形状',
  group: '组合',
  canvas: '绘图画布',
  drawing: '其他对象',
  ole: '嵌入对象',
  math: '公式',
  contentPart: '墨迹',
  effect: '其他效果',
  frame: '图文框',
  floatingTable: '浮动表格',
  altChunk: '外部内容',
  subDocument: '子文档',
  footnote: '脚注',
  endnote: '尾注',
  comment: '批注',
  revision: '修订',
  dynamicField: '域',
  columns: '分栏',
  textDirection: '文字方向',
  lineNumbers: '行号',
  charGrid: '字符网格',
  artBorder: '艺术型页面边框',
  numberFormat: '编号格式',
  nesting: '嵌套过深的内容',
  decimalTab: '小数点对齐制表位',
  barTab: '竖线对齐制表位',
  ptab: '对齐方式选项卡',
  characterScale: '字符缩放',
  emphasisMark: '着重号',
  smallCaps: '小型大写字母',
  eastAsianLayout: '中文版式',
  fitText: '调整宽度',
  rtl: '从右向左',
  ruby: '拼音指南',
  softHyphen: '可选连字符',
}

const FALLBACK = '宋体'

interface Doc {
  readonly pages: DocumentPages
  readonly fonts: PageFonts
  readonly unsupported: UnsupportedCounts
  /** 主机显示器的 ClearType 设置；为 `null` 时平滑字号以浏览器字体绘制。 */
  readonly clearType: PageClearType['display'] | null
  /** 与 `pages.images` 对应的图片部件名。 */
  readonly parts: readonly string[]
  /** 已解码的图片；尚未解码与无法解码的为 `null`。 */
  readonly images: (PaintPicture | null)[]
  /** 已开始解码的图片下标与其完成；无法解码时同样完成。 */
  readonly decoding: Map<number, Promise<void>>
  /** 解码已完成（含无法解码）的图片下标。 */
  readonly decoded: Set<number>
  /** 删除本次注册的嵌入字体。 */
  readonly dispose: () => void
}

/** 嵌入字体族名的序号，使每次注册的族名不同。 */
let embeddedSerial = 0

/** 字体的绘制度量，按字体缓存；字体表不完整时为 `null`，按主机上没有该字体处理（Worker 中同样跳过）。 */
const docxFaces = new WeakMap<HostFace, DocxFace | null>()

function docxFace(host: HostFace): DocxFace | null {
  let face = docxFaces.get(host)
  if (face === undefined) {
    try {
      face = loadDocxFace(host.bytes, host.family)
    } catch {
      face = null
    }
    docxFaces.set(host, face)
  }
  return face
}

/** 分页结果中的字形换算为注册的族名，绘制时按族名与字形取得度量。 */
function pageFonts(
  host: ReadonlyMap<string, readonly HostFace[]>,
  refs: readonly FaceRef[],
): PageFonts {
  const byFace = new Map<string, DocxFace>()
  const key = (family: string, bold: boolean, italic: boolean) =>
    `${family}\u0000${bold}\u0000${italic}`
  const faces = refs.map((ref) => {
    for (const h of host.get(ref.family) ?? []) {
      const face = docxFace(h)
      if (face === null || face.bold !== ref.bold || face.italic !== ref.italic) continue
      byFace.set(key(face.family, face.bold, face.italic), face)
      return { ...ref, family: face.family }
    }
    return ref
  })
  return { faces, draw: (ref) => byFace.get(key(ref.family, ref.bold, ref.italic)) ?? null }
}

/**
 * 绘制所需的图层。DOM 类型中 `createPattern` 的参数为 `CanvasImageSource`，与 `@qywork/ooxml` 声明的 Canvas 子集
 * 无法互相赋值，此处按结构转换；运行时接口相同。
 */
const createCanvas: CreateCanvas = (width, height) =>
  new OffscreenCanvas(Math.max(1, width), Math.max(1, height)) as unknown as PaintCanvas

const imageDecoder: ImageDecoder = {
  file: (bytes, type) => createImageBitmap(new Blob([bytes], { type })),
  pixels: (width, height, data) => createImageBitmap(new ImageData(data, width, height)),
}

/** 解码第 `i` 张图片；同一张只解码一次。 */
function decode(d: Doc, i: number): Promise<void> {
  let done = d.decoding.get(i)
  if (!done) {
    const source = d.pages.images[i]!
    done = decodePicture(source.bytes, source.contentType, imageDecoder).then((picture) => {
      d.images[i] = picture
      d.decoded.add(i)
    })
    d.decoding.set(i, done)
  }
  return done
}

async function loadDoc(bytes: ArrayBuffer, signal: AbortSignal): Promise<Doc | string> {
  const channel = connectWorker<DocxRequest, DocxReplies>(
    new Worker(new URL('./docx-worker.ts', import.meta.url), { type: 'module' }),
  )
  const embedded: FontFace[] = []
  const dispose = () => {
    for (const face of embedded) document.fonts.delete(face)
  }
  signal.addEventListener('abort', () => channel.close(), { once: true })
  try {
    const hostFamilies = await loadHostFamilies()
    const parsed = await channel.request({ kind: 'parse', bytes, host: hostFamilies }, [bytes])
    if (!parsed.ok) return failureText(parsed.failure)
    const [loaded, clearType] = await Promise.all([
      loadHostFaces([...parsed.fonts, FALLBACK]),
      loadClearType(),
    ])
    const host = new Map(loaded)
    for (const f of parsed.embedded) {
      const family = `${f.family} ${++embeddedSerial}`
      const bytes = f.bytes as Uint8Array<ArrayBuffer>
      const face = await registerFace(family, bytes, f.bold, f.italic).catch(() => null)
      if (!face) continue
      embedded.push(face)
      const list = host.get(f.family) ?? []
      host.set(f.family, [...list, { family, bold: f.bold, italic: f.italic, bytes }])
    }
    const files: HostFace[] = []
    const families: [string, number[]][] = []
    for (const [name, list] of host) {
      const indexes: number[] = []
      for (const h of list) {
        if (docxFace(h) === null) continue
        if (!files.includes(h)) files.push(h)
        indexes.push(files.indexOf(h))
      }
      families.push([name, indexes])
    }
    const fallback = [FALLBACK, ...parsed.fonts].find((name) =>
      families.some(([n, indexes]) => n === name && indexes.length > 0),
    )
    if (fallback === undefined) throw new Error('主机上没有可用于排版的字体')
    // 字体字节以复制方式发送：主线程保留同一份字节，供以后的文档使用。
    const pages = await channel.request({
      kind: 'layout',
      files: files.map((h) => h.bytes),
      families,
      fallback,
    })
    return {
      pages,
      fonts: pageFonts(host, pages.faces),
      unsupported: parsed.unsupported,
      clearType,
      parts: pages.images.map((im) => im.part),
      images: pages.images.map(() => null),
      decoding: new Map(),
      decoded: new Set(),
      dispose,
    }
  } catch (e) {
    dispose()
    throw e
  } finally {
    channel.close()
  }
}

export default function DocView(props: { path: string; mtime: number }) {
  const [doc, setDoc] = createSignal<Doc | null>(null)

  let scroller!: HTMLDivElement
  let extent!: HTMLDivElement
  let viewport: PageViewport | null = null

  /** 第 `index` 页的图片都已解码；否则解码尚未开始解码的图片，完成后重绘该页。 */
  const prepare = (index: number): boolean => {
    const d = doc()
    const page = d?.pages.pages[index]
    if (!d || !page) return false
    const needed = pageImages(page, d.parts)
    if (needed.every((i) => d.decoded.has(i))) return true
    void Promise.all(needed.map((i) => decode(d, i))).then(() => {
      if (doc() === d) viewport?.repaint(index)
    })
    return false
  }

  const paint = (index: number, canvas: HTMLCanvasElement, scale: number) => {
    const d = doc()
    const page = d?.pages.pages[index]
    // 不透明画布：ClearType 字形按底色混合；以 `fillText` 绘制的文字（主机不使用 ClearType、CFF 字体）在不透明画布上
    // 为子像素抗锯齿，透明画布只用灰度抗锯齿。`paintPage` 先铺满白底，不需要透明。ClearType 字形读写画布像素。
    const ctx = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: (d?.clearType ?? null) !== null,
    }) as PageClearType['target'] | null
    if (!d || !page || !ctx) return
    paintPage(
      ctx,
      page,
      d.fonts,
      { images: d.images, parts: d.parts, createCanvas },
      scale,
      d.clearType === null ? null : { display: d.clearType, target: ctx },
    )
  }

  /** 下一次显示时的位置：改写后重新加载时为原位置，首次显示时为 `null`。 */
  let nextPosition: ViewPosition | null = null

  const showDoc = (next: Doc) => {
    nextPosition = viewport?.position() ?? null
    const previous = doc()
    setDoc(next)
    previous?.dispose()
  }

  const error = createDocumentLoader(() => props, loadDoc, showDoc)

  createEffect(
    on(doc, (d) => {
      if (!d) return
      viewport ??= createPageViewport({ scroller, extent }, { prepare, paint })
      viewport.show(d.pages.pages, nextPosition)
      nextPosition = null
    }),
  )

  onCleanup(() => {
    viewport?.destroy()
    doc()?.dispose()
  })

  const boundary = () => {
    const d = doc()
    if (!d) return null
    const u = d.unsupported
    const math = d.pages.pages.reduce((n, p) => n + p.hiddenMath, 0)
    return boundaryText<BoundaryKind>(
      {
        ...u,
        picture: (u.picture ?? 0) + (u.imageFormat ?? 0),
        drawing: (u.drawing ?? 0) + (u.vml ?? 0),
        math,
      },
      UNSUPPORTED_LABEL,
    )
  }

  const ready = () => doc() !== null && error() === null

  return (
    <div class="doc-view">
      <Show when={error()}>{(msg) => <div class="preview-note">{msg()}</div>}</Show>
      <Show when={!doc() && !error()}>
        <div class="preview-loading" />
      </Show>
      <div class="doc-scroll" ref={scroller} hidden={!ready()}>
        <div class="doc-extent" ref={extent} />
      </div>
      <Show when={ready() && boundary()}>
        {(text) => <div class="office-boundary">{text()}</div>}
      </Show>
    </div>
  )
}
