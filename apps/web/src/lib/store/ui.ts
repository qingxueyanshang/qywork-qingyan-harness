/**
 * 纯界面状态：右侧面板、几个浮层，以及当前工作区。
 *
 * 这些和服务端无关，也不进 `state` ——它们的生命周期是「这一次打开」，
 * 混进业务 store 只会让每次事件推送都要绕过大量与服务端无关的字段。
 */

import { createEffect, createSignal, onCleanup } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { TerminalSession } from '../terminal.ts'
import { isDesktopShell, tauriInvoke } from './shell.ts'

/**
 * 右侧面板**固定的那几页**。关不掉，永远在页签条最前面。
 *
 * **这里的每个值都必须在 `SidePanel` 的 `<Switch>` 里有对应的 `Match`**，
 * 否则设成它的结果是面板展开、内容空白。
 *
 * 打开的文件**不是这里的一个值**：它长在文件那一页里（`openFile` + `FileView`），
 * 和文件树并排。
 *
 * 终端不在这里：它是可多开、可关掉的一页，见 `PanelTabKind`。
 */
export type PanelView = 'todos' | 'files' | 'changes' | 'runs'

/**
 * 可多开的那几种页。
 *
 * `terminal` 只有桌面端有（PTY 是本机进程和一对系统句柄）。`browser` 是 Windows
 * 桌面外壳里的内置浏览器，一页就是一个原生子 WebView，页签 id 由宿主给；
 * `preview` 是别的端上的 HTTP 网页预览，一页就是一个 iframe，地址由用户给。
 * **两者不是同一件事的两档**：一个能被 AI 操作、有登录状态，另一个只能看。
 * **这一层不判端**：判在入口那边（`SidePanel` 的看板），这里只管开了哪几页。
 *
 * `conversation` 与 `cli` 都没有看板入口：只能从图卡上点开（看哪一条由那张卡说了算），
 * 所以也没有序号，标题就是那个节点的名字。两者分开是因为背后的来源不同：
 * 一个是子会话（有正文、有工具卡），一个是本机另一个进程写出来的一段流。
 */
export type PanelTabKind = 'terminal' | 'browser' | 'preview' | 'conversation' | 'cli'

export interface PanelTab {
  id: string
  kind: PanelTabKind
  /**
   * 页签上的字。**建出来就不再改。**
   *
   * 不要改成「跟着内容走」（终端里的当前命令、浏览器页的站点名）：标题一变页签就变宽，
   * 用户正瞄着的那颗 × 会跑到别的地方去。
   */
  title: string
  /**
   * 网页预览页现在指着的地址。**这一页的地址只有这一份**：收起面板会把 `PreviewPanel`
   * 卸载，地址记在组件里的话再展开就是一个空地址栏。其余几种页没有这个字段。
   *
   * 只记地址，不保页面状态：iframe 从 DOM 上摘下来再插回去就是重新加载，
   * 这是浏览器的行为，前端这一侧没有第二条路。
   *
   * **内置浏览器页没有这个字段**：那一页的地址在原生宿主手里，前端只投影。
   */
  url?: string
  /**
   * 创建序号，页签条按它排。
   *
   * 外壳给的页（终端、内置浏览器）用外壳进程那个计数器的值：两份清单各自异步回来，
   * 按到达顺序追加会让整页刷新后的页签顺序与创建顺序不同，而 `terminal-N` 与 `bt_N`
   * 是两个互不相关的计数，跨类型比不了。纯前端的页用 `nextLocalSeq`。
   */
  createdSeq: number
}

/**
 * 面板现在翻开的是哪一页。`null` = 收起。
 *
 * 固定视图用它自己的名字，可多开的页用 `{ tab: id }`——**一个信号，不是「固定视图」
 * 加「当前页签」两个**：两个信号的时候「翻开文件页」和「翻开终端页」在类型上可以
 * 同时成立，谁盖过谁只能靠每个调用点自觉，那就是第二本账。
 */
export type PanelPage = PanelView | { tab: string }

