import type { FileChange } from '@qywork/core'
import type { JSX } from 'solid-js'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
} from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { loaded } from '../lib/resource.ts'
import { clamp, diffFrom, firstString } from '../lib/step-view.ts'
import {
  absPath,
  activePanelTab,
  client,
  closePanel,
  closePanelTab,
  explainApiError,
  isDesktopShell,
  openFile,
  openFileInPanel,
  openPanelTab,
  type PanelView,
  panelMaximized,
  panelTabs,
  panelWidth,
  resizePanel,
  revealWorkspace,
  setOpenFile,
  setSidePanel,
  sidePanel,
  state,
  togglePanelMax,
  transcript,
  workspace,
} from '../lib/store/index.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  IconCanvas,
  IconChevron,
  IconCollapseAll,
  IconExpand,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconTerminal,
  IconX,
} from './Icons.tsx'
import { TodoPanel } from './TodoPanel.tsx'

// 懒加载：xterm 及其样式只有真的开终端才下载。手机端和浏览器根本开不出这一页，
// 静态引入会让它们多下载一份永远不执行的代码。
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx'))

// 同样懒加载：不开浏览器页的人不必为它付首屏成本。
const BrowserPanel = lazy(() => import('./BrowserPanel.tsx'))

// 子会话页：只有从工具卡上点开子 agent 才会加载。
const ConversationPanel = lazy(() => import('./ConversationPanel.tsx'))

// 外部 CLI 页：只有从图卡上点开 CLI 节点才会加载。
const CliPanel = lazy(() => import('./CliPanel.tsx'))

// 同样懒加载：它带着 CodeMirror 核心（约 300 kB），而只看待办 / 变更的人碰不到它。
const FileView = lazy(() => import('./FileView.tsx'))

// 同样懒加载：运行那一页一挂上就去拉两个接口，不翻到它的人不该为它付首屏成本。
const RunDetails = lazy(() => import('./RunDetails.tsx'))

interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  children?: FileNode[]
}

/**
 * 固定的那几页。顺序即优先级。**它们关不掉，永远在页签条最前面。**
 *
 * 写成一份清单而不是几段 JSX：标签页的外观改一次要改每一处，改漏一处的表现是
 * 「有一格长得不一样」，而 CSS 不会为此报错。
 *
 * **它们回答「这一轮在干什么」**：待办、文件、改动、账。配置类的页（角色编排、
 * 逐条能力开关）不进来——它们和「现在跑到哪了」不是同一个问题。
 *
 * 终端和浏览器不在这里：那两种是**可多开、可关掉**的页，由 `+` 新开、页签上带 ×，
 * 清单在 `panelTabs`。
 */
const VIEWS: { view: PanelView; label: string }[] = [
  // 待办排在最前：它回答的是「这一轮在干什么」，比「有哪些文件」更靠前。
  { view: 'todos', label: '待办' },
  { view: 'files', label: '文件' },
  { view: 'changes', label: '变更' },
  // 运行排在末位：查账是事后动作，不与「现在在做什么」争第一眼。
  { view: 'runs', label: '运行' },
]

/** 桌面外壳判定一次就够：它在一次运行里不会变。 */
const DESKTOP = isDesktopShell()

/**
 * 「新开预览」看板上有哪几行。**每一行都是新开一页**，所以固定的那几格不在这里
 * ——它们一直在页签条上，列进来点了也不会新开一页。
 *
 * **没有 `open` 的那几行是后端还没接上的**，看板上置灰、点不动、行尾标「未接入」。
 * 这是用户点名要的形状：清单同时充当路线图。接上哪一项就给它补一个 `open`，
 * 看板那段 JSX 一行不用改。
 *
 * 现状（核过码，别照着标签猜）：终端在 Rust 侧有 PTY，只在桌面端有；浏览器就是一个
 * iframe，每一端都有。无限画布没有实现；Word / PPT 不在
 * `packages/server/src/files.ts` 的分类表里；Excel 虽然分到 `tabular`，但 xlsx 是
 * 二进制、走到 `looksBinary` 就退成「无法以文本预览」——真能开的只有 csv / tsv，
 * 那条路文件那一页本来就有。
 */
const PREVIEW_SOURCES: {
  key: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  /** 缺席 = 这一项还没有后端。 */
  open?: () => void
  /** 这一端不可能有，整行不渲染——和「以后会接上」的置灰是两回事。 */
  desktopOnly?: true
}[] = [
  {
    key: 'terminal',
    label: '终端',
    icon: IconTerminal,
    desktopOnly: true,
    open: () => openPanelTab('terminal'),
  },
  { key: 'browser', label: '浏览器', icon: IconGlobe, open: () => openPanelTab('browser') },
  { key: 'word', label: 'Word', icon: IconFile },
  { key: 'ppt', label: 'PPT', icon: IconFile },
  { key: 'excel', label: 'Excel', icon: IconFile },
  { key: 'canvas', label: '无限画布', icon: IconCanvas },
]

const BOARD_ROWS = PREVIEW_SOURCES.filter((s) => DESKTOP || !s.desktopOnly)

/**
 * 右侧面板容器。固定的那几格（`VIEWS`）和可多开的那些页（`panelTabs`）共用同一块区域，
 * 互斥显示。
 *
 * 默认导出是为了给 `lazy()` 用：这个模块静态引入了 CodeMirror 核心（约 300 kB），
 * 放进首屏等于让「只想聊天的用户」为文件预览付费。
 */
