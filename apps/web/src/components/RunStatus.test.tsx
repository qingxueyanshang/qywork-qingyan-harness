/**
 * 覆盖 `RunStatus.tsx`：整轮状态条什么时候挂、什么时候撤。
 *
 * 锁的是一条真实失败形状——上一轮改过文件，用户按下回车，忙闲被乐观置上而这一轮的
 * 文件读数要等服务端的 `run.started` 才清空。那一段窗口里 chip 会带着上一轮的读数
 * 出现再自己缩掉。
 *
 * DOM 在这里装、用完卸掉，动态 import 的理由同 `settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DesktopTargetEvent, EventEnvelope } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await resetStore()
  await GlobalRegistrator.unregister()
})
/**
 * store 是模块级单例，`bun test` 一个进程跑全部文件——**这里改过的字段要还回去**，
 * 否则别的文件里「这一格应该是空的」那类断言会按文件顺序随机变红。
 */
async function resetStore() {
  const store = await import('../lib/store/index.ts')
  if (sendBefore) {
    ;(store.client as unknown as { send: typeof sendBefore }).send = sendBefore
    sendBefore = null
  }
  store.setState({
    activeConversation: null,
    busyConversations: [],
    views: {},
    todos: [],
    fileChanges: [],
    lastRunId: null,
    desktopTarget: null,
  })
}

/** 换掉的那个 `client.send`，收尾时还回去。见 `afterPreviousRun`。 */
let sendBefore: ((cmd: never) => void) | null = null

const CV = 'cv_chip'
const OTHER = 'cv_wechat'
const targetFrame = (target: DesktopTargetEvent['target']): EventEnvelope<DesktopTargetEvent> => ({
  seq: 3,
  at: 0,
  event: { type: 'desktop.target', target },
})

async function mount() {
  const { render } = await import('solid-js/web')
  const { RunStatus } = await import('./RunStatus.tsx')
  const host = document.createElement('div')
  const dispose = render(() => <RunStatus />, host as unknown as HTMLElement)
  return { host, dispose }
}

/**
 * 一轮跑完之后的静止态：待办还剩两条没做，上一轮改过一个文件。
 *
 * 一并把 `client.send` 换成空实现：这个文件看的是按下回车之后界面怎么画，
 * 而这里没有连接——不换的话 `sendMessage` 当场收到一条 `not_ready` 回执，
 * 乐观置上的那一格被冲销回闲态（`store/connection.ts` 的 `applyRejected`）。
 */
async function afterPreviousRun() {
  const store = await import('../lib/store/index.ts')
  sendBefore ??= store.client.send.bind(store.client)
  ;(store.client as unknown as { send: (cmd: unknown) => void }).send = () => {}
  store.setState({
    activeConversation: CV,
    views: {
      [CV]: {
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
    busyConversations: [],
    lastRunId: 'run_prev',
    todos: [
      { id: 't1', content: '一', status: 'completed' },
      { id: 't2', content: '二', status: 'pending' },
    ],
    fileChanges: [{ path: 'a.ts', additions: 30, deletions: 5, changeType: 'modified' }],
  })
  return store
}

const startedFrame = (runId: string) =>
  ({
    seq: 1,
    at: 0,
    conversationId: CV,
    event: {
      type: 'run.started',
      runId,
      conversationId: CV,
      model: 'm',
      userMessageId: null,
      retryOfRunId: null,
    },
  }) as never

const finishedFrame = (runId: string) =>
  ({
    seq: 2,
    at: 0,
    conversationId: CV,
    event: {
      type: 'run.finished',
      runId,
      status: 'done',
      stopReason: 'completed',
      usage: null,
      stepCount: 1,
      durationMs: 10,
      fileChanges: [],
    },
  }) as never

describe('整轮状态条跟着这一轮走，不跟着忙闲走', () => {
  test('后台会话操作 QQ 时，当前会话的运行条不显示它的目标', async () => {
    const store = await afterPreviousRun()
    store.sendMessage('接着干')
    store.applyEvent(startedFrame('run_now'))
    const { host, dispose } = await mount()
    try {
      store.applyEvent(targetFrame({ app: 'QQ.exe', foreground: false, conversationId: OTHER }))
      expect(host.textContent).toContain('已完成 1 / 2')
      expect(host.textContent).not.toContain('QQ.exe')
      store.setState('todos', [])
      expect(host.textContent).toBe('')
    } finally {
      dispose()
      await resetStore()
    }
  })

  test('切到操作所属会话立即显示，切走不串台，后台释放后切回不残留', async () => {
    const store = await afterPreviousRun()
    store.applyEvent(startedFrame('run_now'))
    store.setState('busyConversations', [CV, OTHER])
    store.setState('todos', [])
    store.applyEvent(targetFrame({ conversationId: OTHER, app: 'QQ.exe', foreground: true }))
    const selectRunning = (id: string) => {
      store.setState('activeConversation', id)
      // 切会话会重建 view；这里补入历史加载返回的运行时刻。
      store.setState('views', id, 'runStartedAt', 1)
    }
    const { host, dispose } = await mount()
    try {
      expect(host.textContent).toBe('')
      selectRunning(OTHER)
      expect(host.textContent).toBe('正在前台操作 QQ.exe')
      selectRunning(CV)
      expect(host.textContent).toBe('')
      store.applyEvent(targetFrame(null))
      selectRunning(OTHER)
      expect(host.textContent).toBe('')

      // 同一应用换了执行会话，归属也必须一起更新。
      store.applyEvent(targetFrame({ conversationId: CV, app: 'QQ.exe', foreground: false }))
      expect(host.textContent).toBe('')
      selectRunning(CV)
      expect(host.textContent).toBe('正在操作 QQ.exe')
      store.applyEvent(targetFrame(null))
      expect(host.textContent).toBe('')
    } finally {
      dispose()
      await resetStore()
    }
  })

  test('按下回车到 run.started 之间不出现——上一轮的文件读数不许挂在这一轮名下', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    expect(host.textContent).toBe('')

    // 乐观置忙就是 `sendMessage` 按下回车那一刻做的事。
    store.sendMessage('接着干')
    expect(store.isRunning()).toBe(true)
    expect(host.textContent).toBe('')

    dispose()
  })

  test('run.started 到了才挂，挂出来的文件读数是这一轮的（空）', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    store.sendMessage('接着干')
    store.applyEvent(startedFrame('run_now'))

    expect(host.textContent).toContain('已完成 1 / 2')
    expect(host.textContent).not.toContain('个文件')

    dispose()
  })

  test('同一文件先由文件工具写、再由观察器判出一次无行数写入，读数只加已知的', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    store.sendMessage('接着干')
    store.applyEvent(startedFrame('run_now'))
    const changed = (changes: unknown[]) =>
      ({
        seq: 3,
        at: 0,
        conversationId: CV,
        event: { type: 'file.changed', changes, runId: 'run_now' },
      }) as never
    store.applyEvent(
      changed([{ path: 'p.html', changeType: 'created', additions: 442, deletions: 49 }]),
    )
    store.applyEvent(changed([{ path: 'p.html', changeType: 'modified' }]))

    expect(host.textContent).toContain('1 个文件+442-49')

    dispose()
  })

  test('收尾条一落下就撤，不等 conversation.busy 那一帧', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    store.sendMessage('接着干')
    store.applyEvent(startedFrame('run_now'))
    expect(host.textContent).not.toBe('')

    store.applyEvent(finishedFrame('run_now'))
    // 忙闲还挂着（服务端的 conversation.busy 排在下一帧）。
    expect(store.isRunning()).toBe(true)
    expect(host.textContent).toBe('')

    dispose()
  })
})
