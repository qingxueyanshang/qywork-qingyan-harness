/**
 * 前端状态里两块**纯逻辑**的回归锁。
 *
 * 只测不需要连接、不需要 DOM 的部分。组件级行为（面板真的展开了没有、密钥有没有
 * 出现在响应里）不在这里测：那些要么已由端到端实测覆盖，要么该由服务端测试锁，
 * 搬进单测只会变成测桩。
 *
 * **为什么要先补几个浏览器全局。** `store.ts` 顶层 `new QyClient(...)`，而 `QyClient` 有个**字段初
 * 始化器** `private readonly endpoint = resolveEndpoint()`——构造函数体是空的，但字段在实例化时就
 * 跑，它要读 `location` / `sessionStorage` / `matchMedia`。所以这里先把这几样补上再动态 import，而
 * 不是去改产品代码加 `typeof location === 'undefined'` 的判断：那种判断只为测试存在，生产路径上永
 * 远走不到，属于 CLAUDE.md B5 说的空壳分支。
 *
 * `localStorage` 是同样的理由：面板宽度要落盘，没有它整条走进 catch。
 *
 * **别在这里断言「模块加载时读出来的宽度」**：`bun test` 一次跑多个文件共用一份
 * 模块表，`client.test.ts` 先一步 import 过 `client.ts`，`store/ui.ts` 在这几行
 * 补全局之前就已经求值完了。断言它的结果，单跑这个文件是绿的，跑全量是红的。
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
g.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
g.matchMedia = () => ({ matches: false })
// 面板宽度那几条要用：localStorage 是它落盘的地方。
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
  activateWorkspace,
  applyEvent,
  client,
  dropView,
  modelCatalog,
  closeAllPanelTabs,
  closePanel,
  closePanelTab,
  explainApiError,
  holdPanelTab,
  isRunning,
  ledgerRevision,
  loadOlderConversation,
  loadConversationView,
  openBrowserTab,
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
  saveServerConfig,
  selectConversation,
  sendMessage,
  setPanelTabUrl,
  setSidePanel,
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

describe('激活项目复用服务端返回的会话列表', () => {
  test('新项目不再追加会话列表请求与第二次创建请求', async () => {
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
        return { messages: [], runs: [], steps: [], todos: [], nextCursor: null }
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

/** 这条会话现开一份空表：上一条用例往里写过条目，下一条要从空的开始。 */
const freshView = (id: string) => {
  dropView(id)
  openView(id)
}

describe('右侧面板：一个按钮管开合，并记住上次看的视图', () => {
  test('收起状态下点开，回到默认的文件视图', () => {
    setSidePanel(null)
    togglePanel()
    expect(sidePanel()).toBe('files')
  })

  test('展开状态下点，收起', () => {
    openPanel('changes')
    togglePanel()
    expect(sidePanel()).toBe(null)
  })

  test('收起再展开，回到上次待的地方而不是一律跳回文件', () => {
    openPanel('changes')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('changes')
  })

  test('换过几次视图后，记住的是最后那个', () => {
    openPanel('files')
    openPanel('changes')
    openPanel('todos')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('todos')
  })

  test('反复开合不漂移 —— 偶数次回到展开，奇数次收起，视图始终是那一个', () => {
    openPanel('todos')
    for (let i = 0; i < 6; i++) togglePanel()
    expect(sidePanel()).toBe('todos')
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(sidePanel()).toBe('todos')
  })

  test('面板头上的 × 也记住当前视图 —— 它和顶栏开关走同一条收起路径', () => {
    openPanel('changes')
    closePanel()
    togglePanel()
    expect(sidePanel()).toBe('changes')
  })
})

describe('面板放大：跟着面板走，不留下一个自己开着的态', () => {
  test('收起面板一并复位 —— 下次展开不该直接落进放大态', () => {
    openPanel('files')
    togglePanelMax()
    expect(panelMaximized()).toBe(true)
    togglePanel()
    expect(panelMaximized()).toBe(false)
    togglePanel()
    expect(panelMaximized()).toBe(false)
  })

  test('换视图不影响放大 —— 放大的是这块面板，不是某一个视图', () => {
    openPanel('files')
    togglePanelMax()
    setSidePanel('changes')
    expect(panelMaximized()).toBe(true)
    closePanel()
    expect(panelMaximized()).toBe(false)
  })
})