export default function SidePanel() {
  /**
   * 看板是否盖在正文上。**局部信号，不进 `sidePanel`**：它不是第四个视图，
   * 收起面板再展开该回到用户上次看的那个视图，而不是回到新开预览看板。
   */
  const [board, setBoard] = createSignal(false)

  /** 页签亮不亮。看板盖着时哪一格都不亮——那时正文不是它们任何一个。 */
  const onView = (view: PanelView) => sidePanel() === view && !board()
  const onTab = (id: string) => activePanelTab() === id && !board()

  return (
    <Show when={sidePanel()}>
      <aside class="side-panel">
        {/*
         * 拖左边沿改整块面板的宽度。
         *
         * `setPointerCapture` 是必须的：不捕获的话指针一滑到 iframe / CodeMirror
         * 上面，`pointermove` 就断给了那一层，拖动会在半路停住。
         *
         * 用 `<button>` 而不是 `role="separator"` 的 div：焦点、键盘语义、
         * 屏幕阅读器播报都由元素自带，而那个 role 还要求自己补 `tabindex` 与
         * `aria-valuenow`，补齐了 lint 也照样要抑制两条规则。
         * 左右方向键一档 24px——拿得到焦点就得能用键盘改。
         * 窄屏不显示（那里的面板盖满全屏，见 utility.css）。
         */}
        <button
          class="panel-grip"
          type="button"
          aria-label="拖动改变面板宽度"
          data-tip="拖动改变宽度"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            e.preventDefault()
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              resizePanel(window.innerWidth - e.clientX)
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            resizePanel(panelWidth() + (e.key === 'ArrowLeft' ? 24 : -24))
          }}
        />
        <header class="side-head">
          <div class="side-tabs" role="tablist">
            <For each={VIEWS}>
              {(t) => (
                <button
                  class="side-tab"
                  classList={{ active: onView(t.view) }}
                  type="button"
                  role="tab"
                  aria-selected={onView(t.view)}
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
            {/*
             * 可多开的那些页接在固定的那几格后面，各自带一颗 ×。
             *
             * 外面套一个 div 而不是把 × 塞进页签那颗按钮里：**button 套 button 是
             * 非法 HTML**，浏览器会把内层那颗提到外面去，因此点页签名字变成点关闭。
             * 外层只是个盒子（`role="presentation"`），`role="tab"` 落在名字那颗上。
             */}
            <For each={panelTabs()}>
              {(t) => (
                <div
                  class="side-tab closable"
                  classList={{ active: onTab(t.id) }}
                  role="presentation"
                >
                  <button
                    class="tab-name"
                    type="button"
                    role="tab"
                    aria-selected={onTab(t.id)}
                    onClick={() => {
                      setBoard(false)
                      setSidePanel({ tab: t.id })
                    }}
                  >
                    <span class="truncate">{t.title}</span>
                  </button>
                  <button
                    class="icon-btn tab-close"
                    type="button"
                    aria-label={`关闭 ${t.title}`}
                    onClick={() => closePanelTab(t.id)}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              )}
            </For>
          </div>

          <div class="side-actions">
            <button
              class="icon-btn"
              type="button"
              aria-label="新开预览"
              data-tip="新开预览"
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
              data-tip={panelMaximized() ? '还原面板' : '放大面板'}
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
          {/*
           * **换项目就把这一整块重挂一遍**（`keyed` 的 Show 按项目 id）。
           *
           * 面板里到处是「按路径记的状态」：树展开了哪些目录、子层缓存、选中的那一行、
           * 正在看哪个 diff。它们都是局部状态，换项目后每一条都指着上一个项目：
           * 树是新的、旁边那半还是旧的，点击不产生任何响应。
           *
           * 逐个清一遍是行不通的：那是一份「所有局部状态」的清单，加一个 signal 就漏一条。
           * 重挂是唯一不会漏的做法。`openFile` 与可多开的那些页不在这里——它们在 store
           * 里，由 `activateWorkspace` 清（那边有注释）。终端尤其不能靠重挂收：
           * PTY 在 Rust 侧，只认显式关闭。
           */}
          <Show when={workspace()?.id} keyed>
            {/*
             * 看板打开时这一叠只是**藏起来，不卸载**。
             *
             * 卸载的代价是真的：终端页卸载会把 xterm 实例摘出面板（见那边的模块级
             * `panes`），浏览器页的 iframe 一从 DOM 里出去就要重新加载。而看板只是
             * 「想开点什么」的一张清单，不该连带重建已经开着的页。
             */}
            <div class="side-stack" classList={{ hidden: board() }}>
              <Switch>
                <Match when={sidePanel() === 'todos'}>
                  <TodoPanel />
                </Match>
                <Match when={sidePanel() === 'files'}>
                  <FileBrowser />
                </Match>
                <Match when={sidePanel() === 'changes'}>
                  <ChangeRecord />
                </Match>
                <Match when={sidePanel() === 'runs'}>
                  {/* 自带 Suspense，理由同下面那几页：没有边界的话它挂起时整棵树跟着空一下。 */}
                  <Suspense fallback={<div class="pane-loading" />}>
                    <RunDetails />
                  </Suspense>
                </Match>
              </Switch>

              {/*
               * 可多开的那些页**全都挂着，只有当前那一页显示**（`.tab-pane.active`）。
               *
               * 不做成「只挂当前那一页」：终端里的命令要接着跑、滚动历史要留着，
               * iframe 里的页面不该因为切了一下页签就重新加载。
               *
               * 每一页自带 `Suspense`：xterm 那一包三百多 K，没有边界的话它挂起时
               * 整棵树跟着空一下（同 `App.tsx` 里那段）。
               */}
              <For each={panelTabs()}>
                {(t) => (
                  <div class="tab-pane" classList={{ active: activePanelTab() === t.id }}>
                    <Suspense fallback={<div class="pane-loading" />}>
                      <Switch fallback={<BrowserPanel id={t.id} />}>
                        <Match when={t.kind === 'terminal'}>
                          <TerminalPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'conversation'}>
                          <ConversationPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'cli'}>
                          <CliPanel id={t.id} />
                        </Match>
                      </Switch>
                    </Suspense>
                  </div>
                )}
              </For>
            </div>
            <Show when={board()}>
              <PreviewBoard onPick={() => setBoard(false)} />
            </Show>
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
 * **必须点不动、必须标出来**：那条规则要挡的正是「看起来能点、点下去没反应」
 * 的行。
 */
