/**
 * 文件页根目录行的刷新按钮。
 *
 * 该按钮位于文件树与已打开文件共用的文件页中，点击后刷新整页，不只重新读取左侧文件树。
 * 原始失败形状：文件树请求已发出，右侧已打开的文件仍显示旧正文，按钮看起来没有响应。
 * 另覆盖右键菜单与预览切换时的树宽规则；实际尺寸由浏览器复测验证。
 * 覆盖资源管理器菜单的本机目录参数与失败提示。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined
let restoreShell: (() => void) | undefined

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
  restoreShell?.()
  restoreShell = undefined

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

test('右键菜单不改变文件树的伸展规则，只有文件预览参与分栏', async () => {
  const store = await import('../lib/store/index.ts')
  const originalApi = store.client.api
  store.client.api = async <T,>(path: string): Promise<T> => {
    if (path.startsWith('/api/files/tree'))
      return { nodes: [{ name: 'a.bin', path: 'a.bin', kind: 'file', size: 1, mtime: 1 }] } as T
    if (path.startsWith('/api/files/preview'))
      return { path: 'a.bin', kind: 'binary', note: '测试预览', truncated: false } as T
    throw new Error(`未预期请求：${path}`)
  }
  restoreApi = () => {
    store.client.api = originalApi
  }
  store.setWorkspace({ id: 'ws_tree_menu', root: 'C:/work', name: 'work' })
  store.setOpenFile(null)
  store.setSidePanel('files')
  const { render } = await import('solid-js/web')
  const { default: SidePanel } = await import('./SidePanel.tsx')
  const host = document.createElement('div')
  const style = document.createElement('style')
  style.textContent = readFileSync(new URL('../styles/app/panel.css', import.meta.url), 'utf8')
  document.head.append(style)
  document.body.append(host)
  dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
  try {
    await waitFor(
      () => !!host.querySelector('.tree-top .tree-item'),
      () => host.innerHTML,
    )
    const tree = host.querySelector<HTMLElement>('.file-tree-col')!
    expect(window.getComputedStyle(tree).flexGrow).toBe('1')
    for (let i = 0; i < 3; i++) {
      const row = host.querySelector('.tree-top .tree-item')!
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 120,
        }),
      )
      const menu = host.querySelector<HTMLElement>('.tree-menu')!
      expect(menu).not.toBeNull()
      expect(window.getComputedStyle(tree).flexGrow).toBe('1')
      expect(window.getComputedStyle(menu).position).toBe('fixed')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(host.querySelector('.tree-menu')).toBeNull()
      expect(window.getComputedStyle(tree).flexGrow).toBe('1')
    }
    store.setOpenFile('a.bin')
    await waitFor(
      () => !!host.querySelector('.preview'),
      () => host.innerHTML,
    )
    expect(window.getComputedStyle(tree).width).toBe('208px')
    store.setOpenFile(null)
    expect(window.getComputedStyle(tree).flexGrow).toBe('1')
  } finally {
    style.remove()
  }
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 100; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

describe('在资源管理器中显示', () => {
  async function mount(root: string, reveal: (path: string) => Promise<void>) {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    store.client.api = async <T,>(path: string): Promise<T> => {
      if (path.startsWith('/api/files/tree')) {
        return {
          nodes: [
            { name: '根目录.txt', path: '根目录.txt', kind: 'file', size: 1, mtime: 1 },
            {
              name: '素材 文件',
              path: '素材 文件',
              kind: 'dir',
              size: 0,
              mtime: 1,
              children: [
                {
                  name: '视频 1.mp4',
                  path: '素材 文件/视频 1.mp4',
                  kind: 'file',
                  size: 1,
                  mtime: 1,
                },
              ],
            },
          ],
        } as T
      }
      throw new Error(`未预期请求：${path}`)
    }
    restoreApi = () => {
      store.client.api = originalApi
    }
    const g = globalThis as Record<string, unknown>
    const previousShell = g.__TAURI_INTERNALS__
    g.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: { path: string }) => {
        if (cmd !== 'reveal_workspace') throw new Error(`未预期命令：${cmd}`)
        return reveal(args.path)
      },
    }
    restoreShell = () => {
      g.__TAURI_INTERNALS__ = previousShell
    }
    store.setWorkspace({ id: 'ws_reveal', root, name: '项目' })
    store.setSidePanel('files')
    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
    await waitFor(
      () => !!host.querySelector('.tree-top .tree-item'),
      () => host.innerHTML,
    )
    const row = (name: string) => {
      const item = Array.from(
        host.querySelectorAll<HTMLButtonElement>('.tree-top .tree-item'),
      ).find((item) => item.textContent?.includes(name))
      expect(item).toBeDefined()
      return item!
    }
    return {
      host,
      row,
      clickReveal: (name: string) => {
        row(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.tree-menu-item')).find(
          (item) => item.textContent === '在资源管理器中显示',
        )
        expect(button).toBeDefined()
        button!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        button!.click()
      },
    }
  }

  test.each([
    ['C:\\项目 工作', 'C:\\项目 工作\\', 'C:\\项目 工作\\素材 文件'],
    [
      '\\\\server\\share\\项目 工作',
      '\\\\server\\share\\项目 工作\\',
      '\\\\server\\share\\项目 工作\\素材 文件',
    ],
    ['/tmp/项目 工作', '/tmp/项目 工作/', '/tmp/项目 工作/素材 文件'],
  ])('%s：文件打开父目录，目录打开自身', async (root, expectedRoot, expectedDir) => {
    const paths: string[] = []
    const page = await mount(root, async (path) => {
      paths.push(path)
    })
    page.clickReveal('根目录.txt')
    expect(paths).toEqual([expectedRoot])
    expect(page.host.querySelector('.tree-menu')).toBeNull()
    page.clickReveal('素材 文件')
    expect(paths.at(-1)).toBe(expectedDir)
    page.row('素材 文件').click()
    await waitFor(
      () => page.host.textContent?.includes('视频 1.mp4') ?? false,
      () => page.host.innerHTML,
    )
    page.clickReveal('视频 1.mp4')
    expect(paths).toEqual([expectedRoot, expectedDir, expectedDir])
    expect(page.host.querySelector('[role="alert"]')).toBeNull()
  })

  test('桌面命令失败后显示原因，再次操作清除旧错误', async () => {
    let fail = true
    const page = await mount('C:\\项目 工作', async () => {
      if (fail) throw '不是目录：C:\\项目 工作'
    })
    page.clickReveal('根目录.txt')
    await waitFor(
      () => !!page.host.querySelector('[role="alert"]'),
      () => page.host.innerHTML,
    )
    expect(page.host.querySelector('[role="alert"]')?.textContent).toContain(
      '不是目录：C:\\项目 工作',
    )
    expect(page.host.querySelector('.tree-menu')).toBeNull()
    fail = false
    page.clickReveal('根目录.txt')
    expect(page.host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('文件页刷新', () => {
  test('点击一次同时重取文件树与当前预览', async () => {
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

    // 即使磁盘内容没有变化，点击后图标也必须有动画反馈。动画不依赖
    // 请求时长：本机请求可能在浏览器首次绘制之前就已结束。
    expect(refresh?.getAttribute('aria-busy')).toBe('true')
    expect(refresh?.querySelector<SVGElement>('svg')?.style.transform).toBe('rotate(360deg)')

    await waitFor(
      () => treeCalls >= 2 && previewCalls >= 2,
      () => `tree=${treeCalls}, preview=${previewCalls}`,
    )
  })

  test('开始新一轮时不重取未变化的文件，文件实际更新时保留阅读位置', async () => {
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
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
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

    // run.started 清空的是本轮改动摘要，磁盘内容没有变化，不应视为文件刷新。
    store.setState('fileChanges', [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(previewCalls).toBe(1)
    expect(host.querySelector('.cm-scroller')).toBe(scroller)
    expect(scroller.scrollTop).toBe(160)

    // 下一轮再次修改同一个文件时，即使 +x/-y 与上一轮相同也必须重取；正文原位更新，
    // 阅读位置与编辑器 DOM 均保留。
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
  test('目录与文件共用单个主图标位，每层递进 10px', async () => {
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
    expect(dir?.style.paddingLeft).toBe('12px')
    expect(file?.style.paddingLeft).toBe('12px')
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
    expect(childFile?.style.paddingLeft).toBe('22px')
    expect(childFile?.querySelector('.tree-chevron-slot')).toBeNull()
    expect(childFile?.querySelector('.file-type-icon')?.getAttribute('data-file-kind')).toBe(
      'markdown',
    )
    expect(childDir?.style.paddingLeft).toBe('22px')
    expect(childDir?.querySelector('.tree-chevron-slot')).not.toBeNull()
    expect(childDir?.children.length).toBe(2)
    const childTree = host.querySelector<HTMLElement>('.tree:not(.tree-top)')
    expect(childTree?.style.getPropertyValue('--tree-guide-left')).toBe('19px')
    expect(childTree?.classList.contains('tree-terminal')).toBe(false)

    childDir?.click()
    await waitFor(
      () => host.querySelectorAll('.tree:not(.tree-top)').length === 2,
      () => `trees=${host.querySelectorAll('.tree:not(.tree-top)').length}`,
    )
    const grandchildTree = host.querySelectorAll<HTMLElement>('.tree:not(.tree-top)')[1]
    expect(grandchildTree?.style.getPropertyValue('--tree-guide-left')).toBe('29px')
    expect(grandchildTree?.classList.contains('tree-terminal')).toBe(true)
    expect(childDir?.classList.contains('selected')).toBe(true)
    expect(root?.classList.contains('selected')).toBe(false)
  })
})

describe('页签栏横向滚轮', () => {
  async function renderTabs() {
    const store = await import('../lib/store/index.ts')
    // 面板当前页签按项目记录，因此先设置当前项目再切换页签。
    store.setWorkspace({ id: 'ws_tabs_wheel', root: 'C:work', name: 'work' })
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

    // 滚轮事件本身不直接改变滚动位置；随后由唯一的 rAF 循环逐步移动到目标。
    expect(tabs.scrollLeft).toBe(40)
    expect(wheel.defaultPrevented).toBe(true)
    await waitFor(
      () => tabs.scrollLeft === 100,
      () => `scrollLeft=${tabs.scrollLeft}`,
    )
  })

  test('连续同向滚轮累加到同一个目标，不生成多段动画', async () => {
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

  test('没有溢出或已经抵达边界时，不拦截页面滚轮', async () => {
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

  test('触控板原生横向手势不重复叠加位移', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 60,
      deltaY: 5,
    })
    tabs.dispatchEvent(wheel)

    // happy-dom 不执行浏览器的原生滚动；此处验证处理器没有重复叠加位移。
    expect(tabs.scrollLeft).toBe(40)
    expect(wheel.defaultPrevented).toBe(false)
  })

  test('触控板接管时停止尚未完成的鼠标滚轮动画', async () => {
    const tabs = await renderTabs()
    setScrollBox(tabs, { width: 200, content: 500, left: 40 })

    tabs.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }))
    tabs.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 20, deltaY: 5 }),
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    // happy-dom 不执行原生横向滚动；若旧动画未取消，此时 scrollLeft 已向 100 移动。
    expect(tabs.scrollLeft).toBe(40)
  })
})

/**
 * 变更页按轮次分组：最新一轮默认展开、更早的轮次收起；表头是整个会话的合计；清单末尾的哨兵进入视口时加载下一页。
 * happy-dom 没有 IntersectionObserver，此处使用只记录回调的替身，由测试自行触发相交。
 */
