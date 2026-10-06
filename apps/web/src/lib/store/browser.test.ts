/**
 * 内置浏览器投影的初始化（`store/browser.ts` 的 `initBrowserProjection`）。
 *
 * 锁定一项布局缺陷：原生子视图是窗口的子 HWND，不受 Solid 生命周期管理。
 * 页面被硬刷新（开发编排重载、整页 reload）时，上一份页面的 `onCleanup` 不会执行，
 * 已展开的子视图停留在旧矩形上覆盖聊天区；而刷新后面板处于收起状态，没有 `BrowserPanel`
 * 将其收起。原始失败形状：刷新后一条约 300px 的窄条覆盖在会话正文上，既不铺满面板也不消失。
 * 因此初始化时无条件 park 一次。
 *
 * `store/browser.ts` 顶层的 `new QyClient` 不在该调用链上，但它经由 `state.ts` / `ui.ts` 间接
 * 访问几个浏览器全局对象，因此此处先补齐这些对象再动态 import（理由同 `store.test.ts`）。
 *
 * 覆盖范围（B6）：`store/browser.ts` 的 `initBrowserProjection`、`openBrowserTab`、`browserTabLabel`、
 * `openLinkInPanel` 与 `browserUnavailableText`，以及它们经由 `store/ui.ts` 按工作区记录的部分。
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

const { browserTabLabel, initBrowserProjection, openBrowserTab, openLinkInPanel } = await import(
  './browser.ts'
)
const { panelTabs, setSidePanel, setWorkspace, sidePanel, syncBrowserTabs } = await import(
  './ui.ts'
)
const { setState, state } = await import('./state.ts')

interface Invoke {
  cmd: string
  args: Record<string, unknown> | undefined
}

/**
 * 模拟桌面外壳，记录全部原生调用，返回 restore。UA 使用 Linux 的值：宿主类型只由握手能力声明，
 * 与 UA 无关。
 *
 * `reply` 为指定命令自定义响应，返回 `undefined` 时使用默认响应。
 */
function asShell(
  invokes: Invoke[],
  reply?: (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown> | undefined,
): () => void {
  const origNav = g.navigator
  const origTauri = g.__TAURI_INTERNALS__
  g.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }
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
  createdSeq: number
}

let seq = 0

function hostTab(tabId: string, workspaceId: string): HostTab {
  seq += 1
  return { tabId, url: 'about:blank', title: '', workspaceId, createdSeq: seq }
}

