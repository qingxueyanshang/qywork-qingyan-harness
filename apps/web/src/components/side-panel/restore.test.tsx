/**
 * 应用重启后恢复的页签在首次显示时才加载。
 *
 * 覆盖范围：`SidePanel.tsx` 的 `TabPanes`（可多开的页在首次成为当前页时挂载）、`BrowserPanel.tsx` 的 `RestoredPage`，
 * 以及它们经由 `lib/store/ui.ts` 与 `lib/store/browser.ts` 恢复与加载浏览器页的部分。
 *
 * 原始失败形状：恢复 N 个画布页时启动即读取 N 个文件；恢复的浏览器页在显示之前已新建页面，或显示后正文为空白。
 *
 * localStorage 中预先写入上次运行的面板记录，sessionStorage 为空：首次导入 store 即为应用启动。
 * 每条用例使用记录中的一个工作区。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const tab = (id: string, kind: string, title: string, extra: Record<string, unknown>) => ({
  id,
  kind,
  title,
  createdSeq: 1,
  ...extra,
})

const SAVED = {
  ws_restore_canvas: {
    tabs: [
      tab('canvas-a.canvas.json', 'canvas', 'a', { path: 'a.canvas.json' }),
      tab('canvas-b.canvas.json', 'canvas', 'b', { path: 'b.canvas.json' }),
    ],
    page: { tab: 'canvas-a.canvas.json' },
  },
  ws_restore_browser: {
    tabs: [
      tab('canvas-c.canvas.json', 'canvas', 'c', { path: 'c.canvas.json' }),
      tab('bt_7', 'browser', '甲', { url: 'http://a.test/', live: true }),
    ],
    page: { tab: 'canvas-c.canvas.json' },
  },
  ws_restore_fail: {
    tabs: [tab('bt_7', 'browser', '甲', { url: 'http://a.test/', live: true })],
    page: { tab: 'bt_7' },
  },
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  localStorage.setItem('qywork.panel.tabs', JSON.stringify(SAVED))
  const { delegateEvents, DelegatedEvents } = await import('solid-js/web')
  delegateEvents([...DelegatedEvents])
})
afterAll(async () => GlobalRegistrator.unregister())

const g = globalThis as Record<string, unknown>
let dispose: (() => void) | undefined
const restore: (() => void)[] = []
afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  for (const reset of restore.splice(0).reverse()) reset()
  const store = await import('../../lib/store/index.ts')
  store.setWorkspace(null)
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面未在时限内更新：${detail()}`)
}

/** 记录全部接口请求；画布读取一律失败，用例只断言请求了哪些画布。 */
async function stubApi(): Promise<string[]> {
  const store = await import('../../lib/store/index.ts')
  const requested: string[] = []
  const original = store.client.api
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
    requested.push(path)
    throw new Error('测试中不读取')
  }
  restore.push(() => {
    store.client.api = original
  })
  return requested
}

/** 模拟桌面外壳与已连接的嵌入式宿主。`reply` 返回 `undefined` 时使用默认响应。 */
async function asShell(
  invokes: { cmd: string; args: Record<string, unknown> | undefined }[],
  reply: (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown> | undefined,
): Promise<void> {
  const store = await import('../../lib/store/index.ts')
  const previous = g.__TAURI_INTERNALS__
  const capabilities = store.state.capabilities
  g.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' } },
    invoke: (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      return reply(cmd, args) ?? Promise.resolve(undefined)
    },
    transformCallback: () => 1,
  }
  store.setState('capabilities', {
    sandbox: { backend: 'none', active: false, reason: '' },
    browser: { connected: true, runtimeSupported: true, presentation: 'embedded' },
  } as never)
  restore.push(() => {
    g.__TAURI_INTERNALS__ = previous
    store.setState('capabilities', capabilities)
  })
}

