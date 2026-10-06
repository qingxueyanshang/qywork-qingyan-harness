/**
 * 内置浏览器页按宿主报告的显示位置决定网页区域的内容。
 *
 * 覆盖范围：`BrowserPanel.tsx`，以及 `store/browser.ts` 的 `browserPresentation`。
 *
 * 原始失败形状：界面按 UA 判定「有内置浏览器」时，macOS 与 Linux 的外壳中没有入口；按宿主判定
 * 而不区分显示位置时，网页位于独立窗口的宿主上面板仍摆放子视图，每次切换页签都发送一条必然失败的
 * `browser_layout`，用户无法看到该网页。
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

/** 模拟桌面外壳，记录每一次原生调用。 */
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

describe('网页区域按宿主报告的显示位置呈现', () => {
  test('网页嵌入面板：占位容器的矩形报告给宿主，宿主断开期间不收起', async () => {
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

      // 宿主与服务端断开：能力中不再有显示位置，子视图保持在原位置。
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

  test('网页位于浏览器自身窗口：只显示一个按钮，点击后将窗口置于前台，不摆放子视图', async () => {
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
