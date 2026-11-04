/**
 * 云端账号：`/api/cloud/state`、`login`、`register`、`logout`、`avatar`，账号界面的 `models`、`usage`、`requests`，
 * 以及不需要登录的本版说明 `release-notes`。
 *
 * 账号对象由 `server.ts` 按进程创建一个。未配置云端地址时（`cloud/origin.ts`）为 null，只回答 `unavailable`，
 * 界面据此不显示账号入口。登录、注册与读取失败以 400 返回可直接显示的原因。
 */

import { CloudAccountError } from '../cloud/account.ts'
import { type ApiHandler, json } from './types.ts'

/** 使用记录每页条数。 */
const PAGE = 50

export const handleCloudApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  if (!p.startsWith('/api/cloud/')) return null
  const account = d.cloud
  if (p === '/api/cloud/state' && req.method === 'GET') {
    return json(account ? await account.state() : { state: 'unavailable' })
  }
  const notes = p === '/api/cloud/release-notes' && req.method === 'GET'
  if (notes && !account) return json(null)
  if (!account) return json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  try {
    if (notes) return json(await account.releaseNotes(url.searchParams.get('version') ?? ''))
    if ((p === '/api/cloud/login' || p === '/api/cloud/register') && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown }
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        return json({ error: 'invalid_request', message: '缺少邮箱或密码' }, 400)
      }
      const email = body.email.trim()
      return json(
        p === '/api/cloud/login'
          ? await account.login(email, body.password)
          : await account.register(email, body.password),
      )
    }
    if (p === '/api/cloud/logout' && req.method === 'POST') {
      await account.logout()
      return json(await account.state())
    }
    if (p === '/api/cloud/avatar' && req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { image?: unknown }
      if (typeof body.image !== 'string') {
        return json({ error: 'invalid_request', message: '缺少头像图片' }, 400)
      }
      return json(await account.setAvatar(body.image))
    }
    if (p === '/api/cloud/usage' && req.method === 'GET') return json(await account.usage())
    if (p === '/api/cloud/models' && req.method === 'GET') return json(await account.models())
    if (p === '/api/cloud/requests' && req.method === 'GET') {
      return json(await account.requests(url.searchParams.get('before'), PAGE))
    }
  } catch (err) {
    if (err instanceof CloudAccountError) {
      return json({ error: 'cloud', message: err.message }, 400)
    }
    throw err
  }
  return null
}
