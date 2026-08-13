/**
 * 纯界面状态：命令面板、右侧面板、几个浮层，以及当前工作区。
 *
 * 这些和服务端无关，也不进 `state` ——它们的生命周期是「这一次打开」，
 * 混进业务 store 只会让每次事件推送都要绕过一堆与服务端无关的字段。
 */

import { createSignal } from 'solid-js'

/** 命令面板开关等纯 UI 状态用 signal，不进 store。 */
export const [paletteOpen, setPaletteOpen] = createSignal(false)

/**
 * 右侧面板当前视图。`null` = 收起。
 *
 * 曾经这里有 `'preview'` 这个合法值，但 `SidePanel` 的 `<Switch>` 里没有对应的
 * `Match`——设成它的结果是面板展开、内容空白。预览现在是「文件」视图的一个子状态
 * （由 `previewPath` 决定），不再是并列的第四个视图：它本来就是从文件树点进去的，
 * 做成并列项会让「返回文件树」没有自然的落点。
 */
export type PanelView = 'plan' | 'files' | 'git' | 'team' | 'extras'
export const [sidePanel, setSidePanel] = createSignal<PanelView | null>(null)

/**
 * 上一次看的视图。
 *
 * 顶栏只有一个按钮负责「展开 / 收起」，展开时要回到用户上次待的地方而不是
 * 一律跳回文件——否则在变更视图里手滑收起，再展开就得重新点一次 tab。
 */
const [lastPanelView, setLastPanelView] = createSignal<PanelView>('files')
export function togglePanel(): void {
  if (sidePanel()) {
    setLastPanelView(sidePanel() as PanelView)
    setSidePanel(null)
  } else {
    setSidePanel(lastPanelView())
  }
}
export function openPanel(view: PanelView): void {
  setLastPanelView(view)
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
 * 当前浮层。`null` = 没有浮层。
 *
 * 一个信号，而不是每个浮层一个布尔。三个布尔的时候「设置和配对同时开着」
 * 在类型上完全合法，互斥只能靠每个调用点自觉——那就是第二本账。
 *
 * **只剩一个。** `runs` 回答「这一个会话花了多少」。原先并列在这里的
 * settings / schedules / plugins / team / memory / mobile 六个是**机器配置**，
 * 已经整体搬进设置整页（见 `settingsPage`）；`workspace` 那个是「换项目」的浮层，
 * 换项目现在就在左栏点一下的事，浮层整个删了，不留第二条路。
 */
export type Overlay = 'runs'
export const [overlay, setOverlay] = createSignal<Overlay | null>(null)
export function closeOverlay(): void {
  setOverlay(null)
}

/**
 * 设置整页。`null` = 没在看设置。
 *
 * ## 为什么是整页不是浮层
 *
 * 浮层适合「改一格就走」。设置有八个类目、要来回比对，浮层把整页遮住之后
 * 既看不到自己正在改的会话，也没有地方放类目导航——上一版把六个能力做成六个
 * 平行浮层，正是因为浮层里塞不下一层导航。
 *
 * ## 为什么复用现有网格而不是新开一列
 *
 * 打开设置时左栏换成类目导航、主区换成设置内容。多开一列就多一套宽度、断点和
 * 收起逻辑，而设置和会话本来就互斥——同时看不到对方不是损失。
 */
export type SettingsPage =
  | 'general'
  | 'models'
  | 'access'
  | 'team'
  | 'memory'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'schedules'
  | 'mobile'
export const [settingsPage, setSettingsPage] = createSignal<SettingsPage | null>(null)

/** 打开设置。不带参数回到「通用」——它是唯一不需要前置知识的类目。 */
export function openSettings(page: SettingsPage = 'general'): void {
  setSettingsPage(page)
}
export function closeSettings(): void {
  setSettingsPage(null)
}

export const [previewPath, setPreviewPath] = createSignal<string | null>(null)

/**
 * **当前项目**。
 *
 * 会话、文件树、git、扩展清单全部按它取；`client.api` 也按它给每条 REST
 * 拼 `?ws=`。它是前端这一侧「我在看哪个项目」的唯一权威——服务端那边没有
 * 对应的可变状态，只有 `workspaces` 表和每条请求自带的参数。
 */
export interface WorkspaceInfo {
  id: string
  root: string
  name: string
}
export const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null)
