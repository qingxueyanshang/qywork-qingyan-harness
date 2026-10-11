import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  await import('../../lib/store/index.ts')
})
afterAll(async () => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

const root = 'C:\\下载'
const directory = `${root}\\技能目录`
const zip = `${root}\\技能包.ZIP`
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) delegated.call(button, event)
  else button.dispatchEvent(event)
}

function button(host: HTMLElement, name: string) {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name)!
}

function mockPicker() {
  const calls: (string | null)[] = []
  ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { path: string | null }) => {
      expect(cmd).toBe('list_skill_sources')
      calls.push(args.path)
      if (args.path === 'C:\\missing') throw new Error('路径不存在')
      const path = args.path ?? root
      return {
        path,
        parent: path === root ? 'C:\\' : root,
        selected: null,
        locations: [{ name: '下载', path: root, directory: true }],
        entries:
          path === root
            ? [
                { name: '技能目录', path: directory, directory: true },
                { name: '技能包.ZIP', path: zip, directory: false },
              ]
            : [],
      }
    },
  }
  return calls
}

test('一个入口和同一个选择窗口导入目录或 ZIP，失败保留选择并可重试', async () => {
  mockPicker()
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { default: SkillsSettings } = await import('./SkillsSettings.tsx')
  const originalApi = store.client.api
  const imported: { scope: string; path: string }[] = []
  let fail = false
  let reads = 0
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/skills') {
      reads++
      return { skills: [], dirs: [] } as T
    }
    expect(path).toBe('/api/skills/import')
    imported.push(JSON.parse(String(init?.body)))
    if (fail) throw new Error('包内没有 SKILL.md')
    return { installed: [{ name: '技能', active: true }] } as T
  }
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <SkillsSettings />, host)
  try {
    await tick()
    expect(
      Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === '导入'),
    ).toHaveLength(1)
    expect(host.textContent).not.toContain('导入目录')
    expect(host.textContent).not.toContain('导入 ZIP')
    for (const [name, source] of [
      ['技能目录', directory],
      ['技能包.ZIP', zip],
    ] as const) {
      click(button(host, '导入'))
      await tick()
      const dialog = host.querySelector('dialog')!
      expect(dialog.open).toBe(true)
      expect(button(dialog, '导入').disabled).toBe(true)
      expect(button(dialog, '技能目录')).toBeDefined()
      expect(button(dialog, '技能包.ZIP')).toBeDefined()
      click(button(dialog, name!))
      fail = source === zip
      click(button(dialog, '导入'))
      await tick()
      if (fail) {
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('SKILL.md')
        expect(dialog.open).toBe(true)
        fail = false
        click(button(dialog, '导入'))
        await tick()
      }
      expect(imported.at(-1)).toEqual({ scope: 'project', path: source })
      expect(host.querySelector('dialog')).toBeNull()
    }
    expect(reads).toBeGreaterThan(1)
  } finally {
    dispose()
    store.client.api = originalApi
    host.remove()
  }
})

test('目录导航清除旧选择，路径失败可恢复，取消不执行导入', async () => {
  const calls = mockPicker()
  const { render } = await import('solid-js/web')
  const { SkillImportDialog } = await import('./SkillImportDialog.tsx')
  let imported = false
  let closed = false
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => (
      <SkillImportDialog
        onImport={async () => {
          imported = true
        }}
        onClose={() => {
          closed = true
        }}
      />
    ),
    host,
  )
  try {
    await tick()
    click(button(host, '技能目录'))
    button(host, '技能目录').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await tick()
    expect(calls.at(-1)).toBe(directory)
    expect(button(host, '导入').disabled).toBe(true)
    click(button(host, '当前文件夹'))
    expect(button(host, '导入').disabled).toBe(false)
    const input = host.querySelector('input')!
    input.value = 'C:\\missing'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('路径不存在')
    expect(button(host, '导入').disabled).toBe(true)
    click(button(host, '下载'))
    await tick()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    click(button(host, '取消'))
    expect(closed).toBe(true)
    expect(imported).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})
