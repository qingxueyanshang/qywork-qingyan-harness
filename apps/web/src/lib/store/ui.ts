/**
 * 纯界面状态：右侧面板、浮层与当前工作区。
 *
 * 这些状态与服务端无关，不放入 `state`：放入业务 store 会使每次事件推送都需要跳过大量与服务端无关的字段。
 * 表示页面位置与可见内容的状态经 `sessionSignal` 记录，整页刷新后恢复；右侧面板的页签与当前页
 * 记录在 localStorage 中，应用重启后同样恢复（`panels`）。浮层计数等一次操作过程中的状态不记录。
 */

import { type SharedPanelTab, sharedPanelTabId } from '@qywork/core'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { createStore, unwrap } from 'solid-js/store'
import { readSession, sessionSignal, writeSession } from '../session.ts'
import type { TerminalSession } from '../terminal.ts'
import { isDesktopShell, tauriInvoke } from './shell.ts'

/**
 * 右侧面板的固定页。不可关闭，始终位于页签条最前面。
 *
 * 每个值对应 `SidePanel` 的 `VIEWS` 中的一项（页签名与正文），缺少一项时类型检查失败。
 *
 * 打开的文件不是其中一个值：它显示在文件页中（`openFile` + `FileView`），
 * 与文件树并排。
 *
 * 终端不在此列：终端页可多开、可关闭，见 `PanelTabKind`。
 */
export type PanelView = 'todos' | 'files' | 'changes' | 'runs'

/**
 * 可多开的页类型。
 *
 * `terminal` 仅桌面端存在（PTY 是本机进程与一对系统句柄）。`browser` 是 Windows
 * 桌面外壳中的内置浏览器，每页对应一个原生子 WebView，页签 id 由宿主分配（应用重启后恢复、
 * 尚未显示的页除外，见其 `live` 字段）；
 * `preview` 是其他端上的 HTTP 网页预览，每页对应一个 iframe，地址由用户输入。
 * 两者不是同一功能的两个档位：前者可由 AI 操作并保留登录状态，后者只能浏览。
 * 本层不判断运行端：判断在入口处（`SidePanel` 的看板）完成，本层只记录打开了哪些页。
 *
 * `conversation` 与 `cli` 没有看板入口，只能从图卡上打开（显示哪一条由该卡片决定），
 * 因此没有序号，标题即对应节点的名称。两者区分是因为来源不同：
 * 前者是子会话（有正文与工具卡），后者是本机另一个进程输出的文本流。
 *
 * `canvas` 是画布，每页对应一个 `*.canvas.json`（`path`），从看板新建或从文件树打开。
 *
 * `file` 是文件预览页，每页对应一个工作区文件（`path`），从看板的 Office 行选择文件后打开。
 *
 * `plugin` 是插件提供的工作台，每页对应一个工作台（`workbench`），从看板或 `open_in_panel` 打开。
 *
 * 后三种是各客户端共享的页签（`SHARED_KINDS`）：清单的权威在电脑上（服务端，`panel.tabs` 推送），本层的记录是其投影
 * （`syncSharedTabs`），打开与关闭经 `panel-share.ts` 通知服务端。
 */
export type PanelTabKind =
  | 'terminal'
  | 'browser'
  | 'preview'
  | 'conversation'
  | 'cli'
  | 'canvas'
  | 'file'
  | 'plugin'

interface PanelTabBase {
  id: string
  /**
   * 页签标题。创建后不再修改。
   *
   * 不要改为随内容变化（终端中的当前命令、浏览器页的站点名）：标题变化会改变页签宽度，
   * 使用户正要点击的 × 移位。
   */
  title: string
  /**
   * 创建序号，页签条按它排序。
   *
   * 外壳创建的页（终端、内置浏览器）使用外壳进程计数器的值：两份清单分别异步返回，
   * 按到达顺序追加会使整页刷新后的页签顺序与创建顺序不同，而 `terminal-N` 与 `bt_N`
   * 是两个互不相关的计数，无法跨类型比较。纯前端的页使用 `nextLocalSeq`。
   *
   * 应用重启时恢复的页改为不大于 0 的值并保持原顺序（`restoredPanels`）：新的外壳进程从 1 开始计数，
   * 沿用上次运行的值时，新建的页按序号插入到恢复的页之间，而不是排在末尾。
   */
  createdSeq: number
}

/**
 * 一个可多开的页。各类型自带的字段按 `kind` 区分：画布页与文件预览页必有 `path`，
 * 工作台页必有 `workbench`，创建时即写入，此后不修改。
 */
export type PanelTab = PanelTabBase &
  (
    | { kind: 'terminal' | 'conversation' | 'cli' }
    | {
        kind: 'browser'
        /**
         * 网页的地址。宿主中有该页时是宿主上报地址的投影（`alignBrowserTabs` 写入），以宿主为准；
         * 应用重启后宿主中已没有该页，此地址是重新打开它的唯一记录。
         */
        url: string
        /**
         * 宿主中是否有该页。为 `false` 的页由应用启动时恢复（`restoredPanels`），id 由本层分配而不是宿主的
         * tabId，与宿主清单对账时不移除；首次显示时按 `url` 新建页面，原位换为宿主的页（`adoptBrowserTab`）。
         * 一个 id 的该值不会改变：换为宿主的页时 id 一并改变。
         */
        live: boolean
      }
    | {
        kind: 'preview'
        /**
         * 网页预览页的当前地址，且是该地址的唯一记录：收起面板会卸载 `PreviewPanel`，
         * 若地址保存在组件内，再次展开时地址栏为空。新建时未给出地址则没有该字段。
         *
         * 只记录地址，不保留页面状态：iframe 从 DOM 移除后再插入即重新加载，
         * 这是浏览器的行为，前端无法规避。内置浏览器页的地址由原生宿主维护，`browser` 的 `url` 只是其投影。
         */
        url?: string
      }
    | {
        kind: 'canvas' | 'file'
        /** 对应的文件（工作区相对路径）。 */
        path: string
      }
    | {
        kind: 'plugin'
        /**
         * 对应的工作台，`<插件 id>/<工作台 id>`。只记录标识不记录地址：
         * 地址中的随机段每次服务端启动都不同，刷新后按 `workbenches()` 重新取得。
         */
        workbench: string
      }
  )