/**
 * 可多开的那些页（终端、浏览器）。
 *
 * 测的是**关掉一页之后停在哪、什么被收掉**——这两条错了的表现分别是「面板莫名收起」
 * 和「PTY 留在后台，工作区里的文件句柄被占用」，都不会报错。
 */
/*
 * 面板宽度这一节**只锁「要多宽」这半边**。
 *
 * 「实际排多宽」由 `.app.with-panel` 的 `minmax(var(--chat-min), 1fr)` 裁决，
 * 那是网格的事，这里没有 DOM 也没有窗口，量不到——所以下面不会出现任何一条
 * 「窗口 1280、存了 1632，因此应该是 800」的断言。**那条断言写在这里就是假的**：
 * 它只能证明这个文件里又抄了一遍 CSS 的算法。原始失败形状（存 1632、窗口 1280）
 * 由浏览器里跑的那次实测覆盖。
 */
describe('面板宽度：拖出来的数照原样记住', () => {
  test('拖不足夹在下限——再窄这块面板就没法看了', () => {
    resizePanel(100)
    expect(panelWidth()).toBe(PANEL_MIN)
    // 负数尤其要挡：`minmax(0, -50px)` 会让整条 grid-template-columns 失效，
    // 网格退回隐式 auto 列，那正是要防的失效形状。
    resizePanel(-50)
    expect(panelWidth()).toBe(PANEL_MIN)
  })

  test('窗口放不下也不改小它——网格自己会收，设置得留着', () => {
    // 2560 的窗口里拖到 1632，换到 1280 的窗口再打开：这个数照旧是 1632，
    // 窗口再变宽就还给用户。反过来抹掉它，等于拿一次临时的窗口尺寸改用户的设置。
    resizePanel(1632)
    expect(panelWidth()).toBe(1632)
    expect(stored.get('qywork.panelWidth')).toBe('1632')
  })
})

describe('可多开的页：+ 开出来，× 关掉', () => {
  const reset = () => {
    closeAllPanelTabs()
    setSidePanel('files')
  }

  test('新开一页就翻到它', () => {
    reset()
    openPanelTab('terminal')
    expect(panelTabs().length).toBe(1)
    expect(activePanelTab()).toBe(panelTabs()[0]!.id)
  })

  test('正文里的链接开出浏览器页，同一个地址再点是翻回去', () => {
    reset()
    openBrowserTab('http://localhost:8000')
    const [tab] = panelTabs()
    expect(tab!.kind).toBe('browser')
    expect(tab!.url).toBe('http://localhost:8000')

    setSidePanel('files')
    openBrowserTab('http://localhost:8000')
    expect(panelTabs().length).toBe(1)
    expect(activePanelTab()).toBe(tab!.id)

    // 地址栏跳走之后记的是新地址，翻回去认的也是它。
    setPanelTabUrl(tab!.id, 'http://localhost:8000/about')
    openBrowserTab('http://localhost:8000')
    expect(panelTabs().length).toBe(2)
  })

  test('关掉当前那一页 —— 落到右边那页，不收起面板', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('browser')
    const [first, second] = panelTabs()
    setSidePanel({ tab: first!.id })
    closePanelTab(first!.id)
    expect(activePanelTab()).toBe(second!.id)
  })

  test('关掉最右那一页 —— 落到左边那页', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('browser')
    const [first, second] = panelTabs()
    setSidePanel({ tab: second!.id })
    closePanelTab(second!.id)
    expect(activePanelTab()).toBe(first!.id)
  })

  test('关掉最后一页 —— 回文件视图而不是把面板收起来', () => {
    reset()
    openPanelTab('browser')
    closePanelTab(panelTabs()[0]!.id)
    expect(panelTabs().length).toBe(0)
    expect(sidePanel()).toBe('files')
  })

  test('关掉的不是当前那一页 —— 当前这页不动', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('browser')
    const [first, second] = panelTabs()
    setSidePanel({ tab: second!.id })
    closePanelTab(first!.id)
    expect(activePanelTab()).toBe(second!.id)
  })

  test('关一页收一次它登记的资源，只收自己那一份', () => {
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
    // 已经关掉的再关一次不该再收一遍：那一侧是 kill 进程。
    closePanelTab(first!.id)
    expect(closed).toBe('a')
  })

  test('换项目把每一页都收掉', () => {
    reset()
    openPanelTab('terminal')
    openPanelTab('browser')
    let closed = 0
    for (const t of panelTabs()) {
      holdPanelTab(t.id, () => {
        closed += 1
      })
    }
    closeAllPanelTabs()
    expect(closed).toBe(2)
    expect(panelTabs().length).toBe(0)
    expect(sidePanel()).toBe('files')
  })

  test('收起再展开回到那一页 —— 和固定视图同一条路', () => {
    reset()
    openPanelTab('terminal')
    const id = panelTabs()[0]!.id
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(activePanelTab()).toBe(id)
  })

  test('记着的那一页在收起期间没了 —— 展开回文件视图，不是一块点不掉的空白', () => {
    reset()
    openPanelTab('terminal')
    togglePanel()
    closeAllPanelTabs()
    togglePanel()
    expect(sidePanel()).toBe('files')
  })
})

