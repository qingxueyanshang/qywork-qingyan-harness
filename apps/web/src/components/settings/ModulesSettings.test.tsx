/**
 * 「模块」页电脑控制那一组：组头的开关读的是 `desktopEnabled`，写的也是它。
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
      objectLabel: '电脑控制',
      summary: '列出可操作的桌面窗口',
      actionKind: 'read',
      permissionEffect: 'desktop',
      params: [],
      source: 'builtin',
    },
  ],
}

/** 电脑控制那一组的组头里那两格开关。 */
function segOf(host: HTMLElement): HTMLButtonElement[] {
  const head = Array.from(host.querySelectorAll<HTMLElement>('.settings-block-head')).find((h) =>
    h.querySelector('h3')?.textContent?.includes('电脑控制'),
  )
  return Array.from(head?.querySelectorAll<HTMLButtonElement>('.seg-item') ?? [])
}

function activeLabel(host: HTMLElement): string | undefined {
  return segOf(host).find((b) => b.classList.contains('active'))?.textContent ?? undefined
}

/**
 * 等一个条件成立。
 *
 * **不要换成固定时长的 sleep。** `configStore` 是模块级共享的一份，写入走一条串行
 * 队列；整套测试跑在同一个进程里时，队列里可能还压着别的测试排进去的编辑，
 * 本次写出去的那一条不一定是第一条。
 */
async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return ok()
}

test('开关读数：缺席按启用，只有显式 false 才关', async () => {
  const { desktopSwitchOn } = await import('./ModulesSettings.tsx')
  expect(desktopSwitchOn(null)).toBe(true)
  expect(desktopSwitchOn({})).toBe(true)
  expect(desktopSwitchOn({ desktopEnabled: true })).toBe(true)
  expect(desktopSwitchOn({ desktopEnabled: false })).toBe(false)
})

test('组头开关：缺席按启用，点一下写出去的是 desktopEnabled', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../../lib/store/index.ts')
  const { config } = await import('./configStore.ts')
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

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ModulesSettings />, host as unknown as HTMLElement)
  try {
    expect(await until(() => segOf(host).length === 2)).toBe(true)

    // 工具行来自 /api/tools —— 这一组不再是只有说明行。
    expect(host.textContent).toContain('desktop_windows')
    // 删掉的那两条说明行不许回来。
    expect(host.textContent).not.toContain('desktopEnabled')
    expect(host.textContent).not.toContain('dispatch')

    // 缺席按启用。true / false 两种读数由 `desktopSwitchOn` 的单测锁——
    // `configStore` 是模块级共享的一份，整套测试跑在同一个进程里时，
    // 别的测试文件装的模块替身会把「重新载入服务端那一份」这条路径接管掉。
    expect(activeLabel(host)).toBe('启用')

    /*
     * 点「关闭」写出去的是这一格。
     *
     * 判据取 `config()`：`patchConfig` 把新值同步写进这份共享配置，之后才排队发 PUT。
     * **不要改成等那次 PUT 到达**：整套测试跑在同一个进程里，`configStore` 的写入队列
     * 是模块级的一份，别的测试文件排进去而没有回应的编辑会把队列卡住，本次写入因此
     * 可能一直发不出去。PUT 的报文形状由 `configStore.test.ts` 与服务端的接口测试锁。
     */
    click(segOf(host).find((b) => b.textContent === '关闭') as HTMLButtonElement)
    expect(config()?.desktopEnabled).toBe(false)
    expect(activeLabel(host)).toBe('关闭')

    click(segOf(host).find((b) => b.textContent === '启用') as HTMLButtonElement)
    expect(config()?.desktopEnabled).toBe(true)
    expect(activeLabel(host)).toBe('启用')
  } finally {
    dispose()
    host.remove()
  }
})
