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
  store.setState({
    activeConversation: null,
    busyConversations: [],
    views: {},
    todos: [],
    fileChanges: [],
    lastRunId: null,
  })
}

const CV = 'cv_chip'

async function mount() {
  const { render } = await import('solid-js/web')
  const { RunStatus } = await import('./RunStatus.tsx')
  const host = document.createElement('div')
  const dispose = render(() => <RunStatus />, host as unknown as HTMLElement)
  return { host, dispose }
}

/** 一轮跑完之后的静止态：待办还剩两条没做，上一轮改过一个文件。 */
async function afterPreviousRun() {
  const store = await import('../lib/store/index.ts')
  store.setState({
    activeConversation: CV,
    views: {
      [CV]: {
        transcript: [],
        history: { loading: null, nextCursor: null, error: null },
        runStartedAt: null,
        usage: null,
        lastEventAt: null,
        retry: null,
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
