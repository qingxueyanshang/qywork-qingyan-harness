/**
 * 账号界面：`AccountEntry.tsx`（侧栏入口）、`AccountDialog.tsx`（账号弹窗）、`LoginForm.tsx`（登录表单）、
 * `ActivityGrid.tsx`（Token 活动方格）、`../LoginGate.tsx`（首次启动的登录页），以及 `lib/store/cloud.ts`。
 * 服务端接口以替身代替，状态以替身返回值为准。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CloudRequest, CloudState, CloudUsage } from '@qywork/core'
import type { JSX } from 'solid-js'

let store: typeof import('../../lib/store/index.ts')
let cloudStore: typeof import('../../lib/store/cloud.ts')
let originalApi: typeof store.client.api
let ApiError: typeof import('../../lib/client.ts').ApiError
let cloud: CloudState
let providers: unknown[]
let calls: string[]
let pages: CloudRequest[][]

const SIGNED_IN: CloudState = {
  state: 'signed_in',
  email: 'me@example.com',
  credits: 12.5,
  provider: 'qywork',
}

const USAGE: CloudUsage = {
  requests: 3,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 2000,
  cacheWriteTokens: 0,
  credits: 1.5,
  days: [],
}

function record(id: string, failure: string | null = null): CloudRequest {
  return {
    id,
    modelId: 'claude-sonnet-5-5',
    failure,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0.25,
    startedAt: new Date(Date.UTC(2026, 10, 1) + Number(id) * 60_000).toISOString(),
  }
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click', 'input', 'submit'])
  store = await import('../../lib/store/index.ts')
  cloudStore = await import('../../lib/store/cloud.ts')
  ApiError = (await import('../../lib/client.ts')).ApiError
  originalApi = store.client.api
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/models') {
      return { providers, media: [], mediaLibrary: [], library: [] } as T
    }
    if (path === '/api/cloud/state') return structuredClone(cloud) as T
    if (path === '/api/cloud/login') {
      const body = JSON.parse(String(init?.body)) as { password: string }
      if (body.password !== 'password-123') {
        throw new ApiError(400, path, JSON.stringify({ error: 'cloud', message: '邮箱或密码错误' }))
      }
      cloud = SIGNED_IN
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/logout') {
      cloud = { state: 'signed_out' }
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/usage') return structuredClone(USAGE) as T
    if (path.startsWith('/api/cloud/requests')) return (pages.shift() ?? []) as T
    throw new Error(`unexpected ${path}`)
  }
})

beforeEach(async () => {
  cloud = { state: 'signed_out' }
  providers = []
  calls = []
  pages = []
  store.setAccountOpen(false)
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount(view: () => JSX.Element) {
  const { render } = await import('solid-js/web')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(view, host)
  return {
    host,
    text: () => host.textContent ?? '',
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label),
    fill: (type: string, value: string) => {
      const input = host.querySelector(`input[type="${type}"]`) as HTMLInputElement
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    close: () => {
      dispose()
      host.remove()
    },
  }
}

async function entry() {
  const { AccountEntry } = await import('./AccountEntry.tsx')
  return mount(() => (
    <ul>
      <AccountEntry />
    </ul>
  ))
}

async function dialog() {
  const { default: AccountDialog } = await import('./AccountDialog.tsx')
  return mount(() => <AccountDialog />)
}

test('侧栏入口：未配置云端服务时不出现；未登录显示「登录」，已登录显示邮箱；点击打开账号弹窗', async () => {
  cloud = { state: 'unavailable' }
  await cloudStore.refreshCloudState()
  const hidden = await entry()
  expect(hidden.host.querySelector('.account-entry')).toBeNull()
  hidden.close()

  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  const out = await entry()
  expect(out.text()).toBe('登录')
  out.close()

  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const view = await entry()
  expect(view.text()).toContain('me@example.com')
  ;(view.host.querySelector('.account-entry') as HTMLButtonElement).click()
  expect(store.accountOpen()).toBe(true)
  view.close()
})

test('登录表单：密码错误时显示原因；登录成功后弹窗显示账号、统计与使用记录', async () => {
  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  pages = [[record('2'), record('1', '429 请求过多')]]
  const view = await dialog()
  await until(() => view.host.querySelector('.account-form') !== null)

  view.fill('email', 'me@example.com')
  view.fill('password', 'wrong-password')
  ;(view.host.querySelector('form') as HTMLFormElement).requestSubmit()
  await until(() => view.text().includes('邮箱或密码错误'))

  view.fill('password', 'password-123')
  ;(view.host.querySelector('form') as HTMLFormElement).requestSubmit()
  await until(() => view.text().includes('使用记录') && view.text().includes('429 请求过多'))
  expect(view.text()).toContain('me@example.com')
  expect(view.text()).toContain('12.50')
  expect(view.text()).toContain('1.50')
  // 累计 Token 为四项之和；「输入」含缓存命中。
  expect(view.text()).toContain('3.5K')
  expect(view.text()).toContain('完成')
  // 不足一页：没有更早的记录。
  expect(view.button('加载更早的记录')).toBeUndefined()
  view.close()
})

test('使用记录满一页时可继续加载，续页位置为上一页最后一条的时间', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  pages = [Array.from({ length: 50 }, (_, i) => record(String(99 - i))), [record('1')]]
  const view = await dialog()
  await until(() => view.button('加载更早的记录') !== undefined)
  view.button('加载更早的记录')?.click()
  await until(() => view.host.querySelectorAll('tbody tr').length === 51)
  const last = calls.filter((c) => c.startsWith('GET /api/cloud/requests')).at(-1)
  expect(last).toContain(`before=${encodeURIComponent(record('50').startedAt)}`)
  expect(view.button('加载更早的记录')).toBeUndefined()
  view.close()
})

test('退出登录后弹窗显示登录表单', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const view = await dialog()
  await until(() => view.button('退出登录') !== undefined)
  view.button('退出登录')?.click()
  await until(() => view.host.querySelector('.account-form') !== null)
  expect(calls).toContain('POST /api/cloud/logout')
  view.close()
})

test('首次启动且没有任何接口时显示登录页；已有接口时不显示', async () => {
  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  const { LoginGate } = await import('../LoginGate.tsx')
  const first = await mount(() => <LoginGate />)
  await until(() => first.host.querySelector('.login-gate .account-form') !== null)
  expect(first.text()).toContain('使用自己的 API key')
  first.close()

  providers = [{ name: 'mine', kind: 'openai_chat_completions', models: [] }]
  await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  const later = await mount(() => <LoginGate />)
  await new Promise((r) => setTimeout(r, 20))
  expect(later.host.querySelector('.login-gate')).toBeNull()
  later.close()
})

test('Token 活动：53 列 × 7 行，今天之后不绘制，按有请求日子中的名次分档，月初所在列带月份', async () => {
  const { activityCells } = await import('./ActivityGrid.tsx')
  const today = new Date(2026, 10, 4, 15) // 2026-11-04，周三
  const { cells, months } = activityCells(
    [
      { day: '2026-11-01', requests: 1, tokens: 10, credits: 0 },
      { day: '2026-11-02', requests: 1, tokens: 20, credits: 0 },
      { day: '2026-11-03', requests: 1, tokens: 30, credits: 0 },
      { day: '2026-11-04', requests: 1, tokens: 40, credits: 0 },
    ],
    today,
  )
  expect(cells).toHaveLength(53 * 7)
  const last = cells.slice(-7)
  expect(last.map((c) => c.day)).toEqual([
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ])
  expect(last.map((c) => c.future)).toEqual([false, false, false, true, true, true, true])
  const level = (day: string) => cells.find((c) => c.day === day)?.level
  expect([
    level('2026-11-01'),
    level('2026-11-02'),
    level('2026-11-03'),
    level('2026-11-04'),
  ]).toEqual([1, 2, 3, 4])
  expect(level('2026-10-31')).toBe(0)
  // 只有一天有请求时为最深一档。
  const single = activityCells([{ day: '2026-11-04', requests: 1, tokens: 5, credits: 0 }], today)
  expect(single.cells.find((c) => c.day === '2026-11-04')?.level).toBe(4)
  // 11 月 1 日是周日，位于倒数第二列。
  expect(months.at(-2)).toBe('11月')
  expect(months).toHaveLength(53)
})
