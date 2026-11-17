import type { Component, JSX } from 'solid-js'
import { createSignal, For, lazy, onCleanup, Show, Suspense } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import type { OfficeFormat } from '../lib/file-search.ts'
import {
  activePanelTab,
  browserReady,
  canvasAvailable,
  closePanel,
  closePanelTab,
  createCanvas,
  explainApiError,
  isDesktopShell,
  openBrowserTab,
  openFileInPanel,
  openFileTab,
  openPanelTab,
  openWorkbenchTab,
  type PanelTab,
  type PanelView,
  panelMaximized,
  panelTabs,
  panelWidth,
  refreshWorkbenches,
  resizePanel,
  setSidePanel,
  setState,
  sidePanel,
  togglePanelMax,
  workbenches,
  workbenchKey,
  workspace,
} from '../lib/store/index.ts'
import {
  IconCanvas,
  IconExpand,
  IconFile,
  IconGlobe,
  IconPlug,
  IconPlus,
  IconTerminal,
  IconX,
} from './Icons.tsx'
import { OfficePicker } from './office/OfficePicker.tsx'
import { ChangeRecord } from './side-panel/ChangeRecord.tsx'
import { FileBrowser, FileTab } from './side-panel/FileBrowser.tsx'
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

// 外部 CLI 页：只在从图卡片打开 CLI 节点时加载。
const CliPanel = lazy(() => import('./CliPanel.tsx'))

// 画布页：只在打开画布时下载。
const CanvasPanel = lazy(() => import('./canvas/CanvasPanel.tsx'))
// 工作台页：只在打开插件提供的工作台时下载。
const WorkbenchPanel = lazy(() => import('./WorkbenchPanel.tsx'))

// 同样懒加载：运行页挂载后即请求两个接口，不打开它的用户不应为它承担首屏成本。
const RunDetails = lazy(() => import('./RunDetails.tsx'))

/**
 * 固定页签与各自的正文。键的书写顺序即页签栏上的顺序，也是优先级。
 * **它们不可关闭，始终位于页签栏最前面。** 键是 `PanelView` 的全集，缺少一种时类型检查失败。
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
const VIEWS: { readonly [K in PanelView]: { label: string; pane: Component } } = {
  // 待办排在最前：它回答「本轮正在执行什么」，优先于「有哪些文件」。
  todos: { label: '待办', pane: TodoPanel },
  files: { label: '文件', pane: FileBrowser },
  changes: { label: '变更', pane: ChangeRecord },
  // 运行排在末位：查看费用是事后操作，优先级低于当前执行状态。
  runs: {
    label: '运行',
    // 自带 Suspense，理由同可多开的页：没有边界时，组件挂起会使整棵树短暂变空。
    pane: () => (
      <Suspense fallback={<div class="pane-loading" />}>
        <RunDetails />
      </Suspense>
    ),
  },
}

/** 固定页签在页签栏上的顺序，即 `VIEWS` 的键的书写顺序。 */
const VIEW_ORDER = Object.keys(VIEWS) as PanelView[]

/**
 * 每种可多开的页的正文。键是 `PanelTab['kind']` 的全集，缺少一种时类型检查失败。
 */
const TAB_VIEWS: {
  readonly [K in PanelTab['kind']]: Component<{ tab: PanelTab & { kind: K } }>
} = {
  terminal: (p) => <TerminalPanel id={p.tab.id} />,
  browser: (p) => <BrowserPanel id={p.tab.id} />,
  preview: (p) => <PreviewPanel id={p.tab.id} />,
  conversation: (p) => <ConversationPanel id={p.tab.id} />,
  cli: (p) => <CliPanel id={p.tab.id} />,
  canvas: (p) => <CanvasPanel path={p.tab.path} active={activePanelTab() === p.tab.id} />,
  plugin: (p) => <WorkbenchPanel workbench={p.tab.workbench} />,
  file: (p) => <FileTab path={p.tab.path} />,
}

/**
 * 按页的类型取出正文组件。表以 `kind` 为键，每一项只接受该类型的页；TypeScript 无法把按 `tab.kind`
 * 取出的组件与 `tab` 本身关联，因此在这一处把组件类型放宽为接受全部页。
 */
function tabView(tab: PanelTab): Component<{ tab: PanelTab }> {
  return TAB_VIEWS[tab.kind] as Component<{ tab: PanelTab }>
}

/** 看板上的「无限画布」：在工作区根新建一张空画布并打开它。 */
async function openNewCanvas(): Promise<void> {
  const path = await createCanvas()
  openFileInPanel(path)
}

/**
 * 看板 Office 行打开的文件选择框的格式，`null` 为未打开。放在模块级：选择框在看板关闭之后才显示，
 * 不能属于看板组件；`SidePanel` 卸载时清除。
 */
const [officePick, setOfficePick] = createSignal<OfficeFormat | null>(null)

/**
 * 「新开预览」看板的各行。**每一行都会新开一页**，因此固定页签不在此处：
 * 它们始终位于页签栏上，列出后点击也不会新开一页。
 *
 * 各行的可用条件如下，不要按标签推测：终端依赖 Rust 侧的 PTY，只在桌面端可用；内置浏览器由
 * 桌面外壳的宿主承载（Windows 嵌入面板，macOS 与 Linux 显示在浏览器的独立窗口中），
 * 宿主连接后才可用，其他端改用 HTTP 网页预览（iframe，只读）。无限画布只在鼠标端提供入口（`canvasAvailable`）；
 * Word、PPT 与 Excel 打开工作区文件选择框（只列出 `packages/server/src/files.ts` 的 `classify` 归入 docx、pptx
 * 或 xlsx 格式的文件），选中后新开文件预览页。
 */
