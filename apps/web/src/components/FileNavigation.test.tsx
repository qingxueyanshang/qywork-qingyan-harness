/** 覆盖真实 Markdown 点击到画布/文件预览、树定位与重复打开。 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents, DelegatedEvents } = await import('solid-js/web')
  delegateEvents([...DelegatedEvents])
})
afterAll(async () => GlobalRegistrator.unregister())

let dispose: (() => void) | undefined
const restore: (() => void)[] = []
afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  for (const reset of restore.splice(0).reverse()) reset()
  const store = await import('../lib/store/index.ts')
  store.setFileRevealRequest(null)
  for (const tab of store.panelTabs()) store.closePanelTab(tab.id)
  store.setOpenFile(null)
  store.setSidePanel(null)
  store.setWorkspace(null)
  store.setState({ connection: 'connecting', fileVersion: 0 })
  const { flushSession } = await import('../lib/session.ts')
  flushSession()
  sessionStorage.clear()
})

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面未更新：${document.body.innerHTML}`)
}

async function setup() {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws_file_navigation', root: 'C:/项目 空格', name: '项目' })
  store.setState({ connection: 'ready', fileVersion: 0 })
  store.setFileRevealRequest(null)
  const originalApi = store.client.api
  const requests: string[] = []
  const node = (path: string, kind: 'file' | 'dir') => ({
    path,
    kind,
    name: path.split('/').pop(),
    size: 4,
    mtime: 1,
  })
  store.client.api = async <T,>(path: string): Promise<T> => {
    requests.push(path)
    const url = new URL(path, 'http://localhost')
    if (url.pathname === '/api/files/tree') {
      const dir = url.searchParams.get('path') ?? ''
      const nodes =
        dir === ''
          ? [node('output', 'dir'), node('other', 'dir')]
          : dir === 'output'
            ? [node('output/final', 'dir')]
            : dir === 'output/final'
              ? [
                  node('output/final/成品.pptx', 'file'),
                  node('output/final/分镜.canvas.json', 'file'),
                ]
              : []
      return { nodes } as T
    }
    if (url.pathname === '/api/files/preview') {
      return {
        path: url.searchParams.get('path'),
        kind: 'binary',
        size: 4,
        mtime: 1,
        truncated: false,
      } as T
    }
    if (url.pathname === '/api/files/find') return { matches: [], truncated: false } as T
    throw new Error(`未预期请求：${path}`)
  }
  restore.push(() => {
    store.client.api = originalApi
  })
  const host = document.createElement('div')
  document.body.append(host)
  const { openLink } = await import('../App.tsx')
  host.addEventListener('click', openLink)
  const { renderMarkdown } = await import('../lib/markdown.ts')
  const click = (href: string) => {
    const message = document.createElement('div')
    message.innerHTML = renderMarkdown(`[打开](<${href}>)`)
    host.append(message)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    message.querySelector('a')!.dispatchEvent(event)
    message.remove()
    expect(event.defaultPrevented).toBe(true)
  }
  const mount = async () => {
    const { render } = await import('solid-js/web')
    const { default: SidePanel } = await import('./SidePanel.tsx')
    const panel = document.createElement('div')
    host.append(panel)
    dispose = render(() => <SidePanel />, panel)
  }
  return { store, host, click, mount, requests }
}

test('点击深层文件链接会展开、选中并滚动到文件；重复点击能恢复定位', async () => {
  const page = await setup()
  const scrolled: string[] = []
  const originalScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.dataset.path ?? '')
  }
  restore.push(() => {
    HTMLElement.prototype.scrollIntoView = originalScroll
  })
  page.click('C:/项目%20空格/output/final/成品.pptx')
  await page.mount()
  const selected = () => page.host.querySelector<HTMLElement>('.tree-item.selected')
  await waitFor(() => selected()?.dataset.path === 'output/final/成品.pptx')
  expect(scrolled).toContain('output/final/成品.pptx')
  await waitFor(() => !!page.host.querySelector('.preview-head'))
  expect(page.host.querySelector('.preview-head')!.textContent).toContain('output/final/成品.pptx')
  page.host.querySelector<HTMLButtonElement>('[data-path="output"]')!.click()
  expect(selected()?.dataset.path).toBe('output')
  expect(page.store.openFile()).toBe('output/final/成品.pptx')
  const search = page.host.querySelector<HTMLInputElement>('.tree-search')!
  search.value = '不存在'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  page.click('output/./final/成品.pptx')
  await waitFor(() => selected()?.dataset.path === 'output/final/成品.pptx')
  expect(search.value).toBe('')
  expect(selected()?.getAttribute('aria-current')).toBe('true')
  expect(page.host.querySelectorAll('.tree-item.selected')).toHaveLength(1)
})

test('画布链接进入画布页并复用页签，返回文件页后选中该画布', async () => {
  const page = await setup()
  const original = globalThis.matchMedia
  globalThis.matchMedia = ((query: string) => ({
    matches: query === '(pointer: fine)',
  })) as typeof matchMedia
  restore.push(() => {
    globalThis.matchMedia = original
  })
  page.store.setOpenFile('output/final/成品.pptx')
  page.click('output/final/分镜.canvas.json')
  page.click('file:///C:/项目%20空格/output/final/分镜.canvas.json')
  expect(page.store.panelTabs()).toHaveLength(1)
  expect(page.store.panelTabs()[0]?.kind).toBe('canvas')
  expect(page.store.activePanelTab()).toBe('canvas-output/final/分镜.canvas.json')
  expect(page.store.openFile()).toBeNull()
  expect(page.requests.some((path) => path.includes('/api/files/preview'))).toBe(false)
  page.store.closePanelTab(page.store.panelTabs()[0]!.id)
  page.store.openPanel('files')
  await page.mount()
  await waitFor(
    () =>
      page.host.querySelector<HTMLElement>('.tree-item.selected')?.dataset.path ===
      'output/final/分镜.canvas.json',
  )
  page.host.querySelector<HTMLButtonElement>('[data-path="output/final/分镜.canvas.json"]')!.click()
  expect(page.store.activePanelTab()).toBe('canvas-output/final/分镜.canvas.json')
  await waitFor(() => page.host.querySelector('.canvas-stage') !== null)
})

test('无鼠标端的画布文件保留文本入口', async () => {
  const page = await setup()
  const original = globalThis.matchMedia
  globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia
  restore.push(() => {
    globalThis.matchMedia = original
  })
  page.click('output/final/分镜.canvas.json')
  expect(page.store.sidePanel()).toBe('files')
  expect(page.store.openFile()).toBe('output/final/分镜.canvas.json')
  expect(page.store.panelTabs()).toHaveLength(0)
})
