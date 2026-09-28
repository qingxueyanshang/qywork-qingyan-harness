/**
 * 适配器工厂。
 *
 * 按 profile.kind 分派——**不按模型名猜厂商**。用户填什么模型 id 就用什么；
 * 经中转站以 OpenAI 协议调 Claude 是常见配置，按名字猜会把它路由到错误的协议上。
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
 * 判据是主机名而不是端口或路径：只有指向本机回环的端点才豁免。局域网里另一台机器上的
 * ollama 也不豁免——它可能挂在需要鉴权的反代后面，这时候静默发一个空 key
 * 换回来的是 401，又绕回 12-1 要修的那个问题。
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
 * 没配 key 时**在本地就判定**，不发请求去等 401。
 *
 * 不要发出去等 401 再由 `classifyProviderError` 判「是没配还是配错了」——
 * 那要靠 provider 的错误文案推断，各家写法不同，判错的方向恰好是最坏的那个：
 * 报 `auth_failed / API Key 无效` 会把新用户引向「检查 key 是不是抄错了」，
 * 而正确的动作是「去配一个」。本地知道 key 是空串，没有任何理由去问 provider。
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
