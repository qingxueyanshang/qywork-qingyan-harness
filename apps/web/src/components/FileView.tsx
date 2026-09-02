import type { EditorView } from '@codemirror/view'
import { createEffect, createResource, Match, onCleanup, Show, Switch } from 'solid-js'
import { createReadonlyEditor } from '../lib/editor.ts'
import { loaded } from '../lib/resource.ts'
import { absPath, client, explainApiError, fileRevision, setOpenFile } from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'

interface PreviewResult {
  path: string
  kind: 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'tabular' | 'archive' | 'binary'
  mime: string
  size: number
  content?: string
  language?: string
  dataUri?: string
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
  // 路径与手动刷新直接走资源判据。agent 的改动累计不能直接拼在这里：新一轮
  // `run.started` 会把「上一轮改了哪些文件」清空，非空 → 空也会被资源当成一次变化，
  // 因此用户每发一条消息，没变的文件也重取、阅读位置跟着回到开头。
  const [result, { refetch }] = createResource(
    () => `${props.path}:${props.refresh ?? 0}`,
    () => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(props.path)}`),
  )

  let watchedPath = props.path
  let previousRevision = fileRevision(watchedPath)
  createEffect(() => {
    const path = props.path
    const revision = fileRevision(path)
    if (path !== watchedPath) {
      watchedPath = path
      previousRevision = revision
      return
    }

    // 空值只是新一轮开始时清掉了摘要，不代表磁盘内容变回去了；记下这道边界但不重取。
    // 下一轮即使产生了和上一轮完全相同的 +x/-y，空 → 非空仍会触发一次真实刷新。
    const changed = revision !== '' && revision !== previousRevision
    previousRevision = revision
    if (changed) void refetch()
  })

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
              <Match when={r().kind === 'image'}>
                <img class="preview-media" src={r().dataUri} alt={r().path} />
              </Match>
              <Match when={r().kind === 'pdf'}>
                {/* WKWebView 和 WebView2 都内建 PDF 渲染，不需要额外的 JS 阅读器 */}
                <iframe class="preview-frame" src={r().dataUri} title={r().path} />
              </Match>
              <Match when={r().kind === 'video'}>
                <video class="preview-media" src={r().dataUri} controls />
              </Match>
              <Match when={r().kind === 'audio'}>
                <audio class="preview-audio" src={r().dataUri} controls />
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