describe('接口错误还原成人话', () => {
  const err = (body: unknown) =>
    new Error(`422 /api/config: ${typeof body === 'string' ? body : JSON.stringify(body)}`)

  test('挖出 problems 数组，逐条说清哪里不合格', () => {
    const msg = explainApiError(
      err({ error: 'invalid', problems: ['缺 model', '缺 baseUrl'] }),
      '保存失败',
    )
    expect(msg).toBe('缺 model；缺 baseUrl')
  })

  test('没有 problems 就用 message', () => {
    expect(explainApiError(err({ message: '档案不存在' }), '保存失败')).toBe('档案不存在')
  })

  test('problems 优先于 message', () => {
    expect(explainApiError(err({ problems: ['甲'], message: '乙' }), 'x')).toBe('甲')
  })

  test('空的 problems 数组不算数，继续找 message', () => {
    expect(explainApiError(err({ problems: [], message: '乙' }), 'x')).toBe('乙')
  })

  test('响应体被截断解析不了时，回落到原文而不是泛化提示 —— 原文再难看也带着信息', () => {
    const raw = '422 /api/config: {"problems":["缺 mod'
    expect(explainApiError(new Error(raw), '保存失败')).toBe(raw)
  })

  test('不是 JSON 的错误，原样交出去', () => {
    expect(explainApiError(new Error('fetch failed'), '保存失败')).toBe('fetch failed')
  })

  test('非 Error 抛出物也不崩', () => {
    expect(explainApiError('炸了', '保存失败')).toBe('炸了')
  })

  test('只有空消息时才用兜底文案', () => {
    expect(explainApiError(new Error(''), '保存失败')).toBe('保存失败')
  })
})

/**
 * 事件的会话归属校验（`store/connection.ts` 的 `applyEvent`）。
 *
 * 这一组锁的是一个**症状**：切了会话，正文却是上一条会话的；偶尔还会卡死。
 * 根因不在切换那段代码里——服务端的订阅过滤挡不住 `subscribe` 指令的往返窗口，
 * 那一段是物理存在的，所以接收端必须自己判一次。
 *
 * 断言形状是原始失败形状：喂一条**别的会话**的事件，看当前会话的投影有没有被污染。
 */
