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
 * 所以这里先把这三样补上再动态 import，而不是去改产品代码加
 * `typeof location === 'undefined'` 的判断：那种判断只为测试存在，
 * 生产路径上永远走不到，属于 CLAUDE.md B5 说的空壳分支。
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

const {
  applyEvent,
  client,
  closePanel,
  explainApiError,
  openPanel,
  panelMaximized,
  reloadActiveConversation,
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
    openPanel('team')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('team')
  })

  test('反复开合不漂移 —— 偶数次回到展开，奇数次收起，视图始终是那一个', () => {
    openPanel('team')
    for (let i = 0; i < 6; i++) togglePanel()
    expect(sidePanel()).toBe('team')
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(sidePanel()).toBe('team')
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
   * `session.ts` 的 `openToolStep`），而这里曾经只读 `payload`。
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
})
