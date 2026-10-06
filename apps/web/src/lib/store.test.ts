/**
 * 前端状态中纯逻辑部分的回归测试。
 *
 * 只测试不需要连接与 DOM 的部分。组件级行为（面板是否实际展开、密钥是否
 * 出现在响应中）不在此测试：它们或已由端到端实测覆盖，或应由服务端测试锁定，
 * 移入单测只会变成对测试桩的测试。
 *
 * 先补全浏览器全局对象的原因：`store.ts` 顶层执行 `new QyClient(...)`，而 `QyClient` 有字段初始化器
 * `private readonly endpoint = resolveEndpoint()`：构造函数体为空，但字段在实例化时即执行，
 * 需要读取 `location` / `sessionStorage` / `matchMedia`。因此此处先补全这些对象再动态 import，
 * 而不是在产品代码中添加 `typeof location === 'undefined'` 判断：该判断只为测试存在，生产路径上
 * 永远不会执行，属于 CLAUDE.md B5 所述的空壳分支。
 *
 * `localStorage` 同理：面板宽度需要落盘，缺少它时整个写入路径进入 catch。
 *
 * 覆盖范围（B6：一个 test 覆盖多个源文件时须在此列明）：`store/ui.ts` 的面板宽度、
 * 页签与刷新后的恢复、`store/browser.ts` 的内置浏览器归属、`store/connection.ts` 的 `applyEvent`
 * 归属过滤与能力投影替换、`store/settings.ts` 的 API 错误解释。
 *
 * 不要在此断言模块加载时读取的宽度：`bun test` 一次执行多个文件时共用一份
 * 模块表，`client.test.ts` 先行 import 了 `client.ts`，`store/ui.ts` 在此处
 * 补全全局对象之前已完成求值。断言该结果时，单独执行本文件通过，执行全量时失败。
 */

import { describe, expect, test } from 'bun:test'

const g = globalThis as Record<string, unknown>
g.location = {
  hash: '',
  href: 'http://127.0.0.1:5180/',
  search: '',
  pathname: '/',
  origin: 'http://127.0.0.1:5180',
}
// 右侧面板的页签与当前页保存在 sessionStorage 中，刷新恢复的用例读取这份记录。
const session = new Map<string, string>()
g.sessionStorage = {
  getItem: (k: string) => session.get(k) ?? null,
  setItem: (k: string, v: string) => {
    session.set(k, v)
  },
  removeItem: (k: string) => {
    session.delete(k)
  },
}
g.matchMedia = () => ({ matches: false })
// 面板宽度相关用例需要：localStorage 是其落盘位置。
const stored = new Map<string, string>()
g.localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => {
    stored.set(k, v)
  },
  removeItem: (k: string) => {
    stored.delete(k)
  },
}

const {
  activePanelTab,
  loadConversations,
  toggleSidebar,
  setFoldOpen,
  setOpenFile,
  openFileInPanel,
  closeSettings,
  openSettings,
  activateWorkspace,
  applyEvent,
  applyRejected,
  discardPace,
  client,
  dropView,
  modelCatalog,
  closePanel,
  closePanelTab,
  explainApiError,
  holdPanelTab,
  interrupt,
  isRunning,
  ledgerRevision,
  loadOlderConversation,
  loadConversationChanges,
  loadConversationView,
  loadOlderConversationChanges,
  openPreviewTab,
  openCanvasTab,
  openConversationTab,
  openView,
  openPanel,
  openPanelTab,
  PANEL_MIN,
  panelMaximized,
  panelTabs,
  panelWidth,
  reloadActiveConversation,
  runClosed,
  resizePanel,
  restoreTerminalTabs,
  saveServerConfig,
  selectConversation,
  sendMessage,
  setPanelTabUrl,
  setSidePanel,
  setWorkspace,
  syncBrowserTabs,
  setState,
  sidePanel,
  state,
  syncViews,
  togglePanel,
  togglePanelMax,
  transcript,
  view,
  viewOf,
} = await import('./store/index.ts')
const { flushSession } = await import('./session.ts')

describe('激活项目复用服务端返回的会话列表', () => {
  test('新项目不追加会话列表请求与第二次创建请求', async () => {
    const calls: string[] = []
    const invokes: string[] = []
    const apiBefore = client.api
    ;(
      client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/api/workspaces') {
        return {
          workspace: {
            id: 'ws_created',
            name: '空项目',
            rootPath: 'C:/ws/empty',
            lastOpenedAt: 1,
            conversations: 1,
          },
          conversations: [
            {
              id: 'cv_created',
              workspaceId: 'ws_created',
              title: '',
              provider: 'p',
              model: 'm',
              compactionManifest: null,
              cacheGeneration: 0,
              source: null,
              sourceRef: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }
      }
      if (path.includes('/history')) {
        return {
          messages: [],
          runs: [],
          steps: [],
          todos: [],
          workflowStarts: [],
          nextCursor: null,
        }
      }
      throw new Error(`投影不可用：${path}`)
    }

    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        invokes.push(cmd)
      },
      transformCallback: () => 0,
    }
    try {
      await activateWorkspace({ name: '空项目' })
    } finally {
      ;(client as unknown as { api: typeof client.api }).api = apiBefore
      delete g.__TAURI_INTERNALS__
    }

    expect(state.activeConversation).toBe('cv_created')
    expect(state.conversations.map((c) => String(c.id))).toEqual(['cv_created'])
    expect(calls).not.toContain('GET /api/conversations')
    expect(calls).not.toContain('POST /api/conversations')
    expect(invokes).toEqual(['remember_workspace'])
  })
})

/** 为该会话新建一份空表：前一条用例写入过条目，下一条用例须从空表开始。 */
const freshView = (id: string) => {
  dropView(id)
  openView(id)
}

/** 页签与当前页按项目分别记录，因此涉及二者的用例都须先切换到一个具体项目。 */
const WS_A = { id: 'ws_tab_a', root: 'C:/a', name: 'A' }
const WS_B = { id: 'ws_tab_b', root: 'C:/b', name: 'B' }

describe('右侧面板：同一按钮控制展开与收起，并记住上次显示的视图', () => {
  test('收起状态下点击时展开为默认的文件视图', () => {
    setSidePanel(null)
    togglePanel()
    expect(sidePanel()).toBe('files')
  })

  test('展开状态下点击时收起', () => {
    openPanel('changes')
    togglePanel()
    expect(sidePanel()).toBe(null)
  })

  test('收起后再展开时回到上次的视图，而不是一律回到文件视图', () => {
    openPanel('changes')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('changes')
  })

  test('多次切换视图后记住最后一个', () => {
    openPanel('files')
    openPanel('changes')
    openPanel('todos')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('todos')
  })

  test('反复切换时视图不变：切换偶数次后为展开，奇数次后为收起', () => {
    openPanel('todos')
    for (let i = 0; i < 6; i++) togglePanel()
    expect(sidePanel()).toBe('todos')
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(sidePanel()).toBe('todos')
  })

  test('面板标题栏的 × 同样记住当前视图：它与顶栏开关使用同一收起路径', () => {
    openPanel('changes')
    closePanel()
    togglePanel()
    expect(sidePanel()).toBe('changes')
  })
})

describe('面板放大状态随面板复位，不单独保留', () => {
  test('收起面板时一并复位，下次展开不直接进入放大态', () => {
    openPanel('files')
    togglePanelMax()
    expect(panelMaximized()).toBe(true)
    togglePanel()
    expect(panelMaximized()).toBe(false)
    togglePanel()
    expect(panelMaximized()).toBe(false)
  })

  test('切换视图不影响放大：放大的对象是面板，不是某个视图', () => {
    openPanel('files')
    togglePanelMax()
    setSidePanel('changes')
    expect(panelMaximized()).toBe(true)
    closePanel()
    expect(panelMaximized()).toBe(false)
  })
})

/**
 * 可多开的页（终端、浏览器）。
 *
 * 测试关闭一页后切换到哪一页、释放了哪些资源：这两项出错的结果分别是面板意外收起、
 * PTY 留在后台并占用工作区中的文件句柄，且均无报错。
 */
/*
 * 面板宽度一节只锁定期望宽度。
 *
 * 实际宽度由 `.app.with-panel` 的 `minmax(var(--chat-floor), 1fr)` 决定，
 * 属于网格布局；此处没有 DOM 与窗口，无法测量，因此下面不包含
 * 「窗口 1280、保存值 1632，因此应为 800」之类的断言。此类断言在此处不成立：
 * 它只能证明本文件重复实现了一遍 CSS 的算法。原始失败形状（保存值 1632、窗口 1280）
 * 由浏览器中的实测覆盖。
 */
describe('面板宽度：按拖动结果原样保存', () => {
  test('小于下限时限制为下限：更窄时面板内容无法显示', () => {
    resizePanel(100)
    expect(panelWidth()).toBe(PANEL_MIN)
    // 负数必须拦截：`minmax(0, -50px)` 会使整条 grid-template-columns 失效，
    // 网格回退为隐式 auto 列，即要防止的布局失效。
    resizePanel(-50)
    expect(panelWidth()).toBe(PANEL_MIN)
  })

  test('窗口空间不足时也不缩小该值：网格自行收缩，设置保持不变', () => {
    // 在 2560 宽的窗口中拖到 1632，再在 1280 宽的窗口中打开：该值仍为 1632，
    // 窗口变宽后恢复。在窗口变窄时缩小该值，等于以一次临时的窗口尺寸覆盖用户的设置。
    resizePanel(1632)
    expect(panelWidth()).toBe(1632)
    expect(stored.get('qywork.panelWidth')).toBe('1632')
  })
})

