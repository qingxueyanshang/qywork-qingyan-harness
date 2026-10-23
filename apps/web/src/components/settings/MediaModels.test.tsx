/**
 * 设置页里的生成模型：接口页添加、默认、删除，以及模型库的类别页签。
 *
 * 覆盖范围：`ModelSettings.tsx` 的 `addModel` 分流、生成模型行、`removeMediaModel` 与 `withMediaDefaults`；
 * `ModelLibrary.tsx` 的类别页签、未知单价显示与 `MediaTable`；`PullDialog.tsx` 的拉取、刷新、对应型号与添加。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { MEDIA_KIND_OUTPUT, type MediaKind } from '@qywork/core'
import type { MediaLibraryModel, PullResult, RedactedConfig } from '../../lib/store/index.ts'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

/**
 * 直接调用 Solid 挂在元素上的委托处理函数。回车的处理函数读 `currentTarget`，按 Solid 委托
 * 派发的做法把它指向该元素。
 *
 * 不要改成 `dispatchEvent`：Solid 的委托监听在组件模块首次求值时挂到全局 `document` 上，
 * 模块在整套测试的进程里只求值一次，而每个测试文件注册各自的 happy-dom 窗口。先于本文件
 * 导入 `ModelSettings.tsx` 的测试文件存在时，本文件的 `document` 上没有这个监听。
 */
function fire(el: HTMLElement, type: 'click' | 'keydown', init: KeyboardEventInit = {}) {
  if (type === 'keydown') {
    const event = new KeyboardEvent('keydown', { bubbles: true, ...init })
    Object.defineProperty(event, 'currentTarget', { configurable: true, value: el })
    ;(el as unknown as { $$keydown: (e: Event) => void }).$$keydown.call(el, event)
    return
  }
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (el as unknown as { $$click?: (e: Event) => void }).$$click
  if (delegated) delegated.call(el, event)
  else el.dispatchEvent(event)
}

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return ok()
}

const QWEN_IMAGE: MediaLibraryModel = {
  id: 'qwen-image-3.0',
  label: 'Qwen Image 3.0',
  vendor: '阿里云',
  kind: 'dashscope_images',
  kinds: ['dashscope_images', 'openai_images'],
  output: 'image',
  operations: ['generate', 'edit'],
  maxImages: 3,
  maxVideos: 0,
  params: ['size：字符串；宽*高', 'n：整数 1–6；一次生成几张；默认 1', 'seed：整数 0–2147483647'],
}

test('模型库未知单价显示横线，并直接显示订阅限制', async () => {
  const { render } = await import('solid-js/web')
  const { ModelLibrary } = await import('./ModelLibrary.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => (
      <ModelLibrary
        loading={false}
        error={null}
        media={[]}
        vendors={[
          {
            id: 'minimax',
            displayName: 'MiniMax',
            models: [
              {
                id: 'MiniMax-M3.1-Flash-Preview',
                label: 'MiniMax M3.1 Flash Preview',
                contextWindow: 1_000_000,
                maxOutputTokens: 524_288,
                vision: true,
                input: null,
                output: null,
                cacheRead: null,
                cacheWrite: null,
                currency: 'USD',
                effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                thinksByDefault: true,
                priceNotes: ['仅 M Plan 订阅 Key 可用；尚未公布按 token 单价'],
              },
            ],
          },
        ]}
      />
    ),
    host,
  )
  try {
    expect(
      Array.from(host.querySelectorAll('td')).filter((td) => td.textContent === '—'),
    ).toHaveLength(4)
    expect(host.textContent).not.toContain('$0')
    expect(host.querySelector('.lib-note')?.textContent).toContain('仅 M Plan 订阅 Key 可用')
  } finally {
    dispose()
    host.remove()
  }
})

