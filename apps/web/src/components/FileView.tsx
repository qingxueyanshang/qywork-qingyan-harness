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
  // 判据带上改动累计与手动刷新次数：只报路径的话，agent 改了正开着的文件，旁边的树
  // 刷新了而这块内容还是旧的；只报改动累计的话，用户点文件页刷新也重取不了正文。
  const [result] = createResource(
    () => `${props.path}:${fileRevision(props.path)}:${props.refresh ?? 0}`,
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
  /** 只有最后一次装配算数：语言包是动态 import，两次改动挨得近时后发的可能先到。 */
  let generation = 0

  // 路径或内容变了就整块重建：CodeMirror 换语言包需要重建 state，
  // 增量更新反而更复杂且容易漏掉语言切换。
  //
  // 装在 `createEffect` 里，不装在 `ref` 回调里：ref 只在建元素那一下跑一次，
  // 而外层的 `Show` 不是 keyed，内容变了这个组件实例是留着的。
  createEffect(() => {
    const content = props.content
    const path = props.path
    const mine = ++generation
    void (async () => {
      const next = await createReadonlyEditor(host, content, path)
      if (mine !== generation) {
        next.destroy()
        return
      }
      view?.destroy()
      view = next
    })()
  })

  onCleanup(() => view?.destroy())

  return <div class="code-view" ref={host} />
}