function PreviewBoard(props: { onPick: () => void }) {
  return (
    <div class="preview-board">
      <For each={BOARD_ROWS}>
        {(s) => (
          <button
            class="board-item"
            type="button"
            disabled={!s.open}
            onClick={() => {
              // **先收看板，再开那一页。** 反过来的话新那一页会在 `display: none`
              // 的容器里挂载，而 xterm 一挂上就去量字符宽高——量到 0 要等下一次
              // 尺寸变化才会重新量。
              props.onPick()
              s.open?.()
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

/**
 * 树的共享操作。**展开态、子层缓存、正在编辑的那一行都不在节点里**——
 * 「全部折叠」「刷新」要一次管到所有节点，而新建那一行要能出现在任意目录下面；
 * 散在每个 `TreeNode` 的局部信号里的话，这几件事没有一处操作得了全部节点。
 */
interface TreeCtx {
  expanded(): ReadonlySet<string>
  toggle(node: FileNode): void
  /** `null` = 这一层还没取回来（刷新会把它清成 `null`，展开着的目录自己重取）。 */
  childrenOf(path: string): FileNode[] | null
  load(path: string): void
  selected(): string | null
  pick(node: FileNode): void
  menu(node: FileNode, x: number, y: number): void
  /** 正在这个目录下面新建。`dir` 是工作区相对路径，根是空串。 */
  creating(): { kind: 'file' | 'dir'; dir: string } | null
  /** 正在给这个路径改名。 */
  renaming(): string | null
  submitName(name: string): void
  cancelName(): void
  /** 上一次提交名字撞上的回话（重名等）。 */
  nameError(): string | null
}

const parentDir = (path: string) => path.split('/').slice(0, -1).join('/')

/**
 * 工作区根**也是一个可选中的节点**，路径是空串。
 *
 * 不给它一个节点的话，「选中根、然后新建」就得靠「什么都没选」来表达，而那和
 * 「刚打开面板、还没点过任何一行」是同一个状态——用户点了一下根，界面上什么都
 * 不该发生就说不通了。名字由 `workspace()` 给，这里只当占位。
 */
const ROOT_NODE: FileNode = { name: '', path: '', kind: 'dir', size: 0, mtime: 0 }

function FileBrowser() {
  const [tree, { refetch }] = createResource(
    // 依赖 fileChanges 长度：agent 改了文件后自动刷新树，
    // 不需要用户手动点刷新。
    () => state.fileChanges.length,
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=2'),
  )

  /**
   * 树取不回来时的那句话。
   *
   * **不要换回 `tree()` 或 `tree.latest`**：两者在出错时都是 `throw`，而这个应用
   * 没有 `ErrorBoundary`，抛出去没人接。`loaded()` 只给值，错误从 `tree.error` 单独读。
   */
  const treeError = () => (tree.error ? explainApiError(tree.error, '读取失败') : null)

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [kids, setKids] = createSignal<ReadonlyMap<string, FileNode[]>>(new Map())
  /** 选中的那一行。它同时是「新建到哪里」的落点，所以文件和目录都记。 */
  const [selected, setSelected] = createSignal<FileNode | null>(null)
  const [creating, setCreating] = createSignal<{ kind: 'file' | 'dir'; dir: string } | null>(null)
  const [renaming, setRenaming] = createSignal<FileNode | null>(null)
  const [nameError, setNameError] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ node: FileNode; x: number; y: number } | null>(null)
  const [doomed, setDoomed] = createSignal<FileNode | null>(null)
  const [query, setQuery] = createSignal('')
  const [rootOpen, setRootOpen] = createSignal(true)
  /**
   * 手动刷新的是整个文件页，不只是左边那棵树。
   *
   * 当前文件预览有自己的 resource；只调树的 `refetch()`，右边正文会继续停在旧内容上，
   * 用户看到的就是「刷新点不动」。这个递增值只表达一次命令，不另存任何文件状态。
   */
  const [manualRefresh, setManualRefresh] = createSignal(0)

  // 子目录懒加载：一次性拉整棵树在大仓库上会拖几秒（树不过滤，`node_modules`
  // 也在里面），而用户通常只展开一两层。
  const loadDir = (path: string) => {
    void client
      .api<{ nodes: FileNode[] }>(`/api/files/tree?path=${encodeURIComponent(path)}&depth=1`)
      .then((res) => setKids((m) => new Map(m).set(path, res.nodes)))
  }

  /**
   * 新建 / 改名 / 删除之后，那一层要**当场重取并覆盖缓存**。
   *
   * 不是「从缓存里删掉、等它自己重取」：`TreeNode` 取不到缓存时会回落到根那次
   * `depth=2` 带回来的 `node.children`，那份是旧的——删掉缓存的结果是树纹丝不动，
   * 看起来像新建没生效。根那一层没有上一级可取，走 `refetch()`。
   */
  const invalidate = (dir: string) => {
    if (!dir) {
      void refetch()
      return
    }
    setExpanded((s) => new Set(s).add(dir))
    loadDir(dir)
  }

  const ctx: TreeCtx = {
    expanded,
    childrenOf: (path) => kids().get(path) ?? null,
    /*
     * 高亮哪一行**只由 `selected` 说了算**。
     *
     * 别把「主区开着哪个文件」（`openFile`）也算进来：那是两个权威争同一处高亮，
     * 结果是点文件夹不亮（高亮留在打开的文件上），而点文件看着像「选中没留住」。
     * 现在的口径和资源管理器一致：**最后点的那一行是选中的行**，一直亮着，
     * 直到点别的行。
     */
    selected: () => renaming()?.path ?? selected()?.path ?? null,
    load: loadDir,
    toggle: (node) => {
      setSelected(node)
      setExpanded((s) => {
        const next = new Set(s)
        if (!next.delete(node.path)) next.add(node.path)
        return next
      })
    },
    pick: (node) => {
      setSelected(node)
      openFileInPanel(node.path)
    },
    menu: (node, x, y) => {
      setSelected(node)
      setMenuAt({ node, x, y })
    },
    creating,
    renaming: () => renaming()?.path ?? null,
    nameError,
    cancelName: () => {
      setCreating(null)
      setRenaming(null)
      setNameError(null)
    },
    submitName: (raw) => {
      const name = raw.trim()
      if (!name) return
      const job = renaming()
      const make = creating()
      void (async () => {
        try {
          if (job) {
            const { node } = await client.api<{ node: FileNode }>('/api/files/rename', {
              method: 'POST',
              body: JSON.stringify({ path: job.path, name }),
            })
            setRenaming(null)
            setNameError(null)
            invalidate(parentDir(node.path))
            setSelected(node)
            // 改的正是主区开着的那个文件：路径变了，跟着换过去，不然它指向一个没了的路径。
            if (openFile() === job.path && node.kind === 'file') openFileInPanel(node.path)
          } else if (make) {
            const path = make.dir ? `${make.dir}/${name}` : name
            const { node } = await client.api<{ node: FileNode }>('/api/files/create', {
              method: 'POST',
              body: JSON.stringify({ path, kind: make.kind }),
            })
            setCreating(null)
            setNameError(null)
            invalidate(make.dir)
            setSelected(node)
            if (node.kind === 'file') openFileInPanel(node.path)
          }
        } catch (err) {
          // `detail` 是服务端那一句话（「x 已存在」），不是带状态码和路径的整行。
          setNameError(err instanceof ApiError ? err.detail : String(err))
        }
      })()
    },
  }

  /** 新建落在选中的目录里；选中的是文件就落在它旁边；什么都没选就落在根。 */
  const newIn = (kind: 'file' | 'dir') => {
    const s = selected()
    const dir = !s ? '' : s.kind === 'dir' ? s.path : parentDir(s.path)
    setRenaming(null)
    setNameError(null)
    setCreating({ kind, dir })
    // 要新建的那一行在这个目录下面，先把它展开，不然输入框在收起的层里。
    if (dir) setExpanded((s2) => new Set(s2).add(dir))
    setRootOpen(true)
  }

  const remove = (node: FileNode) => {
    void client
      .api('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: node.path }) })
      .then(() => {
        invalidate(parentDir(node.path))
        if (openFile() === node.path) setOpenFile(null)
        if (selected()?.path === node.path) setSelected(null)
      })
      .finally(() => setDoomed(null))
  }

  return (
    /*
     * **树在左、文件内容在右**，同一块面板里。
     *
     * 树不占满整块：它是索引，宽度固定；正文才是要读的部分，占剩下的全部。
     * 整块面板的宽度由用户拖左边沿改（`.panel-grip`）——两块并排必然要求这个，
     * 不给拖的话内容那半永远只有一百多像素。
     */
    <div class="file-browser">
      <div class="file-tree-col">
        {/* 搜索在最上面一行：它是这块树的入口，不该排在树的操作后面。 */}
        <input
          class="tree-search"
          type="search"
          placeholder="搜索名称"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />

        {/* 根目录行：四颗按钮长在这一行上，选中态与 hover 画在整行上。
            两条的理由都在 `panel.css` 的 `.tree-root` 上。 */}
        <div class="tree-root" classList={{ selected: ctx.selected() === '' }}>
          <button
            class="tree-item tree-root-name"
            type="button"
            onClick={() => {
              setSelected(ROOT_NODE)
              setRootOpen((v) => !v)
            }}
          >
            <IconChevron size={11} dir={rootOpen() ? 'down' : 'right'} />
            <IconFolder size={13} />
            <span class="truncate">{workspace()?.name ?? '工作区'}</span>
          </button>
          <div class="tree-root-acts">
            <button
              class="icon-btn"
              type="button"
              aria-label="新建文件"
              data-tip="新建文件"
              onClick={() => newIn('file')}
            >
              <IconFilePlus size={14} />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="新建文件夹"
              data-tip="新建文件夹"
              onClick={() => newIn('dir')}
            >
              <IconFolderPlus size={14} />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="刷新"
              data-tip="刷新"
              aria-busy={tree.loading}
              onClick={() => {
                // 清子层缓存但**留着展开态**：清了展开态的话，点一次刷新整棵树全收起。
                setKids(new Map())
                setManualRefresh((n) => n + 1)
                void refetch()
              }}
            >
              {/*
               * 每次点击固定转一圈，不跟 `tree.loading` 的时长绑在一起：本机请求经常在
               * 浏览器第一次绘制前就结束，只按 loading 加动画等于用户一帧都看不到。
               * transform 的终点持续递增，连续点击也会从上一圈接着转，不需要计时器。
               */}
              <IconRefresh
                size={14}
                style={{
                  transform: `rotate(${manualRefresh() * 360}deg)`,
                  transition: 'transform 360ms ease-out',
                }}
              />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="全部折叠"
              data-tip="全部折叠"
              onClick={() => setExpanded(new Set())}
            >
              <IconCollapseAll size={14} />
            </button>
          </div>
        </div>

        {/* 取不回来要说出来，并且给一条再来一次的路。
            静默留一棵空树的话，「这个项目怎么一个文件都没有」查不出原因。 */}
        <Show when={treeError()}>
          {(msg) => (
            <div class="tree-hint">
              {msg()}
              <button class="btn-ghost sm" type="button" onClick={() => void refetch()}>
                重试
              </button>
            </div>
          )}
        </Show>

        <Show
          when={query().trim()}
          fallback={
            <Show when={rootOpen()}>
              <Tree ctx={ctx} dir="" nodes={loaded(tree)?.nodes ?? []} depth={1} />
            </Show>
          }
        >
          {(q) => <SearchHits ctx={ctx} query={q()} />}
        </Show>
      </div>

      <Show when={openFile()}>
        {(path) => (
          <Suspense fallback={<div class="preview" />}>
            <FileView path={path()} refresh={manualRefresh()} />
          </Suspense>
        )}
      </Show>

      <Show when={menuAt()}>
        {(at) => (
          <TreeMenu
            node={at().node}
            x={at().x}
            y={at().y}
            onClose={() => setMenuAt(null)}
            onRename={() => {
              setCreating(null)
              setNameError(null)
              setRenaming(at().node)
            }}
            onDelete={() => setDoomed(at().node)}
          />
        )}
      </Show>

      <ConfirmDialog
        open={doomed() !== null}
        title={doomed()?.kind === 'dir' ? '删除文件夹' : '删除文件'}
        message={
          doomed()?.kind === 'dir'
            ? `${doomed()?.path} 连同里面的内容一起删掉，删了拿不回来。`
            : `${doomed()?.path} 删了拿不回来。`
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const node = doomed()
          if (node) remove(node)
        }}
        onCancel={() => setDoomed(null)}
      />
    </div>
  )
}

/**
 * 右键菜单。**自己的一层浮层，不复用项目行那个菜单的选择器**（B8）：
 * 那条规则被两个浮层共用过一次，删掉其中一个把另一个的定位、边框、投影一起带走。
 *
 * 位置钉在指针上（`position: fixed`），并往回收一点，免得贴着窗口右下沿被裁掉。
 *
 * 只列**真的能用**的项。Qoder 那份菜单里的剪切 / 复制 / 粘贴不进来：文件级剪贴板
 * 需要一套「待粘贴条目」的状态，没有它的话那三项点了什么也不会发生（B5）。
 * 「在文件资源管理器中显示」只有桌面外壳有，别的端整项不渲染。
 */
function TreeMenu(props: {
  node: FileNode
  x: number
  y: number
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}) {
  createEffect(() => {
    /*
     * 点在菜单**外面**才关。
     *
     * 不能无条件关：`pointerdown` 排在 `click` 前面，菜单项自己的 click 还没跑，
     * 这一层就把它从 DOM 里摘了——因此每一项都点不动。
     */
    const onDown = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.tree-menu')) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    })
  })

  const abs = () => absPath(props.node.path)
  const run = (fn: () => void) => {
    fn()
    props.onClose()
  }

  /*
   * 贴着窗口右下沿右键时把菜单收回来。
   *
   * **量出来再摆，不用估的数**：菜单高度随项数变（桌面端多一项），写死一个
   * 常量迟早和实际项数对不上。`onMount` 在插入 DOM 之后、这一帧绘制之前跑，
   * 所以摆位不会闪一下。
   */
  let el!: HTMLDivElement
  onMount(() => {
    const box = el.getBoundingClientRect()
    const x = Math.min(props.x - 4, window.innerWidth - box.width - 8)
    const y = Math.min(props.y - 4, window.innerHeight - box.height - 8)
    el.style.left = `${Math.max(8, x)}px`
    el.style.top = `${Math.max(8, y)}px`
  })

  return (
    <div
      class="tree-menu"
      role="menu"
      ref={el}
      style={{ left: `${Math.max(8, props.x - 4)}px`, top: `${Math.max(8, props.y - 4)}px` }}
    >
      <Show when={DESKTOP}>
        <button
          class="tree-menu-item"
          type="button"
          role="menuitem"
          onClick={() =>
            run(() => {
              // 外壳那条命令只收目录（它 `is_dir` 校验过），所以文件给它父目录
              // ——用户要的是「在资源管理器里看到它在哪」。
              const dir = props.node.kind === 'dir' ? abs() : parentDir(abs())
              void revealWorkspace(dir)
            })
          }
        >
          在文件资源管理器中显示
        </button>
      </Show>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(() => void navigator.clipboard?.writeText(abs()))}
      >
        复制路径
      </button>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(() => void navigator.clipboard?.writeText(props.node.path))}
      >
        复制相对路径
      </button>
      <div class="tree-menu-sep" />
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(props.onRename)}
      >
        重命名
      </button>
      <button
        class="tree-menu-item danger"
        type="button"
        role="menuitem"
        onClick={() => run(props.onDelete)}
      >
        删除
      </button>
    </div>
  )
}

/**
 * 按名字搜出来的命中，扁平一列，替代树显示。
 *
 * **搜索跳依赖树与构建产物**（服务端 `findByName`），而树不跳。这条边界必须
 * 说出来，否则搜不到 `node_modules` 里的文件读起来就是它不存在。
 */
function SearchHits(props: { ctx: TreeCtx; query: string }) {
  const [debounced, setDebounced] = createSignal(props.query)
  createEffect(() => {
    const q = props.query
    const t = setTimeout(() => setDebounced(q), 300)
    onCleanup(() => clearTimeout(t))
  })

  const [hits] = createResource(debounced, (q) =>
    client.api<{ matches: FileNode[]; truncated: boolean }>(
      `/api/files/find?q=${encodeURIComponent(q)}`,
    ),
  )

  // 用 `loaded()`：改一次搜索词就换一次 source，`hits()` 会在每一批之间进 Suspense
  // ——那会把这块面板连同上面的搜索框一起摘出 DOM，打第二个字时框已经不在了。
  // 重取期间留住上一批命中，新的到位再换。
  const matches = () => loaded(hits)

  return (
    <div class="tree-hits">
      <For each={matches()?.matches ?? []}>
        {(hit) => (
          <button
            class="tree-item"
            classList={{ selected: props.ctx.selected() === hit.path }}
            type="button"
            data-tip={hit.path}
            disabled={hit.kind === 'dir'}
            onClick={() => props.ctx.pick(hit)}
            onContextMenu={(e) => {
              e.preventDefault()
              props.ctx.menu(hit, e.clientX, e.clientY)
            }}
          >
            <Show when={hit.kind === 'dir'} fallback={<IconFile size={13} />}>
              <IconFolder size={13} />
            </Show>
            <span class="truncate">{hit.path}</span>
          </button>
        )}
      </For>
      <Show when={matches() && matches()!.matches.length === 0}>
        <div class="tree-hint">没有匹配的名称。不搜依赖树与构建产物。</div>
      </Show>
      <Show when={matches()?.truncated}>
        <div class="tree-hint">命中过多，只显示前一部分。</div>
      </Show>
    </div>
  )
}

function Tree(props: { ctx: TreeCtx; dir: string; nodes: FileNode[]; depth: number }) {
  const making = () => {
    const m = props.ctx.creating()
    return m && m.dir === props.dir ? m : null
  }

  return (
    <ul class="tree" classList={{ 'tree-top': props.depth === 1 }}>
      {/* 新建那一行**就在这个目录的第一个孩子的位置**，和 Qoder 一样：
          它建在哪里，输入框就出现在哪里。 */}
      <Show when={making()}>
        {(m) => (
          <li>
            <NameRow
              ctx={props.ctx}
              kind={m().kind}
              depth={props.depth}
              value=""
              placeholder={m().kind === 'file' ? '文件名' : '文件夹名'}
            />
          </li>
        )}
      </Show>
      <For each={props.nodes}>
        {(node) => <TreeNode ctx={props.ctx} node={node} depth={props.depth} />}
      </For>
    </ul>
  )
}

/**
 * 就地输入名字的那一行——新建和改名共用**同一个形状**：同样的缩进、同样的图标位、
 * 输入框接在图标后面。两份写法会长成两个样子，而它们在用户眼里是同一件事。
 */
function NameRow(props: {
  ctx: TreeCtx
  kind: 'file' | 'dir'
  depth: number
  value: string
  placeholder?: string
}) {
  const [name, setName] = createSignal(props.value)

  /*
   * **自己抢焦点，不靠 `autofocus`。**
   *
   * `autofocus` 只在文档解析那一刻管用；这一行是点了按钮之后动态插进来的，属性
   * 挂上了也没人给它焦点。后果不止「不能直接打字」——**下面那条失焦即取消
   * 也跟着失效**（从没得到焦点，就不会失焦），因此点别处这一行赖在树里不走。
   *
   * 改名时连着全选：进来就是原名，用户要的通常是整个换掉。
   */
  let input!: HTMLInputElement
  onMount(() => {
    input.focus()
    input.select()
  })

  return (
    <div class="tree-edit" style={{ 'padding-left': `${props.depth * 12 + 8}px` }}>
      <Show when={props.kind === 'dir'} fallback={<IconFile size={13} />}>
        <IconFolder size={13} />
      </Show>
      <input
        class="tree-edit-input"
        ref={input}
        placeholder={props.placeholder}
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.ctx.submitName(name())
          if (e.key === 'Escape') props.ctx.cancelName()
        }}
        onBlur={() => {
          // 失焦即取消，但**报错时不取消**：那一句话得留在屏幕上让人看完。
          if (!props.ctx.nameError()) props.ctx.cancelName()
        }}
      />
      <Show when={props.ctx.nameError()}>
        {(msg) => <span class="tree-edit-error truncate">{msg()}</span>}
      </Show>
    </div>
  )
}

