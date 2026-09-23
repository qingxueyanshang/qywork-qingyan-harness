import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // 组件模块可能已在其他测试的 document 上初始化。
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('当前项目行可以收起并重新展开会话，不切换当前会话', async () => {
  const store = await import('../lib/store/index.ts')
  const { render } = await import('solid-js/web')
  const { Sidebar } = await import('./Sidebar.tsx')
  const originalApi = store.client.api
  const previousWorkspace = store.workspace()
  const previous = {
    connection: store.state.connection,
    conversations: store.state.conversations,
    activeConversation: store.state.activeConversation,
    busyConversations: store.state.busyConversations,
  }
  const root = 'C:/work/ces1'
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
    if (path === '/api/workspaces') {
      return {
        workspaces: [
          { id: 'ws_ces1', rootPath: root, name: 'ces1', lastOpenedAt: 1, conversations: 1 },
        ],
      }
    }
    throw new Error(`意外请求：${path}`)
  }
  store.setWorkspace({ id: 'ws_ces1', root, name: 'ces1' })
  store.setState({
    connection: 'ready',
    conversations: [{ id: 'cv_ces1', title: '飞鸟骑行', updatedAt: Date.now() } as never],
    activeConversation: 'cv_ces1',
    busyConversations: [],
  })

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <Sidebar />, host as unknown as HTMLElement)
  try {
    for (let i = 0; i < 100 && !host.querySelector('.project-open'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const button = host.querySelector<HTMLButtonElement>('.project-open')
    expect(button).not.toBeNull()
    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.conv-row')?.textContent).toContain('飞鸟骑行')

    button?.click()
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.conv-row')).toBeNull()
    expect(store.state.activeConversation).toBe('cv_ces1')

    button?.click()
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.conv-row')?.textContent).toContain('飞鸟骑行')
  } finally {
    dispose()
    host.remove()
    ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    store.setWorkspace(previousWorkspace)
    store.setState(previous)
  }
})
