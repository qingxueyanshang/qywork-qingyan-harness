/**
 * PPT 预览：取得文件字节，在 Worker 中解析，取得字体后按顺序纵向排列幻灯片，只绘制可见的幻灯片。
 * 滚动、缩放与按可见区域绘制见 `slide-viewport.ts`；加载、改写后重新加载与失败文案见 `../document.ts`。
 *
 * - 重新加载完成后保留滚动位置与缩放比例。存在未显示的内容时显示一行能力边界，计数为整个文件之和。
 * - Worker 在文档显示期间保留，嵌入字体与图片从中读取；文档被替换、加载失败或组件卸载时结束。
 * - 字体：主机字体经 `../fonts.ts` 取得后即显示，主机没有的字体先按替代规则绘制（`FaceCache`：西文为 Segoe Print，
 *   其余为缺少字体时的字体）。文件中的嵌入字体在显示后逐个还原，每注册一个即重绘用到它的可见幻灯片。
 * - 嵌入字体每次加载以新的族名注册，文档被替换或卸载时从 `document.fonts` 删除，尚未完成的还原结果丢弃：
 *   不同文件嵌入同名字体的不同子集时，族名相同会使绘制取到另一份字形。
 * - 缺少字体与缺字时使用宋体；主机没有宋体时取文档字体中主机已有的第一个。
 * - 图片在幻灯片首次进入可见区域时读取并解码，按部件缓存到文档被替换为止。
 *
 * 默认导出供 `lazy()` 使用：解析与绘制代码只在打开演示文稿时下载。
 */

import type { CreateCanvas, PaintCanvas, PaintContext, PaintImage } from '@qywork/ooxml/drawingml'
import { readFaces, readMetrics, readVerticalMetrics } from '@qywork/ooxml/font'
import {
  type EmbeddedFont,
  type Presentation,
  paintSlide,
  presentationFonts,
  type SlideFont,
  type SlideFontSource,
  slideImages,
  type UnsupportedKind,
} from '@qywork/ooxml/pptx'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import {
  boundaryText,
  connectWorker,
  createDocumentLoader,
  failureText,
  type WorkerChannel,
} from '../document.ts'
import { type HostFace, loadHostFaces, registerFace } from '../fonts.ts'
import type { ViewPosition } from '../viewport.ts'
import type { PptxReplies, PptxRequest } from './pptx-worker.ts'
import { createSlideViewport, type SlideViewport } from './slide-viewport.ts'

/** 能力边界中各种类的名称，按此顺序列出。 */
const UNSUPPORTED_LABEL: Record<UnsupportedKind, string> = {
  chart: '图表',
  smartArt: 'SmartArt',
  ole: '嵌入对象',
  graphic: '其他对象',
  media: '音视频',
  ink: '墨迹',
  imageFormat: '图片',
  pictureBullet: '图片项目符号',
  verticalText: '竖排文字',
  textWarp: '文字变形',
  tableStyle: '表格样式',
  effect3d: '三维效果',
  imageEffect: '图片效果',
  effect: '其他效果',
  animation: '动画',
  transition: '切换效果',
}

const FALLBACK = '宋体'
const EMU_PER_PX = 9525

interface Doc {
  readonly presentation: Presentation
  /** 主机字体与已注册的嵌入字体；嵌入字体注册后，此后的绘制即取到它。 */
  readonly fonts: SlideFontSource
  readonly channel: WorkerChannel<PptxRequest, PptxReplies>
  /** 已解码的图片部件；无法解码的为 `null`。 */
  readonly images: Map<string, PaintImage | null>
  /** 正在读取的图片部件。 */
  readonly reading: Map<string, Promise<void>>
  /**
   * 按文件中的顺序逐个还原主机没有的嵌入字体，每注册一个调用 `onFont(字体名)`。只调用一次。
   * 无法还原或无法注册的字体保持替代字体；`dispose` 之后到达的结果丢弃。
   */
  readonly restoreFonts: (onFont: (typeface: string) => void) => Promise<void>
  /** 结束 Worker，删除本次注册的嵌入字体。 */
  readonly dispose: () => void
}

/** 字体的排版度量，按字体缓存；字体表不完整时为 `null`，按主机上没有该字体处理。 */
const slideFonts = new WeakMap<HostFace, SlideFont | null>()