/**
 * 面板当前显示的页。`null` 表示收起。
 *
 * 固定视图使用视图名，可多开的页使用 `{ tab: id }`。必须是一个信号，不要拆成「固定视图」
 * 与「当前页签」两个信号：拆开后「显示文件页」与「显示终端页」在类型上可以同时成立，
 * 优先级只能由每个调用点自行保证，形成第二本账。
 */
export type PanelPage = PanelView | { tab: string }

/**
 * 单个工作区的面板：打开了哪些页，当前显示哪一页。
 *
 * 两者放在同一个条目中，而不是两张按工作区索引的表：当前页通常是 `tabs` 中的一项，
 * 分开存储时「页签已是 B 的、当前页仍是 A 的」在类型上合法。
 */
interface WorkspacePanel {
  tabs: readonly PanelTab[]
  page: PanelPage | null
}

const EMPTY_PANEL: WorkspacePanel = { tabs: [], page: null }

/**
 * 面板状态按工作区分别记录。切换工作区不释放任何资源，只改用另一个键读取。
 *
 * 键只能是 `WorkspaceInfo.id`。没有活动工作区时不创建条目：空字符串键的条目
 * 在任何工作区下都无法读取，其中登记的 PTY 与原生页此后没有任何界面可以访问。
 *
 * 记录保存在 localStorage 中，整页刷新与应用重启后都按记录恢复全部页签与当前页，两种情况的处理不同。
 * 整页刷新时外壳进程仍在，终端与内置浏览器页的权威在外壳，恢复的页签随后与宿主清单对账
 * （`restoreTerminalTabs` / `syncBrowserTabs`），外壳中已不存在的页在对账时移除。应用启动时外壳进程是新的，
 * 记录先经 `restoredPanels` 改写，再与宿主清单对账。
 */
const PANELS_KEY = 'qywork.panel.tabs'

/**
 * 本次页面加载是否为应用启动，而不是整页刷新。
 *
 * sessionStorage 属于主窗口的 WebView，整页刷新时保留，应用重启后为空，因此首次加载时写入一个标记，
 * 之后的加载读取到它即为刷新。标记直接写入，不经 `sessionSignal` 在 `pagehide` 时写入：页面异常退出后
 * 重新加载时不触发 `pagehide`，而外壳进程与其中的页面仍在。
 *
 * 无法访问 sessionStorage 时按刷新处理：刷新只按宿主清单移除已不存在的页，不改写记录。
 */
function appStarting(): boolean {
  const key = 'qywork.panel.started'
  try {
    if (sessionStorage.getItem(key) !== null) return false
    sessionStorage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}

function readPanels(): Record<string, WorkspacePanel> {
  try {
    const raw = localStorage.getItem(PANELS_KEY)
    return raw === null ? {} : (JSON.parse(raw) as Record<string, WorkspacePanel>)
  } catch {
    // 隐私模式下 localStorage 会直接抛出异常；记录无法读取或解析时没有可恢复的页。
    return {}
  }
}

/**
 * 写入记录。每次修改同步写入，不在 `pagehide` 时批量写入：应用被强制结束时页面不触发 `pagehide`。
 * 修改来自新建、关闭与切换页以及网页标题与地址的变化，不随拖动或输入逐帧发生。
 */
function savePanels(all: Readonly<Record<string, WorkspacePanel>>): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(all))
  } catch {
    // 同上：本次修改已生效，保存失败只影响下次启动。
  }
}

/** 应用启动时须立即写入改写后的记录：此后整页刷新读取的是该记录，读取到改写前的记录时会按旧 id 对账。 */
function initialPanels(): Record<string, WorkspacePanel> {
  const saved = readPanels()
  if (!appStarting()) return saved
  const restored = restoredPanels(saved)
  savePanels(restored)
  return restored
}

const [panels, setPanels] = createSignal<Readonly<Record<string, WorkspacePanel>>>(initialPanels())

function panelOf(wsId: string | undefined): WorkspacePanel {
  return (wsId ? panels()[wsId] : undefined) ?? EMPTY_PANEL
}

/**
 * 按显式指定的工作区修改条目。这是修改面板状态的唯一入口，修改后写入记录（`savePanels`）。
 *
 * 宿主投影与异步响应必须使用资源自带的工作区调用它，不要在 await 之后读取当前工作区：
 * 请求期间用户可能已切换工作区，响应时的当前工作区可能是 B，写入会把 A 的页记入 B 的条目。
 */
function updatePanel(wsId: string, next: (cur: WorkspacePanel) => WorkspacePanel): void {
  setPanels((all) => ({ ...all, [wsId]: next(all[wsId] ?? EMPTY_PANEL) }))
  savePanels(panels())
}

/**
 * 应用启动时由上次运行的记录得到的面板。外壳进程是新的，上次运行中的 PTY、子进程与原生页面都已不存在：
 *
 * - 终端页与外部 CLI 页移除。前者的进程已结束；后者显示上次运行中的进程的输出，且按当前会话的记录定位，
 *   而当前会话不随应用重启恢复。
 * - 内置浏览器页改为宿主中没有对应页面的记录（`live: false`），保留标题、地址与位置，id 改由本层分配：
 *   宿主的 tabId 随新进程从 `bt_1` 重新计数，沿用旧 id 会与新建的页重复。已是该状态的页同样重新分配 id。
 *   只在桌面外壳中如此：其他客户端的页面在电脑上，不随本页面加载重启，浏览器页原样保留，由服务端的清单对账
 *   （`browser.tabs`）；改为恢复记录时，每次加载都会在电脑上按记录新建一份页面。
 * - 其余页原样保留：它们的内容按路径、地址或标识重新读取。
 * - 全部页的创建序号改为不大于 0 的值并保持原顺序，理由见 `createdSeq`。
 *
 * 当前页被移除时按 `pageWithout` 改为相邻页。
 */
function restoredPanels(
  saved: Readonly<Record<string, WorkspacePanel>>,
): Record<string, WorkspacePanel> {
  let seq = -Object.values(saved).reduce((n, panel) => n + panel.tabs.length, 0)
  let browsers = 0
  const next: Record<string, WorkspacePanel> = {}
  for (const [wsId, panel] of Object.entries(saved)) {
    const gone = panel.tabs.filter((t) => t.kind === 'terminal' || t.kind === 'cli')
    const ids = new Map<string, string>()
    const tabs = panel.tabs
      .filter((t) => !gone.includes(t))
      .map((t): PanelTab => {
        seq += 1
        if (t.kind !== 'browser' || !isDesktopShell()) return { ...t, createdSeq: seq }
        browsers += 1
        const id = `browser-${browsers}`
        ids.set(t.id, id)
        return { ...t, id, createdSeq: seq, live: false }
      })
    const page = pageWithout(panel, gone)
    next[wsId] = {
      tabs,
      page:
        page !== null && typeof page === 'object' ? { tab: ids.get(page.tab) ?? page.tab } : page,
    }
  }
  return next
}

