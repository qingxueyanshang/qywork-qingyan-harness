/**
 * 覆盖 `App.tsx` 挂在根上的两个委托：`openLink`（正文里的链接落到右侧面板的浏览器页）
 * 与 `copyCode`（代码块右上角的复制按钮）。两者的触发元素全部由 markdown 渲染产出，
 * 根上这一处是它们唯一的落点。
 *
 * DOM 在这里装、用完卸掉，理由同 `components/RunStatus.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** 挂一个和 `.app` 同形状的容器，往里贴一条渲染好的链接，点它。 */
async function clickLink(html: string) {
  const { openLink } = await import('./App.tsx')
  const root = document.createElement('div')
  root.innerHTML = html
  root.addEventListener('click', openLink as (e: Event) => void)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  root.querySelector('a')?.dispatchEvent(event)
  return event
}

describe('正文里的链接', () => {
  test('落到右侧面板的浏览器页，并挡下默认跳转', async () => {
    const store = await import('./lib/store/index.ts')
    store.closeAllPanelTabs()
    const event = await clickLink('<a href="http://localhost:8000">http://localhost:8000</a>')
    expect(event.defaultPrevented).toBe(true)
    const [tab] = store.panelTabs()
    expect(tab?.kind).toBe('browser')
    expect(tab?.url).toBe('http://localhost:8000')
    store.closeAllPanelTabs()
  })

  test('http(s) 之外的 scheme 不接管 —— 浏览器页只加载得了 http(s)', async () => {
    const store = await import('./lib/store/index.ts')
    store.closeAllPanelTabs()
    const event = await clickLink('<a href="mailto:a@b.com">a@b.com</a>')
    expect(event.defaultPrevented).toBe(false)
    expect(store.panelTabs().length).toBe(0)
  })
})

describe('代码块的复制按钮', () => {
  /** 拿一份真的渲染结果，点它右上角的按钮。 */
  async function clickCopy(md: string) {
    const { copyCode } = await import('./App.tsx')
    const { renderMarkdown } = await import('./lib/markdown.ts')
    let written: string | null = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => {
          written = t
          return Promise.resolve()
        },
      },
    })
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown(md)
    root.addEventListener('click', copyCode as (e: Event) => void)
    const btn = root.querySelector('.code-copy')
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    return { written: written as string | null, btn }
  }

  test('复制的是代码正文 —— 高亮把它切成了一串 span', async () => {
    const { written } = await clickCopy('```js\nconst a = 1\n```')
    expect(written).toBe('const a = 1')
  })

  test('复制成功后按钮进回执态', async () => {
    const { btn } = await clickCopy('```js\nconst a = 1\n```')
    expect(btn?.classList.contains('done')).toBe(true)
  })

  test('点代码正文不会触发复制', async () => {
    const { copyCode } = await import('./App.tsx')
    const { renderMarkdown } = await import('./lib/markdown.ts')
    let called = false
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => {
          called = true
          return Promise.resolve()
        },
      },
    })
    const root = document.createElement('div')
    root.innerHTML = renderMarkdown('```js\nconst a = 1\n```')
    root.addEventListener('click', copyCode as (e: Event) => void)
    root.querySelector('code')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    expect(called).toBe(false)
  })
})

describe('连接恢复', () => {
  test('先恢复项目，再按该项目重建活动会话', async () => {
    const store = await import('./lib/store/index.ts')
    const { restoreWorkspaceSession } = await import('./App.tsx')
    const originalApi = store.client.api
    const calls: string[] = []
    const workspaceAtConversationLoads: (string | null)[] = []

    ;(
      store.client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      calls.push(path)
      if (path.startsWith('/api/workspace')) {
        return {
          id: 'ws_restore',
          root: 'C:\\work',
          rootPath: 'C:\\work',
          name: 'work',
          pendingTrust: [],
        }
      }
      if (path.startsWith('/api/conversations/cv_restore/history')) {
        return { messages: [], runs: [], steps: [], todos: [], nextCursor: null }
      }
      if (path.startsWith('/api/conversations/cv_restore/context')) return { context: null }
      if (path.startsWith('/api/conversations/cv_restore/goal')) return { goal: null }
      if (path.startsWith('/api/conversations/cv_restore/queue')) return { queue: [] }
      if (path.startsWith('/api/conversations')) {
        workspaceAtConversationLoads.push(store.workspace()?.id ?? null)
        return {
          conversations: [
            {
              id: 'cv_restore',
              title: '绘画会话',
              provider: 'openai',
              model: 'gpt-5',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }
      }
      throw new Error(`没有桩这条：${path}`)
    }

    store.setWorkspace(null)
    store.setState({ activeConversation: null, conversations: [], views: {} })
    try {
      await restoreWorkspaceSession()
      expect(store.workspace()?.id).toBe('ws_restore')
      expect(store.state.activeConversation).toBe('cv_restore')
      expect(calls[0]).toBe('/api/workspace')
      expect(workspaceAtConversationLoads).toEqual(['ws_restore'])
    } finally {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
      store.setWorkspace(null)
      store.setState({ activeConversation: null, conversations: [], views: {} })
    }
  })
})
