/**
 * 「模块」页的浏览器控制、电脑控制、Office 文档、画布与生成四组：分组标题中的开关读取并写入
 * `browserEnabled` / `desktopEnabled` / `officeEnabled` / `mediaEnabled`。
 *
 * 覆盖范围：`ModulesSettings.tsx` 的分组标题开关与工具行分组、`OnOff.tsx` 的两项开关。
 *
 * 「字段缺失视为启用」由本文件与 `server/src/desktop/assembly.test.ts` 分别锁定一端：
 * 本文件锁定界面显示，后者锁定工具是否注册。两端判据必须一致，否则界面显示
 * 「启用」而模型没有这组工具。
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
      objectLabel: '电脑控制',
      summary: '列出可操作的桌面窗口',
      actionKind: 'read',
      permissionEffect: 'desktop',
      params: [],
      source: 'builtin',
    },
    {
      name: 'browser_tabs',
      category: 'browser',
      facet: '页面',
      objectLabel: '浏览器控制',
      summary: '列出、新建、接管或关闭标签页',
      actionKind: 'read',
      permissionEffect: 'browser',
      params: [],
      source: 'builtin',
    },
    {
      name: 'read_canvas',
      category: 'media',
      facet: '生成',
      objectLabel: '画布',
      summary: '读取画布或列出工作区里的画布',
      actionKind: 'read',
      permissionEffect: 'read',
      params: [],
      source: 'builtin',
    },
  ],
}

/** 指定分组标题中的两项开关按钮。 */
function segOf(host: HTMLElement, title = '电脑控制'): HTMLButtonElement[] {
  const head = Array.from(host.querySelectorAll<HTMLElement>('.settings-block-head')).find((h) =>
    h.querySelector('h3')?.textContent?.includes(title),
  )
  return Array.from(head?.querySelectorAll<HTMLButtonElement>('.seg-item') ?? [])
}

function activeLabel(host: HTMLElement, title = '电脑控制'): string | undefined {
  return segOf(host, title).find((b) => b.classList.contains('active'))?.textContent ?? undefined
}

/** 等待条件成立。配置、工具清单与 PUT 各自异步完成，不要改为固定时长的 sleep。 */
async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return ok()
}

test('开关读数：字段缺失视为启用，仅显式 false 为关闭', async () => {
  const { desktopSwitchOn } = await import('./ModulesSettings.tsx')
  expect(desktopSwitchOn(null)).toBe(true)
  expect(desktopSwitchOn({})).toBe(true)
  expect(desktopSwitchOn({ desktopEnabled: true })).toBe(true)
  expect(desktopSwitchOn({ desktopEnabled: false })).toBe(false)
  const { officeSwitchOn } = await import('./ModulesSettings.tsx')
  expect(officeSwitchOn(null)).toBe(true)
  expect(officeSwitchOn({ officeEnabled: true })).toBe(true)
  expect(officeSwitchOn({ officeEnabled: false })).toBe(false)
  const { browserSwitchOn } = await import('./ModulesSettings.tsx')
  expect(browserSwitchOn(null)).toBe(true)
  expect(browserSwitchOn({ browserEnabled: true })).toBe(true)
  expect(browserSwitchOn({ browserEnabled: false })).toBe(false)
  const { mediaSwitchOn } = await import('./ModulesSettings.tsx')
  expect(mediaSwitchOn(null)).toBe(true)
  expect(mediaSwitchOn({ mediaEnabled: true })).toBe(true)
  expect(mediaSwitchOn({ mediaEnabled: false })).toBe(false)
})

test('分组标题开关：缺省视为启用，单击后写入 desktopEnabled', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config, reloadConfig } = await import('./configStore.ts')
  const { ModulesSettings } = await import('./ModulesSettings.tsx')

  let stored: Record<string, unknown> = { providers: {} }
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/tools') return TOOLS as T
    if (path === '/api/config' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { config: Record<string, unknown> }
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
  // `ensureConfig` 在整个进程中只请求一次，共享配置可能来自先运行的测试文件。
  await reloadConfig()

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModulesSettings />, host as unknown as HTMLElement)
  try {
    expect(await until(() => segOf(host).length === 2)).toBe(true)

    // 工具行来自 /api/tools。
    expect(host.textContent).toContain('desktop_windows')
    // 该分组不显示 desktopEnabled 与 dispatch 两条说明行。
    expect(host.textContent).not.toContain('desktopEnabled')
    expect(host.textContent).not.toContain('dispatch')

    // 字段缺失视为启用。true / false 两种读数由 `desktopSwitchOn` 的单元测试锁定。
    expect(activeLabel(host)).toBe('启用')

    click(segOf(host).find((b) => b.textContent === '关闭') as HTMLButtonElement)
    expect(config()?.desktopEnabled).toBe(false)
    expect(activeLabel(host)).toBe('关闭')
    expect(await until(() => stored.desktopEnabled === false)).toBe(true)

    click(segOf(host).find((b) => b.textContent === '启用') as HTMLButtonElement)
    expect(config()?.desktopEnabled).toBe(true)
    expect(activeLabel(host)).toBe('启用')
    expect(await until(() => stored.desktopEnabled === true)).toBe(true)

    // Office 文档分组：开关形式相同，写入 officeEnabled，不改变电脑控制的开关。
    expect(activeLabel(host, 'Office 文档')).toBe('启用')
    click(segOf(host, 'Office 文档').find((b) => b.textContent === '关闭') as HTMLButtonElement)
    expect(config()?.officeEnabled).toBe(false)
    expect(await until(() => stored.officeEnabled === false)).toBe(true)
    expect(stored.desktopEnabled).toBe(true)

    // 画布与生成分组：分组标题中是开关而不是「去配置」，写入 mediaEnabled。
    const media = Array.from(host.querySelectorAll<HTMLElement>('.settings-block-head')).find(
      (h) => h.querySelector('h3')?.textContent === '画布与生成',
    )
    expect(media?.querySelector('.module-console')).toBeNull()
    expect(activeLabel(host, '画布与生成')).toBe('启用')
    click(segOf(host, '画布与生成').find((b) => b.textContent === '关闭') as HTMLButtonElement)
    expect(config()?.mediaEnabled).toBe(false)
    expect(await until(() => stored.mediaEnabled === false)).toBe(true)
    expect(stored.officeEnabled).toBe(false)

    // 浏览器控制分组：开关形式相同，写入 browserEnabled。
    expect(activeLabel(host, '浏览器控制')).toBe('启用')
    click(segOf(host, '浏览器控制').find((b) => b.textContent === '关闭') as HTMLButtonElement)
    expect(config()?.browserEnabled).toBe(false)
    expect(await until(() => stored.browserEnabled === false)).toBe(true)
    expect(stored.mediaEnabled).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})
