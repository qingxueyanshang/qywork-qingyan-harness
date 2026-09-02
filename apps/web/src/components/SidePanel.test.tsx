/**
 * 文件页根目录行那颗刷新键。
 *
 * 它在「树 + 已打开文件」共用的文件页里，用户点的是整页刷新，不是只重读左边索引。
 * 原始失败形状是：树请求发出去了，右边已经打开的文件仍停在旧正文上，看起来像按钮没反应。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

beforeEach(async () => {
  const store = await import('../lib/store/index.ts')
  store.setState({ connection: 'ready', fileVersion: 0 })
})

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  restoreApi?.()
  restoreApi = undefined

  const store = await import('../lib/store/index.ts')
  store.setOpenFile(null)
  store.setSidePanel(null)
  store.setWorkspace(null)
  store.setState({
    activeConversation: null,
    connection: 'connecting',
    fileVersion: 0,
    fileChanges: [],
    views: {},
  })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 100; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

describe('文件页刷新', () => {
  test('点一次同时重取文件树与当前预览', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    let treeCalls = 0
    let previewCalls = 0

    ;(
      store.client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      if (path.startsWith('/api/files/tree')) {
        treeCalls += 1
        return {
          nodes: [{ name: 'a.md', path: 'a.md', kind: 'file', size: 1, mtime: treeCalls }],
        }
      }
      if (path.startsWith('/api/files/preview')) {
        previewCalls += 1
        return {
          path: 'a.md',
          kind: 'text',
          mime: 'text/markdown',
          size: 1,
          content: `第 ${previewCalls} 版`,
          truncated: false,
        }
      }
      throw new Error(`没有桩这条：${path}`)
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }

    store.setWorkspace({ id: 'ws_file_refresh', root: 'C:\\work', name: 'work' })
    store.setOpenFile('a.md')
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    await waitFor(
      () => treeCalls >= 1 && previewCalls >= 1,
      () => `tree=${treeCalls}, preview=${previewCalls}`,
    )
    const refresh = host.querySelector<HTMLButtonElement>('.tree-root-acts [aria-label="刷新"]')
    expect(refresh).not.toBeNull()
    refresh?.click()

    // 即使磁盘内容没变，这一下也不能继续表现成一颗静止、无回执的图标。动画不依赖
    // 请求时长——本机请求可能在浏览器第一次绘制之前就已经结束。
    expect(refresh?.getAttribute('aria-busy')).toBe('true')
    expect(refresh?.querySelector<SVGElement>('svg')?.style.transform).toBe('rotate(360deg)')

    await waitFor(
      () => treeCalls >= 2 && previewCalls >= 2,
      () => `tree=${treeCalls}, preview=${previewCalls}`,
    )
  })

  test('开始新一轮不重取未变文件，真实更新保留阅读位置', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    let previewCalls = 0

    ;(
      store.client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      if (!path.startsWith('/api/files/preview')) throw new Error(`没有桩这条：${path}`)
      previewCalls += 1
      return {
        path: 'long.txt',
        kind: 'text',
        mime: 'text/plain',
        size: 100,
        content: previewCalls === 1 ? '第一版\n'.repeat(80) : '第二版\n'.repeat(80),
        truncated: false,
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }

    store.setState({
      activeConversation: 'cv_file_scroll',
      views: {
        cv_file_scroll: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          todos: [],
          transcript: [],
        },
      },
      fileChanges: [{ path: 'long.txt', additions: 4, deletions: 1, changeType: 'modified' }],
    })

    const { render } = await import('solid-js/web')
    const { default: FileView } = await import('./FileView.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(
      () => <FileView path="long.txt" refresh={store.state.fileVersion} />,
      host as unknown as HTMLElement,
    )

    await waitFor(
      () => previewCalls === 1 && host.querySelector('.cm-scroller') !== null,
      () => `preview=${previewCalls}, editor=${host.querySelector('.cm-scroller') !== null}`,
    )
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!
    scroller.scrollTop = 160

    // run.started 清的是「本轮改动摘要」，磁盘没有因此变化，不能把它当成文件刷新。
    store.setState('fileChanges', [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(previewCalls).toBe(1)
    expect(host.querySelector('.cm-scroller')).toBe(scroller)
    expect(scroller.scrollTop).toBe(160)

    // 下一轮真的又改了同一个文件，即使 +x/-y 与上一轮相同也必须重取；正文原位更新，
    // 阅读位置与编辑器 DOM 都保留。
    store.applyEvent({
      seq: 1,
      at: Date.now(),
      conversationId: 'cv_file_scroll',
      event: {
        type: 'file.changed',
        runId: 'rn_file_scroll',
        changes: [{ path: 'long.txt', additions: 4, deletions: 1, changeType: 'modified' }],
      },
    } as never)
    await waitFor(
      () =>
        previewCalls === 2 &&
        host.querySelector('.cm-content')?.textContent?.includes('第二版') === true,
      () =>
        `preview=${previewCalls}, text=${host.querySelector('.cm-content')?.textContent?.slice(0, 12)}`,
    )
    expect(host.querySelector('.cm-scroller')).toBe(scroller)
    expect(scroller.scrollTop).toBe(160)
  })

  test('连接恢复后自动重取文件树，不保留失败时的空快照', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    let treeCalls = 0

    ;(
      store.client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      if (!path.startsWith('/api/files/tree')) throw new Error(`没有桩这条：${path}`)
      treeCalls += 1
      return {
        nodes: [
          {
            name: treeCalls === 1 ? 'before.txt' : 'after.png',
            path: treeCalls === 1 ? 'before.txt' : 'after.png',
            kind: 'file',
            size: 1,
            mtime: treeCalls,
          },
        ],
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }

    store.setWorkspace({ id: 'ws_reconnect_tree', root: 'C:\\work', name: 'work' })
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    await waitFor(
      () => treeCalls === 1 && host.textContent?.includes('before.txt') === true,
      () => `tree=${treeCalls}, text=${host.textContent}`,
    )
    store.setState('connection', 'reconnecting')
    await Promise.resolve()
    store.setState('connection', 'ready')

    await waitFor(
      () => treeCalls === 2 && host.textContent?.includes('after.png') === true,
      () => `tree=${treeCalls}, text=${host.textContent}`,
    )
  })
})

describe('文件树层级', () => {
  test('目录与文件共用单主图标位，每层只递进 6px', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(
      store.client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      if (path.startsWith('/api/files/tree')) {
        return {
          nodes: [
            {
              name: '目录',
              path: '目录',
              kind: 'dir',
              size: 0,
              mtime: 1,
              children: [
                {
                  name: '子文件.md',
                  path: '目录/子文件.md',
                  kind: 'file',
                  size: 1,
                  mtime: 1,
                },
                {
                  name: '子目录',
                  path: '目录/子目录',
                  kind: 'dir',
                  size: 0,
                  mtime: 1,
                  children: [],
                },
              ],
            },
            { name: '同层文件.md', path: '同层文件.md', kind: 'file', size: 1, mtime: 1 },
          ],
        }
      }
      throw new Error(`没有桩这条：${path}`)
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }

    store.setWorkspace({ id: 'ws_tree_indent', root: 'C:\\work', name: 'work' })
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    await waitFor(
      () => host.querySelectorAll('.tree-top > li > .tree-item').length === 2,
      () => `rows=${host.querySelectorAll('.tree-top > li > .tree-item').length}`,
    )
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.tree-top > li > .tree-item'))
    const root = host.querySelector<HTMLElement>('.tree-root')
    const dir = rows.find((row) => row.textContent?.includes('目录'))
    const file = rows.find((row) => row.textContent?.includes('同层文件.md'))
    expect(dir?.style.paddingLeft).toBe('8px')
    expect(file?.style.paddingLeft).toBe('8px')
    expect(dir?.querySelector('.tree-chevron-slot')).not.toBeNull()
    expect(file?.querySelector('.tree-chevron-slot')).toBeNull()
    expect(dir?.children.length).toBe(2)
    expect(file?.children.length).toBe(2)
    expect(file?.querySelector('.file-type-icon')?.getAttribute('data-file-kind')).toBe('markdown')
    expect(root?.classList.contains('selected')).toBe(false)

    dir?.click()
    await waitFor(
      () => host.textContent?.includes('子文件.md') ?? false,
      () => host.textContent ?? '',
    )
    const childFile = Array.from(host.querySelectorAll<HTMLButtonElement>('.tree-item')).find(
      (row) => row.textContent?.includes('子文件.md'),
    )
    const childDir = Array.from(host.querySelectorAll<HTMLButtonElement>('.tree-item')).find(
      (row) => row.textContent?.includes('子目录'),
    )
    expect(childFile?.style.paddingLeft).toBe('14px')
    expect(childFile?.querySelector('.tree-chevron-slot')).toBeNull()
    expect(childFile?.querySelector('.file-type-icon')?.getAttribute('data-file-kind')).toBe(
      'markdown',
    )
    expect(childDir?.style.paddingLeft).toBe('14px')
    expect(childDir?.querySelector('.tree-chevron-slot')).not.toBeNull()
    expect(childDir?.children.length).toBe(2)
    const childTree = host.querySelector<HTMLElement>('.tree:not(.tree-top)')
    expect(childTree?.style.getPropertyValue('--tree-guide-left')).toBe('14px')
    expect(childTree?.classList.contains('tree-terminal')).toBe(false)

    childDir?.click()
    await waitFor(
      () => host.querySelectorAll('.tree:not(.tree-top)').length === 2,
      () => `trees=${host.querySelectorAll('.tree:not(.tree-top)').length}`,
    )
    const grandchildTree = host.querySelectorAll<HTMLElement>('.tree:not(.tree-top)')[1]
    expect(grandchildTree?.style.getPropertyValue('--tree-guide-left')).toBe('20px')
    expect(grandchildTree?.classList.contains('tree-terminal')).toBe(true)
    expect(childDir?.classList.contains('selected')).toBe(true)
    expect(root?.classList.contains('selected')).toBe(false)
  })
})

describe('页签栏横向滚轮', () => {
  async function renderTabs() {
    const store = await import('../lib/store/index.ts')
    store.setSidePanel('todos')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    const tabs = host.querySelector<HTMLDivElement>('.side-tabs')
    if (!tabs) throw new Error('没有渲染页签栏')
    return tabs
  }

  function setScrollBox(
    tabs: HTMLDivElement,
    opts: { width: number; content: number; left: number },
  ) {
    Object.defineProperties(tabs, {
      clientWidth: { configurable: true, value: opts.width },
      scrollWidth: { configurable: true, value: opts.content },
      scrollLeft: { configurable: true, value: opts.left, writable: true },
    })
  }

  test('宽度不足时，普通鼠标的纵向滚轮平滑移动到横向目标', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 })
    tabs.dispatchEvent(wheel)

    // 滚轮事件本身不再让标签瞬移；唯一的 rAF 循环随后追到目标。
    expect(tabs.scrollLeft).toBe(40)
    expect(wheel.defaultPrevented).toBe(true)
    await waitFor(
      () => tabs.scrollLeft === 100,
      () => `scrollLeft=${tabs.scrollLeft}`,
    )
  })

  test('连续同向滚轮累加到同一个目标，不排成多段动画', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    tabs.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 }))
    tabs.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 }))

    expect(tabs.scrollLeft).toBe(40)
    await waitFor(
      () => tabs.scrollLeft === 100,
      () => `scrollLeft=${tabs.scrollLeft}`,
    )
  })

  test('没有溢出或已经抵达边界时，不吞掉页面滚轮', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 200, left: 0 })

    const noOverflow = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 60,
    })
    tabs.dispatchEvent(noOverflow)
    expect(tabs.scrollLeft).toBe(0)
    expect(noOverflow.defaultPrevented).toBe(false)

    setScrollBox(tabs, { width: 200, content: 500, left: 300 })
    const atEnd = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 })
    tabs.dispatchEvent(atEnd)
    expect(tabs.scrollLeft).toBe(300)
    expect(atEnd.defaultPrevented).toBe(false)
  })

  test('触控板原生横向手势不再手动叠加一次', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 60,
      deltaY: 5,
    })
    tabs.dispatchEvent(wheel)

    // happy-dom 不执行浏览器的原生滚动；这里锁的是处理器没有再加一遍。
    expect(tabs.scrollLeft).toBe(40)
    expect(wheel.defaultPrevented).toBe(false)
  })

  test('触控板接管时停止尚未走完的鼠标滚轮动画', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    tabs.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }))
    tabs.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 20, deltaY: 5 }),
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    // happy-dom 不执行原生横向滚动；旧动画若没被取消，这里已经向 100 移动了。
    expect(tabs.scrollLeft).toBe(40)
  })
})