describe('可多开的页：+ 新建，× 关闭', () => {
  const reset = () => {
    for (const ws of [WS_A, WS_B]) {
      setWorkspace(ws)
      for (const t of panelTabs()) closePanelTab(t.id)
      setSidePanel(null)
    }
    setWorkspace(WS_A)
    setSidePanel('files')
  }

  test('新建一页后切换到该页', () => {
    reset()
    openPanelTab('terminal')
    expect(panelTabs().length).toBe(1)
    expect(activePanelTab()).toBe(panelTabs()[0]!.id)
  })

  test('正文中的链接打开网页预览页，再次点击同一地址时切换到已有页', () => {
    reset()
    openPreviewTab('http://localhost:8000')
    const [tab] = panelTabs()
    expect(tab!.kind).toBe('preview')
    expect(tab!.url).toBe('http://localhost:8000')

    setSidePanel('files')
    openPreviewTab('http://localhost:8000')
    expect(panelTabs().length).toBe(1)
    expect(activePanelTab()).toBe(tab!.id)

    // 地址栏导航后记录新地址，按地址查找已有页时也以新地址为准。
    setPanelTabUrl(tab!.id, 'http://localhost:8000/about')
    openPreviewTab('http://localhost:8000')
    expect(panelTabs().length).toBe(2)
  })

  /**
   * 内置浏览器的页签是宿主存活页的投影：整页刷新后清单由宿主重建，
   * 宿主侧关闭的页在此移除，且不对已不存在的 tabId 再次执行关闭。
   */
  test('内置浏览器页签与宿主的存活页同步', () => {
    reset()
    syncBrowserTabs([
      { id: 'bt_1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 },
      { id: 'bt_2', title: '浏览器 2', workspaceId: WS_A.id, createdSeq: 2 },
    ])
    expect(panelTabs().map((t) => [t.id, t.kind, t.title])).toEqual([
      ['bt_1', 'browser', '浏览器 1'],
      ['bt_2', 'browser', '浏览器 2'],
    ])

    // 页签 id 即宿主的 tabId，前端不另行生成。
    setSidePanel({ tab: 'bt_2' })
    let closed = 0
    holdPanelTab('bt_2', () => {
      closed += 1
    })

    // 宿主侧关闭 bt_2：页签随之移除，切换到左侧相邻页，且不再执行收尾。
    syncBrowserTabs([{ id: 'bt_1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 }])
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_1'])
    expect(activePanelTab()).toBe('bt_1')
    expect(closed).toBe(0)
  })

  test('两个工作区各有一页时只显示各自的页', () => {
    reset()
    syncBrowserTabs([
      { id: 'bt_a1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 },
      { id: 'bt_b1', title: '浏览器 2', workspaceId: WS_B.id, createdSeq: 2 },
    ])
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a1'])
    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_b1'])
  })

  /**
   * 最后一页关闭后，该工作区不再出现在宿主清单中，同步范围仍须覆盖它：
   * 只按清单中的工作区同步时，B 的页签会留在页签条上，而宿主侧已没有该页。
   */
  test('后台工作区的最后一页关闭后，该条目的页签清空，当前页随之修正', () => {
    reset()
    syncBrowserTabs([
      { id: 'bt_a1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 },
      { id: 'bt_b1', title: '浏览器 2', workspaceId: WS_B.id, createdSeq: 2 },
    ])
    setWorkspace(WS_B)
    setSidePanel({ tab: 'bt_b1' })
    setWorkspace(WS_A)

    syncBrowserTabs([{ id: 'bt_a1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 }])
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a1'])
    setWorkspace(WS_B)
    expect(panelTabs()).toEqual([])
    expect(sidePanel()).toBe('files')
  })

  test('没有活动项目时，宿主投影仍按每页自带的工作区记录', () => {
    reset()
    setWorkspace(null)
    syncBrowserTabs([
      { id: 'bt_a1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 },
      { id: 'bt_b1', title: '浏览器 2', workspaceId: WS_B.id, createdSeq: 2 },
    ])
    setWorkspace(WS_A)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_a1'])
    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(['bt_b1'])
  })

  test('关闭当前页时切换到右侧相邻页，不收起面板', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('preview')
    const [first, second] = panelTabs()
    setSidePanel({ tab: first!.id })
    closePanelTab(first!.id)
    expect(activePanelTab()).toBe(second!.id)
  })

  test('关闭最右侧的页时切换到左侧相邻页', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('preview')
    const [first, second] = panelTabs()
    setSidePanel({ tab: second!.id })
    closePanelTab(second!.id)
    expect(activePanelTab()).toBe(first!.id)
  })

  test('关闭最后一页时回到文件视图，不收起面板', () => {
    reset()
    openPanelTab('preview')
    closePanelTab(panelTabs()[0]!.id)
    expect(panelTabs().length).toBe(0)
    expect(sidePanel()).toBe('files')
  })

  test('关闭非当前页时当前页保持不变', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('preview')
    const [first, second] = panelTabs()
    setSidePanel({ tab: second!.id })
    closePanelTab(first!.id)
    expect(activePanelTab()).toBe(second!.id)
  })

  test('关闭一页时释放一次该页登记的资源，不影响其他页', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('terminal')
    const [first, second] = panelTabs()
    let closed = ''
    holdPanelTab(first!.id, () => {
      closed += 'a'
    })
    holdPanelTab(second!.id, () => {
      closed += 'b'
    })
    closePanelTab(first!.id)
    expect(closed).toBe('a')
    // 重复关闭已关闭的页不得再次释放：释放操作会结束进程。
    closePanelTab(first!.id)
    expect(closed).toBe('a')
  })

  test('切换项目只切换页签集合：切到 B 只显示 B，切回后 A 保持原样，不执行任何 disposer', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('preview')
    const opened = panelTabs().map((t) => t.id)
    const page = sidePanel()
    let closed = 0
    for (const id of opened) {
      holdPanelTab(id, () => {
        closed += 1
      })
    }

    setWorkspace(WS_B)
    expect(panelTabs()).toEqual([])
    expect(sidePanel()).toBe(null)
    openPanelTab('terminal')
    const onlyB = panelTabs().map((t) => t.id)
    expect(onlyB).toHaveLength(1)
    expect(opened).not.toContain(onlyB[0])

    setWorkspace(WS_A)
    expect(panelTabs().map((t) => t.id)).toEqual(opened)
    expect(sidePanel()).toEqual(page)
    expect(closed).toBe(0)
  })

  test('写入 A 的条目不改变 B 的页签与当前页', () => {
    reset()
    openPanelTab('terminal')
    setWorkspace(WS_B)
    openPanelTab('terminal')
    const bTabs = panelTabs().map((t) => t.id)
    const bPage = sidePanel()

    setWorkspace(WS_A)
    openPreviewTab('http://localhost:9100')
    syncBrowserTabs([{ id: 'bt_a1', title: '浏览器 1', workspaceId: WS_A.id, createdSeq: 1 }])

    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(bTabs)
    expect(sidePanel()).toEqual(bPage)
  })

  test('没有活动项目时不创建任何页', () => {
    reset()
    setWorkspace(null)
    openPanelTab('terminal')
    openPreviewTab('http://localhost:9200')
    openConversationTab('cv_no_ws', '子 agent')
    expect(panelTabs()).toEqual([])
    expect(sidePanel()).toBe(null)

    setWorkspace(WS_A)
    expect(panelTabs()).toEqual([])
  })

  test('收起后再展开时回到原页，与固定视图使用同一路径', () => {
    reset()
    openPanelTab('terminal')
    const id = panelTabs()[0]!.id
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(activePanelTab()).toBe(id)
  })

  test('记录的页在收起期间被关闭时，展开后回到文件视图，而不是无法关闭的空白', () => {
    reset()
    openPanelTab('terminal')
    const id = panelTabs()[0]!.id
    togglePanel()
    closePanelTab(id)
    togglePanel()
    expect(sidePanel()).toBe('files')
  })
})

/**
 * 外壳侧仍在运行的 PTY 按记录的归属恢复为页签。
 *
 * 锁定两种失败形状：整份清单按当前项目写入时，其他项目的 PTY 不再有任何界面
 * 可以访问；序号只按当前项目的条目递增时，下一次新建的 id 会与已有 id 冲突。
 */
describe('外壳中仍在运行的终端按项目恢复页签', () => {
  const reset = () => {
    for (const ws of [WS_A, WS_B]) {
      setWorkspace(ws)
      for (const t of panelTabs()) closePanelTab(t.id)
    }
    setWorkspace(WS_A)
    setSidePanel('files')
  }

  test('两个项目的记录均建立，当前项目只显示自己的条目', () => {
    reset()
    restoreTerminalTabs([
      { id: 'terminal-41', workspaceId: WS_A.id, createdSeq: 1 },
      { id: 'terminal-42', workspaceId: WS_B.id, createdSeq: 2 },
    ])
    expect(panelTabs().map((t) => t.id)).toEqual(['terminal-41'])
    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(['terminal-42'])
  })

  test('没有活动项目时仍按记录恢复，切换进入后即可看到', () => {
    reset()
    setWorkspace(null)
    restoreTerminalTabs([{ id: 'terminal-51', workspaceId: WS_B.id, createdSeq: 3 }])
    setWorkspace(WS_B)
    expect(panelTabs().map((t) => t.id)).toEqual(['terminal-51'])
  })

  test('新建页的序号高于整份清单的最大值，包括其他项目的条目', () => {
    reset()
    restoreTerminalTabs([
      { id: 'terminal-70', workspaceId: WS_A.id, createdSeq: 4 },
      { id: 'terminal-99', workspaceId: WS_B.id, createdSeq: 5 },
    ])
    openPanelTab('terminal')
    expect(panelTabs().map((t) => t.id)).toEqual(['terminal-70', 'terminal-100'])
  })

  /**
   * 原始失败形状：整页刷新后终端清单与浏览器清单分别异步返回，先到达的清单整体排在
   * 前面，页签顺序与刷新前不同。判据是两种到达顺序得到相同的页签条。
   */
  test('两份清单以相反顺序返回时，页签仍按创建顺序排列', () => {
    // 外壳中的创建顺序：终端、浏览器、终端、浏览器，序号由外壳进程统一分配。
    const terminals = [
      { id: 'terminal-201', workspaceId: WS_A.id, createdSeq: 201 },
      { id: 'terminal-203', workspaceId: WS_A.id, createdSeq: 203 },
    ]
    const browsers = [
      { id: 'bt_202', title: '浏览器 202', workspaceId: WS_A.id, createdSeq: 202 },
      { id: 'bt_204', title: '浏览器 204', workspaceId: WS_A.id, createdSeq: 204 },
    ]
    const created = ['terminal-201', 'bt_202', 'terminal-203', 'bt_204']

    reset()
    restoreTerminalTabs(terminals)
    syncBrowserTabs(browsers)
    expect(panelTabs().map((t) => t.id)).toEqual(created)

    reset()
    syncBrowserTabs(browsers)
    restoreTerminalTabs(terminals)
    expect(panelTabs().map((t) => t.id)).toEqual(created)
  })
})

/**
 * 原始失败形状：整页刷新后右侧面板收起，打开的画布页消失。
 *
 * 刷新以「`flushSession`（即 `pagehide`）+ 以带查询串的路径重新导入 `store/ui.ts`」模拟：
 * Bun 为不同的查询串建立新的模块实例，其中的信号按记录重新建立初值，与刷新后模块重新求值相同。
 */
let refreshes = 0
async function refresh(): Promise<typeof import('./store/ui.ts')> {
  flushSession()
  refreshes += 1
  return import(`./store/ui.ts?refresh=${refreshes}`)
}

describe('整页刷新后恢复页面状态', () => {
  const reset = () => {
    for (const ws of [WS_A, WS_B]) {
      setWorkspace(ws)
      for (const t of panelTabs()) closePanelTab(t.id)
      setSidePanel(null)
    }
    setWorkspace(WS_A)
  }

  test('工作区、画布页、当前页与放大态按刷新前恢复', async () => {
    reset()
    openCanvasTab('分镜.canvas.json', '分镜')
    togglePanelMax()
    const ui = await refresh()
    expect(ui.workspace()?.id).toBe(WS_A.id)
    expect(ui.panelTabs().map((t) => t.path)).toEqual(['分镜.canvas.json'])
    expect(ui.activePanelTab()).toBe('canvas-分镜.canvas.json')
    expect(ui.panelMaximized()).toBe(true)
    closePanel()
  })

  test('当前页是终端页时按原样恢复，终端仍存在时保留', async () => {
    reset()
    openCanvasTab('a.canvas.json', 'a')
    openPanelTab('terminal')
    const id = activePanelTab()!
    const ui = await refresh()
    ui.restoreTerminalTabs([{ id, workspaceId: WS_A.id, createdSeq: 1 }])
    expect(ui.panelTabs().map((t) => t.kind)).toEqual(['canvas', 'terminal'])
    expect(ui.activePanelTab()).toBe(id)
  })

  test('刷新期间结束的终端在对账时移除，当前页改为相邻页', async () => {
    reset()
    openCanvasTab('a.canvas.json', 'a')
    openPanelTab('terminal')
    const ui = await refresh()
    ui.restoreTerminalTabs([])
    expect(ui.panelTabs().map((t) => t.kind)).toEqual(['canvas'])
    expect(ui.activePanelTab()).toBe('canvas-a.canvas.json')
  })

  test('刷新后新建的页 id 不与恢复的页重复，且排在末尾', async () => {
    reset()
    openPanelTab('preview')
    openCanvasTab('b.canvas.json', 'b')
    const ui = await refresh()
    const before = ui.panelTabs().map((t) => t.id)
    expect(before).toHaveLength(2)
    ui.openPanelTab('preview')
    const after = ui.panelTabs().map((t) => t.id)
    expect(after.slice(0, -1)).toEqual(before)
    expect(before).not.toContain(after.at(-1))
  })

  test('上次显示的页、左栏收起、设置类目、打开的文件与折叠状态', async () => {
    reset()
    openFileInPanel('src/a.ts')
    openPanel('changes')
    closePanel()
    toggleSidebar()
    openSettings('usage')
    setFoldOpen('fold-1', true)
    const ui = await refresh()
    expect(ui.sidePanel()).toBe(null)
    expect(ui.sidebarCollapsed()).toBe(true)
    expect(ui.settingsPage()).toBe('usage')
    expect(ui.openFile()).toBe('src/a.ts')
    expect(ui.foldOpen('fold-1')).toBe(true)
    ui.togglePanel()
    expect(ui.sidePanel()).toBe('changes')
    toggleSidebar()
    closeSettings()
    setOpenFile(null)
  })
})

describe('整页刷新后回到刷新前的会话', () => {
  const conv = (id: string) => ({
    id,
    workspaceId: WS_A.id,
    title: '',
    provider: 'p',
    model: 'm',
    compactionManifest: null,
    cacheGeneration: 0,
    source: null,
    sourceRef: null,
    createdAt: 1,
    updatedAt: 1,
  })

  test('记录中的会话仍在列表中时选中它，否则选第一条', async () => {
    let list = [conv('cv_r1'), conv('cv_r2')]
    const before = client.api
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p) => {
      if (p.startsWith('/api/conversations?') || p === '/api/conversations') {
        return { conversations: list }
      }
      if (p.includes('/queue')) return { queue: [] }
      return { messages: [], runs: [], steps: [], todos: [], workflowStarts: [], nextCursor: null }
    }
    try {
      setWorkspace(WS_A)
      await selectConversation('cv_r2')
      flushSession()
      // 刷新后内存中没有当前会话。
      setState({ activeConversation: null })
      await loadConversations()
      expect(state.activeConversation).toBe('cv_r2')

      list = [conv('cv_r1')]
      setState({ activeConversation: null })
      await loadConversations()
      expect(state.activeConversation).toBe('cv_r1')
    } finally {
      ;(client as unknown as { api: typeof client.api }).api = before
      setState({ activeConversation: null })
    }
  })
})

describe('将接口错误转换为可读的说明', () => {
  const err = (body: unknown) =>
    new Error(`422 /api/config: ${typeof body === 'string' ? body : JSON.stringify(body)}`)

  test('提取 problems 数组，逐条列出不合格项', () => {
    const msg = explainApiError(
      err({ error: 'invalid', problems: ['缺 model', '缺 baseUrl'] }),
      '保存失败',
    )
    expect(msg).toBe('缺 model；缺 baseUrl')
  })

  test('没有 problems 时使用 message', () => {
    expect(explainApiError(err({ message: '档案不存在' }), '保存失败')).toBe('档案不存在')
  })

  test('problems 优先于 message', () => {
    expect(explainApiError(err({ problems: ['甲'], message: '乙' }), 'x')).toBe('甲')
  })

  test('空的 problems 数组视为不存在，继续读取 message', () => {
    expect(explainApiError(err({ problems: [], message: '乙' }), 'x')).toBe('乙')
  })

  test('响应体被截断而无法解析时返回原文而不是通用提示：原文仍包含有效信息', () => {
    const raw = '422 /api/config: {"problems":["缺 mod'
    expect(explainApiError(new Error(raw), '保存失败')).toBe(raw)
  })

  test('非 JSON 的错误原样返回', () => {
    expect(explainApiError(new Error('fetch failed'), '保存失败')).toBe('fetch failed')
  })

  test('抛出值不是 Error 时也能正常处理', () => {
    expect(explainApiError('炸了', '保存失败')).toBe('炸了')
  })

  test('仅在消息为空时使用默认文案', () => {
    expect(explainApiError(new Error(''), '保存失败')).toBe('保存失败')
  })
})

/**
 * 事件的会话归属校验（`store/connection.ts` 的 `applyEvent`）。
 *
 * 本组锁定的症状：切换会话后显示的正文属于上一条会话，偶尔还会无响应。
 * 根因不在切换逻辑中：服务端的订阅过滤无法覆盖 `subscribe` 指令的往返时间窗口，
 * 该窗口必然存在，因此接收端必须自行判定一次。
 *
 * 断言采用原始失败形状：输入一条其他会话的事件，检查当前会话的投影是否被污染。
 */
describe('事件按会话归属过滤', () => {
  const reset = (activeConversation: string | null) => {
    setWorkspace(WS_A)
    setState({ activeConversation, conversations: [], busyConversations: [], todos: [] })
    if (activeConversation) freshView(activeConversation)
  }

  const deltaFrame = (conversationId: string | undefined, delta: string) =>
    ({
      seq: 1,
      at: 0,
      ...(conversationId ? { conversationId } : {}),
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta },
    }) as never

  test('其他会话的正文不写入当前 transcript：对应症状「切了还是上一条」', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_other', '别人的话'))
    expect(transcript()).toHaveLength(0)
  })

  /**
   * 右侧打开的子会话页同时接收事件。
   *
   * 原始失败形状：子 agent 运行时该页没有任何内容，其帧因不属于当前会话被整帧丢弃。
   * 该页打开时，帧必须写入该页自己的投影，且不得写入当前会话的投影。
   *
   * 使用真实路径：打开页 → `syncViews` 建表并上报订阅。直接用 `openView` 建的表会在
   * 下一次 `syncViews` 时被撤销，因为没有任何页打开它。
   */
  test('子会话页打开时，其帧写入该页自己的投影', () => {
    reset('cv_now')
    openConversationTab('cv_child', '子 agent')
    syncViews()
    applyEvent(deltaFrame('cv_child', '子 agent 在写的话'))
    applyEvent({
      seq: 3,
      at: 0,
      conversationId: 'cv_child',
      event: {
        type: 'todos',
        runId: 'run_1',
        todos: [{ id: 'todo_1', content: '子任务自己的清单', status: 'in_progress' }],
      },
    } as never)
    applyEvent({
      seq: 4,
      at: 0,
      conversationId: 'cv_child',
      event: {
        type: 'usage',
        runId: 'run_1',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          currency: 'USD',
          turns: [],
        },
      },
    } as never)
    applyEvent({
      seq: 5,
      at: 0,
      conversationId: 'cv_child',
      event: {
        type: 'run.retrying',
        runId: 'run_1',
        requestId: 'pr_child',
        attempt: 2,
        max: 5,
        backoffMs: 2000,
        at: 1000,
        failedThinkingStepIds: [],
      },
    } as never)

    expect(
      viewOf('cv_child')
        .transcript.map((t) => t.text)
        .join(''),
    ).toContain('子 agent 在写的话')
    // 当前会话的投影不得增加任何内容。
    expect(transcript()).toHaveLength(0)
    expect(state.todos).toHaveLength(0)
    expect(viewOf('cv_child').usage?.inputTokens).toBe(12)
    expect(viewOf('cv_child').request).toMatchObject({ attempt: 2, max: 5, phase: 'backoff' })
    expect(view().usage).toBe(null)
    expect(view().request).toBe(null)
    closePanelTab('conversation-cv_child')
    syncViews()
  })

  test('新派发的单个子 agent 只在卡片的规范字段中保存子会话 id', () => {
    reset('cv_parent')
    applyEvent({
      seq: 1,
      at: 0,
      conversationId: 'cv_parent',
      event: {
        type: 'tool.started',
        runId: 'run_parent',
        stepId: 'st_delegate',
        toolName: 'subagent',
        args: { agent: 'glm-racer', task: '复验' },
        action: { kind: 'run', objectLabel: '子 agent', target: 'glm-racer' },
      },
    } as never)
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_parent',
      event: {
        type: 'team.member',
        runId: 'run_parent',
        stepId: 'st_delegate',
        nodeId: 'child',
        state: { phase: 'working', label: 'GLM 赛车开发者', subagentId: 'cv_child_live' },
      },
    } as never)

    const card = transcript().find((item) => item.id === 'st_delegate')
    expect(card?.nodes?.child).toEqual({
      phase: 'working',
      label: 'GLM 赛车开发者',
      subagentId: 'cv_child_live' as never,
    })
  })

  test('子会话历史中的待办不另建顶部投影，也不写入父会话清单', async () => {
    reset('cv_now')
    openConversationTab('cv_child_done', '已完成的子 agent')
    syncViews()
    const apiBefore = client.api
    ;(client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
      if (!path.includes('/cv_child_done/history')) throw new Error(`未预期请求：${path}`)
      return {
        messages: [],
        runs: [],
        steps: [],
        todos: [{ id: 'todo_1', content: '已经做完', status: 'completed' }],
        workflowStarts: [],
        nextCursor: null,
      }
    }

    try {
      await loadConversationView('cv_child_done')
    } finally {
      ;(client as unknown as { api: typeof client.api }).api = apiBefore
    }

    expect('todos' in viewOf('cv_child_done')).toBe(false)
    expect(state.todos).toHaveLength(0)
    closePanelTab('conversation-cv_child_done')
    syncViews()
  })

  /** 子会话页关闭后到达的帧没有写入目标，整帧丢弃，不得写入当前会话。 */
  test('子会话页关闭后，其帧不再写入任何投影', () => {
    reset('cv_now')
    openConversationTab('cv_child', '子 agent')
    syncViews()
    closePanelTab('conversation-cv_child')
    syncViews()
    applyEvent(deltaFrame('cv_child', '关掉之后又来的话'))
    applyEvent({
      seq: 3,
      at: 0,
      conversationId: 'cv_child',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(transcript()).toHaveLength(0)
    expect(viewOf('cv_child').transcript).toHaveLength(0)
  })

  test('当前会话的正文正常写入', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_now', '我的话'))
    // 正文经由匀速呈现，断言前先清空一次缓冲：flush 由下一条非 delta 事件触发。
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(
      transcript()
        .map((t) => t.text)
        .join(''),
    ).toContain('我的话')
  })

  /**
   * `git.state` 由服务端在握手、切换项目、`.git/HEAD` 变化时广播。它不写入 transcript，
   * 无需清空正文缓冲；清空的结果是正文匀速输出一段后，在该事件到达时把积压的数十个字
   * 一次性输出。
   */
  test('git 轮询不清空正文缓冲', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_now', '正在写的一段话'))
    applyEvent({
      seq: 2,
      at: 0,
      event: { type: 'git.state', workspaceId: 'ws_1', branch: 'master' },
    } as never)
    expect(transcript()).toHaveLength(0)

    // 需要写入 transcript 的事件仍须先清空缓冲，否则读数条会插在正文中间。
    applyEvent({
      seq: 3,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(
      transcript()
        .map((t) => t.text)
        .join(''),
    ).toContain('正在写的一段话')
  })

  test('没有归属的事件属于工作区级事件，正常处理', () => {
    reset('cv_now')
    applyEvent({
      seq: 3,
      at: 0,
      event: {
        type: 'run.error',
        runId: 'run_1',
        code: 'internal_error',
        message: '工作区级错误',
      },
    } as never)
    expect(view().error?.message).toBe('工作区级错误')
  })

  test('其他会话的 run.started 不写入当前会话的 run 投影', () => {
    reset('cv_now')
    setState({ lastRunId: null })
    applyEvent({
      seq: 4,
      at: 0,
      conversationId: 'cv_other',
      event: {
        type: 'run.started',
        runId: 'run_x',
        conversationId: 'cv_other',
        model: 'm',
        userMessageId: null,
      },
    } as never)
    expect(state.lastRunId).toBe(null)
    // 运行时刻与账本重取标识必须保持会话归属。
    expect(view().runStartedAt).toBe(null)
  })

  /*
   * 服务端自行发起的轮次（目标自动继续、定时触发、跟进消息自动发送）没有客户端的
   * 乐观插入，用户消息只能取自 `run.started` 携带的正文。
   *
   * 真机上的失败形状：排队的消息执行完毕后自动开始下一轮，账本中有该消息，
   * 也有模型的回答，唯独用户消息不在界面上，刷新一次后才出现。
   */
  const runStarted = (
    conversationId: string,
    userMessageId: string | null,
    userMessage: { content: string } | null,
  ) =>
    ({
      seq: 9,
      at: 0,
      conversationId,
      event: {
        type: 'run.started',
        runId: 'run_f',
        conversationId,
        model: 'm',
        userMessageId,
        userMessage,
      },
    }) as never

  test('服务端自行发起的轮次，用户消息由 run.started 补充', () => {
    reset('cv_now')
    applyEvent(runStarted('cv_now', 'ms_1', { content: '排着的那一句' }))
    expect(transcript().map((i) => [i.kind, i.text, i.id])).toEqual([
      ['user', '排着的那一句', 'ms_1'],
    ])
  })

  test('按回车发送的消息不因此重复，且 id 替换为账本中的实际值', () => {
    reset('cv_now')
    setState('views', 'cv_now', 'transcript', [{ id: 'local_1', kind: 'user', text: '我打的那句' }])
    applyEvent(runStarted('cv_now', 'ms_2', { content: '我打的那句' }))
    expect(transcript()).toHaveLength(1)
    // id 对齐后，实时投影的条目与刷新后从账本投影的条目使用同一个键。
    expect(transcript()[0]?.id).toBe('ms_2')
  })

  /*
   * 原始失败形状：定时任务每次发送同一句 prompt，第二轮的 `run.started` 认领了上一轮
   * 已落库的气泡，界面上缺少本轮的用户消息。只与 `local_` 前缀的条目对齐即可避免。
   */
  test('同一会话连续两次相同正文的 run.started 生成两条用户气泡', () => {
    reset('cv_now')
    applyEvent(runStarted('cv_now', 'ms_1', { content: '检查一次群消息' }))
    applyEvent(runStarted('cv_now', 'ms_2', { content: '检查一次群消息' }))
    expect(transcript().map((i) => [i.kind, i.text, i.id])).toEqual([
      ['user', '检查一次群消息', 'ms_1'],
      ['user', '检查一次群消息', 'ms_2'],
    ])
  })

  /**
   * 忙闲状态相反：它是工作区级事件，其他会话的忙闲必须接收，左栏需要为列表中
   * 每一条会话显示状态。原始失败形状是「只有打开的那条会话显示转圈，其他会话在运行也看不出来」。
   */
  test('其他会话的忙闲状态正常接收，左栏据此标记对应行', () => {
    reset('cv_now')
    applyEvent({
      seq: 5,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_other', busy: true },
    } as never)
    expect(state.busyConversations).toEqual(['cv_other'])
    // 当前会话未在运行，输入框不得变为停止按钮。
    expect(isRunning()).toBe(false)

    applyEvent({
      seq: 6,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_other', busy: false },
    } as never)
    expect(state.busyConversations).toEqual([])
  })

  /**
   * 开始前被拒绝的一轮如何结束。服务端在 run 建立之前拒绝时不发送 `run.finished`
   * （约定写在 `RunErrorEvent` 上），终态只有 `conversation.busy: false`。
   *
   * 原始失败形状：按下回车时客户端乐观置为忙，若只依据 `run.finished` 清除，
   * 忙状态永远不会清除，输入框停留在停止按钮。
   */
  test('未配置 key 被拒绝时，run.error 不清除忙状态，由随后的忙闲事件清除', () => {
    reset('cv_now')
    // 按下回车时的乐观置忙（与 `sendMessage` 使用同一张表）。
    setState('busyConversations', ['cv_now'])
    applyEvent({
      seq: 7,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'run.error', runId: '', code: 'no_api_key', message: '未配置 API Key' },
    } as never)
    expect(view().error?.message).toBe('未配置 API Key')
    expect(isRunning()).toBe(true)

    applyEvent({
      seq: 8,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_now', busy: false },
    } as never)
    expect(isRunning()).toBe(false)
  })

  /**
   * 被拒绝的指令如何结束。服务端从未将其置为忙，因此不会有任何 `conversation.busy`
   * 清除按回车时乐观设置的忙状态，冲销只能依据「该指令被拒绝」这一事实。
   *
   * 原始失败形状：应用更新期间按回车，指令被拒绝，输入框停留在停止按钮，
   * 直到重连后由握手快照重置。
   */
  const captureSend = () => {
    const sent: { type: string; clientRequestId?: string }[] = []
    const before = client.send
    ;(client as unknown as { send: (cmd: unknown) => void }).send = (cmd) => {
      sent.push(cmd as { type: string })
    }
    return {
      requestId: () => sent.find((c) => c.type === 'message.send')?.clientRequestId ?? '',
      restore: () => {
        ;(client as unknown as { send: typeof before }).send = before
      },
    }
  }

  const rejection = (clientRequestId?: string) =>
    ({
      type: 'command.rejected',
      command: 'message.send',
      reason: 'conflict',
      message: '应用正在更新，请稍后重试',
      ...(clientRequestId ? { clientRequestId } : {}),
    }) as never

  test('指令被拒绝时，其预先设置的忙状态恢复为闲', () => {
    reset('cv_now')
    const sent = captureSend()
    try {
      sendMessage('更新完再说')
    } finally {
      sent.restore()
    }
    expect(isRunning()).toBe(true)

    applyRejected(rejection(sent.requestId()))
    expect(isRunning()).toBe(false)
    expect(state.notice?.message).toBe('应用正在更新，请稍后重试')
  })

  test('会话已在运行时后发的指令被拒绝，状态仍为忙', () => {
    reset('cv_now')
    // 服务端先置为忙：该忙状态不是客户端预先设置的，指令被拒绝时不得修改。
    setState('busyConversations', ['cv_now'])
    const sent = captureSend()
    try {
      sendMessage('顺带看看日志')
    } finally {
      sent.restore()
    }

    applyRejected(rejection(sent.requestId()))
    expect(isRunning()).toBe(true)
    // 不带幂等键的指令（如 `followup.steer`）被拒绝时同样不修改忙闲状态。
    applyRejected(rejection())
    expect(isRunning()).toBe(true)
  })

  /** 断线时客户端自行合成的回执使用同一冲销路径，且携带同一个幂等键。 */
  test('连接断开时按回车：消息未发出，界面不保留忙状态', () => {
    reset('cv_now')
    sendMessage('在吗')
    expect(state.notice?.reason).toBe('not_ready')
    expect(isRunning()).toBe(false)
  })

  /*
   * ── 当前请求投影：阶段、次数、退避截止点与最后内容时刻 ──
   *
   * 服务端不发送配对的「重发结束」事件（理由在 `RunRetryingEvent` 上），
   * 结束依据下一条 `run.request`。本组锁定阶段推进：不推进时，
   * 整轮执行完毕后阶段字段仍停留在「正在重连 3 / 5」。
   */
  let projectionSeq = 0
  const retryFrame = (attempt: number, backoffMs = 60_000, at = 1_000) =>
    ({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.retrying',
        runId: 'run_1',
        requestId: 'pr_fail_' + attempt,
        attempt,
        max: 5,
        backoffMs,
        at,
        failedThinkingStepIds: [],
      },
    }) as never

  const requestFrame = (phase: 'sent' | 'headers', attempt: number, at = 2_000) =>
    ({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.request',
        runId: 'run_1',
        requestId: 'pr_send_' + attempt,
        phase,
        attempt,
        max: 5,
        at,
      },
    }) as never

  const contentFrame = (at: number, conversationId = 'cv_now') =>
    ({
      seq: ++projectionSeq,
      at: 0,
      conversationId,
      event: { type: 'tool.generating', runId: 'run_1', at },
    }) as never

  test('退避事件写入阶段、次数与截止点', () => {
    reset('cv_now')
    applyEvent(retryFrame(3))
    expect(viewOf('cv_now').request).toMatchObject({
      requestId: 'pr_fail_3',
      attempt: 3,
      max: 5,
      phase: 'backoff',
      backoffUntil: 61_000,
    })
  })

  test('重发时按 AgentLoop 给出的 step id 撤销失败的部分输出，已完成的思考不受影响', () => {
    reset('cv_now')
    applyEvent({
      seq: 1,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'thinking.delta',
        runId: 'run_1',
        stepId: 'st_done',
        delta: '前一轮思考',
        at: 1,
      },
    } as never)
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'thinking.delta',
        runId: 'run_1',
        stepId: 'st_failed',
        delta: '失败的半截',
        at: 2,
      },
    } as never)
    applyEvent({
      seq: 3,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.retrying',
        runId: 'run_1',
        requestId: 'pr_fail_1',
        attempt: 1,
        max: 5,
        backoffMs: 0,
        at: 3,
        failedThinkingStepIds: ['st_failed'],
      },
    } as never)

    expect(
      viewOf('cv_now')
        .transcript.filter((item) => item.kind === 'thinking')
        .map((item) => item.id),
    ).toEqual(['st_done'])
  })

  /** 请求发出只结束等待：清除截止点、保留次数，界面因此从「等待重试」变为「正在重连 N / M」。 */
  test('下一次请求发出时结束退避，次数保留到该次请求', () => {
    reset('cv_now')
    applyEvent(retryFrame(2))
    applyEvent(requestFrame('sent', 2))
    expect(viewOf('cv_now').request).toMatchObject({
      phase: 'sent',
      attempt: 2,
      max: 5,
      backoffUntil: null,
      sentAt: 2_000,
    })
    applyEvent(requestFrame('headers', 2, 2_400))
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'headers', headersAt: 2_400 })
  })

  test('工具参数进度推进内容时刻，不提前创建工具步骤', () => {
    discardPace()
    reset('cv_now')
    applyEvent(requestFrame('sent', 0))
    applyEvent(contentFrame(3_000))
    expect(viewOf('cv_now').generatingToolCall).toBe(true)
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'content', lastContentAt: 3_000 })
    expect(viewOf('cv_now').transcript).toHaveLength(0)

    applyEvent(retryFrame(2))
    expect(viewOf('cv_now').generatingToolCall).toBe(false)
    applyEvent(contentFrame(4_000))
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'run.finished', runId: 'run_1', stopReason: 'user_interrupt', usage: null },
    } as never)
    expect(viewOf('cv_now').generatingToolCall).toBe(false)
    expect(viewOf('cv_now').request).toBe(null)
  })

  test('子会话参数进度不改变主会话的阶段或内容时刻', () => {
    reset('cv_now')
    openConversationTab('cv_child_progress', '子会话')
    syncViews()
    applyEvent(requestFrame('sent', 0))
    applyEvent(contentFrame(5_000, 'cv_child_progress'))
    expect(viewOf('cv_child_progress').generatingToolCall).toBe(true)
    expect(viewOf('cv_now').generatingToolCall).toBe(false)
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'sent', lastContentAt: null })
    closePanelTab('conversation-cv_child_progress')
    syncViews()
  })

  /** 服务端不为心跳与空增量发送内容事件，因此界面不修改任何字段。 */
  test('工作区级事件不推进阶段：后台的文件改动不得清除当前阶段文字', () => {
    reset('cv_now')
    applyEvent(retryFrame(2))
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      event: { type: 'git.state', workspaceId: 'ws_1', branch: 'master' },
    } as never)
    expect(viewOf('cv_now').request).toMatchObject({ attempt: 2, phase: 'backoff' })
  })

  test('额度用尽导致整轮报错时清空投影', () => {
    reset('cv_now')
    applyEvent(retryFrame(5))
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.error',
        runId: 'run_1',
        code: 'network_error',
        message: '连接被断开，已重发 5 次',
      },
    } as never)
    expect(viewOf('cv_now').request).toBe(null)
  })

  /**
   * 旧请求迟到的内容事件不得使新请求的阶段回退。序号小于投影上的序号时丢弃，
   * 该规则同时拦截「旧快照晚于新事件返回」的情况。
   */
  test('序号更小的迟到事件不能使已推进的阶段回退', () => {
    reset('cv_now')
    const late = contentFrame(6_000)
    applyEvent(requestFrame('sent', 1))
    applyEvent(late)
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'sent', lastContentAt: null })
  })

  /**
   * 一轮结束后到达的工作区级事件与 `goal` 不属于任何一次请求，不得凭空生成阶段。
   * `run.started` 同样不生成：阶段只由 `run.request` 写入，它表示请求已实际发出。
   */
  test('结束后到达的工作区级事件、goal 与 run.started 均不生成请求阶段', () => {
    reset('cv_now')
    applyEvent(requestFrame('sent', 0))
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'run.finished', runId: 'run_1', stopReason: 'end_turn', usage: null },
    } as never)
    expect(viewOf('cv_now').request).toBe(null)
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      event: { type: 'git.state', workspaceId: 'ws_1', branch: 'master' },
    } as never)
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'goal', goal: null },
    } as never)
    applyEvent({
      seq: ++projectionSeq,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.started',
        runId: 'run_2',
        conversationId: 'cv_now',
        model: 'm',
        userMessageId: null,
      },
    } as never)
    expect(viewOf('cv_now').request).toBe(null)
    applyEvent(requestFrame('sent', 0, 7_000))
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'sent', sentAt: 7_000 })
  })

  /**
   * 另一方面：`conversation.updated` 修改的是左栏列表，不是 transcript，
   * 对后台会话同样有意义。一律按当前会话丢弃时，后台会话的标题会一直停留在「新对话」。
   */
  test('后台会话的属性变更仍写入列表', () => {
    reset('cv_now')
    setState('conversations', [
      { id: 'cv_now', title: '当前', model: 'a', effort: null } as never,
      { id: 'cv_other', title: '新对话', model: 'a', effort: null } as never,
    ])
    applyEvent({
      seq: 5,
      at: 0,
      conversationId: 'cv_other',
      event: {
        type: 'conversation.updated',
        conversationId: 'cv_other',
        model: 'b',
        effort: null,
        title: '改过的标题',
      },
    } as never)
    expect(state.conversations.find((c) => c.id === 'cv_other')?.title).toBe('改过的标题')
    expect(state.conversations.find((c) => c.id === 'cv_now')?.title).toBe('当前')
  })

  /*
   * 服务端自行创建的会话（定时任务认领）须立即出现在左栏。它是工作区级事件：
   * 信封不带归属，按归属路由会被整帧丢弃，而列表中原本没有该会话。
   */
  const created = (id: string, workspaceId: string) =>
    ({
      seq: 7,
      at: 0,
      event: {
        type: 'conversation.created',
        conversation: {
          id,
          workspaceId,
          title: '定时任务',
          provider: 'p',
          model: 'm',
          compactionManifest: null,
          cacheGeneration: 0,
          source: null,
          sourceRef: null,
          externalSession: null,
          parentConversationId: null,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    }) as never

  test('本项目新建的会话插入列表顶部', () => {
    reset('cv_now')
    setState('conversations', [{ id: 'cv_now', title: '当前', model: 'a' } as never])
    applyEvent(created('cv_made', WS_A.id))
    expect(state.conversations.map((c) => String(c.id))).toEqual(['cv_made', 'cv_now'])
  })

  test('其他项目新建的会话不进入本列表', () => {
    reset('cv_now')
    setState('conversations', [{ id: 'cv_now', title: '当前', model: 'a' } as never])
    applyEvent(created('cv_elsewhere', WS_B.id))
    expect(state.conversations.map((c) => String(c.id))).toEqual(['cv_now'])
  })

  test('同一会话重复到达时不重复插入', () => {
    reset('cv_now')
    setState('conversations', [])
    applyEvent(created('cv_made', WS_A.id))
    applyEvent(created('cv_made', WS_A.id))
    expect(state.conversations.map((c) => String(c.id))).toEqual(['cv_made'])
  })
})

