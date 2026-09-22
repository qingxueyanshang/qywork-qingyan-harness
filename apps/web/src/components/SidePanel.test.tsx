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
    // 面板翻开在哪一页按项目记，先站到一个项目上再翻页。
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

/**
 * 变更页按轮：最新一轮默认展开、更早的收起；表头是整会话合计；清单末尾的哨兵进视口就翻页。
 * happy-dom 没有 IntersectionObserver，这里用一个只记回调的替身，由测试自己触发相交。
 */
describe('变更页按轮', () => {
  // 面板翻开在哪一页按项目记，所以项目要在每条用例翻页之前就位。
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
  /** 账本页里的写入与 store 里的 `ChangeStep` 同一形状。 */
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

  test('最新一轮展开、更早的收起；表头是整会话合计，不是已加载几页的和', async () => {
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
              // 子 agent 的写入带来源；外部 CLI 的写入由观察器判出，没有行数
              { ...step('st_5', 'b.ts', 1, 0), via: { name: '写手' } },
              {
                id: 'st_4',
                toolName: 'cli',
                fileChanges: [{ path: 'notes.md', changeType: 'modified' as const }],
                via: { name: 'codex' },
              },
              // 同一轮里先建后改：行上是净效果「新建」
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
    // 最新一轮里同一个文件改了两次：一行、「2 次」；这一轮的合计只加已知的行数
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.change-files .change-row')]
    expect(rows.map((r) => r.querySelector('.truncate')?.textContent)).toEqual([
      'a.ts',
      'b.ts',
      'notes.md',
      'shots/a.png',
    ])
    expect(rows[0]?.querySelector('.change-times')?.textContent).toBe('2 次')
    expect(turns[0]?.querySelector('.change-delta')?.textContent).toBe('+4−1')
    // 没有行数的行印变更类型，不画 +0 −0
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

  test('这一轮里建了又删的不出现，改过再删的显示已删除', async () => {
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
            // 这一轮的写入全被折叠丢掉：节头都不出。
            turn('ms_1', '建了又删', [
              ran('st_0', 'python warm.py', [
                { path: 'cache/profile/b.bin', changeType: 'created' as const },
              ]),
              ran('st_00', 'rm -rf cache', [
                { path: 'cache/profile/b.bin', changeType: 'deleted' as const },
              ]),
            ]),
          ],
          // 服务端按同一个 `foldFileChanges` 折过再给的：建了又删的两个路径不在里面。
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
    // 表头与行同一份账：建了又删的那两个文件既不在行上，也不在表头的数里。
    expect(host.querySelector('.change-head')?.textContent).toBe('变更 1 个文件+2−1')
    expect(host.innerHTML).not.toContain('cache/profile')
  })

  test('清单末尾的哨兵进视口就取更早的轮，接在末尾', async () => {
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

  test('首页失败有终态：报错加重试', async () => {
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
 * 新开预览看板上那一行是哪一种页。
 *
 * 内置浏览器是 Windows 桌面外壳里的原生子视图，别的端摆不下它——服务端报宿主连着
 * 也不能给这一端一个内置浏览器的入口，那是一个点了必然摆不出网页的按钮（B5）。
 *
 * 反过来，「网页预览」那一行**按端给，不按宿主连没连上给**：它是别的端真实的能力，
 * 不是内置浏览器的备用路线。
 */
describe('看板按这一端真有的能力列行', () => {
  test('不是桌面外壳时给网页预览，服务端报宿主连着也不给内置浏览器', async () => {
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
