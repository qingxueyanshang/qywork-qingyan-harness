/**
 * 云端账号：`/api/cloud/state`、`login`、`register`、`logout`、`avatar`，账号界面的 `models`、`usage`、`requests`，
 * 充值的 `recharge`（下单）与 `recharge/:orderNo`（状态），
 * 不需要登录的本版说明 `release-notes` 与公告列表 `announcements`，以及公告已读位置的写入 `announcements/seen`。
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
  const listing = p === '/api/cloud/announcements' && req.method === 'GET'
  if (listing && !account) return json([])
  if (!account) return json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  try {
    if (notes) return json(await account.releaseNotes(url.searchParams.get('version') ?? ''))
    if (listing) return json(await account.announcements())
    if ((p === '/api/cloud/login' || p === '/api/cloud/register') && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        email?: unknown
        password?: unknown
        inviteCode?: unknown
      }
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        return json({ error: 'invalid_request', message: '缺少邮箱或密码' }, 400)
      }
      const email = body.email.trim()
      return json(
        p === '/api/cloud/login'
          ? await account.login(email, body.password)
          : await account.register(
              email,
              body.password,
              typeof body.inviteCode === 'string' && body.inviteCode.trim()
                ? body.inviteCode.trim()
                : undefined,
            ),
      )
    }
    if (p === '/api/cloud/logout' && req.method === 'POST') {
      await account.logout()
      return json(await account.state())
    }
    if (p === '/api/cloud/announcements/seen' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown }
      if (typeof body.id !== 'string') {
        return json({ error: 'invalid_request', message: '缺少公告 id' }, 400)
      }
      return json(await account.markAnnouncementSeen(body.id))
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
    if (p === '/api/cloud/recharge' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { amount?: unknown }
      if (typeof body.amount !== 'number') {
        return json({ error: 'invalid_request', message: '缺少充值金额' }, 400)
      }
      return json(await account.recharge(body.amount))
    }
    const order = /^\/api\/cloud\/recharge\/([^/]+)$/.exec(p)?.[1]
    if (order && req.method === 'GET') {
      return json({ status: await account.rechargeStatus(decodeURIComponent(order)) })
    }
  } catch (err) {
    if (err instanceof CloudAccountError) {
      return json({ error: 'cloud', message: err.message }, 400)
    }
    throw err
  }
  return null
}
