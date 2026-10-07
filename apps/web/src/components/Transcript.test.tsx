/**
 * 覆盖 `Transcript.tsx` 中正文块的重渲染判据。
 *
 * 锁定的原始失败形状：会话流每追加一条（工具启动、用户消息、收尾读数），
 * 已定稿的每段正文都重新执行一次 markdown 并整段替换 innerHTML。成因是
 * `streaming` 读取全局状态（忙闲 + 末项 id），而 effect 按依赖是否通知决定是否重新执行，
 * 不按取值是否变化。逐帧实测（真实服务端与前端，两轮四步）：一段 80 个节点的
 * 正文在定稿后被整段重建 9 次，其中 5 次集中在收尾的同一毫秒内。
 *
 * 判据为节点身份：innerHTML 被重新赋值时，原有的子节点对象不再存在。
 * 流式转为定稿时的一次重渲染属于预期，因此基准取在其后。
 *
 * 本文件另外锁定三项依赖 DOM 的行为：工具图片的回放、编排画布与展开态的归属、
 * 回执不渲染；只有子 agent 运行时，收尾条之外没有第二条读数条。
 * 运行条另覆盖轮次开始时的交接：耗时列保留位置，开始时刻到达后不显示负耗时。
 *
 * DOM 在本文件中注册、用后注销，使用动态 import 的原因同 `settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const resizeCallbacks = new Map<Element, ResizeObserverCallback>()

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // 右侧面板的标签页按项目分别记录，从图卡打开子会话与 CLI 页需要存在当前项目。
  const store = await import('../lib/store/index.ts')
  store.setWorkspace({ id: 'ws_transcript', root: 'C:/ws', name: 'ws' })
  // happy-dom 不提供 ResizeObserver，而会话流的贴底跟随依赖它。
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly targets: Element[] = []

    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      this.targets.push(target)
      resizeCallbacks.set(target, this.callback)
    }

    disconnect(): void {
      for (const target of this.targets) resizeCallbacks.delete(target)
    }
  }
})
afterAll(async () => {
  await resetStore()
  await GlobalRegistrator.unregister()
})
/**
 * store 是模块级单例，`bun test` 在一个进程中运行全部文件，因此本文件修改过的字段必须恢复原值，
 * 否则其他文件中断言字段为空的测试会随文件顺序随机失败。
 */
async function resetStore() {
  const store = await import('../lib/store/index.ts')
  store.setWorkspace(null)
  store.setState({
    activeConversation: null,
    busyConversations: [],
    views: {},
    todos: [],
    fileVersion: 0,
    fileChanges: [],
    lastRunId: null,
  })
}

function resize(target: Element) {
  resizeCallbacks.get(target)?.([], {} as ResizeObserver)
}

// 覆盖历史重建、主/子会话状态判断与会话流末尾的呈现，不依赖实时 run.started 的残留。
test('主会话派发任务结束后刷新或切回，显示子任务进度且发送消息不排队', async () => {
  const store = await import('../lib/store/index.ts')
  const { render } = await import('solid-js/web')
  const { Transcript, ConversationStream } = await import('./Transcript.tsx')
  const id = 'cv_background_receipt'
  const apiBefore = store.client.api
  const sendBefore = store.client.send
  const workspaceBefore = store.workspace()
  const connectionBefore = store.state.connection
  const node = { phase: 'working', label: '赛车游戏开发', subagentId: 'cv_racer' }
  const usage = {
    inputTokens: 14,
    outputTokens: 3777,
    cachedTokens: 27761,
    cacheWriteTokens: 3249,
    reasoningTokens: 0,
    cost: 0.257581,
    currency: 'USD',
    turns: [],
  }
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
    if (!path.includes('/history')) throw new Error('本用例只提供会话历史')
    return {
      messages: [{ id: 'ms_dispatch', role: 'user', content: '做赛车游戏', createdAt: 1 }],
      runs: [
        {
          id: 'rn_dispatch',
          userMessageId: 'ms_dispatch',
          status: 'done',
          stopReason: 'completed',
          createdAt: 1_000,
          finishedAt: 52_376,
          usage,
          errorMessage: null,
        },
      ],
      steps: [
        {
          id: 'st_dispatch',
          runId: 'rn_dispatch',
          seq: 1,
          kind: 'tool_action',
          toolName: 'workflow',
          status: 'success',
          createdAt: 1_100,
          durationMs: 10,
          payload: {
            kind: 'tool_result',
            args: {
              goal: '赛车游戏',
              nodes: [
                { id: 'build', kind: 'temp', name: '赛车游戏开发', task: '开发游戏' },
                { id: 'review', kind: 'checkpoint', label: '审批赛车游戏', needs: ['build'] },
              ],
            },
            action: { kind: 'run', objectLabel: '工作流', target: '赛车游戏' },
            outcome: {
              status: 'success',
              executed: true,
              message: '已派发',
              data: { workflowId: 'st_dispatch', dispatched: ['build'] },
            },
            nodes: { build: node },
          },
        },
      ],
      live: null,
      todos: [],
      workflowStarts: [],
      nextCursor: null,
    }
  }
  ;(store.client as unknown as { send: typeof sendBefore }).send = () => {}
  store.setState({
    activeConversation: id,
    busyConversations: [id],
    views: {},
    lastRunId: null,
    followUps: [],
    connection: 'ready',
  })
  store.openView(id)
  const host = document.createElement('div')
  const panel = document.createElement('div')
  const dispose = render(() => <Transcript />, host as unknown as HTMLElement)
  const disposePanel = render(
    () => (
      <ConversationStream
        conversationId={id}
        items={store.viewOf(id).transcript}
        live={() => store.isConversationRunning(id)}
        closed={() => store.conversationRunClosed(id)}
        variant="panel"
      />
    ),
    panel as unknown as HTMLElement,
  )
  try {
    for (const reload of [false, true]) {
      if (reload) {
        store.setState('activeConversation', 'cv_elsewhere')
        store.syncViews()
        store.setState('activeConversation', id)
        store.syncViews()
      }
      await store.reloadActiveConversation()
      expect(store.viewOf(id).history.error).toBeNull()
      expect(store.state.lastRunId).toBeNull()
      expect(store.isRunning()).toBe(true)
      expect(store.hasRun()).toBe(false)
      for (const surface of [host, panel]) {
        expect(surface.querySelectorAll('.run-strip')).toHaveLength(1)
        expect(surface.querySelector('.run-live')).toBeNull()
        expect(surface.querySelector('.delegation-status')?.textContent).toContain('赛车游戏开发')
        expect(surface.querySelector('.delegation-status')?.textContent).toContain('等待子任务返回')
        expect(surface.textContent).not.toContain('命中 N/A')
      }
    }
    store.applyEvent({
      seq: 1,
      at: 55_000,
      conversationId: id,
      event: {
        type: 'team.member',
        runId: 'rn_dispatch',
        stepId: 'st_dispatch',
        nodeId: 'build',
        state: { ...node, phase: 'done', output: '已交稿' },
      },
    } as never)
    expect(host.querySelector('.delegation-status')?.textContent).toBe(
      '等待主会话审查：审批赛车游戏',
    )
    store.applyEvent({
      seq: 2,
      at: 55_001,
      event: {
        type: 'conversation.busy',
        conversationId: id,
        busy: false,
      },
    } as never)
    expect(host.querySelector('.delegation-status')).toBeNull()
    expect(host.querySelector('.run-live')).toBeNull()
    store.setState('busyConversations', [id])
    await store.reloadActiveConversation()
    store.sendMessage('补充一个要求')
    expect(store.state.followUps).toEqual([])
    expect(store.transcript().at(-1)?.text).toBe('补充一个要求')
    expect(host.querySelector('.delegation-status')).toBeNull()
    expect(host.querySelector('.run-live')?.textContent).toBe('正在请求…')

    // 自动审批开始的轮次没有乐观用户消息，末条仍是上一轮的收尾条。
    store.setState('views', id, 'transcript', store.transcript().slice(0, -1))
    await store.reloadActiveConversation()
    store.applyEvent({
      seq: 3,
      at: 60_000,
      conversationId: id,
      event: {
        type: 'run.started',
        runId: 'rn_review',
        conversationId: id,
        model: 'm',
        userMessageId: null,
      },
    } as never)
    expect(store.hasRun()).toBe(true)
    expect(host.querySelector('.delegation-status')).toBeNull()
    expect(host.querySelector('.run-live')?.textContent).toBe('正在请求…')
  } finally {
    dispose()
    disposePanel()
    ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    ;(store.client as unknown as { send: typeof sendBefore }).send = sendBefore
    await resetStore()
    store.setWorkspace(workspaceBefore)
    store.setState('connection', connectionBefore)
  }
})