/**
 * 运行面板的重新获取判据（`store/state.ts` 的 `ledgerRevision`）。
 *
 * 原始失败形状：一轮运行了十分钟，运行面板上的步数、金额、逐请求表停留在开始执行时：
 * 判据只包含会话与忙闲，而账本每写入一步、每次 usage 回报都在变化。
 * 因此断言的是「账本变化时修订号随之变化」，不是「重新获取了几次」。
 */
describe('账本修订号随落库更新', () => {
  const startRun = () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    applyEvent({
      seq: 1,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'run.started',
        runId: 'run_1',
        conversationId: 'cv_1',
        model: 'm',
        userMessageId: null,
      },
    } as never)
  }

  test('每写入一步更新一次修订号', () => {
    startRun()
    const before = ledgerRevision()
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'tool.started',
        stepId: 'st_1',
        toolName: 'read_file',
        action: { kind: 'read', target: 'a.ts' },
        args: {},
        batchId: 'b_1',
        waveIndex: 0,
      },
    } as never)
    expect(ledgerRevision()).not.toBe(before)
  })

  test('provider 每回报一次用量更新一次修订号', () => {
    startRun()
    const before = ledgerRevision()
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'usage',
        runId: 'run_1',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          cost: 0.001,
          currency: 'USD',
          turns: [{ turnIndex: 0 }],
        },
      },
    } as never)
    expect(ledgerRevision()).not.toBe(before)
  })

  /** 只有活动、没有落库的事件不得更新修订号，否则重新获取的频率会升至 token 频率。 */
  test('当前请求的内容时刻变化时不更新修订号', () => {
    startRun()
    const before = ledgerRevision()
    setState('views', 'cv_1', 'request', {
      requestId: 'pr_rev',
      attempt: 0,
      max: 5,
      phase: 'content',
      backoffUntil: null,
      sentAt: 1,
      headersAt: 2,
      lastContentAt: 123456,
      seq: 1,
    })
    expect(ledgerRevision()).toBe(before)
  })
})

