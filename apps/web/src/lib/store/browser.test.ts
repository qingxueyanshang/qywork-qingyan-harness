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
 * `openLinkInPanel`、`loadRestoredTab` 与 `browserUnavailableText`，以及它们经由 `store/ui.ts` 按工作区记录的部分（含
 * `syncBrowserTabs` 切换到新窗口、应用启动时恢复的浏览器页与 `adoptBrowserTab`）。
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

/**
 * 上次运行留下的面板记录：每个工作区一个画布页与两个浏览器页，当前页是第一个浏览器页。sessionStorage 中没有记录，
 * 模块加载即为应用启动，这些浏览器页恢复为未加载的页。每条用例使用其中一个工作区。
 */
const RESTORED = [
  'ws_restore_load',
  'ws_restore_race',
  'ws_restore_closed',
  'ws_restore_fail',
  'ws_restore_link',
]
stored.set(
  'qywork.panel.tabs',
  JSON.stringify(
    Object.fromEntries(
      RESTORED.map((id) => [
        id,
        {
          tabs: [
            {
              id: 'canvas-a.canvas.json',
              kind: 'canvas',
              title: 'a',
              path: 'a.canvas.json',
              createdSeq: 1,
            },
            {
              id: 'bt_7',
              kind: 'browser',
              title: '甲',
              url: 'http://a.test/',
              live: true,
              createdSeq: 7,
            },
            {
              id: 'bt_8',
              kind: 'browser',
              title: '乙',
              url: 'http://b.test/',
              live: true,
              createdSeq: 8,
            },
          ],
          page: { tab: 'bt_7' },
        },
      ]),
    ),
  ),
)

