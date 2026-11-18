/**
 * 内置浏览器页按宿主报告的显示位置决定网页区域的内容，地址栏呈现宿主上报的页面状态。
 *
 * 覆盖范围：`BrowserPanel.tsx`，以及 `store/browser.ts` 的 `browserPresentation`。
 *
 * 原始失败形状：界面按 UA 判定「有内置浏览器」时，macOS 与 Linux 的外壳中没有入口；按宿主判定
 * 而不区分显示位置时，网页位于独立窗口的宿主上面板仍摆放子视图，每次切换页签都发送一条必然失败的
 * `browser_layout`，用户无法看到该网页。
 *
 * 缩放的原始失败形状：地址栏中没有缩放比例，页面中按 Ctrl+滚轮缩放后无从得知当前比例。
 *
 * 地址栏的原始失败形状：后退与前进按钮在没有历史时仍可点击；提交被拒绝的地址后输入的文字被清空；
 * 本地文件的地址以 `%E4%B8%AD` 形式显示。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { BrowserCapability } from '@qywork/core'
import type { NativeTab } from '../lib/browser.ts'

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
const EMBEDDED: BrowserCapability = {
  connected: true,
  runtimeSupported: true,
  presentation: 'embedded',
}
let dispose: (() => void) | undefined
let restore: (() => void) | undefined
/** 当前测试的宿主清单。清空后重新对账，镜像随之清空。 */
let hostTabs: NativeTab[] = []

afterEach(async () => {
  dispose?.()
  dispose = undefined
  const { initBrowserProjection } = await import('../lib/store/browser.ts')
  hostTabs.length = 0
  initBrowserProjection()
  await flush()
  restore?.()
  restore = undefined
  document.body.replaceChildren()
  const store = await import('../lib/store/index.ts')
  store.syncBrowserTabs([])
  store.setWorkspace(null)
})

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function nativeTab(tabId: string, next: Partial<NativeTab> = {}): NativeTab {
  return {
    tabId,
    url: 'https://example.com/',
    title: '页',
    workspaceId: WS.id,
    createdSeq: 1,
    zoom: 1,
    canGoBack: false,
    canGoForward: false,
    openerTabId: null,
    hidden: false,
    ...next,
  }
}

/**
 * 模拟桌面外壳，记录每一次原生调用。`tabs` 是宿主当前的标签页清单；`reply` 为指定命令自定义响应，
 * 返回 `undefined` 时使用默认响应。
 */
function asShell(
  invokes: Invoke[],
  tabs: NativeTab[] = [],
  reply?: (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown> | undefined,
): void {
  hostTabs = tabs
  const before = g.__TAURI_INTERNALS__
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      // 每次返回新数组：镜像信号按引用比较，返回同一个数组时不更新。
      return reply?.(cmd, args) ?? Promise.resolve(cmd === 'browser_tabs' ? [...tabs] : undefined)
    },
    transformCallback: () => 1,
  }
  restore = () => {
    g.__TAURI_INTERNALS__ = before
  }
}

/** 按宿主清单重新对账一次：模拟外壳推送 `browser:tabs`。 */
async function project(): Promise<void> {
  const { initBrowserProjection } = await import('../lib/store/browser.ts')
  initBrowserProjection()
  await flush()
}

