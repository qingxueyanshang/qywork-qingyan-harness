/**
 * 测连接 —— 把 `qy probe` 那套实测搬到界面上。
 *
 * ## 为什么必须有这一层
 *
 * 内置目录不认得中转站、自建网关和刚发布的模型，`lookupModel` 只能回落到保守猜测：
 * 不请求思考、计价按 0。两条后果都完全静默——用户以为自己在用一个会思考的模型，
 * 而账本报 $0。命令行早有 `qy probe`，但桌面端用户手边不一定有终端。
 *
 * ## 与 CLI 共用同一个 `probeModel`
 *
 * 不另写一套「给界面用的探测」。两套探测的结论迟早不一致，而不一致的表现是
 * 「命令行说支持、界面说不支持」，谁也说不清哪个对。
 *
 * ## 三条边界
 *
 * 1. **前端永远拿不到 key。** 请求体只带接口名和模型名，key 由服务端自己
 *    `resolveApiKey` 取。
 * 2. **`ProbeStep.detail` 是 provider 的原始错误消息**（`ai/src/probe.ts:99`），
 *    里面可能回显请求 URL 甚至凭证。返回前按 `collectSecrets` 的值表扫一遍——
 *    E 条「明文 key 不出服务端」不能被一条错误文案绕过去。
 * 3. **只探落盘配置，不收草稿。** 允许探草稿就得让这个端点接收临时明文 key，
 *    等于多开一条 key 上行路径。界面上按钮置灰、提示先保存，比多一条路径便宜。
 *
 * 探测结果**不落盘**：写回 capabilities 走既有的 `PUT /api/config`，
 * 不在这里开第二个写入点。
 */

import { type ProbeOutcome, probeModel, toCapabilities } from '@qywork/ai'
import { collectSecrets, resolveApiKey, resolveModel } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/**
 * 把已知凭证从探测明细里抹掉。
 *
 * 按**值**扫而不是按字段名：错误消息是一整段自由文本，key 可能出现在
 * URL 的 query、`Authorization` 回显、或者 provider 自己拼的一句话里。
 * 短值不扫（`< 8` 字符的「凭证」多半是占位符，按值替换会把正常文字打得稀烂）。
 */
function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (s.length < 8) continue
    out = out.split(s).join('***')
  }
  return out
}

function scrubOutcome(o: ProbeOutcome, secrets: string[]): ProbeOutcome {
  return { ...o, probes: o.probes.map((p) => ({ ...p, detail: scrub(p.detail, secrets) })) }
}

export const handleProbeApi: ApiHandler = async (url, req, d) => {
  if (url.pathname !== '/api/probe' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as {
    provider?: string
    model?: string
    /** `reachability` 只发一个请求；`full` 逐档试思考与 effort，要几秒。 */
    mode?: 'reachability' | 'full'
  } | null
  if (!body?.provider || !body.model) {
    return json({ error: 'bad request', message: '缺少 provider 或 model' }, 400)
  }

  const target = resolveModel(d.config, { provider: body.provider, model: body.model })
  if (!target) {
    return json({ error: 'not found', message: `配置里没有名为 "${body.provider}" 的接口` }, 404)
  }

  const outcome = await probeModel(
    {
      kind: target.kind,
      apiKey: resolveApiKey(target),
      model: target.model,
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      ...(target.headers ? { headers: target.headers } : {}),
      // **不带已有的 capabilities**：带上等于让上一次的结论影响这一次，
      // 探出来的就不再是端点的事实，而是「上次那个结论有没有自洽」。
    },
    body.mode === 'full' ? {} : { reachabilityOnly: true },
  )

  const { values } = collectSecrets(d.config)
  return json({
    outcome: scrubOutcome(outcome, values),
    // 可以安全写回配置的那一部分。**没探过的轴一条都不含**——
    // 写一个「探针都通过了」的空结论会覆盖目录里正确的保守值。
    capabilities: toCapabilities(outcome),
  })
}