/**
 * 一个工作区的面板：开着哪几页，翻开的是哪一页。
 *
 * 两样合在一个条目里，不是两张按工作区的表：翻开的那一页通常就是这份 `tabs` 里的一条，
 * 分开存的时候「页签换成了 B 的、当前页还是 A 的那一条」在类型上完全合法。
 */
interface WorkspacePanel {
  tabs: readonly PanelTab[]
  page: PanelPage | null
}

const EMPTY_PANEL: WorkspacePanel = { tabs: [], page: null }

/**
 * 面板状态按工作区分账。切工作区不收任何资源，只是换一个键去读。
 *
 * **键只能是 `WorkspaceInfo.id`。** 没有活动工作区时一律不建条目：空字符串键的条目
 * 切进任何工作区都读不到，里面登记的 PTY 与原生页从此没有界面碰得到。
 */
const [panels, setPanels] = createSignal<Readonly<Record<string, WorkspacePanel>>>({})

function panelOf(wsId: string | undefined): WorkspacePanel {
  return (wsId ? panels()[wsId] : undefined) ?? EMPTY_PANEL
}

/**
 * 按**显式**工作区改一条条目。
 *
 * 宿主投影与异步回包必须拿资源自带的工作区调它，不要在 await 之后读当前工作区：
 * 请求期间用户可能已经切走，回包时的当前工作区可能是 B，写过去就是把 A 的页记进 B 的条目。
 */
function updatePanel(wsId: string, next: (cur: WorkspacePanel) => WorkspacePanel): void {
  setPanels((all) => ({ ...all, [wsId]: next(all[wsId] ?? EMPTY_PANEL) }))
}

/** 当前工作区开着哪几页可多开的页。顺序即页签条上的顺序。 */
export function panelTabs(): readonly PanelTab[] {
  return panelOf(workspace()?.id).tabs
}

/** 当前工作区的面板翻开在哪一页。`null` = 收起；没有活动工作区时也是 `null`。 */
export function sidePanel(): PanelPage | null {
  return panelOf(workspace()?.id).page
}

/** 翻到某一页。没有活动工作区时不写——那一页没有归属得上的条目。 */
export function setSidePanel(page: PanelPage | null): void {
  const wsId = workspace()?.id
  if (!wsId) return
  updatePanel(wsId, (cur) => ({ ...cur, page }))
}

/**
 * 按**显式**工作区翻到某一页。
 *
 * 异步回包用它，不要用 `setSidePanel`：那个读的是回包时的当前工作区，
 * 而请求期间用户可能已经切走。
 */
export function showPanelTab(wsId: string, id: string): void {
  updatePanel(wsId, (cur) => ({ ...cur, page: { tab: id } }))
}

/** 当前翻开的那一页的 id；停在固定视图上时是 `null`。派生量，不是第二份状态。 */
export function activePanelTab(): string | null {
  const page = sidePanel()
  return page !== null && typeof page === 'object' ? page.tab : null
}

/** 从一条条目里取出它翻开的那一页的 id。给不便读当前工作区的投影入口用。 */
function activeTabOf(panel: WorkspacePanel): string | null {
  const page = panel.page
  return page !== null && typeof page === 'object' ? page.tab : null
}

/**
 * 关掉一页时要收的本机资源：终端的 PTY 与 xterm 实例、浏览器页记着的地址。
 *
 * **为什么不放在组件的 `onCleanup` 里**：收起面板会把整块面板卸载，而那时终端必须
 * 保持存活——用户收起去看会话，切回来命令还得在跑、滚动历史还得在。所以「组件卸载」和
 * 「这一页被关掉」是两件不同的事，只有后者该收资源，而后者唯一的入口在这里。
 *
 * 关页入口清单——浏览器页：用户点页签 ×、AI 的 `browser_tabs(action=close)`、
 * 删除所属会话、应用退出、宿主建页中途失败时回收未登记的视图；终端：用户点页签 ×、
 * 应用退出、「重开」按钮替换旧 PTY、子进程自行退出。切换与移除工作区、归档会话、
 * 停止、一轮结束、宿主重连都不关页。
 */
const tabDisposers = new Map<string, () => void>()

