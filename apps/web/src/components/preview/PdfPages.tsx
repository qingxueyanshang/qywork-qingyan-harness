/**
 * PDF 的页面视图：pdf.js 在 Worker 中解析，按页绘制到画布，所有客户端相同。不交给系统组件显示：手机浏览器不在页面中完整显示
 * 嵌入的 PDF（iOS Safari 只显示第一页，Android Chrome 不显示），Linux 的系统网页组件没有 PDF 阅读器。
 *
 * - 每页的文字层（pdf.js 的 `TextLayer`）放置与字形重合的透明文字，用于选择与复制。
 * - 文件分段读取，见 `pdf-source.ts`。读取失败时显示读取失败。
 * - 页面排列、缩放与按可见区域绘制见 `../office/docx/page-viewport.ts`。页面尺寸以磅为单位，与 PDF 用户空间的单位相同。
 * - 取得某页之前按第一页的尺寸排列；取得的页面尺寸不同时重新排列，内容坐标中的位置不变。
 * - pdf.js 的绘制是异步的：先绘制到离屏画布，完成后复制到视口的画布。缩放后重新绘制期间显示拉伸的上一份结果，不出现空白页。
 *   离屏画布按像素总量 `KEEP_PIXELS` 保留最近绘制的页面。
 * - 路径或修改时间变化时重新打开，新文档就绪之前保留上一份；同一路径重新打开时保留位置。
 *
 * 默认导出供 `lazy()` 使用：pdf.js 只在打开 PDF 时下载。
 */

import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  TextLayer,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import { rawFilePath } from '../../lib/client.ts'
import { client } from '../../lib/store/index.ts'
import {
  createPageViewport,
  type PageSize,
  type PageViewport,
} from '../office/docx/page-viewport.ts'
import type { ViewPosition } from '../office/viewport.ts'
import { officeZoom } from '../office/zoom.tsx'
import { pdfSource, rangeReader } from './pdf-source.ts'
import { readView, writeView } from './view-state.ts'

/** pdf.js 的字符映射表、标准字体与解码模块的目录（`vite.config.ts` 的 `pdfjsData`）。 */
declare const __PDFJS_DATA__: string

GlobalWorkerOptions.workerSrc = workerSrc

/**
 * 分段读取的块大小（字节）。远程访问时每次读取约需一个往返，块过小时显示一页需要多次往返；
 * 256 KB 约为手机网络 2.5 Mbps、往返 0.5 秒时一个往返能传输的数据量。
 */
const RANGE_CHUNK = 256 * 1024

/** 保留的离屏画布的像素总量：约 96 MB。iOS Safari 的画布内存总量有上限，超出后新画布无法绘制。 */
const KEEP_PIXELS = 24 * 1024 * 1024

interface Opened {
  readonly path: string
  readonly task: PDFDocumentLoadingTask
  readonly doc: PDFDocumentProxy
  readonly sizes: PageSize[]
  readonly pages: Map<number, PDFPageProxy>
  readonly loading: Set<number>
  /** 每页最近一次绘制完成的离屏画布，按绘制完成的先后排列。 */
  readonly rendered: Map<number, { readonly size: string; readonly canvas: HTMLCanvasElement }>
  readonly rendering: Map<number, { readonly size: string; readonly task: RenderTask }>
  /** 无法取得或绘制的页面：不再重试，显示为空白页。 */
  readonly failed: Set<number>
}

function sizeOf(page: PDFPageProxy): PageSize {
  const v = page.getViewport({ scale: 1 })
  return { width: v.width, height: v.height }
}

function openFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'PasswordException') return '文件已加密'
  if (name === 'InvalidPDFException') return '文件已损坏'
  return '无法读取文件'
}

