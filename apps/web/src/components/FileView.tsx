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
import { createReadonlyEditor } from '../lib/editor.ts'
import { loaded } from '../lib/resource.ts'
import { absPath, client, explainApiError, setOpenFile } from '../lib/store/index.ts'
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
 * 打开的文件长在**主内容区**，不在右侧面板里。
 *
 * 面板那一列只有 `--panel-w` 宽，代码每行都要折；而看文件时文件树必须还在，
 * 否则「看下一个」得先返回。所以树留在面板、内容占主区——两块同时看得见。
 *
 * 输入区仍可随时唤出：面板放大时默认收在底部，悬浮或聚焦才展开，避免长期遮住
 * 正在看的文件；有草稿时保持展开。
 *
 * 默认导出给 `lazy()` 用：`CodeView` 拖着 CodeMirror 核心约 300 kB，
 * 只想聊天的用户不该为它付首屏成本。
 */
export default function FileView(props: { path: string; refresh?: number }) {
  // 路径与文件页的统一失效序号直接走资源判据。失效序号不在 `run.started` 清空，
  // 因此发起新一轮不会把“摘要从非空变空”误判成一次磁盘改动。
  const [result] = createResource(
    () => `${props.path}:${props.refresh ?? 0}`,
    () => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(props.path)}`),
  )

  return (
    <div class="preview">
      <header class="preview-head">
        {/* **完整的本机路径**，不是工作区相对路径：根目录下的文件相对路径就只剩一个
            文件名，看不出它在哪个项目里。挤不下时从左边截——尾部的文件名比盘符要紧。 */}
        <code class="truncate-left" data-tip={absPath(props.path)}>
          {/* `dir="ltr"` 是这一对里不能省的一半：外层 `rtl` 把省略号挪到左边，
              内层 `ltr` 保证路径本身还是正着读的。只写外层，`C:\` 会跑到右边去。 */}
          <span dir="ltr">{absPath(props.path)}</span>
        </code>
        <span class="spacer" />
        <button class="icon-btn" type="button" aria-label="关闭" onClick={() => setOpenFile(null)}>
          <IconX size={14} />
        </button>
      </header>

      <div class="preview-body">
        {/* 取不回来要给一句话。`loaded()` 而不是 `result()`：后者出错时是 `throw`，
            而这一层外面只有给 `lazy()` 用的 Suspense，接不住抛出来的错——
            表现是这块地方永远停在加载态。 */}
        <Show
          when={loaded(result)}
          fallback={
            <Show when={result.error} fallback={<div class="preview-loading" />}>
              {(e) => <div class="preview-note">{explainApiError(e(), '打不开这个文件')}</div>}
            </Show>
          }
        >
          {(r) => (
            <Switch fallback={<div class="preview-note">{r().note ?? '无法预览'}</div>}>
              <Match when={r().kind === 'text' || r().kind === 'tabular'}>
                <CodeView content={r().content ?? ''} path={r().path} />
              </Match>
              <Match when={rawKind(r().kind)}>
                {(kind) => <RawView kind={kind()} path={r().path} mtime={r().mtime} />}
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

type RawKind = 'pdf' | 'image' | 'video' | 'audio'

function rawKind(kind: PreviewResult['kind']): RawKind | null {
  return kind === 'pdf' || kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null
}

/**
 * PDF、图片与音视频：取原始字节做成 blob URL 交给对应元素。PDF 由 WebView 内建的阅读器渲染。
 *
 * - 用 blob URL，不用 data URI：桌面端 CSP 的 `frame-src` 只放行 `blob:`；data URI 还要整份 base64 进 JSON。
 * - 不直接把 `/api/files/raw` 填进 `src`：那条接口认 Authorization 头，元素自己发的请求带不上。
 *   代价是整份字节进内存、不支持 Range 拖动加载。
 * - 只在路径或修改时间变了才重取。判据必须经 memo 且是字符串：预览每重取一次都返回一个新对象，
 *   直接依赖它的话，会话里任何一次写文件都会让阅读器重新加载、回到第一页；只看修改时间的话，
 *   同一个预览里换到修改时间恰好相同的另一个文件时不会重取，显示的还是上一个文件。
 * - blob URL 换下来就撤销，卸载时撤销最后一个：不撤销的话整份字节占着内存直到整页刷新。
 */
function RawView(props: { kind: RawKind; path: string; mtime: number }) {
  const [src, setSrc] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const source = createMemo(() => JSON.stringify([props.path, props.mtime]))

  const replace = (next: string | null) => {
    const old = src()
    setSrc(next)
    if (old) URL.revokeObjectURL(old)
  }

  /** 只有最后一次请求算数：文件连续改写时先发的可能后到。 */
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
      {(u) => (
        <Switch>
          <Match when={props.kind === 'pdf'}>
            <iframe class="preview-frame" src={u()} title={props.path} />
          </Match>
          <Match when={props.kind === 'image'}>
            <img class="preview-media" src={u()} alt={props.path} />
          </Match>
          <Match when={props.kind === 'video'}>
            <video class="preview-media" src={u()} controls />
          </Match>
          <Match when={props.kind === 'audio'}>
            <audio class="preview-audio" src={u()} controls />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function CodeView(props: { content: string; path: string }) {
  let host!: HTMLDivElement
  let view: EditorView | null = null
  let mountedPath: string | null = null
  /** 只有最后一次装配算数：语言包是动态 import，两次改动挨得近时后发的可能先到。 */
  let generation = 0

  // 只有路径变了才整块重建（语言包跟路径走）。同一个文件的正文更新直接派发到
  // 现有 CodeMirror：重建实例会把 `.cm-scroller` 换掉，用户读到中间时就回到顶部。
  //
  // 装在 `createEffect` 里，不装在 `ref` 回调里：ref 只在建元素那一下跑一次，
  // 而外层的 `Show` 不是 keyed，内容变了这个组件实例是留着的。
  createEffect(() => {
    const content = props.content
    const path = props.path
    const mine = ++generation

    if (view && mountedPath === path) {
      if (view.state.doc.toString() === content) return
      const { scrollLeft, scrollTop } = view.scrollDOM
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      // 全文替换会重算文档高度；恢复像素位置，内容变短时浏览器自然夹到新的底部。
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
    })()
  })

  onCleanup(() => view?.destroy())

  return <div class="code-view" ref={host} />
}
