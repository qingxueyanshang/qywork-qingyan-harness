/**
 * 切换项目时右侧面板按项目重新挂载，上一个项目中已显示的页随之卸载。
 *
 * 覆盖范围：`SidePanel.tsx` 的 `TabPanes`（页正文取得页签记录的方式）、`BrowserPanel.tsx` 的 `EmbeddedView`
 * （卸载时收起子视图），经由 `lib/store/actions.ts` 的 `activateWorkspace` 切换项目。
 *
 * 原始失败形状：当前页是嵌入面板的内置浏览器页时切换到另一个项目，切换以
 * 「Cannot read properties of undefined (reading 'id')」失败，切换请求没有发出，侧栏显示该报错；
 * 各类页都显示过之后切换项目，界面抛出未捕获的「Stale read from <Show>」，此后打开弹窗时网页不再移出可视区。
 *
 * localStorage 中预先写入上次运行的面板记录，首次导入 store 即为桌面外壳中的应用启动：
 * 记录中的浏览器页改为恢复的页，显示时由宿主新建页面。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const g = globalThis as Record<string, unknown>
const FROM = { id: 'ws_switch_from', root: 'C:/from', name: 'from' }
const TO = { id: 'ws_switch_to', rootPath: 'C:/to', name: 'to' }
const browserTab = (id: string, url: string) => ({
  id,
  kind: 'browser',
  title: id,
  url,
  live: true,
  createdSeq: 1,
})
const SAVED = {
  ws_many_a: {
    tabs: [
      browserTab('bt_1', 'http://a.test/'),
      { id: 'preview-1', kind: 'preview', title: 'p', url: 'about:blank', createdSeq: 2 },
      {
        id: 'canvas-a.canvas.json',
        kind: 'canvas',
        title: 'a',
        path: 'a.canvas.json',
        createdSeq: 3,
      },
      { id: 'file-a.md', kind: 'file', title: 'a.md', path: 'a.md', createdSeq: 4 },
      { id: 'conversation-cv_sub', kind: 'conversation', title: 's', createdSeq: 5 },
    ],
    page: { tab: 'bt_1' },
  },
  ws_many_b: {
    tabs: [
      browserTab('bt_2', 'http://b.test/'),
      {
        id: 'canvas-b.canvas.json',
        kind: 'canvas',
        title: 'b',
        path: 'b.canvas.json',
        createdSeq: 6,
      },
      { id: 'preview-2', kind: 'preview', title: 'q', url: 'about:blank', createdSeq: 7 },
    ],
    page: 'runs',
  },
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  localStorage.setItem('qywork.panel.tabs', JSON.stringify(SAVED))
  g.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' } },
    invoke: async () => [],
    transformCallback: () => 0,
  }
  await import('../../lib/store/index.ts')
})
afterAll(async () => {
  delete g.__TAURI_INTERNALS__
  await GlobalRegistrator.unregister()
})

type Invoke = { cmd: string; args: Record<string, unknown> | undefined }

/** 模拟桌面外壳与已连接的嵌入式宿主：`browser_open` 新建宿主页，`browser_tabs` 返回宿主清单。 */
async function asShell(invokes: Invoke[]) {
  const store = await import('../../lib/store/index.ts')
  const hostTabs: Record<string, unknown>[] = []
  g.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' } },
    invoke: async (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      if (cmd === 'browser_open') {
        const tabId = `bt_${100 + hostTabs.length}`
        const tab = {
          tabId,
          url: args?.url,
          title: tabId,
          workspaceId: args?.workspaceId,
          createdSeq: 100 + hostTabs.length,
          zoom: 1,
          canGoBack: false,
          canGoForward: false,
          openerTabId: null,
          hidden: false,
        }
        hostTabs.push(tab)
        return tab
      }
      if (cmd === 'browser_tabs') return [...hostTabs]
      return undefined
    },
    transformCallback: () => 1,
  }
  store.setState('capabilities', {
    sandbox: { backend: 'none', active: false, reason: '' },
    browser: { connected: true, runtimeSupported: true, presentation: 'embedded' },
  } as never)
  return store
}

