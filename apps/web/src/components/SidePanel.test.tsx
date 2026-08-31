/**
 * 文件页根目录行那颗刷新键。
 *
 * 它在「树 + 已打开文件」共用的文件页里，用户点的是整页刷新，不是只重读左边索引。
 * 原始失败形状是：树请求发出去了，右边已经打开的文件仍停在旧正文上，看起来像按钮没反应。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

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