/** 文件快照统一失效；它与展示给用户的逐路径变更摘要不是同一份状态。 */
describe('文件快照失效序号', () => {
  const changed = (seq: number, path: string, additions: number, deletions: number) =>
    applyEvent({
      seq,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'file.changed',
        runId: 'run_1',
        changes: [{ path, additions, deletions, changeType: 'modified' }],
      },
    } as never)

  test('每条事件推进一次，同一文件的连续修改也不遗漏', () => {
    setState({ activeConversation: 'cv_1', fileChanges: [], fileVersion: 0 })
    changed(1, 'src/main.ts', 3, 1)
    expect(state.fileVersion).toBe(1)
    changed(2, 'src/main.ts', 2, 0)
    expect(state.fileChanges.length).toBe(2)
    expect(state.fileVersion).toBe(2)
  })

  test('画布服务写入磁盘时的空 changes 只推进序号，不进入「本轮改动」', () => {
    setState({ activeConversation: 'cv_1', fileChanges: [], fileVersion: 0 })
    applyEvent({
      seq: 3,
      at: 0,
      event: { type: 'file.changed', runId: null, changes: [] },
    } as never)
    expect(state.fileVersion).toBe(1)
    expect(state.fileChanges.length).toBe(0)
  })
})

describe('画布运行事件', () => {
  const run = (seq: number, workspaceId: string) =>
    applyEvent({
      seq,
      at: 0,
      event: {
        type: 'canvas.run',
        workspaceId,
        path: 'a.canvas.json',
        nodeId: 'n1',
        state: 'done',
      },
    } as never)

  test('本项目的事件推进画布序号，其他项目的事件丢弃', () => {
    setWorkspace(WS_A)
    setState({ canvasVersion: 0 })
    run(1, WS_A.id)
    expect(state.canvasVersion).toBe(1)
    run(2, WS_B.id)
    expect(state.canvasVersion).toBe(1)
  })
})

/**
 * 刷新或重连后的会话投影（`store/connection.ts` 的 `reloadActiveConversation`）。
 *
 * 本组锁定「账本中有、界面上缺失」的一类问题。它们只出现在重新拉取路径上，
 * 实时路径正常，因此刷新之前无法察觉。
 *
 * 用模拟的 `client.api` 提供账本响应体，执行真实的折叠逻辑。
 */
