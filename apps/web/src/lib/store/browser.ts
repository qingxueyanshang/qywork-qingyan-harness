/**
 * 内置浏览器的界面投影。
 *
 * **宿主是唯一权威**：存活页、真实地址、页面标题、控制归属都由 `browser:tabs`
 * 事件推过来，这里只存一份镜像。前端不生成 tabId、不改地址——那两样写在这边
 * 就是第二本账，而 AI 操作的是宿主那一份。
 *
 * 页签条由 `syncBrowserTabs` 跟着镜像走，因此整页刷新之后原生页照样回到页签上。
 */

import { createSignal } from 'solid-js'
import {
  closeBrowserPage,
  listBrowserTabs,
  type NativeTab,
  onBrowserTabs,
  openBrowserPage,
  parkBrowserView,
} from '../browser.ts'
import { isNativeBrowserShell } from './shell.ts'
import { state } from './state.ts'
import { holdPanelTab, openPreviewTab, setSidePanel, syncBrowserTabs } from './ui.ts'

const [tabs, setTabs] = createSignal<readonly NativeTab[]>([])

/** 宿主此刻开着的那几页。 */
export const browserTabs = tabs

/** 某一页此刻的样子。认不出的 id 给 `undefined`。 */
export function browserTab(tabId: string): NativeTab | undefined {
  return tabs().find((t) => t.tabId === tabId)
}

/**
 * 这一端能不能用内置浏览器（手动浏览）。
 *
 * 两条都要：这个界面在 Windows 桌面外壳里（摆得下原生子视图），
 * 且服务端报宿主已连上。宿主没连上时**不降级成 iframe**——那是另一种能力，
 * 不是同一件事的备用路线。
 */
export function browserReady(): boolean {
  return isNativeBrowserShell() && state.capabilities?.browser.connected === true
}

/** 页签上的字。**建出来就不再改**，页面标题变了也不动——用户正瞄着那颗 ×。 */
function labelOf(tabId: string): string {
  const n = /(\d+)$/.exec(tabId)?.[1]
  return n ? `浏览器 ${n}` : '浏览器'
}

function project(list: NativeTab[]): void {
  setTabs(list)
  syncBrowserTabs(list.map((t) => ({ id: t.tabId, title: labelOf(t.tabId) })))
  // 关掉这一页时连带关掉原生页。宿主那边已经没了的页在 `syncBrowserTabs` 里
  // 先摘掉登记，不会再走到这里。
  for (const t of list) holdPanelTab(t.tabId, () => void closeBrowserPage(t.tabId).catch(() => {}))
}

/**
 * 新开一页并翻到它。不给地址就是一页空标签，地址由用户在地址栏里输入。
 *
 * 页签由宿主推回来的清单建立，不在这里先建一个再等宿主确认——先建的那一份
 * 会带着一个前端编的 id。
 */
export async function openBrowserTab(url?: string): Promise<void> {
  const tab = await openBrowserPage(url)
  project([...tabs().filter((t) => t.tabId !== tab.tabId), tab])
  setSidePanel({ tab: tab.tabId })
}

/**
 * 正文里的链接落到右侧面板。
 *
 * **两条路按端分，不按可用性分**：这一端有内置浏览器就只走内置浏览器，
 * 宿主没连上时这条链接没有落点——**不退成网页预览**。退过去的话用户拿到的是一个
 * 看起来一样、却没有登录状态也不受 AI 控制的页面，而他分辨不出来。
 * 别的端本来就只有网页预览，那是那一端真实的能力范围。
 */
export function openLinkInPanel(url: string): void {
  if (isNativeBrowserShell()) {
    if (browserReady()) void openBrowserTab(url)
    return
  }
  openPreviewTab(url)
}

/**
 * 模块建立时跟宿主对一次账，之后跟着事件走。
 *
 * **先把所有子视图收出可视区。** 原生子视图是窗口的子 HWND，不受 DOM / Solid 生命周期
 * 管辖：页面被硬刷新（dev 协调重载、整页 reload）时，上一份页面的 `onCleanup` 不会跑，
 * 摆开着的子视图就停在旧矩形上盖住聊天，而刷新后面板从收起态起（`sidePanel` 不持久化）、
 * 没有任何 `BrowserPanel` 挂载去收它。所以初始化时无条件 park 一次，之后由 `BrowserPanel`
 * 挂载时按需摆放。`parkBrowserView()` 不带 tabId，按宿主的存活页全部收起，不依赖前端此刻
 * 认得几页。
 *
 * 放在模块顶层，不挂在某个组件的 `onMount` 上：镜像随这个模块一起建立，
 * 对账就跟它在同一处，不引入「谁先跑」这个问题（同 `ui.ts` 里补终端页签那段）。
 */
export function initBrowserProjection(): void {
  if (!isNativeBrowserShell()) return
  parkBrowserView()
  void onBrowserTabs(project).catch(() => {})
  void listBrowserTabs()
    .then(project)
    .catch(() => {})
}

initBrowserProjection()
