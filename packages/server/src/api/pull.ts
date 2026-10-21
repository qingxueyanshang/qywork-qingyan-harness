/**
 * 拉取模型：设置页「拉取模型」读取接口上的型号、参数与价格（`@qywork/ai` 的 `pullModels`）。
 *
 * 与「检测」相同的边界：前端只传接口名，key 由服务端从已保存的配置读取，只拉取已保存的接口；
 * 结果不落盘，前端选定后经既有的 `PUT /api/config` 写入，不在此处另开写入点。
 */

import { PullError, pullModels } from '@qywork/ai'
import { collectSecrets } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

export const handlePullApi: ApiHandler = async (url, req, d) => {
  if (url.pathname !== '/api/models/pull' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as { provider?: string } | null
  if (!body?.provider) return json({ error: 'bad request', message: '缺少 provider' }, 400)
  const provider = d.config.providers[body.provider]
  if (!provider) {
    return json({ error: 'not found', message: `配置中没有名为 "${body.provider}" 的接口` }, 404)
  }
  if (!provider.baseUrl) return json({ error: 'bad request', message: '请先填写 Base URL' }, 400)

  try {
    return json(
      await pullModels(
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? '',
          ...(provider.headers ? { headers: provider.headers } : {}),
        },
        req.signal,
      ),
    )
  } catch (err) {
    if (!(err instanceof PullError)) throw err
    // 消息是请求路径与状态码；仍按值扫描一遍，凭证不能经由错误信息到达前端。
    let message = err.message
    for (const s of collectSecrets(d.config).values)
      if (s.length >= 8) message = message.split(s).join('***')
    return json({ error: 'pull failed', message }, 502)
  }
}
