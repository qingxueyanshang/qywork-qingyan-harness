/**
 * 前端状态里两块**纯逻辑**的回归锁。
 *
 * 只测不需要连接、不需要 DOM 的部分。组件级行为（面板真的展开了没有、密钥有没有
 * 出现在响应里）不在这里测：那些要么已由端到端实测覆盖，要么该由服务端测试锁，
 * 搬进单测只会变成测桩。
 *
 * ## 为什么要先补几个浏览器全局
 *
 * `store.ts` 顶层 `new QyClient(...)`，而 `QyClient` 有个**字段初始化器**
 * `private readonly endpoint = resolveEndpoint()`——构造函数体是空的，但字段
 * 在实例化时就跑，它要读 `location` / `sessionStorage` / `matchMedia`。
 * 所以这里先把这几样补上再动态 import，而不是去改产品代码加
 * `typeof location === 'undefined'` 的判断：那种判断只为测试存在，
 * 生产路径上永远走不到，属于 CLAUDE.md B5 说的空壳分支。
 *
 * `localStorage` 是同样的理由：面板宽度要落盘，没有它整条走进 catch。
 *
 * **别在这里断言「模块加载时读出来的宽度」**：`bun test` 一次跑多个文件共用一份
 * 模块表，`client.test.ts` 先一步 import 过 `client.ts`，`store/ui.ts` 在这几行
 * 补全局之前就已经求值完了。断言它的结果，单跑这个文件是绿的，跑全量是红的。
 */

import { describe, expect, test } from 'bun:test'

/** 与 `store/ui.ts` 的 `PANEL_MIN` 对齐。它没导出——导出一个常数只为让测试读它，
 *  等于为测试改产品接口。 */
const PANEL_MIN_PX = 280

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
  applyEvent,
  client,
  closeAllPanelTabs,
  closePanel,
  closePanelTab,
  explainApiError,
  holdPanelTab,
  openPanel,
  openPanelTab,
  panelMaximized,
  panelTabs,
  panelWidth,
  reloadActiveConversation,
  resizePanel,
  setSidePanel,
  setState,
  sidePanel,
  state,
  togglePanel,
  togglePanelMax,
} = await import('./store/index.ts')

describe('右侧面板：一个按钮管开合，并记住上次看的视图', () => {
  test('收起状态下点开，回到默认的文件视图', () => {
    setSidePanel(null)
    togglePanel()
    expect(sidePanel()).toBe('files')
  })

  test('展开状态下点，收起', () => {
    openPanel('git')
    togglePanel()
    expect(sidePanel()).toBe(null)
  })

  test('收起再展开，回到上次待的地方而不是一律跳回文件', () => {
    openPanel('git')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('git')
  })

  test('换过几次视图后，记住的是最后那个', () => {
    openPanel('files')
    openPanel('git')
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
    openPanel('git')
    closePanel()
    togglePanel()
    expect(sidePanel()).toBe('git')
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
    setSidePanel('git')
    expect(panelMaximized()).toBe(true)
    closePanel()
    expect(panelMaximized()).toBe(false)
  })
})

/**
 * 可多开的那些页（终端、浏览器）。
 *
 * 测的是**关掉一页之后停在哪、什么被收掉**——这两条错了的表现分别是「面板莫名收起」
 * 和「PTY 留在后台，工作区里的文件句柄被攥着」，都不会报错。
 */
/*
 * 面板宽度这一节**只锁「要多宽」这半边**。
 *
 * 「实际排多宽」由 `.app.with-panel` 的 `minmax(var(--chat-min), 1fr)` 裁决，
 * 那是网格的事，这里没有 DOM 也没有窗口，量不到——所以下面不会出现任何一条
 * 「窗口 1280、存了 1632，于是应该是 800」的断言。**那条断言写在这里就是假的**：
 * 它只能证明这个文件里又抄了一遍 CSS 的算法。原始失败形状（存 1632、窗口 1280）
 * 由浏览器里跑的那次实测覆盖，见 docs/plans。
 */