/** 等待宿主响应与投影执行完毕：`openBrowserTab` 与初始化对账都需要经过若干微任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 清除两个工作区的浏览器页签与选择。空清单按并集对齐，两个工作区同时清除。 */
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

  test('在桌面外壳中初始化时，先把所有子视图移出可视区', () => {
    const invokes: Invoke[] = []
    restore = asShell(invokes)

    initBrowserProjection()

    // park：`browser_layout` 不带 tabId、宽高为 0，宿主据此把每个页面都移出可视区。
    const park = invokes.find((i) => i.cmd === 'browser_layout')
    expect(park).toBeDefined()
    expect(park?.args?.tabId).toBeUndefined()
    expect(park?.args?.width).toBe(0)
    expect(park?.args?.height).toBe(0)
  })

  test('不在桌面外壳中时不发送任何原生命令', () => {
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

describe('内置浏览器页面按工作区记录', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  test('整页刷新后两个工作区各自恢复自己的页面', async () => {
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

  /**
   * 原始失败形状：页签固定显示为「浏览器 N」，会话流中引用该页面时只显示内部 id `bt_N`，
   * 两处都无法识别是哪个网页。页签名取网页标题，标题尚未到达时使用主机名，空标签页使用「新标签页」。
   */
  test('页签名随网页标题变化，会话流使用同一名称', async () => {
    reset()
    const tab = hostTab('bt_a1', WS_A.id)
    let host: HostTab[] = [tab]
    restore = asShell([], (cmd) => (cmd === 'browser_tabs' ? Promise.resolve(host) : undefined))
    setWorkspace(WS_A)
    const titleAfter = async (next: Partial<HostTab>): Promise<string | undefined> => {
      host = [{ ...tab, ...next }]
      initBrowserProjection()
      await flush()
      return panelTabs()[0]?.title
    }

    expect(await titleAfter({})).toBe('新标签页')
    expect(await titleAfter({ url: 'https://www.ibizsim.cn/', title: 'about:blank' })).toBe(
      'www.ibizsim.cn',
    )
    expect(await titleAfter({ url: 'https://www.ibizsim.cn/', title: 'iBizSim' })).toBe('iBizSim')
    expect(browserTabLabel('bt_a1')).toBe('iBizSim')
    expect(browserTabLabel('bt_gone')).toBeUndefined()
  })

  test('打开页面后切换到新打开的页面', async () => {
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
   * 原始失败形状：打开页面的请求尚未完成时切换到 B，响应按完成时的当前工作区写入，
   * B 的页签栏多出 A 的页面，B 原先选中的页面也被替换。
   */
  test('打开页面的响应延迟到达：B 的页签与当前页面保持不变，切回 A 后显示新页面', async () => {
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
    syncBrowserTabs([
      { id: bTab.tabId, title: '浏览器 1', workspaceId: WS_B.id, createdSeq: bTab.createdSeq },
    ])
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

  test('响应到达前页面已被关闭：不恢复也不选中', async () => {
    reset()
    const tab = hostTab('bt_a9', WS_A.id)
    restore = asShell([], (cmd) => {
      if (cmd === 'browser_open') return Promise.resolve(tab)
      // 对账时该页面已不在宿主的存活清单中。
      if (cmd === 'browser_tabs') return Promise.resolve([])
      return undefined
    })
    setWorkspace(WS_A)

    await openBrowserTab()

    expect(panelTabs()).toEqual([])
    expect(sidePanel()).toBe('files')
  })

  test('没有活动工作区时不打开页面', async () => {
    reset()
    const invokes: Invoke[] = []
    restore = asShell(invokes)
    setWorkspace(null)

    await openBrowserTab()

    expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
  })
})

/**
 * 正文中的链接交给内置浏览器打开。
 *
 * 原始失败形状：macOS 与 Linux 外壳中宿主已连接，点击本地 HTML 仍提示「本地网页预览需要
 * Windows 桌面端。」；宿主报告未找到浏览器，提示却是「尚未连接，请稍后重试」。
 */
describe('正文链接交给内置浏览器', () => {
  let restore: (() => void) | undefined
  const previous = state.capabilities
  afterEach(() => {
    restore?.()
    restore = undefined
    setState('notice', null)
    setState('capabilities', previous)
  })

  const caps = (browser: Record<string, unknown>) =>
    ({
      sandbox: { backend: 'none', active: false, reason: '' },
      environment: [],
      mode: 'auto',
      browser,
    }) as never

  test('页面位于独立窗口的宿主：本地 HTML 按工作区文件地址打开', async () => {
    reset()
    const tab = hostTab('bt_link', WS_A.id)
    const opened: (Record<string, unknown> | undefined)[] = []
    restore = asShell([], (cmd, args) => {
      if (cmd === 'browser_open') {
        opened.push(args)
        return Promise.resolve(tab)
      }
      if (cmd === 'browser_tabs') return Promise.resolve([tab])
      return undefined
    })
    setState(
      'capabilities',
      caps({ connected: true, runtimeSupported: true, presentation: 'window' }),
    )
    setWorkspace(WS_A)

    openLinkInPanel('page.html')
    await flush()

    expect(opened).toEqual([{ workspaceId: WS_A.id, url: 'file:///C:/a/page.html' }])
    expect(sidePanel()).toEqual({ tab: 'bt_link' })
    expect(state.notice?.reason).not.toBe('preview_failed')
  })

  test('宿主报告未找到浏览器：提示原因，不打开页面', () => {
    reset()
    const invokes: Invoke[] = []
    restore = asShell(invokes)
    setState(
      'capabilities',
      caps({ connected: false, runtimeSupported: false, unavailable: 'not_found' }),
    )
    setWorkspace(WS_A)

    openLinkInPanel('page.html')

    expect(state.notice?.message).toBe('未找到 Chrome、Edge 或 Chromium。')
    expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
  })
})