describe('重新拉取会话：账本中的内容必须出现在界面上', () => {
  const stub = (steps: unknown[], runs: unknown[], workflowStarts: unknown[] = []) => {
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        return {
          messages: [
            {
              id: 'ms_1',
              conversationId: 'cv_1',
              role: 'user',
              content: '为什么动不了',
              attachments: [],
              createdAt: 1,
            },
          ],
          runs,
          steps: steps.map((step) => ({
            ...(step as Record<string, unknown>),
            runId: (runs[0] as { id?: string } | undefined)?.id ?? 'rn_1',
          })),
          todos: [],
          workflowStarts,
          nextCursor: null,
        }
      }
      throw new Error('没有上下文面板')
    }
  }

  const toolStep = () => ({
    id: 'st_1',
    seq: 1,
    kind: 'tool_action',
    toolName: 'run_command',
    content: null,
    payload: {
      kind: 'tool_result',
      args: { command: 'nvidia-smi -L' },
      action: { kind: 'run', objectLabel: '命令', target: 'nvidia-smi -L' },
    },
    status: 'success',
    createdAt: 2,
  })

  const interruptedRun = {
    id: 'rn_1',
    userMessageId: 'ms_1',
    createdAt: 1,
    finishedAt: 9,
    stopReason: 'user_interrupt',
    status: 'interrupted',
    usage: null,
  }

  test('独立的思考 step 折叠回会话流，位于工具卡之前', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    stub(
      [
        {
          id: 'st_thinking',
          seq: 0,
          kind: 'thinking',
          content: '先看看这台机器的显卡',
          payload: null,
          status: 'done',
          createdAt: 1,
        },
        toolStep(),
      ],
      [interruptedRun],
    )
    await reloadActiveConversation()

    expect(transcript().map((t) => t.kind)).toEqual(['user', 'thinking', 'tool', 'run'])
    expect(transcript()[1]?.text).toBe('先看看这台机器的显卡')
  })

  test('失败重发留下的部分思考只保留在诊断账本中，不折叠回普通会话流', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    stub(
      [
        {
          id: 'st_failed_thinking',
          seq: 0,
          kind: 'thinking',
          content: 'Note: index.html references vendor but the response stopped h',
          payload: null,
          status: 'failure',
          createdAt: 1,
        },
        {
          id: 'st_done_thinking',
          seq: 1,
          kind: 'thinking',
          content: '重发后完整的思考',
          payload: null,
          status: 'done',
          createdAt: 2,
        },
      ],
      [interruptedRun],
    )
    await reloadActiveConversation()

    expect(
      transcript()
        .filter((item) => item.kind === 'thinking')
        .map((item) => item.text),
    ).toEqual(['重发后完整的思考'])
  })

  test('没有思考的工具 step 不生成空的折叠条目', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    stub([toolStep()], [interruptedRun])
    await reloadActiveConversation()

    expect(transcript().map((t) => t.kind)).toEqual(['user', 'tool', 'run'])
  })

  test('运行中的子 agent 入口随 step 回放，不依赖已经错过的进度事件', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    stub(
      [
        {
          ...toolStep(),
          toolName: 'subagent',
          payload: {
            kind: 'tool_call',
            args: { task: '并行排查' },
            action: { kind: 'run', objectLabel: '子 agent' },
            nodes: { child: { phase: 'working', label: '子', subagentId: 'cv_child_replayed' } },
          },
          status: 'running',
        },
      ],
      [{ ...interruptedRun, finishedAt: null, stopReason: null, status: 'running' }],
    )
    await reloadActiveConversation()

    const card = transcript().find((item) => item.id === 'st_1')
    expect(card?.nodes?.child?.subagentId).toBe('cv_child_replayed' as never)
  })

  /**
   * 原始失败形状：图运行时刷新页面，正在运行的节点回到「等待执行」且无法打开，直到整批结束。
   * 运行期的 `team.member` 事件已经错过，该 step 的 `$.nodes` 是每个节点状态的唯一来源。
   */
  test('运行中的 workflow 节点入口按节点随 step 回放', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    stub(
      [
        {
          ...toolStep(),
          toolName: 'workflow',
          payload: {
            kind: 'tool_call',
            args: {
              goal: '四个候选',
              nodes: [
                { id: 'build-glm', task: '做 glm 版' },
                { id: 'build-qwen', task: '做 qwen 版' },
                {
                  id: 'audit',
                  kind: 'checkpoint',
                  label: '验收',
                  needs: ['build-glm', 'build-qwen'],
                },
              ],
            },
            action: { kind: 'run', objectLabel: '工作流' },
            nodes: {
              'build-glm': { phase: 'working', label: 'glm', subagentId: 'cv_glm' },
              'build-qwen': { phase: 'queued', label: 'qwen' },
            },
          },
          status: 'running',
        },
      ],
      [{ ...interruptedRun, finishedAt: null, stopReason: null, status: 'running' }],
    )
    await reloadActiveConversation()

    const card = transcript().find((item) => item.id === 'st_1')
    expect(
      Object.entries(card?.nodes ?? {}).map(([id, node]) => [id, node.subagentId, node.phase]),
    ).toEqual([
      ['build-glm', 'cv_glm', 'working'],
      ['build-qwen', undefined, 'queued'],
    ])
  })

  /**
   * 原始失败形状：续接调用所在的页中没有首次派发，图的结构无从获取，该卡片只剩「当前会话」一个节点。
   * 服务端将被引用的首次派发随页返回，前端先将其放入会话流，折叠时即可完整渲染。
   */
  test('页中只有续接调用时，随页返回的首次派发进入会话流，并折叠为一张带节点的卡片', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    const start = {
      ...toolStep(),
      id: 'st_wf',
      runId: 'rn_0',
      toolName: 'workflow',
      payload: {
        kind: 'tool_result',
        args: {
          goal: '目标',
          nodes: [
            { id: 'a', kind: 'temp', name: 'a', task: '做' },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
          ],
        },
        action: { kind: 'run', objectLabel: '工作流' },
        nodes: {
          a: { phase: 'done', label: 'a', subagentId: 'cv_a', durationMs: 3, output: '稿' },
        },
        outcome: {
          status: 'success',
          executed: true,
          message: '已起跑',
          data: { workflowId: 'st_wf', dispatched: ['a'] },
        },
      },
      status: 'success',
    }
    stub(
      [
        {
          ...toolStep(),
          toolName: 'workflow',
          payload: {
            kind: 'tool_result',
            args: { workflowId: 'st_wf', checkpointId: 'cp', decision: 'approve', note: '好' },
            action: { kind: 'run', objectLabel: '工作流' },
            outcome: {
              status: 'success',
              executed: true,
              message: '完成',
              data: {
                workflowId: 'st_wf',
                dispatched: [],
                review: { checkpointId: 'cp', decision: 'approve', note: '好' },
              },
            },
          },
          status: 'success',
        },
      ],
      [interruptedRun],
      [start],
    )
    await reloadActiveConversation()

    expect(transcript().map((item) => item.kind)).toEqual(['tool', 'user', 'tool', 'run'])
    expect(transcript()[0]?.id).toBe('st_wf')
    const { buildRenderItems } = await import('./render-items.ts')
    const cards = buildRenderItems(transcript()).filter((row) => row.kind === 'tool')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    if (card?.kind !== 'tool') throw new Error('没有卡')
    expect(card.item.id).toBe('st_wf')
    expect(card.item.workflow?.phase).toBe('completed')
    expect(card.item.workflow?.states.a).toMatchObject({ phase: 'done', subagentId: 'cv_a' })
    expect((card.item.args?.nodes as unknown[]).length).toBe(2)
  })

  /** 进入终态后，每个节点的状态仍从 step 回放：耗时与子会话入口都在 `nodes` 中。 */
  test('已结束的 workflow step 的节点状态随 step 回放', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    stub(
      [
        {
          ...toolStep(),
          toolName: 'workflow',
          payload: {
            kind: 'tool_result',
            args: { goal: '目标', nodes: [{ id: 'a', task: '做' }] },
            action: { kind: 'run', objectLabel: '工作流' },
            nodes: { a: { phase: 'done', label: 'a', subagentId: 'cv_a', durationMs: 5 } },
            outcome: { status: 'success', executed: true, message: '完成' },
          },
          status: 'success',
        },
      ],
      [interruptedRun],
    )
    await reloadActiveConversation()

    expect(transcript().find((item) => item.id === 'st_1')?.nodes?.a).toEqual({
      phase: 'done',
      label: 'a',
      subagentId: 'cv_a' as never,
      durationMs: 5,
    })
  })

  /** 被中断的 step 没有 transition，nodes 必须随条目一并输出，折叠时才能得到节点状态。 */
  test('被中断的 workflow step 将 nodes 写入条目', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    stub(
      [
        {
          ...toolStep(),
          toolName: 'workflow',
          payload: {
            kind: 'tool_result',
            args: {
              goal: '目标',
              nodes: [
                { id: 'a', task: '做' },
                { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
              ],
            },
            action: { kind: 'run', objectLabel: '工作流' },
            nodes: {
              a: { phase: 'interrupted', label: 'a', subagentId: 'cv_a', error: '调用中断' },
            },
            outcome: { status: 'failure', executed: true, message: '执行期间被中断，结果未知' },
          },
          status: 'failure',
        },
      ],
      [interruptedRun],
    )
    await reloadActiveConversation()

    const card = transcript().find((item) => item.id === 'st_1')
    expect(card?.nodes?.a).toMatchObject({ phase: 'interrupted', subagentId: 'cv_a' })
  })

  /**
   * 后台进程被终止后，账本中该轮已是 `interrupted`，界面须据此渲染该轮的收尾条目。
   * 「是否在运行」不从账本读取：进程崩溃后账本中的该行可能仍是
   * `running`，按其写入会使界面永久停留在执行中，而新进程的 `RunManager` 中
   * 没有该 run。清除运行状态的是握手上报的忙闲快照。
   */
  test('账本中该轮为中断状态时，重新拉取后显示收尾条目，运行状态不由账本决定', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    stub([toolStep()], [interruptedRun])
    await reloadActiveConversation()

    expect(isRunning()).toBe(false)
    expect(transcript().at(-1)?.run?.stopReason).toBe('user_interrupt')
  })

  /** 另一方面：账本中该行仍为 `running` 时，重新拉取也不得将界面恢复为执行中。 */
  test('账本中仍记为运行中、忙闲快照显示未运行时，以快照为准', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    stub(
      [toolStep()],
      [{ ...interruptedRun, finishedAt: null, stopReason: null, status: 'running' }],
    )
    await reloadActiveConversation()

    expect(isRunning()).toBe(false)
  })

  /**
   * 原始失败形状：一轮执行过程中重连，读数条上的 `↓入 ↑出 / 命中 / 金额` 整组消失，
   * 下一次模型调用回报 usage 后才重新出现。它不是易失值：`runs` 行有对应列，
   * 每收到一次 provider 的 usage 即写入一次。
   */
  test('运行中的一轮，用量随重新拉取一并恢复，不被清空', async () => {
    const liveRun = {
      ...interruptedRun,
      finishedAt: null,
      stopReason: null,
      status: 'running',
      usage: {
        inputTokens: 30_000,
        outputTokens: 27_000,
        cachedTokens: 900_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 0.02,
        currency: 'USD',
        turns: [],
      },
    }
    setState({
      activeConversation: 'cv_1',
      busyConversations: ['cv_1'],
    })
    freshView('cv_1')
    stub([toolStep()], [liveRun])
    await reloadActiveConversation()

    // 重新拉取不得清除忙闲表：它由握手快照与 `conversation.busy` 维护。
    expect(isRunning()).toBe(true)
    expect(viewOf('cv_1').usage?.inputTokens).toBe(30_000)
    expect(viewOf('cv_1').usage?.cost).toBe(0.02)
  })

  test('首屏与更早的页各只发送一个历史请求，前插后顺序正确', async () => {
    const id = 'cv_paged'
    setState({ activeConversation: id, todos: [] })
    freshView(id)
    const calls: string[] = []
    const apiBefore = client.api
    ;(
      client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string) => {
      calls.push(path)
      if (path.includes('/history')) {
        const older = path.includes('before=ms_3')
        const suffix = older ? '1' : '3'
        return {
          messages: [
            {
              id: `ms_${suffix}`,
              conversationId: id,
              role: 'user',
              content: older ? '更早的问题' : '最新的问题',
              attachments: [],
              createdAt: Number(suffix),
            },
          ],
          runs: [
            {
              id: `rn_${suffix}`,
              userMessageId: `ms_${suffix}`,
              createdAt: Number(suffix),
              finishedAt: Number(suffix) + 1,
              stopReason: 'completed',
              status: 'done',
              usage: null,
              errorMessage: null,
            },
          ],
          steps: [
            {
              id: `st_${suffix}`,
              runId: `rn_${suffix}`,
              seq: 1,
              kind: 'text',
              toolName: null,
              content: older ? '更早的回答' : '最新的回答',
              payload: null,
              status: 'done',
              createdAt: Number(suffix),
              durationMs: null,
            },
          ],
          todos: [{ id: 'todo-old', content: '跨页待办', status: 'pending' }],
          workflowStarts: [],
          nextCursor: older ? null : 'ms_3',
        }
      }
      if (path.includes('/context')) return { context: null }
      if (path.includes('/goal')) return { goal: null }
      if (path.includes('/queue')) return { queue: [] }
      throw new Error(`未预期请求：${path}`)
    }

    try {
      await reloadActiveConversation()
      expect(viewOf(id).history.nextCursor).toBe('ms_3')
      expect(state.todos.map((todo) => todo.content)).toEqual(['跨页待办'])
      expect(await loadOlderConversation(id)).toBe(true)
    } finally {
      ;(client as unknown as { api: typeof client.api }).api = apiBefore
    }

    expect(calls.filter((path) => path.includes('/history'))).toHaveLength(2)
    expect(calls.some((path) => path.includes('/api/runs/'))).toBe(false)
    expect(
      transcript()
        .filter((item) => item.kind === 'user')
        .map((item) => item.text),
    ).toEqual(['更早的问题', '最新的问题'])
    expect(viewOf(id).history.nextCursor).toBeNull()
  })

  test('从 A 快速切换到 B 时撤销 A 的请求，A 的迟到结果不得覆盖 B', async () => {
    const apiBefore = client.api
    let releaseStarted!: () => void
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })
    let aAborted = false
    ;(
      client as unknown as {
        api: (path: string, init?: RequestInit) => Promise<unknown>
      }
    ).api = async (path: string, init?: RequestInit) => {
      if (path.includes('/cv_a/history')) {
        releaseStarted()
        return await new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      if (path.includes('/cv_b/history')) {
        return {
          messages: [
            {
              id: 'ms_b',
              conversationId: 'cv_b',
              role: 'user',
              content: '这是 B',
              attachments: [],
              createdAt: 2,
            },
          ],
          runs: [],
          steps: [],
          todos: [],
          workflowStarts: [],
          nextCursor: null,
        }
      }
      if (path.includes('/context')) return { context: null }
      if (path.includes('/goal')) return { goal: null }
      if (path.includes('/queue')) return { queue: [] }
      throw new Error(`未预期请求：${path}`)
    }

    try {
      const loadingA = selectConversation('cv_a')
      await started
      const loadingB = selectConversation('cv_b')
      await Promise.all([loadingA, loadingB])
    } finally {
      ;(client as unknown as { api: typeof client.api }).api = apiBefore
    }

    expect(aAborted).toBe(true)
    expect(state.activeConversation).toBe('cv_b')
    expect(transcript().map((item) => item.text)).toEqual(['这是 B'])
    expect(viewOf('cv_b').history.error).toBeNull()
  })
})

/**
 * 当前目标（`store/connection.ts` 中的 `goal` 事件与重新拉取时的读取）。
 *
 * 两条路径都须锁定，因为二者互补：事件路径只在目标变更时
 * 发送一次，读取路径只在打开会话时执行一次。缺少读取路径时，进程重启后账本中的目标
 * 在界面上消失，而自动继续标记不落盘，该目标不会自动再次执行，
 * 只能等待用户点击继续。自动循环不可见时，用户无法判断它是否仍在运行。
 */