describe('事件按会话归属过滤', () => {
  const reset = (activeConversation: string | null) => {
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

  test('别的会话的正文不写进当前 transcript —— 这就是「切了还是上一条」', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_other', '别人的话'))
    expect(transcript()).toHaveLength(0)
  })

  /**
   * 右侧开着的那一页子会话同时在收事件。
   *
   * **原始失败形状**：子 agent 跑着的时候那一页一个字都没有——它的帧因为「不是当前
   * 会话」被整帧丢掉。开着那一页时必须落进它自己那一份，且不许溢到当前会话这一份上。
   *
   * 走的是真路径：开页 → `syncViews` 建表并报订阅。直接 `openView` 建的表会被
   * 下一次 `syncViews` 撤掉——没有哪一页开着它。
   */
  test('开着那一页的子会话，帧落进它自己那一份', () => {
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
      event: { type: 'run.retrying', runId: 'run_1', attempt: 2, max: 5 },
    } as never)

    expect(
      viewOf('cv_child')
        .transcript.map((t) => t.text)
        .join(''),
    ).toContain('子 agent 在写的话')
    // 当前会话这一份一个字都不该多。
    expect(transcript()).toHaveLength(0)
    expect(state.todos).toHaveLength(0)
    expect(viewOf('cv_child').lastEventAt).not.toBe(null)
    expect(viewOf('cv_child').usage?.inputTokens).toBe(12)
    expect(viewOf('cv_child').retry).toEqual({ attempt: 2, max: 5 })
    expect(view().usage).toBe(null)
    expect(view().retry).toBe(null)
    closePanelTab('conversation-cv_child')
    syncViews()
  })

  test('新派出的单个子 agent 只在卡片规范字段保存子会话 id', () => {
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
        memberId: 'child',
        roleName: 'GLM 赛车开发者',
        backend: 'builtin',
        phase: 'working',
        childConversationId: 'cv_child_live',
      },
    } as never)

    const card = transcript().find((item) => item.id === 'st_delegate')
    expect(card?.childConversationId).toBe('cv_child_live')
    expect(card?.nodes?.[0]?.conversationId).toBeUndefined()
  })

  test('子会话历史里的待办不另建顶部投影，也不写进父会话清单', async () => {
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

  /** 关掉那一页之后再到达的帧没有落点，整帧丢弃——不能落回当前会话。 */
  test('关掉那一页之后，它的帧不再有落点', () => {
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

  test('自己会话的正文照常写入', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_now', '我的话'))
    // 正文走匀速呈现，先冲一次再看：flush 由下一条非 delta 事件触发。
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
   * `git.state` 由服务端在握手、切项目、`.git/HEAD` 变了时广播。它不进 transcript，
   * 冲缓冲毫无必要，而冲了的现象是：正文匀速输出一阵、到这一条时把攒着的几十个字
   * 一次性排空。
   */
  test('git 轮询不冲正文缓冲', () => {
    reset('cv_now')
    applyEvent(deltaFrame('cv_now', '正在写的一段话'))
    applyEvent({
      seq: 2,
      at: 0,
      event: { type: 'git.state', workspaceId: 'ws_1', branch: 'master' },
    } as never)
    expect(transcript()).toHaveLength(0)

    // 真要落 transcript 的事件照旧冲——否则读数条会排在半段正文后面。
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

  test('没有归属的是工作区级事件，照样放行', () => {
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

  test('别的会话的 run.started 不会写进当前会话的 run 投影', () => {
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
    // 中断按钮发的是 lastRunId，串台的表现是「点停止停掉了别人那一轮」。
    expect(view().runStartedAt).toBe(null)
  })

  /*
   * 服务端自己发起的那几轮（目标续起、定时触发、跟进消息火发）没有客户端的
   * 乐观插入，用户那句话只能从 `run.started` 带的正文来。
   *
   * 真机上先漏了这一手：排队的消息跑完自动起了下一轮，账本里那条消息在、
   * 模型的回答也在，唯独用户自己那句话在界面上不存在，要刷新一次才出现。
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

  test('服务端自己发起的那一轮，用户消息由 run.started 补出来', () => {
    reset('cv_now')
    applyEvent(runStarted('cv_now', 'ms_1', { content: '排着的那一句' }))
    expect(transcript().map((i) => [i.kind, i.text, i.id])).toEqual([
      ['user', '排着的那一句', 'ms_1'],
    ])
  })

  test('界面上按回车那条不会因此变成两条，且 id 换成账本里的真值', () => {
    reset('cv_now')
    setState('views', 'cv_now', 'transcript', [{ id: 'local_1', kind: 'user', text: '我打的那句' }])
    applyEvent(runStarted('cv_now', 'ms_2', { content: '我打的那句' }))
    expect(transcript()).toHaveLength(1)
    // id 对齐之后，活的这一份与刷新后从账本投影出来的那一份是同一个键。
    expect(transcript()[0]?.id).toBe('ms_2')
  })

  /**
   * 忙闲反过来：它是**工作区级事件**，别的会话那条必须收下——左栏要为列表里
   * 每一条画状态。原始失败形状是「只有点开的那条会话才转圈，别的在跑也看不出来」。
   */
  test('别的会话的忙闲照收，左栏据此点亮那一行', () => {
    reset('cv_now')
    applyEvent({
      seq: 5,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_other', busy: true },
    } as never)
    expect(state.busyConversations).toEqual(['cv_other'])
    // 当前这条没在跑，输入框不能跟着变成停止按钮。
    expect(isRunning()).toBe(false)

    applyEvent({
      seq: 6,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_other', busy: false },
    } as never)
    expect(state.busyConversations).toEqual([])
  })

  /*
   * ── 断流重发的那句「正在重连 N / M」 ──
   *
   * 服务端不发配对的「重发结束」事件（理由在 `RunRetryingEvent` 上），收场全靠
   * `RESUMED` 那张表 + 入口那一处判断。这一组锁的就是收场：不收场的表现是
   * 整轮跑完了，阶段那一格还钉在「正在重连 3 / 5」。
   */
  const retryFrame = (seq: number, attempt: number) =>
    ({
      seq,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'run.retrying', runId: 'run_1', attempt, max: 5 },
    }) as never

  test('重发的进度照收，界面据此把阶段改口', () => {
    reset('cv_now')
    applyEvent(retryFrame(1, 3))
    expect(viewOf('cv_now').retry).toEqual({ attempt: 3, max: 5 })
  })

  test('新那次一出思考就收场——不收场的话整轮跑完还钉在「正在重连」上', () => {
    reset('cv_now')
    applyEvent(retryFrame(1, 1))
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: { type: 'thinking.delta', runId: 'run_1', stepId: 'st_2', delta: '重来一遍' },
    } as never)
    expect(viewOf('cv_now').retry).toBe(null)
  })

  test('工作区级事件不收场——后台一次文件改动不该把这句话抹掉', () => {
    reset('cv_now')
    applyEvent(retryFrame(1, 2))
    applyEvent({
      seq: 2,
      at: 0,
      event: { type: 'git.state', workspaceId: 'ws_1', branch: 'master' },
    } as never)
    expect(viewOf('cv_now').retry).toEqual({ attempt: 2, max: 5 })
  })

  test('额度用满整轮报错，也要收场', () => {
    reset('cv_now')
    applyEvent(retryFrame(1, 5))
    applyEvent({
      seq: 2,
      at: 0,
      conversationId: 'cv_now',
      event: {
        type: 'run.error',
        runId: 'run_1',
        code: 'network_error',
        message: '连接被断开，已重发 5 次',
      },
    } as never)
    expect(viewOf('cv_now').retry).toBe(null)
  })

  /** 别的会话开跑不算这条会话「有动静」——算进去的话静默检测永远报不出来。 */
  test('别的会话的忙闲不刷新「上一次有动静」', () => {
    reset('cv_now')
    setState('views', 'cv_now', 'lastEventAt', 1)
    applyEvent({
      seq: 7,
      at: 0,
      event: { type: 'conversation.busy', conversationId: 'cv_other', busy: true },
    } as never)
    expect(viewOf('cv_now').lastEventAt).toBe(1)
  })

  /**
   * 反过来的那一半：`conversation.updated` 改的是**左栏列表**，不是 transcript，
   * 对后台会话同样有意义。一刀切按当前会话丢，会让后台会话的标题永远停在「新对话」。
   */
  test('后台会话的属性变更仍然落到列表上', () => {
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
})

/**
 * 运行面板的重取判据（`store/state.ts` 的 `ledgerRevision`）。
 *
 * 原始失败形状：一轮跑了十分钟，运行面板上的步数、金额、逐请求表停在开跑那一刻
 * ——判据只报会话与忙闲，而账本每落一步、每次 usage 回报都在变。
 * 所以断言的是「账本变了，号跟着变」，不是「重取了几次」。
 */
describe('账本修订号跟着落库走', () => {
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

  test('多落一步就换一个号', () => {
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

  test('provider 回报一次用量就换一个号', () => {
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

  /** 只有动静、没有落库的那一类不能换号，否则重取被拉到 token 频率。 */
  test('「上一次有动静」变了不换号', () => {
    startRun()
    const before = ledgerRevision()
    setState('views', 'cv_1', 'lastEventAt', 123456)
    expect(ledgerRevision()).toBe(before)
  })
})

/** 文件快照统一失效；它与给用户看的逐路径变更摘要不是一份状态。 */
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

  test('每条事件都推进一次，同一文件连续修改也不漏', () => {
    setState({ activeConversation: 'cv_1', fileChanges: [], fileVersion: 0 })
    changed(1, 'src/main.ts', 3, 1)
    expect(state.fileVersion).toBe(1)
    changed(2, 'src/main.ts', 2, 0)
    expect(state.fileChanges.length).toBe(1)
    expect(state.fileVersion).toBe(2)
  })
})

/**
 * 刷新 / 重连之后的会话投影（`store/connection.ts` 的 `reloadActiveConversation`）。
 *
 * 这一组锁的是**账本里有、界面上却没了**的那一类。它们全都只在重拉这条路上出现，
 * 实时那条路是正常的，所以看起来一切正常——直到刷新一次。
 *
 * 用假的 `client.api` 喂账本回体，走的是真的折叠逻辑。
 */
describe('重拉会话：账本里有的，界面上就得有', () => {
  const stub = (steps: unknown[], runs: unknown[]) => {
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

  test('独立思考 step 折回来，位置在工具卡之前', async () => {
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

  test('没有思考的工具 step 不平白多出一条空折叠', async () => {
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
            childConversationId: 'cv_child_replayed',
          },
          status: 'running',
        },
      ],
      [{ ...interruptedRun, finishedAt: null, stopReason: null, status: 'running' }],
    )
    await reloadActiveConversation()

    const card = transcript().find((item) => item.id === 'st_1')
    expect(card?.childConversationId).toBe('cv_child_replayed')
  })

  /**
   * 后台进程被杀之后，账本里那一轮已经是 `interrupted`，界面要据此把那一轮的收尾
   * 画出来。**「在不在跑」不从这里读**：账本那行在进程崩过之后可能还挂着
   * `running`，照它写就会把界面永久钉在执行中，而新进程的 `RunManager` 里
   * 没有这条 run。放下它的是握手报的那份忙闲快照。
   */
  test('账本里那一轮是中断态，重拉之后收尾条目在，执行中不再由账本决定', async () => {
    setState({ activeConversation: 'cv_1', busyConversations: [] })
    freshView('cv_1')
    stub([toolStep()], [interruptedRun])
    await reloadActiveConversation()

    expect(isRunning()).toBe(false)
    expect(transcript().at(-1)?.run?.stopReason).toBe('user_interrupt')
  })

  /** 反过来的那一半：账本那行还挂着 `running`，重拉也不许把界面点回执行中。 */
  test('账本里还挂着在跑，忙闲快照说没跑 —— 以快照为准', async () => {
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
   * 原始失败形状：一轮跑到一半重连，读数条上的 `↓入 ↑出 / 命中 / 金额` 整组消失，
   * 要等下一次模型调用回报 usage 才凭空长回来。它不是易失量——`runs` 行有这一列，
   * 每收到一次 provider 的 usage 就写一次。
   */
  test('正在跑的那一轮，用量跟着重拉一起回来，不清空', async () => {
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

    // 重拉不许把忙闲那张表洗掉：它由握手快照与 `conversation.busy` 维持。
    expect(isRunning()).toBe(true)
    expect(viewOf('cv_1').usage?.inputTokens).toBe(30_000)
    expect(viewOf('cv_1').usage?.cost).toBe(0.02)
  })

  test('首屏和更早页各只发一个历史请求，前插后顺序不乱', async () => {
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

  test('快速从 A 点到 B 会撤销 A，A 的迟到结果不能覆盖 B', async () => {
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
 * 当前目标（`store/connection.ts` 里 `goal` 事件与重拉时的读回）。
 *
 * 两条路都要锁，因为**它们各自补的是对方的盲区**：事件那条只在目标变更的那一刻
 * 发一次，读回那条只在打开会话时跑一次。少了读回，进程重启之后账本里那个目标
 * 在界面上凭空消失——而续起标记不落盘，它是**不会自己再跑**的那一个，
 * 只能等用户点继续。自动循环不可见时，用户无从判断它还在不在跑。
 */
describe('当前目标：事件推过来，刷新之后还得在', () => {
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

  test('目标变更实时落进 state', () => {
    setState({ activeConversation: 'cv_1', goal: null })
    applyEvent({ seq: 1, at: 0, conversationId: 'cv_1', event: { type: 'goal', goal } } as never)
    expect(state.goal?.objective).toBe('把门禁跑绿')
  })

  test('别的会话的目标不落到当前会话上', () => {
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
   * **原始失败形状**：目标停在受阻上，用户刷新一次页面——目标是什么、为什么停，
   * 界面上一样都没有，只剩一条看起来正常结束的会话。
   */
  test('重拉会话时从账本读回来，理由跟着一起回来', async () => {
    setState({ activeConversation: 'cv_1', goal: null })
    freshView('cv_1')
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/history')) {
        return { messages: [], runs: [], steps: [], todos: [], nextCursor: null }
      }
      if (p.includes('/goal')) {
        return {
          goal: {
            ...goal,
            status: 'blocked',
            blockedCode: 'no_progress',
            blockedReason: '上一轮在原地打转：同样的调用、同样的结果。',
          },
        }
      }
      throw new Error('没有上下文面板')
    }
    await reloadActiveConversation()

    expect(state.goal?.status).toBe('blocked')
    expect(state.goal?.blockedReason).toContain('原地打转')
  })
})

/**
 * 报错正文的落点。覆盖 `store/connection.ts` 的 `run.error` / `run.finished` 两支。
 *
 * **原始失败形状**：一轮因为连不上接口而停了，读数条上只有「模型服务出错」
 * 五个字，真正说得出该干什么的那句（「网络不可达：检查接口地址与代理」）
 * 挂在另一张卡上——同一件事两个地方说，而那张卡刷新一次就没了。
 */
describe('报错正文并进这一轮的读数条', () => {
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

  test('收尾时正文进条目，全局那份放下——不能两处都说', () => {
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

  /** 正常收尾没有正文，读数条回落到停止原因的通用说法。 */
  test('没出错的那一轮 errorMessage 是 null', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    applyEvent(finishedFrame())
    expect(transcript().find((t) => t.kind === 'run')?.run?.errorMessage).toBe(null)
  })

  /**
   * 另一半：`run.error` 之后**没有** `run.finished`（没配 key、档案解析失败）。
   * 那一半没有 run 行可挂，全局那份必须留着，否则一个字都看不到。
   */
  test('没有收尾事件时全局那份留着', () => {
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
 * 起因是一次真实断流：服务端 262 秒一个字节都没收到，而界面上只有一个越走越大的
 * 总耗时配一句「正在思考…」——两者都没说出真相，用户直到最后报错才知道断了。
 *
 * 静默时长本身不需要新协议字段：每一帧的到达时刻，客户端本地就有。
 * 这一组锁的就是「它真的知道」。
 */
describe('事件到达时刻按帧记下来', () => {
  const frame = (type: string, extra: Record<string, unknown> = {}) =>
    ({
      seq: 9,
      at: 0,
      conversationId: 'cv_now',
      event: { type, runId: 'run_1', ...extra },
    }) as never

  test('任何一帧到达都刷新「上一次有动静」', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    applyEvent(frame('todos', { todos: [] }))
    const first = viewOf('cv_now').lastEventAt
    expect(first).not.toBe(null)
  })

  /**
   * 归属不是当前会话的帧不能刷新它——否则后台会话每动一下，
   * 前台这条就被判成「刚有动静」，静默永远不会显示出来。
   */
  test('别的会话的帧不刷新它', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    setState('views', 'cv_now', 'lastEventAt', 1)
    applyEvent({
      seq: 10,
      at: 0,
      conversationId: 'cv_other',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(viewOf('cv_now').lastEventAt).toBe(1)
  })

  /** 收尾之后清掉：留着的话下一轮开头会拿上一轮的时刻算，起手就报出错误的静默时长。 */
  test('run 收尾后清空', () => {
    setState({
      activeConversation: 'cv_now',
      busyConversations: ['cv_now'],
    })
    freshView('cv_now')
    setState('views', 'cv_now', 'lastEventAt', 1)
    applyEvent(
      frame('run.finished', {
        status: 'done',
        stopReason: 'completed',
        usage: null,
        stepCount: 1,
        durationMs: 1,
        fileChanges: [],
      }),
    )
    expect(viewOf('cv_now').lastEventAt).toBe(null)
  })
})

/**
 * 模型目录是配置的派生态，**失效点只有一个**：配置落盘那一处。
 *
 * 各个组件自己持一份缓存的实测后果：设置页校准完思考写回了配置，
 * 输入区那份目录还是开屏时拉的，档位要整页重载才出现。
 */
describe('配置一落盘，模型目录跟着重算', () => {
  test('保存之后目录是保存后的那一份', async () => {
    const calls: string[] = []
    let levels = ['low']
    // 与上面几组同样直接替换 `client.api`：这一条测的是「谁在什么时候重算」，
    // 不是 HTTP 那一层。
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
    // 目录是保存**之后**取的：反过来取到的是落盘前那一份，看起来像没生效。
    expect(calls.indexOf('GET /api/models')).toBeGreaterThan(calls.indexOf('PUT /api/config'))
  })
})

/**
 * 工具卡的实时输出（`store/connection.ts` 的 `tool.delta`）。
 *
 * 断言形状是原始失败形状：`tool.delta` 的 stepId 为空串时（服务端装配执行上下文
 * 时还没有 step），这里 `find` 一条也匹配不上，`if (!item) return` 把整条通道
 * 静默丢掉——命令跑多久，卡片就空多久，而事件一直在发。
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
   * 中途输出是合帧落地的（同一档里的若干段并成一次），所以这里用一个会冲缓冲的
   * 事件来断言，而不是靠等定时器——**任何要读 transcript 的事件之前一定先落地**。
   */
  test('落到 tool.started 开出来的那张卡上', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    applyEvent(started('st_tool_1'))
    applyEvent(delta('st_tool_1', '第一行\n'))
    applyEvent(delta('st_tool_1', '第二行\n'))
    applyEvent(finished('st_tool_1'))
    expect(transcript().find((t) => t.id === 'st_tool_1')?.stdout).toBe('第一行\n第二行\n')
  })

  /**
   * 认不出归属就丢掉，**不要退化成「贴到最后一张正在跑的卡上」**：
   * 一波里可以有多个工具同时在跑，贴错的输出比没有输出更难查。
   */
  test('认不出 stepId 的一律不落卡', () => {
    setState({ activeConversation: 'cv_now' })
    freshView('cv_now')
    applyEvent(started('st_tool_1'))
    applyEvent(delta('', '认不出归属的一行\n'))
    applyEvent(finished('st_tool_1'))
    expect(transcript().find((t) => t.id === 'st_tool_1')?.stdout).toBeUndefined()
  })
})

/**
 * 收尾走两帧：`run.finished` 落下收尾条并交接读数，`conversation.busy` 随后才放闲。
 * 中间那一帧按忙闲判的话，流尾同一个位置上下画着两条读数条。
 */
describe('收尾条落下就算这一轮完了，不等忙闲', () => {
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

  test('跑着的时候不算完', () => {
    fresh()
    applyEvent(started('run_a'))
    expect(runClosed()).toBe(false)
  })

  test('收尾条一落下就算完，此时忙闲还挂着', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    expect(isRunning()).toBe(true)
    expect(runClosed()).toBe(true)
  })

  test('下一轮起来就不算完了', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    applyEvent(started('run_b'))
    expect(runClosed()).toBe(false)
  })

  /**
   * 另一头不能一起收掉：按下回车到 `run.started` 之间那段，读数条要在
   * （它那一格说的是「正在请求…」，而那正是用户唯一的反馈）。
   */
  test('按下回车之后、run.started 之前，活的那条读数条照挂', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    setState('busyConversations', [])
    sendMessage('接着干')
    expect(isRunning()).toBe(true)
    expect(runClosed()).toBe(false)
  })

  /**
   * 服务端自发起的轮次（目标续起、定时触发、跟进火发）没有客户端乐观插入，
   * 流尾仍是上一轮的收尾条，而新那一轮真的在跑。按末条的 kind 判会漏掉它。
   */
  test('流尾是上一轮的收尾条时，新那一轮照样算在跑', () => {
    fresh()
    applyEvent(started('run_a'))
    applyEvent(finished('run_a'))
    applyEvent(started('run_b'))
    expect(transcript()[transcript().length - 1]?.kind).toBe('run')
    expect(runClosed()).toBe(false)
  })
})