export default function PdfPages(props: { path: string; mtime: number }) {
  let scroller!: HTMLDivElement
  let extent!: HTMLDivElement
  let viewport: PageViewport | null = null
  const [current, setCurrent] = createSignal<Opened | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const release = (o: Opened) => {
    for (const r of o.rendering.values()) r.task.cancel()
    for (const r of o.rendered.values()) {
      r.canvas.width = 0
      r.canvas.height = 0
    }
    void o.task.destroy()
  }

  /** 第 `index` 页的尺寸与排列时所用的不同：重新排列。同一帧中取得的多页合并为一次。 */
  let relayout = 0
  const resize = (o: Opened, index: number, size: PageSize) => {
    const old = o.sizes[index]!
    if (old.width === size.width && old.height === size.height) return
    o.sizes[index] = size
    if (relayout) return
    relayout = requestAnimationFrame(() => {
      relayout = 0
      if (current() === o) viewport?.show(o.sizes, viewport.position())
    })
  }

  const prepare = (index: number): boolean => {
    const o = current()
    if (!o || o.failed.has(index)) return false
    if (o.pages.has(index)) return true
    if (!o.loading.has(index)) {
      o.loading.add(index)
      o.doc.getPage(index + 1).then(
        (page) => {
          o.pages.set(index, page)
          resize(o, index, sizeOf(page))
          if (current() === o) viewport?.repaint(index)
        },
        () => o.failed.add(index),
      )
    }
    return false
  }

  const keep = (o: Opened, index: number) => {
    let total = 0
    for (const [i, r] of [...o.rendered].reverse()) {
      total += r.canvas.width * r.canvas.height
      if (i !== index && total > KEEP_PIXELS) {
        r.canvas.width = 0
        r.canvas.height = 0
        o.rendered.delete(i)
      }
    }
  }

  const paint = (index: number, canvas: HTMLCanvasElement, scale: number) => {
    const o = current()
    const page = o?.pages.get(index)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!o || !page || !ctx) return
    const size = `${canvas.width}x${canvas.height}`
    const done = o.rendered.get(index)
    if (done) {
      ctx.drawImage(done.canvas, 0, 0, canvas.width, canvas.height)
    } else {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    if (done?.size === size || o.rendering.get(index)?.size === size) return
    o.rendering.get(index)?.task.cancel()
    const target = document.createElement('canvas')
    target.width = canvas.width
    target.height = canvas.height
    const task = page.render({ canvas: target, viewport: page.getViewport({ scale }) })
    o.rendering.set(index, { size, task })
    task.promise.then(
      () => {
        if (o.rendering.get(index)?.task !== task) return
        o.rendering.delete(index)
        const old = o.rendered.get(index)
        if (old) {
          old.canvas.width = 0
          old.canvas.height = 0
        }
        o.rendered.delete(index)
        o.rendered.set(index, { size, canvas: target })
        keep(o, index)
        if (current() === o) viewport?.repaint(index)
      },
      (err: unknown) => {
        target.width = 0
        target.height = 0
        if (o.rendering.get(index)?.task !== task) return
        o.rendering.delete(index)
        if (err instanceof Error && err.name === 'RenderingCancelledException') return
        o.failed.add(index)
      },
    )
  }

  /** 第 `index` 页的文字层。元素的位置与缩放由视口设定（`page-viewport.ts`），按比例 1 排列即可。 */
  const layer = (index: number, element: HTMLDivElement) => {
    const page = current()?.pages.get(index)
    if (!page) return
    element.className = 'doc-text'
    new TextLayer({
      textContentSource: page.streamTextContent(),
      container: element,
      viewport: page.getViewport({ scale: 1 }),
    })
      .render()
      .catch(() => {})
  }

  /** 位置或比例改变后更新工具栏，并按路径记录（`view-state.ts`）：切换到其他文件再切回时恢复。 */
  const onChange = (at: ViewPosition) => {
    zoom.note(at)
    writeView(props.path, at)
  }

  const source = createMemo(() => JSON.stringify([props.path, props.mtime]))
  /** 只采用最后一次打开的结果：文件连续改写时，先发出的请求可能后完成。 */
  let generation = 0
  createEffect(
    on(source, () => {
      const mine = ++generation
      const path = props.path
      const url = rawFilePath(path, props.mtime)
      let task: PDFDocumentLoadingTask | null = null
      /** 打开失败，或已显示的文档无法读取其余部分。 */
      const fail = (err: unknown) => {
        void task?.destroy()
        if (mine !== generation) return
        const previous = current()
        setCurrent(null)
        if (previous) release(previous)
        setError(openFailure(err))
      }
      pdfSource(
        rangeReader((p, init) => client.raw(p, init), url),
        RANGE_CHUNK,
        fail,
      )
        .then((from) => {
          if (mine !== generation) return null
          const opening = getDocument({
            ...from,
            rangeChunkSize: RANGE_CHUNK,
            cMapUrl: `${dataUrl()}cmaps/`,
            standardFontDataUrl: `${dataUrl()}standard_fonts/`,
            wasmUrl: `${dataUrl()}wasm/`,
            iccUrl: `${dataUrl()}iccs/`,
          })
          task = opening
          return opening.promise.then(async (doc) => ({
            task: opening,
            doc,
            first: await doc.getPage(1),
          }))
        })
        .then((opened) => {
          if (!opened) return
          const { task, doc, first } = opened
          if (mine !== generation) {
            void task.destroy()
            return
          }
          const size = sizeOf(first)
          const next: Opened = {
            path,
            task,
            doc,
            sizes: Array.from({ length: doc.numPages }, () => size),
            pages: new Map([[0, first]]),
            loading: new Set([0]),
            rendered: new Map(),
            rendering: new Map(),
            failed: new Set(),
          }
          const previous = current()
          const at =
            previous?.path === path ? viewport?.position() : (readView<ViewPosition>(path) ?? null)
          setError(null)
          setCurrent(next)
          if (previous) release(previous)
          viewport ??= createPageViewport({ scroller, extent, onChange }, { prepare, paint, layer })
          viewport.show(next.sizes, at ?? null)
        }, fail)
    }),
  )

  onCleanup(() => {
    generation += 1
    cancelAnimationFrame(relayout)
    viewport?.destroy()
    const o = current()
    if (o) release(o)
  })

  const ready = () => current() !== null && error() === null
  const zoom = officeZoom(
    () => scroller,
    () => viewport,
    ready,
  )

  return (
    <div class="doc-view">
      <Show when={error()}>{(msg) => <div class="preview-note">{msg()}</div>}</Show>
      <Show when={!current() && !error()}>
        <div class="preview-loading" />
      </Show>
      <div class="doc-scroll" ref={scroller} hidden={!ready()}>
        <div class="doc-extent" ref={extent} />
      </div>
    </div>
  )
}

/** 数据目录的绝对地址：pdf.js 在 Worker 中读取，相对地址按 Worker 脚本的地址解析。 */
function dataUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}${__PDFJS_DATA__}`, location.href).href
}
