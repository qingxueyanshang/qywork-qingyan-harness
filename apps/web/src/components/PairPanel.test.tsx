/**
 * 覆盖 `PairPanel.tsx`：未登录时整节不出现；开关切换期间不得触发外层 Suspense；开关失败时显示原因并恢复为实际状态；
 * 隧道各状态的显示。
 *
 * 设置内容区只有一层 Suspense，它挂起时整页内容被移出 DOM，滚动位置随之归零。
 * 判据是外层 fallback 的求值次数：Solid 只在边界挂起时才读取 `fallback`。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `LoadState.test.tsx`。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { RemoteInfo } from './PairPanel.tsx'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  restoreApi?.()
  restoreApi = undefined
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

const DEVICE_URL = 'https://app.example.com/devices/dv_1'

async function mount(initial: RemoteInfo, opts: { failToggle?: string } = {}) {
  const store = await import('../lib/store/index.ts')
  const original = store.client.api
  let info = initial
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    if (path === '/api/pairing/remote') {
      if (opts.failToggle) {
        const { ApiError } = await import('../lib/client.ts')
        throw new ApiError(422, path, opts.failToggle)
      }
      const { enabled } = JSON.parse(String(init?.body)) as { enabled: boolean }
      info = {
        ...info,
        enabled,
        tunnel: enabled ? { state: 'online', deviceUrl: DEVICE_URL } : null,
      }
      return info
    }
    if (path === '/api/pairing') return info
    throw new Error(`未替换的接口：${path}`)
  }
  restoreApi = () => {
    ;(store.client as unknown as { api: typeof original }).api = original
  }

  const { render } = await import('solid-js/web')
  const { Suspense } = await import('solid-js')
  const { default: PairPanel } = await import('./PairPanel.tsx')
  const suspended = { times: 0 }
  const Mark = () => {
    suspended.times += 1
    return <div />
  }
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(
    () => (
      <Suspense fallback={<Mark />}>
        <PairPanel />
      </Suspense>
    ),
    host as unknown as HTMLElement,
  )
  return { host, suspended }
}

const signedIn = (tunnel: RemoteInfo['tunnel'] = null): RemoteInfo => ({
  available: true,
  enabled: tunnel !== null,
  tunnel,
})

test('未登录云端账号时整节不出现', async () => {
  const { host } = await mount({ available: false, enabled: true, tunnel: null })
  await new Promise((r) => setTimeout(r, 30))
  expect(host.querySelector('.pair-section')).toBeNull()
})

test('打开开关后显示 console 中本设备地址的二维码，外层 Suspense 始终不挂起', async () => {
  const { host, suspended } = await mount(signedIn())
  await waitFor(
    () => host.querySelector('.pair-toggle') !== null,
    () => host.innerHTML,
  )
  expect(host.textContent).toContain('允许远程访问')
  const box = host.querySelector<HTMLInputElement>('.pair-toggle input')!
  box.checked = true
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(
    () => host.querySelector('.pair-qr svg') !== null,
    () => host.innerHTML,
  )
  expect(suspended.times).toBe(0)
})

/** 原始失败形状：开关请求失败时没有任何提示，勾选框停留在点击后的状态，而远程访问并未开启。 */
test('开关请求失败时显示原因，勾选框恢复为实际状态', async () => {
  const { host } = await mount(signedIn(), {
    failToggle: '{"message":"remote 必须是 true 或 false"}',
  })
  await waitFor(
    () => host.querySelector('.pair-toggle') !== null,
    () => host.innerHTML,
  )
  const box = host.querySelector<HTMLInputElement>('.pair-toggle input')!
  box.checked = true
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(
    () => (host.textContent ?? '').includes('remote 必须是 true 或 false'),
    () => host.innerHTML,
  )
  expect(host.querySelector<HTMLInputElement>('.pair-toggle input')?.checked).toBe(false)
  expect(host.querySelector('.pair-qr')).toBeNull()
})

test('隧道断开时显示原因；协议版本过旧时提示更新应用', async () => {
  const offline = await mount(signedIn({ state: 'offline', message: '无法连接云端服务' }))
  await waitFor(
    () => (offline.host.textContent ?? '').includes('无法连接云端服务'),
    () => offline.host.innerHTML,
  )
  dispose?.()
  document.body.replaceChildren()
  restoreApi?.()

  const outdated = await mount(signedIn({ state: 'outdated' }))
  await waitFor(
    () => (outdated.host.textContent ?? '').includes('需要更新应用'),
    () => outdated.host.innerHTML,
  )
})
