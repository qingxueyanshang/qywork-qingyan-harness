/**
 * 内置浏览器的界面投影。
 *
 * **宿主是唯一权威**：存活页、真实地址、页面标题、控制归属都由 `browser:tabs`
 * 事件推过来，这里只存一份镜像。前端不生成 tabId、不改地址——那两样写在这边
 * 就是第二本账，而 AI 操作的是宿主那一份。
 *
 * 页签条由 `syncBrowserTabs` 跟着镜像走，每一页按它自带的 `workspaceId` 落到那个
 * 工作区的条目上，因此整页刷新之后各工作区的原生页各自回到自己的页签条上。
 */

import type { BrowserCapability } from '@qywork/core'
import { type Accessor, createMemo, createRoot, createSignal } from 'solid-js'
import {
  BLANK_PAGE,
  closeBrowserPage,
  listBrowserTabs,
  type NativeTab,
  onBrowserTabs,
  openBrowserPage,
  parkBrowserView,
} from '../browser.ts'
import { localHtmlUrl } from '../links.ts'
import { isDesktopShell } from './shell.ts'
import { setState, state } from './state.ts'
import { holdPanelTab, openPreviewTab, showPanelTab, syncBrowserTabs, workspace } from './ui.ts'

type Presentation = NonNullable<BrowserCapability['presentation']>

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
 * 两条都要：这个界面在桌面外壳里（宿主就在这个外壳里，页签命令才调得到），
 * 且服务端报宿主已连上。宿主没连上时**不降级成 iframe**——那是另一种能力，
 * 不是同一件事的备用路线。
 */
export function browserReady(): boolean {
  return isDesktopShell() && state.capabilities?.browser.connected === true
}

/**
 * 页嵌在面板里（`embedded`）还是在浏览器自己的窗口里（`window`）。只由宿主在握手能力里报，
 * 不按 UA 或平台推断；宿主第一次连上之前为 `null`。
 *
 * 宿主断开后沿用上一次的值：它由外壳的构建目标决定，同一次加载里不会变。不要改成跟着
 * 断开回到 `null`，那会在宿主重连期间把嵌在面板里的页收掉。
 */
export const browserPresentation: Accessor<Presentation | null> = createRoot(() =>
  createMemo<Presentation | null>((last) => state.capabilities?.browser.presentation ?? last, null),
)

/**
 * 宿主连着却没有可用浏览器时的原因，其余情况为 `null`。设置页的状态行与开页失败的提示
 * 用同一句话。
 */
export function browserUnavailableText(): string | null {
  switch (state.capabilities?.browser.unavailable) {
    case 'not_found':
      return '未找到 Chrome、Edge 或 Chromium'
    case 'exited':
      return '浏览器已退出'
    default:
      return null
  }
}

/**
 * 页签上的字：网页标题，标题还没到时用主机名，空标签用「新标签页」。
 * 标题会随页面变，× 的位置由页签的固定宽度保证（`.tab-name.fixed`），不要改回不定宽。
 */
function labelOf(tab: NativeTab): string {
  const title = tab.title.trim()
  if (title && title !== BLANK_PAGE) return title
  try {
    return new URL(tab.url).host || '新标签页'
  } catch {
    return '新标签页'
  }
}

/** 某一页的页签名，会话流里指这一页时用同一个名字。认不出的 id 给 `undefined`。 */
export function browserTabLabel(tabId: string): string | undefined {
  const tab = browserTab(tabId)
  return tab ? labelOf(tab) : undefined
}

function project(list: NativeTab[]): void {
  setTabs(list)
  syncBrowserTabs(
    list.map((t) => ({
      id: t.tabId,
      title: labelOf(t),
      workspaceId: t.workspaceId,
      createdSeq: t.createdSeq,
    })),
  )
  // 关掉这一页时连带关掉原生页。宿主那边已经没了的页在 `syncBrowserTabs` 里
  // 先摘掉登记，不会再走到这里。
  for (const t of list) holdPanelTab(t.tabId, () => void closeBrowserPage(t.tabId).catch(() => {}))
}

/**
 * 新开一页并翻到它。不给地址就是一页空标签，地址由用户在地址栏里输入。
 *
 * 页签由宿主推回来的清单建立，不在这里先建一个再等宿主确认——先建的那一份
 * 会带着一个前端编的 id。
 *
 * 归属在第一次 await 之前取：请求期间用户可能切走，之后读到的当前工作区是另一个，
 * 按它写就是把这一页记进别人的条目。回包也不拼回镜像，而是按宿主的存活清单对账——
 * 单页回执只说「建过」，用户在这期间关掉它的话，拼回去就是复活一个已经没了的 tabId。
 */
export async function openBrowserTab(url?: string): Promise<void> {
  // 没有当前工作区就没有这一页的归属，宿主那边也会拒。
  const workspaceId = workspace()?.id
  if (!workspaceId) return
  const tab = await openBrowserPage(url, workspaceId)
  const list = await listBrowserTabs()
  project(list)
  if (list.some((t) => t.tabId === tab.tabId && t.workspaceId === workspaceId)) {
    showPanelTab(workspaceId, tab.tabId)
  }
}

/**
 * 正文里的链接落到右侧面板。
 *
 * 桌面外壳里本地 HTML 与 HTTP 链接都交给内置浏览器，页嵌在面板里还是在独立窗口里由宿主定；
 * 别的端 HTTP 链接用网页预览。宿主不可用或开页失败时投递已有的错误通知，
 * 不把 file URL 交给远端 iframe。
 */
export function openLinkInPanel(url: string): void {
  const local = localHtmlUrl(url, workspace()?.root ?? '/')
  const failed = (message: string) => setState('notice', { reason: 'preview_failed', message })
  if (isDesktopShell()) {
    if (!workspace()) {
      failed('请先打开工作区。')
      return
    }
    if (!browserReady()) {
      const reason = browserUnavailableText()
      failed(reason ? `${reason}。` : '内置浏览器尚未连接，请稍后重试。')
      return
    }
    void openBrowserTab(local ?? url).catch((error: unknown) => {
      failed(`无法打开预览：${error instanceof Error ? error.message : String(error)}`)
    })
    return
  }
  if (local) {
    failed('本地网页预览需要桌面端。')
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
 * 不要把这一次 park 挪到拿到 `browserPresentation` 之后：显示位置要等宿主连上服务端才有，
 * 硬刷新之后宿主重连可能要几秒，这段时间里子视图一直盖着聊天。页在独立窗口里的宿主把
 * 「全部收起」当作已成立，不需要这里区分。
 *
 * 放在模块顶层，不挂在某个组件的 `onMount` 上：镜像随这个模块一起建立，
 * 对账就跟它在同一处，不引入「谁先跑」这个问题（同 `ui.ts` 里补终端页签那段）。
 */
export function initBrowserProjection(): void {
  if (!isDesktopShell()) return
  parkBrowserView()
  void onBrowserTabs(project).catch(() => {})
  void listBrowserTabs()
    .then(project)
    .catch(() => {})
}

initBrowserProjection()
