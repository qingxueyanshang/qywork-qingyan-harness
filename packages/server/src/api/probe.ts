/**
 * 测试连接：在界面上提供与 `qy probe` 相同的实测。
 *
 * **必要性。** 内置目录不识别中转站、自建网关与新发布的模型，`lookupModel` 只能回退到保守推测：
 * 不请求思考、计价按 0。两个后果都完全静默：界面仍把它显示为会思考的模型，而账本记为 $0。
 * 命令行已有 `qy probe`，但桌面端用户不一定有终端。
 *
 * **与 CLI 共用同一个 `probeModel`。** 不另写一套供界面使用的探测。两套探测的结论终将不一致，
 * 表现为命令行报告支持而界面报告不支持，且无法判断哪一个正确。
 *
 * **三条边界**：
 * 1. **前端始终无法取得 key。** 请求体只带接口名与模型名，key 由服务端通过
 *    `resolveApiKey` 自行获取。
 * 2. **`ProbeStep.detail` 是 provider 的原始错误消息**（`ai/src/probe.ts`），
 *    其中可能回显请求 URL 甚至凭证。返回前按 `collectSecrets` 的值表扫描一遍：
 *    E 节「明文 key 不出服务端」不能被一条错误信息绕过。
 * 3. **只探测已保存的配置，不接收草稿。** 允许探测草稿就必须让该端点接收临时明文 key，
 *    等于多开一条 key 上行路径。界面上将按钮置灰并提示先保存，代价低于多一条路径。
 *
 * 探测结果不落盘：前端确认后把端点传输结论写入当前接口的模型条目，
 * 经由既有的 `PUT /api/config`，不在此处另开写入点。
 */

import { type ProbeOutcome, probeModel, toTransportCapabilities } from '@qywork/ai'
import { collectSecrets, resolveModel } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/**
 * 从探测明细中抹去已知凭证。
 *
 * 按值扫描而不是按字段名：错误消息是自由文本，key 可能出现在
 * URL 的 query、`Authorization` 回显或 provider 自行拼接的语句中。
 * 短值不扫描（少于 8 个字符的「凭证」通常是占位符，按值替换会破坏正常文字）。
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
  } | null
  if (!body?.provider || !body.model) {
    return json({ error: 'bad request', message: '缺少 provider 或 model' }, 400)
  }

  const target = resolveModel(d.config, { provider: body.provider, model: body.model })
  if (!target) {
    return json({ error: 'not found', message: `配置中没有名为 "${body.provider}" 的接口` }, 404)
  }

  const outcome = await probeModel(
    {
      kind: target.kind,
      apiKey: target.apiKey ?? '',
      model: target.model,
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      ...(target.headers ? { headers: target.headers } : {}),
      ...(target.spec ? { spec: target.spec } : {}),
      // 模型规格包含用户声明的协议和档位；只忽略上次的 transport 校准。
    },
    { signal: req.signal },
  )

  const { values } = collectSecrets(d.config)
  return json({
    outcome: scrubOutcome(outcome, values),
    // 只返回当前接口的传输结论，不含未探测的维度；官方档位仍来自目录。
    transport: toTransportCapabilities(outcome),
  })
}