/** 登记「这一页被关掉时收什么」。同一个 id 重复登记以最后一次为准。 */
export function holdPanelTab(id: string, dispose: () => void): void {
  tabDisposers.set(id, dispose)
}

function disposeTab(id: string): void {
  const dispose = tabDisposers.get(id)
  tabDisposers.delete(id)
  dispose?.()
}

/**
 * 每种页各自的序号。**只增不减**：关掉「终端 1」之后剩下那页仍然叫「终端 2」，
 * 不在用户眼皮底下改名。
 */
const TAB_LABEL = { terminal: '终端', preview: '网页预览' } as const
type NumberedKind = keyof typeof TAB_LABEL
const tabSeq: Record<NumberedKind, number> = { terminal: 0, preview: 0 }

/**
 * 纯前端那几种页（网页预览、子会话、外部 CLI）的创建序号。
 *
 * **跟着见过的外壳序号抬。** 不抬的话，先开三页网页预览再开一页内置浏览器时，
 * 那一页的外壳序号比它们都小，会被插到中间去，而新开的页该落在页签条末尾。
 * 这几种页刷新后不存在，所以序号不必与外壳对得上，只要大小关系成立。
 */
let localSeq = 0

function nextLocalSeq(): number {
  localSeq += 1
  return localSeq
}

/** 记下一个外壳序号，抬高本地计数的起点。 */
function noteHostSeq(seq: number): void {
  if (seq > localSeq) localSeq = seq
}

/** 按创建序号把几页插进清单：序号相同的排在已有那一页后面。 */
function insertBySeq(tabs: readonly PanelTab[], added: readonly PanelTab[]): PanelTab[] {
  const list = [...tabs]
  for (const tab of added) {
    const at = list.findIndex((t) => t.createdSeq > tab.createdSeq)
    list.splice(at < 0 ? list.length : at, 0, tab)
  }
  return list
}

/**
 * 新开一页并翻到它。`url` 只有网页预览页用得上：新开出来就指着它。
 *
 * 没有活动工作区时不开：这一页背后是 PTY 或 iframe，开出来就没有条目装得下它。
 * 序号也不在那时消耗掉。
 */
export function openPanelTab(kind: NumberedKind, url?: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  tabSeq[kind] += 1
  const n = tabSeq[kind]
  const id = `${kind}-${n}`
  const tab: PanelTab = { id, kind, title: `${TAB_LABEL[kind]} ${n}`, createdSeq: nextLocalSeq() }
  // `exactOptionalPropertyTypes` 开着：没有地址时这个键必须不存在，不能写 undefined。
  if (url) tab.url = url
  updatePanel(wsId, (cur) => ({ tabs: [...cur.tabs, tab], page: { tab: id } }))
}

/**
 * 在网页预览页里打开一个地址。
 *
 * **已经有一页指着这个地址就翻回去**，不并排开出第二页——两页看同一个地址，
 * 内容逐字相同（同 `openConversationTab`）。
 */
export function openPreviewTab(url: string): void {
  const open = panelTabs().find((t) => t.kind === 'preview' && t.url === url)
  if (open) {
    setSidePanel({ tab: open.id })
    return
  }
  openPanelTab('preview', url)
}

/** 某一页现在指着的地址。没有地址（或不是网页预览页）时是空串。 */
export function panelTabUrl(id: string): string {
  return panelTabs().find((t) => t.id === id)?.url ?? ''
}

/** 网页预览页跳到另一个地址。 */
export function setPanelTabUrl(id: string, url: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  updatePanel(wsId, (cur) => ({
    ...cur,
    tabs: cur.tabs.map((t) => (t.id === id ? { ...t, url } : t)),
  }))
}

