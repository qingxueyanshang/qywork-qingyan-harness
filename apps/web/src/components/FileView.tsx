import type { EditorView } from '@codemirror/view'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js'
import { ApiError } from '../lib/client.ts'
import {
  createReadonlyEditor,
  languageFor,
  scrollToLine,
  selectRange,
  topLine,
} from '../lib/editor.ts'
import type { OfficeFormat } from '../lib/file-search.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import { loaded, suspendUntil } from '../lib/resource.ts'
import {
  absPath,
  client,
  explainApiError,
  fileSelectRequest,
  isDesktopShell,
  setFileSelectRequest,
  workspace,
} from '../lib/store/index.ts'
import FileImageView from './FileImageView.tsx'
import { HoldBoundary } from './HoldSwitch.tsx'
import { IconX } from './Icons.tsx'
import HtmlPreview from './preview/HtmlPreview.tsx'
import { type PreviewTools, PreviewToolsContext, type ToolsRender } from './preview/tools.ts'
import { patchView, readView } from './preview/view-state.ts'
import ZoomControl from './preview/ZoomControl.tsx'
import { bindZoomInputs, ZOOM_STEP } from './preview/zoom-input.ts'

// 懒加载：表格、演示文稿与文档的解析与绘制代码只在打开对应文件时下载。使用处以 `HoldBoundary` 包裹，不要换成 Suspense：
// 代码下载与首次解析要挂起到文件页的 `HoldSwitch`，切换文件时保留上一个文件；换成 Suspense 时先显示加载条。
const SheetView = lazy(() => import('./office/SheetView.tsx'))
const SlideView = lazy(() => import('./office/pptx/SlideView.tsx'))
const DocView = lazy(() => import('./office/docx/DocView.tsx'))

interface PreviewResult {
  path: string
  kind: 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'tabular' | 'office' | 'archive' | 'binary'
  mime: string
  size: number
  mtime: number
  content?: string
  language?: string
  office?: OfficeFormat
  entries?: string[]
  truncated: boolean
  note?: string
}

/**
 * 打开的文件显示在**主内容区**，不在右侧面板中。
 *
 * 面板列只有 `--panel-w` 宽，代码每行都需要折行；而查看文件时文件树必须保留，
 * 否则查看下一个文件需要先返回。因此文件树留在面板中、内容占据主区，两者同时可见。
 *
 * 输入区仍可随时唤出：面板放大时默认收起在底部，悬浮或聚焦时才展开，避免长时间遮挡
 * 正在查看的文件；有草稿时保持展开。
 *
 * 默认导出供 `lazy()` 使用：`CodeView` 依赖约 300 kB 的 CodeMirror 核心，
 * 只使用聊天功能的用户不应为它承担首屏加载成本。
 *
 * `onClose` 只在文件页中提供：文件预览页（页签）由页签上的 × 关闭，标题条不再放第二个关闭按钮。
 */