/** 当前工作区打开的可多开页。顺序即页签条上的顺序。 */
export function panelTabs(): readonly PanelTab[] {
  return panelOf(workspace()?.id).tabs
}

/** 当前工作区的面板显示的页。`null` 表示收起；没有活动工作区时也为 `null`。 */
export function sidePanel(): PanelPage | null {
  return panelOf(workspace()?.id).page
}

/** 切换到指定页。没有活动工作区时不写入：该页没有可归属的条目。 */
export function setSidePanel(page: PanelPage | null): void {
  const wsId = workspace()?.id
  if (!wsId) return
  updatePanel(wsId, (cur) => ({ ...cur, page }))
}

/**
 * 按显式指定的工作区切换到指定页。
 *
 * 异步响应使用此函数，不要使用 `setSidePanel`：后者读取响应时的当前工作区，
 * 而请求期间用户可能已切换工作区。
 */
export function showPanelTab(wsId: string, id: string): void {
  updatePanel(wsId, (cur) => ({ ...cur, page: { tab: id } }))
}

/** 当前显示的页 id；显示固定视图时为 `null`。这是派生值，不是第二份状态。 */
export function activePanelTab(): string | null {
  const page = sidePanel()
  return page !== null && typeof page === 'object' ? page.tab : null
}

/** 从条目中取出当前显示页的 id。供不便读取当前工作区的投影入口使用。 */
function activeTabOf(panel: WorkspacePanel): string | null {
  const page = panel.page
  return page !== null && typeof page === 'object' ? page.tab : null
}

/**
 * 关闭一页时需要释放的本机资源：终端的 PTY 与 xterm 实例、浏览器页记录的地址。
 *
 * 不放在组件的 `onCleanup` 中：收起面板会卸载整个面板，而此时终端必须保持运行，
 * 用户收起面板查看会话后再切回时，命令必须仍在运行、滚动历史必须保留。「组件卸载」与
 * 「页被关闭」是两件不同的事，只有后者应释放资源，且后者的唯一入口在此。
 *
 * 关闭页的入口：浏览器页为用户点击页签 ×、AI 调用 `browser_tabs(action=close)`、
 * 删除所属会话、应用退出、宿主创建页中途失败时回收未登记的视图；终端为用户点击页签 ×、
 * 应用退出、「重开」按钮替换旧 PTY、子进程自行退出。切换与移除工作区、归档会话、
 * 停止、一轮结束、宿主重连均不关闭页。
 */
const tabDisposers = new Map<string, () => void>()

/** 登记页被关闭时需释放的资源。同一 id 重复登记时以最后一次为准。 */
export function holdPanelTab(id: string, dispose: () => void): void {
  tabDisposers.set(id, dispose)
}

function disposeTab(id: string): void {
  const dispose = tabDisposers.get(id)
  tabDisposers.delete(id)
  dispose?.()
}

/**
 * 每种页各自的序号，只增不减：关闭「终端 1」后，剩余的页仍名为「终端 2」，
 * 已显示的页签不改名。
 */
const TAB_LABEL = { terminal: '终端', preview: '网页预览' } as const
type NumberedKind = keyof typeof TAB_LABEL
const tabSeq: Record<NumberedKind, number> = { terminal: 0, preview: 0 }

/**
 * 纯前端页（网页预览、子会话、外部 CLI）的创建序号。
 *
 * 该计数须随已见到的外壳序号提升。否则先打开三页网页预览再打开一页内置浏览器时，
 * 后者的外壳序号小于前三页，会被插入中间，而新打开的页应位于页签条末尾。
 * 刷新后这些页连同序号一起恢复，外壳进程不随刷新重启，两者的大小关系不变。
 */
let localSeq = 0

// 两个计数都须提升到恢复的页签的最大值，否则刷新后新建的页与恢复的页 id 重复、排在其前面。
for (const panel of Object.values(panels())) {
  for (const t of panel.tabs) {
    localSeq = Math.max(localSeq, t.createdSeq)
    if (t.kind === 'terminal' || t.kind === 'preview') {
      tabSeq[t.kind] = Math.max(tabSeq[t.kind], Number(t.id.slice(t.kind.length + 1)))
    }
  }
}

function nextLocalSeq(): number {
  localSeq += 1
  return localSeq
}

/** 记录一个外壳序号，提高本地计数的起点。 */
function noteHostSeq(seq: number): void {
  if (seq > localSeq) localSeq = seq
}

/** 按创建序号将新页插入清单：序号相同时排在已有页之后。 */
function insertBySeq(tabs: readonly PanelTab[], added: readonly PanelTab[]): PanelTab[] {
  const list = [...tabs]
  for (const tab of added) {
    const at = list.findIndex((t) => t.createdSeq > tab.createdSeq)
    list.splice(at < 0 ? list.length : at, 0, tab)
  }
  return list
}

/**
 * 新建一页并切换到该页。`url` 仅用于网页预览页，作为其初始地址。
 *
 * 没有活动工作区时不新建：该页对应 PTY 或 iframe，新建后没有条目可以记录它。
 * 此时也不消耗序号。
 */
export function openPanelTab(kind: NumberedKind, url?: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  tabSeq[kind] += 1
  const n = tabSeq[kind]
  const id = `${kind}-${n}`
  const base = { id, title: `${TAB_LABEL[kind]} ${n}`, createdSeq: nextLocalSeq() }
  // 已开启 `exactOptionalPropertyTypes`：没有地址时该键必须不存在，不能写入 undefined。
  const tab: PanelTab = kind === 'preview' && url ? { ...base, kind, url } : { ...base, kind }
  updatePanel(wsId, (cur) => ({ tabs: [...cur.tabs, tab], page: { tab: id } }))
}

/**
 * 在网页预览页中打开地址。
 *
 * 已有页显示该地址时切换到该页，不并排新建第二页：两页显示同一地址，
 * 内容完全相同（同 `openConversationTab`）。
 */
