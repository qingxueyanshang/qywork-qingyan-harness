/**
 * 覆盖 `back-stack.ts`：窄屏上浮层打开时压入一条记录，后退关闭最上层，以其他方式关闭时撤回记录且随之到达的后退不再关闭浮层；
 * 宽屏不压入。原始失败形状：手机上返回手势不关闭面板与抽屉，在云端网页的 iframe 中直接回到电脑列表。
 * 浏览历史以桩代替：`pushState` 计数，`back()` 记录调用，`popstate` 由测试派发。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function setup(narrow: boolean) {
  globalThis.matchMedia = ((query: string) =>
    ({
      matches: narrow && query === '(max-width: 820px)',
      media: query,
    }) as MediaQueryList) as never
  let pushes = 0
  let backs = 0
  history.pushState = () => {
    pushes += 1
  }
  history.back = () => {
    backs += 1
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const { createRoot, createSignal } = await import('solid-js')
  const { closeOnBack } = await import('./back-stack.ts')
  const layer = (name: string, closed: string[]) =>
    createRoot(() => {
      const [open, setOpen] = createSignal(false)
      closeOnBack(open, () => {
        closed.push(name)
        setOpen(false)
      })
      return { open, setOpen }
    })
  return { layer, counts: () => ({ pushes, backs }) }
}

test('后退依次关闭最上层；以关闭按钮关闭时撤回记录，随之到达的后退不关闭其他浮层', async () => {
  const { layer, counts } = await setup(true)
  const closed: string[] = []
  const drawer = layer('抽屉', closed)
  const settings = layer('设置', closed)
  drawer.setOpen(true)
  settings.setOpen(true)
  expect(counts().pushes).toBe(2)

  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(closed).toEqual(['设置'])
  expect(drawer.open()).toBe(true)

  drawer.setOpen(false)
  expect(counts().backs).toBe(1)
  expect(closed).toEqual(['设置'])

  settings.setOpen(true)
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(closed).toEqual(['设置', '设置'])
})

test('宽屏不压入记录', async () => {
  const { layer, counts } = await setup(false)
  const closed: string[] = []
  const panel = layer('面板', closed)
  panel.setOpen(true)
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(counts().pushes).toBe(0)
  expect(closed).toEqual([])
  expect(panel.open()).toBe(true)
})