function TreeNode(props: { ctx: TreeCtx; node: FileNode; depth: number }) {
  const open = () => props.ctx.expanded().has(props.node.path)
  const children = () => props.ctx.childrenOf(props.node.path) ?? props.node.children ?? null
  const editing = () => props.ctx.renaming() === props.node.path

  // 展开着而这一层还没取回来就去取。**取数的触发条件是「展开且缺数据」**，
  // 不是点击那一下——刷新把缓存清空之后，展开着的目录靠这条自己重取。
  createEffect(() => {
    if (open() && children() === null) props.ctx.load(props.node.path)
  })

  const row = (onClick: () => void, chevron: boolean) => (
    <button
      class="tree-item"
      classList={{ selected: props.ctx.selected() === props.node.path }}
      type="button"
      style={{ 'padding-left': `${props.depth * 12 + 8}px` }}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        props.ctx.menu(props.node, e.clientX, e.clientY)
      }}
    >
      <Show when={chevron}>
        <IconChevron size={11} dir={open() ? 'down' : 'right'} />
      </Show>
      <Show when={props.node.kind === 'dir'} fallback={<IconFile size={13} />}>
        <IconFolder size={13} />
      </Show>
      <span class="truncate">{props.node.name}</span>
    </button>
  )

  return (
    <li>
      <Show
        when={editing()}
        fallback={
          <Show
            when={props.node.kind === 'dir'}
            fallback={row(() => props.ctx.pick(props.node), false)}
          >
            {row(() => props.ctx.toggle(props.node), true)}
          </Show>
        }
      >
        <NameRow
          ctx={props.ctx}
          kind={props.node.kind}
          depth={props.depth}
          value={props.node.name}
        />
      </Show>
      <Show when={props.node.kind === 'dir' && open()}>
        <Tree
          ctx={props.ctx}
          dir={props.node.path}
          nodes={children() ?? []}
          depth={props.depth + 1}
        />
      </Show>
    </li>
  )
}