/**
 * 按宿主的存活页对齐内置浏览器的页签。**只投影**：这里加出来或去掉的页签
 * 不反过来决定宿主开着哪几页，页签 id 就是宿主给的 tabId。
 *
 * 少了它，整页刷新之后页签是空的而原生页还在——那几页只能等应用退出时被收掉
 * （同 `restoreTerminalTabs`）。
 *
 * **每页按它自带的工作区落账，不读当前工作区**：这一次调用可能发生在模块建立时
 * （那时还没有活动工作区），清单里也可能有后台工作区的页。对齐范围是
 * 「已有条目里有浏览器页的工作区」并上「本次清单里的工作区」——某工作区最后一页
 * 关掉后它不出现在清单里，旧页签与失效的当前页仍要在这一轮清掉。
 *
 * 宿主那边已经没了的页**不走 `tabDisposers`**：它是「关掉这一页」的收尾，
 * 而这一页已经被关掉了，再走一次就是对着一个不存在的 tabId 再关一次。
 */
export function syncBrowserTabs(
  tabs: readonly { id: string; title: string; workspaceId: string; createdSeq: number }[],
): void {
  const groups = new Map<string, HostTab[]>()
  for (const [wsId, panel] of Object.entries(panels())) {
    if (panel.tabs.some((t) => t.kind === 'browser')) groups.set(wsId, [])
  }
  for (const t of tabs) {
    noteHostSeq(t.createdSeq)
    const list = groups.get(t.workspaceId) ?? []
    list.push({ id: t.id, title: t.title, createdSeq: t.createdSeq })
    groups.set(t.workspaceId, list)
  }
  for (const [wsId, list] of groups) alignBrowserTabs(wsId, list)
}

interface HostTab {
  id: string
  title: string
  createdSeq: number
}

/**
 * 把一个工作区的浏览器页签对齐到给定清单。**只按传进来的工作区寻址**，不读当前工作区。
 * 页签名跟着清单里的 `title` 走：它是网页标题的投影，页面跳转后会变。
 *
 * 新页按 `createdSeq` 插入而不是追加到末尾：这份清单与终端那份各自异步回来，
 * 追加的话整页刷新后的页签顺序取决于谁先回来。
 */
function alignBrowserTabs(wsId: string, tabs: readonly HostTab[]): void {
  const cur = panelOf(wsId)
  const wanted = new Set(tabs.map((t) => t.id))
  const known = new Set(cur.tabs.map((t) => t.id))
  const gone = cur.tabs.filter((t) => t.kind === 'browser' && !wanted.has(t.id))
  const added = tabs
    .filter((t) => !known.has(t.id))
    .map(
      (t): PanelTab => ({
        id: t.id,
        kind: 'browser',
        title: t.title,
        createdSeq: t.createdSeq,
      }),
    )
  const titles = new Map(tabs.map((t) => [t.id, t.title]))
  const retitled = cur.tabs.some((t) => t.kind === 'browser' && titles.get(t.id) !== t.title)
  if (!gone.length && !added.length && !retitled) return
  const orphaned = gone.find((t) => t.id === activeTabOf(cur))
  for (const t of gone) tabDisposers.delete(t.id)
  const list = insertBySeq(
    cur.tabs
      .filter((t) => !gone.includes(t))
      .map((t) => (t.kind === 'browser' ? { ...t, title: titles.get(t.id) ?? t.title } : t)),
    added,
  )
  if (!orphaned) {
    updatePanel(wsId, (c) => ({ ...c, tabs: list }))
    return
  }
  const i = cur.tabs.indexOf(orphaned)
  const next = cur.tabs[i + 1] ?? cur.tabs[i - 1]
  const page: PanelPage = next && !gone.includes(next) ? { tab: next.id } : 'files'
  updatePanel(wsId, () => ({ tabs: list, page }))
}

/**
 * 打开某条子会话那一页。
 *
 * **页 id 就是会话 id**：同一条子会话再点一次是翻回去，不是并排开出第二页
 * ——两页看同一条已经跑完的会话，内容逐字相同。
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

/** 从页 id 反取会话 id。`openConversationTab` 是唯一的生产者。 */
export function tabConversationId(tabId: string): string {
  return tabId.slice('conversation-'.length)
}

/**
 * 打开某个外部 CLI 节点那一页：看它此刻在写什么。
 *
 * 页 id 是「哪张卡 + 哪个节点」，与那个节点的输出缓冲同一个键——同一个节点再点一次
 * 是翻回去，不是并排开出第二页。
 */
