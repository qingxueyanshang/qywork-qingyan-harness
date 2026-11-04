/**
 * 通用设置：新对话默认权限（配置读取、即时保存、连续切换、失败回滚，不修改当前会话）；
 * 主题三项始终可选；「个性化」一行打开个性化弹窗（颜色选择可选空值，修改后保存，恢复默认需确认）；
 * 个性化弹窗中选择图片后界面与服务端一致（`PersonalizationDialog.tsx`）。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_PERSONALIZATION } from '@qywork/core'
import type { ConfigPayload, RedactedConfig } from '../../lib/store/index.ts'

let store: typeof import('../../lib/store/index.ts')
let configStore: typeof import('./configStore.ts')
let originalApi: typeof store.client.api
let originalSend: typeof store.client.send
let stored: RedactedConfig
let failNext = false
let pendingSave: Promise<void> | undefined
let commands: unknown[] = []
let personalCalls: string[] = []

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
    if (path === '/api/personalization') {
      personalCalls.push(init?.method ?? 'GET')
      const body = init?.method === 'PUT' ? JSON.parse(String(init.body)) : DEFAULT_PERSONALIZATION
      return { personalization: body, updatedAt: 1 } as T
    }
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

test('主题三项始终可选，个性化不影响主题的选中项', async () => {
  store.paintPersonalization({
    personalization: { ...DEFAULT_PERSONALIZATION, accent: '#7c3aed' },
    imageUrl: null,
  })
  const view = await mount()
  try {
    const themes = [...view.host.querySelectorAll<HTMLButtonElement>('.seg-item')].filter((b) =>
      ['跟随系统', '浅色', '深色'].includes(b.textContent ?? ''),
    )
    themes.find((b) => b.textContent === '浅色')!.click()
    expect(store.theme()).toBe('light')
    expect(themes.find((b) => b.textContent === '浅色')!.classList.contains('active')).toBe(true)
    expect(store.paintedPersonalization()?.personalization.accent).toBe('#7c3aed')
  } finally {
    store.setTheme('system')
    store.paintPersonalization(null)
    view.close()
  }
})

test('个性化一行打开弹窗：雾面可选颜色与「无」，修改后保存，恢复默认需确认', async () => {
  personalCalls = []
  const view = await mount()
  try {
    const row = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === '默认',
    )!
    row.click()
    await until(() => view.host.querySelector('dialog.personal-dialog') !== null)
    const dialog = view.host.querySelector('dialog.personal-dialog')!
    const labels = [...dialog.querySelectorAll('.setting-row-label')].map((l) => l.textContent)
    expect(labels).toEqual(['背景', '颜色', '雾面', '界面不透明度', '强调色', '流动色'])
    expect(dialog.textContent).not.toContain('模式')

    const fog = dialog.querySelector<HTMLButtonElement>('button[aria-label="雾面颜色"]')!
    expect(fog.querySelector('.color-swatch.empty')).not.toBeNull()
    // 面板打开时，弹窗的关闭请求（Escape）只关闭面板，弹窗保留。
    fog.click()
    expect(dialog.querySelector('.color-panel')).not.toBeNull()
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(dialog.querySelector('.color-panel')).toBeNull()
    expect(view.host.querySelector('dialog.personal-dialog')).not.toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    fog.click()
    const panel = dialog.querySelector('.color-panel')!
    expect(panel.textContent).toContain('无')
    panel.querySelector<HTMLButtonElement>('button[aria-label="#3b82f6"]')!.click()
    // 从看不到背景改为设置雾面：不透明度同一次降为 85%，浓度与速度两行出现。
    expect(store.currentPersonalization().fog).toEqual({
      color: '#3b82f6',
      density: 0.5,
      speed: 0.4,
    })
    expect(store.currentPersonalization().opacity).toBe(0.85)
    expect([...dialog.querySelectorAll('.setting-row-label')].map((l) => l.textContent)).toContain(
      '浓度',
    )
    await until(() => personalCalls.includes('PUT'))

    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '恢复默认')!
      .click()
    await until(() => dialog.querySelector('dialog.personal-reset-dialog') !== null)
    const confirm = dialog.querySelector('dialog.personal-reset-dialog')!
    ;[...confirm.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '恢复默认')!
      .click()
    await until(() => personalCalls.includes('DELETE'))
    expect(store.currentPersonalization()).toEqual(DEFAULT_PERSONALIZATION)

    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '完成')!
      .click()
    await until(() => view.host.querySelector('dialog.personal-dialog') === null)
  } finally {
    store.paintPersonalization(null)
    view.close()
  }
})

/**
 * 原始失败形状：选择图片后服务端保存了 85% 的不透明度，界面仍为 100%，图片被骨架遮住，刷新后才显示。
 * 服务端先广播 `personalization.changed` 再返回响应；广播触发的读取晚于后续预览到达时覆盖预览。
 */
test('从看不到背景改为图片：只发一次请求，变更广播触发的读取到达后界面与服务端一致', async () => {
  const { revealBackdrop } = await import('@qywork/core')
  const { setPersonalizationChange } = await import('../../lib/store/connection.ts')
  const { render } = await import('solid-js/web')
  const { PersonalizationDialog } = await import('./PersonalizationDialog.tsx')
  let server = DEFAULT_PERSONALIZATION
  let seq = 100
  const requests: string[] = []
  const api = store.client.api
  store.client.api = (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${path.split('?')[0]}`)
    if (path.startsWith('/api/personalization/image')) {
      server = revealBackdrop(server, {
        ...server,
        background: { kind: 'image', file: 'bg.png', fit: 'cover', dim: 0.2, blur: 0 },
      })
    } else if (method === 'PUT') server = JSON.parse(String(init?.body))
    if (method === 'PUT') {
      setPersonalizationChange(++seq)
      await new Promise((r) => setTimeout(r, 1))
      return { personalization: server, updatedAt: seq }
    }
    const snapshot = server
    await new Promise((r) => setTimeout(r, 20))
    return { personalization: snapshot, updatedAt: seq }
  }) as typeof api
  store.paintPersonalization({ personalization: DEFAULT_PERSONALIZATION, imageUrl: null })
  const stop = store.observePersonalization()
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <PersonalizationDialog onClose={() => {}} />, host)
  try {
    const input = host.querySelector<HTMLInputElement>('input.personal-file')!
    const file = new File([new Uint8Array([1, 2, 3])], 'bg.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await until(() => requests.includes('GET /api/personalization'))
    await new Promise((r) => setTimeout(r, 400))
    expect(requests).toEqual(['PUT /api/personalization/image', 'GET /api/personalization'])
    expect(server.opacity).toBe(0.85)
    expect(store.currentPersonalization()).toEqual(server)
  } finally {
    dispose()
    host.remove()
    stop()
    store.client.api = api
    store.paintPersonalization(null)
  }
})