// ───────────────────────── 会话变更记录 ─────────────────────────

/**
 * 对一个文件的**一次**改动。
 *
 * `body` 是那一次的正文，整个来自这一步落库的入参——和会话流里展开那一步看到的
 * 是同一份数据（`Transcript.tsx` 的 `StepBody`）：编辑给的是 old/new 两段，
 * 整份写出给的是写进去的那份内容。
 */
interface ChangeEdit {
  tool: string
  additions: number
  deletions: number
  body: { removed: string; added: string } | { written: string } | null
}

/**
 * 这一步的正文。**按入参形状认，不按工具名认**（同 `step-view.ts` 的 `diffFrom`）。
 *
 * 两档不会互相抢：整份写出的入参里没有 old/new，编辑的入参里没有 content。
 * 不要给整份写出编一份红绿——旧内容只在工具执行的那一瞬间存在，没落过库。
 */
function bodyOf(args: Record<string, unknown> | undefined): ChangeEdit['body'] {
  if (!args) return null
  const diff = diffFrom(args)
  if (diff) return diff
  const written = firstString(args, 'content', 'text')
  return written ? { written: clamp(written) } : null
}

/** 这条会话在一个文件上写了多少。路径同账本：工作区相对、posix 分隔符。 */
interface ChangedFile {
  path: string
  additions: number
  deletions: number
  /** 最后一次对它做的是什么。`deleted` 那一档没有行数、也打不开。 */
  changeType: FileChange['changeType']
  /** 每一次改动，按先后。**同一个文件改十次就是十条**，这才是「记录」。 */
  edits: ChangeEdit[]
}