export function openCliTab(stepId: string, nodeId: string, title: string): void {
  const wsId = workspace()?.id
  if (!wsId) return
  const id = `cli-${stepId}-${nodeId}`
  // 标题单独给，不拿 `nodeId` 顶：派一件那张卡的节点 id 是个内部常量，
  // 直接送上去页签就叫那个常量。
  updatePanel(wsId, (cur) => ({
    tabs: cur.tabs.some((t) => t.id === id)
      ? cur.tabs
      : [...cur.tabs, { id, kind: 'cli', title, createdSeq: nextLocalSeq() }],
    page: { tab: id },
  }))
}

/** 从页 id 反取「哪张卡 + 哪个节点」。`openCliTab` 是唯一的生产者。 */
export function tabCliNode(tabId: string): { stepId: string; nodeId: string } {
  const rest = tabId.slice('cli-'.length)
  // step id 里没有 `-`（`st_` 加一串 base36），所以第一个 `-` 就是分界。
  const cut = rest.indexOf('-')
  return { stepId: rest.slice(0, cut), nodeId: rest.slice(cut + 1) }
}

/**
 * 把外壳那边仍存活的终端会话补回页签。
 *
 * `panelTabs` 是 Rust 那张会话表的镜像，而整页重载会把镜像清空——开发期改一个
 * `store/` 或 `packages/` 下的文件，vite 走的就是整页刷新。清空之后 shell 还在跑，
 * 却没有任何界面碰得到它：页签不是走 `closePanelTab` 没的，`tabDisposers` 一次都
 * 没被调用，那条会话只能等应用退出时被 `shutdown` 收掉。所以镜像建立时要跟权威
 * 对一次账，不能只靠 `openPanelTab` 往上加。
 *
 * **只补不删。** 认不出的 id 一律不动：浏览器页在外壳那边本来就没有对应物。
 *
 * **每条按它自己报的工作区补，不看当前工作区**：这一次调用发生在模块建立时，
 * 那时通常还没有活动工作区，按当前工作区写就是把全部 PTY 丢掉。
 * 序号取整份清单的最大值，包括别的工作区那几条——`terminal-N` 是 Rust 那张表的键，
 * 全进程唯一，按当前工作区算会让下一次新开撞上一个已经存在的 id。
 *
 * 补回来的页按 `createdSeq` 插入而不是追加到末尾：这份清单与浏览器那份各自异步回来，
 * 追加的话整页刷新后的页签顺序取决于谁先回来。
 */
export function restoreTerminalTabs(sessions: readonly TerminalSession[]): void {
  const found = new Map<string, PanelTab[]>()
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
  for (const [wsId, list] of found) {
    updatePanel(wsId, (cur) => ({ ...cur, tabs: insertBySeq(cur.tabs, list) }))
  }
}

/**
 * 关掉一页。**这是收资源的唯一入口**（见 `tabDisposers`）。
 *
 * 关掉的正是当前那一页时，落到右边那页，没有就落到左边那页，一页都不剩就回文件视图
 * ——**不连带把面板收起来**：用户点的是这一页的 ×，不是面板的 ×。
 */
