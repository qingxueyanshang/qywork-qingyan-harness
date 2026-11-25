/**
 * 桌面外壳以外的客户端新建、关闭与导航内置浏览器的页面，上传交给网页的文件（`browser/remote/pages.ts` 的 `BrowserPages`）。
 * 桌面外壳的界面经外壳直接调用宿主，不使用本接口。
 *
 * - `POST /api/browser/pages`：`{ url?, hidden? }`，在请求所指的工作区新建页面，返回 `BrowserTabView`。
 * - `POST /api/browser/pages/navigate`：`{ tabId, action, url? }`；地址按宿主的规则解析，无法解析时返回 400 与宿主的说明。
 * - `DELETE /api/browser/pages?tabId=`：关闭页面。
 * - `POST /api/browser/uploads?tabId=&name=`：请求体为文件内容，返回 `{ upload }`，查看连接以该编号把文件交给网页。
 * - 宿主未连接时返回 409。
 */

import { type ApiHandler, json } from './types.ts'

const ACTIONS = ['goto', 'back', 'forward', 'reload'] as const

export const handleBrowserApi: ApiHandler = async (url, req, d) => {
  if (
    url.pathname !== '/api/browser/pages' &&
    url.pathname !== '/api/browser/pages/navigate' &&
    url.pathname !== '/api/browser/uploads'
  ) {
    return null
  }
  const pages = d.browserPages
  if (!pages) return json({ error: 'unavailable', message: '内置浏览器未连接' }, 409)
  const failed = (err: unknown) =>
    json({ error: 'browser', message: err instanceof Error ? err.message : String(err) }, 400)

  if (url.pathname === '/api/browser/uploads') {
    const tabId = url.searchParams.get('tabId')
    if (req.method !== 'POST' || !tabId) return json({ error: 'invalid', message: '参数无效' }, 400)
    return pages
      .upload(tabId, url.searchParams.get('name') ?? '', req.body)
      .then((upload) => json({ upload }), failed)
  }
  if (url.pathname === '/api/browser/pages/navigate' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      tabId?: unknown
      action?: unknown
      url?: unknown
    } | null
    const action = ACTIONS.find((a) => a === body?.action)
    if (
      typeof body?.tabId !== 'string' ||
      !action ||
      (action === 'goto' && typeof body.url !== 'string')
    ) {
      return json({ error: 'invalid', message: '参数无效' }, 400)
    }
    return pages
      .navigate(body.tabId, action, typeof body.url === 'string' ? body.url : undefined)
      .then(() => json({ ok: true }), failed)
  }
  if (url.pathname !== '/api/browser/pages') return null
  if (req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { url?: unknown; hidden?: unknown }
    return pages
      .create(
        d.workspaceId,
        typeof body.url === 'string' ? body.url : undefined,
        body.hidden === true,
      )
      .then((tab) => json(tab), failed)
  }
  if (req.method === 'DELETE') {
    const tabId = url.searchParams.get('tabId')
    if (!tabId) return json({ error: 'invalid', message: '参数无效' }, 400)
    return pages.close(tabId).then(() => json({ ok: true }), failed)
  }
  return null
}
