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
export type PanelView = 'files' | 'git' | 'team'
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

export const [pairOpen, setPairOpen] = createSignal(false)
export const [settingsOpen, setSettingsOpen] = createSignal(false)
export const [workspaceSheetOpen, setWorkspaceSheetOpen] = createSignal(false)
export const [previewPath, setPreviewPath] = createSignal<string | null>(null)

/** 当前工作区。会话按工作区分表，看不到自己在哪个工作区时数据像是丢了。 */
export interface WorkspaceInfo {
  id: string
  root: string
  name: string
}
export const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null)
