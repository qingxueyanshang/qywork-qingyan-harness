/**
 * Excel 预览：取得文件字节，在 Worker 中解析，取得字体后在画布上绘制当前工作表。滚动、缩放与绘制见 `sheet-viewport.ts`。
 *
 * - 加载、改写后重新加载与失败文案见 `document.ts`。重新加载完成后按名称保留当前工作表，并保留滚动位置与缩放比例。
 * - 存在未显示的内容时显示一行能力边界：当前工作表的计数、工作簿级的种类与无法解码的图片。
 * - 工作表签只列出可见的工作表，隐藏与深度隐藏的不列出。
 *
 * 默认导出供 `lazy()` 使用：解析与绘制代码只在打开表格文件时下载。
 */

import {
  createScene,
  FontSet,
  fallbackFonts,
  type LoadedFace,
  loadFace,
  type PaintImage,
  type UnsupportedKind,
  type Workbook,
} from '@qywork/ooxml/xlsx'
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { boundaryText, connectWorker, createDocumentLoader, failureText } from './document.ts'
import { type HostFace, loadHostFaces } from './fonts.ts'
import { createSheetViewport, type SheetViewport } from './sheet-viewport.ts'
import type { ViewPosition } from './viewport.ts'
import type { XlsxReplies, XlsxRequest } from './xlsx-worker.ts'

interface Doc {
  readonly workbook: Workbook
  readonly fonts: FontSet
}

/** 能力边界中各种类的名称，按此顺序列出。 */
const UNSUPPORTED_LABEL: Record<UnsupportedKind, string> = {
  chart: '图表',
  chartsheet: '图表工作表',
  otherSheet: '宏表与对话框表',
  graphic: '其他对象',
  textWarp: '文字变形',
  effect3d: '三维效果',
  effect: '其他效果',
  verticalText: '竖排文字',
  image: '图片',
  cellImage: '单元格内图片',
  pivotTable: '数据透视表',
  slicer: '切片器',
  sparkline: '迷你图',
  table: '表格样式',
  conditionalFormat: '条件格式',
  comment: '批注',
  control: '控件',
  oleObject: '嵌入对象',
}

/** 字体的排版度量，按字体缓存；字体表不完整（如缺少 `OS/2`）时为 `null`，按主机上没有该字体处理。 */
const loadedFaces = new WeakMap<HostFace, LoadedFace | null>()

function loadedFace(host: HostFace): LoadedFace | null {
  let face = loadedFaces.get(host)
  if (face === undefined) {
    try {
      face = loadFace(host.bytes, host.family)
    } catch {
      face = null
    }
    loadedFaces.set(host, face)
  }
  return face
}

/**
 * 取得 `names` 中各字体（主机上没有的略去），组成排版用的字体集；`fallbacks` 为缺字时依次尝试的字体名。
 * 文档以另一个名称引用已注册的字体时，以别名指向首次注册的族名。
 */
async function loadFontSet(
  names: readonly string[],
  fallbacks: readonly string[],
): Promise<FontSet> {
  const host = await loadHostFaces([...names, ...fallbacks])
  const loaded: LoadedFace[] = []
  const aliases = new Map<string, string>()
  for (const [name, list] of host) {
    for (const h of list) {
      const face = loadedFace(h)
      if (!face) continue
      if (!loaded.includes(face)) loaded.push(face)
      if (face.family !== name) aliases.set(name.trim().toLowerCase(), face.family)
    }
  }
  return new FontSet(loaded, fallbacks, aliases)
}

/** 在 Worker 中解析；`signal` 中止时结束 Worker。 */
async function parseInWorker(bytes: ArrayBuffer, signal: AbortSignal) {
  const channel = connectWorker<XlsxRequest, XlsxReplies>(
    new Worker(new URL('./xlsx-worker.ts', import.meta.url), { type: 'module' }),
  )
  signal.addEventListener('abort', () => channel.close(), { once: true })
  try {
    return await channel.request({ kind: 'parse', bytes }, [bytes])
  } finally {
    channel.close()
  }
}