export function openPreviewTab(url: string): void {
  const open = panelTabs().find((t) => t.kind === 'preview' && t.url === url)
  if (open) {
    setSidePanel({ tab: open.id })
    return
  }
  openPanelTab('preview', url)
}

/** 指定页的当前地址。没有地址或不是网页预览页时为空串。 */
export function panelTabUrl(id: string): string {
  const tab = panelTabs().find((t) => t.id === id)
  return tab?.kind === 'preview' ? (tab.url ?? '') : ''
}

/** 网页预览页导航到另一个地址。 */
export function setPanelTabUrl(id: string, url: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  updatePanel(wsId, (cur) => ({
    ...cur,
    tabs: cur.tabs.map((t) => (t.id === id && t.kind === 'preview' ? { ...t, url } : t)),
  }))
}

/**
 * 按宿主的存活页同步内置浏览器的页签。本函数只做投影：此处增删的页签
 * 不反向决定宿主打开哪些页，页签 id 即宿主分配的 tabId。
 *
 * 缺少此同步时，整页刷新后页签为空而原生页仍存在，这些页只能在应用退出时回收
 * （同 `restoreTerminalTabs`）。
 *
 * 每页按其自带的工作区记录，不读取当前工作区：本次调用可能发生在模块初始化时
 * （此时尚无活动工作区），清单中也可能包含后台工作区的页。同步范围是
 * 「已有条目中含浏览器页的工作区」与「本次清单中的工作区」的并集：某工作区的最后一页
 * 关闭后，该工作区不出现在清单中，其旧页签与失效的当前页仍须在本次清除。
 *
 * 宿主侧已不存在的页不调用 `tabDisposers`：它负责关闭页时的收尾，
 * 而该页已经关闭，再次调用会对不存在的 tabId 重复执行关闭。
 */
export function syncBrowserTabs(
  tabs: readonly {
    id: string
    title: string
    url: string
    workspaceId: string
    createdSeq: number
    opener?: string
  }[],
): void {
  const groups = new Map<string, HostTab[]>()
  for (const [wsId, panel] of Object.entries(panels())) {
    if (panel.tabs.some((t) => t.kind === 'browser' && t.live)) groups.set(wsId, [])
  }
  for (const t of tabs) {
    noteHostSeq(t.createdSeq)
    const list = groups.get(t.workspaceId) ?? []
    list.push({
      id: t.id,
      title: t.title,
      url: t.url,
      createdSeq: t.createdSeq,
      ...(t.opener ? { opener: t.opener } : {}),
    })
    groups.set(t.workspaceId, list)
  }
  for (const [wsId, list] of groups) alignBrowserTabs(wsId, list)
}

interface HostTab {
  id: string
  title: string
  url: string
  createdSeq: number
  /** 打开该页的页。只有页面请求的新窗口有该字段。 */
  opener?: string
}

/**
 * 将一个工作区的浏览器页签同步到给定清单。只按传入的工作区寻址，不读取当前工作区。
 * 页签名与地址取清单中的 `title` 与 `url`：两者是宿主的投影，页面导航后会变化。
 * 未变化的页签保留原对象：页签条与正文按对象区分各页，替换对象会使该页的正文重建。
 *
 * 应用启动时恢复、宿主中尚无对应页面的页（`live: false`）不在清单中，不移除也不更新。
 *
 * 新页按 `createdSeq` 插入而不是追加到末尾：本清单与终端清单分别异步返回，
 * 追加会使整页刷新后的页签顺序取决于返回先后。
 *
 * 面板中显示的页打开了新窗口（`target=_blank` 链接、`window.open`）时切换到新页，与浏览器打开新页签的行为一致；
 * 其余新页（AI 创建的页、后台页打开的新窗口）只加入页签条，不改变当前页。
 */
function alignBrowserTabs(wsId: string, tabs: readonly HostTab[]): void {
  const cur = panelOf(wsId)
  const hosted = new Map(tabs.map((t) => [t.id, t]))
  const known = new Set(cur.tabs.map((t) => t.id))
  const gone = cur.tabs.filter((t) => t.kind === 'browser' && t.live && !hosted.has(t.id))
  const added = tabs
    .filter((t) => !known.has(t.id))
    .map(
      (t): PanelTab => ({
        id: t.id,
        kind: 'browser',
        title: t.title,
        url: t.url,
        live: true,
        createdSeq: t.createdSeq,
      }),
    )
  /** 宿主上报的标题或地址与页签不同时为更新后的页签，否则为 `undefined`。 */
  const updated = (t: PanelTab): PanelTab | undefined => {
    if (t.kind !== 'browser' || !t.live) return undefined
    const h = hosted.get(t.id)
    if (!h || (h.title === t.title && h.url === t.url)) return undefined
    return { ...t, title: h.title, url: h.url }
  }
  if (!gone.length && !added.length && !cur.tabs.some(updated)) return
  for (const t of gone) tabDisposers.delete(t.id)
  const list = insertBySeq(
    cur.tabs.filter((t) => !gone.includes(t)).map((t) => updated(t) ?? t),
    added,
  )
  const shown = activeTabOf(cur)
  const popup = tabs.find((t) => !known.has(t.id) && shown !== null && t.opener === shown)
  updatePanel(wsId, () => ({
    tabs: list,
    page: popup ? { tab: popup.id } : pageWithout(cur, gone),
  }))
}

/**
 * 移除 `gone` 中的页之后应显示的页：当前页被移除时改为右侧相邻页，没有则为左侧相邻页，
 * 都已移除时为文件页；当前页未被移除时不变。
 */
function pageWithout(cur: WorkspacePanel, gone: readonly PanelTab[]): PanelPage | null {
  const orphaned = gone.find((t) => t.id === activeTabOf(cur))
  if (!orphaned) return cur.page
  const i = cur.tabs.indexOf(orphaned)
  const next = cur.tabs[i + 1] ?? cur.tabs[i - 1]
  return next && !gone.includes(next) ? { tab: next.id } : 'files'
}

/** 应用启动时恢复、宿主中尚无对应页面的浏览器页（`live: false`）。其他页与不存在的页为 `undefined`。 */
export function restoredBrowserTab(
  wsId: string | undefined,
  id: string,
): (PanelTab & { kind: 'browser' }) | undefined {
  const tab = panelOf(wsId).tabs.find((t) => t.id === id)
  return tab?.kind === 'browser' && !tab.live ? tab : undefined
}