test('官方模型使用目录协议，模型库显示对应页签', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const cases: { id: string; kind: MediaKind; baseUrl: string; vendor: string }[] = [
    {
      id: 'gemini-3.1-flash-image',
      kind: 'gemini_images',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      vendor: 'Google',
    },
    {
      id: 'gemini-omni-1.1-flash',
      kind: 'gemini_videos',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      vendor: 'Google',
    },
    {
      id: 'veo-3.1-generate-preview',
      kind: 'veo_videos',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      vendor: 'Google',
    },
    {
      id: 'grok-imagine-image-2.0',
      kind: 'xai_images',
      baseUrl: 'https://api.x.ai/v1',
      vendor: 'xAI',
    },
    {
      id: 'grok-imagine-video-1.5',
      kind: 'xai_videos',
      baseUrl: 'https://api.x.ai/v1',
      vendor: 'xAI',
    },
  ]
  const mediaLibrary: MediaLibraryModel[] = cases.map((m) => ({
    ...QWEN_IMAGE,
    ...m,
    label: m.id,
    output: MEDIA_KIND_OUTPUT[m.kind],
    kinds: [m.kind],
  }))
  for (const model of cases.flatMap((m) => [m, { ...m, baseUrl: 'https://relay.example/v1' }])) {
    let stored: RedactedConfig = {
      providers: {
        native: {
          kind: 'openai_chat_completions',
          baseUrl: model.baseUrl,
          hasApiKey: true,
          models: {},
        },
      },
    }
    store.client.api = async <T,>(path: string, init?: RequestInit) => {
      if (path === '/api/models')
        return { providers: [], media: [], library: [], mediaLibrary } as T
      if (path === '/api/config' && init?.method === 'PUT') {
        stored = (JSON.parse(String(init.body)) as { config: RedactedConfig }).config
        return { ok: true } as T
      }
      if (path === '/api/config')
        return {
          path: 'config.json',
          config: stored,
          version: 'v',
          notices: [],
          problems: [],
          defaultEnvAllowList: [],
        } as T
      throw new Error(`unexpected ${path}`)
    }
    await reloadConfig()
    await store.reloadModelCatalog()
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <ModelSettings />, host as unknown as HTMLElement)
    try {
      fire(
        Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find(
          (b) => b.textContent === 'native',
        )!,
        'click',
      )
      const input = host.querySelector<HTMLInputElement>('.model-row.add input')!
      input.value = model.id
      fire(input, 'keydown', { key: 'Enter' })
      expect(await until(() => !configBusy())).toBe(true)
      expect(stored.providers.native?.media?.[model.id]).toEqual({ kind: model.kind })
      expect(config()?.providers.native?.models).toEqual({})
      const output = MEDIA_KIND_OUTPUT[model.kind]
      expect(stored.mediaDefaults?.[output]).toEqual({ provider: 'native', model: model.id })
      fire(
        Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find((b) =>
          b.textContent?.includes('模型库'),
        )!,
        'click',
      )
      fire(
        Array.from(host.querySelectorAll<HTMLButtonElement>('.lib-tab')).find(
          (b) => b.textContent === (output === 'image' ? '图像' : '视频'),
        )!,
        'click',
      )
      expect(host.querySelector('.lib-table.media')?.textContent).toContain(model.id)
      expect(host.querySelector('.lib-table.media')?.textContent).toContain(model.vendor)
    } finally {
      dispose()
      host.remove()
    }
  }
})

