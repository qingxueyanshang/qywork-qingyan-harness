/**
 * 内置浏览器页按宿主报的显示位置决定网页那块区域放什么。
 *
 * 覆盖范围：`BrowserPanel.tsx`，连同 `store/browser.ts` 的 `browserPresentation`。
 *
 * 原始失败形状：界面按 UA 判「有内置浏览器」，macOS 与 Linux 的外壳里没有入口；判据换成
 * 宿主之后，页在独立窗口里的宿主上面板若照旧摆放子视图，每次翻页签都发一条必然失败的
 * `browser_layout`，而用户没有办法看到那一页。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { BrowserCapability } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

interface Invoke {
  cmd: string
  args: Record<string, unknown> | undefined
}

const g = globalThis as Record<string, unknown>
const WS = { id: 'ws_panel', root: 'C:/p', name: 'p' }
let dispose: (() => void) | undefined
let restore: (() => void) | undefined

afterEach(async () => {
  dispose?.()
  dispose = undefined
  restore?.()
  restore = undefined
  document.body.replaceChildren()
  const store = await import('../lib/store/index.ts')
  store.syncBrowserTabs([])
  store.setWorkspace(null)
})

/** 装成桌面外壳，记下每一条原生调用。 */
function asShell(invokes: Invoke[]): void {
  const before = g.__TAURI_INTERNALS__
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      return Promise.resolve(cmd === 'browser_tabs' ? [] : undefined)
    },
    transformCallback: () => 1,
  }
  restore = () => {
    g.__TAURI_INTERNALS__ = before
  }
}

async function mount(tabId: string, browser: BrowserCapability) {
  const store = await import('../lib/store/index.ts')
  store.setState('capabilities', {
    sandbox: { backend: 'none', active: false, reason: '' },
    environment: [],
    mode: 'auto',
    browser,
  } as never)
  store.setWorkspace(WS)
  store.syncBrowserTabs([{ id: tabId, title: '页', workspaceId: WS.id, createdSeq: 1 }])
  store.setSidePanel({ tab: tabId })
  const { render } = await import('solid-js/web')
  const { default: BrowserPanel } = await import('./BrowserPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <BrowserPanel id={tabId} />, host as unknown as HTMLElement)
  await new Promise((r) => setTimeout(r, 0))
  return { host, store }
}

describe('网页那块区域跟着宿主报的显示位置走', () => {
  test('页嵌在面板里：占位容器的矩形报给宿主，宿主断开期间不收起', async () => {
    const invokes: Invoke[] = []
    asShell(invokes)
    const rect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 300, height: 200 }) as DOMRect
    try {
      const { host, store } = await mount('bt_embed', {
        connected: true,
        runtimeSupported: true,
        presentation: 'embedded',
      })
      expect(host.querySelector('.web-view')).not.toBeNull()
      expect(host.textContent).not.toContain('显示窗口')
      const placed = invokes.filter((i) => i.cmd === 'browser_layout' && i.args?.tabId)
      expect(placed.at(-1)?.args).toMatchObject({ tabId: 'bt_embed', width: 300, height: 200 })

      // 宿主与服务端断开：能力里没有显示位置了，子视图仍摆在原处。
      const before = invokes.length
      store.applyEvent({
        seq: 1,
        at: 0,
        event: { type: 'browser.state', browser: { connected: false, runtimeSupported: false } },
      } as never)
      expect(store.state.capabilities?.browser.presentation).toBeUndefined()
      expect(store.browserPresentation()).toBe('embedded')
      await new Promise((r) => setTimeout(r, 0))
      expect(host.querySelector('.web-view')).not.toBeNull()
      expect(invokes.slice(before).some((i) => i.cmd === 'browser_layout')).toBe(false)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect
    }
  })

  test('页在浏览器自己的窗口里：只给一个按钮，点它把窗口提到前面，不摆放子视图', async () => {
    const invokes: Invoke[] = []
    asShell(invokes)
    const { host, store } = await mount('bt_win', {
      connected: true,
      runtimeSupported: true,
      presentation: 'window',
    })
    expect(store.browserPresentation()).toBe('window')
    expect(host.querySelector('.web-view')).toBeNull()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '显示窗口')
    expect(button).toBeDefined()
    button?.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(invokes.filter((i) => i.cmd === 'browser_activate')).toEqual([
      { cmd: 'browser_activate', args: { tabId: 'bt_win' } },
    ])
    expect(invokes.some((i) => i.cmd === 'browser_layout')).toBe(false)
  })
})