describe('面板宽度：拖出来的数照原样记住', () => {
  test('拖不足夹在下限——再窄这块面板就没法看了', () => {
    resizePanel(100)
    expect(panelWidth()).toBe(PANEL_MIN_PX)
    // 负数尤其要挡：`minmax(0, -50px)` 会让整条 grid-template-columns 失效，
    // 网格退回隐式 auto 列，那正是要防的那种崩法。
    resizePanel(-50)
    expect(panelWidth()).toBe(PANEL_MIN_PX)
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

  test('压根不是 JSON 的错误，原样交出去', () => {
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
    setState({ activeConversation, transcript: [], conversations: [], running: false })
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
    expect(state.transcript).toHaveLength(0)
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
    expect(state.transcript.map((t) => t.text).join('')).toContain('我的话')
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
        retryable: false,
      },
    } as never)
    expect(state.error?.message).toBe('工作区级错误')
  })

  test('别的会话的 run.started 不会把当前会话点亮成「执行中」', () => {
    reset('cv_now')
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
        retryOfRunId: null,
      },
    } as never)
    expect(state.running).toBe(false)
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
 * 刷新 / 重连之后的会话投影（`store/connection.ts` 的 `reloadActiveConversation`）。
 *
 * 这一组锁的是**账本里有、界面上却没了**的那一类。它们全都只在重拉这条路上出现，
 * 实时那条路好好的，所以看起来一切正常——直到你刷新一次。
 *
 * 用假的 `client.api` 喂账本回体，走的是真的折叠逻辑。
 */
describe('重拉会话：账本里有的，界面上就得有', () => {
  const stub = (steps: unknown[], runs: unknown[]) => {
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/messages')) {
        return { messages: [{ id: 'ms_1', role: 'user', content: '为什么动不了', createdAt: 1 }] }
      }
      // 先判 `/steps`：run 的 steps 路径是 `/api/runs/<id>/steps`，两条都含 `/runs`。
      if (p.includes('/steps')) return { steps }
      if (p.includes('/runs')) return { runs }
      throw new Error('没有上下文面板')
    }
  }

  const toolStep = (thinking: string) => ({
    id: 'st_1',
    seq: 1,
    kind: 'tool_action',
    toolName: 'run_command',
    content: thinking,
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
    supersededBy: null,
  }

  /**
   * **原始失败形状**：一轮跑了十分钟，大半时间产出的是思考；进程被掐断、界面重拉
   * 之后，思考一条不剩。它落在批次首条工具 step 的 `content` 上（后端
   * `session.ts` 的 `openToolStep`），只读 `payload` 的话就会漏掉。
   */
  test('思考正文跟着工具 step 折回来，位置在工具卡之前', async () => {
    setState({ activeConversation: 'cv_1', transcript: [], running: true })
    stub([toolStep('先看看这台机器的显卡')], [interruptedRun])
    await reloadActiveConversation()

    expect(state.transcript.map((t) => t.kind)).toEqual(['user', 'thinking', 'tool', 'run'])
    expect(state.transcript[1]?.text).toBe('先看看这台机器的显卡')
  })

  test('没有思考的工具 step 不平白多出一条空折叠', async () => {
    setState({ activeConversation: 'cv_1', transcript: [], running: true })
    stub([toolStep('')], [interruptedRun])
    await reloadActiveConversation()

    expect(state.transcript.map((t) => t.kind)).toEqual(['user', 'tool', 'run'])
  })

  /**
   * 后台进程被杀之后，账本里那一轮已经是 `interrupted`。**界面必须据此放下
   * 「执行中」**——这是重连后唯一能纠正它的地方，事件那条路已经随进程一起没了。
   */
  test('账本里那一轮是中断态，重拉之后输入框不再卡在执行中', async () => {
    setState({ activeConversation: 'cv_1', transcript: [], running: true })
    stub([toolStep('思考')], [interruptedRun])
    await reloadActiveConversation()

    expect(state.running).toBe(false)
    expect(state.transcript.at(-1)?.run?.stopReason).toBe('user_interrupt')
  })

  /**
   * 原始失败形状：进程在工具执行期间退出，那一行原本是「运行命令 · nvidia-smi -L」，
   * 恢复落终态时 payload 被整份盖掉，剩下一个空标题加一个红「失败」——而这一轮
   * 末尾的读数条已经写着「上次进程在工具执行期间退出」。同一件事两处说，
   * 其中一处什么也没说清。
   */
  test('账本里那条没有 action 的 step 不出行，理由由读数条那一句负责', async () => {
    const settled = {
      ...toolStep(''),
      status: 'failure',
      // 恢复流程盖出来的形状：只有 outcome，没有 action / args。
      payload: {
        kind: 'tool_result',
        outcome: { status: 'failure', executed: true, message: '执行期间进程退出或被中断' },
      },
    }
    setState({ activeConversation: 'cv_1', transcript: [], running: true })
    stub([settled], [interruptedRun])
    await reloadActiveConversation()

    expect(state.transcript.map((t) => t.kind)).toEqual(['user', 'run'])
  })

  test('思考还在的话照出——没被盖掉的东西不许跟着一起丢', async () => {
    const settled = {
      ...toolStep('先看看这台机器的显卡'),
      status: 'failure',
      payload: { kind: 'tool_result', outcome: { status: 'failure', executed: true } },
    }
    setState({ activeConversation: 'cv_1', transcript: [], running: true })
    stub([settled], [interruptedRun])
    await reloadActiveConversation()

    expect(state.transcript.map((t) => t.kind)).toEqual(['user', 'thinking', 'run'])
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
    setState({ activeConversation: 'cv_1', transcript: [], running: false, usage: null })
    stub([toolStep('思考')], [liveRun])
    await reloadActiveConversation()

    expect(state.running).toBe(true)
    expect(state.usage?.inputTokens).toBe(30_000)
    expect(state.usage?.cost).toBe(0.02)
  })
})