/** 切换项目的接口按请求的路径返回对应项目；其余读取一律失败，用例不依赖它们的内容。 */
function stubApi(
  store: typeof import('../../lib/store/index.ts'),
  projects: { id: string; rootPath: string; name: string }[],
  posted: string[] = [],
) {
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path, init) => {
    if (path === '/api/workspaces' && init?.method === 'POST') {
      posted.push(String(init.body))
      const target = JSON.parse(String(init.body)).path
      const workspace = projects.find((p) => p.rootPath === target)
      return { workspace, conversations: [{ id: `cv_${workspace?.id}`, title: '', updatedAt: 0 }] }
    }
    throw new Error('测试中不读取')
  }
}

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面未在时限内更新：${detail()}`)
}

/**
 * 等待已排队的 Promise 与动画帧执行完毕。happy-dom 以 `setImmediate` 实现 `requestAnimationFrame`，
 * 切换与显示页的路径中没有带延迟的计时器；不要改回按毫秒等待，每次显示页都按真实时间等待时，
 * 本文件在并行测试的负载下超过 5 秒时限。
 */
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

const parked = { cmd: 'browser_layout', args: { x: 0, y: 0, width: 0, height: 0 } }

test('当前页是嵌入面板的内置浏览器页时切换项目：切换完成，网页移出可视区', async () => {
  const invokes: Invoke[] = []
  const store = await asShell(invokes)
  const posted: string[] = []
  stubApi(store, [TO], posted)
  store.setWorkspace(FROM)
  store.syncBrowserTabs([
    { id: 'bt_switch', title: '甲', url: 'http://a.test/', workspaceId: FROM.id, createdSeq: 1 },
  ])
  store.setSidePanel({ tab: 'bt_switch' })

  const { render } = await import('solid-js/web')
  const { default: SidePanel } = await import('../SidePanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 300, height: 200 }) as DOMRect
  const dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
  try {
    await waitFor(
      () => invokes.some((i) => i.cmd === 'browser_layout' && i.args?.tabId === 'bt_switch'),
      () => `${host.innerHTML} ${JSON.stringify(invokes)}`,
    )
    const before = invokes.length

    await store.activateWorkspace(TO)

    expect(posted).toEqual([JSON.stringify({ path: TO.rootPath })])
    expect(store.workspace()?.id).toBe(TO.id)
    expect(host.querySelector('.web-view')).toBeNull()
    expect(invokes.slice(before).filter((i) => i.cmd === 'browser_layout')).toEqual([parked])
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect
    dispose()
  }
})

test('各类页都显示过之后反复切换项目，含连续切换：每次切换完成，弹窗打开时网页移出可视区', async () => {
  const invokes: Invoke[] = []
  const store = await asShell(invokes)
  const A = { id: 'ws_many_a', rootPath: 'C:/a', name: 'a' }
  const B = { id: 'ws_many_b', rootPath: 'C:/b', name: 'b' }
  stubApi(store, [A, B])
  store.setWorkspace({ id: A.id, root: A.rootPath, name: A.name })

  const { createSignal, Show } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { default: SidePanel } = await import('../SidePanel.tsx')
  const [dialog, setDialog] = createSignal(false)
  function Dialog() {
    store.holdOverlay(() => true)
    return <div />
  }
  const host = document.createElement('div')
  document.body.append(host)
  const rect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 300, height: 200 }) as DOMRect
  const dispose = render(
    () => (
      <>
        <SidePanel />
        <Show when={dialog()}>
          <Dialog />
        </Show>
      </>
    ),
    host as unknown as HTMLElement,
  )
  /** 依次显示当前项目的每一页，使各页的正文都已挂载。 */
  const showEach = async () => {
    for (const tab of store.panelTabs()) {
      store.setSidePanel({ tab: tab.id })
      await settle()
    }
  }
  const switchTo = (p: typeof A) =>
    store.activateWorkspace(p).then(
      () => 'ok',
      (e: unknown) => String(e),
    )
  try {
    const results: string[] = []
    await showEach()
    for (let round = 0; round < 3; round++) {
      results.push(await switchTo(B))
      await showEach()
      results.push(await switchTo(A))
      await showEach()
      results.push(...(await Promise.all([switchTo(B), switchTo(A), switchTo(B), switchTo(A)])))
      await settle()
    }
    expect(results.filter((r) => r !== 'ok')).toEqual([])
    expect(store.workspace()?.id).toBe(A.id)

    const browser = store.panelTabs().find((t) => t.kind === 'browser')
    store.setSidePanel({ tab: browser!.id })
    await waitFor(
      () => invokes.at(-1)?.cmd === 'browser_layout' && invokes.at(-1)?.args?.tabId === browser!.id,
      () => JSON.stringify(invokes.slice(-5)),
    )
    const before = invokes.length
    setDialog(true)
    await settle()
    expect(invokes.slice(before).filter((i) => i.cmd === 'browser_layout')).toEqual([parked])
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect
    dispose()
  }
})