describe('变更页按轮次分组', () => {
  // 面板当前页签按项目记录，因此每条用例切换页签之前须先设置项目。
  beforeEach(async () => {
    const store = await import('../lib/store/index.ts')
    store.setWorkspace({ id: 'ws_changes', root: 'C:work', name: 'work' })
  })

  class FakeObserver {
    static instances: FakeObserver[] = []
    observed: Element[] = []
    constructor(readonly callback: IntersectionObserverCallback) {
      FakeObserver.instances.push(this)
    }
    observe(el: Element) {
      this.observed.push(el)
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
    intersect() {
      this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
    }
  }

  const step = (id: string, path: string, additions: number, deletions: number) => ({
    id,
    toolName: 'edit_file',
    args: { path },
    fileChanges: [{ path, changeType: 'modified' as const, additions, deletions }],
    via: null,
  })
  /** 账本分页中的写入与 store 中的 `ChangeStep` 结构相同。 */
  const wireStep = step
  const turn = (userMessageId: string, text: string, steps: unknown[]) => ({
    userMessageId,
    text,
    origin: null,
    createdAt: 1,
    steps,
  })
  const viewWith = (changes: unknown) => ({
    transcript: [],
    history: { loading: null, nextCursor: null, error: null },
    changes: changes as never,
    runUserMessageId: null,
    runStartedAt: null,
    usage: null,
    generatingToolCall: false,
    request: null,
    error: null,
  })

  const mount = async () => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver
    FakeObserver.instances = []
    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
    return host
  }

  test('最新一轮展开、更早的轮次收起；表头是整个会话的合计，不是已加载分页之和', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (p) => {
      throw new Error(`不该有请求：${p}`)
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    store.setState({
      activeConversation: 'cv_changes',
      views: {
        cv_changes: viewWith({
          turns: [
            turn('ms_2', '再改一次', [
              step('st_2', 'a.ts', 2, 0),
              step('st_3', 'a.ts', 1, 1),
              // 子 agent 的写入带来源；外部 CLI 的写入由观察器判定，没有行数
              { ...step('st_5', 'b.ts', 1, 0), via: { name: '写手' } },
              {
                id: 'st_4',
                toolName: 'cli',
                fileChanges: [{ path: 'notes.md', changeType: 'modified' as const }],
                via: { name: 'codex' },
              },
              // 同一轮中先新建后修改：行上显示净效果「新建」
              {
                id: 'st_6',
                toolName: 'run_command',
                args: { command: 'python shoot.py' },
                fileChanges: [{ path: 'shots/a.png', changeType: 'created' as const }],
                via: { name: '写手' },
              },
              {
                id: 'st_7',
                toolName: 'run_command',
                args: { command: 'python shoot.py' },
                fileChanges: [{ path: 'shots/a.png', changeType: 'modified' as const }],
                via: { name: '写手' },
              },
            ]),
            turn('ms_1', '先改 a 和 b', [step('st_1', 'a.ts', 3, 1), step('st_0', 'b.ts', 5, 0)]),
          ],
          totals: { paths: ['a.ts', 'b.ts', 'c.ts'], additions: 20, deletions: 4 },
          nextCursor: null,
          loading: null,
          error: null,
        }),
      },
    })
    store.setSidePanel('changes')
    const host = await mount()

    await waitFor(
      () => host.querySelectorAll('.change-turn').length === 2,
      () => host.innerHTML,
    )
    expect(host.querySelector('.change-head')?.textContent).toBe('变更 3 个文件+20−4')
    const turns = [...host.querySelectorAll<HTMLButtonElement>('.change-turn')]
    expect(turns.map((t) => t.querySelector('.truncate')?.textContent)).toEqual([
      '再改一次',
      '先改 a 和 b',
    ])
    expect(turns.map((t) => t.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    // 最新一轮中同一个文件修改了两次：显示为一行、「2 次」；该轮合计只累加已知的行数
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.change-files .change-row')]
    expect(rows.map((r) => r.querySelector('.truncate')?.textContent)).toEqual([
      'a.ts',
      'b.ts',
      'notes.md',
      'shots/a.png',
    ])
    expect(rows[0]?.querySelector('.change-times')?.textContent).toBe('2 次')
    expect(turns[0]?.querySelector('.change-delta')?.textContent).toBe('+4−1')
    // 没有行数的行显示变更类型，不显示 +0 −0
    expect(rows[2]?.querySelector('.change-delta')).toBeNull()
    expect(rows[2]?.querySelector('.change-kind')?.textContent).toBe('已修改')
    expect(rows[3]?.querySelector('.change-times')?.textContent).toBe('2 次')
    expect(rows[3]?.querySelector('.change-kind')?.textContent).toBe('新建')
    // 展开：逐次的来源标签
    rows[1]?.click()
    rows[2]?.click()
    await waitFor(
      () => host.querySelectorAll('.edit-head').length === 2,
      () => host.innerHTML,
    )
    expect(
      [...host.querySelectorAll('.edit-head')].map((e) => e.textContent?.replace(/\s+/g, '')),
    ).toEqual(['#1写手·编辑+1−0', '#1codex·CLI已修改'])

    turns[1]?.click()
    await waitFor(
      () => host.querySelectorAll('.change-files .change-row').length === 6,
      () => host.innerHTML,
    )
  })

  test('同一轮中新建后又删除的文件不显示，修改后再删除的显示已删除', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (p) => {
      throw new Error(`不该有请求：${p}`)
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    const ran = (id: string, command: string, changes: unknown[]) => ({
      id,
      toolName: 'run_command',
      args: { command },
      fileChanges: changes,
      via: null,
    })
    store.setState({
      activeConversation: 'cv_changes',
      views: {
        cv_changes: viewWith({
          turns: [
            turn('ms_2', '跑一轮脚本', [
              ran('st_1', 'python snap.py', [
                { path: 'cache/profile/a.bin', changeType: 'created' as const },
                { path: 'notes.md', changeType: 'modified' as const, additions: 2, deletions: 1 },
              ]),
              ran('st_2', 'rm -rf cache notes.md', [
                { path: 'cache/profile/a.bin', changeType: 'deleted' as const },
                { path: 'notes.md', changeType: 'deleted' as const },
              ]),
            ]),
            // 该轮的写入在折叠后全部丢弃：不显示节标题。
            turn('ms_1', '建了又删', [
              ran('st_0', 'python warm.py', [
                { path: 'cache/profile/b.bin', changeType: 'created' as const },
              ]),
              ran('st_00', 'rm -rf cache', [
                { path: 'cache/profile/b.bin', changeType: 'deleted' as const },
              ]),
            ]),
          ],
          // 服务端以同一个 `foldFileChanges` 折叠后返回：新建后又删除的路径不在其中。
          totals: { paths: ['notes.md'], additions: 2, deletions: 1 },
          nextCursor: null,
          loading: null,
          error: null,
        }),
      },
    })
    store.setSidePanel('changes')
    const host = await mount()

    await waitFor(
      () => host.querySelectorAll('.change-row').length === 1,
      () => host.innerHTML,
    )
    expect(host.querySelectorAll('.change-turn')).toHaveLength(1)
    const row = host.querySelector<HTMLButtonElement>('.change-files .change-row')
    expect(row?.querySelector('.truncate')?.textContent).toBe('notes.md')
    expect(row?.querySelector('.change-kind')?.textContent).toBe('已删除')
    // 表头与行使用同一份数据：新建后又删除的文件既不在行中，也不计入表头。
    expect(host.querySelector('.change-head')?.textContent).toBe('变更 1 个文件+2−1')
    expect(host.innerHTML).not.toContain('cache/profile')
  })

  test('清单末尾的哨兵进入视口时获取更早的轮次，追加到末尾', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    const requested: string[] = []
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (p) => {
      requested.push(p)
      return {
        turns: [turn('ms_0', '最早那次', [wireStep('st_x', 'z.ts', 1, 0)])],
        totals: { paths: ['a.ts', 'z.ts'], additions: 3, deletions: 0 },
        nextCursor: null,
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    store.setState({
      activeConversation: 'cv_changes',
      views: {
        cv_changes: viewWith({
          turns: [turn('ms_1', '后来', [step('st_1', 'a.ts', 2, 0)])],
          totals: { paths: ['a.ts', 'z.ts'], additions: 3, deletions: 0 },
          nextCursor: 'ms_1',
          loading: null,
          error: null,
        }),
      },
    })
    store.setSidePanel('changes')
    const host = await mount()
    await waitFor(
      () => host.querySelectorAll('.change-turn').length === 1,
      () => host.innerHTML,
    )
    const observer = FakeObserver.instances.at(-1)
    expect(observer?.observed[0]?.classList.contains('change-more')).toBe(true)
    observer?.intersect()
    await waitFor(
      () => host.querySelectorAll('.change-turn').length === 2,
      () => `requested=${requested.join(',')} html=${host.innerHTML}`,
    )
    expect(requested).toHaveLength(1)
    expect(requested[0]).toContain('/api/conversations/cv_changes/changes?')
    expect(requested[0]).toContain('before=ms_1')
    const turns = [...host.querySelectorAll<HTMLButtonElement>('.change-turn')]
    expect(turns.map((t) => t.querySelector('.truncate')?.textContent)).toEqual([
      '后来',
      '最早那次',
    ])
    expect(turns.map((t) => t.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    expect(turns[1]?.querySelector('.change-count')?.textContent).toBe('1 个文件')
  })

  test('首页加载失败有终态：显示错误与重试按钮', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    let calls = 0
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async () => {
      calls += 1
      if (calls === 1) throw new Error('网络断开')
      return {
        turns: [turn('ms_1', '后来', [wireStep('st_1', 'a.ts', 2, 0)])],
        totals: { paths: ['a.ts'], additions: 2, deletions: 0 },
        nextCursor: null,
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    store.setState({
      activeConversation: 'cv_changes',
      views: { cv_changes: viewWith(null) },
    })
    store.setSidePanel('changes')
    const host = await mount()
    await waitFor(
      () =>
        host
          .querySelector('[role="alert"]')
          ?.textContent?.includes('历史记录加载失败：网络断开') === true,
      () => host.innerHTML,
    )
    host.querySelector<HTMLButtonElement>('.change-more .ghost-btn')?.click()
    await waitFor(
      () => host.querySelectorAll('.change-turn').length === 1,
      () => `calls=${calls} html=${host.innerHTML}`,
    )
    expect(calls).toBe(2)
  })
})

/**
 * 新开预览看板上各行对应的页面类型。
 *
 * 内置浏览器由桌面外壳的宿主承载，其他端无法承载：即使服务端报告宿主已连接，
 * 也不在这些端提供内置浏览器入口，否则点击后必然无法显示网页（B5）。
 *
 * 「网页预览」一行**按端提供，不按宿主是否连接提供**：它是其他端实际具备的能力，
 * 不是内置浏览器的备用路线。
 */
describe('看板按当前端实际具备的能力列出各行', () => {
  test('非桌面外壳时提供网页预览，服务端报告宿主已连接也不提供内置浏览器', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async () => ({
      nodes: [],
    })
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    store.setState('capabilities', {
      sandbox: { backend: 'none', active: false, reason: '' },
      environment: [],
      mode: 'auto',
      browser: {
        connected: true,
        runtimeSupported: true,
      },
    })
    store.setWorkspace({ id: 'ws_board', root: 'C:work', name: 'work' })
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    host.querySelector<HTMLButtonElement>('[aria-label="新开预览"]')?.click()
    await waitFor(
      () => host.querySelectorAll('.board-item').length > 0,
      () => host.innerHTML,
    )
    const labels = [...host.querySelectorAll('.board-label')].map((el) => el.textContent)
    expect(labels).toContain('网页预览')
    expect(labels).not.toContain('浏览器')
    // 终端同理：PTY 在外壳的 Rust 侧，网页端没有。
    expect(labels).not.toContain('终端')
  })
})

describe('文件预览的切换与 PDF', () => {
  /**
   * 原始失败形状：点击另一个文件后正文仍显示上一个文件，直到新文件的预览取回；
   * 加载较慢的文件看起来像点击没有响应。
   */
  test('切换文件后立即显示新文件的加载态，不保留上一个文件的正文', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    let releaseB: (() => void) | undefined
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (path.startsWith('/api/files/tree')) return { nodes: [] }
      if (!path.startsWith('/api/files/preview')) throw new Error(`没有桩这条：${path}`)
      const file = decodeURIComponent(path.split('path=')[1] ?? '')
      if (file === 'b.md') {
        await new Promise<void>((resolve) => {
          releaseB = resolve
        })
      }
      return {
        path: file,
        kind: 'text',
        mime: 'text/markdown',
        size: 1,
        mtime: 1,
        content: file === 'a.md' ? '甲文件正文' : '乙文件正文',
        truncated: false,
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }

    store.setWorkspace({ id: 'ws_switch', root: 'C:\\work', name: 'work' })
    store.setOpenFile('a.md')
    store.setSidePanel('files')

    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SidePanel />, host as unknown as HTMLElement)

    await waitFor(
      () => host.querySelector('.cm-content')?.textContent?.includes('甲文件正文') === true,
      () => host.innerHTML.slice(0, 400),
    )

    store.setOpenFile('b.md')
    await waitFor(
      () => releaseB !== undefined,
      () => 'b.md 的预览没有发出',
    )
    expect(host.querySelector('.preview-head')?.textContent).toContain('b.md')
    expect(host.querySelector('.preview .preview-loading')).not.toBeNull()
    expect(host.textContent).not.toContain('甲文件正文')

    releaseB?.()
    await waitFor(
      () => host.querySelector('.cm-content')?.textContent?.includes('乙文件正文') === true,
      () => host.innerHTML.slice(0, 400),
    )
  })

  /**
   * PDF 的字节单独获取后交给 iframe。会话中写入其他文件会使预览重取一次，
   * 源文件未变化（修改时间相同）时不重取字节，阅读器不重新加载。
   */
  test('PDF 按修改时间获取字节，写入其他文件时不重新加载', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    const originalRaw = store.client.raw
    let mtime = 1
    const rawCalls: string[] = []
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (!path.startsWith('/api/files/preview')) throw new Error(`没有桩这条：${path}`)
      return {
        path: 'r.pdf',
        kind: 'pdf',
        mime: 'application/pdf',
        size: 9,
        mtime,
        truncated: false,
      }
    }
    ;(store.client as unknown as { raw: (path: string) => Promise<Response> }).raw = async (
      path: string,
    ) => {
      rawCalls.push(path)
      return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } })
    }
    // happy-dom 的 iframe 无法加载 `blob:` 地址，会在后台报错；因此替换为它能加载的空白页。
    const { createObjectURL, revokeObjectURL } = URL
    URL.createObjectURL = () => 'about:blank'
    URL.revokeObjectURL = () => {}
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
      ;(store.client as unknown as { raw: typeof originalRaw }).raw = originalRaw
      URL.createObjectURL = createObjectURL
      URL.revokeObjectURL = revokeObjectURL
    }

    const { render } = await import('solid-js/web')
    const { default: FileView } = await import('./FileView.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(
      () => <FileView path="r.pdf" refresh={store.state.fileVersion} />,
      host as unknown as HTMLElement,
    )

    await waitFor(
      () => host.querySelector('iframe.preview-frame') !== null,
      () => `raw=${rawCalls.join(',')} html=${host.innerHTML.slice(0, 300)}`,
    )
    expect(rawCalls).toEqual([`/api/files/raw?path=${encodeURIComponent('r.pdf')}`])

    store.setState('fileVersion', 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rawCalls).toHaveLength(1)

    mtime = 2
    store.setState('fileVersion', 2)
    await waitFor(
      () => rawCalls.length === 2,
      () => `raw=${rawCalls.join(',')}`,
    )
  })

  /**
   * 图片与音视频使用直链：元素自行按 Range 请求，视频边播放边加载、支持拖动进度，内存占用不随文件大小增长。
   * 令牌放在查询串中（元素无法携带请求头），修改时间写入地址，文件修改后地址随之变化。
   */
  test('图片与视频的 src 是带令牌的直链，地址包含修改时间，不整份获取字节', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    const originalRaw = store.client.raw
    const rawCalls: string[] = []
    let mtime = 1
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      const file = decodeURIComponent(path.split('path=')[1] ?? '')
      const video = file.endsWith('.mp4')
      return {
        path: file,
        kind: video ? 'video' : 'image',
        mime: video ? 'video/mp4' : 'image/png',
        size: 20 * 1024 * 1024,
        mtime,
        truncated: false,
      }
    }
    ;(store.client as unknown as { raw: (path: string) => Promise<Response> }).raw = async (
      path: string,
    ) => {
      rawCalls.push(path)
      return new Response('bytes')
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
      ;(store.client as unknown as { raw: typeof originalRaw }).raw = originalRaw
    }

    const { createSignal } = await import('solid-js')
    const { render } = await import('solid-js/web')
    const { default: FileView } = await import('./FileView.tsx')
    const [path, setPath] = createSignal('generated/a.png')
    const [refresh, setRefresh] = createSignal(0)
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(
      () => <FileView path={path()} refresh={refresh()} />,
      host as unknown as HTMLElement,
    )

    const src = (selector: string) => host.querySelector(selector)?.getAttribute('src') ?? ''
    await waitFor(
      () => src('img.preview-media').includes(`path=${encodeURIComponent('generated/a.png')}`),
      () => `html=${host.innerHTML.slice(0, 300)}`,
    )
    expect(src('img.preview-media')).toContain('/api/files/raw?')
    expect(src('img.preview-media')).toContain('&v=1')
    expect(src('img.preview-media')).toContain('token=')

    mtime = 2
    setRefresh(1)
    await waitFor(
      () => src('img.preview-media').includes('&v=2'),
      () => `html=${host.innerHTML.slice(0, 300)}`,
    )

    setPath('generated/b.mp4')
    await waitFor(
      () => src('video.preview-media').includes(encodeURIComponent('generated/b.mp4')),
      () => `html=${host.innerHTML.slice(0, 300)}`,
    )
    expect(rawCalls).toEqual([])
  })
})
