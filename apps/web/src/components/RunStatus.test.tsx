/**
 * 覆盖 `RunStatus.tsx`：整轮状态条的显示与隐藏时机。
 *
 * 锁定的失败形状：
 *
 * - 上一轮修改过文件，用户按下回车后 chip 带着上一轮的读数出现，随后缩小。
 * - chip 等到 `run.started` 才出现：服务端发出它之前有数秒准备步骤，chip 在发送数秒后弹出，推动下方布局。
 *
 * DOM 在本文件内注册、用后注销，使用动态 import 的理由同 `settings/LoadState.test.tsx`。
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
 * store 是模块级单例，`bun test` 在一个进程中运行全部文件：**本文件修改过的字段必须恢复原值**，
 * 否则其他文件中断言字段为空的测试会随文件顺序随机失败。
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
    desktopTargets: [],
  })
}

/** 被替换前的 `client.send`，收尾时恢复。见 `afterPreviousRun`。 */
let sendBefore: ((cmd: never) => void) | null = null

const CV = 'cv_chip'
const OTHER = 'cv_wechat'
const targetFrame = (
  target: DesktopTargetEvent['targets'][number] | null,
): EventEnvelope<DesktopTargetEvent> => ({
  seq: 3,
  at: 0,
  event: { type: 'desktop.target', targets: target ? [target] : [] },
})

async function mount() {
  const { render } = await import('solid-js/web')
  const { RunStatus } = await import('./RunStatus.tsx')
  const host = document.createElement('div')
  const dispose = render(() => <RunStatus />, host as unknown as HTMLElement)
  return { host, dispose }
}

/**
 * 一轮执行完毕后的静止状态：待办剩两条未完成，上一轮修改过一个文件。
 *
 * 同时把 `client.send` 替换为空实现：本文件验证按下回车后的界面渲染，
 * 而测试环境没有连接；不替换时 `sendMessage` 会立即收到 `not_ready` 回执，
 * 乐观设置的忙碌状态被撤销为空闲（`store/connection.ts` 的 `applyRejected`）。
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
        runId: null,
        liveSeq: 0,
        runSeq: 0,
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
      startedAt: 0,
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

describe('整轮状态条随轮次显示，不随忙碌状态显示', () => {
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

  test('切换到操作所属会话时立即显示，切换离开后不显示其他会话的目标，后台释放后切回不残留', async () => {
    const store = await afterPreviousRun()
    store.applyEvent(startedFrame('run_now'))
    store.setState('busyConversations', [CV, OTHER])
    store.setState('todos', [])
    store.applyEvent(targetFrame({ conversationId: OTHER, app: 'QQ.exe', foreground: true }))
    const selectRunning = (id: string) => {
      store.setState('activeConversation', id)
      // 切换会话会重建 view；此处补入历史加载返回的运行开始时间。
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

      // 同一应用的执行会话改变时，归属必须同步更新。
      store.applyEvent(targetFrame({ conversationId: CV, app: 'QQ.exe', foreground: false }))
      expect(host.textContent).toBe('')
      selectRunning(CV)
      expect(host.textContent).toBe('正在后台操作 QQ.exe')
      store.applyEvent(targetFrame(null))
      expect(host.textContent).toBe('')
    } finally {
      dispose()
      await resetStore()
    }
  })

  test('按下回车即显示，上一轮的文件读数不计入本轮，run.started 到达时内容不变', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    expect(host.textContent).toBe('')

    store.sendMessage('接着干')
    expect(store.isRunning()).toBe(true)
    const chip = host.querySelector('.run-status')
    expect(host.textContent).toContain('已完成 1 / 2')
    expect(host.textContent).not.toContain('个文件')

    const before = host.textContent
    store.applyEvent(startedFrame('run_now'))
    expect(host.querySelector('.run-status')).toBe(chip)
    expect(host.textContent).toBe(before)

    dispose()
  })

  test('发送被拒绝时 chip 随忙碌状态一并撤销', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    // 恢复真实的 `client.send`：测试环境没有连接，指令立即以 `not_ready` 被拒绝。
    ;(store.client as unknown as { send: typeof sendBefore }).send = sendBefore
    store.sendMessage('接着干')

    expect(store.isRunning()).toBe(false)
    expect(store.viewOf(CV).runStartedAt).toBe(null)
    expect(host.textContent).toBe('')

    dispose()
  })

  test('同一文件先由文件工具写入、再由观察器判定一次无行数写入，读数只累加已知行数', async () => {
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

  test('run.finished 到达后立即隐藏，不等待 conversation.busy 帧', async () => {
    const store = await afterPreviousRun()
    const { host, dispose } = await mount()
    store.sendMessage('接着干')
    store.applyEvent(startedFrame('run_now'))
    expect(host.textContent).not.toBe('')

    store.applyEvent(finishedFrame('run_now'))
    // 忙碌状态仍未清除（服务端的 conversation.busy 在下一帧发送）。
    expect(store.isRunning()).toBe(true)
    expect(host.textContent).toBe('')

    dispose()
  })
})
