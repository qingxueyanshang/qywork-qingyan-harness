/**
 * 桌面外壳以外的客户端的页签清单（`browser.tabs` 事件）与页面操作（`BrowserPages`：新建、关闭、导航、上传文件）。
 *
 * 宿主是页面的唯一权威：新建、关闭与导航都是宿主的操作，与桌面界面的页签与地址栏执行同一路径（地址按宿主的规则解析）。
 * 本模块不保存页面状态，清单取自桥接的存活表。
 */

import type { BrowserTabView } from '@qywork/core'
import type { EventBus } from '../../bus.ts'
import type { BrowserBridge } from '../bridge.ts'
import { saveUpload } from './uploads.ts'

/** 列入页签条的页面。 */
export function browserTabsOf(bridge: BrowserBridge | null): BrowserTabView[] {
  if (!bridge?.host()) return []
  return bridge
    .tabs()
    .filter((t) => !t.hidden)
    .map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, workspaceId: t.workspaceId }))
}

/** 宿主连接、断开与页面变化时发布 `browser.tabs`，返回注销函数。 */
export function publishBrowserTabs(bridge: BrowserBridge, bus: EventBus): () => void {
  const publish = () => bus.publish({ type: 'browser.tabs', tabs: browserTabsOf(bridge) })
  const offEvent = bridge.onEvent((frame) => {
    if (['opened', 'closed', 'navigated', 'title'].includes(frame.kind)) publish()
  })
  const offHost = bridge.onHostChange(publish)
  return () => {
    offEvent()
    offHost()
  }
}

/** 远程客户端的页面操作，供 `/api/browser/*` 使用。 */
export interface BrowserPages {
  /** 新建页面；不给出地址时为空白页。`hidden` 的页不列入页签条（文件页的 HTML 预览）。 */
  create(workspaceId: string, url: string | undefined, hidden: boolean): Promise<BrowserTabView>
  close(tabId: string): Promise<void>
  navigate(
    tabId: string,
    action: 'goto' | 'back' | 'forward' | 'reload',
    url: string | undefined,
  ): Promise<void>
  /** 保存一个交给该页文件输入框的文件，返回编号（见 `uploads.ts`）。该页不存在时抛出。 */
  upload(tabId: string, name: string, body: ReadableStream<Uint8Array> | null): Promise<string>
}

export function browserPages(bridge: BrowserBridge): BrowserPages {
  return {
    async create(workspaceId, url, hidden) {
      const data = await bridge.request('create', {
        workspaceId,
        url: url ?? 'about:blank',
        ...(hidden ? { hidden } : {}),
      })
      return {
        tabId: data?.tabId ?? '',
        url: data?.url ?? '',
        title: data?.title ?? '',
        workspaceId,
      }
    },
    async close(tabId) {
      await bridge.request('close', { tabId })
    },
    async navigate(tabId, action, url) {
      await bridge.request('navigate', { tabId, action, ...(url !== undefined ? { url } : {}) })
    },
    async upload(tabId, name, body) {
      if (!bridge.tab(tabId)) throw new Error('该页面已关闭')
      return saveUpload(tabId, name, body)
    },
  }
}
