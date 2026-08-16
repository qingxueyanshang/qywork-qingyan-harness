import type { EditorView } from '@codemirror/view'
import type { JSX } from 'solid-js'
import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { createReadonlyEditor } from '../lib/editor.ts'
import {
  client,
  closePanel,
  type PanelView,
  panelMaximized,
  previewPath,
  setPreviewPath,
  setSidePanel,
  sidePanel,
  state,
  togglePanelMax,
} from '../lib/store/index.ts'
import {
  IconBranch,
  IconCanvas,
  IconChevron,
  IconExpand,
  IconFile,
  IconFolder,
  IconGlobe,
  IconPlus,
  IconTerminal,
  IconX,
} from './Icons.tsx'
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
 * 三个固定视图。顺序即优先级。
 *
 * 写成一份清单而不是三段 JSX：标签页的外观改一次要改三处，改漏一处的表现是
 * 「有一格长得不一样」，而 CSS 不会为此报错。
 *
 * **这块面板只回答「这一轮在干什么」**：待办、文件、改动。配置类的东西
 * （角色编排、逐条能力开关）不进来——它们和「现在跑到哪了」不是同一个问题。
 */
const VIEWS: { view: PanelView; label: string }[] = [
  // 待办排在最前：它回答的是「这一轮在干什么」，比「有哪些文件」更靠前。
  { view: 'todos', label: '待办' },
  { view: 'files', label: '文件' },
  { view: 'git', label: '变更' },
]

/**
 * 「新开预览」看板上有哪几行。
 *
 * **没有 `open` 的那几行是后端还没接上的**，看板上置灰、点不动、行尾标「未接入」。
 * 这是用户点名要的形状：清单同时充当路线图。接上哪一项就给它补一个 `open`，
 * 看板那段 JSX 一行不用改。
 *
 * 现状（核过码，别照着标签猜）：只有「文件」有后端。终端在全项目都不存在
 * （`packages/core/src/protocol/transport.ts` 的说明），浏览器与无限画布没有服务端，
 * Word / PPT 不在 `packages/server/src/files.ts` 的分类表里，
 * Excel 虽然分到 `tabular`，但 xlsx 是二进制、走到 `looksBinary` 就退成
 * 「无法以文本预览」——真能开的只有 csv / tsv，那条路文件预览本来就有。
 */
const PREVIEW_SOURCES: {
  key: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  /** 缺席 = 这一项还没有后端。 */
  open?: () => void
}[] = [
  {
    key: 'file',
    label: '文件',
    icon: IconFile,
    // 先清掉上一次看的那个文件再切过去：不清的话点开「新开一个预览」，
    // 出来的是上次那份内容，看着像没生效。
    open: () => {
      setPreviewPath(null)
      setSidePanel('files')
    },
  },
  { key: 'terminal', label: '终端', icon: IconTerminal },
  { key: 'browser', label: '浏览器', icon: IconGlobe },
  { key: 'word', label: 'Word', icon: IconFile },
  { key: 'ppt', label: 'PPT', icon: IconFile },
  { key: 'excel', label: 'Excel', icon: IconFile },
  { key: 'canvas', label: '无限画布', icon: IconCanvas },
]

/**
 * 右侧面板容器。`VIEWS` 那几个视图共用同一块区域，互斥显示。
 *
 * 默认导出是为了给 `lazy()` 用：这个模块静态引入了 CodeMirror 核心（约 300 kB），
 * 放进首屏等于让「只想聊天的用户」为文件预览付费。
 */
export default function SidePanel() {
  /**
   * 看板是否盖在正文上。**局部信号，不进 `sidePanel`**：它不是第四个视图，
   * 收起面板再展开该回到用户上次看的那个视图，而不是回到「你想开点什么」。
   */
  const [board, setBoard] = createSignal(false)

  return (
    <Show when={sidePanel()}>
      <aside class="side-panel">
        <header class="side-head">
          <div class="side-tabs" role="tablist">
            <For each={VIEWS}>
              {(t) => (
                <button
                  class="side-tab"
                  classList={{ active: sidePanel() === t.view && !board() }}
                  type="button"
                  role="tab"
                  aria-selected={sidePanel() === t.view && !board()}
                  onClick={() => {
                    // 点页签即离开看板：不收的话页签亮了、正文还是看板，
                    // 看起来像这一下没生效。
                    setBoard(false)
                    setSidePanel(t.view)
                  }}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>

          <div class="side-actions">
            <button
              class="icon-btn"
              type="button"
              aria-label="新开预览"
              title="新开预览"
              aria-pressed={board()}
              onClick={() => setBoard((v) => !v)}
            >
              <IconPlus size={15} />
            </button>
            {/* 放大：正文让位，只留输入框和这块面板。窄屏不显示——那里的面板
                本来就盖满全屏，没有「放大」可言（样式见 utility.css）。 */}
            <button
              class="icon-btn panel-max-btn"
              type="button"
              aria-label={panelMaximized() ? '还原面板' : '放大面板'}
              aria-pressed={panelMaximized()}
              title={panelMaximized() ? '还原面板' : '放大面板'}
              onClick={togglePanelMax}
            >
              <IconExpand size={15} collapse={panelMaximized()} />
            </button>
            {/* 关闭只在窄屏出现（样式见 utility.css）。宽屏由顶栏那个开关管，
                这里再放一颗就是同一件事的第二个入口；窄屏的面板盖满全屏、把顶栏
                一起盖住了，不留这颗就没有出路。 */}
            <button
              class="icon-btn panel-close-btn"
              type="button"
              aria-label="关闭面板"
              onClick={closePanel}
            >
              <IconX size={15} />
            </button>
          </div>
        </header>

        <div class="side-body">
          <Show when={!board()} fallback={<PreviewBoard onPick={() => setBoard(false)} />}>
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
            </Switch>
          </Show>
        </div>
      </aside>
    </Show>
  )
}

/**
 * 新开预览看板。行由 `PREVIEW_SOURCES` 说了算。
 *
 * **长在面板正文里，不是浮层。** 浮层菜单只塞得下三四行、还盖住下面的内容；
 * 这块清单是「这块面板能开出什么」的全景，值得占满整块地方。
 *
 * 没有后端的那几行照样画出来，但 `disabled` 且标「未接入」——这是用户点名要的
 * 路线图式清单。注意它是本仓 B5「不做空壳」的一个例外，例外的边界就是
 * **必须点不动、必须标出来**：一个看起来能点、点下去没反应的行才是那条规则真正
 * 要挡的东西。
 */
function PreviewBoard(props: { onPick: () => void }) {
  return (
    <div class="preview-board">
      <For each={PREVIEW_SOURCES}>
        {(s) => (
          <button
            class="board-item"
            type="button"
            disabled={!s.open}
            onClick={() => {
              s.open?.()
              props.onPick()
            }}
          >
            <s.icon size={15} />
            <span class="board-label truncate">{s.label}</span>
            <Show when={!s.open}>
              <span class="board-tag">未接入</span>
            </Show>
          </button>
        )}
      </For>
    </div>
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
