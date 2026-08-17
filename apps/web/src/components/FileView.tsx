import type { EditorView } from '@codemirror/view'
import { createResource, Match, onCleanup, Show, Switch } from 'solid-js'
import { createReadonlyEditor } from '../lib/editor.ts'
import { client, setOpenFile } from '../lib/store/index.ts'
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
 * 输入区不藏：看着文件让模型改它，输入框正好在手边（同 `panel-max` 那条规矩，
 * 正文让位、输入框留着）。
 *
 * 默认导出给 `lazy()` 用：`CodeView` 拖着 CodeMirror 核心约 300 kB，
 * 只想聊天的用户不该为它付首屏成本。
 */
export default function FileView(props: { path: string }) {
  const [result] = createResource(
    () => props.path,
    (path) => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(path)}`),
  )

  return (
    <div class="preview">
      <header class="preview-head">
        <code class="truncate">{props.path}</code>
        <span class="spacer" />
        <button class="icon-btn" type="button" aria-label="关闭" onClick={() => setOpenFile(null)}>
          <IconX size={14} />
        </button>
      </header>

      <div class="preview-body">
        <Show when={result()} fallback={<div class="preview-loading" />}>
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

      <Show when={result()?.truncated}>
        <footer class="preview-foot">内容已截断</footer>
      </Show>
    </div>
  )
}

function CodeView(props: { content: string; path: string }) {
  let host!: HTMLDivElement
  let view: EditorView | null = null

  // 路径或内容变了就整块重建：CodeMirror 换语言包需要重建 state，
  // 增量更新反而更复杂且容易漏掉语言切换。
  const mount = async () => {
    view?.destroy()
    view = await createReadonlyEditor(host, props.content, props.path)
  }

  onCleanup(() => view?.destroy())

  return (
    <div
      class="code-view"
      ref={(el) => {
        host = el
        void mount()
      }}
    />
  )
}