test('从发送到轮次开始之间保留耗时列，开始时刻到达时同步计时且不重建运行条动画', async () => {
  const store = await import('../lib/store/index.ts')
  const { render } = await import('solid-js/web')
  const { Transcript } = await import('./Transcript.tsx')
  const workspaceBefore = store.workspace()
  const connectionBefore = store.state.connection
  const sendBefore = store.client.send
  const nowBefore = Date.now
  const id = 'cv_start_elapsed'
  let now = 100_000
  Date.now = () => now
  ;(store.client as unknown as { send: typeof sendBefore }).send = () => {}
  store.setState({
    activeConversation: id,
    busyConversations: [],
    connection: 'ready',
    views: {},
    lastRunId: null,
  })
  store.openView(id)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <Transcript />, host as unknown as HTMLElement)
  try {
    store.sendMessage('开始')
    const strip = host.querySelector('.run-strip')
    const galaxy = host.querySelector('.run-galaxy')
    const elapsed = host.querySelector('.run-elapsed')
    expect(elapsed).not.toBeNull()
    expect(elapsed?.textContent).toBe('')
    expect(strip?.querySelector('.run-live')?.textContent).toBe('正在请求…')

    // 确认事件在下一次 100ms 时钟更新前到达。
    now += 60
    store.applyEvent({
      seq: 1,
      at: now,
      conversationId: id,
      event: {
        type: 'run.started',
        conversationId: id,
        runId: 'rn_start_elapsed',
        model: 'm',
        userMessageId: null,
      },
    } as never)
    expect(host.querySelector('.run-strip')).toBe(strip)
    expect(host.querySelector('.run-galaxy')).toBe(galaxy)
    expect(host.querySelector('.run-elapsed')).toBe(elapsed)
    expect(elapsed?.textContent).toBe('0.0s')

    now += 200
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(elapsed?.textContent).toBe('0.2s')
  } finally {
    dispose()
    host.remove()
    Date.now = nowBefore
    ;(store.client as unknown as { send: typeof sendBefore }).send = sendBefore
    await resetStore()
    store.setWorkspace(workspaceBefore)
    store.setState('connection', connectionBefore)
  }
})

/**
 * 持续输出后的静默间隔按最后一段内容的时刻计算，刷新前后取值相同。
 *
 * 原始失败形状：按首段内容、步骤创建或页面加载时刻计算。t=0 收到首段、t=60 s 收到末段时，
 * 三种算法在 t=65 s 分别显示 65 秒、65 秒和 0 秒，正确值为 5 秒。
 */
test('间隔按最后内容时刻计算，刷新前后取值相同', async () => {
  const store = await import('../lib/store/index.ts')
  const workspaceBefore = store.workspace()
  const connectionBefore = store.state.connection
  const nowBefore = Date.now
  const { render } = await import('solid-js/web')
  const { LiveRunBar } = await import('./Transcript.tsx')
  const id = 'cv_silence'
  const t0 = 1_700_000_000_000
  let now = t0
  Date.now = () => now
  store.setState({
    activeConversation: id,
    busyConversations: [id],
    connection: 'ready',
    views: {},
  })
  store.openView(id)
  store.setState('views', id, 'runStartedAt', t0)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <LiveRunBar conversationId={id} />, host as unknown as HTMLElement)
  const note = () => host.querySelector('.run-live')?.textContent
  try {
    // t=0 首段、t=60 s 末段，两段均经由实时事件到达。
    store.applyEvent({
      seq: 1,
      at: t0,
      conversationId: id,
      event: {
        type: 'run.request',
        runId: 'rn_silence',
        requestId: 'pr_silence',
        phase: 'sent',
        attempt: 0,
        max: 5,
        at: t0,
      },
    } as never)
    store.applyEvent({
      seq: 2,
      at: t0,
      conversationId: id,
      event: { type: 'text.delta', runId: 'rn_silence', stepId: 'st_1', delta: '首段', at: t0 },
    } as never)
    store.applyEvent({
      seq: 3,
      at: t0,
      conversationId: id,
      event: {
        type: 'text.delta',
        runId: 'rn_silence',
        stepId: 'st_1',
        delta: '末段',
        at: t0 + 60_000,
      },
    } as never)

    // t=65 s：距末段 5 秒，未达到切换提示的阈值，状态文字仍为「正在回复…」。
    now = t0 + 65_000
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(now - store.viewOf(id).request!.lastContentAt!).toBe(5_000)
    expect(note()).toBe('正在回复…')

    // 再过 30 秒超过阈值：显示距末段的 35 秒。按首段计算会显示 95 秒。
    now = t0 + 95_000
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(note()).toBe('已 35 秒无新增内容')

    /*
     * 刷新：投影改由历史接口的快照写入，最后内容时刻取账本中的同一个值，
     * 因此状态文字保持不变。若按重新获取的时刻计算，间隔会归零，状态文字退回「正在回复…」。
     */
    store.setState('views', id, 'request', {
      requestId: 'pr_silence',
      attempt: 0,
      max: 5,
      phase: 'content' as const,
      backoffUntil: null,
      sentAt: t0,
      headersAt: t0,
      lastContentAt: t0 + 60_000,
      seq: 9,
    })
    expect(note()).toBe('已 35 秒无新增内容')
  } finally {
    dispose()
    host.remove()
    Date.now = nowBefore
    await resetStore()
    store.setWorkspace(workspaceBefore)
    store.setState('connection', connectionBefore)
  }
})

