/**
 * 覆盖 `SchedulesPanel.tsx`。
 *
 * 面板读的 API 与仓储另有测试（`packages/server/src/scheduler.test.ts`），这里只验面板自己：
 * 上次触发的三种结果各印哪一行、什么变化会让它重取、启停开关发出去的是什么。
 *
 * **DOM 在这里装，用完卸掉**，理由同 `LoadState.test.tsx`：happy-dom 的全局带着它自己那份
 * `fetch`，装成全局会让服务端那些包的测试全红。
 *
 * **桩打在 `client.api` 上，不打在 `settings.ts` 的导出上**：面板经 `loadSchedules` /
 * `updateSchedule` 走到那一个出口，桩在出口才连带验到请求方法与请求体。`ws=` 由 `api()`
 * 内部拼，桩收到的是拼之前的路径。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ScheduleView } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

beforeEach(async () => {
  const store = await import('../lib/store/index.ts')
  store.setState({ connection: 'ready', busyConversations: [] })
})

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  restoreApi?.()
  restoreApi = undefined
  const store = await import('../lib/store/index.ts')
  store.setWorkspace(null)
  store.setState({ busyConversations: [] })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

interface Call {
  path: string
  method: string
  body: string | null
}

/** 记下每一条请求，并按调用方给的应答回。 */
async function stub(reply: (path: string, init?: RequestInit) => unknown): Promise<Call[]> {
  const store = await import('../lib/store/index.ts')
  const original = store.client.api
  const calls: Call[] = []
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return reply(path, init)
  }
  restoreApi = () => {
    ;(store.client as unknown as { api: typeof original }).api = original
  }
  return calls
}

function schedule(over: Partial<ScheduleView>): ScheduleView {
  return {
    id: 'sc_1',
    workspaceRoot: 'C:\\work',
    title: '每日汇报',
    prompt: '汇报一遍今天的改动。',
    kind: 'interval',
    everyMinutes: 60,
    enabled: true,
    createdAt: 1,
    nextRunAt: null,
    due: false,
    lastRun: null,
    ...over,
  }
}