function slideFont(host: HostFace): SlideFont | null {
  let font = slideFonts.get(host)
  if (font === undefined) {
    try {
      const sfnt = readFaces(host.bytes)[0]
      font = sfnt
        ? {
            face: {
              metrics: readMetrics(host.bytes, sfnt),
              vertical: readVerticalMetrics(host.bytes, sfnt),
            },
            family: host.family,
            bold: host.bold,
            italic: host.italic,
          }
        : null
    } catch {
      font = null
    }
    slideFonts.set(host, font)
  }
  return font
}

function pick(list: readonly SlideFont[], bold: boolean, italic: boolean): SlideFont | null {
  return (
    list.find((f) => f.bold === bold && f.italic === italic) ??
    list.find((f) => f.bold === bold) ??
    list.find((f) => !f.bold && !f.italic) ??
    list[0] ??
    null
  )
}

/** 第 `index` 张幻灯片用到的字体名：按只含该幻灯片的演示文稿求 `presentationFonts`。 */
function slideFontNames(p: Presentation, index: number): string[] {
  return presentationFonts({ ...p, slides: p.slides.slice(index, index + 1) })
}

/** 嵌入字体族名的序号，使每次注册的族名不同。 */
let embeddedSerial = 0

/**
 * 绘制所需的图层。DOM 类型中 `createPattern` 的参数为 `CanvasImageSource`，与 `@qywork/ooxml` 声明的 Canvas 子集
 * 无法互相赋值，此处按结构转换；运行时接口相同。
 */
const createCanvas: CreateCanvas = (width, height) =>
  new OffscreenCanvas(Math.max(1, width), Math.max(1, height)) as unknown as PaintCanvas

async function loadDoc(bytes: ArrayBuffer, signal: AbortSignal): Promise<Doc | string> {
  const channel = connectWorker<PptxRequest, PptxReplies>(
    new Worker(new URL('./pptx-worker.ts', import.meta.url), { type: 'module' }),
  )
  const embedded: FontFace[] = []
  let ended = false
  const dispose = () => {
    ended = true
    channel.close()
    for (const face of embedded) document.fonts.delete(face)
  }
  signal.addEventListener('abort', dispose, { once: true })
  try {
    const parsed = await channel.request({ kind: 'parse', bytes }, [bytes])
    if (!parsed.ok) {
      dispose()
      return failureText(parsed.failure)
    }
    const presentation = parsed.value
    const host = await loadHostFaces([...presentationFonts(presentation), FALLBACK])
    const fonts = new Map<string, SlideFont[]>()
    for (const [name, list] of host) {
      fonts.set(
        name,
        list.map(slideFont).filter((f) => f !== null),
      )
    }
    const fallback =
      pick(fonts.get(FALLBACK) ?? [], false, false) ??
      [...fonts.values()].map((list) => pick(list, false, false)).find((f) => f !== null)
    if (!fallback) throw new Error('主机上没有可用于排版的字体')
    const missing = presentation.embeddedFonts.filter((f) => !fonts.get(f.typeface)?.length)
    const request = (f: EmbeddedFont | undefined) =>
      f ? channel.request({ kind: 'font', font: f }).catch(() => null) : null
    // 收到一个字体后先请求下一个再注册：Worker 在主线程注册期间继续还原，且任一时刻只有一个字体请求未回复，
    // 之后发出的图片请求最多等待一个字体的解码。
    const restoreFonts = async (onFont: (typeface: string) => void) => {
      let next = request(missing[0])
      for (const [i, f] of missing.entries()) {
        const file = await next
        if (ended) return
        next = request(missing[i + 1])
        if (!file) continue
        const family = `${f.typeface} ${++embeddedSerial}`
        const bytes = file.bytes as Uint8Array<ArrayBuffer>
        const face = await registerFace(family, bytes, f.bold, f.italic).catch(() => null)
        if (!face) continue
        if (ended) {
          document.fonts.delete(face)
          return
        }
        embedded.push(face)
        const font = slideFont({ family, bold: f.bold, italic: f.italic, bytes })
        if (!font) continue
        fonts.set(f.typeface, [...(fonts.get(f.typeface) ?? []), font])
        onFont(f.typeface)
      }
    }
    signal.removeEventListener('abort', dispose)
    return {
      presentation,
      fonts: { face: (name, bold, italic) => pick(fonts.get(name) ?? [], bold, italic), fallback },
      channel,
      images: new Map(),
      reading: new Map(),
      restoreFonts,
      dispose,
    }
  } catch (e) {
    dispose()
    throw e
  }
}