/**
 * 把恢复的页换为宿主新建的页 `tabId`：位置与标题不变，显示的是该页时当前页随之换为新 id。
 *
 * 宿主新建页面时同时推送清单，该清单可能先于新建结果到达，投影已把新页作为另一页插入页签条，
 * 此处一并移除该项，否则同一页面在页签条上出现两次。
 *
 * 返回 `false` 表示恢复的页已不在条目中（新建期间被关闭），由调用方关闭新建的页面。
 */
export function adoptBrowserTab(wsId: string, id: string, tabId: string): boolean {
  const cur = panelOf(wsId)
  const entry = restoredBrowserTab(wsId, id)
  if (!entry) return false
  const shown = activeTabOf(cur)
  updatePanel(wsId, () => ({
    tabs: cur.tabs
      .filter((t) => t.id !== tabId)
      .map((t) => (t === entry ? { ...entry, id: tabId, live: true } : t)),
    page: shown === id || shown === tabId ? { tab: tabId } : cur.page,
  }))
  return true
}

/**
 * 打开子会话页。
 *
 * 页 id 由会话 id 构成：再次打开同一子会话时切换到已有页，不并排新建第二页，
 * 因为两页显示同一条已执行完毕的会话，内容完全相同。
 */
export function openConversationTab(conversationId: string, title: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  const id = `conversation-${conversationId}`
  updatePanel(wsId, (cur) => ({
    tabs: cur.tabs.some((t) => t.id === id)
      ? cur.tabs
      : [...cur.tabs, { id, kind: 'conversation', title, createdSeq: nextLocalSeq() }],
    page: { tab: id },
  }))
}

/** 各客户端共享的页签类型，见 `PanelTabKind`。 */
export const SHARED_KINDS: ReadonlySet<PanelTabKind> = new Set(['canvas', 'file', 'plugin'])

/** 共享页签的对象：画布与文件为工作区相对路径，工作台为其标识。 */
export type SharedTabTarget =
  | { kind: 'canvas' | 'file'; path: string; title: string }
  | { kind: 'plugin'; workbench: string; title: string }

/**
 * 在本端显示一个共享页签并切换到该页；同一对象已打开时只切换，不并排新建第二页（同 `openConversationTab`）。
 * id 由类型与对象确定（`sharedPanelTabId`），与服务端随后推送的是同一页。返回该页的 id；没有活动工作区时为 `null`。
 * 只由 `panel-share.ts` 调用：打开须同时通知服务端，只在本端显示的页会在下一次推送时被移除。
 */
export function showSharedTab(target: SharedTabTarget): string | null {
  const wsId = workspace()?.id
  if (!wsId) return null
  const id = sharedPanelTabId(target)
  updatePanel(wsId, (cur) => ({
    tabs: cur.tabs.some((t) => t.id === id)
      ? cur.tabs
      : [...cur.tabs, { ...target, id, createdSeq: nextLocalSeq() }],
    page: { tab: id },
  }))
  return id
}

/**
 * 按电脑上的清单（`panel.tabs`）同步全部工作区的共享页签。本函数只做投影，不通知服务端。
 *
 * 同步范围是「已有条目中含共享页签的工作区」与「本次清单中的工作区」的并集，理由同 `syncBrowserTabs`：
 * 某工作区的最后一页在其他客户端关闭后，该工作区不在清单中，本端的页签仍须移除。
 * 本端没有的页追加到末尾，清单中已没有的页移除，当前页被移除时按 `pageWithout` 改为相邻页；未变化的页保留原对象。
 */
export function syncSharedTabs(tabs: readonly SharedPanelTab[]): void {
  const groups = new Map<string, SharedPanelTab[]>()
  for (const [wsId, panel] of Object.entries(panels())) {
    if (panel.tabs.some((t) => SHARED_KINDS.has(t.kind))) groups.set(wsId, [])
  }
  for (const t of tabs) groups.set(t.workspaceId, [...(groups.get(t.workspaceId) ?? []), t])
  for (const [wsId, list] of groups) {
    const cur = panelOf(wsId)
    const listed = new Set(list.map((t) => t.id))
    const known = new Set(cur.tabs.map((t) => t.id))
    const gone = cur.tabs.filter((t) => SHARED_KINDS.has(t.kind) && !listed.has(t.id))
    const added = list
      .filter((t) => !known.has(t.id))
      .map((t): PanelTab => {
        const { workspaceId: _, ...tab } = t
        return { ...tab, createdSeq: nextLocalSeq() }
      })
    if (!gone.length && !added.length) continue
    for (const t of gone) tabDisposers.delete(t.id)
    updatePanel(wsId, () => ({
      tabs: [...cur.tabs.filter((t) => !gone.includes(t)), ...added],
      page: pageWithout(cur, gone),
    }))
  }
}

/** 从页 id 解析会话 id。`openConversationTab` 是唯一的生产者。 */
export function tabConversationId(tabId: string): string {
  return tabId.slice('conversation-'.length)
}

/**
 * 打开外部 CLI 节点页，显示该节点当前的输出。
 *
 * 页 id 由 step id 与节点 id 组成，与该节点的输出缓冲使用同一个键：再次打开同一节点时
 * 切换到已有页，不并排新建第二页。
 */
export function openCliTab(stepId: string, nodeId: string, title: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  const id = `cli-${stepId}-${nodeId}`
  // 标题由调用方单独传入，不以 `nodeId` 代替：单任务派发卡片的节点 id 是内部常量，
  // 直接使用会使页签标题显示为该常量。
  updatePanel(wsId, (cur) => ({
    tabs: cur.tabs.some((t) => t.id === id)
      ? cur.tabs
      : [...cur.tabs, { id, kind: 'cli', title, createdSeq: nextLocalSeq() }],
    page: { tab: id },
  }))
}

/** 从页 id 解析 step id 与节点 id。`openCliTab` 是唯一的生产者。 */
export function tabCliNode(tabId: string): { stepId: string; nodeId: string } {
  const rest = tabId.slice('cli-'.length)
  // step id 不含 `-`（`st_` 加 base36 串），因此第一个 `-` 即分隔位置。
  const cut = rest.indexOf('-')
  return { stepId: rest.slice(0, cut), nodeId: rest.slice(cut + 1) }
}

