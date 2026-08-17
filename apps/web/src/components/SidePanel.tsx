import type { JSX } from 'solid-js'
import {
  createEffect,
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
import {
  client,
  closePanel,
  isDesktopShell,
  openFile,
  openFileInMain,
  type PanelView,
  panelMaximized,
  revealWorkspace,
  setOpenFile,
  setSidePanel,
  sidePanel,
  state,
  togglePanelMax,
  workspace,
} from '../lib/store/index.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  IconBranch,
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

// 懒加载：xterm 及其样式只有真的开终端才下载。手机端和浏览器根本选不到这个视图，
// 静态引入等于让它们白背一份永远不执行的代码。
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx'))

interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  children?: FileNode[]
}

/**
 * 固定视图。顺序即优先级。
 *
 * 写成一份清单而不是几段 JSX：标签页的外观改一次要改每一处，改漏一处的表现是
 * 「有一格长得不一样」，而 CSS 不会为此报错。
 *
 * **这块面板只回答「这一轮在干什么」**：待办、文件、改动、以及你自己动手的那个
 * 终端。配置类的东西（角色编排、逐条能力开关）不进来——它们和「现在跑到哪了」
 * 不是同一个问题。
 *
 * `desktopOnly` 的那一格在别的端**根本不渲染**，不是渲染出来点了报错：PTY 是本机
 * 进程和一对系统句柄，手机和浏览器不可能有（CLAUDE.md B5）。
 */
const VIEWS: { view: PanelView; label: string; desktopOnly?: true }[] = [
  // 待办排在最前：它回答的是「这一轮在干什么」，比「有哪些文件」更靠前。
  { view: 'todos', label: '待办' },
  { view: 'files', label: '文件' },
  { view: 'git', label: '变更' },
  { view: 'terminal', label: '终端', desktopOnly: true },
]

/** 桌面外壳判定一次就够：它在一次运行里不会变。 */
const DESKTOP = isDesktopShell()
const VISIBLE_VIEWS = VIEWS.filter((v) => DESKTOP || !v.desktopOnly)

/**
 * 「新开预览」看板上有哪几行。
 *
 * **没有 `open` 的那几行是后端还没接上的**，看板上置灰、点不动、行尾标「未接入」。
 * 这是用户点名要的形状：清单同时充当路线图。接上哪一项就给它补一个 `open`，
 * 看板那段 JSX 一行不用改。
 *
 * 现状（核过码，别照着标签猜）：文件和终端有后端，终端只在桌面端有。
 * 浏览器与无限画布没有服务端；Word / PPT 不在 `packages/server/src/files.ts`
 * 的分类表里；Excel 虽然分到 `tabular`，但 xlsx 是二进制、走到 `looksBinary`
 * 就退成「无法以文本预览」——真能开的只有 csv / tsv，那条路文件预览本来就有。
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
    key: 'file',
    label: '文件',
    icon: IconFile,
    open: () => setSidePanel('files'),
  },
  {
    key: 'terminal',
    label: '终端',
    icon: IconTerminal,
    desktopOnly: true,
    open: () => setSidePanel('terminal'),
  },
  { key: 'browser', label: '浏览器', icon: IconGlobe },
  { key: 'word', label: 'Word', icon: IconFile },
  { key: 'ppt', label: 'PPT', icon: IconFile },
  { key: 'excel', label: 'Excel', icon: IconFile },
  { key: 'canvas', label: '无限画布', icon: IconCanvas },
]

const BOARD_ROWS = PREVIEW_SOURCES.filter((s) => DESKTOP || !s.desktopOnly)

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
            <For each={VISIBLE_VIEWS}>
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
              {/* 桌面之外这个视图选不到（页签和看板都不渲染它），
                  留着这个 Match 只是让「视图值 ↔ 渲染」这张表保持完整。
                  自带 `Suspense`：xterm 那一包三百多 K，没有边界的话它挂起时
                  整棵树跟着空一下（同 `App.tsx` 里那段）。 */}
              <Match when={sidePanel() === 'terminal'}>
                <Suspense fallback={<div class="terminal-panel" />}>
                  <TerminalPanel />
                </Suspense>
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
      <For each={BOARD_ROWS}>
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

