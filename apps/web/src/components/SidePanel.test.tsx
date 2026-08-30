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
