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
  updates: { autoCheck: boolean; autoDownload: boolean }
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
    config: { active: server.active, mode: server.mode, providers, updates: server.updates },
  }
}

const loadServerConfig = mock(() => Promise.resolve(payloadFromServer()))
function persistConfig(config: RedactedConfig, baseVersion?: string): Promise<ConfigPayload> {
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
  if (config.updates) server.updates = { ...config.updates }
  serverVersion++
  return Promise.resolve(payloadFromServer())
}
const saveServerConfig = mock(persistConfig)

/*
 * 替身要**摊开真模块再覆盖那三个导出**。
 *
 * `mock.module` 是进程级的，一装就对后面所有导入这个模块的测试文件成立。只交出这三个
 * 导出的话，之后任何一个引到 `state` / `client` 的组件测试都会在导入那一刻报
 * 「Export named 'state' not found」，而失败点落在那个文件里，看不出成因在这里。
 */
const actualStore = await import('../../lib/store/index.ts')
mock.module('../../lib/store/index.ts', () => ({
  ...actualStore,
  loadServerConfig,
  saveServerConfig,
  explainApiError: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}))

const { config, configBusy, configWriteError, replaceConfig, reloadConfig } = await import(
  './configStore.ts'
)

function pause() {
  let resume!: () => void
  const promise = new Promise<void>((resolve) => {
    resume = resolve
  })
  return { promise, resume }
}

const setUpdate =
  (field: 'autoCheck' | 'autoDownload', value: boolean) =>
  (cur: RedactedConfig): RedactedConfig => ({
    ...cur,
    updates: { autoCheck: true, autoDownload: true, ...cur.updates, [field]: value },
  })

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
      updates: { autoCheck: true, autoDownload: true },
    }
    serverVersion = 0
    injectConflictOnce = null
    saveServerConfig.mockReset()
    saveServerConfig.mockImplementation(persistConfig)
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

  test('连续改两个开关，前一次保存返回时不覆盖后一次的即时显示', async () => {
    const first = pause()
    const second = pause()
    saveServerConfig.mockImplementationOnce(async (next, version) => {
      await first.promise
      return persistConfig(next, version)
    })
    saveServerConfig.mockImplementationOnce(async (next, version) => {
      await second.promise
      return persistConfig(next, version)
    })
    const a = replaceConfig(setUpdate('autoCheck', false))
    const b = replaceConfig(setUpdate('autoDownload', false))
    try {
      expect(config()?.updates).toEqual({ autoCheck: false, autoDownload: false })
      first.resume()
      await a
      expect(config()?.updates).toEqual({ autoCheck: false, autoDownload: false })
      expect(configBusy()).toBe(true)
    } finally {
      first.resume()
      second.resume()
      await Promise.all([a, b])
    }
    expect(server.updates).toEqual({ autoCheck: false, autoDownload: false })
    expect(configBusy()).toBe(false)
  })

  test('第一次保存失败时只回滚失败项，后续开关仍保持用户刚选的值并继续保存', async () => {
    const first = pause()
    const second = pause()
    saveServerConfig.mockImplementationOnce(async () => {
      await first.promise
      throw new Error('无法保存自动检查设置')
    })
    saveServerConfig.mockImplementationOnce(async (next, version) => {
      await second.promise
      return persistConfig(next, version)
    })
    const a = replaceConfig(setUpdate('autoCheck', false))
    const b = replaceConfig(setUpdate('autoDownload', false))
    try {
      first.resume()
      await a
      expect(configWriteError()).toBe('无法保存自动检查设置')
      expect(config()?.updates).toEqual({ autoCheck: true, autoDownload: false })
    } finally {
      second.resume()
      await Promise.all([a, b])
    }
    expect(server.updates).toEqual({ autoCheck: true, autoDownload: false })
    expect(configWriteError()).toBeNull()
    expect(configBusy()).toBe(false)
  })
})