test('主会话与子会话状态行按真实参数进度显示，退避与重连仍能接管', async () => {
  const store = await import('../lib/store/index.ts')
  const workspaceBefore = store.workspace()
  const connectionBefore = store.state.connection
  const { render } = await import('solid-js/web')
  const { LiveRunBar, TranscriptRows } = await import('./Transcript.tsx')
  const ids = ['cv_progress_main', 'cv_progress_child']
  store.setState({
    activeConversation: ids[0]!,
    busyConversations: ids,
    connection: 'ready',
    views: {},
  })
  store.openConversationTab(ids[1]!, '子会话')
  store.syncViews()
  let seq = 0
  // 静默提示按当前请求的最后内容时刻计算，因此直接把投影设为已有内容输出且 31 秒无新增内容。
  const silent = (conversationId: string) =>
    store.setState('views', conversationId, 'request', {
      requestId: 'pr_progress',
      attempt: 0,
      max: 5,
      phase: 'content' as const,
      backoffUntil: null,
      sentAt: null,
      headersAt: null,
      lastContentAt: Date.now() - 31_000,
      lastContentKind: 'thinking' as const,
      lastVisibleAt: Date.now() - 60_000,
      seq: ++seq,
    })
  for (const id of ids) {
    store.openView(id)
    store.setState('views', id, 'runStartedAt', Date.now() - 60_000)
    silent(id)
  }
  store.setState('views', ids[1]!, 'transcript', [
    { id: 'st_progress_thinking', kind: 'thinking', text: '先前的思考' },
  ])
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => (
      <>
        <LiveRunBar conversationId={ids[0]!} />
        <LiveRunBar conversationId={ids[1]!} />
        <TranscriptRows
          items={store.viewOf(ids[1]!).transcript}
          live={() => true}
          generatingToolCall={() => store.viewOf(ids[1]!).generatingToolCall}
        />
      </>
    ),
    host as unknown as HTMLElement,
  )
  const progress = (conversationId: string) =>
    store.applyEvent({
      seq: ++seq,
      at: Date.now(),
      conversationId,
      event: { type: 'tool.generating', runId: 'rn_progress', at: Date.now() },
    } as never)
  const notes = () => [...host.querySelectorAll('.run-live')].map((el) => el.textContent)
  try {
    expect(notes().every((note) => note?.includes('无新增内容'))).toBe(true)
    expect(host.querySelector('.fold-label')?.textContent).toContain('思考中')
    progress(ids[0]!)
    expect(notes()[0]).toMatch(/^等待响应，已 60 秒无可见进展$/)
    expect(notes()[1]).toContain('无新增内容')
    expect(store.viewOf(ids[0]!).transcript).toHaveLength(0)
    progress(ids[1]!)
    expect(notes().every((note) => note?.includes('无可见进展'))).toBe(true)
    expect(host.querySelector('.fold-label')?.textContent).toContain('已思考')

    silent(ids[0]!)
    expect(notes()[0]).toContain('无新增内容')
    store.applyEvent({
      seq: ++seq,
      at: Date.now(),
      conversationId: ids[0],
      event: {
        type: 'run.retrying',
        runId: 'rn_progress',
        requestId: 'pr_progress',
        attempt: 1,
        max: 5,
        backoffMs: 60_000,
        at: Date.now(),
        failedThinkingStepIds: [],
      },
    } as never)
    expect(notes()[0]).toMatch(/^等待重试，(60|61) 秒后…$/)
    store.applyEvent({
      seq: ++seq,
      at: Date.now(),
      conversationId: ids[0],
      event: {
        type: 'run.request',
        runId: 'rn_progress',
        requestId: 'pr_retry',
        phase: 'sent',
        attempt: 1,
        max: 5,
        at: Date.now(),
      },
    } as never)
    expect(notes()[0]).toBe('正在重连 1 / 5…')
    store.applyEvent({
      seq: ++seq,
      at: Date.now(),
      conversationId: ids[0],
      event: {
        type: 'run.request',
        runId: 'rn_progress',
        requestId: 'pr_retry',
        phase: 'headers',
        attempt: 1,
        max: 5,
        at: Date.now(),
      },
    } as never)
    expect(notes()[0]).toBe('等待响应…')
    progress(ids[0]!)
    expect(notes()[0]).toBe('等待响应…')
    store.applyEvent({
      seq: ++seq,
      at: Date.now(),
      conversationId: ids[0],
      event: {
        type: 'tool.started',
        runId: 'rn_progress',
        stepId: 'st_progress',
        toolCallId: 'call_progress',
        toolName: 'write_file',
        batchId: 'bt_progress',
        callIndex: 0,
        waveIndex: 0,
        args: { path: 'page.html' },
        action: { kind: 'write', objectLabel: '文件', target: 'page.html' },
      },
    } as never)
    expect(notes()[0]).toBe('正在执行…')
    expect(store.viewOf(ids[0]!).generatingToolCall).toBe(false)
    store.setState('connection', 'reconnecting')
    expect(notes()).toEqual([])
  } finally {
    dispose()
    host.remove()
    store.closePanelTab(`conversation-${ids[1]}`)
    await resetStore()
    store.setWorkspace(workspaceBefore)
    store.setState('connection', connectionBefore)
  }
})

test.each(['running', 'success', 'failure'] as const)(
  '文件卡显示实际落盘路径：%s',
  async (status) => {
    const store = await import('../lib/store/index.ts')
    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const workspaceBefore = store.workspace()
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [
            {
              id: 'tool-created-path',
              kind: 'tool',
              text: '',
              toolName: 'write_file',
              action: { kind: 'write', objectLabel: '文件', target: 'page.html' },
              args: { path: 'page.html', mode: 'create', on_conflict: 'rename', content: 'new' },
              status,
              ...(status === 'success'
                ? {
                    outcome: {
                      status: 'success',
                      executed: true,
                      message: '创建 page-2.html',
                      data: { path: 'page-2.html' },
                      fileChanges: [
                        { path: 'page-2.html', changeType: 'created', additions: 1, deletions: 0 },
                      ],
                    },
                  }
                : {}),
            },
          ],
        },
      },
    })
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host)
    try {
      expect(host.querySelector('.fold-target')?.getAttribute('data-tip')).toBe(
        status === 'success' ? 'page-2.html' : 'page.html',
      )
      expect(host.querySelector('.fold-label')?.textContent).toContain('创建文件')
    } finally {
      dispose()
      host.remove()
      await resetStore()
      store.setWorkspace(workspaceBefore)
    }
  },
)

