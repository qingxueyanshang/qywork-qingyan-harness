/**
 * 远程访问：开关与隧道状态。
 *
 * 二维码编码 console 中本设备的地址（隧道握手时由云端下发），不含令牌：手机扫码后登录同一账号才能打开本设备。
 */

import { type ApiHandler, json } from './types.ts'

export const handlePairingApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/pairing/remote' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean') {
      return json({ error: 'invalid_payload', message: 'enabled 必须是 true 或 false' }, 400)
    }
    const problems = await d.remote.setEnabled(body.enabled)
    if (problems) return json({ error: 'invalid_config', message: problems.join('；') }, 422)
    return json(d.remote.snapshot())
  }

  if (p === '/api/pairing/reconnect' && req.method === 'POST') {
    d.remote.reconnect()
    return json(d.remote.snapshot())
  }

  if (p === '/api/pairing' && req.method === 'GET') return json(d.remote.snapshot())

  return null
}
