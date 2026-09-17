/**
 * 内置浏览器投影的初始化（`store/browser.ts` 的 `initBrowserProjection`）。
 *
 * 锁的是一个真实布局 bug：原生子视图是窗口的子 HWND，不受 Solid 生命周期管辖。
 * 页面被硬刷新（dev 协调重载、整页 reload）时上一份页面的 `onCleanup` 不会跑，
 * 摆开着的子视图停在旧矩形上盖住聊天；而刷新后面板从收起态起、没有 `BrowserPanel`
 * 去收它。原始失败形状：刷新后一条约 300px 的窄条浮在会话正文上，既不铺满面板也不消失。
 * 修法是初始化时无条件 park 一次。
 *
 * `store/browser.ts` 顶层 `new QyClient` 不在这条链上，但它经 `state.ts` / `ui.ts` 间接
 * 触到几个浏览器全局，所以这里先补齐再动态 import（同 `store.test.ts` 的理由）。
 *
 * 覆盖范围（B6）：`store/browser.ts` 的 `initBrowserProjection` 与 `openBrowserTab`，
 * 连同它们经 `store/ui.ts` 按工作区落账的那一段。
 */

import { afterEach, describe, expect, test } from 'bun:test'

const g = globalThis as Record<string, unknown>
g.location ??= {
  hash: '',
  href: 'http://127.0.0.1:5180/',
  search: '',
  pathname: '/',
  origin: 'http://127.0.0.1:5180',
}
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
g.matchMedia ??= () => ({ matches: false })
const stored = new Map<string, string>()
g.localStorage ??= {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => stored.set(k, v),
  removeItem: (k: string) => stored.delete(k),
}

const { initBrowserProjection, openBrowserTab } = await import('./browser.ts')
const { panelTabs, setSidePanel, setWorkspace, sidePanel, syncBrowserTabs } = await import(
  './ui.ts'
)

interface Invoke {
  cmd: string
  args: Record<string, unknown> | undefined
}

/**
 * 装成 Windows 桌面外壳，记录所有原生调用。返回 restore。
 *
 * `reply` 给某条命令自定回包，返回 `undefined` 的走默认回包。
 */
function asShell(
  invokes: Invoke[],
  reply?: (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown> | undefined,
): () => void {
  const origNav = g.navigator
  const origTauri = g.__TAURI_INTERNALS__
  g.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      const custom = reply?.(cmd, args)
      if (custom) return custom
      if (cmd === 'browser_tabs') return Promise.resolve([])
      return Promise.resolve(0)
    },
    transformCallback: () => 1,
  }
  return () => {
    g.navigator = origNav
    g.__TAURI_INTERNALS__ = origTauri
  }
}

const WS_A = { id: 'ws_browser_a', root: 'C:/a', name: 'A' }
const WS_B = { id: 'ws_browser_b', root: 'C:/b', name: 'B' }

interface HostTab {
  tabId: string
  url: string
  title: string
  workspaceId: string
}

function hostTab(tabId: string, workspaceId: string): HostTab {
  return { tabId, url: 'about:blank', title: '', workspaceId }
}

/** 等宿主回包与投影跑完：`openBrowserTab` 与初始化对账都要过几个微任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 清掉两个工作区的浏览器页签与选择。空清单按并集对齐，两边一起收。 */
function reset(): void {
  syncBrowserTabs([])
  for (const ws of [WS_A, WS_B]) {
    setWorkspace(ws)
    setSidePanel('files')
  }
  setWorkspace(null)
}