test('分段读取的文件行在路径后显示行号范围', async () => {
  const store = await import('../lib/store/index.ts')
  const { render } = await import('solid-js/web')
  const { Transcript } = await import('./Transcript.tsx')
  const workspaceBefore = store.workspace()
  store.setState({
    activeConversation: CV,
    busyConversations: [],
    views: {
      [CV]: {
        history: { loading: null, nextCursor: null, error: null },
        changes: null,
        runUserMessageId: null,
        runStartedAt: null,
        usage: null,
        generatingToolCall: false,
        request: null,
        error: null,
        transcript: [
          {
            id: 'read-mid',
            kind: 'tool',
            text: '',
            toolName: 'read_file',
            action: { kind: 'read', objectLabel: '文件', target: 'scripts/check.py' },
            args: { path: 'scripts/check.py', offset: 395, limit: 54 },
            status: 'success',
            outcome: {
              status: 'success',
              executed: true,
              message: '读取 scripts/check.py（54 行，已截断）',
              data: { content: '', startLine: 395, endLine: 448, totalLines: 700 },
            },
          },
        ],
      },
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <Transcript />, host)
  try {
    expect(host.querySelector('.fold-target')?.getAttribute('data-tip')).toBe(
      'scripts/check.py:395-448',
    )
  } finally {
    dispose()
    host.remove()
    await resetStore()
    store.setWorkspace(workspaceBefore)
  }
})

describe('工具图片回放', () => {
  test('read_file 图片只交给模型，不自动渲染为会话图片', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [
            {
              id: 'tool-image-history',
              kind: 'tool',
              text: '',
              toolName: 'read_file',
              action: { kind: 'read', objectLabel: '文件', target: 'art/result.png' },
              args: { path: 'art/result.png' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '读取 art/result.png（图片）',
                data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    try {
      const image = host.querySelector<HTMLImageElement>('.tool-images img')
      expect(image).toBeNull()
      expect((host.querySelector('details') as HTMLDetailsElement | null)?.open).toBe(false)
    } finally {
      dispose()
      host.remove()
    }
  })

  test('仅当 outcome 明确声明 inline 时恢复图片', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [
            {
              id: 'tool-image-inline',
              kind: 'tool',
              text: '',
              toolName: 'generate_image',
              action: { kind: 'run', objectLabel: '图片', target: 'art/result.png' },
              args: { path: 'art/result.png' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '生成 art/result.png',
                data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
                presentation: { images: 'inline' },
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    try {
      const image = host.querySelector<HTMLImageElement>('.tool-images img')
      expect(image).not.toBeNull()
      expect(image?.src).toBe('data:image/png;base64,aGVsbG8=')
      expect((host.querySelector('details') as HTMLDetailsElement | null)?.open).toBe(false)
    } finally {
      dispose()
      host.remove()
    }
  })
})

describe('编排画布', () => {
  test('并行节点的列有最小宽度，宽度不足时由卡片内的滚动层横向滚动', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-four',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                action: { kind: 'run', objectLabel: '工作流', target: '四个候选' },
                args: {
                  goal: '四个候选',
                  nodes: [
                    { id: 'a', kind: 'temp', name: 'glm' },
                    { id: 'b', kind: 'temp', name: 'qwen' },
                    { id: 'c', kind: 'temp', name: 'deepseek' },
                    { id: 'd', kind: 'temp', name: 'gemini' },
                  ],
                },
                status: 'running',
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const layers = host.querySelectorAll<HTMLElement>('.wf-layer')
      expect(layers).toHaveLength(3)
      expect(layers[1]?.style.gridTemplateColumns).toBe('repeat(4, minmax(128px, 1fr))')
      expect(layers[1]?.style.maxWidth).toBe('676px')
      // 滚动层位于卡片内、图位于滚动层内：卡片宽度不随节点数变化，只有图所在的一层滚动。
      expect(host.querySelector('.wf-card > .wf-scroll > .wf-graph')).not.toBeNull()
      expect(layers[1]?.querySelector('.wf-node-name')?.classList.contains('truncate')).toBe(false)
    } finally {
      dispose()
    }
  })

  test('共享入口的共线区间只生成一份路径', async () => {
    const { mergeWorkflowEdgeSegments } = await import('./Transcript.tsx')
    const paths = mergeWorkflowEdgeSegments([
      { axis: 'vertical', fixed: 100.5, from: 20.5, to: 40.5, live: false },
      { axis: 'vertical', fixed: 100.5, from: 20.5, to: 40.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 20.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 60.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 100.5, to: 180.5, live: false },
    ])

    expect(paths).toEqual([
      { d: 'M100.5 20.5V40.5', live: false },
      { d: 'M20.5 40.5H180.5', live: false },
    ])
  })

  test('活动依赖与静态依赖共线时拆分为不重叠的区间', async () => {
    const { mergeWorkflowEdgeSegments } = await import('./Transcript.tsx')
    const paths = mergeWorkflowEdgeSegments([
      { axis: 'horizontal', fixed: 40.5, from: 20.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 60.5, to: 100.5, live: true },
    ])

    expect(paths).toEqual([
      { d: 'M20.5 40.5H60.5', live: false },
      { d: 'M60.5 40.5H100.5', live: true },
    ])
  })

  /** 失败只显示红色边框与底部一行原因：卡片顶部不显示动作、状态与耗时，同一信息不重复显示。 */
  test('失败的卡片没有标题行，原因只显示在底部一行', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-head',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                action: { kind: 'run', objectLabel: '工作流', target: '四个候选' },
                args: {
                  goal: '四个候选',
                  nodes: [{ id: 'a', kind: 'temp', name: 'glm', task: '做' }],
                },
                status: 'failure',
                durationMs: 2500,
                outcome: {
                  status: 'failure',
                  executed: true,
                  message: 'Workflow 执行失败，本次返回 0 个回执',
                },
              },
              {
                id: 'sub-head',
                kind: 'tool',
                text: '',
                toolName: 'subagent',
                action: { kind: 'run', objectLabel: '子 agent', target: 'qwen-racer' },
                args: { kind: 'role', role: 'qwen-racer', task: '继续优化' },
                status: 'failure',
                outcome: { status: 'failure', executed: true, message: 'qwen-racer 失败：超时' },
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      expect(host.querySelectorAll('.wf-head')).toHaveLength(0)
      expect([...host.querySelectorAll('.wf-error')].map((e) => e.textContent)).toEqual([
        'Workflow 执行失败，本次返回 0 个回执',
        'qwen-racer 失败：超时',
      ])
      expect(host.querySelectorAll('.wf-card.failed')).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  test('排队的节点只通过样式调暗，次行仍显示其指令', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-queued',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                args: {
                  goal: '并行执行',
                  nodes: [{ id: 'fifth', kind: 'temp', name: 'gemini', task: '实现第五版' }],
                },
                status: 'running',
                nodes: { fifth: { label: 'Gemini 开发者', phase: 'queued' } },
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const cell = host.querySelector('.wf-node.queued')
      expect(cell?.querySelector('.wf-node-name')?.textContent).toBe('Gemini 开发者')
      expect(cell?.querySelector('.wf-node-task')?.textContent).toBe('实现第五版')
    } finally {
      dispose()
    }
  })

  /**
   * 种类是状态中的一个字段，主行右侧显示 `SUBAGENT_KIND_LABEL` 中对应的名称；
   * 没有状态的节点不显示标签。不要改为显示字段原值，因为它是内部枚举名。
   */
  test('每个节点按状态中的种类显示标签', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-kind',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                args: {
                  goal: '三种各一格',
                  nodes: [
                    { id: 'r', kind: 'role', role: 'reviewer', task: '审' },
                    { id: 't', kind: 'temp', name: '查资料', task: '查' },
                    { id: 'c', kind: 'cli', cli: 'claude', task: '改' },
                    { id: 'n', kind: 'temp', name: '还没派', task: '等' },
                  ],
                },
                status: 'running',
                nodes: {
                  r: { label: '审查员', phase: 'working', kind: 'role' },
                  t: { label: '查资料', phase: 'working', kind: 'temp' },
                  c: { label: 'Anthropic claude', phase: 'working', kind: 'cli' },
                },
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      expect([...host.querySelectorAll('.wf-node-kind')].map((e) => e.textContent)).toEqual([
        '角色',
        '临时',
        '外部 CLI',
      ])
    } finally {
      dispose()
    }
  })

  /**
   * 原始失败形状：继续派发的参数中只有子 agent id，按参数推测种类会把外部 CLI 识别为
   * 内置子 agent，打开后是一条没有正文的子会话。种类只从状态中读取。
   */
  test('继续派发的外部 CLI 节点打开 CLI 页', async () => {
    const { delegateEvents, render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const { closePanelTab, panelTabs } = await import('../lib/store/index.ts')
    // 点击经由 solid 的事件委托：处理器注册在 document 上，因此宿主元素必须位于文档中，
    // 而委托只在模块首次加载时注册一次，所用的 document 由其他测试文件注册。
    const host = document.createElement('div')
    document.body.append(host)
    delegateEvents(['click'])
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'st_cli',
                kind: 'tool',
                text: '',
                toolName: 'subagent',
                args: { subagent: 'cv_cli', task: '接着审' },
                status: 'running',
                nodes: {
                  child: {
                    label: 'claude 代码审查',
                    phase: 'working',
                    kind: 'cli',
                    subagentId: 'cv_cli',
                  },
                },
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const cell = host.querySelector<HTMLButtonElement>('button.wf-node')
      expect(cell?.disabled).toBe(false)
      cell?.click()
      expect(panelTabs().map((t) => [t.id, t.kind, t.title])).toEqual([
        ['cli-st_cli-child', 'cli', 'claude 代码审查'],
      ])
    } finally {
      for (const tab of panelTabs()) closePanelTab(tab.id)
      dispose()
      host.remove()
    }
  })
})