test('生成模型默认取目录协议，接入方式可独立保存，删除时清理默认模型', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')

  let stored: RedactedConfig = {
    providers: {
      qwen: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        hasApiKey: true,
        models: {},
      },
    },
  }
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models') {
      return { providers: [], media: [], library: [], mediaLibrary: [QWEN_IMAGE] } as T
    }
    if (path === '/api/config' && init?.method === 'PUT') {
      stored = (JSON.parse(String(init.body)) as { config: RedactedConfig }).config
      return { ok: true } as T
    }
    if (path === '/api/config') {
      return {
        path: 'config.json',
        config: stored,
        version: 'v',
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    }
    throw new Error(`unexpected ${path}`)
  }
  await reloadConfig()
  await store.reloadModelCatalog()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host as unknown as HTMLElement)
  try {
    const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find(
      (b) => b.textContent === 'qwen',
    )
    fire(tab!, 'click')
    const input = () => host.querySelector<HTMLInputElement>('.model-row.add input')!
    const qwen = () => config()?.providers.qwen
    expect(qwen()?.models).toEqual({})
    input().value = 'qwen-image-3.0'
    fire(input(), 'keydown', { key: 'Enter' })
    // 百炼官方地址上的出图走百炼原生协议；这一类还没有默认，它成为默认。
    expect(qwen()?.media?.['qwen-image-3.0']).toEqual({ kind: 'dashscope_images' })
    expect(qwen()?.models).toEqual({})
    expect(config()?.mediaDefaults).toEqual({
      image: { provider: 'qwen', model: 'qwen-image-3.0' },
    })

    const row = () =>
      Array.from(host.querySelectorAll<HTMLElement>('.model-row')).find((r) =>
        r.textContent?.includes('qwen-image-3.0'),
      )
    expect(row()?.textContent).toContain('图像')
    expect(row()?.textContent).toContain('默认')
    expect(row()?.textContent).not.toContain('检测')

    const access = () => row()!.querySelector<HTMLSelectElement>('select')!
    expect(Array.from(access().options, (option) => option.value)).toEqual([
      'dashscope_images',
      'openai_images',
    ])
    access().value = 'openai_images'
    access().dispatchEvent(new Event('change', { bubbles: true }))
    expect(await until(() => !configBusy())).toBe(true)
    expect(stored.providers.qwen?.media?.['qwen-image-3.0']?.kind).toBe('openai_images')
    expect(stored.providers.qwen?.kind).toBe('openai_chat_completions')
    expect(stored.providers.qwen?.hasApiKey).toBe(true)
    expect(stored.mediaDefaults?.image).toEqual({ provider: 'qwen', model: 'qwen-image-3.0' })
    access().value = 'dashscope_images'
    access().dispatchEvent(new Event('change', { bubbles: true }))
    expect(await until(() => !configBusy())).toBe(true)
    expect(access().value).toBe('dashscope_images')

    // 目录外的 id 照旧当对话模型。
    input().value = 'some-chat-model'
    fire(input(), 'keydown', { key: 'Enter' })
    expect(qwen()?.models['some-chat-model']).toEqual({})
    expect(Object.keys(qwen()?.media ?? {})).toEqual(['qwen-image-3.0'])

    fire(row()!.querySelector<HTMLButtonElement>('.icon-btn')!, 'click')
    expect(qwen()?.media).toEqual({})
    // 该类别已清空：默认模型一并删除，否则服务端会以「默认指向已删模型」拒绝保存。
    expect(config()?.mediaDefaults).toBeUndefined()

    // 编辑依次保存，最后一次 PUT 已删除生成模型。
    expect(await until(() => !configBusy())).toBe(true)
    expect(stored.providers.qwen?.media).toEqual({})
    expect(stored.providers.qwen?.models).toEqual({ 'some-chat-model': {} })
    expect(stored.mediaDefaults).toBeUndefined()
  } finally {
    dispose()
    host.remove()
  }
})

const SUNBURST: MediaLibraryModel = {
  id: 'gpt-image-2.5-sunburst',
  label: 'GPT Image 2.5 Sunburst',
  vendor: 'OpenAI',
  kind: 'openai_images',
  kinds: ['openai_images'],
  output: 'image',
  operations: ['generate', 'edit'],
  maxImages: 16,
  maxVideos: 0,
  params: [],
}

/** 中转接口与配置读写的桩：`/api/models` 返回给定的生成目录与对话模型库，配置保存在 `stored` 中。 */
function relayApi(
  store: typeof import('../../lib/store/index.ts'),
  state: { stored: RedactedConfig },
  pull?: PullResult,
) {
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models')
      return {
        providers: [],
        media: [],
        mediaLibrary: [SUNBURST],
        library: [
          {
            id: 'deepseek',
            displayName: 'DeepSeek',
            models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash' }],
          },
        ],
      } as T
    if (path === '/api/models/pull' && pull) return pull as T
    if (path === '/api/config' && init?.method === 'PUT') {
      state.stored = (JSON.parse(String(init.body)) as { config: RedactedConfig }).config
      return { ok: true } as T
    }
    if (path === '/api/config')
      return {
        path: 'config.json',
        config: state.stored,
        version: 'v',
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    throw new Error(`unexpected ${path}`)
  }
}

const relayConfig = (): RedactedConfig => ({
  providers: {
    apii: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://ai.apii.cn/',
      hasApiKey: true,
      models: {},
    },
  },
})

