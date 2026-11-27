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

/**
 * 原始失败形状：切换项目后重新获取的项目清单是新对象，全部项目行重建，光标下的行先失去悬停底色，
 * 再按过渡重新淡入。
 */
test('重新获取项目清单后项目行不重建，名称变化与移除照常显示', async () => {
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
  let lists = [
    [
      { id: 'ws_a', rootPath: 'C:/work/a', name: 'a', lastOpenedAt: 1, conversations: 1 },
      { id: 'ws_b', rootPath: 'C:/work/b', name: 'b', lastOpenedAt: 1, conversations: 1 },
      { id: 'ws_c', rootPath: 'C:/work/c', name: 'c', lastOpenedAt: 1, conversations: 1 },
    ],
    [
      { id: 'ws_a', rootPath: 'C:/work/a', name: 'a', lastOpenedAt: 2, conversations: 1 },
      { id: 'ws_b', rootPath: 'C:/work/b', name: 'b2', lastOpenedAt: 1, conversations: 1 },
    ],
  ]
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
    if (path === '/api/workspaces') {
      const [next, ...rest] = lists
      lists = rest.length ? rest : lists
      return { workspaces: next }
    }
    throw new Error(`意外请求：${path}`)
  }
  store.setWorkspace({ id: 'ws_a', root: 'C:/work/a', name: 'a' })
  store.setState({
    connection: 'ready',
    conversations: [{ id: 'cv_a', title: '会话', updatedAt: Date.now() } as never],
    activeConversation: 'cv_a',
    busyConversations: [],
  })

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <Sidebar />, host as unknown as HTMLElement)
  const names = () => [...host.querySelectorAll('.project-name')].map((el) => el.textContent)
  try {
    for (let i = 0; i < 100 && names().length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(names()).toEqual(['a', 'b', 'c'])
    const [rowA, rowB] = host.querySelectorAll('.project-head')

    // 连接恢复时重新获取清单。
    store.setState('connection', 'connecting')
    store.setState('connection', 'ready')
    for (let i = 0; i < 100 && names().length !== 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(names()).toEqual(['a', 'b2'])
    const rows = host.querySelectorAll('.project-head')
    expect(rows[0]).toBe(rowA!)
    expect(rows[1]).toBe(rowB!)
  } finally {
    dispose()
    host.remove()
    ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    store.setWorkspace(previousWorkspace)
    store.setState(previous)
  }
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
