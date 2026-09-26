/**
 * 「权限」页电脑控制那一张卡：状态行的判定顺序，与缺项行及其「打开系统设置」按钮。
 *
 * 覆盖范围：`AccessSettings.tsx` 的 `desktopStatus` 与缺项行。
 *
 * 原始失败形状：授权事实由 worker 报之前，Mac/Linux 上 worker 没起来也显示「系统未授权」，
 * 而那时系统设置里没有任何一项可授。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DesktopCapability } from '@qywork/core'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

const g = globalThis as Record<string, unknown>

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) delegated.call(button, event)
  else button.dispatchEvent(event)
}

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return ok()
}

const desktop = (over: Partial<DesktopCapability>): DesktopCapability => ({
  connected: true,
  workerReady: true,
  authorized: true,
  missing: [],
  ...over,
})

test('状态依次报：宿主未连接 → 组件未就绪 → 系统未授权 → 已就绪', async () => {
  const { desktopStatus } = await import('./AccessSettings.tsx')
  expect(desktopStatus(undefined)).toBe('读取中…')
  expect(desktopStatus(desktop({ connected: false, workerReady: false, authorized: false }))).toBe(
    '宿主未连接',
  )
  // worker 没起来时没有授权事实：报组件未就绪，不报系统未授权。
  expect(desktopStatus(desktop({ workerReady: false, authorized: false }))).toBe('组件未就绪')
  expect(desktopStatus(desktop({ authorized: false, missing: ['accessibility'] }))).toBe(
    '系统未授权',
  )
  // 只缺屏幕录制时读取与动作照常可用。
  expect(desktopStatus(desktop({ missing: ['screen_recording'] }))).toBe('已就绪')
})

/** 挂一份「权限」页，返回页面容器、原生调用记录与收尾函数。 */
async function mount(
  capability: DesktopCapability,
  shell: ((cmd: string) => Promise<unknown>) | null,
) {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { setState } = await import('../../lib/store/state.ts')
  const { AccessSettings } = await import('./AccessSettings.tsx')
  store.client.api = async <T,>(path: string) => {
    if (path === '/api/config') {
      return {
        path: 'config.json',
        config: { providers: {} },
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    }
    throw new Error(`unexpected ${path}`)
  }
  const invokes: { cmd: string; args: unknown }[] = []
  const previousShell = g.__TAURI_INTERNALS__
  if (shell) {
    g.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => {
        invokes.push({ cmd, args })
        return shell(cmd)
      },
      transformCallback: () => 1,
    }
  } else {
    delete g.__TAURI_INTERNALS__
  }
  const previousCaps = store.state.capabilities
  setState('capabilities', {
    sandbox: { backend: 'none', active: false, reason: '' },
    environment: [],
    mode: 'auto',
    browser: { connected: false, runtimeSupported: false },
    desktop: capability,
  } as never)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <AccessSettings />, host as unknown as HTMLElement)
  await until(() => (host.textContent ?? '').includes('电脑控制'))
  const card = () =>
    Array.from(host.querySelectorAll<HTMLElement>('.settings-block')).find((b) =>
      b.querySelector('.settings-block-head')?.textContent?.includes('电脑控制'),
    )
  const rows = () =>
    Array.from(card()?.querySelectorAll<HTMLElement>('.setting-row') ?? []).map((r) => ({
      label: r.querySelector('.setting-row-label')?.textContent ?? '',
      hint: r.querySelector('.setting-row-hint')?.textContent ?? '',
      button: r.querySelector<HTMLButtonElement>('button.btn-ghost'),
    }))
  return {
    rows,
    invokes,
    done: () => {
      dispose()
      host.remove()
      setState('capabilities', previousCaps)
      g.__TAURI_INTERNALS__ = previousShell
    },
  }
}

test('macOS 缺辅助功能与屏幕录制：各一行、各一个按钮，按钮按名字打开系统设置', async () => {
  const page = await mount(
    desktop({ authorized: false, missing: ['accessibility', 'screen_recording'] }),
    () => Promise.resolve(null),
  )
  try {
    const rows = page.rows()
    expect(rows.map((r) => [r.label, r.hint])).toEqual([
      ['前台操作', '用真实鼠标键盘，执行时会打断你'],
      ['状态', '系统未授权'],
      ['辅助功能', '未授权'],
      ['屏幕录制', '未授权'],
    ])
    expect(rows.slice(2).map((r) => r.button?.textContent)).toEqual([
      '打开系统设置',
      '打开系统设置',
    ])
    click(rows[3]?.button as HTMLButtonElement)
    expect(page.invokes).toEqual([
      { cmd: 'desktop_open_settings', args: { grant: 'screen_recording' } },
    ])
  } finally {
    page.done()
  }
})

test('外壳打不开系统设置时那一行如实报失败', async () => {
  const page = await mount(desktop({ authorized: false, missing: ['accessibility'] }), () =>
    Promise.reject(new Error('open failed')),
  )
  try {
    click(page.rows()[2]?.button as HTMLButtonElement)
    expect(await until(() => page.rows()[2]?.hint === '无法打开系统设置')).toBe(true)
  } finally {
    page.done()
  }
})

test('Linux 找不到无障碍总线：一行说明缺什么，没有按钮', async () => {
  const page = await mount(desktop({ authorized: false, missing: ['accessibility_bus'] }), () =>
    Promise.resolve(null),
  )
  try {
    const bus = page.rows()[2]
    expect([bus?.label, bus?.hint, bus?.button]).toEqual(['无障碍总线', '不可用', null])
  } finally {
    page.done()
  }
})

test('不在桌面外壳里时缺项照常列出，但不给打开系统设置的按钮', async () => {
  const page = await mount(desktop({ authorized: false, missing: ['accessibility'] }), null)
  try {
    const row = page.rows()[2]
    expect([row?.label, row?.hint, row?.button]).toEqual(['辅助功能', '未授权', null])
  } finally {
    page.done()
  }
})
