import { type FileChange, type FoldedFileChange, foldFileChanges } from '@qywork/core'
import type { JSX } from 'solid-js'
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
  Suspense,
  Switch,
} from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { loaded } from '../lib/resource.ts'
import { clamp, diffFrom, firstString } from '../lib/step-view.ts'
import {
  absPath,
  activePanelTab,
  browserReady,
  CANVAS_SUFFIX,
  type ChangesView,
  type ChangeTurn,
  canvasAvailable,
  canvasTitle,
  client,
  closePanel,
  closePanelTab,
  createCanvas,
  explainApiError,
  isDesktopShell,
  loadConversationChanges,
  loadOlderConversationChanges,
  openBrowserTab,
  openCanvasTab,
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
  view,
  WORKSPACE_PATH_TYPE,
  workspace,
} from '../lib/store/index.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import FileTypeIcon from './FileTypeIcon.tsx'
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
  IconSpinner,
  IconTerminal,
  IconX,
} from './Icons.tsx'
import { TodoPanel } from './TodoPanel.tsx'

// 懒加载：xterm 及其样式只在打开终端时下载。手机端和浏览器无法打开终端页，
// 静态引入会使它们多下载一份永远不执行的代码。
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx'))

// 同样懒加载：不打开浏览器页的用户无需承担它的首屏加载成本。
const BrowserPanel = lazy(() => import('./BrowserPanel.tsx'))

// 网页预览页：供没有内置浏览器的端使用。
const PreviewPanel = lazy(() => import('./PreviewPanel.tsx'))

// 子会话页：只在从工具卡打开子 agent 时加载。
const ConversationPanel = lazy(() => import('./ConversationPanel.tsx'))

// 外部 CLI 页：只在从图卡打开 CLI 节点时加载。
const CliPanel = lazy(() => import('./CliPanel.tsx'))

// 同样懒加载：它包含 CodeMirror 核心（约 300 kB），只查看待办与变更的用户不会用到它。
const FileView = lazy(() => import('./FileView.tsx'))
// 画布页：只在打开画布时下载。
const CanvasPanel = lazy(() => import('./canvas/CanvasPanel.tsx'))

// 同样懒加载：运行页挂载后即请求两个接口，不打开它的用户不应为它承担首屏成本。
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
 * 固定页签。顺序即优先级。**它们不可关闭，始终位于页签栏最前面。**
 *
 * 写成清单而不是多段 JSX：分别书写时，修改页签外观需改动每一处，遗漏一处会使
 * 某个页签的外观不一致，而 CSS 不会为此报错。
 *
 * **它们回答「本轮正在执行什么」**：待办、文件、变更、费用。配置类页面（角色编排、
 * 逐项能力开关）不放入此处：它们与当前执行进度无关。
 *
 * 终端与浏览器不在此处：它们是**可多开、可关闭**的页，由 `+` 新开、页签上带 ×，
 * 清单在 `panelTabs`。
 */
const VIEWS: { view: PanelView; label: string }[] = [
  // 待办排在最前：它回答「本轮正在执行什么」，优先于「有哪些文件」。
  { view: 'todos', label: '待办' },
  { view: 'files', label: '文件' },
  { view: 'changes', label: '变更' },
  // 运行排在末位：查看费用是事后操作，优先级低于当前执行状态。
  { view: 'runs', label: '运行' },
]

/** 看板上的「无限画布」：在工作区根新建一张空画布并打开它。 */
async function openNewCanvas(): Promise<void> {
  const path = await createCanvas()
  openCanvasTab(path, canvasTitle(path))
}

/** 在文件树中点击文件：画布文件在鼠标端打开画布页，其余文件在主区预览。 */
function openPath(path: string): void {
  if (path.endsWith(CANVAS_SUFFIX) && canvasAvailable()) openCanvasTab(path, canvasTitle(path))
  else openFileInPanel(path)
}

/**
 * 「新开预览」看板的各行。**每一行都会新开一页**，因此固定页签不在此处：
 * 它们始终位于页签栏上，列出后点击也不会新开一页。
 *
 * **没有 `open` 的行尚未接入后端**，在看板上置灰、不可点击、行尾标注「未接入」。
 * 这是用户明确要求的形式：清单同时充当路线图。接入某一项时为它补充 `open`，
 * 看板的 JSX 无需修改。
 *
 * 现状（已核对代码，不要按标签推测）：终端依赖 Rust 侧的 PTY，只在桌面端可用；内置浏览器由
 * 桌面外壳的宿主承载（Windows 嵌入面板，macOS 与 Linux 显示在浏览器的独立窗口中），
 * 宿主连接后才可用，其他端改用 HTTP 网页预览（iframe，只读）。无限画布只在鼠标端提供入口（`canvasAvailable`）；
 * Word / PPT 不在 `packages/server/src/files.ts` 的分类表中；Excel 虽归入 `tabular`，但 xlsx 是
 * 二进制格式，经 `looksBinary` 判定后显示「无法以文本预览」，实际可预览的只有 csv / tsv，
 * 而文件页已支持这两种格式。
 */
const PREVIEW_SOURCES: {
  key: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  /** 缺省表示该项尚未接入后端。 */
  open?: () => void
  /** 当前端不具备该能力时整行不渲染，与「尚未接入」的置灰不同。 */
  show?: () => boolean
}[] = [
  {
    key: 'terminal',
    label: '终端',
    icon: IconTerminal,
    show: isDesktopShell,
    open: () => openPanelTab('terminal'),
  },
  {
    key: 'browser',
    label: '浏览器',
    icon: IconGlobe,
    show: browserReady,
    open: () => void openBrowserTab(),
  },
  {
    /*
     * 网页预览**只在没有桌面外壳的端提供**，不按宿主是否连接判定。
     * 按可用性判定时，外壳上的宿主启动失败会退化为 iframe：用户得到的是
     * 外观相同、但没有登录状态且不受 AI 控制的页面，且无法区分。
     */
    key: 'preview',
    label: '网页预览',
    icon: IconGlobe,
    show: () => !isDesktopShell(),
    open: () => openPanelTab('preview'),
  },
  { key: 'word', label: 'Word', icon: IconFile },
  { key: 'ppt', label: 'PPT', icon: IconFile },
  { key: 'excel', label: 'Excel', icon: IconFile },
  {
    key: 'canvas',
    label: '无限画布',
    icon: IconCanvas,
    show: canvasAvailable,
    open: () => void openNewCanvas(),
  },
]