/**
 * 按外壳的终端会话清单对账终端页签：补充清单中有而页签中没有的，移除页签中有而清单中没有的。
 *
 * `panelTabs` 是 Rust 会话表的镜像，必须在镜像建立时与权威核对一次：刷新后恢复的记录中，
 * 终端可能已在刷新期间结束；记录无法读取时页签为空，而 shell 仍在运行，此时缺少的页签
 * 不是经 `removePanelTab` 移除的，`tabDisposers` 未被调用，该会话只能在应用退出时回收。
 *
 * 只处理终端页签：浏览器页在终端清单中没有对应项。移除的页不调用 `tabDisposers`，
 * 理由同 `syncBrowserTabs`：该会话已经结束。
 *
 * 每条按其自身报告的工作区恢复，不读取当前工作区：本次调用发生在模块初始化时，
 * 此时通常尚无活动工作区，按当前工作区写入会丢弃全部 PTY。
 * 序号取整份清单的最大值，包括其他工作区的条目：`terminal-N` 是 Rust 会话表的键，
 * 在进程内唯一，只按当前工作区计算会使下一次新建的 id 与已有 id 冲突。
 *
 * 恢复的页按 `createdSeq` 插入而不是追加到末尾：本清单与浏览器清单分别异步返回，
 * 追加会使整页刷新后的页签顺序取决于返回先后。
 */
export function restoreTerminalTabs(sessions: readonly TerminalSession[]): void {
  const found = new Map<string, PanelTab[]>()
  const alive = new Set(sessions.map((s) => s.id))
  for (const s of sessions) {
    noteHostSeq(s.createdSeq)
    if (!s.id.startsWith('terminal-')) continue
    const n = Number(s.id.slice('terminal-'.length))
    if (!Number.isInteger(n) || n < 1) continue
    tabSeq.terminal = Math.max(tabSeq.terminal, n)
    if (!s.workspaceId) continue
    if (panelOf(s.workspaceId).tabs.some((t) => t.id === s.id)) continue
    const list = found.get(s.workspaceId) ?? []
    list.push({
      id: s.id,
      kind: 'terminal',
      title: `${TAB_LABEL.terminal} ${n}`,
      createdSeq: s.createdSeq,
    })
    found.set(s.workspaceId, list)
  }
  for (const wsId of new Set([...Object.keys(panels()), ...found.keys()])) {
    const cur = panelOf(wsId)
    const gone = cur.tabs.filter((t) => t.kind === 'terminal' && !alive.has(t.id))
    const added = found.get(wsId) ?? []
    if (!gone.length && !added.length) continue
    for (const t of gone) tabDisposers.delete(t.id)
    const tabs = insertBySeq(
      cur.tabs.filter((t) => !gone.includes(t)),
      added,
    )
    updatePanel(wsId, () => ({ tabs, page: pageWithout(cur, gone) }))
  }
}

/**
 * 在本端关闭一页。这是释放资源的唯一入口（见 `tabDisposers`）。界面经 `panel-share.ts` 的 `closePanelTab` 调用：
 * 共享页签须同时通知服务端，只在本端移除的页会在下一次推送时恢复。
 *
 * 关闭的是当前页时切换到右侧相邻页，没有则切换到左侧相邻页，没有任何页时回到文件视图。
 * 不连带收起面板：用户点击的是该页的 ×，不是面板的 ×。
 */
export function removePanelTab(id: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  const cur = panelOf(wsId)
  const i = cur.tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  const next = cur.tabs[i + 1] ?? cur.tabs[i - 1]
  const tabs = cur.tabs.filter((t) => t.id !== id)
  const page: PanelPage | null =
    activeTabOf(cur) === id ? (next ? { tab: next.id } : 'files') : cur.page
  updatePanel(wsId, () => ({ tabs, page }))
  disposeTab(id)
}

/**
 * 当前打开的浮层数量（设置、确认框、新建项目、面板放大时悬停或聚焦而展开的输入区）。
 *
 * 原生子视图据此让位：内置浏览器页是窗口的子 HWND，绘制在所有 DOM 之上，
 * 浮层的 `z-index` 对它无效，不让位时浮层被网页遮挡。
 * 由浮层自行计数，而不是在此检测 DOM：检测需要选定某个 class 作为判据，
 * 而该 class 改名时不会产生任何报错。
 */
const [overlays, setOverlays] = createSignal(0)

export function overlayOpen(): boolean {
  return overlays() > 0
}

/**
 * 浮层打开时计数加一，关闭或组件卸载时减一。必须在组件作用域中调用。
 *
 * 接收 `open` 而不是只依据挂载：确认框等组件始终挂载，只按 `open` 显示内容。
 */
export function holdOverlay(open: () => boolean): void {
  createEffect(() => {
    if (!open()) return
    setOverlays((n) => n + 1)
    onCleanup(() => setOverlays((n) => Math.max(0, n - 1)))
  })
}

/**
 * 面板最小宽度：文件树与一列内容仍可显示的最小值。
 *
 * 此处只设下限，不设上限。上限属于布局，由 `.app.with-panel` 的
 * `minmax(var(--chat-floor), 1fr)` 决定：网格能取得当前窗口宽度与左栏是否收起，
 * 此处无法取得。在此重复计算会形成第二本账，且只在拖动时成立：
 * 大屏上拖出的宽度在小窗口中会成为超出布局的固定宽度。
 */
export const PANEL_MIN = 337
const PANEL_KEY = 'qywork.panelWidth'
const PANEL_DEFAULT = 380

/** 必须排除负数与 0：`minmax(0, -50px)` 会使整条 `grid-template-columns` 失效，
 *  网格回退为隐式的 auto 列，即本函数要防止的布局失效。 */
function clampPanelWidth(px: number): number {
  return Math.max(PANEL_MIN, Math.round(px))
}

function readPanelWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_KEY))
    return clampPanelWidth(Number.isFinite(v) && v > 0 ? v : PANEL_DEFAULT)
  } catch {
    // 隐私模式下 localStorage 会直接抛出异常。无法保存宽度时不应导致应用无法启动。
    return PANEL_DEFAULT
  }
}

/**
 * 右侧面板的期望宽度（像素）。由用户拖动左边沿修改，保存在 localStorage 中。
 *
 * 真源是该信号，不是 `tokens.css` 的 `--panel-w`：后者只是首次启动的默认值。
 * `App.tsx` 将其写为 `.app` 上的行内 `--panel-w`，网格对应列随之变化，
 * 布局规则无需修改。
 *
 * 它是期望宽度，不是实际宽度：窗口无法容纳时网格只分配到上限，该值仍保持
 * 用户拖出的数值，窗口变宽后恢复。不要在窗口变窄时缩小该值：那会以一次临时的
 * 窗口尺寸覆盖用户的设置。
 *
 * 面板中「内容 + 树」两栏并排，因此宽度必须可拖动：不可拖动时内容栏
 * 不足 200 像素。
 */
