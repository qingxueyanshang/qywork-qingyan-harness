/**
 * 纯界面状态：命令面板、右侧面板、几个浮层，以及当前工作区。
 *
 * 这些和服务端无关，也不进 `state` ——它们的生命周期是「这一次打开」，
 * 混进业务 store 只会让每次事件推送都要绕过大量与服务端无关的字段。
 */

import { createSignal } from 'solid-js'
import { isDesktopShell, tauriInvoke } from './shell.ts'

/** 命令面板开关等纯 UI 状态用 signal，不进 store。 */
export const [paletteOpen, setPaletteOpen] = createSignal(false)

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
 * `terminal` 只有桌面端有（PTY 是本机进程和一对系统句柄），`browser` 每一端都有
 * （就是一个 iframe）。**这一层不判端**：判在入口那边（`SidePanel` 的看板按
 * `isDesktopShell()` 决定列不列），这里只管开了哪几页。
 *
 * `conversation` 与 `cli` 都没有看板入口：只能从图卡上点开（看哪一条由那张卡说了算），
 * 所以也没有序号，标题就是那个节点的名字。两者分开是因为背后的来源不同：
 * 一个是子会话（有正文、有工具卡），一个是本机另一个进程写出来的一段流。
 */
export type PanelTabKind = 'terminal' | 'browser' | 'conversation' | 'cli'

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
   * 浏览器页现在指着的地址。**这一页的地址只有这一份**：收起面板会把 `BrowserPanel`
   * 卸载，地址记在组件里的话再展开就是一个空地址栏。其余几种页没有这个字段。
   *
   * 只记地址，不保页面状态：iframe 从 DOM 上摘下来再插回去就是重新加载，
   * 这是浏览器的行为，前端这一侧没有第二条路。
   */
  url?: string
}

/**
 * 面板现在翻开的是哪一页。`null` = 收起。
 *
 * 固定视图用它自己的名字，可多开的页用 `{ tab: id }`——**一个信号，不是「固定视图」
 * 加「当前页签」两个**：两个信号的时候「翻开文件页」和「翻开终端页」在类型上可以
 * 同时成立，谁盖过谁只能靠每个调用点自觉，那就是第二本账。
 */
export type PanelPage = PanelView | { tab: string }
export const [sidePanel, setSidePanel] = createSignal<PanelPage | null>(null)

const [tabs, setTabs] = createSignal<readonly PanelTab[]>([])

/** 开着哪几页可多开的页。顺序即页签条上的顺序。 */
export const panelTabs = tabs

/** 当前翻开的那一页的 id；停在固定视图上时是 `null`。派生量，不是第二份状态。 */
export function activePanelTab(): string | null {
  const page = sidePanel()
  return page !== null && typeof page === 'object' ? page.tab : null
}

/**
 * 关掉一页时要收的本机资源：终端的 PTY 与 xterm 实例、浏览器页记着的地址。
 *
 * **为什么不放在组件的 `onCleanup` 里**：收起面板会把整块面板卸载，而那时终端必须
 * 保持存活——用户收起去看会话，切回来命令还得在跑、滚动历史还得在。所以「组件卸载」和
 * 「这一页被关掉」是两件不同的事，只有后者该收资源，而后者唯一的入口在这里。
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
const TAB_LABEL = { terminal: '终端', browser: '浏览器' } as const
type NumberedKind = keyof typeof TAB_LABEL
const tabSeq: Record<NumberedKind, number> = { terminal: 0, browser: 0 }

/** 新开一页并翻到它。`url` 只有浏览器页用得上：新开出来就指着它。 */
export function openPanelTab(kind: NumberedKind, url?: string): void {
  tabSeq[kind] += 1
  const n = tabSeq[kind]
  const id = `${kind}-${n}`
  const tab: PanelTab = { id, kind, title: `${TAB_LABEL[kind]} ${n}` }
  // `exactOptionalPropertyTypes` 开着：没有地址时这个键必须不存在，不能写 undefined。
  if (url) tab.url = url
  setTabs((list) => [...list, tab])
  setSidePanel({ tab: id })
}

/**
 * 在浏览器页里打开一个地址：正文里的链接点下去落在这里。
 *
 * **已经有一页指着这个地址就翻回去**，不并排开出第二页——两页看同一个地址，
 * 内容逐字相同（同 `openConversationTab`）。
 */