export default function SlideView(props: { path: string; mtime: number }) {
  const [doc, setDoc] = createSignal<Doc | null>(null)

  let scroller!: HTMLDivElement
  let extent!: HTMLDivElement
  let viewport: SlideViewport | null = null

  /** 第 `index` 张幻灯片的图片都已解码；否则读取尚未读取的部件，完成后重绘该幻灯片。 */
  const prepare = (index: number): boolean => {
    const d = doc()
    const slide = d?.presentation.slides[index]
    if (!d || !slide) return false
    const parts = slideImages(slide)
    if (parts.every((part) => d.images.has(part))) return true
    const unread = parts.filter((part) => !d.images.has(part) && !d.reading.has(part))
    if (unread.length > 0) {
      const done = d.channel.request({ kind: 'images', parts: unread }).then(
        async (found) => {
          const decoded = new Map<string, PaintImage | null>()
          await Promise.all(
            found.map(async ([part, img]) => {
              const blob = new Blob([img.bytes as Uint8Array<ArrayBuffer>], {
                type: img.contentType,
              })
              decoded.set(part, await createImageBitmap(blob).catch(() => null))
            }),
          )
          for (const part of unread) d.images.set(part, decoded.get(part) ?? null)
        },
        () => {
          for (const part of unread) d.images.set(part, null)
        },
      )
      for (const part of unread) d.reading.set(part, done)
    }
    void Promise.all(parts.map((part) => d.reading.get(part))).then(() => {
      if (doc() === d) viewport?.repaint(index)
    })
    return false
  }

  const paint = (index: number, canvas: HTMLCanvasElement) => {
    const d = doc()
    const slide = d?.presentation.slides[index]
    const ctx = canvas.getContext('2d') as PaintContext | null
    if (!d || !slide || !ctx) return
    const scale = canvas.width / (d.presentation.width / EMU_PER_PX)
    paintSlide(
      ctx,
      d.presentation,
      slide,
      { fonts: d.fonts, image: (part) => d.images.get(part) ?? null, createCanvas },
      scale,
    )
  }

  /** 下一次显示时的位置：改写后重新加载时为原位置，首次显示时为 `null`。 */
  let nextPosition: ViewPosition | null = null

  const showDoc = (next: Doc) => {
    const previous = doc()
    nextPosition = viewport?.position() ?? null
    setDoc(next)
    previous?.dispose()
  }

  const error = createDocumentLoader(() => props, loadDoc, showDoc)

  /** 嵌入字体 `typeface` 注册后，重绘用到它的幻灯片；视口只重绘其中可见的。 */
  const repaintUsing = (d: Doc, typeface: string) => {
    if (doc() !== d) return
    d.presentation.slides.forEach((_, index) => {
      if (slideFontNames(d.presentation, index).includes(typeface)) viewport?.repaint(index)
    })
  }

  createEffect(
    on(doc, (d) => {
      if (!d) return
      viewport ??= createSlideViewport({ scroller, extent }, { prepare, paint })
      const { width, height } = d.presentation
      viewport.show({ count: d.presentation.slides.length, aspect: height / width }, nextPosition)
      nextPosition = null
      // 在视口处理第一帧之后开始还原：视口的帧回调先于此回调注册，可见幻灯片的图片请求先于字体请求到达 Worker；
      // Worker 按到达顺序处理，首次绘制不等待字体解码。
      requestAnimationFrame(() => {
        if (doc() === d) void d.restoreFonts((typeface) => repaintUsing(d, typeface))
      })
    }),
  )

  onCleanup(() => {
    viewport?.destroy()
    doc()?.dispose()
  })

  const boundary = () => {
    const d = doc()
    return d ? boundaryText(d.presentation.unsupported, UNSUPPORTED_LABEL) : null
  }

  const ready = () => doc() !== null && error() === null

  return (
    <div class="slide-view">
      <Show when={error()}>{(msg) => <div class="preview-note">{msg()}</div>}</Show>
      <Show when={!doc() && !error()}>
        <div class="preview-loading" />
      </Show>
      <div class="slide-scroll" ref={scroller} hidden={!ready()}>
        <div class="slide-extent" ref={extent} />
      </div>
      <Show when={ready() && boundary()}>
        {(text) => <div class="office-boundary">{text()}</div>}
      </Show>
    </div>
  )
}
