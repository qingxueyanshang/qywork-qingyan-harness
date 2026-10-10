/**
 * 配置写串行化与乐观并发（`configStore.ts` 的 `replaceConfig`）。
 *
 * 锁定两种 key 丢失场景：
 * 1. 同一页面中先填写 API Key、紧接着填写 Base URL，两次「读取完整配置 → 修改一个字段 → 整份 PUT」
 *    重叠，写入 url 的一次在 key 落盘前读到旧值，写回时把 key 覆盖为空。串行化使两次写入不重叠。
 * 2. 两个窗口或设备同时修改，后写入的一次基于旧的完整配置，覆盖前一次刚保存的字段。服务端按
 *    版本指纹返回 409，客户端重新读取最新的完整配置、在其上重放本次编辑后再提交，两处修改均得到保留。
 *
 * 服务端由 `client.api` 的替身模拟，`/api/config` 的 PUT 复现真实语义：按 `mergeConfig`，
 * `hasApiKey:false` 且不带明文表示清除 key；`baseVersion` 与当前版本不一致时返回 409。
 *
 * 不要改成用 `mock.module` 替换 store 模块：Bun 的模块替身在整个测试进程内有效，
 * `mock.restore()` 不撤销它，之后导入 store 的测试文件读写的都是这里的内存服务端。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PermissionMode } from '@qywork/core'
import type {
  ConfigPayload,
  ProviderRename,
  RedactedConfig,
  RedactedProvider,
} from '../../lib/store/index.ts'

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
/** 下一次 PUT 前注入一次来自其他客户端的并发修改，以触发一次 409。 */
let injectConflictOnce: (() => void) | null = null
/** 每次 PUT 先取出队首的一项并执行完毕，再落盘；该项抛出异常即表示本次保存失败。 */
const beforePut: (() => Promise<void>)[] = []

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

let store: typeof import('../../lib/store/index.ts')
let clientModule: typeof import('../../lib/client.ts')
let configStore: typeof import('./configStore.ts')
let originalApi: typeof store.client.api

async function serverApi<T>(path: string, init?: RequestInit): Promise<T> {
  if (path === '/api/models') {
    return { providers: [], media: [], mediaLibrary: [], library: [] } as T
  }
  if (path !== '/api/config') throw new Error(`unexpected ${path}`)
  if (init?.method !== 'PUT') return payloadFromServer() as T
  await beforePut.shift()?.()
  const { config, baseVersion, renameProvider } = JSON.parse(String(init.body)) as {
    config: RedactedConfig
    baseVersion?: string
    renameProvider?: ProviderRename
  }
  injectConflictOnce?.()
  injectConflictOnce = null
  if (baseVersion !== undefined && baseVersion !== String(serverVersion)) {
    throw new clientModule.ApiError(409, path, JSON.stringify({ error: 'conflict' }))
  }
  const providers: Record<string, ServerProvider> = {}
  for (const [name, p] of Object.entries(config.providers)) {
    const { hasApiKey, apiKey: explicit, baseUrl } = p
    const prior = server.providers[renameProvider?.to === name ? renameProvider.from : name]?.apiKey
    const apiKey = explicit !== undefined ? explicit : hasApiKey ? prior : undefined
    providers[name] = {
      kind: p.kind,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }
  }
  server.providers = providers
  if (config.active) server.active = config.active
  if (config.updates) server.updates = { ...config.updates }
  serverVersion++
  return { ok: true } as T
}

// store 模块求值时按 `location` 创建连接客户端，DOM 必须先于它注册。
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  store = await import('../../lib/store/index.ts')
  clientModule = await import('../../lib/client.ts')
  configStore = await import('./configStore.ts')
  originalApi = store.client.api
  store.client.api = serverApi
})
afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

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

