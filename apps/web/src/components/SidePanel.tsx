import type { EditorView } from '@codemirror/view'
import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { createReadonlyEditor } from '../lib/editor.ts'
import {
  client,
  previewPath,
  setPreviewPath,
  setSidePanel,
  sidePanel,
  state,
} from '../lib/store/index.ts'
import { ExtrasPanel } from './ExtrasPanel.tsx'
import { IconBranch, IconChevron, IconFile, IconFolder, IconX } from './Icons.tsx'
import { TeamPanel } from './TeamPanel.tsx'
import { TodoPanel } from './TodoPanel.tsx'

interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  children?: FileNode[]
}

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
 * 右侧面板容器。文件 / git / 预览三个视图共用同一块区域，互斥显示。
 *
 * 默认导出是为了给 `lazy()` 用：这个模块静态引入了 CodeMirror 核心（约 300 kB），
 * 放进首屏等于让「只想聊天的用户」为文件预览付费。
 */
export default function SidePanel() {
  return (
    <Show when={sidePanel()}>
      <aside class="side-panel">
        <header class="side-head">
          <div class="side-tabs">
            {/* 待办排在最前：它回答的是「这一轮在干什么」，比「有哪些文件」更靠前。 */}
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'todos' }}
              type="button"
              onClick={() => setSidePanel('todos')}
            >
              待办
            </button>
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'files' }}
              type="button"
              onClick={() => setSidePanel('files')}
            >
              文件
            </button>
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'git' }}
              type="button"
              onClick={() => setSidePanel('git')}
            >
              变更
            </button>
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'team' }}
              type="button"
              onClick={() => setSidePanel('team')}
            >
              {/* 「协作」会被读成多人同时看同一份东西。这里是多个 agent 按角色
                  分工跑一件事，一个人都不涉及——名字必须把这件事说对。 */}
              Agent
            </button>
            <button
              class="side-tab"
              classList={{ active: sidePanel() === 'extras' }}
              type="button"
              onClick={() => setSidePanel('extras')}
            >
              {/* 「这一轮用什么」。设置页只管内容，开关全在这儿——
                  两处都放开关的话，用户分不清自己关掉的是这一轮还是所有会话。 */}
              能力
            </button>
          </div>
          <button
            class="icon-btn"
            type="button"
            aria-label="关闭面板"
            onClick={() => setSidePanel(null)}
          >
            <IconX size={15} />
          </button>
        </header>

        <div class="side-body">
          <Switch>
            <Match when={sidePanel() === 'todos'}>
              <TodoPanel />
            </Match>
            <Match when={sidePanel() === 'files'}>
              <FileBrowser />
            </Match>
            <Match when={sidePanel() === 'git'}>
              <GitChanges />
            </Match>
            <Match when={sidePanel() === 'team'}>
              <TeamPanel />
            </Match>
            <Match when={sidePanel() === 'extras'}>
              <ExtrasPanel />
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
  )
}

// ───────────────────────── 文件浏览 ─────────────────────────

function FileBrowser() {
  const [tree] = createResource(
    // 依赖 fileChanges 长度：agent 改了文件后自动刷新树，
    // 不需要用户手动点刷新。
    () => state.fileChanges.length,
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=2'),
  )

  return (
    <div class="file-browser">
      <Show when={previewPath()} fallback={<Tree nodes={tree()?.nodes ?? []} depth={0} />}>
        {(p) => <FilePreview path={p()} />}
      </Show>
    </div>
  )
}

function Tree(props: { nodes: FileNode[]; depth: number }) {
  return (
    <ul class="tree" style={{ '--depth': String(props.depth) }}>
      <For each={props.nodes}>{(node) => <TreeNode node={node} depth={props.depth} />}</For>
    </ul>
  )
}

function TreeNode(props: { node: FileNode; depth: number }) {
  const [open, setOpen] = createSignal(false)
  const [children, setChildren] = createSignal<FileNode[] | null>(null)

  const toggle = async () => {
    const next = !open()
    setOpen(next)
    // 子目录懒加载：一次性拉整棵树在大仓库上会拖几秒，而用户通常只展开一两层。
    if (next && children() === null) {
      const res = await client.api<{ nodes: FileNode[] }>(
        `/api/files/tree?path=${encodeURIComponent(props.node.path)}&depth=1`,
      )
      setChildren(res.nodes)
    }
  }

  return (
    <li>
      <Show
        when={props.node.kind === 'dir'}
        fallback={
          <button
            class="tree-item"
            type="button"
            style={{ 'padding-left': `${props.depth * 12 + 8}px` }}
            onClick={() => setPreviewPath(props.node.path)}
          >
            <IconFile size={13} />
            <span class="truncate">{props.node.name}</span>
          </button>
        }
      >
        <button
          class="tree-item"
          type="button"
          style={{ 'padding-left': `${props.depth * 12 + 8}px` }}
          onClick={toggle}
        >
          <IconChevron size={11} dir={open() ? 'down' : 'right'} />
          <IconFolder size={13} />
          <span class="truncate">{props.node.name}</span>
        </button>
        <Show when={open()}>
          <Tree nodes={children() ?? props.node.children ?? []} depth={props.depth + 1} />
        </Show>
      </Show>
    </li>
  )
}

