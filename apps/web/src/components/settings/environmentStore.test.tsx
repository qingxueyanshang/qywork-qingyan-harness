/**
 * 覆盖范围：`environmentStore.ts` 与读取它的「模块」页（`ModulesSettings.tsx`）。
 *
 * 原始失败形状：运行环境只随握手下发，安装完成后重新打开设置页，界面仍显示「需要安装」，
 * 直到重新连接。
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  document.body.replaceChildren()
})

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return ok()
}

const row = (id: string, path: string | null) => ({
  id,
  label: id,
  path,
  required: false,
  hint: '缺失',
  canInstall: false,
})

test('重新打开「模块」页时重新检测：安装完成后显示为可用', async () => {
  const store = await import('../../lib/store/index.ts')
  let python: string | null = null
  const original = store.client.api
  store.client.api = async <T,>(path: string): Promise<T> => {
    if (path === '/api/host/environment') {
      return { environment: [row('python', python), row('office-libs', 'C:\\py\\Lib')] } as T
    }
    if (path === '/api/tools') return { tools: [] } as T
    throw new Error(`未预期请求：${path}`)
  }
  restore = () => {
    store.client.api = original
  }
  const { render } = await import('solid-js/web')
  const { ModulesSettings } = await import('./ModulesSettings.tsx')
  const open = () => {
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <ModulesSettings />, host as unknown as HTMLElement)
    return { host, dispose }
  }

  const first = open()
  expect(
    await until(() => first.host.textContent?.includes('运行环境：需要安装 Python') ?? false),
  ).toBe(true)
  first.dispose()

  python = 'C:\\py\\python.exe'
  const second = open()
  expect(await until(() => second.host.textContent?.includes('运行环境：可用') ?? false)).toBe(true)
  second.dispose()
})