describe('当前目标：由事件推送，刷新后仍须存在', () => {
  const goal = {
    id: 'gl_1',
    conversationId: 'cv_1',
    objective: '把门禁跑绿',
    status: 'active',
    revision: 4,
    blockedCode: null,
    blockedReason: null,
    createdAt: 1,
    updatedAt: 2,
  }

  test('目标变更实时写入 state', () => {
    setState({ activeConversation: 'cv_1', goal: null })
    applyEvent({ seq: 1, at: 0, conversationId: 'cv_1', event: { type: 'goal', goal } } as never)
    expect(state.goal?.objective).toBe('把门禁跑绿')
  })

  test('其他会话的目标不写入当前会话', () => {
    setState({ activeConversation: 'cv_now', goal: null })
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_other',
      event: { type: 'goal', goal },
    } as never)
    expect(state.goal).toBeNull()
  })

  /**
   * 原始失败形状：目标因受阻而停止，用户刷新一次页面后，目标内容与停止原因
   * 在界面上都不存在，只剩一条看似正常结束的会话。
   */
  test('重新拉取会话时从账本读取目标，受阻理由一并恢复', async () => {
    setState({ activeConversation: 'cv_1', goal: null })
    freshView('cv_1')
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        return {
          messages: [],
          runs: [],
          steps: [],
          todos: [],
          workflowStarts: [],
          nextCursor: null,
        }
      }
      if (p.includes('/goal')) {
        return {
          goal: {
            ...goal,
            status: 'blocked',
            blockedCode: 'no_progress',
            blockedReason: '上一轮因连续无进展而终止：同样的调用、同样的结果。',
          },
        }
      }
      throw new Error('没有上下文面板')
    }
    await reloadActiveConversation()

    expect(state.goal?.status).toBe('blocked')
    expect(state.goal?.blockedReason).toContain('连续无进展')
  })
})

/**
 * 报错正文的显示位置。覆盖 `store/connection.ts` 的 `run.error` / `run.finished` 两个分支。
 *
 * 原始失败形状：一轮因无法连接接口而停止，读数条上只有「模型服务出错」
 * 五个字，说明处理方法的那句（「网络不可达：检查接口地址与代理」）
 * 显示在另一张卡片上：同一件事在两处说明，且那张卡片刷新一次即消失。
 */
describe('报错正文并入本轮的读数条', () => {
  const errorFrame = (message: string) =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'run.error', runId: 'run_1', code: 'network_error', message },
    }) as never

  const finishedFrame = () =>
    ({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.finished',
        runId: 'run_1',
        status: 'failed',
        stopReason: 'provider_error',
        usage: null,
        stepCount: 0,
        durationMs: 1,
        fileChanges: [],
      },
    }) as never

  test('结束时正文写入条目并清除全局错误，不在两处显示', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    applyEvent(errorFrame('网络不可达：检查接口地址与代理'))
    applyEvent(finishedFrame())

    const item = transcript().find((t) => t.kind === 'run')
    expect(item?.run?.errorMessage).toBe('网络不可达：检查接口地址与代理')
    expect(view().error).toBe(null)
  })

  /** 正常结束时没有报错正文，读数条使用停止原因的通用文字。 */
  test('未出错的一轮 errorMessage 为 null', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    applyEvent(finishedFrame())
    expect(transcript().find((t) => t.kind === 'run')?.run?.errorMessage).toBe(null)
  })

  /**
   * 另一方面：`run.error` 之后没有 `run.finished`（未配置 key、档案解析失败）。
   * 此时没有 run 行可以写入，全局错误必须保留，否则用户看不到任何报错。
   */
  test('没有结束事件时保留全局错误', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    applyEvent(errorFrame('未配置 API Key'))
    expect(view().error?.message).toBe('未配置 API Key')
    expect(transcript().some((t) => t.kind === 'run')).toBe(false)
  })
})

/**
 * 「多久没动静了」。
 *
 * 起因是一次实际断流：服务端 262 秒未收到任何字节，而界面上只有一个持续增长的
 * 总耗时与一句「正在思考…」，二者都未反映实际状态，用户直到最终报错才知道连接已断开。
 *
 * 静默时长按当前请求的最后内容时刻计算，该时刻由适配器观察、随内容事件传入，
 * 与落库的 `provider_requests.last_content_at` 是同一个值。本组锁定
 * 「只有实际内容推进该时刻」：按任意一帧计时时，仅有心跳的无内容流永远不会报告静默。
 */
describe('内容时刻只由实际内容推进', () => {
  const sent = (seq: number) =>
    applyEvent({
      seq,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.request',
        runId: 'run_1',
        requestId: 'pr_silence',
        phase: 'sent',
        attempt: 0,
        max: 5,
        at: 1_000,
      },
    } as never)

  test('非内容事件不推进内容时刻：仅有心跳的流才能报告静默', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    sent(1)
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'sent', lastContentAt: null })
    applyEvent({
      seq: 3,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_x', delta: '喂', at: 9_000 },
    } as never)
    expect(viewOf('cv_now').request).toMatchObject({ phase: 'content', lastContentAt: 9_000 })
  })

  /**
   * 不属于本会话的帧不得修改该时刻：否则后台会话每到达一帧，
   * 前台会话就被判定为刚有活动，静默永远不会显示。
   */
  test('其他会话的帧不修改内容时刻', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    sent(4)
    applyEvent({
      seq: 5,
      at: 0,
      conversationId: 'cv_other',
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_y', delta: '别人', at: 9_000 },
    } as never)
    expect(viewOf('cv_now').request).toMatchObject({ lastContentAt: null })
  })

  /** 结束后清除：保留时，下一轮开始时按上一轮的时刻计算，起始即显示错误的静默时长。 */
  test('run 结束后清空', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    sent(6)
    applyEvent({
      seq: 7,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.finished',
        runId: 'run_1',
        status: 'done',
        stopReason: 'completed',
        usage: null,
        stepCount: 1,
        durationMs: 1,
        fileChanges: [],
      },
    } as never)
    expect(viewOf('cv_now').request).toBe(null)
  })
})

/**
 * 刷新后当前请求的阶段、次数与截止点原样恢复。
 *
 * 事件环有界（`server/bus.ts` 按帧数与字节数淘汰），断线时间较长时无法补齐，因此刷新
 * 不能依赖重放实时事件。服务端从 `RunManager` 与同一份请求账实时读取该状态，随历史页
 * 一并返回，客户端按同一规则折叠进同一投影：两条路径恢复出的状态必须相同。
 *
 * 四组分别对应四个阶段；另两条用例锁定竞态与请求数。
 */
describe('刷新按同一份请求账恢复当前请求', () => {
  let historyCalls = 0
  let otherCalls = 0

  const stubHistory = (live: unknown) => {
    historyCalls = 0
    otherCalls = 0
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        historyCalls++
        return {
          messages: [],
          runs: [],
          steps: [],
          todos: [],
          workflowStarts: [],
          nextCursor: null,
          live,
        }
      }
      otherCalls++
      throw new Error('这个接口不在本组范围内')
    }
  }

  const snapshot = (request: Record<string, unknown> | null, seq = 100) => ({
    runId: 'rn_live',
    seq,
    request,
  })

  const baseRequest = {
    requestId: 'pr_live',
    attempt: 2,
    max: 5,
    status: 'in_flight',
    sentAt: 1_000,
    headersAt: null,
    firstContentAt: null,
    lastContentAt: null,
    lastContentKind: null,
    lastVisibleAt: null,
    backoffUntil: null,
  }

  const reload = async (live: unknown) => {
    setState({ activeConversation: 'cv_live', busyConversations: ['cv_live'] })
    freshView('cv_live')
    stubHistory(live)
    await reloadActiveConversation()
  }

  test('退避中：阶段、N / M 与截止点均恢复', async () => {
    await reload(
      snapshot({ ...baseRequest, status: 'rejected', sentAt: 500, backoffUntil: 61_000 }),
    )
    expect(viewOf('cv_live').request).toMatchObject({
      requestId: 'pr_live',
      attempt: 2,
      max: 5,
      phase: 'backoff',
      backoffUntil: 61_000,
    })
  })

  test('已发送未响应：阶段停留在已发出，等待时长按 sent_at 计算', async () => {
    await reload(snapshot(baseRequest))
    expect(viewOf('cv_live').request).toMatchObject({
      phase: 'sent',
      attempt: 2,
      sentAt: 1_000,
      headersAt: null,
      lastContentAt: null,
    })
  })

  test('已响应无内容：阶段为等待响应，内容时刻仍为空', async () => {
    await reload(snapshot({ ...baseRequest, headersAt: 1_400 }))
    expect(viewOf('cv_live').request).toMatchObject({
      phase: 'headers',
      headersAt: 1_400,
      lastContentAt: null,
    })
  })

  test('工具参数流刷新后仍保留类型与上次可见时刻', async () => {
    await reload(
      snapshot({
        ...baseRequest,
        headersAt: 1_400,
        firstContentAt: 1_500,
        lastContentAt: 61_500,
        lastContentKind: 'tool_arguments',
        lastVisibleAt: 1_500,
      }),
    )
    expect(viewOf('cv_live').request).toMatchObject({
      phase: 'content',
      lastContentAt: 61_500,
      lastContentKind: 'tool_arguments',
      lastVisibleAt: 1_500,
    })
    expect(viewOf('cv_live').generatingToolCall).toBe(true)
  })

  /**
   * 持续输出后刷新：恢复的是最后一段内容的时刻，不是重新拉取的时刻。
   * 以重新拉取时刻代替时，每次刷新都会使静默时长归零，已停滞的流看起来刚有过活动。
   */
  test('有内容：恢复最后一段内容的时刻，而不是重新拉取的时刻', async () => {
    setState({ activeConversation: 'cv_live', busyConversations: ['cv_live'] })
    freshView('cv_live')
    applyEvent({
      seq: 8,
      at: 0,
      conversationId: 'cv_live',
      event: {
        type: 'run.request',
        runId: 'rn_live',
        requestId: 'pr_live',
        phase: 'sent',
        attempt: 2,
        max: 5,
        at: 1_000,
      },
    } as never)
    applyEvent({
      seq: 9,
      at: 0,
      conversationId: 'cv_live',
      event: { type: 'text.delta', runId: 'rn_live', stepId: 'st_1', delta: '首段', at: 1_500 },
    } as never)
    applyEvent({
      seq: 10,
      at: 0,
      conversationId: 'cv_live',
      event: { type: 'text.delta', runId: 'rn_live', stepId: 'st_1', delta: '末段', at: 61_500 },
    } as never)
    const before = viewOf('cv_live').request
    expect(before).toMatchObject({ phase: 'content', lastContentAt: 61_500 })

    stubHistory(
      snapshot({
        ...baseRequest,
        headersAt: 1_200,
        firstContentAt: 1_500,
        lastContentAt: 61_500,
        lastContentKind: 'text',
        lastVisibleAt: 61_500,
      }),
    )
    await reloadActiveConversation()
    expect(viewOf('cv_live').request).toMatchObject({
      phase: 'content',
      attempt: 2,
      max: 5,
      lastContentAt: 61_500,
      lastVisibleAt: 61_500,
    })
    // 刷新只调用一次历史接口，运行中快照随其一并返回，没有第二个接口。
    expect(historyCalls).toBe(1)
    expect(otherCalls).toBeGreaterThan(0)
  })

  /** 加载期间先到达的事件比快照新，快照不得覆盖它。 */
  test('序号更旧的快照不覆盖已经到达的新事件', async () => {
    setState({ activeConversation: 'cv_live', busyConversations: ['cv_live'] })
    freshView('cv_live')
    applyEvent({
      seq: 200,
      at: 0,
      conversationId: 'cv_live',
      event: {
        type: 'run.request',
        runId: 'rn_live',
        requestId: 'pr_new',
        phase: 'headers',
        attempt: 3,
        max: 5,
        at: 9_000,
      },
    } as never)
    stubHistory(
      snapshot(
        {
          ...baseRequest,
          requestId: 'pr_old',
          lastContentAt: 5_000,
          lastContentKind: 'tool_arguments',
        },
        100,
      ),
    )
    await reloadActiveConversation()
    expect(viewOf('cv_live').request).toMatchObject({
      requestId: 'pr_new',
      attempt: 3,
      phase: 'headers',
    })
    expect(viewOf('cv_live').generatingToolCall).toBe(false)
  })

  /** 已进入终态的 run 不带快照，投影随之清空，界面不会将其显示为执行中。 */
  test('没有运行中的 run 时投影清空', async () => {
    await reload(null)
    expect(viewOf('cv_live').request).toBe(null)
  })
})

/**
 * 模型目录是配置的派生状态，失效点只有一个：配置落盘处。
 *
 * 各组件各自缓存一份时的实测后果：设置页校准思考后写回了配置，
 * 输入区的目录仍是启动时获取的，档位要整页重载才出现。
 */
