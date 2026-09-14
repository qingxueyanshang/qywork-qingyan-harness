/**
 * 内置浏览器投影的初始化（`store/browser.ts` 的 `initBrowserProjection`）。
 *
 * 锁的是一个真实布局 bug：原生子视图是窗口的子 HWND，不受 Solid 生命周期管辖。
 * 页面被硬刷新（dev 协调重载、整页 reload）时上一份页面的 `onCleanup` 不会跑，
 * 摆开着的子视图停在旧矩形上盖住聊天；而刷新后面板从收起态起、没有 `BrowserPanel`
 * 去收它。原始失败形状：刷新后一条约 300px 的窄条浮在会话正文上，既不铺满面板也不消失。
 * 修法是初始化时无条件 park 一次。
 *
 * `store/browser.ts` 顶层 `new QyClient` 不在这条链上，但它经 `state.ts` / `ui.ts` 间接
 * 触到几个浏览器全局，所以这里先补齐再动态 import（同 `store.test.ts` 的理由）。
 */

import { afterEach, describe, expect, test } from 'bun:test'

const g = globalThis as Record<string, unknown>
g.location ??= {
  hash: '',
  href: 'http://127.0.0.1:5180/',
  search: '',
  pathname: '/',
  origin: 'http://127.0.0.1:5180',
}
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
g.matchMedia ??= () => ({ matches: false })
const stored = new Map<string, string>()
g.localStorage ??= {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => stored.set(k, v),
  removeItem: (k: string) => stored.delete(k),
}

const { initBrowserProjection } = await import('./browser.ts')

interface Invoke {
  cmd: string
  args: Record<string, unknown> | undefined
}

/** 装成 Windows 桌面外壳，记录所有原生调用。返回 restore。 */
function asShell(invokes: Invoke[]): () => void {
  const origNav = g.navigator
  const origTauri = g.__TAURI_INTERNALS__
  g.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> | undefined) => {
      invokes.push({ cmd, args })
      if (cmd === 'browser_tabs') return Promise.resolve([])
      return Promise.resolve(0)
    },
    transformCallback: () => 1,
  }
  return () => {
    g.navigator = origNav
    g.__TAURI_INTERNALS__ = origTauri
  }
}

describe('内置浏览器投影初始化', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  test('在 Windows 桌面外壳里初始化时，先把所有子视图移出可视区', () => {
    const invokes: Invoke[] = []
    restore = asShell(invokes)

    initBrowserProjection()

    // park：`browser_layout` 不带 tabId、宽高为 0 —— 宿主据此把每一页都收出可视区。
    const park = invokes.find((i) => i.cmd === 'browser_layout')
    expect(park).toBeDefined()
    expect(park?.args?.tabId).toBeUndefined()
    expect(park?.args?.width).toBe(0)
    expect(park?.args?.height).toBe(0)
  })

  test('不是桌面外壳时一条原生命令都不发', () => {
    const invokes: Invoke[] = []
    const origNav = g.navigator
    const origTauri = g.__TAURI_INTERNALS__
    g.navigator = { userAgent: 'not-a-shell' }
    g.__TAURI_INTERNALS__ = undefined
    restore = () => {
      g.navigator = origNav
      g.__TAURI_INTERNALS__ = origTauri
    }

    initBrowserProjection()

    expect(invokes).toHaveLength(0)
  })
})