async function mount() {
  const { render } = await import('solid-js/web')
  const { SchedulesPanel } = await import('./SchedulesPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <SchedulesPanel />, host as unknown as HTMLElement)
  return host
}

describe('上次触发的结果', () => {
  test('没有执行记录 / 失败带正文 / 被中断 各印一行，跑完的那条一个字不印', async () => {
    await stub(() => ({
      runtimeOnly: '仅在应用运行时触发',
      schedules: [
        schedule({
          id: 'sc_none',
          title: '有触发时刻没有执行记录',
          lastRunAt: 1_700_000_000_000,
          lastRun: { conversationId: 'cv_a', runId: null, status: null, errorMessage: null },
        }),
        schedule({
          id: 'sc_failed',
          title: '上次失败',
          lastRunAt: 1_700_000_000_000,
          lastRun: {
            conversationId: 'cv_b',
            runId: 'rn_b',
            status: 'failed',
            errorMessage: 'Incorrect API key provided',
          },
        }),
        schedule({
          id: 'sc_interrupted',
          title: '上次被中断',
          lastRunAt: 1_700_000_000_000,
          lastRun: {
            conversationId: 'cv_c',
            runId: 'rn_c',
            status: 'interrupted',
            errorMessage: null,
          },
        }),
        schedule({
          id: 'sc_done',
          title: '跑完了',
          lastRunAt: 1_700_000_000_000,
          lastRun: { conversationId: 'cv_d', runId: 'rn_d', status: 'done', errorMessage: null },
        }),
      ],
    }))

    const host = await mount()
    await waitFor(
      () => host.querySelectorAll('.schedule-card').length === 4,
      () => `卡片 ${host.querySelectorAll('.schedule-card').length} 张`,
    )
    const cards = [...host.querySelectorAll('.schedule-card')]
    const badOf = (i: number) => cards[i]?.querySelector('.field-hint.bad')?.textContent ?? null

    expect(badOf(0)).toBe('没有执行记录')
    expect(badOf(1)).toBe('上次失败：Incorrect API key provided')
    expect(badOf(2)).toBe('上次被中断')
    // 跑完的那条没有话说，那一行整个不出现——空着不写「成功」。
    expect(badOf(3)).toBeNull()
  })

  test('失败但没有报错正文时说出来，不留一句半截的话', async () => {
    await stub(() => ({
      runtimeOnly: '仅在应用运行时触发',
      schedules: [
        schedule({
          lastRunAt: 1_700_000_000_000,
          lastRun: {
            conversationId: 'cv_e',
            runId: 'rn_e',
            status: 'failed',
            errorMessage: null,
          },
        }),
      ],
    }))
    const host = await mount()
    await waitFor(
      () => host.querySelector('.field-hint.bad') !== null,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.field-hint.bad')?.textContent).toBe('上次失败：没有报错正文')
  })
})

describe('什么变化会让它重取', () => {
  test('换项目重取，列出的是新项目那一份', async () => {
    const store = await import('../lib/store/index.ts')
    const calls = await stub(() => ({
      runtimeOnly: '仅在应用运行时触发',
      schedules: [
        schedule({
          id: `sc_${store.workspace()?.id ?? 'none'}`,
          title: store.workspace()?.id ?? '',
        }),
      ],
    }))

    store.setWorkspace({ id: 'ws_a', root: 'C:\\a', name: 'a' })
    const host = await mount()
    await waitFor(
      () => host.querySelector('.schedule-title')?.textContent === 'ws_a',
      () => host.textContent ?? '',
    )
    expect(calls.filter((c) => c.path === '/api/schedules').length).toBe(1)

    store.setWorkspace({ id: 'ws_b', root: 'C:\\b', name: 'b' })
    await waitFor(
      () => host.querySelector('.schedule-title')?.textContent === 'ws_b',
      () => host.textContent ?? '',
    )
    expect(calls.filter((c) => c.path === '/api/schedules').length).toBe(2)
  })

  test('在跑的会话集合变了就重取：后台触发不经过这个面板', async () => {
    const store = await import('../lib/store/index.ts')
    let turn = 0
    const calls = await stub(() => {
      turn += 1
      return {
        runtimeOnly: '仅在应用运行时触发',
        schedules: [schedule({ title: `第 ${turn} 次` })],
      }
    })

    store.setWorkspace({ id: 'ws_busy', root: 'C:\\busy', name: 'busy' })
    const host = await mount()
    await waitFor(
      () => host.querySelector('.schedule-title')?.textContent === '第 1 次',
      () => host.textContent ?? '',
    )

    // 一次触发建的会话进了 busy 集合，跑完又出来——两次变化各重取一次。
    store.setState({ busyConversations: ['cv_sched'] })
    await waitFor(
      () => host.querySelector('.schedule-title')?.textContent === '第 2 次',
      () => host.textContent ?? '',
    )
    store.setState({ busyConversations: [] })
    await waitFor(
      () => host.querySelector('.schedule-title')?.textContent === '第 3 次',
      () => host.textContent ?? '',
    )
    expect(calls.filter((c) => c.path === '/api/schedules').length).toBe(3)
  })
})

describe('启停开关', () => {
  test('只发 enabled 一个字段，回来之后重取一次', async () => {
    const store = await import('../lib/store/index.ts')
    let enabled = true
    const calls = await stub((_path, init) => {
      if (init?.method === 'PUT') {
        enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled
        return { schedule: schedule({ enabled }) }
      }
      return {
        runtimeOnly: '仅在应用运行时触发',
        schedules: [schedule({ enabled })],
      }
    })

    store.setWorkspace({ id: 'ws_toggle', root: 'C:\\t', name: 't' })
    const host = await mount()
    await waitFor(
      () => host.querySelector('.schedule-actions button')?.textContent === '停用',
      () => host.textContent ?? '',
    )

    host.querySelector<HTMLButtonElement>('.schedule-actions button')?.click()
    await waitFor(
      () => host.querySelector('.schedule-actions button')?.textContent === '启用',
      () => host.textContent ?? '',
    )

    const put = calls.filter((c) => c.method === 'PUT')
    expect(put.length).toBe(1)
    expect(put[0]?.path).toBe('/api/schedules/sc_1')
    // 时间字段一个都不带：服务端按现值兜底，带上等于让面板复述一份它没有权威的配置。
    expect(JSON.parse(String(put[0]?.body))).toEqual({ enabled: false })
    expect(calls.filter((c) => c.path === '/api/schedules').length).toBe(2)
    expect(host.querySelector('.schedule-card')?.classList.contains('off')).toBe(true)
  })

  test('写失败时把原文摆出来，卡片仍在', async () => {
    const store = await import('../lib/store/index.ts')
    await stub((_path, init) => {
      if (init?.method === 'PUT') throw new Error('间隔必须是不小于 1 的分钟数')
      return { runtimeOnly: '仅在应用运行时触发', schedules: [schedule({})] }
    })

    store.setWorkspace({ id: 'ws_bad', root: 'C:\\b', name: 'b' })
    const host = await mount()
    await waitFor(
      () => host.querySelector('.schedule-actions button') !== null,
      () => host.textContent ?? '',
    )
    host.querySelector<HTMLButtonElement>('.schedule-actions button')?.click()
    await waitFor(
      () => host.querySelector('.settings-notices.bad') !== null,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.settings-notices.bad')?.textContent).toBe(
      '间隔必须是不小于 1 的分钟数',
    )
    expect(host.querySelectorAll('.schedule-card').length).toBe(1)
  })
})