describe('内置浏览器投影初始化', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  test('在 Windows 桌面外壳里初始化时，先把所有子视图移出可视区', () => {
    const invokes: Invoke[] = []
    restore = asShell(invokes)

    initBrowserProjection()

    // park：`browser_layout` 不带 tabId、宽高为 0 —— 宿主据此把每一页都收出可视区。
    const park = invokes.find((i) => i.cmd === 'browser_layout')
    expect(park).toBeDefined()
    expect(park?.args?.tabId).toBeUndefined()
    expect(park?.args?.width).toBe(0)
    expect(park?.args?.height).toBe(0)
  })

  test('不是桌面外壳时一条原生命令都不发', () => {
    const invokes: Invoke[] = []
    const origNav = g.navigator
    const origTauri = g.__TAURI_INTERNALS__
    g.navigator = { userAgent: 'not-a-shell' }
    g.__TAURI_INTERNALS__ = undefined
    restore = () => {
      g.navigator = origNav
      g.__TAURI_INTERNALS__ = origTauri
    }

    initBrowserProjection()

    expect(invokes).toHaveLength(0)
  })
})

describe('内置浏览器页按工作区落账', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  test('整页刷新后两个工作区各自恢复自己的页', async () => {
    reset()
    const host = [hostTab('bt_a1', WS_A.id), hostTab('bt_b1', WS_B.id)]
    restore = asShell([], (cmd) => (cmd === 'browser_tabs' ? Promise.resolve(host) : undefined))

    initBrowserProjection()
    await flush()

    setWorkspace(WS_A)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a1'])
    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_b1'])
  })

  test('开页翻到新开的那一页', async () => {
    reset()
    const tab = hostTab('bt_a9', WS_A.id)
    restore = asShell([], (cmd) => {
      if (cmd === 'browser_open') return Promise.resolve(tab)
      if (cmd === 'browser_tabs') return Promise.resolve([tab])
      return undefined
    })
    setWorkspace(WS_A)

    await openBrowserTab()

    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a9'])
    expect(sidePanel()).toEqual({ tab: 'bt_a9' })
  })

  /**
   * 原始失败形状：开页请求在途时切到 B，回包按「完成时的当前工作区」写，
   * B 的页签条上多出 A 的那一页，B 原来停的那一页也被顶掉。
   */
  test('开页回包迟到 —— B 的页签与当前页一动不动，切回 A 见到新页', async () => {
    reset()
    const aTab = hostTab('bt_a9', WS_A.id)
    const bTab = hostTab('bt_b1', WS_B.id)
    let land: (() => void) | undefined
    const opened = new Promise<HostTab>((resolve) => {
      land = () => resolve(aTab)
    })
    restore = asShell([], (cmd) => {
      if (cmd === 'browser_open') return opened
      if (cmd === 'browser_tabs') return Promise.resolve([bTab, aTab])
      return undefined
    })
    syncBrowserTabs([{ id: bTab.tabId, title: '浏览器 1', workspaceId: WS_B.id }])
    setWorkspace(WS_B)
    setSidePanel({ tab: bTab.tabId })

    setWorkspace(WS_A)
    const opening = openBrowserTab()
    setWorkspace(WS_B)
    land?.()
    await opening

    expect(panelTabs().map((t) => t.id)).toEqual([bTab.tabId])
    expect(sidePanel()).toEqual({ tab: bTab.tabId })
    setWorkspace(WS_A)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a9'])
    expect(sidePanel()).toEqual({ tab: 'bt_a9' })
  })

  test('回包到达前这一页已被关掉 —— 不复活也不选中', async () => {
    reset()
    const tab = hostTab('bt_a9', WS_A.id)
    restore = asShell([], (cmd) => {
      if (cmd === 'browser_open') return Promise.resolve(tab)
      // 对账时它已经不在宿主的存活清单里。
      if (cmd === 'browser_tabs') return Promise.resolve([])
      return undefined
    })
    setWorkspace(WS_A)

    await openBrowserTab()

    expect(panelTabs()).toEqual([])
    expect(sidePanel()).toBe('files')
  })

  test('没有活动工作区时不开页', async () => {
    reset()
    const invokes: Invoke[] = []
    restore = asShell(invokes)
    setWorkspace(null)

    await openBrowserTab()

    expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
  })
})