async function mount(tabId: string, browser: BrowserCapability) {
  const store = await import('../lib/store/index.ts')
  store.setState('capabilities', {
    sandbox: { backend: 'none', active: false, reason: '' },
    browser,
  } as never)
  store.setWorkspace(WS)
  // 对账会先收起全部子视图（`browser_layout`）。宿主清单为空的测试不对账，以便检查是否摆放过子视图。
  if (hostTabs.length) await project()
  store.syncBrowserTabs([
    { id: tabId, title: '页', url: 'https://example.com/', workspaceId: WS.id, createdSeq: 1 },
  ])
  store.setSidePanel({ tab: tabId })
  const { render } = await import('solid-js/web')
  const { default: BrowserPanel } = await import('./BrowserPanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <BrowserPanel id={tabId} />, host as unknown as HTMLElement)
  await flush()
  return { host, store }
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

/** 在地址栏中输入文字并按回车提交。 */
function submit(host: HTMLElement, text: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('.web-url')!
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  host
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return input
}

describe('网页区域按宿主报告的显示位置呈现', () => {
  test('网页嵌入面板：占位容器的矩形报告给宿主，宿主断开期间不收起', async () => {
    const invokes: Invoke[] = []
    asShell(invokes)
    const rect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 300, height: 200 }) as DOMRect
    try {
      const { host, store } = await mount('bt_embed', EMBEDDED)
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
      await flush()
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
    expect(host.querySelector('.zoom-control')).toBeNull()
    const shown = [...host.querySelectorAll('button')].find((b) => b.textContent === '显示窗口')
    expect(shown).toBeDefined()
    shown?.click()
    await flush()
    expect(invokes.filter((i) => i.cmd === 'browser_activate')).toEqual([
      { cmd: 'browser_activate', args: { tabId: 'bt_win' } },
    ])
    expect(invokes.some((i) => i.cmd === 'browser_layout')).toBe(false)
  })

  test('网页嵌入面板：地址栏右侧显示宿主上报的缩放比例，加减按钮按档位缩放', async () => {
    const invokes: Invoke[] = []
    asShell(invokes, [nativeTab('bt_zoom', { zoom: 1.25 })])
    const { host } = await mount('bt_zoom', EMBEDDED)
    expect(host.querySelector('.zoom-control output')?.textContent).toBe('125%')
    button(host, '放大').click()
    button(host, '缩小').click()
    expect(invokes.filter((i) => i.cmd === 'browser_zoom').map((i) => i.args)).toEqual([
      { tabId: 'bt_zoom', action: 'in' },
      { tabId: 'bt_zoom', action: 'out' },
    ])
  })
})

describe('地址栏', () => {
  test('网页嵌入面板：后退与前进按宿主上报的历史启用，历史变化后随之更新', async () => {
    const tabs = [nativeTab('bt_hist', { canGoBack: true })]
    asShell([], tabs)
    const { host } = await mount('bt_hist', EMBEDDED)
    expect(button(host, '后退').disabled).toBe(false)
    expect(button(host, '前进').disabled).toBe(true)

    tabs[0] = { ...tabs[0]!, canGoBack: false, canGoForward: true }
    await project()
    expect(button(host, '后退').disabled).toBe(true)
    expect(button(host, '前进').disabled).toBe(false)
  })

  test('网页位于浏览器自身窗口：宿主不上报历史，后退与前进按钮不禁用', async () => {
    asShell([], [nativeTab('bt_hist_win')])
    const { host } = await mount('bt_hist_win', {
      connected: true,
      runtimeSupported: true,
      presentation: 'window',
    })
    expect(button(host, '后退').disabled).toBe(false)
    expect(button(host, '前进').disabled).toBe(false)
  })

  test('三个导航按钮的提示请求显示在上方：下方是原生子视图', async () => {
    asShell([], [nativeTab('bt_tip')])
    const { host } = await mount('bt_tip', EMBEDDED)
    for (const label of ['后退', '前进', '刷新']) {
      expect(button(host, label).dataset.tipPlace).toBe('above')
    }
  })

  test('宿主拒绝地址时保留输入的文字并显示原因；页面导航后错误随之清除', async () => {
    const tabs = [nativeTab('bt_go')]
    asShell([], tabs, (cmd) =>
      cmd === 'browser_navigate'
        ? Promise.reject(new Error('只能打开 HTTP、HTTPS 或本地文件'))
        : undefined,
    )
    const { host } = await mount('bt_go', EMBEDDED)
    const input = submit(host, 'ftp://host/a')
    await flush()
    expect(input.value).toBe('ftp://host/a')
    expect(host.querySelector('.web-error')?.textContent).toBe('只能打开 HTTP、HTTPS 或本地文件')

    tabs[0] = { ...tabs[0]!, url: 'https://example.com/next' }
    await project()
    expect(host.querySelector('.web-error')).toBeNull()
  })

  test('宿主接受地址后地址栏改为显示宿主上报的地址', async () => {
    const invokes: Invoke[] = []
    asShell(invokes, [nativeTab('bt_ok')])
    const { host } = await mount('bt_ok', EMBEDDED)
    const input = submit(host, 'example.org')
    await flush()
    expect(invokes.filter((i) => i.cmd === 'browser_navigate').map((i) => i.args)).toEqual([
      { tabId: 'bt_ok', action: 'goto', url: 'example.org' },
    ])
    expect(input.value).toBe('https://example.com/')
  })

  /** 提交显示的文字时打开的是同一个文件，外壳一侧的解析由 `address.rs` 的测试锁定。 */
  test('本地文件地址解码显示，百分号与井号保持转义；原样提交显示的文字', async () => {
    const invokes: Invoke[] = []
    const url = 'file:///C:/p/%E9%B9%88%E9%B9%95%20%E9%AA%91%E8%BD%A6%20%23100%2520.html'
    asShell(invokes, [nativeTab('bt_file', { url })])
    const { host } = await mount('bt_file', EMBEDDED)
    const input = host.querySelector<HTMLInputElement>('.web-url')!
    expect(input.value).toBe('file:///C:/p/鹈鹕 骑车 %23100%2520.html')
    submit(host, input.value)
    await flush()
    expect(invokes.find((i) => i.cmd === 'browser_navigate')?.args?.url).toBe(
      'file:///C:/p/鹈鹕 骑车 %23100%2520.html',
    )
  })
})
