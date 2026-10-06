import type { EditorView } from '@codemirror/view'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { createReadonlyEditor, scrollToLine, topLine } from '../lib/editor.ts'
import { loaded } from '../lib/resource.ts'
import { readSession, writeSession } from '../lib/session.ts'
import { absPath, client, explainApiError, setOpenFile } from '../lib/store/index.ts'
import FileImageView from './FileImageView.tsx'
import { IconX } from './Icons.tsx'

interface PreviewResult {
  path: string
  kind: 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'tabular' | 'archive' | 'binary'
  mime: string
  size: number
  mtime: number
  content?: string
  language?: string
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
 */
export default function FileView(props: { path: string; refresh?: number }) {
  // 路径与文件页的统一失效序号直接作为资源判据。失效序号不在 `run.started` 时清空，
  // 因此发起新一轮不会把「摘要从非空变为空」误判为一次磁盘改动。
  const [result] = createResource(
    () => `${props.path}:${props.refresh ?? 0}`,
    () => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(props.path)}`),
  )

  return (
    <div class="preview">
      <header class="preview-head">
        {/* 显示完整的本机路径，而不是工作区相对路径：根目录下文件的相对路径只剩
            文件名，无法看出所属项目。空间不足时从左侧截断：末尾的文件名比盘符更重要。 */}
        <code class="truncate-left" data-tip={absPath(props.path)}>
          {/* `dir="ltr"` 与外层的 `rtl` 必须同时存在：外层 `rtl` 把省略号移到左侧，
              内层 `ltr` 保证路径本身仍按从左到右显示。只写外层时，`C:\` 会移到右侧。 */}
          <span dir="ltr">{absPath(props.path)}</span>
        </code>
        <span class="spacer" />
        <button class="icon-btn" type="button" aria-label="关闭" onClick={() => setOpenFile(null)}>
          <IconX size={14} />
        </button>
      </header>

      <div class="preview-body">
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
              <Match when={r().kind === 'text' || r().kind === 'tabular'}>
                <CodeView content={r().content ?? ''} path={r().path} />
              </Match>
              <Match when={r().kind === 'pdf'}>
                <PdfView path={r().path} mtime={r().mtime} />
              </Match>
              <Match when={r().kind === 'image'}>
                <FileImageView src={client.fileUrl(r().path, r().mtime)} alt={r().path} />
              </Match>
              <Match when={r().kind === 'video'}>
                <div class="preview-video">
                  <video
                    class="preview-media"
                    src={client.fileUrl(r().path, r().mtime)}
                    controls
                    playsinline
                  />
                </div>
              </Match>
              <Match when={r().kind === 'audio'}>
                <audio class="preview-audio" src={client.fileUrl(r().path, r().mtime)} controls />
              </Match>
            </Switch>
          )}
        </Show>
      </div>

      <Show when={loaded(result)?.truncated}>
        <footer class="preview-foot">内容已截断</footer>
      </Show>
    </div>
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
          setError(err instanceof ApiError ? err.detail : String(err))
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

/** 当前文本文件视口顶部的行。只记录一个文件，按路径区分：刷新后同一文件按记录恢复。 */
const SCROLL_KEY = 'qywork.file.scroll'
interface ScrollRecord {
  path: string
  line: number
}

function CodeView(props: { content: string; path: string }) {
  let host!: HTMLDivElement
  let view: EditorView | null = null
  let mountedPath: string | null = null
  /** 只采用最后一次装配的结果：语言包是动态 import，两次改动间隔很短时，后发出的可能先完成。 */
  let generation = 0

  // 只有路径变化时才整体重建（语言包由路径决定）。同一文件的正文更新直接派发到
  // 现有 CodeMirror：重建实例会替换 `.cm-scroller`，用户阅读到中间时会回到顶部。
  //
  // 放在 `createEffect` 中，不放在 `ref` 回调中：ref 只在创建元素时执行一次，
  // 而外层的 `Show` 不是 keyed，内容变化时本组件实例保持不变。
  createEffect(() => {
    const content = props.content
    const path = props.path
    const mine = ++generation

    if (view && mountedPath === path) {
      if (view.state.doc.toString() === content) return
      const { scrollLeft, scrollTop } = view.scrollDOM
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      // 全文替换会重新计算文档高度；恢复像素位置，内容变短时浏览器自动将位置限制在新的底部。
      view.scrollDOM.scrollLeft = scrollLeft
      view.scrollDOM.scrollTop = scrollTop
      return
    }

    void (async () => {
      const next = await createReadonlyEditor(host, content, path)
      if (mine !== generation) {
        next.destroy()
        return
      }
      view?.destroy()
      view = next
      mountedPath = path
      const saved = readSession<ScrollRecord>(SCROLL_KEY)
      if (saved?.path === path) scrollToLine(next, saved.line)
      next.scrollDOM.addEventListener('scroll', () =>
        writeSession(SCROLL_KEY, { path, line: topLine(next) } satisfies ScrollRecord),
      )
    })()
  })

  onCleanup(() => view?.destroy())

  return <div class="code-view" ref={host} />
}