/**
 * 这条会话改过哪些文件。**不接 git。**
 *
 * 真源是 step 账本：每个写类工具的回执自带 `fileChanges`（改了谁、增删多少行），
 * 它随 step 落库，会话重载时原样折回 transcript（`store/connection.ts` 的
 * `stepToItems`）。所以这是一份永久记录——刷新、重启、进程换掉之后都还在
 * （账本是本机那份 sqlite），**而且在没有 git 的目录里照样有内容**。
 *
 * 不接 git 不是因为拿不到，是因为 git 回答的是另一个问题：「工作区相对 HEAD
 * 有什么差别」里混着用户自己在编辑器里改的、上一条会话改的、以及全部未跟踪的
 * 文件。这一页只回答「这条会话干了什么」。两个问题摆进同一块面板就是两本账。
 *
 * 四条口径：
 * - **一个文件一行，展开是它的每一次改动**。行上的数是这条会话在它上面写了多少
 *   （多次累加），不是「它和初始状态差多少」——后者要整份前后文，账本里没有。
 * - **顺序是第一次被改到的先后**，不排字典序：记录读的就是先后。
 * - 失败的调用不进来（写失败的工具不给 `fileChanges`），读也不进来。
 * - **只有文件类工具进账**：`run_command` 改的文件不在里面（shell 那侧没有
 *   `fileChanges` 这一层），所以 sed、代码生成、格式化脚本改的文件这里看不到。
 */