export const [panelWidth, setPanelWidthSignal] = createSignal(readPanelWidth())

/**
 * 修改宽度的唯一入口：拖动与方向键都经由此函数。限制下限，并同步落盘。
 *
 * 值未变化时直接返回：拖到下限后继续拖动，每一帧都会调用此函数，
 * 不拦截会产生每秒数十次无意义的 localStorage 写入。
 */
export function resizePanel(px: number): void {
  const next = clampPanelWidth(px)
  if (next === panelWidth()) return
  setPanelWidthSignal(next)
  try {
    localStorage.setItem(PANEL_KEY, String(next))
  } catch {
    // 同上：本次拖动已生效，保存失败只影响下次启动。
  }
}

/**
 * 面板放大：会话正文让出位置，面板独占内容区；输入框默认收为底部触发条，悬停、
 * 聚焦或有草稿时展开（布局见 `shell.css` 与 `composer.css` 的 `.app.panel-max`）。
 *
 * 面板收起时一并复位：放大只在本次展开期间有效，不复位时下次展开直接进入放大态。
 * 因此该标志没有独立的关闭路径，只随面板变化。
 */
export const [panelMaximized, setPanelMaximized] = sessionSignal('qywork.panel.max', false)
export function togglePanelMax(): void {
  setPanelMaximized((v) => !v)
}

/**
 * 上一次显示的页。
 *
 * 顶栏只有一个按钮负责展开与收起，展开时应回到用户上次所在的页，而不是
 * 一律回到文件页：否则在变更视图中误触收起后，再展开需要重新选择页签。
 */
const [lastPage, setLastPage] = sessionSignal<PanelPage>('qywork.panel.last', 'files')

/**
 * 判断该页在当前工作区是否仍存在。记录的页随时可能失效：已被关闭，
 * 或属于另一个工作区（`lastPage` 只有一份，跨工作区共用）。
 * 不做此判断时，展开后显示一块无法关闭的空白。
 */
function pageAlive(page: PanelPage): boolean {
  return typeof page === 'string' || panelTabs().some((t) => t.id === page.tab)
}

/**
 * 收起面板。这是唯一的收起入口：顶栏开关与面板标题栏的 × 都经由此函数。
 *
 * 不要为 × 单独实现收起：单独实现只执行 `setSidePanel(null)`，既不记录上次显示的页，
 * 也不复位放大态，同一动作形成两套实现，差异会持续扩大。
 */
export function closePanel(): void {
  const page = sidePanel()
  if (page) setLastPage(page)
  setSidePanel(null)
  setPanelMaximized(false)
}

export function togglePanel(): void {
  if (sidePanel()) {
    closePanel()
    return
  }
  const page = lastPage()
  setSidePanel(pageAlive(page) ? page : 'files')
}
export function openPanel(view: PanelView): void {
  setLastPage(view)
  setSidePanel(view)
}

/**
 * 左栏收起。
 *
 * 只适用于宽屏。窄屏的左栏是浮动抽屉（见 utility.css 的断点），
 * 收起即关闭抽屉，已由 `drawer` 机制处理；两套机制在同一屏幕宽度下并存会形成
 * 第二本账，因此收起的样式整体限定在 `min-width: 821px` 内。
 *
 * 收起后重新展开的入口在顶栏：左栏已隐藏，开关不能只放在左栏上。
 */
export const [sidebarCollapsed, setSidebarCollapsed] = sessionSignal(
  'qywork.sidebar.collapsed',
  false,
)
export function toggleSidebar(): void {
  setSidebarCollapsed((v) => !v)
}

/**
 * 设置弹窗当前显示的类目。`null` 表示设置未打开。
 *
 * 使用一个弹窗，不要拆成多个平行浮层：平行浮层各有一套开关，「设置与配对同时打开」
 * 在类型上合法。类目导航避免了这一点：一个弹窗，左栏列出类目，全部类目共用同一个状态。
 *
 * 不要做成整页（左栏换成类目导航、主区换成设置内容）：一次简单修改需要切换整个界面，
 * 顶栏的会话导出与面板开关需要随之隐藏，返回时还需点击「返回」。
 * 类目导航可以放入弹窗，不需要整页。
 *
 * 分隔线上下是两类页。分隔线以上说明 agent 的组成与用量：`modules` 是说明页，
 * `usage` 是账本，二者只读、不可配置；分隔线以下每一项都是一个模块的设置页，有实际表单。
 * 没有可配置项的模块不设独立页：在 `modules` 中列出即可，单独的空页属于空壳。
 */
export type SettingsPage =
  | 'general'
  | 'models'
  | 'usage'
  | 'modules'
  | 'access'
  | 'memory'
  | 'skills'
  | 'team'
  | 'mcp'
  | 'plugins'
  | 'schedules'
export const [settingsPage, setSettingsPage] = sessionSignal<SettingsPage | null>(
  'qywork.settings.page',
  null,
)

/** 打开设置。不带参数时打开「通用」：它是唯一不需要前置知识的类目。 */
export function openSettings(page: SettingsPage = 'general'): void {
  setSettingsPage(page)
}
export function closeSettings(): void {
  setSettingsPage(null)
}

/** 账号弹窗是否打开。与设置弹窗相同，经 `sessionSignal` 记录，整页刷新后恢复。 */
export const [accountOpen, setAccountOpen] = sessionSignal<boolean>('qywork.account.open', false)

/**
 * 面板中当前打开的文件（工作区相对路径）。`null` 表示只显示文件树。
 *
 * 内容与树在同一面板中并排：树在左、内容在右（`FileBrowser`）。会话正文
 * 不让出位置：查看文件与查看对话位于两个区域，不应互相替换。
 *
 * 这是「打开了哪个文件」的唯一权威。不要在面板中另存一份，两份必然不一致。
 * 高亮由 `FileBrowser` 中的 `selected` 决定。打开文件时同步选择，
 * 随后点击目录可以改变选中行，不能用预览路径覆盖目录选择。
 */
export const [openFile, setOpenFile] = sessionSignal<string | null>('qywork.file.open', null)

