/**
 * 覆盖 `App.tsx` 的 `openLink`：正文里的链接点下去落在右侧面板的浏览器页。
 * 应用里的 `<a>` 全部由 markdown 渲染产出，这一条是它们唯一的落点。
 *
 * DOM 在这里装、用完卸掉，理由同 `components/RunStatus.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** 挂一个和 `.app` 同形状的容器，往里贴一条渲染好的链接，点它。 */
async function clickLink(html: string) {
  const { openLink } = await import('./App.tsx')
  const root = document.createElement('div')
  root.innerHTML = html
  root.addEventListener('click', openLink as (e: Event) => void)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  root.querySelector('a')?.dispatchEvent(event)
  return event
}

describe('正文里的链接', () => {
  test('落到右侧面板的浏览器页，并挡下默认跳转', async () => {
    const store = await import('./lib/store/index.ts')
    store.closeAllPanelTabs()
    const event = await clickLink('<a href="http://localhost:8000">http://localhost:8000</a>')
    expect(event.defaultPrevented).toBe(true)
    const [tab] = store.panelTabs()
    expect(tab?.kind).toBe('browser')
    expect(tab?.url).toBe('http://localhost:8000')
    store.closeAllPanelTabs()
  })

  test('http(s) 之外的 scheme 不接管 —— 浏览器页只加载得了 http(s)', async () => {
    const store = await import('./lib/store/index.ts')
    store.closeAllPanelTabs()
    const event = await clickLink('<a href="mailto:a@b.com">a@b.com</a>')
    expect(event.defaultPrevented).toBe(false)
    expect(store.panelTabs().length).toBe(0)
  })
})