test('手动添加目录 id 加后缀的名称：识别为生成型号并保存对应型号', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const state = { stored: relayConfig() }
  relayApi(store, state)
  await reloadConfig()
  await store.reloadModelCatalog()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host as unknown as HTMLElement)
  try {
    fire(
      Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find(
        (b) => b.textContent === 'apii',
      )!,
      'click',
    )
    const input = host.querySelector<HTMLInputElement>('.model-row.add input')!
    input.value = 'gpt-image-2.5-sunburst-4k'
    fire(input, 'keydown', { key: 'Enter' })
    expect(await until(() => !configBusy())).toBe(true)
    expect(state.stored.providers.apii?.media).toEqual({
      'gpt-image-2.5-sunburst-4k': {
        kind: 'openai_images',
        spec: { base: 'gpt-image-2.5-sunburst' },
      },
    })
    expect(state.stored.providers.apii?.models).toEqual({})
    expect(config()?.mediaDefaults?.image).toEqual({
      provider: 'apii',
      model: 'gpt-image-2.5-sunburst-4k',
    })
    // 对应型号不是渠道规格：行上仍是接入方式下拉框。
    const row = Array.from(host.querySelectorAll<HTMLElement>('.model-row')).find((r) =>
      r.textContent?.includes('gpt-image-2.5-sunburst-4k'),
    )!
    expect(
      row.querySelector('select[aria-label="接入方式 gpt-image-2.5-sunburst-4k"]'),
    ).not.toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

test('拉取模型：带后缀的生成型号预选对应型号，改选生成型号后移到该类别页签', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const state = { stored: relayConfig() }
  relayApi(store, state, {
    source: 'models',
    models: [
      {
        id: 'gpt-image-2.5-sunburst-4k',
        output: 'image',
        kind: 'openai_images',
        known: false,
        base: 'gpt-image-2.5-sunburst',
      },
      { id: 'banana-pro', output: 'chat', known: false },
    ],
  })
  await reloadConfig()
  await store.reloadModelCatalog()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host as unknown as HTMLElement)
  try {
    fire(
      Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find(
        (b) => b.textContent === 'apii',
      )!,
      'click',
    )
    fire(host.querySelector<HTMLButtonElement>('.pull-open')!, 'click')
    expect(await until(() => !!document.querySelector('.pull-dialog .pull-row'))).toBe(true)
    const dialog = document.querySelector<HTMLElement>('.pull-dialog')!
    const tabs = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>('.lib-tab'))
    expect(tabs().map((b) => b.textContent)).toEqual(['对话 1', '图像 1'])
    const select = (id: string) =>
      dialog.querySelector<HTMLSelectElement>(`select[aria-label="对应型号 ${id}"]`)!
    // 对应型号的可选项：对话模型库在前，生成目录在后。
    expect(Array.from(select('banana-pro').options, (o) => o.value)).toEqual([
      '',
      'deepseek-flash',
      'gpt-image-2.5-sunburst',
    ])
    select('banana-pro').value = 'gpt-image-2.5-sunburst'
    select('banana-pro').dispatchEvent(new Event('change', { bubbles: true }))
    // 对话页签已空，显示图像页签。
    expect(tabs().map((b) => [b.textContent, b.classList.contains('active')])).toEqual([
      ['图像 2', true],
    ])
    expect(select('gpt-image-2.5-sunburst-4k').value).toBe('gpt-image-2.5-sunburst')
    for (const row of dialog.querySelectorAll<HTMLElement>('.pull-row')) {
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }
    fire(
      Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === '添加',
      )!,
      'click',
    )
    expect(
      await until(() => !configBusy() && !!state.stored.providers.apii?.media?.['banana-pro']),
    ).toBe(true)
    expect(state.stored.providers.apii?.media).toEqual({
      'gpt-image-2.5-sunburst-4k': {
        kind: 'openai_images',
        spec: { base: 'gpt-image-2.5-sunburst' },
      },
      'banana-pro': { kind: 'openai_images', spec: { base: 'gpt-image-2.5-sunburst' } },
    })
    expect(state.stored.providers.apii?.models).toEqual({})
    expect(state.stored.catalog).toBeUndefined()
  } finally {
    dispose()
    host.remove()
  }
})

