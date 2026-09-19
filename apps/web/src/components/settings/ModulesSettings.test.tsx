/**
 * 「模块」页电脑操作那一组：组头的开关读的是 `desktopEnabled`，写的也是它。
 *
 * 覆盖范围：`ModulesSettings.tsx` 的组头开关与工具行分组、`OnOff.tsx` 的两格形态。
 *
 * 缺席按启用这一条只在这里与 `server/src/desktop/assembly.test.ts` 各锁一端：
 * 一端是界面显示成什么，另一端是工具注不注册。两端判据必须一致，否则界面写着
 * 「启用」而模型手里没有这组工具。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) delegated.call(button, event)
  else button.dispatchEvent(event)
}

const TOOLS = {
  tools: [
    {
      name: 'desktop_windows',
      category: 'desktop',
      facet: '桌面控件',
      objectLabel: '电脑操作',
      summary: '列出可操作的桌面窗口',
      actionKind: 'read',
      permissionEffect: 'desktop',
      params: [],
      source: 'builtin',
    },
  ],
}

/** 电脑操作那一组的组头里那两格开关。 */
function segOf(host: HTMLElement): HTMLButtonElement[] {
  const head = Array.from(host.querySelectorAll<HTMLElement>('.settings-block-head')).find((h) =>
    h.querySelector('h3')?.textContent?.includes('电脑操作'),
  )
  return Array.from(head?.querySelectorAll<HTMLButtonElement>('.seg-item') ?? [])
}

function activeLabel(host: HTMLElement): string | undefined {
  return segOf(host).find((b) => b.classList.contains('active'))?.textContent ?? undefined
}

test('组头开关：缺席按启用、显式 false 才关，点一下写出去的是 desktopEnabled', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { reloadConfig } = await import('./configStore.ts')
  const { ModulesSettings } = await import('./ModulesSettings.tsx')

  let stored: Record<string, unknown> = { providers: {} }
  // 用数组收：`let saved = null` 会被控制流分析收窄成 `null`，读它的那一行就没有字段。
  const saves: Record<string, unknown>[] = []
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/tools') return TOOLS as T
    if (path === '/api/config' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { config: Record<string, unknown> }
      saves.push(body.config)
      stored = body.config
      return { ok: true } as T
    }
    if (path === '/api/config') {
      return {
        path: 'config.json',
        config: stored,
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    }
    throw new Error(`unexpected ${path}`)
  }

  await reloadConfig()
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModulesSettings />, host as unknown as HTMLElement)
  try {
    // resource 要一轮微任务才落地。
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 30))

    // 工具行来自 /api/tools —— 这一组不再是只有说明行。
    expect(host.textContent).toContain('desktop_windows')
    // 删掉的那两条说明行不许回来。
    expect(host.textContent).not.toContain('desktopEnabled')
    expect(host.textContent).not.toContain('dispatch')

    // 缺席：显示为启用。
    expect(segOf(host)).toHaveLength(2)
    expect(activeLabel(host)).toBe('启用')

    // 点「关闭」写出去的是这一格。
    click(segOf(host).find((b) => b.textContent === '关闭') as HTMLButtonElement)
    await new Promise((r) => setTimeout(r, 30))
    expect(saves.at(-1)?.desktopEnabled).toBe(false)
    expect(activeLabel(host)).toBe('关闭')

    // 显式 true：显示为启用。
    stored = { providers: {}, desktopEnabled: true }
    await reloadConfig()
    await new Promise((r) => setTimeout(r, 10))
    expect(activeLabel(host)).toBe('启用')
  } finally {
    dispose()
    host.remove()
  }
})
