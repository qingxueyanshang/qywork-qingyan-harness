/**
 * 通用设置：新对话默认权限（配置读取、即时保存、连续切换、失败回滚，不修改当前会话）；
 * 主题与皮肤一行（点选主题即取消皮肤，皮肤一行打开 `SkinDialog`）。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConfigPayload, RedactedConfig } from '../../lib/store/index.ts'

let store: typeof import('../../lib/store/index.ts')
let configStore: typeof import('./configStore.ts')
let originalApi: typeof store.client.api
let originalSend: typeof store.client.send
let stored: RedactedConfig
let failNext = false
let pendingSave: Promise<void> | undefined
let commands: unknown[] = []

const payload = (): ConfigPayload => ({
  path: 'config.json',
  config: structuredClone(stored),
  version: 'test',
  notices: [],
  problems: [],
  defaultEnvAllowList: [],
})

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
  store = await import('../../lib/store/index.ts')
  configStore = await import('./configStore.ts')
  originalApi = store.client.api
  originalSend = store.client.send
  store.client.send = (command) => {
    commands.push(command)
  }
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (path === '/api/models')
      return { providers: [], media: [], mediaLibrary: [], library: [] } as T
    if (path === '/api/pairing') return { available: false, enabled: false, tunnel: null } as T
    // 「运行环境」一节在页面显示时获取检测结果（`environmentStore.ts`）。
    if (path === '/api/host/environment') return { environment: [] } as T
    if (path === '/api/skins') return { skins: [], failures: [] } as T
    if (path !== '/api/config') throw new Error(`unexpected ${path}`)
    if (init?.method === 'PUT') {
      const waiting = pendingSave
      pendingSave = undefined
      if (waiting) await waiting
      if (failNext) {
        failNext = false
        throw new Error('无法保存默认权限')
      }
      stored = JSON.parse(String(init.body)).config
      return { ok: true } as T
    }
    return payload() as T
  }
})

beforeEach(async () => {
  stored = {
    mode: 'auto',
    providers: { existing: { kind: 'openai_chat_completions', hasApiKey: true, models: {} } },
    updates: { autoCheck: false, autoDownload: true },
  }
  failNext = false
  pendingSave = undefined
  commands = []
  await configStore.reloadConfig()
})

afterAll(async () => {
  store.client.api = originalApi
  store.client.send = originalSend
  await GlobalRegistrator.unregister()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待设置保存超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount() {
  const { render } = await import('solid-js/web')
  const { GeneralSettings } = await import('./GeneralSettings.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <GeneralSettings />, host)
  const buttons = [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="新对话默认权限"] button'),
  ]
  const select = (label: string) => buttons.find((button) => button.textContent === label)!.click()
  const selected = () =>
    buttons.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent
  return {
    host,
    select,
    selected,
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('默认权限即时保存，重新读取后保持选项，不发送当前会话权限指令', async () => {
  const ui = await mount()
  const unchanged = structuredClone(stored)
  try {
    expect(ui.selected()).toBe('自动审批')
    ui.select('完全访问')
    expect(ui.selected()).toBe('完全访问')
    await until(() => !configStore.configBusy())
    expect(stored).toEqual({ ...unchanged, mode: 'full' })
    await configStore.reloadConfig()
    expect(ui.selected()).toBe('完全访问')
    expect(commands).toEqual([])
  } finally {
    ui.close()
  }
})

test('连续切换时保留最后选择，保存失败时回滚并显示错误', async () => {
  const ui = await mount()
  try {
    const gate = Promise.withResolvers<void>()
    pendingSave = gate.promise
    ui.select('完全访问')
    ui.select('自动审批')
    expect(ui.selected()).toBe('自动审批')
    gate.resolve()
    await until(() => !configStore.configBusy())
    expect(stored.mode).toBe('auto')
    expect(ui.selected()).toBe('自动审批')
    failNext = true
    ui.select('完全访问')
    await until(() => !configStore.configBusy())
    expect(stored.mode).toBe('auto')
    expect(ui.selected()).toBe('自动审批')
    expect(ui.host.querySelector('.settings-error')?.textContent).toContain('无法保存默认权限')
    ui.select('完全访问')
    await until(() => !configStore.configBusy())
    expect(stored.mode).toBe('full')
    expect(ui.host.querySelector('.settings-error')).toBeNull()
  } finally {
    ui.close()
  }
})

test('选用皮肤时主题三项都不高亮，点选一项即取消皮肤', async () => {
  store.chooseSkin({ id: 'night', base: 'dark' })
  const view = await mount()
  try {
    const themes = [...view.host.querySelectorAll<HTMLButtonElement>('.seg-item')].filter((b) =>
      ['跟随系统', '浅色', '深色'].includes(b.textContent ?? ''),
    )
    expect(themes.some((b) => b.classList.contains('active'))).toBe(false)
    themes.find((b) => b.textContent === '浅色')!.click()
    expect(store.skinChoice()).toBeNull()
    expect(store.theme()).toBe('light')
    expect(themes.find((b) => b.textContent === '浅色')!.classList.contains('active')).toBe(true)
  } finally {
    store.setTheme('system')
    view.close()
  }
})

test('皮肤一行打开皮肤弹窗，完成后关闭', async () => {
  const view = await mount()
  try {
    const row = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === '无',
    )!
    row.click()
    await until(() => view.host.querySelector('dialog.skin-dialog') !== null)
    const dialog = view.host.querySelector('dialog.skin-dialog')!
    expect([...dialog.querySelectorAll('.skin-list button')].map((b) => b.textContent)).toEqual([
      '无',
      '新建',
    ])
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '完成')!
      .click()
    await until(() => view.host.querySelector('dialog.skin-dialog') === null)
  } finally {
    view.close()
  }
})