describe('子会话与主会话共用流式外壳', () => {
  test('权威忙态已到但 run.started 尚未回放时也立即显示运行条', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    let finishLoad!: (value: unknown) => void
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = () =>
      new Promise((resolve) => {
        finishLoad = resolve
      })

    store.openConversationTab('cv_child_starting', '子 agent')
    store.syncViews()
    store.setState({
      activeConversation: null,
      busyConversations: ['cv_child_starting'],
      connection: 'ready',
      views: {
        cv_child_starting: {
          transcript: [],
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child_starting" />,
      host as unknown as HTMLElement,
    )

    try {
      expect(host.querySelector('.run-strip')).not.toBeNull()
      expect(host.querySelector('.run-galaxy')).not.toBeNull()
    } finally {
      finishLoad({ messages: [], steps: [], runs: [], todos: [], nextCursor: null })
      await Promise.resolve()
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child_starting')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })

  test('不重复挂载待办，并显示自身的运行条与贴底跟随', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path,
    ) => {
      if (!path.includes('/cv_child/history')) throw new Error(`未预期请求：${path}`)
      return {
        messages: [],
        steps: [],
        runs: [
          {
            id: 'rn_child',
            userMessageId: null,
            createdAt: 100,
            finishedAt: null,
            stopReason: null,
            status: 'running',
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              cost: 0,
              currency: 'USD',
              turns: [],
            },
            errorMessage: null,
          },
        ],
        todos: [{ id: 'todo_1', content: '实现赛车', status: 'in_progress' }],
        nextCursor: null,
      }
    }

    store.openConversationTab('cv_child', '子 agent')
    store.syncViews()
    store.setState({
      activeConversation: null,
      busyConversations: ['cv_child'],
      connection: 'ready',
      views: {
        cv_child: {
          transcript: [
            {
              id: 'st_todos',
              kind: 'tool',
              text: '',
              toolName: 'write_todos',
              action: { kind: 'write', objectLabel: '待办' },
              args: {
                todos: [{ id: 'todo_1', content: '实现赛车', status: 'in_progress' }],
              },
              status: 'success',
            },
          ],
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: 100,
          usage: null,
          lastEventAt: 100,
          generatingToolCall: false,
          retry: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child" />,
      host as unknown as HTMLElement,
    )

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(host.querySelector('.child-cv-todos')).toBeNull()
      expect(host.querySelector('.run-strip')).not.toBeNull()
      expect(host.querySelector('.run-galaxy')).not.toBeNull()

      const details = host.querySelector<HTMLDetailsElement>('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Promise.resolve()
      expect(host.querySelector('.todo-list')).not.toBeNull()
      expect(host.querySelectorAll('.todo-list')).toHaveLength(1)

      const scroller = host.querySelector<HTMLElement>('.child-cv')!
      const inner = host.querySelector<HTMLElement>('.child-cv-inner')!
      expect(scroller.classList.contains('conversation-scroll')).toBe(true)
      expect(inner.classList.contains('conversation-stream-inner')).toBe(true)
      let height = 300
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, get: () => 100 },
      })
      resize(inner)
      expect(scroller.scrollTop).toBe(300)

      // 鼠标或键盘展开 details 后，浏览器会为焦点自行滚动；这不属于用户向上滚动。
      details
        .querySelector('summary')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      scroller.scrollTop = 120
      scroller.dispatchEvent(new Event('scroll'))
      height = 480
      resize(inner)
      expect(scroller.scrollTop).toBe(480)

      // 用户主动向上滚动后保留阅读位置，后续内容增长时不再滚动到底部。
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 40
      scroller.dispatchEvent(new Event('scroll'))
      height = 620
      resize(inner)
      expect(scroller.scrollTop).toBe(40)
    } finally {
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })

  /** 原始失败形状：整页刷新后会话流回到底部，刷新前的阅读位置丢失。 */
  test('刷新前未跟随底部时，恢复到刷新前距底部的距离；回到底部后不再记录', async () => {
    const store = await import('../lib/store/index.ts')
    const { readSession, writeSession } = await import('../lib/session.ts')
    const apiBefore = store.client.api
    ;(store.client as unknown as { api: () => Promise<unknown> }).api = async () => ({
      messages: [],
      steps: [],
      runs: [],
      todos: [],
      nextCursor: null,
    })
    // 本次页面加载中该会话尚未显示过、记录中有刷新前的距离，与刷新后的状态相同。
    writeSession('qywork.scroll:cv_scroll', 300)
    store.openConversationTab('cv_scroll', '子 agent')
    store.syncViews()
    store.setState({
      activeConversation: null,
      busyConversations: [],
      connection: 'ready',
      views: {
        cv_scroll: {
          transcript: [],
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
        },
      },
    } as never)
    const proto = HTMLElement.prototype
    const height = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
    const client = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 100 })

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_scroll" />,
      host as unknown as HTMLElement,
    )

    try {
      const scroller = host.querySelector<HTMLElement>('.child-cv')!
      for (let i = 0; i < 100 && scroller.scrollTop !== 600; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(scroller.scrollTop).toBe(600)

      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 200
      scroller.dispatchEvent(new Event('scroll'))
      expect(readSession<number>('qywork.scroll:cv_scroll')).toBe(700)

      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))
      scroller.scrollTop = 900
      scroller.dispatchEvent(new Event('scroll'))
      expect(readSession('qywork.scroll:cv_scroll')).toBeUndefined()
    } finally {
      for (const [name, d] of [
        ['scrollHeight', height],
        ['clientHeight', client],
      ] as const) {
        if (d) Object.defineProperty(proto, name, d)
        else Reflect.deleteProperty(proto, name)
      }
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_scroll')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })

  test('父步骤不能替子会话伪造忙态', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path,
    ) => {
      if (!path.includes('/cv_child_legacy/history')) throw new Error(`未预期请求：${path}`)
      return { messages: [], steps: [], runs: [], todos: [], nextCursor: null }
    }

    store.openConversationTab('cv_child_legacy', '旧进程成员')
    store.syncViews()
    store.setState({
      activeConversation: 'cv_parent',
      busyConversations: ['cv_parent'],
      connection: 'ready',
      views: {
        cv_parent: {
          transcript: [
            {
              id: 'delegate-running',
              kind: 'tool',
              text: '',
              toolName: 'subagent',
              args: { kind: 'role', role: 'qwen-racer', task: '继续修复' },
              status: 'running',
              nodes: {
                child: {
                  label: 'Qwen 赛车开发者',
                  phase: 'working',
                  subagentId: 'cv_child_legacy',
                },
              },
            },
          ],
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: 100,
          usage: null,
          lastEventAt: 100,
          generatingToolCall: false,
          retry: null,
          error: null,
        },
        cv_child_legacy: {
          transcript: [{ id: 'thinking-child', kind: 'thinking', text: '仍在处理最新内容' }],
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child_legacy" />,
      host as unknown as HTMLElement,
    )

    try {
      await Promise.resolve()
      expect(host.querySelector('.run-strip')).toBeNull()
      expect(host.querySelector('.fold-label')?.textContent).toContain('已思考')
    } finally {
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child_legacy')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })
})

const CV = 'cv_prose'

describe('定稿的正文不随会话流的增长重建', () => {
  test('用户长消息按实际高度判断折叠，并可在右下角展开和收起', async () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent && this.textContent.length > 100 ? 240 : 20
      },
    })

    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [
            { id: 'u-short', kind: 'user', text: '短消息' },
            { id: 'u-long', kind: 'user', text: '这是一条需要收敛的长消息。'.repeat(12) },
          ],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    try {
      const bubbles = host.querySelectorAll('.bubble')
      expect(bubbles).toHaveLength(2)
      expect(bubbles[0]?.classList.contains('collapsible')).toBe(false)

      const longBubble = bubbles[1] as HTMLElement
      const toggle = longBubble.querySelector('.user-bubble-toggle') as HTMLButtonElement
      expect(longBubble.classList.contains('collapsible')).toBe(true)
      expect(toggle.textContent).toContain('展开全部')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      toggle.click()
      await Promise.resolve()
      expect(longBubble.classList.contains('expanded')).toBe(true)
      expect(toggle.textContent).toContain('收起')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      toggle.click()
      await Promise.resolve()
      expect(longBubble.classList.contains('expanded')).toBe(false)
      expect(toggle.textContent).toContain('展开全部')
    } finally {
      dispose()
      host.remove()
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    }
  })

  test('折叠正文首次展开时才挂载', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          error: null,
          transcript: [
            {
              id: 'tool-lazy',
              kind: 'tool',
              text: '',
              toolName: 'run_command',
              action: { kind: 'run', objectLabel: '命令', target: 'echo ok' },
              args: { command: 'echo ok' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '命令执行完成',
                data: { stdout: '首次展开后才能看见的输出' },
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    const details = host.querySelector('details') as HTMLDetailsElement
    expect(details).toBeTruthy()
    expect(host.querySelector('.fold-body')).toBeNull()
    expect(host.textContent).not.toContain('首次展开后才能看见的输出')

    details.open = true
    details.dispatchEvent(new Event('toggle'))

    expect(host.querySelector('.fold-body')).toBeTruthy()
    expect(host.textContent).toContain('首次展开后才能看见的输出')

    dispose()
  })

  test('运行中的思考首次展开时滚动到内层最新内容', async () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList.contains('fold-pre') ? 240 : 0
      },
    })

    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={[{ id: 'thinking-live', kind: 'thinking', text: '正在形成最新结论' }]}
          live={() => true}
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const details = host.querySelector('details') as HTMLDetailsElement
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Promise.resolve()

      const pre = host.querySelector('.fold-pre') as HTMLPreElement
      expect(pre).toBeTruthy()
      expect(pre.scrollTop).toBe(240)
    } finally {
      dispose()
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    }
  })

  test('下一批工具逐条启动时，该段正文的节点保持不变', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [CV],
      lastRunId: 'run_now',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: Date.now(),
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [
            { id: 'u1', kind: 'user', text: '问一句' },
            { id: 't1', kind: 'text', text: '# 标题\n\n一段正文。\n\n另一段正文。' },
          ],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    const push = (id: string) =>
      store.applyEvent({
        seq: 1,
        at: 0,
        conversationId: CV,
        event: {
          type: 'tool.started',
          runId: 'run_now',
          stepId: id,
          toolName: 'read_file',
          action: { kind: 'read', objectLabel: '文件', target: 'a.ts' },
          args: {},
        },
      } as never)

    // 第一条使该段正文从流式转为定稿（末项不再是它），这次重渲染属于预期。
    push('s0')
    const prose = host.querySelector('.prose')
    const settled = prose?.firstElementChild
    expect(prose?.textContent).toContain('另一段正文')
    expect(settled).toBeTruthy()

    // 本轮继续执行，会话流逐条增长；该段正文没有任何变化。
    push('s1')
    push('s2')
    push('s3')

    expect(host.querySelector('.prose')).toBe(prose as never)
    expect(host.querySelector('.prose')?.firstElementChild).toBe(settled as never)

    dispose()
  })

  test('模型在 usage 前报错，收尾条仍显示命中 N/A', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_failed',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-failed', kind: 'user', text: '开始' },
            {
              id: 'run-run_failed',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_failed',
                stopReason: 'provider_error',
                usage: null,
                startedAt: 1_000,
                endedAt: 1_500,
                errorMessage: '模型连接失败',
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.textContent).toContain('命中 N/A')
    expect(host.textContent).toContain('模型连接失败')

    dispose()
  })

  test('正常完成不重复显示已完成', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_done',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-done', kind: 'user', text: '开始' },
            {
              id: 'run-run_done',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_done',
                stopReason: 'completed',
                usage: null,
                startedAt: 1_000,
                endedAt: 1_500,
                errorMessage: null,
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.querySelector('.run-reason')).toBeNull()

    dispose()
  })

  test('未知停止码不渲染成内部枚举', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_unknown_stop',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-unknown', kind: 'user', text: '开始' },
            {
              id: 'run-run_unknown_stop',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_unknown_stop',
                stopReason: 'future_internal_reason',
                usage: null,
                startedAt: 1_000,
                endedAt: 1_500,
                errorMessage: null,
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.querySelector('.run-reason')).toBeNull()
    expect(host.textContent).not.toContain('future_internal_reason')

    dispose()
  })

  test('历史加载、失败重试和更早页入口都有可见反馈', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: 'initial', nextCursor: null, error: null },
          changes: null,
          runUserMessageId: null,
          runStartedAt: null,
          usage: null,
          generatingToolCall: false,
          request: null,
          error: null,
          transcript: [],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.textContent).toContain('正在加载会话')
    store.setState('views', CV, 'history', {
      loading: null,
      nextCursor: null,
      error: { phase: 'initial', message: '网络断开' },
    })
    expect(host.textContent).toContain('历史记录加载失败：网络断开')
    expect(host.querySelector('.history-error button')?.textContent).toContain('重试')

    store.setState('views', CV, 'history', {
      loading: null,
      nextCursor: 'ms_old',
      error: null,
    })
    expect(host.querySelector('.history-button')?.textContent).toContain('加载更早记录')

    dispose()
  })
})