/**
 * 当前目标（`store/connection.ts` 里 `goal` 事件与重拉时的读回）。
 *
 * 两条路都要锁，因为**它们各自补的是对方的盲区**：事件那条只在目标变更的那一刻
 * 发一次，读回那条只在打开会话时跑一次。少了读回，进程重启之后账本里那个目标
 * 在界面上凭空消失——而续起标记不落盘，它恰恰是**不会自己再跑**的那一个，
 * 只能等用户点继续。看不见的自动循环是最坏的一种。
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
    setState({ activeConversation: 'cv_1', goal: null, transcript: [] })
    ;(client as unknown as { api: (p: string) => Promise<unknown> }).api = async (p: string) => {
      if (p.includes('/messages')) return { messages: [] }
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
      if (p.includes('/steps')) return { steps: [] }
      if (p.includes('/runs')) return { runs: [] }
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
      event: { type: 'run.error', runId: 'run_1', code: 'network_error', message, retryable: true },
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
    setState({ activeConversation: 'cv_now', transcript: [], error: null, running: true })
    applyEvent(errorFrame('网络不可达：检查接口地址与代理'))
    applyEvent(finishedFrame())

    const item = state.transcript.find((t) => t.kind === 'run')
    expect(item?.run?.errorMessage).toBe('网络不可达：检查接口地址与代理')
    expect(state.error).toBe(null)
  })

  /** 正常收尾没有正文，读数条回落到停止原因的通用说法。 */
  test('没出错的那一轮 errorMessage 是 null', () => {
    setState({ activeConversation: 'cv_now', transcript: [], error: null, running: true })
    applyEvent(finishedFrame())
    expect(state.transcript.find((t) => t.kind === 'run')?.run?.errorMessage).toBe(null)
  })

  /**
   * 另一半：`run.error` 之后**没有** `run.finished`（没配 key、档案解析失败）。
   * 那一半没有 run 行可挂，全局那份必须留着，否则一个字都看不到。
   */
  test('没有收尾事件时全局那份留着', () => {
    setState({ activeConversation: 'cv_now', transcript: [], error: null, running: true })
    applyEvent(errorFrame('未配置 API Key'))
    expect(state.error?.message).toBe('未配置 API Key')
    expect(state.transcript.some((t) => t.kind === 'run')).toBe(false)
  })
})

/**
 * 「多久没动静了」。
 *
 * 起因是一次真实断流：服务端 262 秒一个字节都没收到，而界面上只有一个越走越大的
 * 总耗时配一句「正在思考…」——两者都没说出真相，用户直到最后报错才知道断了。
 *
 * 静默时长本身不需要新协议字段：每一帧什么时候到的，客户端自己就知道。
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
    setState({ activeConversation: 'cv_now', transcript: [], lastEventAt: null })
    applyEvent(frame('todos', { todos: [] }))
    const first = state.lastEventAt
    expect(first).not.toBe(null)
  })

  /**
   * 归属不是当前会话的帧不能刷新它——否则后台会话每动一下，
   * 前台这条就被判成「刚有动静」，静默永远不会显示出来。
   */
  test('别的会话的帧不刷新它', () => {
    setState({ activeConversation: 'cv_now', transcript: [], lastEventAt: 1 })
    applyEvent({
      seq: 10,
      at: 0,
      conversationId: 'cv_other',
      event: { type: 'todos', runId: 'run_1', todos: [] },
    } as never)
    expect(state.lastEventAt).toBe(1)
  })

  /** 收尾之后清掉：留着的话下一轮开头会拿上一轮的时刻算，一开口就谎报静默。 */
  test('run 收尾后清空', () => {
    setState({ activeConversation: 'cv_now', transcript: [], running: true, lastEventAt: 1 })
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
    expect(state.lastEventAt).toBe(null)
  })
})