async function mount(wsId: string): Promise<HTMLElement> {
  const store = await import('../../lib/store/index.ts')
  store.setWorkspace({ id: wsId, root: 'C:/r', name: 'r' })
  const { render } = await import('solid-js/web')
  const { default: SidePanel } = await import('../SidePanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
  return host
}

function clickTab(host: HTMLElement, title: string): void {
  const names = [...host.querySelectorAll<HTMLButtonElement>('.side-tab .tab-name')]
  names.find((b) => b.textContent === title)!.click()
}

const canvasReads = (requested: string[]) =>
  requested.filter((p) => p.startsWith('/api/canvas?')).map((p) => decodeURIComponent(p))

test('恢复的画布页在首次显示之前不挂载、不读取文件，显示后保持挂载', async () => {
  const requested = await stubApi()
  const host = await mount('ws_restore_canvas')
  await waitFor(
    () => canvasReads(requested).length > 0,
    () => host.innerHTML,
  )
  expect(host.querySelectorAll('.tab-pane')).toHaveLength(1)
  expect(canvasReads(requested)).toEqual(['/api/canvas?path=a.canvas.json'])

  clickTab(host, 'b')
  await waitFor(
    () => canvasReads(requested).includes('/api/canvas?path=b.canvas.json'),
    () => JSON.stringify(requested),
  )
  expect(host.querySelectorAll('.tab-pane')).toHaveLength(2)

  clickTab(host, 'a')
  expect(host.querySelectorAll('.tab-pane')).toHaveLength(2)
  expect(host.querySelector('.tab-pane.active')).toBe(host.querySelectorAll('.tab-pane')[0]!)
})

test('恢复的浏览器页在显示时按记录的地址新建页面，原位换为宿主的页并显示地址栏', async () => {
  await stubApi()
  const invokes: { cmd: string; args: Record<string, unknown> | undefined }[] = []
  const opened = {
    tabId: 'bt_1',
    url: 'http://a.test/',
    title: '甲',
    workspaceId: 'ws_restore_browser',
    createdSeq: 1,
    zoom: 1,
    canGoBack: false,
    canGoForward: false,
    openerTabId: null,
    hidden: false,
  }
  await asShell(invokes, (cmd) => {
    if (cmd === 'browser_open') return Promise.resolve(opened)
    if (cmd === 'browser_tabs') return Promise.resolve([opened])
    return undefined
  })
  const host = await mount('ws_restore_browser')
  const store = await import('../../lib/store/index.ts')
  const restored = store.panelTabs()[1]!
  expect(restored).toMatchObject({ kind: 'browser', live: false, url: 'http://a.test/' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)

  clickTab(host, '甲')
  await waitFor(
    () => host.querySelector('.web-bar') !== null,
    () => `${host.innerHTML} ${JSON.stringify(invokes)}`,
  )
  expect(invokes.filter((i) => i.cmd === 'browser_open').map((i) => i.args)).toEqual([
    { workspaceId: 'ws_restore_browser', url: 'http://a.test/' },
  ])
  expect(store.panelTabs().map((t) => t.id)).toEqual(['canvas-c.canvas.json', 'bt_1'])
  expect(store.sidePanel()).toEqual({ tab: 'bt_1' })
  expect(host.querySelector<HTMLInputElement>('.web-url')?.value).toBe('http://a.test/')
})

test('恢复的浏览器页新建失败时显示原因，页签保留', async () => {
  await stubApi()
  await asShell([], (cmd) =>
    cmd === 'browser_open' ? Promise.reject('只能打开 HTTP、HTTPS 或本地文件') : undefined,
  )
  const host = await mount('ws_restore_fail')
  await waitFor(
    () => host.querySelector('.web-error') !== null,
    () => host.innerHTML,
  )
  expect(host.querySelector('.web-error')?.textContent).toBe(
    '无法打开页面：只能打开 HTTP、HTTPS 或本地文件',
  )
  const store = await import('../../lib/store/index.ts')
  expect(store.panelTabs()).toMatchObject([{ kind: 'browser', title: '甲', live: false }])
})
