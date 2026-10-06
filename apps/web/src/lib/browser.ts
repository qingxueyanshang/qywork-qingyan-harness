/**
 * 内置浏览器桥：界面与 Rust 原生宿主之间唯一的接口层。
 *
 * 仅在桌面外壳中存在。调用方应在渲染入口之前用 `isDesktopShell()` 与握手能力
 * 判定，而不是由此处抛错（CLAUDE.md B5）。放置子视图只适用于页面嵌在面板中的宿主，
 * 将窗口置于前台只适用于页面位于独立窗口中的宿主，按握手能力的 `presentation` 选用。
 *
 * 标签页清单、地址与标题都是宿主推送的投影，此处只向宿主发送操作请求。
 * 前端不生成 tabId，也不自行写入地址：两者由宿主管理。归属由协调器负责，
 * 工具栏是标准浏览器 chrome，不区分用户打开的页面与 AI 打开的页面。
 */

import { tauriInvoke, tauriListen } from './store/shell.ts'

/** 界面可见的一个页面。与 Rust `TabView` 结构相同：只有 id / 地址 / 标题 / 工作区 / 创建序号。 */
export interface NativeTab {
  tabId: string
  url: string
  title: string
  /** 该页面所属的工作区 id。创建页面时确定，此后不变。 */
  workspaceId: string
  /** 外壳进程中的创建序号，与终端会话共用一个计数器。页签条按它排序。 */
  createdSeq: number
}

/** 用户新建的空标签页使用该地址。地址栏对它显示为空。 */
export const BLANK_PAGE = 'about:blank'

export function listBrowserTabs(): Promise<NativeTab[]> {
  return tauriInvoke<NativeTab[]>('browser_tabs')
}

/** 新建页面。不提供地址时为空标签页；工作区为必填项，页面此后归属该工作区。 */
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

/** 将该页面所在的浏览器窗口置于前台，并切换到该页面。 */
export function activateBrowserPage(tabId: string): Promise<void> {
  return tauriInvoke<void>('browser_activate', { tabId })
}

/**
 * 当前放置在屏幕上的页面。
 *
 * 原生子视图是窗口的子 HWND，渲染在所有 DOM 之上，不受 CSS 层叠控制；因此
 * 「哪个页面可见」只能有一处记录，`parkBrowserView` 据此判断是否收起当前页面。
 */
let placed: string | null = null

/** 宿主所需的矩形：窗口客户区中的物理像素。 */
export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 将 DOM 矩形换算为宿主所需的物理像素矩形。无法测得尺寸（隐藏的页签测得 0）时返回 `null`。
 *
 * 宿主按物理像素放置子视图：传入 CSS 像素会按子视图 HWND 的 DPI 再缩放一次，
 * 在 100% 以外的显示缩放下位置与尺寸均会偏移。坐标原点是窗口客户区左上角，
 * 而主界面的 WebView 铺满客户区，因此 DOM 的视口坐标即客户区坐标。
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

/** 将指定页面放置到该矩形上，其余页面移出可视区。 */
export function placeBrowserView(tabId: string, rect: ViewRect): void {
  placed = tabId
  void tauriInvoke('browser_layout', { tabId, ...rect }).catch(() => {})
}

/**
 * 收起当前放置的页面。
 *
 * 传入 `tabId` 时，仅当该页面正在显示才收起：切换页签时旧页面的清理在新页面放置之后执行，
 * 不做此判断会把刚放置的新页面收起。
 */
export function parkBrowserView(tabId?: string): void {
  if (tabId !== undefined && placed !== tabId) return
  placed = null
  void tauriInvoke('browser_layout', { x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
}