describe('配置落盘后模型目录随之重新计算', () => {
  test('保存后获取的目录是保存后的版本', async () => {
    const calls: string[] = []
    let levels = ['low']
    // 与前几组相同，直接替换 `client.api`：本用例测试重新计算的触发方与时机，
    // 不测试 HTTP 层。
    ;(client as unknown as { api: (p: string, init?: RequestInit) => Promise<unknown> }).api =
      async (p: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${p}`)
        if (p.startsWith('/api/models')) {
          return {
            providers: [{ name: 'p', models: [{ id: 'm', label: 'm', effortLevels: levels }] }],
            active: { provider: 'p', model: 'm' },
            library: [],
          }
        }
        if (p.startsWith('/api/config')) {
          return {
            config: { active: { provider: 'p', model: 'm' }, providers: {} },
            path: '',
            notices: [],
            problems: [],
          }
        }
        throw new Error(`没桩这条：${p}`)
      }

    levels = ['low', 'high']
    await saveServerConfig({ active: { provider: 'p', model: 'm' }, providers: {} } as never)

    expect(modelCatalog()?.providers[0]?.models[0]?.effortLevels).toEqual(['low', 'high'])
    // 目录在保存之后获取：顺序相反时取到的是落盘前的版本，看起来如同保存未生效。
    expect(calls.indexOf('GET /api/models')).toBeGreaterThan(calls.indexOf('PUT /api/config'))
  })
})

/**
 * 工具卡的实时输出（`store/connection.ts` 的 `tool.delta`）。
 *
 * 断言采用原始失败形状：`tool.delta` 的 stepId 为空串时（服务端装配执行上下文
 * 时尚无 step），此处 `find` 无法匹配任何条目，`if (!item) return` 将整条通道
 * 静默丢弃：命令运行期间卡片始终为空，而事件持续发送。
 */
describe('工具卡按 stepId 认领实时输出', () => {
  const started = (stepId: string) =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'tool.started',
        runId: 'run_1',
        stepId,
        toolCallId: 'call_1',
        toolName: 'run_command',
        batchId: 'b_1',
        callIndex: 0,
        waveIndex: 0,
        args: { command: 'npm test' },
        action: { kind: 'run', objectLabel: '命令', target: 'npm test' },
      },
    }) as never

  const delta = (stepId: string, text: string) =>
    ({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'tool.delta', runId: 'run_1', stepId, channel: 'stdout', delta: text },
    }) as never

  const finished = (stepId: string) =>
    ({
      seq: 3,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'tool.finished',
        runId: 'run_1',
        stepId,
        toolCallId: 'call_1',
        status: 'success',
        outcome: { kind: 'run', status: 'success' },
        durationMs: 1,
      },
    }) as never

  /**
   * 中途输出合帧后写入（同一档内的若干段合并为一次），因此此处用一个会清空缓冲的
   * 事件断言，而不是等待定时器：任何需要读取 transcript 的事件之前都会先写入。
   */
  test('写入 tool.started 创建的卡片', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    applyEvent(started('st_tool_1'))
    applyEvent(delta('st_tool_1', '第一行\n'))
    applyEvent(delta('st_tool_1', '第二行\n'))
    applyEvent(finished('st_tool_1'))
    expect(transcript().find((t) => t.id === 'st_tool_1')?.stdout).toBe('第一行\n第二行\n')
  })

  /**
   * 无法识别归属时丢弃，不要改为写入最后一张正在运行的卡片：
   * 一批中可以有多个工具同时运行，写错卡片的输出比没有输出更难排查。
   */
  test('无法识别 stepId 的输出一律不写入卡片', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    applyEvent(started('st_tool_1'))
    applyEvent(delta('', '认不出归属的一行\n'))
    applyEvent(finished('st_tool_1'))
    expect(transcript().find((t) => t.id === 'st_tool_1')?.stdout).toBeUndefined()
  })
})

/**
 * 结束分两帧：`run.finished` 写入收尾条并交接读数，`conversation.busy` 随后才置为闲。
 * 中间一帧若按忙闲判定，会话流末尾的同一位置会上下显示两条读数条。
 */
describe('收尾条写入即视为本轮结束，不等待忙闲', () => {
  const started = (runId: string) =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_tail',
      event: {
        type: 'run.started',
        runId,
        conversationId: 'cv_tail',
        model: 'm',
        userMessageId: null,
      },
    }) as never

  const finished = (runId: string) =>
    ({
      seq: 2,
      at: 0,
      conversationId: 'cv_tail',
      event: {
        type: 'run.finished',
        runId,
        status: 'done',
        stopReason: 'completed',
        usage: null,
        stepCount: 1,
        durationMs: 5,
        fileChanges: [],
      },
    }) as never

  const fresh = () => {
    setState({
      activeConversation: 'cv_tail',
      busyConversations: ['cv_tail'],
      lastRunId: null,
    })
    freshView('cv_tail')
  }

  test('运行期间不视为结束', () => {
    fresh()
    applyEvent(started('run_a'))
    expect(runClosed()).toBe(false)
  })

  test('收尾条写入即视为结束，此时忙状态尚未清除', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    expect(isRunning()).toBe(true)
    expect(runClosed()).toBe(true)
  })

  test('下一轮开始后不再视为结束', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    applyEvent(started('run_b'))
    expect(runClosed()).toBe(false)
  })

  /**
   * 另一端不能一并清除：按下回车到 `run.started` 之间，读数条必须存在
   * （它显示「正在请求…」，这是用户唯一的反馈）。
   */
  test('按下回车后、run.started 之前，实时读数条保持显示', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    setState('busyConversations', [])
    // 指令必须实际发出：不替换 `client.send` 时此处没有连接，它会立即返回
    // `not_ready` 并冲销乐观置忙，那属于断线场景，不是本用例测试的阶段。
    const before = client.send
    ;(client as unknown as { send: (cmd: unknown) => void }).send = () => {}
    try {
      sendMessage('接着干')
    } finally {
      ;(client as unknown as { send: typeof before }).send = before
    }
    expect(isRunning()).toBe(true)
    expect(runClosed()).toBe(false)
  })

  /**
   * 服务端自行发起的轮次（目标自动继续、定时触发、跟进消息自动发送）没有客户端乐观插入，
   * 会话流末尾仍是上一轮的收尾条，而新的一轮确实在运行。按末条的 kind 判定会遗漏它。
   */
  test('流尾是上一轮的收尾条时，新的一轮仍算作运行中', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    applyEvent(started('run_b'))
    expect(transcript()[transcript().length - 1]?.kind).toBe('run')
    expect(runClosed()).toBe(false)
  })
})

describe('停止按会话寻址', () => {
  const capture = () => {
    const sent: { type: string; conversationId?: string }[] = []
    const before = client.send
    ;(client as unknown as { send: (cmd: unknown) => void }).send = (cmd) => {
      sent.push(cmd as { type: string })
    }
    return {
      // 切换会话的订阅指令与中断指令都经由 `client.send`，此处只检查中断指令。
      interrupts: () => sent.filter((c) => c.type === 'conversation.interrupt'),
      restore: () => {
        ;(client as unknown as { send: typeof before }).send = before
      },
    }
  }

  test('发送的是当前会话的中断指令', () => {
    const { interrupts, restore } = capture()
    try {
      setState({ activeConversation: 'cv_stop' })
      interrupt()
    } finally {
      restore()
    }
    expect(interrupts()).toEqual([{ type: 'conversation.interrupt', conversationId: 'cv_stop' }])
  })

  /** 没有打开任何会话时无法点击停止按钮，也不应发出指令。 */
  test('没有活动会话时不发送', () => {
    const { interrupts, restore } = capture()
    try {
      setState({ activeConversation: null })
      interrupt()
    } finally {
      restore()
    }
    expect(interrupts()).toEqual([])
  })
})

/**
 * 回执与用户输入在 wire 上都是 user 角色，只能通过 `origin` 区分。两条投影路径各锁定一次：
 * 开始一轮的回执写入 `messages.origin`，run 内注入的回执写入 step 的 `payload.origin`。
 */
describe('带 origin 的用户消息折叠为回执条目', () => {
  const CV = 'cv_receipt'
  const run = {
    id: 'rn_1',
    userMessageId: 'ms_1',
    createdAt: 1,
    finishedAt: 9,
    stopReason: 'completed',
    status: 'done',
    usage: null,
    errorMessage: null,
  }

  const message = (id: string, content: string, origin: string | null) => ({
    id,
    conversationId: CV,
    role: 'user',
    content,
    attachments: [],
    origin,
    createdAt: 1,
  })

  const userStep = (id: string, content: string, payload: Record<string, unknown>) => ({
    id,
    runId: 'rn_1',
    seq: 1,
    kind: 'user',
    toolName: null,
    content,
    payload,
    status: 'done',
    createdAt: 2,
    durationMs: null,
  })

  const stub = (messages: unknown[], steps: unknown[]) => {
    const before = client.api
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        return { messages, runs: [run], steps, todos: [], workflowStarts: [], nextCursor: null }
      }
      throw new Error('没有上下文面板')
    }
    return () => {
      ;(client as unknown as { api: typeof before }).api = before
    }
  }

  const load = async (messages: unknown[], steps: unknown[]) => {
    setState({ activeConversation: CV, busyConversations: [] })
    freshView(CV)
    const restore = stub(messages, steps)
    try {
      await reloadActiveConversation()
    } finally {
      restore()
    }
  }

  test('开始一轮的回执不渲染为气泡，用户输入仍为气泡', async () => {
    await load(
      [
        message('ms_1', '为什么动不了', null),
        message('ms_2', '[子 agent 回执] 外部 CLI claude 已返回', 'subagent'),
      ],
      [],
    )
    expect(transcript().map((t) => t.kind)).toEqual(['user', 'run', 'receipt'])
    expect(transcript().at(-1)).toMatchObject({
      kind: 'receipt',
      origin: 'subagent',
      text: '[子 agent 回执] 外部 CLI claude 已返回',
    })
  })

  test('run 内注入的消息按 payload.origin 区分，同一轮中两种消息并存', async () => {
    await load(
      [message('ms_1', '为什么动不了', null)],
      [
        userStep('st_receipt', '[workflow 回执] 检查点 主会话审查 的上游已经全部返回', {
          kind: 'user',
          origin: 'workflow',
        }),
        { ...userStep('st_human', '接着干', { kind: 'user' }), seq: 2 },
      ],
    )
    expect(transcript().map((t) => t.kind)).toEqual(['user', 'receipt', 'user', 'run'])
    expect(transcript()[1]).toMatchObject({ kind: 'receipt', origin: 'workflow' })
  })
})

/**
 * 服务端判定是否排队的依据是「是否存在 run」（`runs.hasRun`），而忙状态包含正在运行的子 agent。
 * 按忙状态判定时，只有子 agent 在运行时用户发送的消息在界面上进入队列卡片，
 * 服务端却立即开始了一轮。
 */
describe('仅子 agent 运行中时发送消息不排队', () => {
  const CV = 'cv_send'
  const runItem = {
    id: 'run_rn_1',
    kind: 'run',
    text: '',
    run: {
      runId: 'rn_1',
      stopReason: 'completed',
      usage: null,
      startedAt: 1,
      endedAt: 2,
      errorMessage: null,
    },
  }

  const seed = (tail: unknown[]) => {
    setState({ activeConversation: CV, busyConversations: [CV], lastRunId: 'rn_1', followUps: [] })
    freshView(CV)
    setState('views', CV, 'transcript', tail as never)
    const before = client.send
    ;(client as unknown as { send: (cmd: unknown) => void }).send = () => {}
    return () => {
      ;(client as unknown as { send: typeof before }).send = before
    }
  }

  test('收尾条位于会话流末尾时，消息进入会话流，不显示乐观队列卡片', () => {
    const restore = seed([runItem])
    try {
      sendMessage('再看一眼那个文件')
    } finally {
      restore()
    }
    expect(state.followUps).toEqual([])
    expect(transcript().at(-1)).toMatchObject({ kind: 'user', text: '再看一眼那个文件' })
  })

  test('run 仍在运行时正常排队', () => {
    const restore = seed([{ id: 'st_text', kind: 'text', text: '在查了' }])
    try {
      sendMessage('顺带看看日志')
    } finally {
      restore()
    }
    expect(state.followUps.map((f) => f.content)).toEqual(['顺带看看日志'])
    expect(transcript().at(-1)).toMatchObject({ kind: 'text' })
  })
})

/**
 * 实时到达的帧与刷新后折叠出的条目必须 id 相同、形态相同。
 * 只在一处区分时，回执在页面打开期间显示为用户气泡，刷新一次后才变为回执行。
 */
describe('实时到达的回执同样建为回执条目', () => {
  const CV = 'cv_receipt_live'
  const RECEIPT = '[子 agent 回执] 临时 查资料 已返回'

  const frame = (event: Record<string, unknown>) =>
    ({ seq: 1, at: 0, conversationId: CV, event }) as never

  const open = () => {
    setState({ activeConversation: CV, busyConversations: [CV], lastRunId: null, followUps: [] })
    freshView(CV)
  }

  const injected = (stepId: string, content: string, origin?: string) =>
    frame({
      type: 'message.injected',
      runId: 'rn_1',
      stepId,
      followUpId: `q_${stepId}`,
      content,
      ...(origin ? { origin } : {}),
    })

  const started = (userMessageId: string, content: string, origin?: string) =>
    frame({
      type: 'run.started',
      runId: 'rn_1',
      conversationId: CV,
      model: 'm',
      userMessageId,
      userMessage: { content, ...(origin ? { origin } : {}) },
    })

  test('run 内注入的回执为回执行，用户输入仍为气泡', () => {
    open()
    applyEvent(injected('st_receipt', RECEIPT, 'subagent'))
    applyEvent(injected('st_human', '接着干'))
    expect(transcript().map((t) => t.kind)).toEqual(['receipt', 'user'])
    expect(transcript()[0]).toMatchObject({ id: 'st_receipt', origin: 'subagent' })
  })

  test('由回执开始的一轮不经过气泡对齐，直接建为回执行', () => {
    open()
    applyEvent(started('ms_1', '[workflow 回执] 检查点 主会话审查 的上游已经全部返回', 'workflow'))
    expect(transcript().map((t) => t.kind)).toEqual(['receipt'])
    expect(transcript()[0]).toMatchObject({ id: 'ms_1', origin: 'workflow' })
  })

  test('刷新后从账本折叠出的是同一条目，不产生第二条', async () => {
    open()
    applyEvent(started('ms_1', RECEIPT, 'subagent'))
    applyEvent(injected('st_receipt', RECEIPT, 'subagent'))
    setState('busyConversations', [])

    const before = client.api
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        return {
          messages: [
            {
              id: 'ms_1',
              conversationId: CV,
              role: 'user',
              content: RECEIPT,
              attachments: [],
              origin: 'subagent',
              createdAt: 1,
            },
          ],
          runs: [
            {
              id: 'rn_1',
              userMessageId: 'ms_1',
              createdAt: 1,
              finishedAt: 9,
              stopReason: 'completed',
              status: 'done',
              usage: null,
              errorMessage: null,
            },
          ],
          steps: [
            {
              id: 'st_receipt',
              runId: 'rn_1',
              seq: 1,
              kind: 'user',
              toolName: null,
              content: RECEIPT,
              payload: { kind: 'user', origin: 'subagent' },
              status: 'done',
              createdAt: 2,
              durationMs: null,
            },
          ],
          todos: [],
          workflowStarts: [],
          nextCursor: null,
        }
      }
      throw new Error('没有上下文面板')
    }
    try {
      await reloadActiveConversation()
    } finally {
      ;(client as unknown as { api: typeof before }).api = before
    }

    expect(transcript().map((t) => t.id)).toEqual(['ms_1', 'st_receipt', 'run_rn_1'])
    expect(transcript().map((t) => t.kind)).toEqual(['receipt', 'receipt', 'run'])
  })
})

/**
 * 思考流经由合帧器（`store/connection.ts` 的 `thinking.delta`）：每帧合并写入一次，不逐 token 写入。
 * 正文到达时先写入积压的思考，否则同一次回复中思考会排在正文之后。
 */
describe('思考流合帧', () => {
  const think = (stepId: string, delta: string) =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_think',
      event: { type: 'thinking.delta', runId: 'run_1', stepId, delta },
    }) as never
  const text = (stepId: string, delta: string) =>
    ({
      seq: 2,
      at: 0,
      conversationId: 'cv_think',
      event: { type: 'text.delta', runId: 'run_1', stepId, delta },
    }) as never

  test('多段思考合并为一条，正文到达时先写入', () => {
    setState({ activeConversation: 'cv_think' })
    freshView('cv_think')
    applyEvent(think('st_think', '先想'))
    applyEvent(think('st_think', '再想'))
    // 仍在缓冲中，尚未写入 transcript。
    expect(viewOf('cv_think').transcript.find((t) => t.id === 'st_think')).toBeUndefined()
    applyEvent(text('st_text', '完成'))
    const items = viewOf('cv_think').transcript
    const thinking = items.findIndex((t) => t.id === 'st_think')
    expect(items[thinking]?.text).toBe('先想再想')
    // 正文仍在节拍器中或已写在思考之后，思考不得排在正文之后。
    const textAt = items.findIndex((t) => t.id === 'st_text')
    expect(textAt === -1 || textAt > thinking).toBe(true)
    // 正文仍积压在节拍器中，不丢弃时其定时器会阻止进程退出。
    discardPace()
  })
})

/**
 * 变更面板的数据：账本页（`/changes`）与实时回执（`tool.finished`）必须合并为同一份。
 *
 * 锁定三项：首页请求进行中到达的写入不丢失也不重复；未获取过面板数据时实时回执不追加；
 * 只在有游标时请求下一页。
 */
describe('变更面板：账本页与实时回执合并为同一份', () => {
  const change = (path: string, additions: number, deletions: number) => ({
    path,
    changeType: 'modified',
    additions,
    deletions,
  })
  const wireStep = (id: string, path: string, additions: number, deletions: number) => ({
    id,
    toolName: 'edit_file',
    args: { path },
    fileChanges: [change(path, additions, deletions)],
    via: null,
  })
  const finished = (stepId: string, path: string, additions: number, deletions: number) =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'tool.finished',
        runId: 'rn_1',
        stepId,
        toolCallId: 'c',
        status: 'success',
        outcome: {
          status: 'success',
          executed: true,
          message: '',
          fileChanges: [change(path, additions, deletions)],
        },
        durationMs: 1,
      },
    }) as never
  /** 一次实时回执，变更类型可任选：折叠规则按变更类型分档。 */
  const changed = (stepId: string, path: string, changeType: 'created' | 'deleted') =>
    ({
      seq: 1,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'tool.finished',
        runId: 'rn_1',
        stepId,
        toolCallId: 'c',
        status: 'success',
        outcome: {
          status: 'success',
          executed: true,
          message: '',
          fileChanges: [{ path, changeType }],
        },
        durationMs: 1,
      },
    }) as never
  const runFinished = (runId: string) =>
    ({
      seq: 2,
      at: 0,
      conversationId: 'cv_1',
      event: {
        type: 'run.finished',
        runId,
        status: 'done',
        stopReason: 'completed',
        usage: null,
        stepCount: 1,
        durationMs: 5,
        fileChanges: [],
      },
    }) as never
  const toolItem = (id: string, path: string) => ({
    id,
    kind: 'tool' as const,
    text: '',
    toolName: 'edit_file',
    args: { path },
    status: 'running' as const,
  })
  const stubApi = (handler: (path: string) => Promise<unknown>) => {
    const before = client.api
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = handler
    return () => {
      ;(client as unknown as { api: typeof client.api }).api = before
    }
  }

  test('首页请求进行中到达的写入：页中已有的去重，页中没有的并入，合计只累加页中没有的部分', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    setState('views', 'cv_1', 'transcript', [
      { id: 'ms_1', kind: 'user', text: '改 a' },
      toolItem('st_1', 'a.ts'),
      toolItem('st_2', 'b.ts'),
    ])
    setState('views', 'cv_1', 'runUserMessageId', 'ms_1')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const restore = stubApi(async (p) => {
      if (!p.includes('/changes')) throw new Error('意外请求 ' + p)
      await gate
      return {
        turns: [
          {
            userMessageId: 'ms_1',
            text: '改 a',
            origin: null,
            createdAt: 1,
            steps: [wireStep('st_1', 'a.ts', 3, 1)],
          },
        ],
        totals: { paths: ['a.ts'], additions: 3, deletions: 1 },
        nextCursor: null,
      }
    })
    try {
      const loading = loadConversationChanges('cv_1')
      expect(viewOf('cv_1').changes?.loading).toBe('initial')
      applyEvent(finished('st_1', 'a.ts', 3, 1))
      applyEvent(finished('st_2', 'b.ts', 2, 0))
      release()
      await loading
      const changes = viewOf('cv_1').changes
      expect(changes?.loading).toBeNull()
      expect(changes?.error).toBeNull()
      expect(changes?.turns.map((t) => [t.text, t.steps.map((s) => s.id)])).toEqual([
        ['改 a', ['st_1', 'st_2']],
      ])
      expect(changes?.totals).toEqual({ paths: ['a.ts', 'b.ts'], additions: 5, deletions: 1 })
      // 再次到达同一条回执：不重复计入
      applyEvent(finished('st_2', 'b.ts', 2, 0))
      expect(viewOf('cv_1').changes?.totals.additions).toBe(5)
    } finally {
      restore()
      dropView('cv_1')
    }
  })

  test('未获取过面板数据时回执不追加；获取后，新一轮的写入按 run.started 的用户消息新建一节并置于最前', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    setState('views', 'cv_1', 'transcript', [
      { id: 'ms_1', kind: 'user', text: '改 a' },
      toolItem('st_1', 'a.ts'),
    ])
    setState('views', 'cv_1', 'runUserMessageId', 'ms_1')
    applyEvent(finished('st_1', 'a.ts', 1, 0))
    expect(viewOf('cv_1').changes).toBeNull()

    const restore = stubApi(async () => ({
      turns: [
        {
          userMessageId: 'ms_1',
          text: '改 a',
          origin: null,
          createdAt: 1,
          steps: [wireStep('st_1', 'a.ts', 1, 0)],
        },
      ],
      totals: { paths: ['a.ts'], additions: 1, deletions: 0 },
      nextCursor: null,
    }))
    try {
      await loadConversationChanges('cv_1')
      applyEvent({
        seq: 2,
        at: 0,
        conversationId: 'cv_1',
        event: {
          type: 'run.started',
          runId: 'rn_2',
          conversationId: 'cv_1',
          model: 'm',
          userMessageId: 'ms_2',
          userMessage: { content: '再改' },
        },
      } as never)
      setState('views', 'cv_1', 'transcript', (items) => [...items, toolItem('st_2', 'a.ts')])
      applyEvent(finished('st_2', 'a.ts', 4, 2))
      const changes = viewOf('cv_1').changes
      expect(changes?.turns.map((t) => [t.userMessageId, t.text, t.steps.length])).toEqual([
        ['ms_2', '再改', 1],
        ['ms_1', '改 a', 1],
      ])
      expect(changes?.totals).toEqual({ paths: ['a.ts'], additions: 5, deletions: 2 })
    } finally {
      restore()
      dropView('cv_1')
    }
  })

  test('翻页：有游标时才发送请求，新页追加在末尾；到达末页后不再发送', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    const requested: string[] = []
    const restore = stubApi(async (p) => {
      requested.push(p)
      if (p.includes('before=ms_1')) {
        return {
          turns: [{ userMessageId: 'ms_0', text: '最早', origin: null, createdAt: 0, steps: [] }],
          totals: { paths: ['a.ts'], additions: 2, deletions: 0 },
          nextCursor: null,
        }
      }
      return {
        turns: [{ userMessageId: 'ms_1', text: '后来', origin: null, createdAt: 1, steps: [] }],
        totals: { paths: ['a.ts'], additions: 2, deletions: 0 },
        nextCursor: 'ms_1',
      }
    })
    try {
      await loadConversationChanges('cv_1')
      expect(viewOf('cv_1').changes?.nextCursor).toBe('ms_1')
      expect(await loadOlderConversationChanges('cv_1')).toBe(true)
      expect(viewOf('cv_1').changes?.turns.map((t) => t.text)).toEqual(['后来', '最早'])
      expect(viewOf('cv_1').changes?.nextCursor).toBeNull()
      expect(await loadOlderConversationChanges('cv_1')).toBe(false)
      expect(requested).toHaveLength(2)
      // 已获取过时不再获取
      await loadConversationChanges('cv_1')
      expect(requested).toHaveLength(2)
    } finally {
      restore()
      dropView('cv_1')
    }
  })

  test('派发任务的节点进入终态时，重新获取最新一轮并替换，合计以账本为准', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    const requested: string[] = []
    let phase = 0
    const restore = stubApi(async (p) => {
      requested.push(p)
      if (phase === 0) {
        return {
          turns: [
            {
              userMessageId: 'ms_1',
              text: '派活',
              origin: null,
              createdAt: 1,
              steps: [wireStep('st_1', 'a.ts', 1, 0)],
            },
          ],
          totals: { paths: ['a.ts'], additions: 1, deletions: 0 },
          nextCursor: null,
        }
      }
      return {
        turns: [
          {
            userMessageId: 'ms_1',
            text: '派活',
            origin: null,
            createdAt: 1,
            steps: [
              wireStep('st_1', 'a.ts', 1, 0),
              { ...wireStep('st_c', 'c.ts', 4, 4), via: { name: '写手' } },
            ],
          },
        ],
        totals: { paths: ['a.ts', 'c.ts'], additions: 5, deletions: 4 },
        nextCursor: null,
      }
    })
    try {
      await loadConversationChanges('cv_1')
      phase = 1
      applyEvent({
        seq: 3,
        at: 0,
        conversationId: 'cv_1',
        event: {
          type: 'team.member',
          runId: 'rn_1',
          stepId: 'st_w',
          nodeId: 'n1',
          state: { phase: 'done', label: '写手', subagentId: 'cv_child' },
        },
      } as never)
      for (let i = 0; i < 50 && requested.length < 2; i += 1) await Bun.sleep(5)
      expect(requested[1]).toContain('limit=1')
      await Bun.sleep(10)
      const changes = viewOf('cv_1').changes
      expect(changes?.turns.map((t) => t.steps.map((s) => [s.id, s.via?.name ?? null]))).toEqual([
        [
          ['st_1', null],
          ['st_c', '写手'],
        ],
      ])
      expect(changes?.totals).toEqual({ paths: ['a.ts', 'c.ts'], additions: 5, deletions: 4 })
    } finally {
      restore()
      dropView('cv_1')
    }
  })

  test('本轮执行完毕：重新获取该节，创建后又删除的路径从行与合计中一并消失', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: ['cv_1'] })
    freshView('cv_1')
    const requested: string[] = []
    // 账本数据的行与合计均已折叠：该路径在本轮没有净效果，行与合计均不包含它。
    const restore = stubApi(async (p) => {
      requested.push(p)
      return {
        turns: [
          {
            userMessageId: 'ms_1',
            text: '跑一轮脚本',
            origin: null,
            createdAt: 1,
            steps: [wireStep('st_keep', 'keep.ts', 2, 0)],
          },
        ],
        totals: { paths: ['keep.ts'], additions: 2, deletions: 0 },
        nextCursor: null,
      }
    })
    try {
      await loadConversationChanges('cv_1')
      setState('views', 'cv_1', 'transcript', [
        { id: 'ms_1', kind: 'user', text: '跑一轮脚本' },
        toolItem('st_1', 'cache/a.bin'),
        toolItem('st_2', 'cache/a.bin'),
      ])
      setState('views', 'cv_1', 'runUserMessageId', 'ms_1')
      applyEvent(changed('st_1', 'cache/a.bin', 'created'))
      applyEvent(changed('st_2', 'cache/a.bin', 'deleted'))
      // 实时追加只加入到达的那一条：此时该路径仍在行中，也计入合计。
      expect(viewOf('cv_1').changes?.totals.paths).toContain('cache/a.bin')

      applyEvent(runFinished('rn_1'))
      for (let i = 0; i < 50 && requested.length < 2; i += 1) await Bun.sleep(5)
      await Bun.sleep(10)
      const changes = viewOf('cv_1').changes
      expect(requested[1]).toContain('limit=1')
      expect(changes?.turns.flatMap((t) => t.steps.map((s) => s.id))).toEqual(['st_keep'])
      expect(changes?.totals).toEqual({ paths: ['keep.ts'], additions: 2, deletions: 0 })
    } finally {
      restore()
      dropView('cv_1')
    }
  })

  test('首页请求失败时有终态，再次调用即重试', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    let fail = true
    const restore = stubApi(async () => {
      if (fail) throw new Error('网络断开')
      return {
        turns: [],
        totals: { paths: [], additions: 0, deletions: 0 },
        nextCursor: null,
      }
    })
    try {
      await loadConversationChanges('cv_1')
      expect(viewOf('cv_1').changes?.error).toBe('网络断开')
      expect(viewOf('cv_1').changes?.loading).toBeNull()
      fail = false
      await loadConversationChanges('cv_1')
      expect(viewOf('cv_1').changes?.error).toBeNull()
    } finally {
      restore()
      dropView('cv_1')
    }
  })
})

/**
 * 内置浏览器能力投影（`store/connection.ts` 对 `browser.state` 的处理）。
 *
 * 原生宿主在应用启动之后才连接，握手时的能力中尚不包含它；`browser.state`
 * 是进程级事件，整份替换 `capabilities.browser`，界面据此决定是否显示浏览器入口。
 */
describe('内置浏览器能力投影', () => {
  const caps = (connected: boolean) =>
    ({
      sandbox: { backend: 'none', active: false, reason: '' },
      environment: [],
      mode: 'auto',
      browser: { connected, runtimeSupported: connected },
    }) as never

  test('browser.state 整份替换能力投影，不是第二份状态', () => {
    setState('capabilities', caps(false))
    expect(state.capabilities?.browser.connected).toBe(false)
    applyEvent({
      seq: 2,
      at: 0,
      event: {
        type: 'browser.state',
        browser: { connected: true, runtimeSupported: true },
      },
    } as never)
    expect(state.capabilities?.browser.connected).toBe(true)
    expect(state.capabilities?.browser.runtimeSupported).toBe(true)
    // 同一投影中的其他字段不受影响。
    expect(state.capabilities?.mode).toBe('auto')
  })
})
