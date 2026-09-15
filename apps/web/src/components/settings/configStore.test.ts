/**
 * 配置写串行化与乐观并发（`configStore.ts` 的 `replaceConfig`）。
 *
 * 锁两个真实的丢 key：
 * 1. 同一页面里先填 API Key、紧接着填 Base URL，两次「读整份 → 改一格 → 整份 PUT」
 *    重叠，url 那次在 key 落盘前读到旧值，写回把 key 覆盖成空。串行化让写不重叠。
 * 2. 两个窗口/设备同时改，后写的那次基于旧整份，把前一次刚落的字段盖掉。服务端按
 *    版本指纹回 409，客户端重读最新整份、在其上重放这次编辑再提交，两处改动都留住。
 *
 * 服务端用一个内存 map 模拟，`saveServerConfig` 复刻真实语义：`mergeConfig` 的
 * `hasApiKey:false` 且不带明文 = 清 key；`baseVersion` 对不上当前版本 = 抛 409。
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
let serverVersion = 0
/** 下一次 saveServerConfig 先注入一次「别处的并发改动」，逼出一次 409。 */
let injectConflictOnce: (() => void) | null = null

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
    version: String(serverVersion),
    notices: [],
    problems: [],
    defaultEnvAllowList: [],
    config: { active: server.active, mode: server.mode, providers },
  }
}

const loadServerConfig = mock(() => Promise.resolve(payloadFromServer()))
const saveServerConfig = mock((config: RedactedConfig, baseVersion?: string) => {
  injectConflictOnce?.()
  injectConflictOnce = null
  if (baseVersion !== undefined && baseVersion !== String(serverVersion)) {
    return Promise.reject(Object.assign(new Error('409 conflict'), { status: 409 }))
  }
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
  serverVersion++
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

describe('配置写串行化与乐观并发', () => {
  beforeEach(async () => {
    server = {
      active: { provider: 'ds', model: 'm' },
      mode: 'auto',
      providers: { ds: { kind: 'openai_chat_completions' } },
    }
    serverVersion = 0
    injectConflictOnce = null
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

  test('别处并发改配置引发 409：重读重放，两处改动都留住', async () => {
    // 本次要填 key。保存那一刻，模拟另一个窗口刚把 baseUrl 写了进去（版本随之变）。
    injectConflictOnce = () => {
      server.providers.ds = { kind: 'openai_chat_completions', baseUrl: 'https://other.example/v1' }
      serverVersion++
    }
    await replaceConfig(setKey('sk-z'))
    // 第一次 save 撞 409；重读拿到别处那次的 baseUrl，重放本次 setKey 后再存。
    expect(server.providers.ds?.apiKey).toBe('sk-z')
    expect(server.providers.ds?.baseUrl).toBe('https://other.example/v1')
  })
})
