/**
 * 覆盖 `App.tsx` 挂在根上的两个委托：`openLink`（正文里的链接落到右侧面板）
 * 与 `copyCode`（代码块右上角的复制按钮）。两者的触发元素全部由 markdown 渲染产出，
 * 根上这一处是它们唯一的落点。
 *
 * 普通客户端验证网页预览；桌面端用原生命令桩验证文件地址、工作区归属与页签选择。
 * 真实 WebView2 的加载与布局需另做桌面验收。
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
  /** 页签按项目分账，所以这一组要先有一个当前项目；用完把页都关掉还回去。 */
  async function freshWorkspace() {
    const store = await import('./lib/store/index.ts')
    store.setWorkspace({ id: 'ws_link', root: 'C:/ws', name: 'ws' })
    for (const t of store.panelTabs()) store.closePanelTab(t.id)
    return store
  }

  test('落到右侧面板的网页预览页，并挡下默认跳转', async () => {
    const store = await freshWorkspace()
    const event = await clickLink('<a href="http://localhost:8000">http://localhost:8000</a>')
    expect(event.defaultPrevented).toBe(true)
    const [tab] = store.panelTabs()
    expect(tab?.kind).toBe('preview')
    expect(tab?.url).toBe('http://localhost:8000')
    for (const t of store.panelTabs()) store.closePanelTab(t.id)
    store.setWorkspace(null)
  })

  test('邮件协议不进入网页预览', async () => {
    const store = await freshWorkspace()
    const event = await clickLink('<a href="mailto:a@b.com">a@b.com</a>')
    expect(event.defaultPrevented).toBe(false)
    expect(store.panelTabs().length).toBe(0)
    store.setWorkspace(null)
  })

  test('点击真实 Markdown 本地 HTML 链接，在当前工作区的内置浏览器中打开', async () => {
    const store = await freshWorkspace()
    const { renderMarkdown } = await import('./lib/markdown.ts')
    const g = globalThis as Record<string, unknown>
    const previousTauri = g.__TAURI_INTERNALS__
    const previousCapabilities = store.state.capabilities
    const opened: { url: string; workspaceId: string }[] = []
    let hostTabs: Record<string, unknown>[] = []
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { url: string; workspaceId: string }) => {
        if (cmd === 'browser_open') {
          opened.push(args)
          const tab = {
            tabId: `bt_link_${opened.length}`,
            url: args.url,
            title: '预览',
            workspaceId: args.workspaceId,
            createdSeq: opened.length,
          }
          hostTabs = [...hostTabs, tab]
          return tab
        }
        if (cmd === 'browser_tabs') return hostTabs
      },
    }
    store.setState('capabilities', { browser: { connected: true } } as NonNullable<
      typeof previousCapabilities
    >)
    try {
      for (const href of [
        'flying-bird.html',
        './flying-bird.html',
        'file:///C:/ws/flying-bird.html',
        'C:/ws/flying-bird.html',
      ]) {
        const event = await clickLink(
          renderMarkdown(`已创建 [flying-bird.html](${href})，双击即可打开。`),
        )
        await new Promise((r) => setTimeout(r, 0))
        expect(event.defaultPrevented).toBe(true)
        expect(opened.at(-1)).toEqual({
          url: 'file:///C:/ws/flying-bird.html',
          workspaceId: 'ws_link',
        })
        expect(store.activePanelTab()).toBe(`bt_link_${opened.length}`)
        expect(store.panelTabs().at(-1)?.kind).toBe('browser')
      }
      expect(opened).toHaveLength(4)
    } finally {
      for (const t of store.panelTabs()) store.closePanelTab(t.id)
      store.setWorkspace(null)
      store.setState('capabilities', previousCapabilities)
      g.__TAURI_INTERNALS__ = previousTauri
    }
  })

  test('没有原生浏览器的客户端明确提示本地预览不可用，并阻止默认跳转', async () => {
    const store = await freshWorkspace()
    const { renderMarkdown } = await import('./lib/markdown.ts')
    const event = await clickLink(renderMarkdown('[预览](flying-bird.html)'))
    expect(event.defaultPrevented).toBe(true)
    expect(store.panelTabs()).toHaveLength(0)
    expect(store.state.notice?.message).toBe('本地网页预览需要桌面端。')
    store.setState('notice', null)
    store.setWorkspace(null)
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