/** 每次渲染时重新计算：内置浏览器要等宿主连接，而宿主在应用启动之后才连接。 */
const boardRows = () => PREVIEW_SOURCES.filter((s) => s.show?.() ?? true)

/**
 * 右侧面板容器。固定页签（`VIEWS`）与可多开的页（`panelTabs`）共用同一区域，
 * 互斥显示。
 *
 * 默认导出供 `lazy()` 使用：本模块静态引入了 CodeMirror 核心（约 300 kB），
 * 放入首屏会使只使用对话的用户承担文件预览的加载成本。
 */
export default function SidePanel() {
  /**
   * 看板是否覆盖在正文上。**局部信号，不放入 `sidePanel`**：看板不是独立视图，
   * 收起面板再展开时应回到用户上次查看的视图，而不是新开预览看板。
   */
  const [board, setBoard] = createSignal(false)

  /*
   * 普通鼠标滚动一格时，Windows 通常只产生一个较大的离散 delta。直接写入 `scrollLeft`
   * 会使位置瞬间跳变；此处由一个 rAF 循环逐步接近同一个目标，连续滚轮只累加目标，不排队创建
   * 多段 smooth 动画。40ms 是接近目标的时间常数，约 120ms 完成 95%，过渡可见，
   * 且停止滚动后不会持续过久。
   */
  const wheelSmoothingMs = 40
  let wheelTarget: number | null = null
  let wheelDirection = 0
  let wheelFrame: number | null = null
  let wheelFrameAt = 0
  let wheelTabs: HTMLDivElement | null = null

  const stopWheelScroll = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame)
    wheelTarget = null
    wheelDirection = 0
    wheelFrame = null
    wheelTabs = null
  }

  const animateWheelScroll = (at: number) => {
    const tabs = wheelTabs
    if (!tabs || wheelTarget === null) {
      stopWheelScroll()
      return
    }

    const max = Math.max(0, tabs.scrollWidth - tabs.clientWidth)
    const target = Math.min(max, Math.max(0, wheelTarget))
    wheelTarget = target
    const distance = target - tabs.scrollLeft
    if (Math.abs(distance) <= 0.5) {
      tabs.scrollLeft = target
      stopWheelScroll()
      return
    }

    const elapsed = Math.max(0, at - wheelFrameAt)
    wheelFrameAt = at
    const blend = 1 - Math.exp(-elapsed / wheelSmoothingMs)
    tabs.scrollLeft += distance * blend
    wheelFrame = requestAnimationFrame(animateWheelScroll)
  }

  /**
   * 窄面板中的页签仍排成一行：普通鼠标只有纵向滚轮，此处将其转换为横向位移。
   * 触控板本身产生 `deltaX`，交给浏览器原生滚动；到达边界或没有溢出时也不拦截。滚动只
   * 响应用户输入，选中页签时不自动调整位置。
   */
  const scrollTabsWithWheel = (e: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.deltaY === 0) {
      // 触控板开始原生横向滚动时，必须停止尚未完成的鼠标滚轮动画，避免两者同时写入 scrollLeft。
      stopWheelScroll()
      return
    }

    const tabs = e.currentTarget
    const max = Math.max(0, tabs.scrollWidth - tabs.clientWidth)
    if (max === 0) return

    const scale =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? tabs.clientWidth
          : 1
    const delta = e.deltaY * scale
    const direction = Math.sign(delta)
    // 反向滚动从当前位置起算；同向滚动才在尚未到达的目标上累加。
    const base =
      wheelTarget !== null && direction === wheelDirection ? wheelTarget : tabs.scrollLeft
    const target = Math.min(max, Math.max(0, base + delta))
    const pendingDistance = (wheelTarget ?? tabs.scrollLeft) - tabs.scrollLeft
    if (target === base && Math.abs(pendingDistance) <= 0.5) return

    e.preventDefault()
    wheelTabs = tabs
    wheelTarget = target
    wheelDirection = direction
    if (wheelFrame === null) {
      wheelFrameAt = performance.now()
      wheelFrame = requestAnimationFrame(animateWheelScroll)
    }
  }

  onCleanup(stopWheelScroll)

  /** 页签是否高亮。看板覆盖正文时所有页签均不高亮：此时正文不属于任何页签。 */
  const onView = (view: PanelView) => sidePanel() === view && !board()
  const onTab = (id: string) => activePanelTab() === id && !board()

  return (
    <Show when={sidePanel()}>
      <aside class="side-panel">
        {/*
         * 拖动左边沿调整面板宽度。
         *
         * 必须调用 `setPointerCapture`：不捕获时指针移到 iframe / CodeMirror
         * 上后，`pointermove` 会派发给该层，拖动中途停止。
         *
         * 使用 `<button>` 而不是 `role="separator"` 的 div：焦点、键盘语义、
         * 屏幕阅读器播报都由元素自带，而该 role 还要求手动补充 `tabindex` 与
         * `aria-valuenow`，补齐后 lint 仍需抑制两条规则。
         * 左右方向键每次调整 24px：可获得焦点的控件必须支持键盘调整。
         * 窄屏不显示（窄屏下面板覆盖全屏，见 utility.css）。
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
          <div class="side-tabs" role="tablist" onWheel={scrollTabsWithWheel}>
            <For each={VIEWS}>
              {(t) => (
                <button
                  class="side-tab"
                  classList={{ active: onView(t.view) }}
                  type="button"
                  role="tab"
                  aria-selected={onView(t.view)}
                  onClick={() => {
                    // 点击页签即关闭看板：不关闭时页签已高亮而正文仍是看板，
                    // 点击看起来没有生效。
                    setBoard(false)
                    setSidePanel(t.view)
                  }}
                >
                  {t.label}
                </button>
              )}
            </For>
            {/*
             * 可多开的页排在固定页签之后，各带一个 × 按钮。
             *
             * 外层使用 div，不把 × 放入页签按钮内：**button 嵌套 button 是
             * 非法 HTML**，浏览器会把内层按钮移到外面，导致点击页签名称变为点击关闭。
             * 外层只是容器（`role="presentation"`），`role="tab"` 设在名称按钮上。
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
                    classList={{ fixed: t.kind === 'browser' }}
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
            {/* 放大：面板占据正文区域，输入框收起为底部悬浮触发条。窄屏不显示：
                窄屏下面板已覆盖全屏，无需放大（样式见 utility.css）。 */}
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
            {/* 关闭按钮只在窄屏显示（样式见 utility.css）。宽屏由顶栏的开关控制，
                此处再放一个会形成同一操作的第二个入口；窄屏下面板覆盖全屏并遮住顶栏，
                没有该按钮将无法关闭面板。 */}
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
           * **切换项目时重新挂载整个区域**（`keyed` 的 Show 按项目 id）。
           *
           * 面板中有多处按路径记录的状态：文件树展开的目录、子层缓存、选中的行、
           * 正在查看的 diff。它们都是局部状态，切换项目后每一项仍指向上一个项目：
           * 文件树已更新而另一半仍是旧内容，点击不产生任何响应。
           *
           * 逐项清除不可行：那需要维护一份全部局部状态的清单，每新增一个 signal 都可能遗漏。
           * 重新挂载是唯一不会遗漏的做法。`openFile` 不在此处，由 `activateWorkspace` 清除。
           *
           * **重新挂载不关闭可多开的页**：它们按项目分别记录（`store/ui.ts` 的 `panels`），
           * 只派生当前项目的页。终端的 xterm 实例保存在模块级的 `panes` 中、
           * PTY 在 Rust 侧，重新挂载只是移入移出宿主元素，切回后命令仍在运行。
           */}
          <Show when={workspace()?.id} keyed>
            {/*
             * 看板打开时该层只**隐藏，不卸载**。
             *
             * 卸载有实际代价：终端页卸载会把 xterm 实例移出面板（见 `TerminalPanel.tsx` 的模块级
             * `panes`），浏览器页的 iframe 一旦移出 DOM 就会重新加载。看板只是
             * 选择新页面的清单，不应导致已打开的页被重建。
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
                  {/* 自带 Suspense，理由同下方各页：没有边界时，组件挂起会使整棵树短暂变空。 */}
                  <Suspense fallback={<div class="pane-loading" />}>
                    <RunDetails />
                  </Suspense>
                </Match>
              </Switch>

              {/*
               * 可多开的页**全部保持挂载，只显示当前页**（`.tab-pane.active`）。
               *
               * 不采用只挂载当前页的做法：终端中的命令需继续运行、滚动历史需保留，
               * iframe 中的页面不应因切换页签而重新加载。
               *
               * 每一页自带 `Suspense`：xterm 的包体积超过 300 kB，没有边界时组件挂起会使
               * 整棵树短暂变空（同 `App.tsx` 中的处理）。
               */}
              <For each={panelTabs()}>
                {(t) => (
                  <div class="tab-pane" classList={{ active: activePanelTab() === t.id }}>
                    <Suspense fallback={<div class="pane-loading" />}>
                      <Switch fallback={<PreviewPanel id={t.id} />}>
                        <Match when={t.kind === 'terminal'}>
                          <TerminalPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'browser'}>
                          <BrowserPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'conversation'}>
                          <ConversationPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'cli'}>
                          <CliPanel id={t.id} />
                        </Match>
                        <Match when={t.kind === 'canvas' && t.path}>
                          {(path) => (
                            <CanvasPanel path={path()} active={activePanelTab() === t.id} />
                          )}
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
 * 新开预览看板。各行由 `PREVIEW_SOURCES` 决定。
 *
 * **位于面板正文中，不是浮层。** 浮层菜单只能容纳三四行，且会遮挡下方内容；
 * 该清单列出面板可打开的全部页面，因此占满整个区域。
 *
 * 没有后端的行仍然显示，但设为 `disabled` 并标注「未接入」：这是用户明确要求的
 * 路线图式清单。它是本仓库 B5「不造空壳」的例外，例外的边界是
 * **必须不可点击、必须标注**：B5 针对的正是看起来可点击、点击后没有响应
 * 的入口。
 */
