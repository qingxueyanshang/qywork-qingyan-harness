/**
 * 设置页里的生成模型：接口页添加、默认、删除，以及模型库的类别页签。
 *
 * 覆盖范围：`ModelSettings.tsx` 的 `addModel` 分流、生成模型行、`removeMediaModel` 与 `withMediaDefaults`；
 * `ModelLibrary.tsx` 的类别页签与 `MediaTable`。
 *
 * 判据取共享的 `config()`，每个操作之后立即断言：写入先同步改这一份再排队发 PUT。
 * **不要改成等待**：`configStore` 的写入队列是模块级的一份，整套测试跑在同一个进程里时，
 * 别的测试文件留下的写入稍后回来会把这一份整个换掉。PUT 的报文形状由 `configStore.test.ts`
 * 与服务端接口测试锁（理由同 `ModulesSettings.test.tsx`）。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MediaLibraryModel } from '../../lib/store/index.ts'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

/** 回车走真实派发：输入框的处理函数读 `currentTarget`，只有经委托派发时它才被填上。 */
function fire(el: HTMLElement, type: 'click' | 'keydown', init: KeyboardEventInit = {}) {
  if (type === 'keydown') {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    return
  }
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (el as unknown as { $$click?: (e: Event) => void }).$$click
  if (delegated) delegated.call(el, event)
  else el.dispatchEvent(event)
}

const QWEN_IMAGE: MediaLibraryModel = {
  id: 'qwen-image-3.0',
  label: '千问图像 3.0',
  vendor: '阿里云',
  kind: 'dashscope_images',
  output: 'image',
  operations: ['generate', 'edit'],
  maxImages: 3,
  maxVideos: 0,
  params: ['size：字符串；宽*高', 'n：整数 1–6；一次生成几张；默认 1', 'seed：整数 0–2147483647'],
}

test('目录里的图像模型挂成生成模型：协议按地址定、首个成为默认、没有检测、删掉后默认一并清掉', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, reloadConfig, replaceConfig } = await import('./configStore.ts')
  const { ModelSettings } = await import('./ModelSettings.tsx')

  let stored: Record<string, unknown> = {
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
      stored = (JSON.parse(String(init.body)) as { config: Record<string, unknown> }).config
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

  /*
   * 整套测试里 `loadServerConfig` 可能被别的文件的模块替身接管，读回来的不一定是上面那份。
   * 所以测试用的接口用一次乐观更新加进当前那一份；此后到最后一条断言之间不让出执行权，
   * 队列里的写入回来之前断言已经做完。
   */
  void replaceConfig((cur) => {
    const { mediaDefaults: _drop, ...rest } = cur
    return {
      ...rest,
      providers: {
        ...cur.providers,
        qwen: {
          kind: 'openai_chat_completions',
          baseUrl: 'https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          hasApiKey: true,
          models: {},
        },
      },
    }
  })

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

    // 目录外的 id 照旧当对话模型。
    input().value = 'some-chat-model'
    fire(input(), 'keydown', { key: 'Enter' })
    expect(qwen()?.models['some-chat-model']).toEqual({})
    expect(Object.keys(qwen()?.media ?? {})).toEqual(['qwen-image-3.0'])

    fire(row()!.querySelector<HTMLButtonElement>('.icon-btn')!, 'click')
    expect(qwen()?.media).toEqual({})
    // 那一类删空了：默认一并删掉，否则保存会被服务端以「默认指向已删模型」挡回。
    expect(config()?.mediaDefaults).toBeUndefined()
  } finally {
    dispose()
    host.remove()
  }
})

test('模型库按类别分页签；生成类一张表，厂商是一列，参数表收在行末', async () => {
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
    expect(table?.textContent).toContain('生成 / 修改')
    expect(table?.textContent).toContain('图 3')
    expect(table?.querySelector('summary')?.textContent).toBe('3 项')
  } finally {
    dispose()
    host.remove()
  }
})