const PREVIEW_SOURCES: {
  key: string
  label: string
  icon: (p: { size?: number }) => JSX.Element
  open: () => void
  /** 当前端不具备该能力时整行不渲染。 */
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
    open: () =>
      void openBrowserTab().catch((e: unknown) =>
        setState('notice', {
          reason: 'browser_open_failed',
          message: `无法打开浏览器页面：${explainApiError(e, '请求失败')}`,
        }),
      ),
  },
  {
    /*
     * 网页预览**只在没有桌面外壳的端提供**，不按宿主是否连接判定。
     * 按可用性判定时，外壳上的宿主启动失败后会改用 iframe：该页面
     * 外观相同，但没有登录状态、不受 AI 控制，用户无法区分两者。
     */
    key: 'preview',
    label: '网页预览',
    icon: IconGlobe,
    show: () => !isDesktopShell(),
    open: () => openPanelTab('preview'),
  },
  { key: 'word', label: 'Word', icon: IconFile, open: () => setOfficePick('docx') },
  { key: 'ppt', label: 'PPT', icon: IconFile, open: () => setOfficePick('pptx') },
  { key: 'excel', label: 'Excel', icon: IconFile, open: () => setOfficePick('xlsx') },
  {
    key: 'canvas',
    label: '无限画布',
    icon: IconCanvas,
    show: canvasAvailable,
    open: () =>
      void openNewCanvas().catch((e: unknown) =>
        setState('notice', {
          reason: 'canvas_create_failed',
          message: `无法新建画布：${explainApiError(e, '请求失败')}`,
        }),
      ),
  },
]

/** 每次渲染时重新计算：内置浏览器要等宿主连接，而宿主在应用启动之后才连接。 */
const boardRows = () => PREVIEW_SOURCES.filter((s) => s.show?.() ?? true)

/**
 * 右侧面板容器。固定页签（`VIEWS`）与可多开的页（`panelTabs`）共用同一区域，
 * 互斥显示。
 *
 * 默认导出供 `App.tsx` 的 `lazy()` 使用：面板及其静态引入的文件树、待办与变更记录不进入首屏，
 * 只使用对话的用户不承担它们的加载成本。CodeMirror 不在本模块的静态依赖中，由文件页懒加载
 * （`FileBrowser` 中的 `FileView`）。
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
  onCleanup(() => setOfficePick(null))

  /** 页签是否高亮。看板覆盖正文时所有页签均不高亮：此时正文不属于任何页签。 */
  const onView = (view: PanelView) => sidePanel() === view && !board()
  const onTab = (id: string) => activePanelTab() === id && !board()
  /** 当前固定视图的正文；显示可多开的页时为 `undefined`。 */
  const viewPane = () => {
    const page = sidePanel()
    return typeof page === 'string' ? VIEWS[page].pane : undefined
  }

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
            <For each={VIEW_ORDER}>
              {(view) => (
                <button
                  class="side-tab"
                  classList={{ active: onView(view) }}
                  type="button"
                  role="tab"
                  aria-selected={onView(view)}
                  onClick={() => {
                    // 点击页签即关闭看板：不关闭时页签已高亮而正文仍是看板，
                    // 点击看起来没有生效。
                    setBoard(false)
                    setSidePanel(view)
                  }}
                >
                  {VIEWS[view].label}
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
              onClick={() => {
                // 每次打开看板都重新读取工作台：插件可能刚由模型安装或在设置页卸载。
                if (!board()) void refreshWorkbenches().catch(() => undefined)
                setBoard((v) => !v)
              }}
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
           * 文件树的数据已更新而这些状态仍是旧值，点击不产生任何响应。
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
              <Dynamic component={viewPane()} />

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
                      <Dynamic component={tabView(t)} tab={t} />
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
        <Show when={officePick()}>
          {(format) => (
            <OfficePicker
              format={format()}
              onPick={(path) => {
                setOfficePick(null)
                openFileTab(path)
              }}
              onClose={() => setOfficePick(null)}
            />
          )}
        </Show>
      </aside>
    </Show>
  )
}

/**
 * 新开预览看板。各行由 `PREVIEW_SOURCES` 决定。
 *
 * **位于面板正文中，不是浮层。** 浮层菜单只能容纳三四行，且会遮挡下方内容；
 * 该清单列出面板可打开的全部页面，因此占满整个区域。
 */
function PreviewBoard(props: { onPick: () => void }) {
  return (
    <div class="preview-board">
      <For each={boardRows()}>
        {(s) => (
          <button
            class="board-item"
            type="button"
            onClick={() => {
              // **先关闭看板，再打开新页。** 顺序相反时新页会在 `display: none`
              // 的容器中挂载，而 xterm 挂载后立即测量字符宽高，测得 0 时要等下一次
              // 尺寸变化才会重新测量。
              props.onPick()
              s.open()
            }}
          >
            <s.icon size={15} />
            <span class="board-label truncate">{s.label}</span>
          </button>
        )}
      </For>
      {/* 已安装插件提供的工作台，排在固定行之后。 */}
      <For each={workbenches()}>
        {(w) => (
          <button
            class="board-item"
            type="button"
            onClick={() => {
              props.onPick()
              openWorkbenchTab(workbenchKey(w), w.title)
            }}
          >
            <IconPlug size={15} />
            <span class="board-label truncate">{w.title}</span>
          </button>
        )}
      </For>
    </div>
  )
}
