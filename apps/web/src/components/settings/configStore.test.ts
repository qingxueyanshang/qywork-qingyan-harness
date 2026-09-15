/**
 * 配置写串行化（`configStore.ts` 的 `replaceConfig`）。
 *
 * 锁一个真实竞态：先填 API Key、紧接着填 Base URL，两次「读服务端整份 → 改一格 →
 * 整份 PUT」重叠时，url 那次在 key 落盘前 GET 到旧的脱敏配置（`hasApiKey:false`），
 * 整份写回把刚存的 key 覆盖成空。串行化后每次写都在前一次落盘之后才读，改哪几格、
 * 按什么顺序改都不丢。
 *
 * 服务端用一个内存 map 模拟，`saveServerConfig` 复刻 `mergeConfig` 的语义
 * （`hasApiKey:false` 且不带明文 = 清 key）——竞态正是这条语义被喂了旧输入造成的。
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PermissionMode } from '@qywork/core'
import type { ConfigPayload, RedactedConfig, RedactedProvider } from '../../lib/store/index.ts'

interface ServerProvider {
  kind: string
  apiKey?: string
  baseUrl?: string
}
let server: {
  active: { provider: string; model: string }
  mode: PermissionMode
  providers: Record<string, ServerProvider>
}

function payloadFromServer(): ConfigPayload {
  const providers: Record<string, RedactedProvider> = {}
  for (const [name, p] of Object.entries(server.providers)) {
    providers[name] = {
      kind: p.kind,
      hasApiKey: Boolean(p.apiKey),
      models: {},
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    }
  }
  return {
    path: '',
    notices: [],
    problems: [],
    defaultEnvAllowList: [],
    config: { active: server.active, mode: server.mode, providers },
  }
}

const loadServerConfig = mock(() => Promise.resolve(payloadFromServer()))
const saveServerConfig = mock((config: RedactedConfig) => {
  for (const [name, p] of Object.entries(config.providers)) {
    const { hasApiKey, apiKey: explicit, baseUrl } = p
    const prior = server.providers[name]?.apiKey
    const apiKey = explicit !== undefined ? explicit : hasApiKey ? prior : undefined
    server.providers[name] = {
      kind: p.kind,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }
  }
  return Promise.resolve(payloadFromServer())
})

mock.module('../../lib/store/index.ts', () => ({
  loadServerConfig,
  saveServerConfig,
  explainApiError: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}))

const { replaceConfig, reloadConfig } = await import('./configStore.ts')

const setKey =
  (key: string) =>
  (cur: RedactedConfig): RedactedConfig => ({
    ...cur,
    providers: { ...cur.providers, ds: { ...cur.providers.ds!, apiKey: key, hasApiKey: true } },
  })
const setUrl =
  (url: string) =>
  (cur: RedactedConfig): RedactedConfig => ({
    ...cur,
    providers: { ...cur.providers, ds: { ...cur.providers.ds!, baseUrl: url } },
  })

describe('配置写串行化', () => {
  beforeEach(async () => {
    server = {
      active: { provider: 'ds', model: 'm' },
      mode: 'auto',
      providers: { ds: { kind: 'openai_chat_completions' } },
    }
    await reloadConfig()
  })

  test('先填 key 紧接着填 url，并发两次写不丢 key', async () => {
    // 不等第一次完成就发第二次——正是用户「填完 key 立刻填 url」的节奏。
    const a = replaceConfig(setKey('sk-x'))
    const b = replaceConfig(setUrl('https://api.example.com/v1'))
    await Promise.all([a, b])
    expect(server.providers.ds?.apiKey).toBe('sk-x')
    expect(server.providers.ds?.baseUrl).toBe('https://api.example.com/v1')
  })

  test('反过来先填 url 再填 key 同样不丢', async () => {
    const a = replaceConfig(setUrl('https://api.example.com/v1'))
    const b = replaceConfig(setKey('sk-y'))
    await Promise.all([a, b])
    expect(server.providers.ds?.apiKey).toBe('sk-y')
    expect(server.providers.ds?.baseUrl).toBe('https://api.example.com/v1')
  })
})