export function closePanelTab(id: string): void {
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
 * 此刻盖着多少个浮层（设置、确认框、新建项目）。
 *
 * **原生子视图按它让位。** 内置浏览器那一页是窗口的子 HWND，画在所有 DOM 之上，
 * 浮层的 `z-index` 对它无效；不让位的话浮层被网页盖在下面。
 * 浮层自己占一格而不是由这里嗅探 DOM：嗅探要挑一个 class 当判据，
 * 而那个 class 改名不会有任何报错。
 */
const [overlays, setOverlays] = createSignal(0)

export function overlayOpen(): boolean {
  return overlays() > 0
}

/**
 * 浮层出现时占一格，收起或组件卸载时还回去。必须在组件作用域里调。
 *
 * 收 `open` 而不是只看挂载：确认框那一类组件一直挂着，只有内容按 `open` 显示。
 */
export function holdOverlay(open: () => boolean): void {
  createEffect(() => {
    if (!open()) return
    setOverlays((n) => n + 1)
    onCleanup(() => setOverlays((n) => Math.max(0, n - 1)))
  })
}

/**
 * 面板最窄：树 + 一列内容还看得见的最窄。
 *
 * **这里只有下限，没有上限。** 上限是布局的事，由 `.app.with-panel` 的
 * `minmax(var(--chat-min), 1fr)` 说了算——网格知道窗口现在多宽、左栏收没收起，
 * 这里不知道。在这儿再算一遍就是同一件事的第二本账，而那本账只在拖动那一刻对：
 * 大屏上拖出来的宽度换到小窗口就成了一个撑破布局的定长。
 */
export const PANEL_MIN = 337
const PANEL_KEY = 'qywork.panelWidth'
const PANEL_DEFAULT = 380

/** 负数和 0 不只是难看：`minmax(0, -50px)` 会让整条 `grid-template-columns` 失效，
 *  网格退回隐式的 auto 列，那正是要防的失效形状。 */
function clampPanelWidth(px: number): number {
  return Math.max(PANEL_MIN, Math.round(px))
}

function readPanelWidth(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_KEY))
    return clampPanelWidth(Number.isFinite(v) && v > 0 ? v : PANEL_DEFAULT)
  } catch {
    // 隐私模式下 localStorage 直接抛。记不住宽度不该让应用起不来。
    return PANEL_DEFAULT
  }
}

/**
 * 右侧面板**要多宽**（像素）。由用户拖左边沿改，记在 localStorage 里。
 *
 * 真源是这个信号，不是 `tokens.css` 的 `--panel-w`：那条只是首次启动的默认值。
 * `App.tsx` 把它写成 `.app` 上的行内 `--panel-w`，因此网格那一列跟着变，
 * 布局规则一行不用改。
 *
 * **它是「要多宽」，不是「实际多宽」**：窗口放不下时网格只给到上限，这个数照旧
 * 是用户拖出来的那个。窗口再变宽就还它——反过来（拖窄窗口时把它改小）等于
 * 拿一次临时的窗口尺寸抹掉用户的设置。
 *
 * 面板里是「内容 + 树」两块并排，所以宽度必须可拖：不给拖的话内容那半永远只剩
 * 一百多像素。
 */
export const [panelWidth, setPanelWidthSignal] = createSignal(readPanelWidth())

/**
 * 改宽度的**唯一入口**：拖动和方向键都走它。夹住下限，并同步落盘。
 *
 * 值没变就直接返回：拖到头了还在拉，每一帧都会调到这里，
 * 不拦的话就是每秒几十次无意义的 localStorage 写入。
 */
export function resizePanel(px: number): void {
  const next = clampPanelWidth(px)
  if (next === panelWidth()) return
  setPanelWidthSignal(next)
  try {
    localStorage.setItem(PANEL_KEY, String(next))
  } catch {
    // 同上：这一次的拖动已经生效了，存不下只影响下次启动。
  }
}

/**
 * 面板放大：会话正文让位，面板独占内容区；输入框默认收成底部触发条，悬浮、
 * 聚焦或带草稿时再展开（布局见 `shell.css` 与 `composer.css` 的 `.app.panel-max`）。
 *
 * 面板收起时一并复位——不复位的话下次展开直接落进放大态，而用户上次关掉它
 * 可能正是因为不想要放大。所以这个标志没有独立的「关」路径，只跟着面板走。
 */
export const [panelMaximized, setPanelMaximized] = createSignal(false)
export function togglePanelMax(): void {
  setPanelMaximized((v) => !v)
}

/**
 * 上一次翻开的那一页。
 *
 * 顶栏只有一个按钮负责「展开 / 收起」，展开时要回到用户上次待的地方而不是
 * 一律跳回文件——否则在变更视图里手滑收起，再展开就得重新点一次 tab。
 */
const [lastPage, setLastPage] = createSignal<PanelPage>('files')

/**
 * 这一页在当前工作区还在不在。**记着的那一页随时可能落空**：它被关掉了，
 * 或者它属于另一个工作区（`lastPage` 只有一份，跨工作区共用）
 * ——不判一下的话展开出来是一块谁也点不掉的空白。
 */