test('模型库按类别分页签；生成类一张表，厂商是一列，参数由行末按钮展开到下一整行', async () => {
  const { render } = await import('solid-js/web')
  const { ModelLibrary } = await import('./ModelLibrary.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => <ModelLibrary vendors={[]} media={[QWEN_IMAGE]} loading={false} error={null} />,
    host as unknown as HTMLElement,
  )
  try {
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.lib-tab'))
    expect(tabs.map((t) => t.textContent)).toEqual(['对话', '图像'])
    fire(tabs[1]!, 'click')
    const table = host.querySelector('.lib-table.media')
    expect(table?.textContent).toContain('qwen-image-3.0')
    expect(table?.textContent).toContain('阿里云')
    expect(table?.textContent).toContain('百炼')
    // 参考图上限跟在它约束的「修改」后面。
    expect(table?.textContent).toContain('生成 / 修改 ≤3')
    const toggle = table?.querySelector<HTMLButtonElement>('.lib-params-toggle')
    expect(toggle?.textContent).toBe('3 项')
    expect(table?.querySelector('.lib-params')).toBeNull()
    fire(toggle!, 'click')
    const row = table?.querySelector<HTMLTableRowElement>('tr.lib-params')
    expect(row?.cells[0]?.colSpan).toBe(5)
    expect(row?.querySelectorAll('li').length).toBe(3)
  } finally {
    dispose()
    host.remove()
  }
})

test.each([
  ['GGseadanco2.5/720', 30, 10, 10, '5–30 秒整数，使用字符串'],
  ['seedance-2.5-yy-720p', 30, 0, 10, '4–30 秒整数，使用字符串'],
  ['TTseadanco2.5-720', 30, 10, 10, '5–30 秒整数，使用字符串'],
  ['TTsedanco2.5-480', 30, 10, 10, '5–30 秒整数，使用字符串'],
] as const)(
  '模型库分别显示各类参考素材上限：%s',
  async (id, maxImages, maxVideos, maxAudios, duration) => {
    const { render } = await import('solid-js/web')
    const { ModelLibrary } = await import('./ModelLibrary.tsx')
    const model: MediaLibraryModel = {
      id,
      label: id,
      vendor: 'hongcheng',
      kind: 'openai_videos',
      kinds: ['openai_videos'],
      output: 'video',
      operations: [
        'text_to_video',
        'reference_to_video',
        ...(maxVideos ? ['video_to_video' as const] : []),
      ],
      maxImages,
      maxVideos,
      maxAudios,
      params: [`seconds：${duration}`],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ModelLibrary vendors={[]} media={[model]} loading={false} error={null} />,
      host,
    )
    try {
      fire(
        Array.from(host.querySelectorAll<HTMLButtonElement>('.lib-tab')).find(
          (t) => t.textContent === '视频',
        )!,
        'click',
      )
      expect(host.querySelector('.lib-table.media')?.textContent).toContain(
        `图≤${maxImages}、音频≤${maxAudios}`,
      )
      if (maxVideos)
        expect(host.querySelector('.lib-table.media')?.textContent).toContain(
          `视频≤${maxVideos}、音频≤${maxAudios}`,
        )
      else expect(host.querySelector('.lib-table.media')?.textContent).not.toContain('视频≤')
    } finally {
      dispose()
      host.remove()
    }
  },
)