export default function SheetView(props: { path: string; mtime: number }) {
  const [doc, setDoc] = createSignal<Doc | null>(null)
  /** 当前工作表在 `workbook.sheets` 中的下标；没有可见工作表时为 -1。 */
  const [sheetIndex, setSheetIndex] = createSignal(-1)
  /** 当前工作表中无法解码的图片数，计入能力边界。 */
  const [undecoded, setUndecoded] = createSignal(0)

  let scroller!: HTMLDivElement
  let extent!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let viewport: SheetViewport | null = null
  /** 下一次显示工作表时的位置：改写后重新加载同一工作表时为原位置，其余为 `null`（取工作表保存的打开位置）。 */
  let nextPosition: ViewPosition | null = null

  onCleanup(() => viewport?.destroy())

  /** 换上新解析的工作簿：同名的可见工作表仍在时保留它与位置，否则显示工作簿的活动工作表。 */
  const showDoc = (next: Doc) => {
    const sheets = next.workbook.sheets
    const previous = doc()?.workbook.sheets[sheetIndex()]?.name
    const kept = sheets.findIndex((s) => s.name === previous && s.state === 'visible')
    const active = sheets[next.workbook.activeSheet]?.state === 'visible'
    const index =
      kept >= 0
        ? kept
        : active
          ? next.workbook.activeSheet
          : sheets.findIndex((s) => s.state === 'visible')
    nextPosition = kept >= 0 ? (viewport?.position() ?? null) : null
    setDoc(next)
    setSheetIndex(index)
  }

  const error = createDocumentLoader(
    () => props,
    async (bytes, signal): Promise<Doc | string> => {
      const parsed = await parseInWorker(bytes, signal)
      if (!parsed.ok) return failureText(parsed.failure)
      const workbook = parsed.value
      const fonts = await loadFontSet(workbook.fontNames, fallbackFonts(workbook))
      return { workbook, fonts }
    },
    showDoc,
  )

  let decoding = 0
  createEffect(
    on([doc, sheetIndex], ([d, index]) => {
      const sheet = d?.workbook.sheets[index]
      if (!d || !sheet) return
      viewport ??= createSheetViewport({ scroller, extent, canvas })
      viewport.show(createScene(d.workbook, sheet, d.fonts), nextPosition)
      nextPosition = null
      const mine = ++decoding
      setUndecoded(0)
      void Promise.all(
        sheet.images.map((img) =>
          createImageBitmap(new Blob([img.bytes.slice()], { type: img.contentType })).then(
            (bitmap): PaintImage | null => bitmap,
            () => null,
          ),
        ),
      ).then((images) => {
        if (mine !== decoding) return
        viewport?.setImages(images)
        setUndecoded(images.filter((img) => img === null).length)
      })
    }),
  )

  const tabs = () =>
    (doc()?.workbook.sheets ?? [])
      .map((sheet, index) => ({ name: sheet.name, index, visible: sheet.state === 'visible' }))
      .filter((t) => t.visible)

  const boundary = () => {
    const d = doc()
    const sheet = d?.workbook.sheets[sheetIndex()]
    if (!d || !sheet) return null
    const book = d.workbook.unsupported
    return boundaryText(
      {
        ...sheet.unsupported,
        chartsheet: book.chartsheet ?? 0,
        otherSheet: book.otherSheet ?? 0,
        image: (sheet.unsupported.image ?? 0) + undecoded(),
      },
      UNSUPPORTED_LABEL,
    )
  }

  const ready = () => doc() !== null && error() === null

  return (
    <div class="sheet-view">
      <Show when={error()}>{(msg) => <div class="preview-note">{msg()}</div>}</Show>
      <Show when={!doc() && !error()}>
        <div class="preview-loading" />
      </Show>
      <div class="sheet-stage" hidden={!ready()}>
        <div class="sheet-scroll" ref={scroller}>
          <div class="sheet-extent" ref={extent} />
        </div>
        <canvas class="sheet-canvas" ref={canvas} />
      </div>
      <Show when={ready() && boundary()}>
        {(text) => <div class="office-boundary">{text()}</div>}
      </Show>
      <Show when={ready()}>
        <div class="sheet-tabs" role="tablist">
          <For each={tabs()}>
            {(t) => (
              <button
                class="sheet-tab"
                classList={{ active: t.index === sheetIndex() }}
                type="button"
                role="tab"
                aria-selected={t.index === sheetIndex()}
                onClick={() => {
                  if (t.index === sheetIndex()) return
                  nextPosition = null
                  setSheetIndex(t.index)
                }}
              >
                {t.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