function ChangeRecord() {
  const rows = createMemo(() => {
    const byPath = new Map<string, ChangedFile>()
    for (const item of transcript()) {
      for (const c of item.outcome?.fileChanges ?? []) {
        // 这一步的入参就在账本里，正文从它来——不另存一份。
        const edit: ChangeEdit = {
          tool: item.toolName ?? '',
          additions: c.additions,
          deletions: c.deletions,
          body: bodyOf(item.args),
        }
        const cur = byPath.get(c.path)
        if (cur) {
          cur.additions += c.additions
          cur.deletions += c.deletions
          // 后一次说了算：删掉又重建的文件，最后那次是「建」。
          cur.changeType = c.changeType
          cur.edits.push(edit)
        } else {
          byPath.set(c.path, {
            path: c.path,
            additions: c.additions,
            deletions: c.deletions,
            changeType: c.changeType,
            edits: [edit],
          })
        }
      }
    }
    return [...byPath.values()]
  })
  const additions = () => rows().reduce((n, r) => n + r.additions, 0)
  const deletions = () => rows().reduce((n, r) => n + r.deletions, 0)

  /** 展开了哪几个文件。默认全收——一屏先看清改了哪些文件，再点开要看的那个。 */
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (path: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(path)) next.add(path)
      return next
    })

  // 一条都没有就整页留白：空态不写引导语。
  return (
    <Show when={rows().length > 0}>
      <div class="change-panel">
        <div class="change-head">
          <span>变更 {rows().length} 个文件</span>
          <span class="change-delta">
            <span class="add">+{additions()}</span>
            <span class="del">−{deletions()}</span>
          </span>
        </div>
        <ul class="change-list">
          <For each={rows()}>
            {(r) => (
              <li>
                {/* 点一行 = 展开它的每一次改动。**不做成「打开文件」**：文件正文在
                    「文件」那一页，这一页要回答的是「这条会话对它做了什么」。 */}
                <button
                  class="change-row"
                  classList={{ selected: open().has(r.path) }}
                  type="button"
                  aria-expanded={open().has(r.path)}
                  data-tip={nativePath(r.path)}
                  onClick={() => toggle(r.path)}
                >
                  <IconChevron size={11} dir={open().has(r.path) ? 'down' : 'right'} />
                  <IconFile size={13} />
                  <span class="change-path truncate-left">
                    <span dir="ltr">{nativePath(r.path)}</span>
                  </span>
                  {/* 改了几次只在重复改过时说：写一次的文件标「1 次」是废话。 */}
                  <Show when={r.edits.length > 1}>
                    <span class="change-times">{r.edits.length} 次</span>
                  </Show>
                  {/* 删掉的不报行数：`delete_memory` 给的是 0/0，画成 +0 −0
                      会被读成「什么都没改」。 */}
                  <Show
                    when={r.changeType !== 'deleted'}
                    fallback={<span class="change-gone">已删除</span>}
                  >
                    <span class="change-delta">
                      <span class="add">+{r.additions}</span>
                      <span class="del">−{r.deletions}</span>
                    </span>
                  </Show>
                </button>
                <Show when={open().has(r.path)}>
                  <ol class="change-edits">
                    <For each={r.edits}>
                      {(e, i) => (
                        <li class="change-edit">
                          <div class="edit-head">
                            <span class="edit-no">#{i() + 1}</span>
                            <span class="edit-tool">{editLabel(e.tool)}</span>
                            <span class="change-delta">
                              <span class="add">+{e.additions}</span>
                              <span class="del">−{e.deletions}</span>
                            </span>
                          </div>
                          <Switch>
                            <Match when={e.body && 'written' in e.body ? e.body : null}>
                              {(w) => <pre class="change-body">{w().written}</pre>}
                            </Match>
                            <Match when={e.body && 'removed' in e.body ? e.body : null}>
                              {(d) => (
                                <pre class="change-body">
                                  <Show when={d().removed}>
                                    <span class="del">{d().removed}</span>
                                  </Show>
                                  <Show when={d().added}>
                                    <span class="add">{d().added}</span>
                                  </Show>
                                </pre>
                              )}
                            </Match>
                          </Switch>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  )
}

/**
 * 这一次改动是怎么做的。
 *
 * 认不出的工具名原样显示——写类工具是可以增加的（插件也能给），
 * 回落成「编辑」会把一次整份覆盖说成一次小改。
 */
function editLabel(tool: string): string {
  if (tool === 'edit_file') return '编辑'
  if (tool === 'write_file') return '整份写出'
  if (tool === 'save_memory') return '记忆'
  if (tool === 'delete_memory') return '删除记忆'
  return tool
}

/**
 * 账本里的路径 → 本机绝对路径。
 *
 * **账本里也躺着本来就是绝对路径的条目**：写到工作区外面时（`full` 模式、
 * 额外目录）`displayPath` 回的就是绝对路径。不认这一档会拼出
 * `C:\项目\C:\别处\x.ts`。
 */
function nativePath(p: string): string {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : absPath(p)
}