test('拉取模型：打开即刷新已添加型号，勾选后写入规格与对应型号，渠道型号的接入方式显示渠道名', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, configBusy, reloadConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')
  const spec = {
    channel: 'mumugofe' as const,
    seconds: [30],
    ratios: ['16:9', '9:16'],
    resolutions: ['720p'],
    sizes: { '720p': [1280, 720] as [number, number] },
    maxImages: 30,
    maxVideos: 0,
    maxAudios: 0,
    price: { per: 'request' as const, amount: 7, currency: 'CNY' as const },
  }
  const result: PullResult = {
    source: 'pricing',
    models: [
      { id: 'deepseek-v4.1-flash', output: 'chat', known: false },
      { id: 'X-SD25-301010', output: 'video', kind: 'openai_videos', known: true, spec },
    ],
  }
  let stored: RedactedConfig = {
    providers: {
      mumu: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://api.mumugofe.com/v1',
        hasApiKey: true,
        models: {},
        media: { 'old-video': { kind: 'openai_videos' } },
      },
    },
  }
  let pulls = 0
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models')
      return {
        providers: [],
        media: [],
        mediaLibrary: [],
        library: [
          {
            id: 'deepseek',
            displayName: 'DeepSeek',
            models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash' }],
          },
        ],
      } as T
    if (path === '/api/models/pull') {
      pulls++
      return result as T
    }
    if (path === '/api/config' && init?.method === 'PUT') {
      stored = (JSON.parse(String(init.body)) as { config: RedactedConfig }).config
      return { ok: true } as T
    }
    if (path === '/api/config')
      return {
        path: 'config.json',
        config: stored,
        version: 'v',
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    throw new Error(`unexpected ${path}`)
  }
  await reloadConfig()
  await store.reloadModelCatalog()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelSettings />, host as unknown as HTMLElement)
  try {
    fire(
      Array.from(host.querySelectorAll<HTMLButtonElement>('.tab-chip')).find(
        (b) => b.textContent === 'mumu',
      )!,
      'click',
    )
    fire(host.querySelector<HTMLButtonElement>('.pull-open')!, 'click')
    expect(await until(() => !!document.querySelector('.pull-dialog .pull-row'))).toBe(true)
    expect(pulls).toBe(1)
    // 计费清单中没有的已添加型号标记已下架，接口页行上显示。
    expect(
      await until(
        () => !configBusy() && !!config()?.providers.mumu?.media?.['old-video']?.delisted,
      ),
    ).toBe(true)
    expect(host.textContent).toContain('已下架')

    const dialog = document.querySelector<HTMLElement>('.pull-dialog')!
    const tabs = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>('.lib-tab'))
    expect(tabs().map((b) => b.textContent)).toEqual(['对话 1', '视频 1'])
    const base = dialog.querySelector<HTMLSelectElement>(
      'select[aria-label="对应型号 deepseek-v4.1-flash"]',
    )!
    // 占位项只在框内显示，展开的列表只有型号，不分组。
    expect(base.value).toBe('')
    expect(Array.from(base.options, (o) => [o.value, o.hidden])).toEqual([
      ['', true],
      ['deepseek-flash', false],
    ])
    expect(base.querySelector('optgroup')).toBeNull()
    base.value = 'deepseek-flash'
    base.dispatchEvent(new Event('change', { bubbles: true }))
    const check = (id: string) =>
      Array.from(dialog.querySelectorAll<HTMLElement>('.pull-row'))
        .find((r) => r.textContent?.includes(id))!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
    check('deepseek-v4.1-flash').checked = true
    check('deepseek-v4.1-flash').dispatchEvent(new Event('change', { bubbles: true }))

    fire(tabs()[1]!, 'click')
    expect(dialog.textContent).toContain('¥7.00/次')
    check('X-SD25-301010').checked = true
    check('X-SD25-301010').dispatchEvent(new Event('change', { bubbles: true }))

    const add = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '添加',
    )!
    fire(add, 'click')
    expect(
      await until(() => !configBusy() && !!config()?.providers.mumu?.media?.['X-SD25-301010']),
    ).toBe(true)
    expect(document.querySelector('.pull-dialog')).toBeNull()
    expect(stored.providers.mumu?.models).toEqual({ 'deepseek-v4.1-flash': {} })
    expect(stored.providers.mumu?.media?.['X-SD25-301010']).toEqual({ kind: 'openai_videos', spec })
    expect(stored.catalog).toEqual({
      'deepseek-v4.1-flash|openai_chat_completions': { base: 'deepseek-flash' },
    })
    expect(stored.active).toEqual({ provider: 'mumu', model: 'deepseek-v4.1-flash' })
    const row = Array.from(host.querySelectorAll<HTMLElement>('.model-row')).find((r) =>
      r.textContent?.includes('X-SD25-301010'),
    )!
    expect(row.textContent).toContain('接入方式 Mumugofe')
    expect(row.querySelector('select')).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})