function PreviewBoard(props: { onPick: () => void }) {
  return (
    <div class="preview-board">
      <For each={boardRows()}>
        {(s) => (
          <button
            class="board-item"
            type="button"
            disabled={!s.open}
            onClick={() => {
              // **先关闭看板，再打开新页。** 顺序相反时新页会在 `display: none`
              // 的容器中挂载，而 xterm 挂载后立即测量字符宽高，测得 0 时要等下一次
              // 尺寸变化才会重新测量。
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
 * 文件树的共享操作。**展开状态、子层缓存与正在编辑的行都不保存在节点中**：
 * 「全部折叠」「刷新」需一次作用于所有节点，新建行需能出现在任意目录下；
 * 分散在各 `TreeNode` 的局部信号中时，没有一处能操作全部节点。
 */
interface TreeCtx {
  expanded(): ReadonlySet<string>
  toggle(node: FileNode): void
  /** `null` 表示该层尚未取回（刷新会将其清为 `null`，已展开的目录自行重取）。 */
  childrenOf(path: string): FileNode[] | null
  load(path: string): void
  selected(): string | null
  pick(node: FileNode): void
  menu(node: FileNode, x: number, y: number): void
  /** 正在该目录下新建。`dir` 是工作区相对路径，根目录为空串。 */
  creating(): { kind: 'file' | 'dir'; dir: string } | null
  /** 正在重命名的路径。 */
  renaming(): string | null
  submitName(name: string): void
  cancelName(): void
  /** 上一次提交名称时返回的错误（重名等）。 */
  nameError(): string | null
}

const parentDir = (path: string) => path.split('/').slice(0, -1).join('/')

function FileBrowser() {
  const treeSource = () => {
    const id = workspace()?.id
    return state.connection === 'ready' && id ? `${id}:${state.fileVersion}` : (false as const)
  }
  const [tree, { refetch }] = createResource(
    // 连接未就绪时不发送必然失败的请求；恢复为 ready 后同一资源自动重取。
    // fileVersion 同时覆盖精确文件工具与只能粗粒度失效的命令/子流程。
    treeSource,
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=2'),
  )

  /**
   * 文件树获取失败时显示的错误信息。
   *
   * **不要改为 `tree()` 或 `tree.latest`**：两者在出错时都会 `throw`，而本应用
   * 没有 `ErrorBoundary`，抛出的错误无人处理。`loaded()` 只返回值，错误从 `tree.error` 单独读取。
   */
  const treeError = () => (tree.error ? explainApiError(tree.error, '读取失败') : null)

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [kids, setKids] = createSignal<ReadonlyMap<string, FileNode[]>>(new Map())
  /** 选中的行。它同时决定新建的位置，因此文件与目录都会记录。 */
  const [selected, setSelected] = createSignal<FileNode | null>(null)
  const [creating, setCreating] = createSignal<{ kind: 'file' | 'dir'; dir: string } | null>(null)
  const [renaming, setRenaming] = createSignal<FileNode | null>(null)
  const [nameError, setNameError] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ node: FileNode; x: number; y: number } | null>(null)
  const [revealError, setRevealError] = createSignal<string | null>(null)
  const [doomed, setDoomed] = createSignal<FileNode | null>(null)
  const [query, setQuery] = createSignal('')
  const [rootOpen, setRootOpen] = createSignal(true)
  /**
   * 手动刷新作用于整个文件页，不只是左侧文件树。
   *
   * 当前文件预览有独立的 resource；只调用文件树的 `refetch()` 时，右侧正文仍显示旧内容，
   * 刷新看起来没有响应。该递增值只表示一次刷新命令，不另存任何文件状态。
   */
  const [manualRefresh, setManualRefresh] = createSignal(0)

  /*
   * 根树重取时，展开目录的懒加载缓存必须同时失效。只重取根节点时，已展开的目录
   * 仍优先显示 `kids` 中的旧内容，根目录已更新而子层不变。
   */
  createEffect<string | false>((previous) => {
    const current = treeSource()
    if (current && current !== previous) setKids(new Map())
    return current
  }, false)

  // 子目录懒加载：大仓库中一次性获取整棵树需要数秒（文件树不过滤，`node_modules`
  // 也包含在内），而用户通常只展开一两层。
  const loadDir = (path: string) => {
    void client
      .api<{ nodes: FileNode[] }>(`/api/files/tree?path=${encodeURIComponent(path)}&depth=1`)
      .then((res) => setKids((m) => new Map(m).set(path, res.nodes)))
  }

  /**
   * 新建 / 重命名 / 删除之后，所在层必须**立即重取并覆盖缓存**。
   *
   * 不能只从缓存中删除再等待自动重取：`TreeNode` 未找到缓存时会回退到根请求
   * `depth=2` 返回的 `node.children`，那份数据已过期；删除缓存后文件树不变，
   * 新建看起来没有生效。根层没有上一级可获取，使用 `refetch()`。
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
     * 高亮的行**只由 `selected` 决定**。
     *
     * 不要把主区打开的文件（`openFile`）也纳入判定：两个权威争夺同一处高亮时，
     * 点击文件夹不会高亮（高亮停留在已打开的文件上），点击文件后选中状态看起来没有保留。
     * 行为与资源管理器一致：**最后点击的行即选中行**，保持高亮，
     * 直到点击其他行。
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
      openPath(node.path)
    },
    menu: (node, x, y) => {
      setSelected(node)
      setRevealError(null)
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
            // 重命名的是主区已打开的文件时，同步切换到新路径，否则主区指向一个已不存在的路径。
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
          // `detail` 是服务端返回的错误描述（「x 已存在」），不含状态码与路径。
          setNameError(err instanceof ApiError ? err.detail : String(err))
        }
      })()
    },
  }

  /** 新建位置：选中目录时在该目录中；选中文件时在其所在目录；未选中时在根目录。 */
  const newIn = (kind: 'file' | 'dir') => {
    const s = selected()
    const dir = !s ? '' : s.kind === 'dir' ? s.path : parentDir(s.path)
    setRenaming(null)
    setNameError(null)
    setCreating({ kind, dir })
    // 新建行位于该目录下，须先展开目录，否则输入框处于折叠的层中。
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
     * **文件树在左、文件内容在右**，位于同一面板中。
     *
     * 文件树不占满面板：它是索引，宽度固定；正文是阅读区域，占据其余全部宽度。
     * 面板宽度由用户拖动左边沿调整（`.panel-grip`）：两栏并排时必须支持调整，
     * 否则内容栏只有一百多像素。
     */
    <div class="file-browser">
      <div class="file-tree-col">
        {/* 搜索位于第一行：它是文件树的入口，不应排在文件树操作之后。 */}
        <input
          class="tree-search"
          type="search"
          placeholder="搜索名称"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />

        {/* 根目录行：只负责展开与四个操作按钮，不参与文件选中；hover 样式由整行承担，
            标题按钮自身不另加灰色背景。理由见 `panel.css` 的 `.tree-root`。 */}
        <div class="tree-root">
          <button
            class="tree-item tree-root-name"
            type="button"
            onClick={() => {
              // 根目录行是结构标题，不是可选节点。清空选择后，后续新建仍位于根目录。
              setSelected(null)
              setRootOpen((v) => !v)
            }}
          >
            <span class="tree-chevron-slot" aria-hidden="true">
              <IconChevron size={11} dir={rootOpen() ? 'down' : 'right'} />
            </span>
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
                // 清空子层缓存但**保留展开状态**：清空展开状态时，每次刷新都会使整棵树全部折叠。
                setKids(new Map())
                setManualRefresh((n) => n + 1)
                void refetch()
              }}
            >
              {/*
               * 每次点击固定旋转一圈，不与 `tree.loading` 的时长绑定：本机请求常在
               * 浏览器首次绘制前就已结束，只按 loading 显示动画时用户看不到任何一帧。
               * transform 的终点持续递增，连续点击时从上一圈继续旋转，无需计时器。
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

        {/* 获取失败时显示原因并提供重试按钮。
            静默显示空树时，用户无法判断项目为何没有任何文件。 */}
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

        <Show when={revealError()}>
          {(msg) => (
            <div class="tree-hint" role="alert">
              无法打开目录：{msg()}
              <button
                class="icon-btn"
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setRevealError(null)}
              >
                <IconX size={12} />
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

      {/*
       * **按路径重新挂载**（`keyed`）：点击另一个文件时，正文立即切换为该文件的加载态。
       * 不要去掉 `keyed`：资源重取期间 `loaded()` 返回上一个文件的结果，上一个文件的错误
       * 也保留到新结果返回，正文会停留在旧文件上。刷新同一个文件时不重新挂载，阅读位置保留。
       */}
      <Show when={openFile()} keyed>
        {(path) => (
          <Suspense fallback={<div class="preview" />}>
            <FileView path={path} refresh={manualRefresh() + state.fileVersion} />
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
            onError={setRevealError}
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
            ? `${doomed()?.path} 及其中的全部内容将一并删除，且删除后无法恢复。`
            : `${doomed()?.path} 删除后无法恢复。`
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
 * 右键菜单。**独立的浮层，不复用项目行菜单的选择器**（B8）：
 * 两个浮层共用同一条样式规则时，删除其中一个会使另一个的定位、边框与投影一并丢失。
 *
 * 位置固定在指针处（`position: fixed`），并向内收缩，避免靠近窗口右下边缘时被裁切。
 *
 * 只列出**实际可用**的项，不提供剪切 / 复制 / 粘贴：文件级剪贴板
 * 需要一套待粘贴条目的状态，没有该状态时这三项点击后没有任何效果（B5）。
 * 「在资源管理器中显示」只在桌面外壳中提供，其他端不渲染该项。
 */
function TreeMenu(props: {
  node: FileNode
  x: number
  y: number
  onClose: () => void
  onError: (message: string) => void
  onRename: () => void
  onDelete: () => void
}) {
  createEffect(() => {
    /*
     * 只在点击菜单**外部**时关闭。
     *
     * 不能无条件关闭：`pointerdown` 先于 `click` 触发，菜单项的 click 尚未执行时，
     * 菜单就已从 DOM 中移除，导致所有菜单项都无法点击。
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
   * 在靠近窗口右下边缘处右键时，将菜单移回窗口内。
   *
   * **先测量再定位，不使用估算值**：菜单高度随项数变化（桌面端多一项），固定的
   * 常量会与实际项数不一致。`onMount` 在插入 DOM 之后、当前帧绘制之前执行，
   * 因此定位时不会闪烁。
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
      <Show when={isDesktopShell()}>
        <button
          class="tree-menu-item"
          type="button"
          role="menuitem"
          onClick={() =>
            run(() => {
              // 先从使用斜杠的相对路径取父目录，再转换为本机路径。
              const dir = absPath(
                props.node.kind === 'dir' ? props.node.path : parentDir(props.node.path),
              )
              void revealWorkspace(dir).catch((err) =>
                props.onError(err instanceof Error ? err.message : String(err)),
              )
            })
          }
        >
          在资源管理器中显示
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
 * 第 depth 层行的左内边距。每层递进 10px：子行的层级线位于父行箭头线条的中心
 * （父内边距 + 7），子行的图标位从该线右侧 3px 起，图标线条距该线 8px。
 * 不要缩小到 6px：徽标会紧贴层级线。
 */
const treeIndent = (depth: number): number => depth * 10 + 2

/**
 * 按名称搜索的结果，扁平列出，替代文件树显示。
 *
 * **搜索跳过依赖目录与构建产物**（服务端 `findByName`），而文件树不跳过。该边界必须
 * 显示出来，否则搜索不到 `node_modules` 中的文件会被理解为文件不存在。
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

  // 使用 `loaded()`：每次修改搜索词都会更换 source，`hits()` 会在两批结果之间进入 Suspense，
  // 使面板连同上方的搜索框一起移出 DOM，输入第二个字符时搜索框已不存在。
  // 重取期间保留上一批结果，新结果返回后再替换。
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
            <Show when={hit.kind === 'dir'} fallback={<FileTypeIcon name={hit.name} />}>
              <span class="tree-node-icon" aria-hidden="true">
                <IconFolder size={13} />
              </span>
            </Show>
            <span class="truncate">{hit.path}</span>
          </button>
        )}
      </For>
      <Show when={matches() && matches()!.matches.length === 0}>
        <div class="tree-hint">没有匹配的名称。不搜索依赖目录与构建产物。</div>
      </Show>
      <Show when={matches()?.truncated}>
        <div class="tree-hint">匹配项过多，只显示前一部分。</div>
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
    <ul
      class="tree"
      classList={{
        'tree-top': props.depth === 1,
        'tree-terminal': props.nodes.every((node) => node.kind !== 'dir'),
      }}
      style={{ '--tree-guide-left': `${treeIndent(props.depth) - 3}px` } as JSX.CSSProperties}
    >
      {/* 新建行**位于该目录第一个子项的位置**：
          输入框出现在新条目将要创建的位置。 */}
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
 * 就地输入名称的行。新建与重命名共用**同一结构**：相同的缩进、相同的图标位，
 * 输入框位于图标之后。分别实现会导致两者外观不一致，而对用户而言它们是同一操作。
 */
function NameRow(props: {
  ctx: TreeCtx
  kind: 'file' | 'dir'
  depth: number
  value: string
  placeholder?: string
  chevronDir?: 'right' | 'down' | undefined
}) {
  const [name, setName] = createSignal(props.value)

  /*
   * **主动获取焦点，不依赖 `autofocus`。**
   *
   * `autofocus` 只在文档解析时生效；该行在点击按钮后动态插入，即使带有该属性
   * 也不会获得焦点。其后果不只是无法直接输入：**下方的失焦即取消逻辑
   * 也随之失效**（从未获得焦点就不会失焦），点击别处时该行仍留在文件树中。
   *
   * 重命名时同时全选：输入框初始值为原名，用户通常需要整体替换。
   */
  let input!: HTMLInputElement
  onMount(() => {
    input.focus()
    input.select()
  })

  return (
    <div class="tree-edit" style={{ 'padding-left': `${treeIndent(props.depth)}px` }}>
      <Show when={props.chevronDir}>
        {(dir) => (
          <span class="tree-chevron-slot" aria-hidden="true">
            <IconChevron size={11} dir={dir()} />
          </span>
        )}
      </Show>
      <Show when={props.kind === 'file'}>
        <FileTypeIcon name={name()} />
      </Show>
      <Show when={props.kind === 'dir' && !props.chevronDir}>
        <span class="tree-node-icon" aria-hidden="true">
          <IconFolder size={13} />
        </span>
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
          // 失焦即取消，但**存在错误时不取消**：错误信息必须保留在界面上供用户阅读。
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

  // 已展开且该层尚未取回时发起获取。**获取的触发条件是「已展开且缺少数据」**，
  // 不是点击动作：刷新清空缓存后，已展开的目录依靠该条件自行重取。
  createEffect(() => {
    if (open() && children() === null) props.ctx.load(props.node.path)
  })

  const row = (onClick: () => void) => (
    <button
      class="tree-item"
      classList={{ selected: props.ctx.selected() === props.node.path }}
      type="button"
      style={{ 'padding-left': `${treeIndent(props.depth)}px` }}
      draggable={props.node.kind === 'file'}
      onDragStart={(e) => e.dataTransfer?.setData(WORKSPACE_PATH_TYPE, props.node.path)}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        props.ctx.menu(props.node, e.clientX, e.clientY)
      }}
    >
      <Show when={props.node.kind === 'dir'} fallback={<FileTypeIcon name={props.node.name} />}>
        <span class="tree-chevron-slot" aria-hidden="true">
          <IconChevron size={11} dir={open() ? 'down' : 'right'} />
        </span>
      </Show>
      <span class="truncate">{props.node.name}</span>
    </button>
  )

  return (
    <li>
      <Show
        when={editing()}
        fallback={
          <Show when={props.node.kind === 'dir'} fallback={row(() => props.ctx.pick(props.node))}>
            {row(() => props.ctx.toggle(props.node))}
          </Show>
        }
      >
        <NameRow
          ctx={props.ctx}
          kind={props.node.kind}
          depth={props.depth}
          value={props.node.name}
          chevronDir={props.node.kind === 'dir' ? (open() ? 'down' : 'right') : undefined}
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
 * 对单个文件的**一次**改动。
 *
 * `body` 是该次改动的正文，完全取自该步骤落库的入参，与会话流中展开该步骤时显示的
 * 是同一份数据（`Transcript.tsx` 的 `StepBody`）：编辑提供 old/new 两段，
 * 完整写入提供写入的全部内容。
 */
interface ChangeEdit {
  tool: string
  /** 执行者：子 agent 或外部 CLI 节点的名称；本会话自身执行时为 null。 */
  via: string | null
  changeType: FileChange['changeType']
  /** 缺省表示行数未知：shell 与外部 CLI 的写入由观察器判定，无法取得改动前的内容。 */
  additions?: number
  deletions?: number
  body: { removed: string; added: string } | { written: string } | null
}

/**
 * 该步骤的正文。**按入参结构识别，不按工具名识别**（同 `step-view.ts` 的 `diffFrom`）。
 *
 * 三种结构互不冲突：完整写入的入参中没有 old/new，编辑的入参中没有 content，
 * shell 的入参只有 command，其正文即执行的命令。
 * 不要为完整写入构造增删对比：旧内容只在工具执行时存在，从未写入数据库。
 */
function bodyOf(args: Record<string, unknown> | undefined): ChangeEdit['body'] {
  if (!args) return null
  const diff = diffFrom(args)
  if (diff) return diff
  const written = firstString(args, 'content', 'text', 'command')
  return written ? { written: clamp(written) } : null
}

/** 一轮中对单个文件的改动汇总。净效果字段由 `foldFileChanges` 提供，此处只补充每次改动的明细。 */
interface ChangedFile extends FoldedFileChange {
  /** 每次改动，按时间顺序排列。**同一个文件修改十次即记录十条。** */
  edits: ChangeEdit[]
}

/**
 * 将一轮的写入按路径折叠为文件行。
 *
 * **折叠规则位于 `foldFileChanges`（`@qywork/core`），不在此处**：表头的合计由服务端
 * 对每一轮调用同一函数算出，两处分别实现折叠必然不一致：被丢弃的行会从行列表中消失，
 * 却仍计入表头。此处只按相同顺序把每次改动关联到折叠后的行。
 */
function foldTurn(turn: ChangeTurn): ChangedFile[] {
  const flat: FileChange[] = []
  const edits = new Map<string, ChangeEdit[]>()
  for (const step of turn.steps) {
    for (const c of step.fileChanges) {
      flat.push(c)
      // 该步骤的入参已在账本中，正文取自入参，不另行保存。
      const edit: ChangeEdit = {
        tool: step.toolName,
        via: step.via?.name ?? null,
        changeType: c.changeType,
        ...(c.additions === undefined ? {} : { additions: c.additions }),
        ...(c.deletions === undefined ? {} : { deletions: c.deletions }),
        body: bodyOf(step.args),
      }
      const known = edits.get(c.path)
      if (known) known.push(edit)
      else edits.set(c.path, [edit])
    }
  }
  return foldFileChanges(flat).map((f) => ({ ...f, edits: edits.get(f.path) ?? [] }))
}

/**
 * 当前会话修改过的文件，按轮次分组。**不使用 git。**
 *
 * 真源是 step 账本：写类工具的回执带有 `fileChanges`（修改的路径，以及可取得时的增删行数）。
 * 服务端按「写入过文件的轮次」投影并分页（`/changes`），运行期间的回执直接追加到同一份数据
 * （`store/connection.ts`）。**不从会话流折叠**：会话流只加载最后几轮，在长会话中由它折叠出的
 * 记录不完整，表头数值也会随之出错。
 *
 * 不使用 git 不是因为无法取得，而是因为 git 回答的是另一个问题：工作区相对 HEAD
 * 的差异中混有用户在编辑器中的修改、其他会话的修改以及全部未跟踪的
 * 文件。本页只回答当前会话做了哪些修改。两个问题放在同一面板中会形成两本账。
 *
 * 口径：
 * - **每轮一节**，最新在上且默认展开，更早的轮次收起，只显示节标题。节标题是用户的消息。
 * - 节内每个文件一行，行上的数值是该轮对该文件的改动量；展开后显示每次改动。
 * - 表头数值是整个会话的合计，由服务端计算，不是已加载分页之和；它与行使用同一个折叠
 *   函数（`foldFileChanges`），因此新建后又删除的文件在两处同时剔除。
 * - 没有 `fileChanges` 的调用不计入：读取操作，以及写入失败的文件工具。
 * - 文件类工具给出精确行数；`run_command` 与外部 CLI 的写入由观察器判定，只有变更类型，
 *   没有行数。
 */
function ChangeRecord() {
  const conversationId = () => state.activeConversation
  const changes = () => view().changes
  createEffect(
    on(conversationId, (id) => {
      if (id) void loadConversationChanges(id)
    }),
  )
  const retry = () => {
    const id = conversationId()
    if (id) void loadConversationChanges(id)
  }

  return (
    <Switch>
      <Match when={changes()?.turns.length === 0 && changes()?.error}>
        {(error) => (
          <div class="change-more" role="alert">
            <span>历史记录加载失败：{error()}</span>
            <button class="ghost-btn" type="button" onClick={retry}>
              重试
            </button>
          </div>
        )}
      </Match>
      {/* 没有任何记录时整页留空：空状态不写引导文案。 */}
      <Match when={changes()?.turns.length ? changes() : null}>
        {(loaded) => (
          <div class="change-panel">
            <div class="change-head">
              <span>变更 {loaded().totals.paths.length} 个文件</span>
              <span class="change-delta">
                <span class="add">+{loaded().totals.additions}</span>
                <span class="del">−{loaded().totals.deletions}</span>
              </span>
            </div>
            <ChangeList changes={loaded()} conversationId={conversationId()} />
          </div>
        )}
      </Match>
    </Switch>
  )
}

/**
 * 轮次清单。独立为组件，使哨兵观察器与该子树的生命周期一致：
 * 面板留空时组件不存在，观察器也不存在。
 */
function ChangeList(props: { changes: ChangesView; conversationId: string | null }) {
  /**
   * 用户明确展开或收起过的轮次。没有记录的按默认状态：最新一轮展开，其余收起。
   * 记录明确的状态值而不是切换标记：新一轮到达后，原先的第一轮移到第二位，
   * 未点击过时按默认收起，点击过时保持用户设定的状态。
   */
  const [explicit, setExplicit] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const turnOpen = (turnId: string, index: number) => explicit().get(turnId) ?? index === 0
  const toggleTurn = (turnId: string, index: number) =>
    setExplicit((cur) => new Map(cur).set(turnId, !turnOpen(turnId, index)))

  /** 已展开的文件，键为「轮次 + 路径」：同一文件在不同轮次中分别展开或收起。 */
  const [openFiles, setOpenFiles] = createSignal<ReadonlySet<string>>(new Set())
  const fileKey = (turnId: string, path: string) => `${turnId}\n${path}`
  const toggleFile = (key: string) =>
    setOpenFiles((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })

  let list!: HTMLUListElement
  let sentinel!: HTMLLIElement
  const loadOlder = async () => {
    if (!props.conversationId) return false
    return loadOlderConversationChanges(props.conversationId)
  }
  onMount(() => {
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (!(await loadOlder())) return
        // 一页加载完成后哨兵可能仍在视口中，观察器不会再次通知：重新观察一次以取得初始通知。
        io.unobserve(sentinel)
        io.observe(sentinel)
      },
      { root: list },
    )
    io.observe(sentinel)
    onCleanup(() => io.disconnect())
  })

  return (
    <ul class="tree tree-top" ref={list}>
      {/* 净效果为空的轮次不显示节标题：`foldTurn` 已丢弃这些轮次的全部行，展开后也没有内容。 */}
      <For each={props.changes.turns.filter((t) => foldTurn(t).length > 0)}>
        {(turn, index) => {
          const files = createMemo(() => foldTurn(turn))
          const additions = () => files().reduce((n, f) => n + f.additions, 0)
          const deletions = () => files().reduce((n, f) => n + f.deletions, 0)
          const open = () => turnOpen(turn.userMessageId, index())
          return (
            <li>
              {/* 行与文件树使用同一套类名与缩进（`treeIndent`）：轮次是第 0 层，文件是第 1 层。
                  不另行定义对齐数值：两份数值会逐渐不一致。 */}
              <button
                class="tree-item change-turn"
                type="button"
                style={{ 'padding-left': '2px' }}
                aria-expanded={open()}
                onClick={() => toggleTurn(turn.userMessageId, index())}
              >
                <span class="tree-chevron-slot" aria-hidden="true">
                  <IconChevron size={11} dir={open() ? 'down' : 'right'} />
                </span>
                <span class="truncate">{turn.text}</span>
                <span class="change-count">{files().length} 个文件</span>
                <Show when={files().some((f) => f.counted)}>
                  <span class="change-delta">
                    <span class="add">+{additions()}</span>
                    <span class="del">−{deletions()}</span>
                  </span>
                </Show>
              </button>
              <Show when={open()}>
                <ul class="tree tree-terminal change-files">
                  <For each={files()}>
                    {(r) => {
                      const key = fileKey(turn.userMessageId, r.path)
                      const fileOpen = () => openFiles().has(key)
                      return (
                        <li>
                          {/* 点击一行即展开该文件的每次改动，已展开的行高亮（与文件树的选中样式相同）。
                              **不实现为「打开文件」**：文件正文在「文件」页，本页回答的是
                              该轮对文件做了哪些修改。 */}
                          <button
                            class="tree-item change-row"
                            classList={{ selected: fileOpen() }}
                            type="button"
                            style={{ 'padding-left': `${treeIndent(1)}px` }}
                            aria-expanded={fileOpen()}
                            data-tip={nativePath(r.path)}
                            onClick={() => toggleFile(key)}
                          >
                            {/* 该行是可展开的节点，图标位显示折叠符号，与文件树的目录行相同。 */}
                            <span class="tree-chevron-slot" aria-hidden="true">
                              <IconChevron size={11} dir={fileOpen() ? 'down' : 'right'} />
                            </span>
                            {/* 行上显示工作区相对路径，路径较短，末尾截断时仍能保留文件名；绝对路径在悬停提示中。 */}
                            <span class="truncate">{r.path}</span>
                            {/* 改动次数只在多次修改时显示：只修改一次的文件标注「1 次」没有信息量。 */}
                            <Show when={r.edits.length > 1}>
                              <span class="change-times">{r.edits.length} 次</span>
                            </Show>
                            {/* 没有行数时只显示变更类型：删除的行数为 0/0，观察器判定的写入
                                没有行数，显示为 +0 −0 会被理解为没有任何修改。 */}
                            <Show
                              when={r.counted && r.changeType !== 'deleted'}
                              fallback={<span class="change-kind">{kindLabel(r.changeType)}</span>}
                            >
                              <span class="change-delta">
                                <span class="add">+{r.additions}</span>
                                <span class="del">−{r.deletions}</span>
                              </span>
                            </Show>
                          </button>
                          <Show when={fileOpen()}>
                            <ol class="change-edits">
                              <For each={r.edits}>
                                {(e, i) => (
                                  <li class="change-edit">
                                    <div class="edit-head">
                                      <span class="edit-no">#{i() + 1}</span>
                                      <span class="edit-tool">
                                        {e.via ? `${e.via} · ` : ''}
                                        {editLabel(e.tool)}
                                      </span>
                                      <Show
                                        when={
                                          e.additions !== undefined && e.changeType !== 'deleted'
                                        }
                                        fallback={
                                          <span class="change-kind">{kindLabel(e.changeType)}</span>
                                        }
                                      >
                                        <span class="change-delta">
                                          <span class="add">+{e.additions}</span>
                                          <span class="del">−{e.deletions}</span>
                                        </span>
                                      </Show>
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
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </li>
          )
        }}
      </For>
      {/* 清单末尾用于加载下一页：加载中与失败各占一行；没有更多记录时留空，仅作为观察器的哨兵。 */}
      <li class="change-more" ref={sentinel}>
        <Switch>
          <Match when={props.changes.loading === 'older'}>
            <IconSpinner size={13} />
            正在加载更早记录…
          </Match>
          <Match when={props.changes.error}>
            {(error) => (
              <>
                <span role="alert">历史记录加载失败：{error()}</span>
                <button class="ghost-btn" type="button" onClick={() => void loadOlder()}>
                  重试
                </button>
              </>
            )}
          </Match>
        </Switch>
      </li>
    </ul>
  )
}

/**
 * 该次改动使用的操作。
 *
 * 无法识别的工具名原样显示：写类工具可以增加（插件也可提供），
 * 回退为「编辑」会把整份覆盖显示为局部修改。
 */
function editLabel(tool: string): string {
  if (tool === 'edit_file') return '编辑'
  if (tool === 'write_file') return '完整写入'
  if (tool === 'write_memory') return '记忆'
  if (tool === 'delete_memory') return '删除记忆'
  if (tool === 'move_memory') return '移动记忆'
  if (tool === 'run_command') return '运行命令'
  if (tool === 'cli') return 'CLI'
  return tool
}

function kindLabel(kind: FileChange['changeType']): string {
  if (kind === 'created') return '新建'
  if (kind === 'deleted') return '已删除'
  if (kind === 'renamed') return '重命名'
  return '已修改'
}

/**
 * 将账本中的路径转换为本机绝对路径。
 *
 * **账本中也有本身就是绝对路径的条目**：写入工作区之外时（`full` 模式、
 * 额外目录），`displayPath` 返回绝对路径。不识别这种情况会拼接出
 * `C:\项目\C:\别处\x.ts`。
 */
function nativePath(p: string): string {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : absPath(p)
}