// ───────────────────────── 文件预览 ─────────────────────────

function FilePreview(props: { path: string }) {
  const [result] = createResource(
    () => props.path,
    (path) => client.api<PreviewResult>(`/api/files/preview?path=${encodeURIComponent(path)}`),
  )

  return (
    <div class="preview">
      <header class="preview-head">
        <button
          class="icon-btn"
          type="button"
          aria-label="返回"
          onClick={() => setPreviewPath(null)}
        >
          <IconChevron size={14} dir="right" style={{ transform: 'rotate(180deg)' }} />
        </button>
        <code class="truncate">{props.path}</code>
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

// ───────────────────────── git 变更 ─────────────────────────

interface GitFileEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
}
interface GitStatus {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  conflicted: number
  files: GitFileEntry[]
}
interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  lastCommitSubject: string
}

function GitChanges() {
  const [status] = createResource(
    () => state.fileChanges.length,
    () => client.api<{ repo: boolean; status: GitStatus | null }>('/api/git/status'),
  )
  const [branches] = createResource(() =>
    client.api<{ branches: GitBranch[] }>('/api/git/branches'),
  )
  const [selected, setSelected] = createSignal<string | null>(null)
  const [branchOpen, setBranchOpen] = createSignal(false)

  return (
    <div class="git-panel">
      <Show when={status()?.repo} fallback={<div class="preview-note">不是 git 仓库</div>}>
        <Show when={status()?.status}>
          {(s) => (
            <>
              {/* 分支落在这里，而不是侧边栏。
                  它曾经是左侧导航的一个顶级项（且是个死按钮）——那个位置回答的是
                  「我要去哪个页面」，而分支回答的是「这次改动在哪条线上」。
                  后者是审阅的语境，所以它属于变更视图的顶部。

                  收起态只显示当前分支与领先/落后，展开才列全部：一个常驻展开的
                  分支列表会把真正要看的「改了哪些文件」挤到屏幕外。 */}
              <div class="branch-bar">
                <button
                  class="branch-chip"
                  type="button"
                  aria-expanded={branchOpen()}
                  onClick={() => setBranchOpen((v) => !v)}
                >
                  <IconBranch size={13} />
                  <span class="truncate">{s().branch || 'detached'}</span>
                  <Show when={s().ahead > 0}>
                    <span class="git-count">↑{s().ahead}</span>
                  </Show>
                  <Show when={s().behind > 0}>
                    <span class="git-count">↓{s().behind}</span>
                  </Show>
                  <IconChevron size={11} dir={branchOpen() ? 'down' : 'right'} />
                </button>
              </div>

              <Show when={branchOpen()}>
                <ul class="git-branches">
                  <For each={branches()?.branches ?? []}>
                    {(b) => (
                      <li class="git-branch" classList={{ current: b.current }}>
                        <span class="truncate">{b.name}</span>
                        <Show when={b.ahead > 0}>
                          <span class="git-count">↑{b.ahead}</span>
                        </Show>
                        <Show when={b.behind > 0}>
                          <span class="git-count">↓{b.behind}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              {/* 冲突挡在改动列表之前：让 agent 在未解决冲突的树上继续改是在制造更大麻烦 */}
              <Show when={s().conflicted > 0}>
                <div class="git-conflict">{s().conflicted} 个文件存在冲突，先解决再继续</div>
              </Show>

              <section class="git-section">
                <div class="git-section-head">改动 {s().files.length}</div>
                <ul class="git-files">
                  <For each={s().files}>
                    {(f) => (
                      <li>
                        <button
                          class="git-file"
                          classList={{ active: selected() === f.path }}
                          type="button"
                          onClick={() => setSelected(selected() === f.path ? null : f.path)}
                        >
                          <span class="git-flag" data-status={statusOf(f)}>
                            {statusOf(f)}
                          </span>
                          <span class="truncate">{f.path}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>

              <Show when={selected()}>{(p) => <DiffView path={p()} />}</Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

function DiffView(props: { path: string }) {
  const [diff] = createResource(
    () => props.path,
    (path) => client.api<{ diff: string }>(`/api/git/diff?path=${encodeURIComponent(path)}`),
  )
  return (
    <div class="diff">
      <Show when={diff()} fallback={<div class="preview-loading" />}>
        {(d) => (
          <pre class="diff-body">
            <For each={d().diff.split('\n')}>
              {(line) => (
                <div class="diff-line" data-kind={diffKind(line)}>
                  {line}
                </div>
              )}
            </For>
          </pre>
        )}
      </Show>
    </div>
  )
}

function diffKind(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** porcelain v2 的状态码取更显著的一位显示；'?' 是未跟踪。 */
function statusOf(f: GitFileEntry): string {
  if (f.indexStatus === '?') return '?'
  if (f.indexStatus === 'U' || f.worktreeStatus === 'U') return '!'
  if (f.indexStatus !== '.') return f.indexStatus
  return f.worktreeStatus
}
