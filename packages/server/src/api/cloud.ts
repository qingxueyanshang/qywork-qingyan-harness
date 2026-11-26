/**
 * 云端账号：`/api/cloud/state`、`login`、`register`、`logout`、`avatar`、`name`，账号界面的 `account`（一次取得全部内容）
 * 与 `requests`（使用记录的后续分页），
 * 充值的 `recharge`（下单）与 `recharge/:orderNo`（状态），兑换码的 `redeem`，
 * 不需要登录的本版说明 `release-notes` 与公告列表 `announcements`，以及公告已读位置的写入 `announcements/seen`，
 * 客服对话的 `support`（读取与发送）、`support/read`（已读位置）与 `support/files/:id`（附件）。
 *
 * 账号对象由 `server.ts` 按进程创建一个。未配置云端地址时（`cloud/origin.ts`）为 null：带 `offline` 的路由以它答复，
 * 界面据此不显示账号入口；其余路径答复 404。登录、注册与读取失败以 400 返回可直接显示的原因。
 */

import { type CloudAccount, CloudAccountError } from '../cloud/account.ts'
import { markSupportRead, sendSupport, supportFile, supportThread } from '../cloud/support.ts'
import { type ApiHandler, json } from './types.ts'

/** 使用记录每页条数，账号概览中的第一页条数相同。 */
const PAGE = 50

type Run = (account: CloudAccount, req: Request, url: URL) => Promise<Response>

/** 一条路由。`offline` 是未配置云端时的答复（null 是合法的答复）；缺省时答复 404。 */
interface Route {
  run: Run
  offline?: unknown
}

const invalid = (message: string) => json({ error: 'invalid_request', message }, 400)

/** 请求体中的 JSON 对象；请求体不是 JSON 对象时为空对象。 */
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null)
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

const signIn =
  (mode: 'login' | 'register'): Run =>
  async (account, req) => {
    const body = await bodyOf(req)
    if (typeof body.email !== 'string' || typeof body.password !== 'string') {
      return invalid('缺少邮箱或密码')
    }
    const email = body.email.trim()
    if (mode === 'login') return json(await account.login(email, body.password))
    const invite = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : ''
    return json(await account.register(email, body.password, invite || undefined))
  }

/** 按 `方法 路径` 查找的路由。 */
const ROUTES: Record<string, Route> = {
  'GET /api/cloud/state': {
    run: async (account) => json(await account.state()),
    offline: { state: 'unavailable' },
  },
  'GET /api/cloud/release-notes': {
    run: async (account, _req, url) =>
      json(await account.releaseNotes(url.searchParams.get('version') ?? '')),
    offline: null,
  },
  'GET /api/cloud/announcements': {
    run: async (account) => json(await account.announcements()),
    offline: [],
  },
  'POST /api/cloud/login': { run: signIn('login') },
  'POST /api/cloud/register': { run: signIn('register') },
  'POST /api/cloud/logout': {
    run: async (account) => {
      await account.logout()
      return json(await account.state())
    },
  },
  'POST /api/cloud/announcements/seen': {
    run: async (account, req) => {
      const { id } = await bodyOf(req)
      return typeof id === 'string'
        ? json(await account.markAnnouncementSeen(id))
        : invalid('缺少公告 id')
    },
  },
  'PUT /api/cloud/avatar': {
    run: async (account, req) => {
      const { image } = await bodyOf(req)
      return typeof image === 'string'
        ? json(await account.setAvatar(image))
        : invalid('缺少头像图片')
    },
  },
  'PUT /api/cloud/name': {
    run: async (account, req) => {
      const { name } = await bodyOf(req)
      return typeof name === 'string' ? json(await account.setName(name)) : invalid('缺少用户名')
    },
  },
  'GET /api/cloud/account': { run: async (account) => json(await account.overview(PAGE)) },
  'GET /api/cloud/requests': {
    run: async (account, _req, url) =>
      json(await account.requests(url.searchParams.get('before'), PAGE)),
  },
  'POST /api/cloud/recharge': {
    run: async (account, req) => {
      const { amount } = await bodyOf(req)
      return typeof amount === 'number'
        ? json(await account.recharge(amount))
        : invalid('缺少充值金额')
    },
  },
  'POST /api/cloud/redeem': {
    run: async (account, req) => {
      const { code } = await bodyOf(req)
      return typeof code === 'string' && code.trim()
        ? json(await account.redeem(code.trim()))
        : invalid('缺少兑换码')
    },
  },
  'GET /api/cloud/support': { run: async (account) => json(await supportThread(account)) },
  'POST /api/cloud/support': {
    run: async (account, req) => {
      const form = await req.formData().catch(() => null)
      return form
        ? json(await sendSupport(account, form))
        : invalid('请求体须为 multipart/form-data')
    },
  },
  'POST /api/cloud/support/read': {
    run: async (account, req) => {
      const { id } = await bodyOf(req)
      return typeof id === 'string'
        ? json(await markSupportRead(account, id))
        : invalid('缺少消息 id')
    },
  },
}

/** 末段为参数的路由，按 `方法 前缀` 查找；参数不为空，已解码。 */
const PARAM_ROUTES: Record<string, (account: CloudAccount, param: string) => Promise<Response>> = {
  'GET /api/cloud/recharge/': async (account, orderNo) =>
    json({ status: await account.rechargeStatus(orderNo) }),
  'GET /api/cloud/support/files/': (account, id) => supportFile(account, id),
}

function routeOf(method: string, path: string): Route | null {
  const exact = ROUTES[`${method} ${path}`]
  if (exact) return exact
  const cut = path.lastIndexOf('/') + 1
  const param = PARAM_ROUTES[`${method} ${path.slice(0, cut)}`]
  const value = path.slice(cut)
  return param && value ? { run: (account) => param(account, decodeURIComponent(value)) } : null
}

export const handleCloudApi: ApiHandler = async (url, req, d) => {
  if (!url.pathname.startsWith('/api/cloud/')) return null
  const route = routeOf(req.method, url.pathname)
  const account = d.cloud
  if (!account) {
    return route?.offline !== undefined
      ? json(route.offline)
      : json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  }
  if (!route) return null
  try {
    return await route.run(account, req, url)
  } catch (err) {
    if (err instanceof CloudAccountError) {
      return json({ error: 'cloud', message: err.message }, 400)
    }
    throw err
  }
}
