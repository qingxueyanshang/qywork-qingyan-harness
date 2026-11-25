/**
 * 右侧面板中各客户端共享的页签与最近查看的文件，按请求所指的工作区读写（`@qywork/store` 的 `workspace-panel`）。
 * 清单记录在电脑上，全部客户端显示同一份；变化后发布 `panel.tabs`。
 *
 * - `POST /api/panel/tabs`：`{ kind: 'canvas' | 'file', path, title }` 或 `{ kind: 'plugin', workbench, title }`，打开一页并返回它；
 *   id 按 `sharedPanelTabId` 生成，同一对象已打开时不变。
 * - `DELETE /api/panel/tabs?id=`：关闭一页。
 * - `POST /api/panel/viewing`：`{ path }`，记录最近查看的文件。
 * - `DELETE /api/panel/viewing?path=`：最近查看的是该文件时清空。
 */

import { type SharedPanelTab, sharedPanelTabId } from '@qywork/core'
import {
  clearViewing,
  closePanelTab,
  listPanelTabs,
  openPanelTab,
  type Store,
  type StoredPanelTab,
  setViewing,
} from '@qywork/store'
import type { EventBus } from '../bus.ts'
import { type ApiHandler, json } from './types.ts'

/** 路径、工作台标识与标题的长度上限：写入页签与提示词，只接受较短的文本。 */
const TEXT_MAX = 500

/** 发布全部工作区的共享页签。握手后与清单变化时调用。 */
export function publishPanelTabs(store: Store, bus: EventBus): void {
  bus.publish({ type: 'panel.tabs', tabs: listPanelTabs(store) })
}

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= TEXT_MAX ? v : null

/** 请求体中的页签；字段不合法时为 `null`。 */
function tabOf(body: Record<string, unknown> | null): StoredPanelTab | null {
  const title = text(body?.title)
  if (!title) return null
  if (body?.kind === 'canvas' || body?.kind === 'file') {
    const path = text(body.path)
    if (!path) return null
    return { id: sharedPanelTabId({ kind: body.kind, path }), kind: body.kind, path, title }
  }
  if (body?.kind === 'plugin') {
    const workbench = text(body.workbench)
    if (!workbench) return null
    return { id: sharedPanelTabId({ kind: 'plugin', workbench }), kind: 'plugin', workbench, title }
  }
  return null
}

export const handlePanelApi: ApiHandler = async (url, req, d) => {
  const invalid = () => json({ error: 'invalid', message: '参数无效' }, 400)
  if (url.pathname === '/api/panel/tabs') {
    if (req.method === 'POST') {
      const tab = tabOf((await req.json().catch(() => null)) as Record<string, unknown> | null)
      if (!tab) return invalid()
      if (openPanelTab(d.store, d.workspaceId, tab)) publishPanelTabs(d.store, d.bus)
      return json({ ...tab, workspaceId: d.workspaceId } satisfies SharedPanelTab)
    }
    if (req.method === 'DELETE') {
      const id = text(url.searchParams.get('id'))
      if (!id) return invalid()
      if (closePanelTab(d.store, d.workspaceId, id)) publishPanelTabs(d.store, d.bus)
      return json({ ok: true })
    }
    return null
  }
  if (url.pathname === '/api/panel/viewing') {
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { path?: unknown } | null
      const path = text(body?.path)
      if (!path) return invalid()
      setViewing(d.store, d.workspaceId, path)
      return json({ ok: true })
    }
    if (req.method === 'DELETE') {
      const path = text(url.searchParams.get('path'))
      if (!path) return invalid()
      clearViewing(d.store, d.workspaceId, path)
      return json({ ok: true })
    }
    return null
  }
  return null
}
