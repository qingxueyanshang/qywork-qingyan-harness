/**
 * 云端账号：`/api/cloud/state`、`/api/cloud/login`、`/api/cloud/logout`。
 *
 * 账号状态对象按运行中的配置对象创建，每个服务进程一个（同一配置对象只对应一个服务）。
 * 未配置云端地址时（`cloud/origins.ts`）只回答 `unavailable`，界面据此不显示账号入口。
 */

import type { QyConfig } from '@qywork/runtime'
import { CloudAccount } from '../cloud/account.ts'
import { cloudOrigins } from '../cloud/origins.ts'
import { type ApiHandler, json } from './types.ts'

const accounts = new WeakMap<QyConfig, CloudAccount>()

function accountOf(config: QyConfig): CloudAccount | null {
  const origins = cloudOrigins()
  if (!origins) return null
  let account = accounts.get(config)
  if (!account) {
    account = new CloudAccount(config, origins)
    accounts.set(config, account)
  }
  return account
}

export const handleCloudApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  if (!p.startsWith('/api/cloud/')) return null
  const account = accountOf(d.config)
  if (p === '/api/cloud/state' && req.method === 'GET') {
    return json(account ? await account.state() : { state: 'unavailable' })
  }
  if (!account) return json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  if (p === '/api/cloud/login' && req.method === 'POST') return json(await account.login())
  if (p === '/api/cloud/logout' && req.method === 'POST') {
    await account.logout()
    return json(await account.state())
  }
  return null
}
