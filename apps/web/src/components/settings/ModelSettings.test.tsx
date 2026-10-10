/** 覆盖接口改名、名称冲突、默认模型操作、检测结果显示和 Base URL 的官方地址占位符。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ProbeResult, ProviderRename, RedactedConfig } from '../../lib/store/index.ts'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // 组件可能已在其他测试文件导入；新的 document 需要重新注册 Solid 的点击委托。
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
})
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

async function settingsFixture(
  check: (fixture: {
    host: HTMLDivElement
    stored: () => RedactedConfig
    beforeRead: (action: () => void) => void
    idle: () => Promise<void>
  }) => Promise<void>,
) {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { writeSession } = await import('../../lib/session.ts')
  const { configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const originalApi = store.client.api
  const provider = {
    kind: 'openai_chat_completions',
    hasApiKey: true,
    models: { chat: {} },
    media: { video: { kind: 'openai_videos' as const } },
  }
  let stored: RedactedConfig = {
    providers: { first: structuredClone(provider), second: structuredClone(provider) },
    active: { provider: 'second', model: 'chat' },
    mediaDefaults: { video: { provider: 'second', model: 'video' } },
  }
  let beforeRead: (() => void) | undefined
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models')
      return { providers: [], library: [], media: [], mediaLibrary: [] } as T
    if (init?.method === 'PUT') {
      stored = JSON.parse(String(init.body)).config
      return { ok: true } as T
    }
    const action = beforeRead
    beforeRead = undefined
    action?.()
    return {
      config: structuredClone(stored),
      path: '',
      version: 'v',
      notices: [],
      problems: [],
      defaultEnvAllowList: [],
    } as T
  }
  const idle = async () => {
    const deadline = Date.now() + 3000
    while (configBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(configBusy()).toBe(false)
  }
  writeSession('qywork.settings.models.library', false)
  writeSession('qywork.settings.models.picked', 'first')
  await reloadConfig()
  await store.reloadModelCatalog()
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host)
  try {
    await check({
      host,
      stored: () => stored,
      beforeRead: (action) => {
        beforeRead = action
      },
      idle,
    })
  } finally {
    await idle()
    dispose()
    host.remove()
    store.client.api = originalApi
  }
}

for (const [index, output] of ['chat', 'video'].entries()) {
  test(`点击默认${output}模型后立即切换接口，保存仍指向点击时的接口`, async () => {
    await settingsFixture(async ({ host, stored, idle }) => {
      host.querySelectorAll<HTMLButtonElement>('.model-pick')[index]!.click()
      const second = [...host.querySelectorAll<HTMLButtonElement>('.tab-chip')].find(
        (button) => button.textContent === 'second',
      )!
      second.click()
      await idle()
      const ref = output === 'chat' ? stored().active : stored().mediaDefaults?.video
      expect(ref).toEqual({ provider: 'first', model: output })
    })
  })
}

test('重名和空名称恢复原名并显示错误，不留下看似已经保存的输入值', async () => {
  await settingsFixture(async ({ host, stored, idle }) => {
    for (const value of ['second', '   ']) {
      const input = host.querySelector<HTMLInputElement>('.setting-row-control input')!
      input.value = value
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
      await idle()
      expect(input.value).toBe('first')
      expect(host.querySelector('.settings-error')?.textContent).toContain('接口名称')
      expect(Object.keys(stored().providers)).toEqual(['first', 'second'])
    }
  })
})

test('新增接口前其他窗口占用同名，保留其密钥标记、地址及模型', async () => {
  await settingsFixture(async ({ host, stored, beforeRead, idle }) => {
    const concurrent = {
      kind: 'openai_chat_completions',
      hasApiKey: true,
      baseUrl: 'https://other.example/v1',
      models: { existing: {} },
    }
    beforeRead(() => {
      stored().providers.新接口 = concurrent
    })
    host.querySelector<HTMLButtonElement>('.tab-chip.add')!.click()
    await idle()
    expect(stored().providers.新接口).toEqual(concurrent)
    expect(host.querySelector('.settings-error')?.textContent).toContain('接口名称')
  })
})

test('改名保存前其他窗口占用目标名称，两个接口均保持原配置', async () => {
  await settingsFixture(async ({ host, stored, beforeRead, idle }) => {
    const source = structuredClone(stored().providers.first!)
    const target = {
      kind: 'openai_chat_completions',
      hasApiKey: true,
      models: { existing: {} },
    }
    beforeRead(() => {
      stored().providers.target = target
    })
    const input = host.querySelector<HTMLInputElement>('.setting-row-control input')!
    input.value = 'target'
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await idle()
    expect(stored().providers.first).toEqual(source)
    expect(stored().providers.target).toEqual(target)
    expect(host.querySelector('.settings-error')?.textContent).toContain('接口名称')
  })
})

test('名称输入框提交改名关系，默认对话与生成模型同步指向新名称', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { writeSession } = await import('../../lib/session.ts')
  const { configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const originalApi = store.client.api
  let stored: RedactedConfig = {
    providers: {
      main: {
        kind: 'openai_chat_completions',
        hasApiKey: true,
        models: { chat: {} },
        media: { video: { kind: 'openai_videos' } },
      },
    },
    active: { provider: 'main', model: 'chat' },
    mediaDefaults: { video: { provider: 'main', model: 'video' } },
  }
  let relation: ProviderRename | undefined
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models')
      return { providers: [], library: [], media: [], mediaLibrary: [] } as T
    if (path === '/api/config' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        config: RedactedConfig
        renameProvider: ProviderRename
      }
      stored = body.config
      relation = body.renameProvider
      return { ok: true } as T
    }
    return {
      config: stored,
      path: '',
      version: 'v',
      notices: [],
      problems: [],
      defaultEnvAllowList: [],
    } as T
  }
  writeSession('qywork.settings.models.library', false)
  writeSession('qywork.settings.models.picked', 'main')
  await reloadConfig()
  await store.reloadModelCatalog()
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host)
  try {
    const input = host.querySelector<HTMLInputElement>('.setting-row-control input')!
    input.value = '即梦'
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    const deadline = Date.now() + 3000
    while (configBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(relation).toEqual({ from: 'main', to: '即梦' })
    expect(stored.providers.main).toBeUndefined()
    expect(stored.providers.即梦?.hasApiKey).toBe(true)
    expect(stored.active?.provider).toBe('即梦')
    expect(stored.mediaDefaults?.video?.provider).toBe('即梦')
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.placeholder).toContain(
      '已设置',
    )
  } finally {
    dispose()
    host.remove()
    store.client.api = originalApi
  }
})

test('地址占位符显示实际官方地址；混合厂商与未知模型不显示错误的统一默认', async () => {
  const { baseUrlPlaceholder } = await import('./ModelSettings.tsx')
  const deepseek = 'https://api.deepseek.com/v1'
  expect(baseUrlPlaceholder([deepseek, deepseek])).toBe(`留空使用 ${deepseek}`)
  expect(baseUrlPlaceholder([deepseek, 'https://api.xiaomimimo.com/v1'])).toBe(
    '留空按各模型使用官方地址',
  )
  expect(baseUrlPlaceholder([deepseek, undefined])).toBe('请填写接口地址')
  expect(baseUrlPlaceholder([])).toBe('请填写接口地址')
})

test('思考已观察但参数未确认时分别显示；未观察不显示为不支持', async () => {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { ProbeSummary } = await import('./ModelSettings.tsx')
  const initial: ProbeResult = {
    outcome: {
      reachable: true,
      untested: [],
      inconclusive: ['effort'],
      effortSource: 'probe',
      effortLevels: ['low', 'high'],
      thinkingObserved: true,
      probes: [{ name: '非法值对照', ok: false, inconclusive: true, detail: '接口接受了非法档位' }],
    },
    transport: {},
  }
  const [result, setResult] = createSignal(initial)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ProbeSummary result={result()} />, host)
  try {
    expect(host.textContent).toContain('已观察到思考')
    expect(host.textContent).toContain('档位参数未确认')
    expect(host.querySelector('.bad')).toBeNull()
    expect(host.querySelector('[data-tip]')?.getAttribute('data-tip')).toContain(
      '接口接受了非法档位',
    )
    setResult({
      ...initial,
      outcome: { ...initial.outcome, inconclusive: [], thinkingObserved: false },
    })
    expect(host.textContent).toContain('未观察到思考')
    expect(host.textContent).toContain('接口接受：low / high')
    expect(host.textContent).not.toContain('不支持')
    expect(host.textContent).not.toContain('默认思考')
    setResult({
      ...initial,
      outcome: {
        ...initial.outcome,
        reachable: false,
        probes: [{ name: '最小请求', ok: false, detail: '连接超时' }],
      },
    })
    expect(host.querySelector('.bad')?.textContent).toContain('连接失败')
  } finally {
    dispose()
    host.remove()
  }
})