const rename =
  (from: string, to: string) =>
  (cur: RedactedConfig): RedactedConfig => {
    const { [from]: provider, ...rest } = cur.providers
    return { ...cur, providers: { ...rest, [to]: provider! }, active: { provider: to, model: 'm' } }
  }

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
    beforePut.length = 0
    await configStore.reloadConfig()
  })

  test('先填写 key 紧接着填写 url，两次并发写入不丢失 key', async () => {
    // 不等待第一次完成即发起第二次，对应用户填写 key 后立即填写 url 的操作。
    const a = configStore.replaceConfig(setKey('sk-x'))
    const b = configStore.replaceConfig(setUrl('https://api.example.com/v1'))
    await Promise.all([a, b])
    expect(server.providers.ds?.apiKey).toBe('sk-x')
    expect(server.providers.ds?.baseUrl).toBe('https://api.example.com/v1')
  })

  test('填写密钥后立即连续改名，队列保留每次改名的来源并保持密钥', async () => {
    const a = configStore.replaceConfig(setKey('sk-rename'))
    const b = configStore.replaceConfig(rename('ds', '即梦'), { from: 'ds', to: '即梦' })
    const c = configStore.replaceConfig(rename('即梦', '即梦1'), { from: '即梦', to: '即梦1' })
    await Promise.all([a, b, c])
    expect(Object.keys(server.providers)).toEqual(['即梦1'])
    expect(server.providers.即梦1?.apiKey).toBe('sk-rename')
    expect(configStore.config()?.providers.即梦1?.hasApiKey).toBe(true)
    expect(configStore.config()?.active?.provider).toBe('即梦1')
  })

  test('改名保存遇到其他客户端轮换密钥，冲突重放仍使用同一改名关系', async () => {
    await configStore.replaceConfig(setKey('sk-before'))
    injectConflictOnce = () => {
      server.providers.ds!.apiKey = 'sk-after'
      server.providers.ds!.baseUrl = 'https://changed.example/v1'
      serverVersion++
    }
    await configStore.replaceConfig(rename('ds', '即梦'), { from: 'ds', to: '即梦' })
    expect(server.providers.ds).toBeUndefined()
    expect(server.providers.即梦?.apiKey).toBe('sk-after')
    expect(server.providers.即梦?.baseUrl).toBe('https://changed.example/v1')
    expect(configStore.config()?.providers.即梦?.hasApiKey).toBe(true)
  })

  test('顺序相反，先填写 url 再填写 key，同样不丢失', async () => {
    const a = configStore.replaceConfig(setUrl('https://api.example.com/v1'))
    const b = configStore.replaceConfig(setKey('sk-y'))
    await Promise.all([a, b])
    expect(server.providers.ds?.apiKey).toBe('sk-y')
    expect(server.providers.ds?.baseUrl).toBe('https://api.example.com/v1')
  })

  test('改名失败后，对新名称的后续编辑取消时保留失败提示', async () => {
    beforePut.push(async () => {
      throw new Error('接口改名保存失败')
    })
    const a = configStore.replaceConfig(rename('ds', '新名称'), { from: 'ds', to: '新名称' })
    const b = configStore.replaceConfig((cur) => {
      const provider = cur.providers.新名称
      if (!provider) return null
      return {
        ...cur,
        providers: {
          ...cur.providers,
          新名称: { ...provider, baseUrl: 'https://example.test/v1' },
        },
      }
    })
    await Promise.all([a, b])
    expect(configStore.configWriteError()).toBe('接口改名保存失败')
    expect(Object.keys(server.providers)).toEqual(['ds'])
    expect(configStore.configBusy()).toBe(false)
  })

  test('最新配置使后续编辑校验失败时，投影与保存队列继续运行', async () => {
    const first = pause()
    beforePut.push(async () => {
      await first.promise
      throw new Error('接口改名保存失败')
    })
    const a = configStore.replaceConfig(rename('ds', '新名称'), { from: 'ds', to: '新名称' })
    const b = configStore.replaceConfig((cur) => {
      if (!cur.providers.新名称) throw new Error('接口已不存在')
      return setUpdate('autoCheck', false)(cur)
    })
    const c = configStore.replaceConfig(setUpdate('autoDownload', false))
    first.resume()
    await Promise.all([a, b, c])
    expect(server.updates).toEqual({ autoCheck: true, autoDownload: false })
    expect(configStore.configWriteError()).toBeNull()
    expect(configStore.configBusy()).toBe(false)
    await configStore.replaceConfig(() => {
      throw new Error('接口名称已存在')
    })
    expect(configStore.configWriteError()).toBe('接口名称已存在')
    expect(configStore.configBusy()).toBe(false)
  })

  test('其他客户端并发修改配置引发 409：重新读取并重放，两处修改均保留', async () => {
    // 本次填写 key。保存时模拟另一个窗口刚写入 baseUrl（版本随之改变）。
    injectConflictOnce = () => {
      server.providers.ds = { kind: 'openai_chat_completions', baseUrl: 'https://other.example/v1' }
      serverVersion++
    }
    await configStore.replaceConfig(setKey('sk-z'))
    // 第一次保存遇到 409；重新读取得到另一个窗口写入的 baseUrl，重放本次 setKey 后再保存。
    expect(server.providers.ds?.apiKey).toBe('sk-z')
    expect(server.providers.ds?.baseUrl).toBe('https://other.example/v1')
  })

  test('连续修改两个开关，前一次保存返回时不覆盖后一次的即时显示', async () => {
    const first = pause()
    const second = pause()
    beforePut.push(
      () => first.promise,
      () => second.promise,
    )
    const a = configStore.replaceConfig(setUpdate('autoCheck', false))
    const b = configStore.replaceConfig(setUpdate('autoDownload', false))
    try {
      expect(configStore.config()?.updates).toEqual({ autoCheck: false, autoDownload: false })
      first.resume()
      await a
      expect(configStore.config()?.updates).toEqual({ autoCheck: false, autoDownload: false })
      expect(configStore.configBusy()).toBe(true)
    } finally {
      first.resume()
      second.resume()
      await Promise.all([a, b])
    }
    expect(server.updates).toEqual({ autoCheck: false, autoDownload: false })
    expect(configStore.configBusy()).toBe(false)
  })

  test('第一次保存失败时只回滚失败项，后续开关仍保持用户刚选的值并继续保存', async () => {
    const first = pause()
    const second = pause()
    beforePut.push(
      async () => {
        await first.promise
        throw new clientModule.ApiError(
          500,
          '/api/config',
          JSON.stringify({ error: '无法保存自动检查设置' }),
        )
      },
      () => second.promise,
    )
    const a = configStore.replaceConfig(setUpdate('autoCheck', false))
    const b = configStore.replaceConfig(setUpdate('autoDownload', false))
    try {
      first.resume()
      await a
      expect(configStore.configWriteError()).toBe('无法保存自动检查设置')
      expect(configStore.config()?.updates).toEqual({ autoCheck: true, autoDownload: false })
    } finally {
      second.resume()
      await Promise.all([a, b])
    }
    expect(server.updates).toEqual({ autoCheck: true, autoDownload: false })
    expect(configStore.configWriteError()).toBeNull()
    expect(configStore.configBusy()).toBe(false)
  })
})