/**
 * 本端右侧面板当前显示的工作区文件：画布页、文件预览页，或文件页中打开的文件。面板收起或显示其他页时为 undefined。
 * 显示时上报给电脑（`panel-share.ts` 的 `watchViewing`），发送消息时由服务端附上，模型据此理解「这个画布」「这个文件」。
 */
export function viewingFile(): string | undefined {
  const page = sidePanel()
  if (page === null) return undefined
  if (typeof page === 'object') {
    const tab = panelTabs().find((t) => t.id === page.tab)
    return tab && (tab.kind === 'canvas' || tab.kind === 'file') ? tab.path : undefined
  }
  return page === 'files' ? (openFile() ?? undefined) : undefined
}

/**
 * 当前项目。
 *
 * 会话、文件树、git、扩展清单都按它获取；`client.api` 也按它为每个 REST 请求
 * 拼接 `?ws=`。它是前端「当前项目」的唯一权威：服务端没有对应的可变状态，
 * 只有 `workspaces` 表与每个请求自带的参数。
 *
 * 刷新后按记录恢复，首个请求即带上该项目的 `ws=`：不带时服务端返回最近打开的项目，
 * 其他客户端在此期间打开过另一个项目时，刷新会切换到那个项目。
 */
export interface WorkspaceInfo {
  id: string
  root: string
  name: string
}
export const [workspace, setWorkspace] = sessionSignal<WorkspaceInfo | null>(
  'qywork.workspace',
  null,
)

/**
 * 将工作区相对路径转换为本机绝对路径。
 *
 * 分隔符与项目根一致：根使用反斜杠时拼接反斜杠，使用斜杠时拼接斜杠。后端统一返回 posix
 * 风格的相对路径（`server/files.ts` 的 `toPosix`），直接拼接得到的混合写法
 * （`C:\ws/src/a.ts`）复制到其他程序中无法使用。
 *
 * 统一在此定义：文件视图的标题栏与右键菜单的「复制路径」必须生成相同的字符串，
 * 分别实现必然产生差异。
 */
/**
 * 投递给输入框的一条初始指令。
 *
 * 只使用一次，不是第二份正文。`Composer` 读取后写入自身的 `text`、聚焦，随即将此信号
 * 清空。正文的唯一权威始终是 `Composer` 内部的 `text`：不要把此信号当作
 * 输入框的当前内容读取，它绝大多数时候为 `null`。
 *
 * 用途：设置页中的「新增」按钮。新建记忆、技能或定时任务时，面板中的几个字段
 * 无法填写完整（技能需要正文与触发条件，插件需要代码），因此将初始指令交给模型处理。
 */
export const [composerSeed, setComposerSeed] = createSignal<string | null>(null)

/** 窄屏：右侧面板覆盖全屏、侧栏改为抽屉。断点与样式表的 `max-width: 820px` 相同。 */
export function narrowScreen(): boolean {
  return globalThis.matchMedia?.('(max-width: 820px)').matches === true
}

/** 关闭设置，将一条初始指令送入输入框。设置弹窗遮挡输入框，不关闭则无法看到。 */
export function askInChat(prompt: string): void {
  closeSettings()
  setComposerSeed(prompt)
}
export function absPath(rel: string): string {
  const root = workspace()?.root ?? ''
  if (!root) return rel
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}

/*
 * 模块初始化时与外壳核对一次终端会话。
 *
 * 放在模块顶层，而不是某个组件的 `onMount` 中：页签镜像随本模块建立，
 * 核对与其放在同一处，不引入执行先后顺序的问题。
 *
 * 仅桌面端有 PTY；调用失败时忽略，其结果仅是本次未能恢复页签。
 */
if (isDesktopShell()) {
  void tauriInvoke<TerminalSession[]>('terminal_list')
    .then(restoreTerminalTabs)
    .catch(() => {})
}

const FOLLOWUP_KEY = 'qywork.followUpMode'

/**
 * 会话运行期间发送消息的默认方式。
 *
 * `queue` 表示等当前一轮执行完毕后作为下一轮发起；`steer` 表示注入当前一轮，
 * 模型在下一次请求中即可看到。界面上对应「加入队列」与「调整方向」。
 *
 * 真源在客户端，服务端既不存储也不读取。它属于输入习惯，与主题、面板宽度同层；
 * 服务端另存一份会形成第二本账，且可能与用户当前的按键不一致：意图随每条
 * `message.send` 的 `steer` 字段显式携带。
 *
 * 按设备保存：手机上没有 `Ctrl+Enter`，两端的习惯无需一致。
 */
export type FollowUpMode = 'queue' | 'steer'

function readFollowUpMode(): FollowUpMode {
  try {
    return localStorage.getItem(FOLLOWUP_KEY) === 'steer' ? 'steer' : 'queue'
  } catch {
    // 隐私模式下 localStorage 会直接抛出异常。无法保存默认方式时不应导致应用无法启动。
    return 'queue'
  }
}

export const [followUpMode, setFollowUpModeSignal] = createSignal<FollowUpMode>(readFollowUpMode())

/** 修改默认方式的唯一入口，同步落盘。 */
export function setFollowUpMode(next: FollowUpMode): void {
  if (next === followUpMode()) return
  setFollowUpModeSignal(next)
  try {
    localStorage.setItem(FOLLOWUP_KEY, next)
  } catch {
    // 同上：本次选择已生效，保存失败只影响下次启动。
  }
}

/**
 * 会话流中折叠条目的展开状态，按条目 key 记录。展开状态的权威在此，不在 `<details>` 节点上：
 * 节点的生命周期由渲染投影决定，组卡增加成员或单条工具并入组卡时节点会重建，
 * 记录在节点上的展开状态随之丢失。只有用户切换展开状态时才写入；未记录的条目视为折叠。
 */
const FOLDS_KEY = 'qywork.folds'
const [folds, setFolds] = createStore<Record<string, boolean>>(
  readSession<Record<string, boolean>>(FOLDS_KEY) ?? {},
)

export function foldOpen(key: string): boolean {
  return folds[key] ?? false
}

export function setFoldOpen(key: string, open: boolean): void {
  setFolds(key, open)
  writeSession(FOLDS_KEY, unwrap(folds))
}

/** 仅在该条目尚无记录时写入：用于为新建的组卡设置初始展开状态，此后由用户决定。 */
export function seedFoldOpen(key: string, open: boolean): void {
  if (folds[key] !== undefined) return
  setFolds(key, open)
  writeSession(FOLDS_KEY, unwrap(folds))
}
