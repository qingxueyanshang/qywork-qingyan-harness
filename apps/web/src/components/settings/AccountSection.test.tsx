/**
 * 云端账号的界面：`AccountSection.tsx`（「通用」页账号区块）与 `LoginGate.tsx`（首次启动的登录页），
 * 以及 `lib/store/cloud.ts`。服务端接口以替身代替，状态以替身返回值为准。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CloudState } from '../../lib/store/cloud.ts'

let store: typeof import('../../lib/store/index.ts')
let originalApi: typeof store.client.api
let cloud: CloudState
let providers: unknown[]
let calls: string[]

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
  store = await import('../../lib/store/index.ts')
  originalApi = store.client.api
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/models') {
      return { providers, media: [], mediaLibrary: [], library: [] } as T
    }
    if (path === '/api/cloud/state') return structuredClone(cloud) as T
    if (path === '/api/cloud/login') {
      cloud = {
        state: 'pending',
        userCode: 'ABCD1234',
        verificationUri: 'http://app.test/device?user_code=ABCD1234',
        expiresAt: Date.now() + 600_000,
      }
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/logout') {
      cloud = { state: 'signed_out' }
      return structuredClone(cloud) as T
    }
    throw new Error(`unexpected ${path}`)
  }
})

beforeEach(() => {
  cloud = { state: 'signed_out' }
  providers = []
  calls = []
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

async function mount(which: 'section' | 'gate') {
  const { render } = await import('solid-js/web')
  const { AccountSection } = await import('./AccountSection.tsx')
  const { LoginGate } = await import('../LoginGate.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => (which === 'section' ? <AccountSection /> : <LoginGate />), host)
  return {
    host,
    text: () => host.textContent ?? '',
    click: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click(),
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('未配置云端服务时账号区块不出现', async () => {
  cloud = { state: 'unavailable' }
  const view = await mount('section')
  await until(() => calls.includes('GET /api/cloud/state'))
  await new Promise((r) => setTimeout(r, 20))
  expect(view.host.querySelector('.settings-block')).toBeNull()
  view.close()
})

test('设备被移除后显示原因与登录按钮；点击登录后显示登录码', async () => {
  cloud = { state: 'signed_out', reason: 'revoked' }
  const view = await mount('section')
  await until(() => view.text().includes('设备已被移除'))
  view.click('登录')
  await until(() => view.text().includes('ABCD1234'))
  expect(calls).toContain('POST /api/cloud/login')
  view.close()
})

test('已登录时显示邮箱与积分余额；退出后回到登录按钮', async () => {
  cloud = { state: 'signed_in', email: 'me@example.com', credits: 12.5 }
  const view = await mount('section')
  await until(() => view.text().includes('me@example.com'))
  expect(view.text()).toContain('12.50 积分')
  view.click('退出')
  await until(() => view.text().includes('登录'))
  expect(calls).toContain('POST /api/cloud/logout')
  view.close()
})

test('首次启动且没有任何接口时显示登录页；已有接口时不显示', async () => {
  const first = await mount('gate')
  await until(() => first.host.querySelector('.login-gate') !== null)
  expect(first.text()).toContain('使用自己的 API key')
  first.close()

  providers = [{ name: 'mine', kind: 'openai_chat_completions', models: [] }]
  await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  const later = await mount('gate')
  await new Promise((r) => setTimeout(r, 50))
  expect(later.host.querySelector('.login-gate')).toBeNull()
  later.close()
})
