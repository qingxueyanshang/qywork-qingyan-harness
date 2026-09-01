/**
 * 思考选择器的产品边界：不支持时没有入口；支持时只有正向档位，且能恢复未选择。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  const store = await import('../lib/store/index.ts')
  store.setState({ activeConversation: null, conversations: [], busyConversations: [], views: {} })
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) delegated.call(button, event)
  else button.dispatchEvent(event)
}

test('不支持时隐藏；支持时可恢复未选择且从不出现 none', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../lib/store/index.ts')
  const { ModelPicker } = await import('./ModelPicker.tsx')
  const originalApi = store.client.api
  let saved: Record<string, unknown> | null = null
  const catalog = {
    active: { provider: 'p', model: 'plain' },
    library: [],
    providers: [
      {
        name: 'p',
        models: [
          {
            id: 'plain',
            label: 'plain',
            effortLevels: [],
            effort: null,
            currency: 'USD',
            vision: null,
            video: false,
            known: true,
          },
          {
            id: 'reasoning',
            label: 'reasoning',
            effortLevels: ['low', 'high'],
            effort: 'high',
            currency: 'USD',
            vision: null,
            video: false,
            known: true,
          },
        ],
      },
    ],
  }
  const config = {
    active: { provider: 'p', model: 'reasoning' },
    providers: {
      p: {
        kind: 'openai_chat_completions',
        hasApiKey: true,
        models: { plain: {}, reasoning: { effort: 'high' } },
      },
    },
  }

  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models') return catalog as T
    if (path === '/api/config' && init?.method === 'PUT') {
      saved = JSON.parse(String(init.body)) as Record<string, unknown>
      catalog.providers[0]!.models[1]!.effort = null
      return { ok: true } as T
    }
    if (path === '/api/config') {
      return {
        path: 'config.json',
        config,
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    }
    throw new Error(`unexpected ${path}`)
  }

  store.setState({
    activeConversation: 'cv',
    conversations: [{ id: 'cv', provider: 'p', model: 'plain' } as never],
    busyConversations: [],
    views: {},
  })
  await store.reloadModelCatalog()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModelPicker />, host as unknown as HTMLElement)
  try {
    click(host.querySelector('.mode-chip') as HTMLButtonElement)
    expect(host.textContent).not.toContain('推理等级')
    expect(host.textContent).not.toContain('不支持')

    store.setState('conversations', 0, 'model', 'reasoning')
    expect(host.textContent).toContain('推理等级')
    const effortEntry = Array.from(host.querySelectorAll<HTMLButtonElement>('.model-entry')).find(
      (button) => button.textContent?.includes('推理等级'),
    )!
    click(effortEntry)
    expect(host.textContent).toContain('未选择（模型默认）')
    expect(host.textContent).not.toContain('none')

    const reset = Array.from(host.querySelectorAll<HTMLButtonElement>('.model-item')).find(
      (button) => button.textContent?.includes('未选择（模型默认）'),
    )!
    click(reset)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saved).not.toBeNull()
    const body = saved as unknown as { config: typeof config }
    expect(body.config.providers.p.models.reasoning).not.toHaveProperty('effort')
  } finally {
    dispose()
    store.client.api = originalApi
    host.remove()
  }
})
