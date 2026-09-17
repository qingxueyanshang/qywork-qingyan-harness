/**
 * 覆盖 `PairPanel.tsx`：开关与换地址期间不得触发外层 Suspense。
 *
 * 设置内容区只有一层 Suspense，它挂起时整页内容被摘出 DOM，滚动位置随之归零。
 * 判据是外层 fallback 的求值次数：Solid 只在边界挂起时才读 `fallback`。
 *
 * **DOM 在这里装，用完卸掉**，理由同 `LoadState.test.tsx`。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

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

const CANDIDATES = [
  { name: '以太网', address: '192.168.1.26', url: 'http://192.168.1.26:1', qr: 'http://a/' },
  { name: 'vEthernet', address: '172.21.16.1', url: 'http://172.21.16.1:1', qr: 'http://b/' },
]

async function mount() {
  const store = await import('../lib/store/index.ts')
  const original = store.client.api
  let lanEnabled = false
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    if (path === '/api/pairing/lan') {
      lanEnabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled
      return { ok: true }
    }
    if (path === '/api/pairing') {
      return {
        url: CANDIDATES[0]?.url,
        token: 't',
        deviceName: 'pc',
        qr: CANDIDATES[0]?.qr,
        lanEnabled,
        candidates: CANDIDATES,
      }
    }
    throw new Error(`没有桩这条：${path}`)
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
  await waitFor(
    () => host.querySelector('.pair-toggle') !== null,
    () => host.textContent ?? '',
  )
  return { host, suspended }
}

test('打开开关出码、再换地址，外层 Suspense 一次都不挂起', async () => {
  const { host, suspended } = await mount()

  const box = host.querySelector<HTMLInputElement>('.pair-toggle input')
  if (!box) throw new Error('开关没渲染')
  box.checked = true
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(
    () => host.querySelector('.pair-qr svg') !== null,
    () => host.innerHTML,
  )
  const first = host.querySelector('.pair-qr')?.innerHTML

  host.querySelectorAll<HTMLButtonElement>('.pair-addr')[1]?.click()
  await waitFor(
    () => host.querySelector('.pair-qr')?.innerHTML !== first,
    () => '换地址后二维码没变',
  )

  expect(host.querySelector('.pair-qr svg')).not.toBeNull()
  expect(suspended.times).toBe(0)
})
