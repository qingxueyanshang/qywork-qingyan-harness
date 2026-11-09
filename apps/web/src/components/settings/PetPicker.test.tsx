/**
 * 宠物皮肤下拉：宠物库晚于偏好到达时仍显示当前选中的宠物（原生 select 会落到第一项）；
 * 删除按钮在每只用户宠物的行内，内置宠物没有，删除前须确认；点选后写入偏好并收起。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PetEntry } from '@qywork/core'

let store: typeof import('../../lib/store/index.ts')
let originalApi: typeof store.client.api
let pets: PetEntry[] = []
let gate: Promise<void> | undefined
const removed: string[] = []

const states = { frames: ['a.png'], fps: 1 }
const entry = (id: string, name: string): PetEntry => ({
  id,
  updatedAt: 1,
  pack: {
    name,
    size: 96,
    states: { desktop: states, failed: states, working: states, done: states, idle: states },
  },
})

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click', 'keydown'])
  store = await import('../../lib/store/index.ts')
  originalApi = store.client.api
  store.client.api = (async (path: string, init?: RequestInit) => {
    if (path === '/api/pets') {
      if (gate) await gate
      return { pets }
    }
    if (init?.method === 'DELETE') {
      removed.push(decodeURIComponent(path.split('/').at(-1) ?? ''))
      return {}
    }
    throw new Error(`unexpected ${path}`)
  }) as typeof store.client.api
})

afterAll(async () => {
  store.client.api = originalApi
  store.setPetPrefs({ pack: null })
  await GlobalRegistrator.unregister()
})

async function mount() {
  const { render } = await import('solid-js/web')
  const { PetPicker } = await import('./PetPicker.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const errors: (string | null)[] = []
  const dispose = render(() => <PetPicker onError={(e) => errors.push(e)} />, host)
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="宠物皮肤"]')!
  return {
    trigger,
    menu: () => document.querySelector<HTMLElement>('.pet-pick-menu'),
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('宠物库晚于偏好到达：重新打开设置时显示的是当前选中的宠物', async () => {
  pets = [entry('bubble', '飞鱼娘·泡泡'), entry('maid', '大肥鱼娘 · 蓝色鲸鱼女仆')]
  store.setPetPrefs({ pack: 'maid' })
  const wait = Promise.withResolvers<void>()
  gate = wait.promise
  const loading = store.refreshPetLibrary()
  const ui = await mount()
  try {
    expect(ui.trigger.textContent).not.toBe('团子')
    wait.resolve()
    await loading
    expect(ui.trigger.textContent).toBe('大肥鱼娘 · 蓝色鲸鱼女仆')
  } finally {
    gate = undefined
    ui.close()
  }
})

test('删除按钮位于每只用户宠物的行内，内置宠物没有；删除前须确认；点选写入偏好并收起', async () => {
  store.setPetPrefs({ pack: null })
  await store.refreshPetLibrary()
  const ui = await mount()
  try {
    expect(ui.trigger.textContent).toBe('团子')
    ui.trigger.click()
    const menu = ui.menu()!
    const rows = [...menu.querySelectorAll('.pet-option')]
    expect(rows.map((r) => r.querySelector('[data-pet-option]')?.textContent)).toEqual([
      '团子',
      '飞鱼娘·泡泡',
      '大肥鱼娘 · 蓝色鲸鱼女仆',
    ])
    expect(rows.map((r) => r.querySelector('.pet-option-remove') !== null)).toEqual([
      false,
      true,
      true,
    ])
    // 行外不再有单独的删除按钮。
    expect(document.querySelector('.pet-pick > .btn-ghost')).toBeNull()

    const confirm = () => document.querySelector<HTMLElement>('.confirm-dialog')
    const confirmButton = (label: string) =>
      [...confirm()!.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === label,
      )!

    // 点删除只弹出确认，菜单收起；取消后不删除。
    rows[1]!.querySelector<HTMLButtonElement>('.pet-option-remove')!.click()
    expect(ui.menu()).toBeNull()
    expect(confirm()?.textContent).toContain('飞鱼娘·泡泡')
    confirmButton('取消').click()
    expect(confirm()).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    expect(removed).toEqual([])

    // Escape 只取消确认，不传到 window（设置弹窗在 window 上监听 Escape）。
    let reachedWindow = false
    const onWindowKey = () => {
      reachedWindow = true
    }
    window.addEventListener('keydown', onWindowKey)
    ui.trigger.click()
    ui.menu()!.querySelectorAll<HTMLButtonElement>('.pet-option-remove')[0]!.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.removeEventListener('keydown', onWindowKey)
    expect(confirm()).toBeNull()
    expect(reachedWindow).toBe(false)

    ui.trigger.click()
    ui.menu()!.querySelectorAll<HTMLButtonElement>('.pet-option-remove')[0]!.click()
    confirmButton('删除').click()
    await new Promise((r) => setTimeout(r, 0))
    expect(removed).toEqual(['bubble'])
    expect(confirm()).toBeNull()

    ui.trigger.click()
    ui.menu()!.querySelectorAll<HTMLButtonElement>('[data-pet-option]')[2]!.click()
    expect(store.petPrefs().pack).toBe('maid')
    expect(ui.menu()).toBeNull()
    expect(ui.trigger.textContent).toBe('大肥鱼娘 · 蓝色鲸鱼女仆')
  } finally {
    ui.close()
  }
})
