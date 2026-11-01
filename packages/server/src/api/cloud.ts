/**
 * 云端账号：`/api/cloud/state`、`/api/cloud/login`、`/api/cloud/logout`。
 *
 * 账号对象由 `server.ts` 按进程创建一个。未配置云端地址时（`cloud/origins.ts`）为 null，只回答 `unavailable`，
 * 界面据此不显示账号入口。
 */

import { openSystemBrowser } from '../cloud/open.ts'
import { type ApiHandler, json } from './types.ts'

export const handleCloudApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  if (!p.startsWith('/api/cloud/')) return null
  const account = d.cloud
  if (p === '/api/cloud/state' && req.method === 'GET') {
    return json(account ? await account.state() : { state: 'unavailable' })
  }
  if (!account) return json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  if (p === '/api/cloud/login' && req.method === 'POST') {
    // 只有桌面外壳请求时才打开浏览器：手机经远程访问时浏览器会打开在电脑上。
    const body = (await req.json().catch(() => ({}))) as { openBrowser?: boolean }
    const state = await account.login()
    if (body.openBrowser && state.state === 'pending') openSystemBrowser(state.verificationUri)
    return json(state)
  }
  if (p === '/api/cloud/logout' && req.method === 'POST') {
    await account.logout()
    return json(await account.state())
  }
  return null
}