const {
  browserTab,
  browserTabLabel,
  initBrowserProjection,
  loadRestoredTab,
  openBrowserTab,
  openLinkInPanel,
} = await import('./browser.ts')
const { closePanelTab, panelTabs, setSidePanel, setWorkspace, sidePanel, syncBrowserTabs } =
  await import('./ui.ts')
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
    metadata: { currentWebview: { label: 'main' } },
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
  openerTabId?: string | null
  hidden?: boolean
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
      {
        id: bTab.tabId,
        title: '浏览器 1',
        url: 'about:blank',
        workspaceId: WS_B.id,
        createdSeq: bTab.createdSeq,
      },
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

  /**
   * 原始失败形状：面板中显示的页打开新窗口（`target=_blank` 链接、`window.open`）后，新页只追加到页签条，
   * 面板仍显示原页，新打开的页不可见。
   */
  test('面板中显示的页打开的新窗口切换为当前页；其他页打开的新窗口与 AI 新建的页不切换', async () => {
    reset()
    let host: HostTab[] = [hostTab('bt_a1', WS_A.id), hostTab('bt_a2', WS_A.id)]
    restore = asShell([], (cmd) => (cmd === 'browser_tabs' ? Promise.resolve(host) : undefined))
    setWorkspace(WS_A)
    initBrowserProjection()
    await flush()
    setSidePanel({ tab: 'bt_a1' })

    host = [
      ...host,
      { ...hostTab('bt_a3', WS_A.id), openerTabId: 'bt_a2' },
      hostTab('bt_a4', WS_A.id),
    ]
    initBrowserProjection()
    await flush()
    expect(sidePanel()).toEqual({ tab: 'bt_a1' })

    host = [...host, { ...hostTab('bt_a5', WS_A.id), openerTabId: 'bt_a1' }]
    initBrowserProjection()
    await flush()
    expect(sidePanel()).toEqual({ tab: 'bt_a5' })
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a1', 'bt_a2', 'bt_a3', 'bt_a4', 'bt_a5'])

    // 已在页签条上的新窗口不再改变当前页。
    setSidePanel({ tab: 'bt_a1' })
    initBrowserProjection()
    await flush()
    expect(sidePanel()).toEqual({ tab: 'bt_a1' })
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

  /** 原始失败形状：在正文中连续三次点击同一个网页文件的链接，面板中出现三个显示同一文件的页。 */
  test('当前工作区已有页显示同一地址时切换到该页，转义写法不同也视为同一地址', async () => {
    reset()
    const shown = { ...hostTab('bt_same', WS_A.id), url: 'file:///C:/a/%E4%B8%AD%E6%96%87.html' }
    const invokes: Invoke[] = []
    restore = asShell(invokes, (cmd) =>
      cmd === 'browser_tabs' ? Promise.resolve([shown]) : undefined,
    )
    setState(
      'capabilities',
      caps({ connected: true, runtimeSupported: true, presentation: 'embedded' }),
    )
    setWorkspace(WS_A)
    initBrowserProjection()
    await flush()

    for (const href of ['中文.html', 'file:///C:/a/中文.html']) {
      setSidePanel('files')
      openLinkInPanel(href)
      await flush()
      expect(sidePanel()).toEqual({ tab: 'bt_same' })
    }
    expect(invokes.some((i) => i.cmd === 'browser_open' || i.cmd === 'browser_activate')).toBe(
      false,
    )
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_same'])
  })

  test('页面位于独立窗口的宿主：切换到已有页时把该页的窗口置于前台', async () => {
    reset()
    const shown = { ...hostTab('bt_same_win', WS_A.id), url: 'https://example.com/a' }
    const invokes: Invoke[] = []
    restore = asShell(invokes, (cmd) =>
      cmd === 'browser_tabs' ? Promise.resolve([shown]) : undefined,
    )
    setState(
      'capabilities',
      caps({ connected: true, runtimeSupported: true, presentation: 'window' }),
    )
    setWorkspace(WS_A)
    initBrowserProjection()
    await flush()

    openLinkInPanel('https://example.com/a')
    await flush()

    expect(sidePanel()).toEqual({ tab: 'bt_same_win' })
    expect(invokes.filter((i) => i.cmd === 'browser_activate').map((i) => i.args)).toEqual([
      { tabId: 'bt_same_win' },
    ])
    expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
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

  // 原始失败形状：同时运行两个 qywork 时，后启动的一个提示「尚未连接，请稍后重试」，而等待不会恢复。
  test('浏览器配置被另一个 qywork 占用：提示原因，不提示稍后重试', () => {
    reset()
    const invokes: Invoke[] = []
    restore = asShell(invokes)
    setState(
      'capabilities',
      caps({ connected: false, runtimeSupported: false, unavailable: 'in_use' }),
    )
    setWorkspace(WS_A)

    openLinkInPanel('page.html')

    expect(state.notice?.message).toBe('另一个 qywork 正在使用内置浏览器。')
    expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
  })
})

/**
 * 应用重启后恢复的浏览器页只在显示时新建页面（`loadRestoredTab`），新建后原位换为宿主的页。
 *
 * 原始失败形状：恢复的页沿用旧的 tabId，与新进程中新建的页重复；或首次显示时新页追加在页签条末尾，
 * 恢复的页仍留在原位，同一网页出现两次。
 */
describe('恢复的浏览器页', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    setWorkspace(null)
  })

  /** 该工作区恢复的页：未加载，id 不是宿主的 tabId。 */
  function restoredIn(wsId: string) {
    setWorkspace({ id: wsId, root: 'C:/r', name: 'R' })
    const tabs = panelTabs()
    const [first, second] = tabs.filter((t) => t.kind === 'browser')
    return { first: first!, second: second!, tabs }
  }

  test('应用启动时不新建页面；首次显示时按记录的地址新建，原位换为宿主的页并保持为当前页', async () => {
    const wsId = 'ws_restore_load'
    const { first, second, tabs } = restoredIn(wsId)
    expect([first, second]).toMatchObject([
      { title: '甲', url: 'http://a.test/', live: false },
      { title: '乙', url: 'http://b.test/', live: false },
    ])
    expect(sidePanel()).toEqual({ tab: first.id })

    const invokes: Invoke[] = []
    const opened = { ...hostTab('bt_1', wsId), url: 'http://a.test/', title: '甲' }
    restore = asShell(invokes, (cmd) => {
      if (cmd === 'browser_open') return Promise.resolve(opened)
      if (cmd === 'browser_tabs') return Promise.resolve([opened])
      return undefined
    })
    await loadRestoredTab(wsId, first.id)

    expect(invokes.filter((i) => i.cmd === 'browser_open').map((i) => i.args)).toEqual([
      { workspaceId: wsId, url: 'http://a.test/' },
    ])
    expect(panelTabs().map((t) => t.id)).toEqual([tabs[0]!.id, 'bt_1', second.id])
    expect(panelTabs()[1]).toMatchObject({ live: true, title: '甲' })
    expect(sidePanel()).toEqual({ tab: 'bt_1' })
  })

  test('宿主推送的清单先于新建结果到达：页签条上只有一页', async () => {
    const wsId = 'ws_restore_race'
    const { first, second, tabs } = restoredIn(wsId)
    const opened = { ...hostTab('bt_1', wsId), url: 'http://a.test/', title: '甲' }
    restore = asShell([], (cmd) => {
      if (cmd === 'browser_open') {
        syncBrowserTabs([
          {
            id: 'bt_1',
            title: '甲',
            url: opened.url,
            workspaceId: wsId,
            createdSeq: opened.createdSeq,
          },
        ])
        return Promise.resolve(opened)
      }
      if (cmd === 'browser_tabs') return Promise.resolve([opened])
      return undefined
    })
    await loadRestoredTab(wsId, first.id)

    expect(panelTabs().map((t) => t.id)).toEqual([tabs[0]!.id, 'bt_1', second.id])
    expect(sidePanel()).toEqual({ tab: 'bt_1' })
  })

  test('新建期间该页被关闭：关闭新建的页面，不留下页签', async () => {
    const wsId = 'ws_restore_closed'
    const { first, second, tabs } = restoredIn(wsId)
    const invokes: Invoke[] = []
    const opened = hostTab('bt_1', wsId)
    restore = asShell(invokes, (cmd) => {
      if (cmd === 'browser_open') {
        closePanelTab(first.id)
        return Promise.resolve(opened)
      }
      return undefined
    })
    await loadRestoredTab(wsId, first.id)

    expect(invokes.filter((i) => i.cmd === 'browser_close').map((i) => i.args)).toEqual([
      { tabId: 'bt_1' },
    ])
    expect(panelTabs().map((t) => t.id)).toEqual([tabs[0]!.id, second.id])
  })

  test('新建失败：该页保持未加载，与宿主清单对账时不移除', async () => {
    const wsId = 'ws_restore_fail'
    const { first, tabs } = restoredIn(wsId)
    restore = asShell([], (cmd) =>
      cmd === 'browser_open' ? Promise.reject('只能打开 HTTP、HTTPS 或本地文件') : undefined,
    )
    await expect(loadRestoredTab(wsId, first.id)).rejects.toBe('只能打开 HTTP、HTTPS 或本地文件')
    syncBrowserTabs([])
    expect(panelTabs()).toEqual(tabs)
    expect(sidePanel()).toEqual({ tab: first.id })
  })

  /** 原始失败形状：正文中的链接指向恢复的页记录的地址时，再新建一页，同一地址出现两个页签。 */
  test('正文链接指向恢复的页记录的地址：切换到该页，不新建页面', async () => {
    const { second } = restoredIn('ws_restore_link')
    setSidePanel('files')
    const invokes: Invoke[] = []
    restore = asShell(invokes)
    const previous = state.capabilities
    setState('capabilities', {
      sandbox: { backend: 'none', active: false, reason: '' },
      browser: { connected: true, runtimeSupported: true, presentation: 'embedded' },
    } as never)
    try {
      openLinkInPanel('http://b.test/')
      await flush()
      expect(sidePanel()).toEqual({ tab: second.id })
      expect(invokes.some((i) => i.cmd === 'browser_open')).toBe(false)
    } finally {
      setState('capabilities', previous)
    }
  })
})

describe('隐藏页', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    reset()
  })

  /** 文件页的 HTML 预览是隐藏页：它出现在页签条上时，可以被当作浏览器页签切换与关闭。 */
  test('隐藏页留在镜像中供打开者读取缩放比例，不进入页签条', async () => {
    const invokes: Invoke[] = []
    const shown = hostTab('bt_shown', WS_A.id)
    const preview = { ...hostTab('bt_preview', WS_A.id), hidden: true }
    restore = asShell(invokes, (cmd) =>
      cmd === 'browser_tabs' ? Promise.resolve([shown, preview]) : undefined,
    )
    setWorkspace(WS_A)
    initBrowserProjection()
    await flush()
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_shown'])
    expect(browserTab('bt_preview')?.hidden).toBe(true)
  })
})