describe('检查点节点', () => {
  const wireNodes = [
    { id: 'a', kind: 'temp', name: 'A', task: '做 A' },
    { id: 'b', kind: 'temp', name: 'B', task: '做 B' },
    { id: 'cp', kind: 'checkpoint', label: '验收', needs: ['a', 'b'] },
  ]
  /** 按节点状态（`NodeState`）折叠出的卡片：回执是终态的那条节点状态，仍在运行的节点没有回执。 */
  const item = (
    states: Record<string, { phase: string; label: string; error?: string; durationMs?: number }>,
  ) => ({
    id: 'wf-cp',
    kind: 'tool',
    text: '',
    toolName: 'workflow',
    action: { kind: 'run', objectLabel: '工作流', target: '并行' },
    args: { goal: '并行', nodes: wireNodes },
    status: 'success',
    nodes: states,
    outcome: {
      status: 'success',
      executed: true,
      message: '已起跑',
      data: { workflowId: 'wf-cp', dispatched: Object.keys(states) },
    },
  })
  const mount = async (
    states: Record<string, { phase: string; label: string; error?: string; durationMs?: number }>,
  ) => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => <TranscriptRows items={[item(states)] as never} />,
      host as unknown as HTMLElement,
    )
    return { host, dispose }
  }

  /** 一个节点失败并先返回后，其余节点仍在运行，检查点在等待它们，而不是等待父会话审查。 */
  test('上游仍有节点在运行时不算待审查', async () => {
    const { host, dispose } = await mount({
      a: { phase: 'failed', label: 'A', error: '连不上' },
      b: { phase: 'working', label: 'B' },
    })
    try {
      expect(host.querySelector('.wf-node.session.working')).not.toBeNull()
      expect(host.querySelector('.wf-node.session.waiting_review')).toBeNull()
    } finally {
      dispose()
    }
  })

  test('上游全部到达终态后才待审查', async () => {
    const { host, dispose } = await mount({
      a: { phase: 'failed', label: 'A', error: '连不上' },
      b: { phase: 'done', label: 'B', durationMs: 5 },
    })
    try {
      expect(host.querySelector('.wf-node.session.waiting_review')).not.toBeNull()
    } finally {
      dispose()
    }
  })
})

