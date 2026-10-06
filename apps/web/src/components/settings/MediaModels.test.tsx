/**
 * 设置页里的生成模型：接口页添加、默认、删除，以及模型库的类别页签。
 *
 * 覆盖范围：`ModelSettings.tsx` 的 `addModel` 分流、生成模型行、`removeMediaModel` 与 `withMediaDefaults`；
 * `ModelLibrary.tsx` 的类别页签、未知单价显示与 `MediaTable`。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { MEDIA_KIND_OUTPUT, type MediaKind } from '@qywork/core'
import type { MediaLibraryModel, RedactedConfig } from '../../lib/store/index.ts'

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
  label: '千问图像 3.0',
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

test('官方及自定义地址添加 Google 与 xAI 均使用目录协议，模型库显示对应页签', async () => {
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
      if (model.kind === 'xai_videos' && model.baseUrl === 'https://relay.example/v1') {
        stored = structuredClone(stored)
        stored.providers.native!.media![model.id] = { kind: 'openai_videos' }
        await reloadConfig()
        const access = host.querySelector<HTMLSelectElement>(
          `select[aria-label="接入方式 ${model.id}"]`,
        )!
        expect(access.value).toBe('openai_videos')
        expect(Array.from(access.options, (option) => option.value)).toEqual([
          'openai_videos',
          'xai_videos',
        ])
        access.value = 'xai_videos'
        access.dispatchEvent(new Event('change', { bubbles: true }))
        expect(await until(() => !configBusy())).toBe(true)
        expect(stored.providers.native!.media![model.id]!.kind).toBe('xai_videos')
        expect(stored.providers.native!.kind).toBe('openai_chat_completions')
      }
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