function pageAlive(page: PanelPage): boolean {
  return typeof page === 'string' || panelTabs().some((t) => t.id === page.tab)
}

/**
 * 收起面板。**唯一的收起入口**——顶栏那个开关和面板头上的 × 都走这里。
 *
 * 两处各写各的时候，× 只做了 `setSidePanel(null)`：它既不记「上次看的是哪一页」，
 * 将来也不会复位放大态。同一个动作两本账，差异只会越拉越大。
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
 * **只对宽屏成立。** 窄屏的左栏本来就是浮动抽屉（见 utility.css 的断点），
 * 那里「收起」等于关抽屉，已经有 `drawer` 那套在管；两套机制在同一屏并存
 * 就是第二本账，所以收起的样式整体锁在 `min-width: 821px` 里。
 *
 * 收起后重新展开的入口在顶栏——左栏自己都不在了，开关不能只长在它身上。
 */
export const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)
export function toggleSidebar(): void {
  setSidebarCollapsed((v) => !v)
}

/**
 * 设置弹窗当前看的类目。`null` = 没在看设置。
 *
 * **为什么是一个弹窗，不是十个平行浮层。** 最早那版是六个平行浮层（定时、记忆、插件、团队、手机、设
 * 置），每个自己一套开关——「设置和配对同时开着」在类型上完全合法。类目导航就是解药：一个弹窗，
 * 左边一栏列类目，全部类目共用同一个状态。
 *
 * **不要做成整页**（左栏换类目导航、主区换设置内容）：那会把「改一格就走」变成
 * 一次场景切换——顶栏的会话导出和面板开关得跟着藏，回来还要点一次「返回」。
 * 类目导航塞得进弹窗，整页那一层没有存在的理由。
 *
 * **横线上下是两类页。** 横线上面是「这个 agent 是什么、花了多少」，其中 `modules` 是说明书——只
 * 读，不配置，`usage` 是账本——只读，不配置；横线下面每一项都是一个模块的操作台，有真实的表单。
 * **没有可配项的模块不给独立页**，它在 `modules` 里有条目就够了，开一个空页就是空壳。
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
export const [settingsPage, setSettingsPage] = createSignal<SettingsPage | null>(null)

/** 打开设置。不带参数回到「通用」——它是唯一不需要前置知识的类目。 */
export function openSettings(page: SettingsPage = 'general'): void {
  setSettingsPage(page)
}
export function closeSettings(): void {
  setSettingsPage(null)
}

/**
 * 面板里正在看哪个文件（工作区相对路径）。`null` = 只有树。
 *
 * **内容和树在同一块面板里并排**：树在右、内容在左（`FileBrowser`）。会话正文
 * 不让位——看文件和看对话是两块地方的事，不该互相顶掉。
 *
 * 这是「开着哪个文件」的唯一权威。别在面板里再存一份，两份必然对不上。
 * 注意它**不负责高亮哪一行**：那是 `FileBrowser` 里的 `selected`
 * （最后点过的那一行），两者混用过一次，症状是点文件夹不亮。
 */
export const [openFile, setOpenFile] = createSignal<string | null>(null)

/**
 * 打开一个文件。**必须走这里**：它同时保证面板是开着的、且停在文件那一页。
 *
 * 直接设 `openFile` 的话，从别的地方触发时
 * 面板可能收着或停在「变更」页，用户点一下什么都看不到。
 * 放大态**不动**：那个模式下面板占满内容区，正好是看文件最舒服的形状。
 */
export function openFileInPanel(path: string): void {
  setOpenFile(path)
  openPanel('files')
}

/**
 * **当前项目**。
 *
 * 会话、文件树、git、扩展清单全部按它取；`client.api` 也按它给每条 REST
 * 拼 `?ws=`。它是前端这一侧「当前在看哪个项目」的唯一权威——服务端那边没有
 * 对应的可变状态，只有 `workspaces` 表和每条请求自带的参数。
 */
export interface WorkspaceInfo {
  id: string
  root: string
  name: string
}
export const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null)