/**
 * 行的 DOM 挂载在按 id 固定的外壳上，不挂载在每轮新建的投影包装上。锁定两种原始失败形状：
 * 运行中展开的组卡片在下一个工具启动时收起；workflow 卡每收到一个进度事件即整张重建，
 * 连线的 `<path>` 全部替换，虚线动画从头开始。
 */
describe('行的 DOM 不随投影重建', () => {
  const rect = (el: Element, left: number, top: number, width: number, height: number) => {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    })
  }

  test('组卡片展开时，下一个工具启动后仍是同一个 details 且保持展开', async () => {
    const { createSignal } = await import('solid-js')
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const tool = (id: string, status: string) => ({
      id,
      kind: 'tool',
      text: '',
      toolName: 'read_file',
      status,
      action: { kind: 'read', objectLabel: `${id}.ts` },
    })
    const a = tool('a', 'success')
    const b = tool('b', 'running')
    const [items, setItems] = createSignal([a, b])
    const host = document.createElement('div')
    const dispose = render(
      () => <TranscriptRows items={items() as never} />,
      host as unknown as HTMLElement,
    )
    try {
      const details = host.querySelector<HTMLDetailsElement>('details.fold')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Promise.resolve()
      expect(host.querySelectorAll('.fold-group > details.fold')).toHaveLength(2)

      setItems([a, b, tool('c', 'running')])

      expect(host.querySelector('details.fold')).toBe(details)
      expect(details.open).toBe(true)
      expect(host.querySelectorAll('.fold-group > details.fold')).toHaveLength(3)
    } finally {
      dispose()
    }
  })

  test('收到进度事件后，workflow 卡与连线的 path 仍是原有节点', async () => {
    const { createSignal } = await import('solid-js')
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    // 形状来自 args，一次派发任务中是同一个对象；进度事件整体替换 nodes。
    const args = {
      goal: '并行',
      nodes: [
        { id: 'a', kind: 'temp', name: 'glm', task: '做 A' },
        { id: 'b', kind: 'temp', name: 'qwen', task: '做 B' },
      ],
    }
    const wf = (nodes: Record<string, { phase: string; label: string }>) => ({
      id: 'wf-live',
      kind: 'tool',
      text: '',
      toolName: 'workflow',
      status: 'running',
      action: { kind: 'run', objectLabel: '工作流', target: '并行' },
      args,
      nodes,
    })
    const [items, setItems] = createSignal([wf({ a: { phase: 'working', label: 'glm' } })])
    const host = document.createElement('div')
    const dispose = render(
      () => <TranscriptRows items={items() as never} />,
      host as unknown as HTMLElement,
    )
    try {
      const card = host.querySelector('.wf-card')!
      const box = host.querySelector('.wf-graph')!
      const nodes = host.querySelectorAll('.wf-node')
      expect(nodes).toHaveLength(4)
      rect(box, 0, 0, 400, 230)
      rect(nodes[0]!, 150, 0, 100, 30)
      rect(nodes[1]!, 50, 100, 100, 40)
      rect(nodes[2]!, 250, 100, 100, 40)
      rect(nodes[3]!, 150, 200, 100, 30)
      resize(box)
      const paths = [...host.querySelectorAll('.wf-edges path')]
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.some((p) => p.classList.contains('live'))).toBe(true)

      setItems([wf({ a: { phase: 'working', label: 'glm · 第 2 轮' } })])
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(host.querySelector('.wf-card')).toBe(card)
      expect(host.querySelectorAll('.wf-node')[1]).toBe(nodes[1]!)
      expect(nodes[1]!.querySelector('.wf-node-name')?.textContent).toBe('glm · 第 2 轮')
      const after = [...host.querySelectorAll('.wf-edges path')]
      expect(after).toHaveLength(paths.length)
      expect(after.every((p, i) => p === paths[i])).toBe(true)
    } finally {
      dispose()
    }
  })
})