export function openBrowserTab(url: string): void {
  const open = panelTabs().find((t) => t.kind === 'browser' && t.url === url)
  if (open) {
    setSidePanel({ tab: open.id })
    return
  }
  openPanelTab('browser', url)
}

/** 某一页现在指着的地址。没有地址（或不是浏览器页）时是空串。 */
export function panelTabUrl(id: string): string {
  return panelTabs().find((t) => t.id === id)?.url ?? ''
}

/** 浏览器页跳到另一个地址。 */
export function setPanelTabUrl(id: string, url: string): void {
  setTabs((list) => list.map((t) => (t.id === id ? { ...t, url } : t)))
}

/**
 * 打开某条子会话那一页。
 *
 * **页 id 就是会话 id**：同一条子会话再点一次是翻回去，不是并排开出第二页
 * ——两页看同一条已经跑完的会话，内容逐字相同。
 */
export function openConversationTab(conversationId: string, title: string): void {
  const id = `conversation-${conversationId}`
  if (!panelTabs().some((t) => t.id === id)) {
    setTabs((list) => [...list, { id, kind: 'conversation', title }])
  }
  setSidePanel({ tab: id })
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
  const id = `cli-${stepId}-${nodeId}`
  if (!panelTabs().some((t) => t.id === id)) {
    // 标题单独给，不拿 `nodeId` 顶：派一件那张卡的节点 id 是个内部常量，
    // 直接送上去页签就叫那个常量。
    setTabs((list) => [...list, { id, kind: 'cli', title }])
  }
  setSidePanel({ tab: id })
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
 * 序号也要跟着抬上去，否则下一次新开会撞上一个已经存在的 id。
 */
export function restoreTerminalTabs(ids: readonly string[]): void {
  const known = new Set(panelTabs().map((t) => t.id))
  const found: { n: number; tab: PanelTab }[] = []
  for (const id of ids) {
    if (known.has(id) || !id.startsWith('terminal-')) continue
    const n = Number(id.slice('terminal-'.length))
    if (!Number.isInteger(n) || n < 1) continue
    tabSeq.terminal = Math.max(tabSeq.terminal, n)
    found.push({ n, tab: { id, kind: 'terminal', title: `${TAB_LABEL.terminal} ${n}` } })
  }
  if (!found.length) return
  found.sort((a, b) => a.n - b.n)
  setTabs((list) => [...list, ...found.map((f) => f.tab)])
}

/**
 * 关掉一页。**这是收资源的唯一入口**（见 `tabDisposers`）。
 *
 * 关掉的正是当前那一页时，落到右边那页，没有就落到左边那页，一页都不剩就回文件视图
 * ——**不连带把面板收起来**：用户点的是这一页的 ×，不是面板的 ×。
 */
export function closePanelTab(id: string): void {
  const list = panelTabs()
  const i = list.findIndex((t) => t.id === id)
  if (i < 0) return
  const current = activePanelTab() === id
  setTabs(list.filter((t) => t.id !== id))
  disposeTab(id)
  if (!current) return
  const next = list[i + 1] ?? list[i - 1]
  setSidePanel(next ? { tab: next.id } : 'files')
}

/**
 * 换项目时把可多开的页全关掉。
 *
 * 不留着：终端里那个 shell 跑在上一个项目的目录里，浏览器那页指着上一个项目起的服务。
 * 留下来的表现是页签还在、点进去内容全是上一个项目的。
 */
export function closeAllPanelTabs(): void {
  const current = activePanelTab()
  for (const t of panelTabs()) disposeTab(t.id)
  setTabs([])
  if (current) setSidePanel('files')
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
 * 面板放大：会话正文让位，只留输入框和这块面板（布局见 `shell.css` 的
 * `.app.panel-max`）。
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
 * 这一页还在不在。**收起期间它可能已经没了**：换项目会把可多开的那些页全关掉，
 * 而记着的可能正是其中一页——不判一下的话展开出来是一块谁也点不掉的空白。
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
 * 一次场景切换——顶栏的搜索和面板开关得跟着藏，回来还要点一次「返回」。
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
 * 直接设 `openFile` 的话，从别的地方（命令面板、将来的「在文件里打开」）触发时
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
  void tauriInvoke<string[]>('terminal_list')
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