/**
 * 工作区相对路径 → **本机绝对路径**。
 *
 * 分隔符跟着项目根走：根用反斜杠就拼反斜杠，用斜杠就拼斜杠。后端一律回 posix
 * 风格的相对路径（`server/files.ts` 的 `toPosix`），直接拼出来的混合写法
 * （`C:\ws/src/a.ts`）复制到别处用不了。
 *
 * 一处定义：文件视图的标题栏和右键菜单的「复制路径」必须拼出同一个字符串，
 * 各写一遍必然分叉。
 */
/**
 * 投递给输入框的一条起手指令。
 *
 * **一次性，不是第二份正文。** `Composer` 读到就写进自己的 `text`、聚焦、随即把这里
 * 清空。正文的唯一权威始终是 `Composer` 内部那个 `text`——不要拿这个信号当
 * 「输入框现在是什么」来读，它绝大多数时候是 `null`。
 *
 * 用途：设置页里那些「新增」按钮。建一条记忆 / 一个技能 / 一个定时任务，靠面板里填
 * 几个格子填不全（技能要写正文和触发条件、插件要写代码），所以改成把话头递给模型。
 */
export const [composerSeed, setComposerSeed] = createSignal<string | null>(null)

/** 关掉设置，把一条起手指令送进输入框。设置盖在输入框上面，不关就看不见。 */
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
 * 模块建立时跟外壳对一次账。
 *
 * 放在模块顶层，不挂在某个组件的 `onMount` 上：页签这份镜像随这个模块一起建立，
 * 对账就跟它在同一处，不引入「谁先跑」这个问题。
 *
 * 只有桌面端有 PTY；调不通就算了，那只意味着这一次没能补回页签。
 */
if (isDesktopShell()) {
  void tauriInvoke<TerminalSession[]>('terminal_list')
    .then(restoreTerminalTabs)
    .catch(() => {})
}

const FOLLOWUP_KEY = 'qywork.followUpMode'

/**
 * 会话在跑时发出去的消息，默认走哪一档。
 *
 * `queue` = 等这一轮跑完再作为下一轮发起；`steer` = 注入当前这一轮，
 * 模型下一次请求就看到。界面上这两个词是「加入队列」与「调整方向」。
 *
 * **真源在客户端，服务端不存也不读。** 它是输入习惯，与主题、面板宽度同层；
 * 服务端存一份就是第二本账，而且和用户此刻按的键可能不一致——意图随每条
 * `message.send` 的 `steer` 字段显式携带。
 *
 * 按设备记：手机上没有 `Ctrl+Enter`，两端的习惯本来就不必相同。
 */
export type FollowUpMode = 'queue' | 'steer'

function readFollowUpMode(): FollowUpMode {
  try {
    return localStorage.getItem(FOLLOWUP_KEY) === 'steer' ? 'steer' : 'queue'
  } catch {
    // 隐私模式下 localStorage 直接抛。记不住默认档不该让应用起不来。
    return 'queue'
  }
}

export const [followUpMode, setFollowUpModeSignal] = createSignal<FollowUpMode>(readFollowUpMode())

/** 改默认档的唯一入口，同步落盘。 */
export function setFollowUpMode(next: FollowUpMode): void {
  if (next === followUpMode()) return
  setFollowUpModeSignal(next)
  try {
    localStorage.setItem(FOLLOWUP_KEY, next)
  } catch {
    // 同上：这一次的选择已经生效，存不下只影响下次启动。
  }
}

/**
 * 会话流里折叠条目的开合，按条目 key。**开合的权威在这里，不在 `<details>` 节点上**：
 * 节点的寿命由渲染投影决定——组卡多一个成员、单条工具并进组卡，节点就换新，
 * 记在节点上的展开态跟着丢。只有用户点开合才写；没记过的条目视为合着。
 */
const [folds, setFolds] = createStore<Record<string, boolean>>({})

export function foldOpen(key: string): boolean {
  return folds[key] ?? false
}

export function setFoldOpen(key: string, open: boolean): void {
  setFolds(key, open)
}

/** 只在这条还没记过决定时写：给新出生的组卡定初始开合用，之后归用户。 */
export function seedFoldOpen(key: string, open: boolean): void {
  if (folds[key] === undefined) setFolds(key, open)
}
