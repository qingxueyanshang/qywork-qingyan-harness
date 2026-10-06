/**
 * 适配器工厂。
 *
 * 按 profile.kind 分派，**不按模型名推测厂商**。用户填写什么模型 id 就使用什么；
 * 经中转站以 OpenAI 协议调用 Claude 是常见配置，按名称推测会把它路由到错误的协议上。
 */

import { applyTransportCapabilities, lookupModel, officialBaseUrl } from './catalog.ts'
import { ProviderError } from './errors.ts'
import { AnthropicAdapter } from './providers/anthropic.ts'
import { OpenAICompatAdapter } from './providers/openai-compat.ts'
import { OpenAIResponsesAdapter } from './providers/openai-responses.ts'
import type { LlmAdapter, ProviderProfile } from './types.ts'

/**
 * 本机模型服务（ollama / llama.cpp / LM Studio / vLLM）不需要 API Key，
 * 空 key 在那里是**合法配置**而不是漏配。
 *
 * 判据是主机名而不是端口或路径：只有指向本机回环地址的端点才豁免。局域网中其他机器上的
 * ollama 同样不豁免：它可能位于需要鉴权的反向代理之后，此时静默发送空 key
 * 只会得到 401，「未配置 key」又会被报告为「key 无效」。
 */
function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}

/**
 * 未配置 key 时**在本地判定**，不发送请求等待 401。
 *
 * 不要发送请求后再由 `classifyProviderError` 判定是未配置还是配置错误：
 * 该判定依赖 provider 的错误文案，各厂商写法不同，误判的方向恰好最糟：
 * 报告 `auth_failed / API Key 无效` 会引导新用户检查 key 是否填写有误，
 * 而正确的操作是配置 key。本地已知 key 为空串，无需询问 provider。
 */
export function buildAdapter(profile: ProviderProfile, now = Date.now()): LlmAdapter {
  if (!profile.apiKey.trim() && !isLocalEndpoint(profile.baseUrl)) {
    throw new ProviderError({
      code: 'no_api_key',
      message: `未配置 API Key（供应商 ${profile.kind}，模型 ${profile.model}）。运行 qy init 生成配置，或设置对应的环境变量。`,
      provider: profile.kind,
      detail: { kind: profile.kind, model: profile.model },
    })
  }

  // 端点校验只作用于当前接口，不修改全局模型规格。
  const spec = applyTransportCapabilities(
    lookupModel(profile.model, profile.kind, now),
    profile.transport,
    profile.spec,
  )
  const baseUrl = profile.baseUrl?.trim() || officialBaseUrl(spec)
  if (!baseUrl) {
    throw new ProviderError({
      code: 'invalid_request',
      message: `请填写 Base URL：模型 ${profile.model} 在当前协议下没有已登记的官方地址`,
      provider: profile.kind,
    })
  }
  const resolved = { ...profile, baseUrl }

  switch (profile.kind) {
    case 'anthropic_messages':
      return Object.assign(new AnthropicAdapter(resolved, spec), { endpoint: baseUrl })
    case 'openai_chat_completions':
      return Object.assign(new OpenAICompatAdapter(resolved, spec), { endpoint: baseUrl })
    case 'openai_responses':
      return Object.assign(new OpenAIResponsesAdapter(resolved, spec), { endpoint: baseUrl })
    default: {
      const never: never = profile.kind
      throw new Error(`未知 provider: ${String(never)}`)
    }
  }
}