export default function FileView(props: { path: string; refresh?: number; onClose?: () => void }) {
  // 路径与文件页的统一失效序号直接作为资源判据。失效序号不在 `run.started` 时清空，
  // 因此发起新一轮不会把「摘要从非空变为空」误判为一次磁盘改动。
  const [result] = createResource(
    () => `${props.path}:${props.refresh ?? 0}`,
    () => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(props.path)}`),
  )
  suspendUntil(() => !result.loading)

  /**
   * Markdown 与 SVG 显示源码而不是渲染结果。文件页按路径重新挂载本组件，切换文件后回到渲染结果；
   * 文件预览页的路径不变，刷新时保留。
   */
  const [source, setSource] = createSignal(false)
  const markdown = () => loaded(result)?.language === 'markdown'
  const svg = () => loaded(result)?.kind === 'image' && /\.svg$/i.test(props.path)
  /** HTML 的预览由内置浏览器的引擎显示（`HtmlPreview`），只在桌面端提供；其他客户端只显示源码。 */
  const html = () => loaded(result)?.language === 'html' && isDesktopShell()
  // 选中请求（画布摘录卡）按源码位置计算，只能在源码视图中执行；请求可能先于预览结果到达，两者都就绪后再判断。
  createEffect(() => {
    const req = fileSelectRequest()
    if (req && markdown() && req.path === loaded(result)?.path) setSource(true)
  })

  /** 以文本显示的内容：代码、表格文本、Markdown 的两种视图与 SVG 源码。它们按字号缩放，共用一个比例。 */
  const textual = () => {
    const r = loaded(result)
    if (!r) return false
    if (html() && !source()) return false
    return r.kind === 'text' || r.kind === 'tabular' || (svg() && source())
  }
  const [textZoom, setTextZoom] = createSignal(readView<TextView>(props.path)?.zoom ?? 1)
  let body!: HTMLDivElement
  /** 缩放后按比例恢复滚动位置：字号变化后内容总高度随之变化。代码视图按行恢复（`CodeView`）。 */
  const zoomText = (next: number) => {
    const zoom = Math.min(TEXT_ZOOM_MAX, Math.max(TEXT_ZOOM_MIN, next))
    const ratio = body.scrollHeight ? body.scrollTop / body.scrollHeight : 0
    setTextZoom(zoom)
    patchView(props.path, { zoom })
    requestAnimationFrame(() => {
      body.scrollTop = ratio * body.scrollHeight
    })
  }
  onMount(() => {
    const unbind = bindZoomInputs(
      body,
      {
        ready: textual,
        zoomBy: (factor) => zoomText(textZoom() * factor),
        reset: () => zoomText(1),
      },
      { wheel: true },
    )
    onCleanup(unbind)
  })

  /** Markdown 渲染结果的阅读位置：内容渲染后恢复一次，之后随滚动记录。 */
  let restoreTop = readView<TextView>(props.path)?.top
  const rendered = () => {
    const top = restoreTop
    restoreTop = undefined
    if (top !== undefined)
      requestAnimationFrame(() => {
        body.scrollTop = top
      })
  }
  const onBodyScroll = () => {
    if (markdown() && !source()) patchView(props.path, { top: body.scrollTop })
  }

  /** 图片、Office 与 HTML 的视图提供的控件（`usePreviewTools`）。 */
  const [viewTools, setViewTools] = createSignal<ToolsRender | null>(null)
  const previewTools: PreviewTools = {
    show: (render) => setViewTools(() => render),
    hide: (render) => {
      if (viewTools() === render) setViewTools(null)
    },
  }

  /** 渲染结果与源码的切换。 */
  const ModeToggle = () => (
    <Show when={markdown() || svg() || html()}>
      <button type="button" aria-pressed={!source()} onClick={() => setSource(false)}>
        预览
      </button>
      <button type="button" aria-pressed={source()} onClick={() => setSource(true)}>
        源码
      </button>
    </Show>
  )

  return (
    <div class="preview" style={{ '--text-zoom': String(textZoom()) }}>
      <header class="preview-head">
        {/* 显示完整的本机路径，而不是工作区相对路径：根目录下文件的相对路径只剩
            文件名，无法看出所属项目。空间不足时从左侧截断：末尾的文件名比盘符更重要。 */}
        <code class="truncate-left" data-tip={absPath(props.path)}>
          {/* `dir="ltr"` 与外层的 `rtl` 必须同时存在：外层 `rtl` 把省略号移到左侧，
              内层 `ltr` 保证路径本身仍按从左到右显示。只写外层时，`C:\` 会移到右侧。 */}
          <span dir="ltr">{absPath(props.path)}</span>
        </code>
        <span class="spacer" />
        {/* 各类型的控件与路径同一行：渲染结果与源码的切换、文本缩放，以及视图经 `usePreviewTools` 提供的控件。 */}
        <span class="preview-tools">
          <ModeToggle />
          <Show when={textual()}>
            <ZoomControl
              ratio={textZoom()}
              min={TEXT_ZOOM_MIN}
              max={TEXT_ZOOM_MAX}
              onStep={(direction) =>
                zoomText(textZoom() * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
              }
            />
          </Show>
          {viewTools()?.()}
        </span>
        <Show when={props.onClose}>
          <button
            class="icon-btn"
            type="button"
            aria-label="关闭"
            onClick={() => props.onClose?.()}
          >
            <IconX size={14} />
          </button>
        </Show>
      </header>

      <PreviewToolsContext.Provider value={previewTools}>
        <div class="preview-body" ref={body} onScroll={onBodyScroll}>
          {/* 获取失败时必须给出说明。使用 `loaded()` 而不是 `result()`：后者出错时会 `throw`，
            而这一层外部只有供 `lazy()` 使用的 Suspense，无法捕获抛出的错误，
            该区域会一直停留在加载状态。 */}
          <Show
            when={loaded(result)}
            fallback={
              <Show when={result.error} fallback={<div class="preview-loading" />}>
                {(e) => <div class="preview-note">{explainApiError(e(), '无法打开此文件')}</div>}
              </Show>
            }
          >
            {(r) => (
              <Switch fallback={<div class="preview-note">{r().note ?? '无法预览'}</div>}>
                <Match when={markdown() && !source()}>
                  <MarkdownView
                    content={r().content ?? ''}
                    path={r().path}
                    version={`${r().mtime}.${props.refresh ?? 0}`}
                    onRendered={rendered}
                  />
                </Match>
                <Match when={html() && !source()}>
                  <HtmlPreview path={r().path} mtime={r().mtime} />
                </Match>
                <Match when={r().kind === 'text' || r().kind === 'tabular'}>
                  <CodeView
                    content={r().content ?? ''}
                    path={r().path}
                    wrap={r().kind !== 'tabular'}
                    zoom={textZoom()}
                  />
                </Match>
                <Match when={svg() && source()}>
                  <SvgSource path={r().path} mtime={r().mtime} zoom={textZoom()} />
                </Match>
                <Match when={r().kind === 'pdf'}>
                  <PdfView path={r().path} mtime={r().mtime} />
                </Match>
                <Match when={r().office === 'xlsx'}>
                  <HoldBoundary fallback={<div class="preview-loading" />}>
                    <SheetView path={r().path} mtime={r().mtime} />
                  </HoldBoundary>
                </Match>
                <Match when={r().office === 'pptx'}>
                  <HoldBoundary fallback={<div class="preview-loading" />}>
                    <SlideView path={r().path} mtime={r().mtime} />
                  </HoldBoundary>
                </Match>
                <Match when={r().office === 'docx'}>
                  <HoldBoundary fallback={<div class="preview-loading" />}>
                    <DocView path={r().path} mtime={r().mtime} />
                  </HoldBoundary>
                </Match>
                <Match when={r().kind === 'image'}>
                  <FileImageView src={client.fileUrl(r().path, r().mtime)} path={r().path} />
                </Match>
                <Match when={r().kind === 'video'}>
                  <MediaView kind="video" src={client.fileUrl(r().path, r().mtime)} />
                </Match>
                <Match when={r().kind === 'audio'}>
                  <MediaView kind="audio" src={client.fileUrl(r().path, r().mtime)} />
                </Match>
                <Match when={r().entries}>
                  {(entries) => (
                    <ul class="archive-list">
                      <For each={entries()}>{(entry) => <li>{entry}</li>}</For>
                    </ul>
                  )}
                </Match>
              </Switch>
            )}
          </Show>
        </div>
      </PreviewToolsContext.Provider>

      <Show when={loaded(result)?.truncated}>
        <footer class="preview-foot">内容已截断</footer>
      </Show>
    </div>
  )
}

/** 视频与音频。无法解码时显示说明，不留下一个无法播放的空播放器。 */
function MediaView(props: { kind: 'video' | 'audio'; src: string }) {
  const [failed, setFailed] = createSignal(false)
  createEffect(
    on(
      () => props.src,
      () => setFailed(false),
      { defer: true },
    ),
  )
  return (
    <Show when={!failed()} fallback={<div class="preview-note">无法播放此文件</div>}>
      <Show
        when={props.kind === 'video'}
        fallback={
          <audio class="preview-audio" src={props.src} controls onError={() => setFailed(true)} />
        }
      >
        <div class="preview-video">
          <video
            class="preview-media"
            src={props.src}
            controls
            playsinline
            onError={() => setFailed(true)}
          />
        </div>
      </Show>
    </Show>
  )
}

/** SVG 的源码：预览接口对图片只返回类型，源码另行读取原始字节。 */
function SvgSource(props: { path: string; mtime: number; zoom: number }) {
  const [text] = createResource(
    () => JSON.stringify([props.path, props.mtime]),
    async () => {
      const url = `/api/files/raw?path=${encodeURIComponent(props.path)}`
      const res = await client.raw(url)
      if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
      return res.text()
    },
  )
  return (
    <Show
      when={loaded(text) !== undefined}
      fallback={
        <Show when={text.error} fallback={<div class="preview-loading" />}>
          {(e) => <div class="preview-note">{explainApiError(e(), '无法读取源码')}</div>}
        </Show>
      }
    >
      <CodeView content={loaded(text) ?? ''} path={props.path} wrap zoom={props.zoom} />
    </Show>
  )
}

/**
 * PDF：取得原始字节并生成 blob URL 交给 iframe，由 WebView 内置的阅读器渲染。图片与音视频使用直链（`client.fileUrl`）。
 *
 * - 使用 blob URL，不使用直链或 data URI：桌面端 CSP 的 `frame-src` 只放行 `blob:`；data URI 还需要把整个文件以 base64 写入 JSON。
 * - 只在路径或修改时间变化时重新获取。判据必须经过 memo 且为字符串：预览每次重新获取都返回一个新对象，
 *   直接依赖它时，会话中任何一次写文件都会使阅读器重新加载并回到第一页；只判断修改时间时，
 *   在同一个预览中切换到修改时间恰好相同的另一个文件不会重新获取，显示的仍是上一个文件。
 * - blob URL 被替换时立即撤销，卸载时撤销最后一个：不撤销时整份字节会占用内存直到整页刷新。
 */
function PdfView(props: { path: string; mtime: number }) {
  const [src, setSrc] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const source = createMemo(() => JSON.stringify([props.path, props.mtime]))

  const replace = (next: string | null) => {
    const old = src()
    setSrc(next)
    if (old) URL.revokeObjectURL(old)
  }

  /** 只采用最后一次请求的结果：文件连续改写时，先发出的请求可能后返回。 */
  let generation = 0
  createEffect(
    on(source, () => {
      const mine = ++generation
      const url = `/api/files/raw?path=${encodeURIComponent(props.path)}`
      void (async () => {
        const res = await client.raw(url)
        if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
        return URL.createObjectURL(await res.blob())
      })().then(
        (next) => {
          if (mine !== generation) {
            URL.revokeObjectURL(next)
            return
          }
          setError(null)
          replace(next)
        },
        (err: unknown) => {
          if (mine !== generation) return
          replace(null)
          setError(err instanceof Error ? err.message : String(err))
        },
      )
    }),
  )
  onCleanup(() => {
    generation += 1
    replace(null)
  })

  return (
    <Show
      when={src()}
      fallback={
        <Show when={error()} fallback={<div class="preview-loading" />}>
          {(msg) => <div class="preview-note">{msg()}</div>}
        </Show>
      }
    >
      {(u) => <iframe class="preview-frame" src={u()} title={props.path} />}
    </Show>
  )
}

/**
 * Markdown 的渲染结果。链接点击由根节点的 `openLink` 处理；相对地址按文件所在目录解析，
 * 工作区内的图片以直链内嵌。直链的版本 `version` 包含文件页的失效序号：只取 Markdown 自身的修改时间时，
 * 图片被改写而 Markdown 未改写，仍显示原图。`onRendered` 在每次写入渲染结果后调用。
 */
function MarkdownView(props: {
  content: string
  path: string
  version: string
  onRendered: () => void
}) {
  const html = createMemo(() => {
    const slash = props.path.lastIndexOf('/')
    return renderMarkdown(props.content, {
      dir: slash < 0 ? '' : props.path.slice(0, slash),
      root: workspace()?.root ?? '',
      url: (path) => client.fileUrl(path, props.version),
    })
  })
  createEffect(on(html, () => props.onRendered()))
  return <div class="markdown markdown-file" innerHTML={html()} />
}

/**
 * 文本类预览按路径记录的视图状态（`view-state.ts`）：字号比例、代码视图顶部的行、Markdown 渲染结果的滚动位置。
 * 代码视图按行而不是按像素记录，理由见 `scrollToLine`。
 */
interface TextView {
  zoom?: number
  line?: number
  top?: number
}
/** 文本字号比例的范围。 */
const TEXT_ZOOM_MIN = 0.5
const TEXT_ZOOM_MAX = 3

/** 只读代码视图。`wrap` 为假时长行横向滚动（表格文本）；`zoom` 变化后保持顶部的行不变。 */
function CodeView(props: { content: string; path: string; wrap: boolean; zoom: number }) {
  let host!: HTMLDivElement
  let view: EditorView | null = null
  let mountedPath: string | null = null
  /**
   * 语言包随组件创建开始读取，并声明为首次读取（`suspendUntil`）：编辑器在语言包到达后同步创建，
   * 预览显示时代码区已有内容。不要改回在 effect 中 `await` 语言包：Suspense 挂起期间 effect 推迟执行，
   * 预览显示之后才开始读取，代码区先空白、再出现正文。
   */
  const [lang] = createResource(() => props.path, languageFor)
  suspendUntil(() => !lang.loading)

  /** 执行指向本文件的选中请求（`fileSelectRequest`）。请求可能先于编辑器装配完成到达，装配后再执行一次。 */
  const applySelect = () => {
    const req = fileSelectRequest()
    if (!view || !req || req.path !== mountedPath) return
    setFileSelectRequest(null)
    selectRange(view, req.from, req.to)
  }
  createEffect(on(fileSelectRequest, applySelect))

  // 只有路径变化时才整体重建（语言包由路径决定）。同一文件的正文更新直接派发到
  // 现有 CodeMirror：重建实例会替换 `.cm-scroller`，阅读位置会回到顶部。
  //
  // 放在 `createEffect` 中，不放在 `ref` 回调中：ref 只在创建元素时执行一次，
  // 而外层的 `Show` 不是 keyed，内容变化时本组件实例保持不变。
  createEffect(() => {
    const content = props.content
    const path = props.path
    // 换路径时等待该路径的语言包：重新读取期间 `latest` 仍是上一个路径的结果。
    const extensions = lang.state === 'ready' ? lang.latest : undefined

    if (view && mountedPath === path) {
      if (view.state.doc.toString() === content) return
      const { scrollLeft, scrollTop } = view.scrollDOM
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      // 全文替换会重新计算文档高度；恢复像素位置，内容变短时浏览器自动将位置限制在新的底部。
      view.scrollDOM.scrollLeft = scrollLeft
      view.scrollDOM.scrollTop = scrollTop
      return
    }

    if (extensions === undefined) return
    const next = createReadonlyEditor(host, content, extensions, props.wrap)
    view?.destroy()
    view = next
    mountedPath = path
    const line = readView<TextView>(path)?.line
    if (line !== undefined) scrollToLine(next, line)
    applySelect()
    next.scrollDOM.addEventListener('scroll', () => patchView(path, { line: topLine(next) }))
  })

  // 字号由外层的 `--text-zoom` 决定。编辑器按缓存的行高定位，字号变化后须重新测量，再滚动到缩放前位于顶部的行。
  createEffect(
    on(
      () => props.zoom,
      () => {
        const current = view
        if (!current) return
        const line = topLine(current)
        current.requestMeasure()
        requestAnimationFrame(() => scrollToLine(current, line))
      },
      { defer: true },
    ),
  )

  onCleanup(() => view?.destroy())

  return <div class="code-view" ref={host} />
}