/**
 * 树的共享操作。**展开态、子层缓存、正在编辑的那一行都不在节点里**——
 * 「全部折叠」「刷新」要一次管到所有节点，而新建那一行要能出现在任意目录下面；
 * 散在每个 `TreeNode` 的局部信号里，这几件事谁都指挥不动。
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

function FileBrowser() {
  const [tree, { refetch }] = createResource(
    // 依赖 fileChanges 长度：agent 改了文件后自动刷新树，
    // 不需要用户手动点刷新。
    () => state.fileChanges.length,
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=2'),
  )

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
    selected: () => renaming()?.path ?? openFile() ?? selected()?.path ?? null,
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
      openFileInMain(node.path)
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
            if (openFile() === job.path && node.kind === 'file') openFileInMain(node.path)
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
            if (node.kind === 'file') openFileInMain(node.path)
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
    <div class="file-browser">
      {/* 搜索在最上面一行，和 Qoder 一样：它是这块面板的入口，不该排在树的操作后面。 */}
      <input
        class="tree-search"
        type="search"
        placeholder="搜索名称"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />

      {/*
       * 根目录行。**四颗按钮长在这一行上，不另起一条工具条**——工具条那种细带子
       * 会在搜索框和树之间多插一层横条，而这四颗做的事全都发生在这个根之下。
       */}
      <div class="tree-root">
        <button
          class="tree-item tree-root-name"
          type="button"
          onClick={() => {
            setSelected(null)
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
            title="新建文件"
            onClick={() => newIn('file')}
          >
            <IconFilePlus size={14} />
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label="新建文件夹"
            title="新建文件夹"
            onClick={() => newIn('dir')}
          >
            <IconFolderPlus size={14} />
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label="刷新"
            title="刷新"
            onClick={() => {
              // 清子层缓存但**留着展开态**：清了展开态的话，点一次刷新整棵树全收起。
              setKids(new Map())
              void refetch()
            }}
          >
            <IconRefresh size={14} />
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label="全部折叠"
            title="全部折叠"
            onClick={() => setExpanded(new Set())}
          >
            <IconCollapseAll size={14} />
          </button>
        </div>
      </div>

      <Show
        when={query().trim()}
        fallback={
          <Show when={rootOpen()}>
            <Tree ctx={ctx} dir="" nodes={tree()?.nodes ?? []} depth={1} />
          </Show>
        }
      >
        {(q) => <SearchHits ctx={ctx} query={q()} />}
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
 * 需要一套「待粘贴的东西」的状态，没有它的话那三项点了什么也不会发生（B5）。
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
     * 这一层就把它从 DOM 里摘了——于是每一项都点不动。
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

  const abs = () => {
    const root = workspace()?.root ?? ''
    return root ? `${root.replace(/[\\/]+$/, '')}/${props.node.path}` : props.node.path
  }
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
 * 说出来，否则用户搜不到 `node_modules` 里的东西会以为文件不存在。
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

  return (
    <div class="tree-hits">
      <For each={hits()?.matches ?? []}>
        {(hit) => (
          <button
            class="tree-item"
            classList={{ selected: props.ctx.selected() === hit.path }}
            type="button"
            title={hit.path}
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
      <Show when={hits() && hits()!.matches.length === 0}>
        <div class="tree-hint">没有匹配的名称。不搜依赖树与构建产物。</div>
      </Show>
      <Show when={hits()?.truncated}>
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

  return (
    <div class="tree-edit" style={{ 'padding-left': `${props.depth * 12 + 8}px` }}>
      <Show when={props.kind === 'dir'} fallback={<IconFile size={13} />}>
        <IconFolder size={13} />
      </Show>
      <input
        class="tree-edit-input"
        // 这一行是点了按钮才出现的，出现就该能直接打字——不给焦点等于让用户再点一次。
        autofocus
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
