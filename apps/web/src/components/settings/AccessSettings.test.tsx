/**
 * 「权限」页的电脑控制卡片：状态行的判定顺序，以及缺项行与其「打开系统设置」按钮。
 *
 * 覆盖范围：`AccessSettings.tsx` 的状态行、前台操作默认值与开关保存。
 *
 * 原始失败形状：授权事实不由 worker 报告时，Mac/Linux 上 worker 未启动也显示「系统未授权」，
 * 而此时系统设置中没有任何可授权的项。
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

test('状态依次显示：宿主未连接 → 组件未就绪 → 系统未授权 → 已就绪', async () => {
  const { desktopStatus } = await import('./AccessSettings.tsx')
  expect(desktopStatus(undefined)).toBe('读取中…')
  expect(desktopStatus(desktop({ connected: false, workerReady: false, authorized: false }))).toBe(
    '宿主未连接',
  )
  // worker 未启动时没有授权事实：显示组件未就绪，不显示系统未授权。
  expect(desktopStatus(desktop({ workerReady: false, authorized: false }))).toBe('组件未就绪')
  expect(desktopStatus(desktop({ authorized: false, missing: ['accessibility'] }))).toBe(
    '系统未授权',
  )
  // 只缺屏幕录制时读取与动作照常可用。
  expect(desktopStatus(desktop({ missing: ['screen_recording'] }))).toBe('已就绪')
})

/** 挂载「权限」页，返回页面容器、原生调用记录与清理函数。 */
async function mount(
  capability: DesktopCapability,
  shell: ((cmd: string) => Promise<unknown>) | null,
  foreground?: boolean,
) {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { setState } = await import('../../lib/store/state.ts')
  const { AccessSettings } = await import('./AccessSettings.tsx')
  let cfg = {
    providers: {},
    ...(foreground === undefined ? {} : { desktopForeground: foreground }),
  }
  const saved: boolean[] = []
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/config') {
      if (init?.method === 'PUT') {
        cfg = JSON.parse(String(init.body)).config
        saved.push(cfg.desktopForeground as boolean)
      }
      return {
        path: 'config.json',
        config: cfg,
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
  const { reloadConfig } = await import('./configStore.ts')
  await reloadConfig()
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
    saved,
    foreground: () => card()?.querySelector<HTMLElement>('.setting-row .seg'),
    done: () => {
      dispose()
      host.remove()
      setState('capabilities', previousCaps)
      g.__TAURI_INTERNALS__ = previousShell
    },
  }
}

test('前台操作默认启用，显式关闭与重新开启均按实际选择保存', async () => {
  for (const value of [undefined, true, false]) {
    const page = await mount(desktop({}), null, value)
    try {
      const selected = () => page.foreground()?.querySelector('.active')?.textContent
      expect(selected()).toBe(value === false ? '关闭' : '启用')
      const buttons = page.foreground()?.querySelectorAll<HTMLButtonElement>('button')
      click(buttons?.[0] as HTMLButtonElement)
      expect(await until(() => page.saved.length === 1)).toBe(true)
      expect(page.saved[0]).toBe(false)
      expect(selected()).toBe('关闭')
      click(buttons?.[1] as HTMLButtonElement)
      expect(await until(() => page.saved.length === 2)).toBe(true)
      expect(page.saved[1]).toBe(true)
      expect(selected()).toBe('启用')
    } finally {
      page.done()
    }
  }
})

test('macOS 缺少辅助功能与屏幕录制：各占一行、各有一个按钮，按钮按名称打开系统设置', async () => {
  const page = await mount(
    desktop({ authorized: false, missing: ['accessibility', 'screen_recording'] }),
    () => Promise.resolve(null),
  )
  try {
    const rows = page.rows()
    expect(rows.map((r) => [r.label, r.hint])).toEqual([
      ['前台操作', '使用真实鼠标键盘，执行时会中断当前操作'],
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

test('外壳无法打开系统设置时该行显示失败', async () => {
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

test('Linux 未找到无障碍总线：用一行说明缺少的项，不显示按钮', async () => {
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

test('不在桌面外壳中时缺项照常列出，但不提供打开系统设置的按钮', async () => {
  const page = await mount(desktop({ authorized: false, missing: ['accessibility'] }), null)
  try {
    const row = page.rows()[2]
    expect([row?.label, row?.hint, row?.button]).toEqual(['辅助功能', '未授权', null])
  } finally {
    page.done()
  }
})
