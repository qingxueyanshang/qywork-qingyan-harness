/**
 * 内置浏览器桥：界面这一侧与 Rust 原生宿主之间只有这一层。
 *
 * **只在桌面外壳里存在。** 调用方在渲染入口之前就该用 `isDesktopShell()` 加握手能力
 * 判掉，而不是让这里抛错（CLAUDE.md B5）。摆放子视图只对页嵌在面板里的宿主成立，
 * 把窗口提到前面只对页在独立窗口里的宿主成立，按握手能力的 `presentation` 取用。
 *
 * 标签页清单、地址、标题都是宿主推过来的投影，这里只发「请宿主做一件事」。
 * **前端不生成 tabId，也不自己写地址**——那两样在宿主手里。归属是协调器的事，
 * 工具栏是标准浏览器 chrome，不区分人工页与 AI 页。
 */

import { tauriInvoke, tauriListen } from './store/shell.ts'

/** 界面看得见的一页。与 Rust `TabView` 同形：只有 id / 地址 / 标题 / 工作区 / 创建序号。 */
export interface NativeTab {
  tabId: string
  url: string
  title: string
  /** 这一页所属的工作区 id。建页时定，此后不改。 */
  workspaceId: string
  /** 外壳进程里的创建序号，与终端会话共用一个计数器。页签条按它排序。 */
  createdSeq: number
}

/** 用户新开的空标签停在这个地址上。地址栏对它显示为空。 */
export const BLANK_PAGE = 'about:blank'

export function listBrowserTabs(): Promise<NativeTab[]> {
  return tauriInvoke<NativeTab[]>('browser_tabs')
}

/** 新开一页。不给地址就是一页空标签；工作区必带，这一页从此归它。 */
export function openBrowserPage(url: string | undefined, workspaceId: string): Promise<NativeTab> {
  return tauriInvoke<NativeTab>('browser_open', { workspaceId, ...(url ? { url } : {}) })
}

export function closeBrowserPage(tabId: string): Promise<void> {
  return tauriInvoke<void>('browser_close', { tabId })
}

export type NavigateAction = 'goto' | 'back' | 'forward' | 'reload'

export function navigateBrowserPage(
  tabId: string,
  action: NavigateAction,
  url?: string,
): Promise<void> {
  return tauriInvoke<void>('browser_navigate', { tabId, action, ...(url ? { url } : {}) })
}

export function onBrowserTabs(handler: (tabs: NativeTab[]) => void): Promise<void> {
  return tauriListen<NativeTab[]>('browser:tabs', handler)
}

/** 把这一页所在的浏览器窗口提到前面，并切到这一页。 */
export function activateBrowserPage(tabId: string): Promise<void> {
  return tauriInvoke<void>('browser_activate', { tabId })
}

/**
 * 此刻摆在屏幕上的那一页。
 *
 * 原生子视图是窗口的子 HWND，画在所有 DOM 之上，CSS 层叠管不到它；所以
 * 「哪一页露出来」必须只有一个说法，`parkBrowserView` 才知道该不该收掉当前这一页。
 */
let placed: string | null = null

/** 宿主要的矩形：窗口客户区里的物理像素。 */
export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * DOM 矩形换算成宿主要的物理像素矩形。量不出来（藏起来的页签量到 0）时给 `null`。
 *
 * **宿主按物理像素摆放子视图**：传 CSS 像素会被按子视图 HWND 的 DPI 再乘一次缩放，
 * 在 100% 之外的显示缩放下位置和尺寸都偏。坐标原点是窗口客户区左上角，
 * 而主界面这块 WebView 铺满客户区，所以 DOM 的视口坐标就是客户区坐标。
 */
export function viewRect(
  rect: { left: number; top: number; width: number; height: number },
  dpr: number,
): ViewRect | null {
  if (!(dpr > 0) || rect.width < 1 || rect.height < 1) return null
  return {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  }
}

/** 把一页摆到这块矩形上，其余页移出可视区。 */
export function placeBrowserView(tabId: string, rect: ViewRect): void {
  placed = tabId
  void tauriInvoke('browser_layout', { tabId, ...rect }).catch(() => {})
}

/**
 * 收掉当前摆出来的那一页。
 *
 * 带 `tabId` 时只有它正摆着才收——切页签时旧页的清理跑在新页摆好之后，
 * 不判一下会把刚摆好的那一页又收回去。
 */
export function parkBrowserView(tabId?: string): void {
  if (tabId !== undefined && placed !== tabId) return
  placed = null
  void tauriInvoke('browser_layout', { x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
}