/**
 * 展开态归属于 step id，不归属于 `<details>` 节点。锁定的原始失败形状：单条工具处于展开状态时，
 * 下一个工具启动使它并入组卡片，组卡片以收起状态创建，该条随之收起，正在阅读的内容消失。
 */
describe('展开态归属于 step id', () => {
  const tool = (id: string) => ({
    id,
    kind: 'tool',
    text: '',
    toolName: 'read_file',
    status: 'success',
    action: { kind: 'read', objectLabel: `${id}.ts` },
    outcome: { status: 'success', executed: true, message: '', data: { content: `${id} 的内容` } },
  })
  const mount = async (first: ReturnType<typeof tool>) => {
    const { createSignal } = await import('solid-js')
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const [items, setItems] = createSignal([first])
    const host = document.createElement('div')
    const dispose = render(
      () => <TranscriptRows items={items() as never} />,
      host as unknown as HTMLElement,
    )
    return { host, dispose, setItems }
  }

  test('单条处于展开状态时，并入组卡片后组卡片以展开状态创建，该条仍展开', async () => {
    const a = tool('fold-open-a')
    const { host, dispose, setItems } = await mount(a)
    try {
      const single = host.querySelector<HTMLDetailsElement>('details.fold')!
      single.open = true
      single.dispatchEvent(new Event('toggle'))
      expect(host.textContent).toContain('fold-open-a 的内容')

      setItems([a, tool('fold-open-b')])

      const folds = host.querySelectorAll<HTMLDetailsElement>('details.fold')
      expect(folds).toHaveLength(3)
      expect(folds[0]!.open).toBe(true)
      expect(folds[1]!.open).toBe(true)
      expect(folds[2]!.open).toBe(false)
      expect(host.textContent).toContain('fold-open-a 的内容')
    } finally {
      dispose()
    }
  })

  test('单条处于收起状态时，并入组卡片后组卡片以收起状态创建', async () => {
    const a = tool('fold-shut-a')
    const { host, dispose, setItems } = await mount(a)
    try {
      setItems([a, tool('fold-shut-b')])
      // 组卡片收起时成员正文未挂载，只有组卡片自身的 details。
      const folds = host.querySelectorAll<HTMLDetailsElement>('details.fold')
      expect(folds).toHaveLength(1)
      expect(folds[0]!.open).toBe(false)
      expect(host.textContent).not.toContain('fold-shut-a 的内容')
    } finally {
      dispose()
    }
  })
})

/** 收尾读数条与「运行」面板使用同一计算方式（`runCosts`）：模型调用费用加生成费用，不同币种并列显示。 */
test('收尾读数条的金额包含本轮的生成费用', async () => {
  const { render } = await import('solid-js/web')
  const { TranscriptRows } = await import('./Transcript.tsx')
  const items = [
    {
      id: 'run_rn_media',
      kind: 'run',
      text: '',
      run: {
        runId: 'rn_media',
        stopReason: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          cost: 0.01,
          currency: 'USD',
          turns: [],
          media: [
            {
              kind: 'dashscope_images',
              provider: 'qwen',
              model: 'qwen-image-3.0',
              output: 'image',
              quantity: 1,
              cost: 0.18,
              currency: 'CNY',
              at: 1,
            },
          ],
        },
        startedAt: 1,
        endedAt: 2,
        errorMessage: null,
      },
    },
  ]
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => <TranscriptRows items={items as never} />,
    host as unknown as HTMLElement,
  )
  try {
    expect(host.querySelector('.run-cost')?.textContent).toBe('¥0.18 + $0.01')
  } finally {
    dispose()
    host.remove()
  }
})
