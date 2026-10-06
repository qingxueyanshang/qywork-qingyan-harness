/**
 * 内置浏览器的界面投影。
 *
 * 宿主是唯一权威：存活页面、真实地址、页面标题与控制归属都由 `browser:tabs`
 * 事件推送，此处只保存一份镜像。前端不生成 tabId、不修改地址：在前端写入两者会形成
 * 第二份记录，而 AI 操作的是宿主中的那一份。
 *
 * 页签条由 `syncBrowserTabs` 按镜像同步，每个页面按自身的 `workspaceId` 归入对应
 * 工作区的条目，因此整页刷新后各工作区的原生页面仍显示在各自的页签条上。
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

/** 宿主当前打开的页面。 */
export const browserTabs = tabs

/** 指定页面的当前状态。无法识别的 id 返回 `undefined`。 */
export function browserTab(tabId: string): NativeTab | undefined {
  return tabs().find((t) => t.tabId === tabId)
}

/**
 * 当前客户端是否可以使用内置浏览器（手动浏览）。
 *
 * 须同时满足两个条件：界面运行在桌面外壳中（宿主位于该外壳内，页签命令才能调用），
 * 且服务端报告宿主已连接。宿主未连接时不降级为 iframe：iframe 是另一种能力，
 * 不是同一功能的备用路径。
 */
export function browserReady(): boolean {
  return isDesktopShell() && state.capabilities?.browser.connected === true
}

/**
 * 页面嵌在面板中（`embedded`）还是位于浏览器自身的窗口中（`window`）。只由宿主在握手能力中报告，
 * 不按 UA 或平台推断；宿主首次连接之前为 `null`。
 *
 * 宿主断开后沿用上一次的值：它由外壳的构建目标决定，同一次加载中不会改变。不要改为
 * 断开时重置为 `null`，否则宿主重连期间嵌在面板中的页面会被收起。
 */
export const browserPresentation: Accessor<Presentation | null> = createRoot(() =>
  createMemo<Presentation | null>((last) => state.capabilities?.browser.presentation ?? last, null),
)

/**
 * 宿主已连接但没有可用浏览器时的原因，其余情况为 `null`。设置页的状态行与打开页面失败的提示
 * 使用同一文案。
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
 * 页签文字：网页标题；标题尚未取得时使用主机名，空标签页使用「新标签页」。
 * 标题随页面变化，× 的位置由页签的固定宽度保证（`.tab-name.fixed`），不要改为不定宽。
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

/** 指定页面的页签名，会话流中引用该页面时使用同一名称。无法识别的 id 返回 `undefined`。 */
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
  // 关闭页签时一并关闭原生页面。宿主中已不存在的页面在 `syncBrowserTabs` 中
  // 已先移除登记，不会执行到此处。
  for (const t of list) holdPanelTab(t.tabId, () => void closeBrowserPage(t.tabId).catch(() => {}))
}

/**
 * 新建页面并切换到该页面。不提供地址时为空标签页，地址由用户在地址栏中输入。
 *
 * 页签按宿主推送的清单建立，不在此处先建立再等待宿主确认：先建立的页签
 * 会带有前端生成的 id。
 *
 * 归属在第一次 await 之前读取：请求期间用户可能切换工作区，之后读到的当前工作区已不同，
 * 按它写入会把页面记入其他工作区的条目。响应也不合并进镜像，而是按宿主的存活清单对账：
 * 单页回执只表示页面曾被创建，用户在此期间关闭它时，合并回执会恢复一个已不存在的 tabId。
 */
export async function openBrowserTab(url?: string): Promise<void> {
  // 没有当前工作区时页面没有归属，宿主也会拒绝。
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
 * 在右侧面板中打开正文中的链接。
 *
 * 桌面外壳中本地 HTML 与 HTTP 链接都交给内置浏览器，页面嵌在面板中还是位于独立窗口中由宿主决定；
 * 其他客户端的 HTTP 链接使用网页预览。宿主不可用或打开页面失败时投递已有的错误通知，
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
 * 模块初始化时与宿主对账一次，之后按事件更新。
 *
 * 先将所有子视图移出可视区。原生子视图是窗口的子 HWND，不受 DOM / Solid 生命周期
 * 管理：页面被硬刷新（dev 协调重载、整页 reload）时，上一个页面的 `onCleanup` 不会执行，
 * 已放置的子视图停留在旧矩形上并覆盖对话区域，而刷新后面板处于收起状态（`sidePanel` 不持久化），
 * 没有任何 `BrowserPanel` 挂载来收起它。因此初始化时无条件 park 一次，之后由 `BrowserPanel`
 * 挂载时按需放置。`parkBrowserView()` 不带 tabId，按宿主的存活页面全部收起，不依赖前端当前
 * 识别的页面数。
 *
 * 不要把这次 park 移到取得 `browserPresentation` 之后：显示位置要等宿主连接服务端后才能取得，
 * sidecar 重启后宿主按重连间隔重连（sidecar 停止 1.5 s 时，实测在其恢复 1.3 s 后才连接），
 * 页面先刷新时，这段时间内子视图持续覆盖对话区域。页面位于独立窗口中的宿主将「全部收起」视为已满足，
 * 此处无需区分。
 *
 * 放在模块顶层，不放在某个组件的 `onMount` 中：镜像随本模块建立，
 * 对账与它位于同一处，不引入执行顺序问题（与 `ui.ts` 中补充终端页签的逻辑相同）。
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
